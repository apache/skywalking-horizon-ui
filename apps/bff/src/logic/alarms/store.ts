/*
 * Licensed to the Apache Software Foundation (ASF) under one or more
 * contributor license agreements.  See the NOTICE file distributed with
 * this work for additional information regarding copyright ownership.
 * The ASF licenses this file to You under the Apache License, Version 2.0
 * (the "License"); you may not use this file except in compliance with
 * the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * File-backed store for the Alarms-page setup. Holds the list of OAP
 * layers that get their own dedicated KPI tile + breakdown chip on the
 * alarms page header (the "pinned" layers). Everything not on this
 * list shows up under the overflow-chip row when it has at least one
 * alarm in the visible window.
 *
 * Defaults seed agent (`GENERAL`) + mesh (`MESH`) so a fresh install
 * has sensible top-of-page tiles out-of-the-box.
 *
 * Backward compatibility: an older shape stored `trafficLayers:
 * [{layerKey, mqe, label}]` for the (now-removed) traffic-backdrop
 * chart. The loader silently projects that down to `pinnedLayers`
 * (just the layer keys, deduped, order preserved) so operators don't
 * have to re-pick their layers after upgrade.
 *
 * Storage convention mirrors `SetupStore`: serialised writes with a
 * `.tmp` rename so the file never appears half-written to a watcher.
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { logger } from '../../logger.js';

export interface AlarmsConfig {
  /** OAP layer keys (canonical `GENERAL`, `MESH`, `K8S_SERVICE`, …)
   *  that get a dedicated tile on the alarms page header. The order
   *  here is the render order on the page. Defaults to
   *  `['GENERAL', 'MESH']`. */
  pinnedLayers: string[];
  /** Default time window in milliseconds for the topbar alarm badge
   *  AND the alarms page's initial picker selection. The overview
   *  "Active alarms" widget keeps its own 60m window; this only
   *  affects the recent-triage surfaces. Must be one of the page
   *  picker presets — 20m / 2h / 4h. Defaults to 20m. */
  defaultWindowMs: number;
  /** Fetch cap for the overview "Active alarms" widget. The widget
   *  pulls this many rows from `/api/alarms` per poll, merges them
   *  into incidents client-side, and surfaces the top `widget.limit`
   *  rows. Higher caps catch more incident variety in noisy
   *  installs at the cost of more wire bytes per poll. Defaults to
   *  200; must be in [10, 500]. */
  overviewAlarmsLimit: number;
}

/** Allowed values for `defaultWindowMs`. Matches the alarms page's
 *  preset list so the admin's choice always lights up an existing
 *  tab on the page. */
export const ALARMS_WINDOW_OPTIONS = [
  20 * 60_000,
  2 * 60 * 60_000,
  4 * 60 * 60_000,
] as const;

export const OVERVIEW_ALARMS_LIMIT_MIN = 10;
export const OVERVIEW_ALARMS_LIMIT_MAX = 500;
export const OVERVIEW_ALARMS_LIMIT_DEFAULT = 200;

const DEFAULT_CONFIG: AlarmsConfig = {
  pinnedLayers: ['GENERAL', 'MESH'],
  defaultWindowMs: ALARMS_WINDOW_OPTIONS[0],
  overviewAlarmsLimit: OVERVIEW_ALARMS_LIMIT_DEFAULT,
};

/* Legacy shape — kept only as a tolerant input type for `load()`. New
 * code reads / writes `pinnedLayers` exclusively; the next `save()`
 * after an upgraded load rewrites the file in the new shape. */
interface LegacyTrafficLayer {
  layerKey?: unknown;
}

export class AlarmsStore {
  private readonly absPath: string;
  private cache: AlarmsConfig | null = null;
  private writing: Promise<void> | null = null;

  constructor(filePath: string) {
    this.absPath = resolve(filePath);
  }

  async load(): Promise<AlarmsConfig> {
    if (this.cache) return this.cache;
    if (!existsSync(this.absPath)) {
      this.cache = { ...DEFAULT_CONFIG, pinnedLayers: [...DEFAULT_CONFIG.pinnedLayers] };
      return this.cache;
    }
    try {
      const raw = await readFile(this.absPath, 'utf8');
      const parsed = JSON.parse(raw) as {
        pinnedLayers?: unknown;
        trafficLayers?: unknown;
        defaultWindowMs?: unknown;
        overviewAlarmsLimit?: unknown;
      };

      let pinned: string[] | null = null;
      if (Array.isArray(parsed.pinnedLayers)) {
        pinned = parsed.pinnedLayers.filter(
          (v): v is string => typeof v === 'string' && v.length > 0,
        );
      } else if (Array.isArray(parsed.trafficLayers)) {
        // Project legacy `trafficLayers: [{layerKey,...}]` down to the
        // pinned-layer set. Dedup + preserve first-seen order so the
        // header reads the same as the prior traffic-chart order.
        const seen = new Set<string>();
        const out: string[] = [];
        for (const l of parsed.trafficLayers as LegacyTrafficLayer[]) {
          const k = typeof l?.layerKey === 'string' ? l.layerKey : '';
          if (!k || seen.has(k)) continue;
          seen.add(k);
          out.push(k);
        }
        pinned = out.length > 0 ? out : null;
      }

      /* defaultWindowMs is one of the page-picker preset values; any
       * out-of-allowlist value (file edited by hand, drifted enum)
       * falls back to the default. */
      const rawWin = typeof parsed.defaultWindowMs === 'number' ? parsed.defaultWindowMs : NaN;
      const defaultWindowMs = (ALARMS_WINDOW_OPTIONS as readonly number[]).includes(rawWin)
        ? rawWin
        : DEFAULT_CONFIG.defaultWindowMs;

      const rawLim = typeof parsed.overviewAlarmsLimit === 'number' ? parsed.overviewAlarmsLimit : NaN;
      const overviewAlarmsLimit =
        Number.isInteger(rawLim) &&
        rawLim >= OVERVIEW_ALARMS_LIMIT_MIN &&
        rawLim <= OVERVIEW_ALARMS_LIMIT_MAX
          ? rawLim
          : DEFAULT_CONFIG.overviewAlarmsLimit;

      this.cache = {
        pinnedLayers: pinned ?? [...DEFAULT_CONFIG.pinnedLayers],
        defaultWindowMs,
        overviewAlarmsLimit,
      };
      return this.cache;
    } catch (err) {
      logger.warn({ err, path: this.absPath }, 'alarms store unreadable; using defaults');
      this.cache = { ...DEFAULT_CONFIG, pinnedLayers: [...DEFAULT_CONFIG.pinnedLayers] };
      return this.cache;
    }
  }

  async save(next: AlarmsConfig): Promise<void> {
    while (this.writing) await this.writing;
    const tmp = `${this.absPath}.tmp`;
    const snapshot: AlarmsConfig = {
      pinnedLayers: [...next.pinnedLayers],
      defaultWindowMs: next.defaultWindowMs,
      overviewAlarmsLimit: next.overviewAlarmsLimit,
    };
    const work = (async () => {
      await mkdir(dirname(this.absPath), { recursive: true });
      await writeFile(
        tmp,
        JSON.stringify({ generatedAt: Date.now(), ...snapshot }, null, 2),
        'utf8',
      );
      await rename(tmp, this.absPath);
      this.cache = snapshot;
    })();
    this.writing = work;
    try {
      await work;
    } finally {
      this.writing = null;
    }
  }
}
