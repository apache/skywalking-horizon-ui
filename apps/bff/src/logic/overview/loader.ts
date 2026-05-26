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
 * Overview-dashboard config loader. Reads every `*.json` under
 * `../bundled_templates/overviews/`, validates the wire shape, and keeps
 * the parsed dashboards in-memory. The loader is intentionally eager
 * (all dashboards loaded at boot) — config files are small and the
 * SPA hits dashboard endpoints often enough that on-demand parsing
 * isn't worth the ceremony.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  OverviewDashboard,
  OverviewKpi,
  OverviewVisibility,
  OverviewWidgetType,
} from '@skywalking-horizon-ui/api-client';
import { isOverlayFilename } from '../../i18n/store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** Mirrors the dev-vs-prod path probing in `logic/layers/loader.ts`
 *  — see that file for the rationale. */
function locateConfigDir(): string {
  const candidates = [
    path.join(__dirname, 'bundled_templates', 'overviews'),
    path.join(__dirname, '..', '..', 'bundled_templates', 'overviews'),
    path.join(__dirname, '..', 'bundled_templates', 'overviews'),
    path.join(process.cwd(), 'bundled_templates', 'overviews'),
  ];
  for (const dir of candidates) {
    try {
      fs.readdirSync(dir);
      return dir;
    } catch {
      /* try next */
    }
  }
  return candidates[0];
}
const CONFIG_DIR = locateConfigDir();

let cache: OverviewDashboard[] | null = null;

function isString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

const WIDGET_TYPES: ReadonlySet<OverviewWidgetType> = new Set([
  'metric',
  'topology',
  'section-break',
  'kpi-tile',
  'alarms',
  'metric-composite',
]);
// `layer` is required for data-bound widgets; layout-only / aggregate
// widgets resolve their data without an explicit layer binding.
const LAYERLESS_WIDGETS: ReadonlySet<OverviewWidgetType> = new Set([
  'section-break',
  'alarms',
]);

function parseKpis(raw: unknown): OverviewKpi[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: OverviewKpi[] = [];
  for (const k of raw) {
    if (!k || typeof k !== 'object') continue;
    const rec = k as Record<string, unknown>;
    if (!isString(rec.label)) continue;
    const source = rec.source === 'service-count' ? 'service-count' : 'mqe';
    /* MQE source requires a non-empty `mqe`; service-count source
     * doesn't need one (the layer's listServices count is the value). */
    if (source === 'mqe' && !isString(rec.mqe)) continue;
    const style = rec.style === 'progress-bar' ? 'progress-bar' : rec.style === 'number' ? 'number' : undefined;
    const max =
      style === 'progress-bar' && typeof rec.max === 'number' && Number.isFinite(rec.max) && rec.max > 0
        ? rec.max
        : undefined;
    out.push({
      label: rec.label,
      mqe: isString(rec.mqe) ? rec.mqe : undefined,
      unit: isString(rec.unit) ? rec.unit : undefined,
      aggregation:
        rec.aggregation === 'sum' ? 'sum' : rec.aggregation === 'avg' ? 'avg' : undefined,
      style,
      max,
      source,
    });
  }
  return out.length > 0 ? out : undefined;
}

function validate(raw: unknown, file: string): OverviewDashboard | null {
  if (!raw || typeof raw !== 'object') {
    console.warn(`overview/${file}: not an object, skipped`);
    return null;
  }
  const r = raw as Record<string, unknown>;
  if (!isString(r.id) || !isString(r.title) || !Array.isArray(r.widgets)) {
    console.warn(`overview/${file}: missing id/title/widgets`);
    return null;
  }
  const widgets = (r.widgets as unknown[]).filter((w): w is Record<string, unknown> => {
    if (!w || typeof w !== 'object') return false;
    const rec = w as Record<string, unknown>;
    if (!isString(rec.id) || !isString(rec.title)) return false;
    if (!WIDGET_TYPES.has(rec.type as OverviewWidgetType)) return false;
    if (!LAYERLESS_WIDGETS.has(rec.type as OverviewWidgetType) && !isString(rec.layer)) {
      return false;
    }
    return true;
  });
  const visibility: OverviewVisibility | undefined =
    r.visibility === 'operate' ? 'operate' : r.visibility === 'public' ? 'public' : undefined;
  const layers = Array.isArray(r.layers)
    ? (r.layers as unknown[]).filter(isString)
    : undefined;
  return {
    id: r.id,
    title: r.title,
    description: isString(r.description) ? r.description : undefined,
    visibility,
    icon: isString(r.icon) ? r.icon : undefined,
    order: typeof r.order === 'number' ? r.order : undefined,
    layers,
    widgets: widgets.map((w) => ({
      id: w.id as string,
      title: w.title as string,
      tip: isString(w.tip) ? w.tip : undefined,
      layer: isString(w.layer) ? w.layer : undefined,
      type: w.type as OverviewWidgetType,
      mqe: isString(w.mqe) ? w.mqe : undefined,
      unit: isString(w.unit) ? w.unit : undefined,
      aggregation: w.aggregation === 'sum' ? 'sum' : w.aggregation === 'avg' ? 'avg' : undefined,
      cols: typeof w.cols === 'number' ? w.cols : undefined,
      kpis: parseKpis(w.kpis),
      showCount: w.showCount === true ? true : undefined,
      limit: typeof w.limit === 'number' ? w.limit : undefined,
      span: typeof w.span === 'number' ? w.span : undefined,
      rowSpan: typeof w.rowSpan === 'number' ? w.rowSpan : undefined,
    })),
  };
}

/**
 * Load every dashboard config under `../bundled_templates/overviews/*.json`.
 * Memoised after the first call; restart the BFF to pick up file changes
 * (in line with the layer-template loader's behaviour).
 */
export function loadOverviewDashboards(): OverviewDashboard[] {
  if (cache) return cache;
  if (!fs.existsSync(CONFIG_DIR)) {
    cache = [];
    return cache;
  }
  const files = fs
    .readdirSync(CONFIG_DIR)
    .filter((f) => f.endsWith('.json') && !isOverlayFilename(f));
  const out: OverviewDashboard[] = [];
  for (const f of files) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, f), 'utf8'));
      const dash = validate(raw, f);
      if (dash) out.push(dash);
    } catch (err) {
      console.warn(`overview/${f}: parse error`, err instanceof Error ? err.message : err);
    }
  }
  // Stable sort: explicit `order` first, then visibility (public before
  // operate), then id. Operators bumping `order` on a single dashboard
  // shouldn't need to renumber the rest of the bundle.
  out.sort((a, b) => {
    const ao = a.order ?? 1000;
    const bo = b.order ?? 1000;
    if (ao !== bo) return ao - bo;
    const av = a.visibility ?? 'public';
    const bv = b.visibility ?? 'public';
    if (av !== bv) return av === 'public' ? -1 : 1;
    return a.id.localeCompare(b.id);
  });
  cache = out;
  return cache;
}

/** Force a re-read on the next call. Used in tests + by the admin
 *  write path so the next dashboard fetch sees the freshly-saved JSON. */
export function invalidateOverviewCache(): void {
  cache = null;
}

export function getOverviewDashboard(id: string): OverviewDashboard | null {
  return loadOverviewDashboards().find((d) => d.id === id) ?? null;
}

/** Locate the on-disk JSON file backing `id`, if any. Bundle files are
 *  named by id but operators may use any filename — scan the dir for a
 *  match. Returns null when no file in the bundle dir parses with that
 *  id (admin then has nowhere to write). */
export function findOverviewFile(id: string): string | null {
  if (!fs.existsSync(CONFIG_DIR)) return null;
  for (const f of fs.readdirSync(CONFIG_DIR)) {
    if (!f.endsWith('.json') || isOverlayFilename(f)) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, f), 'utf8'));
      if (raw && typeof raw === 'object' && (raw as { id?: unknown }).id === id) {
        return path.join(CONFIG_DIR, f);
      }
    } catch {
      /* ignore */
    }
  }
  return null;
}

/** Persist a dashboard's full config back to disk and invalidate the
 *  cache. Atomic via `.tmp` rename so a partial write never leaves
 *  half-JSON on disk. */
export function writeOverviewDashboard(id: string, dash: OverviewDashboard): void {
  const file = findOverviewFile(id);
  if (!file) {
    throw new Error(`overview/${id}: no source file to write back to`);
  }
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(dash, null, 2), 'utf8');
  fs.renameSync(tmp, file);
  invalidateOverviewCache();
}

/** Create a new dashboard JSON in the bundled dir. Fails when an
 *  existing file already declares the same id (the admin should
 *  surface this as "id already in use" rather than overwriting). */
export function createOverviewDashboard(dash: OverviewDashboard): void {
  if (findOverviewFile(dash.id)) {
    throw new Error(`overview/${dash.id}: dashboard already exists`);
  }
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
  /* Filename = `<id>.json` so the on-disk layout matches the id
   * exactly. Sanitise to guard against accidental path traversal —
   * loader id-equality is what really binds the file to the
   * dashboard, but the operator's also editing on disk later. */
  const safe = dash.id.replace(/[^A-Za-z0-9_-]/g, '_');
  const file = path.join(CONFIG_DIR, `${safe}.json`);
  fs.writeFileSync(file, JSON.stringify(dash, null, 2), 'utf8');
  invalidateOverviewCache();
}

/** Remove the JSON file backing `id`. No-op when there's no file. */
export function deleteOverviewDashboard(id: string): void {
  const file = findOverviewFile(id);
  if (!file) return;
  fs.unlinkSync(file);
  invalidateOverviewCache();
}
