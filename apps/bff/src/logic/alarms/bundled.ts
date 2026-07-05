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
 * Bundled defaults for the Alert page-setup template. Lives next to the
 * layer and overview bundled JSON so the sync orchestrator can treat all
 * three families uniformly — there's exactly one alert template
 * (`horizon.alert.page-setup`) and it ships with the BFF.
 *
 * Resolved via the same path-search as the layer loader: dev source tree
 * first, then the packaged dist layout. Keeps the file readable and
 * editable in dev without forcing a rebuild step.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The Alert page-setup config — the whole of the `horizon.alert.page-setup`
 *  template. Authored in the Alert-page admin, persisted to OAP like every other
 *  template; the UI reads the effective (bundled ↔ OAP) copy from the config
 *  bundle's sync status. `pinnedLayers` get a header KPI tile on the Alarms page;
 *  `defaultWindowMs` is the shared default window for the badge + page + widget;
 *  `overviewAlarmsLimit` caps the overview "Active alarms" widget's per-poll fetch. */
export interface AlarmsConfig {
  pinnedLayers: string[];
  defaultWindowMs: number;
  overviewAlarmsLimit: number;
}

const HERE = dirname(fileURLToPath(import.meta.url));

let cached: AlarmsConfig | null = null;

export function loadBundledAlertPageSetup(): AlarmsConfig {
  if (cached) return cached;
  const file = locateAlertBundle();
  const raw = readFileSync(file, 'utf8');
  const parsed = JSON.parse(raw) as AlarmsConfig;
  cached = parsed;
  return parsed;
}

export function invalidateAlertBundleCache(): void {
  cached = null;
}

function locateAlertBundle(): string {
  // Probe order matches the sibling layer/overview loaders. Entry 1
  // must come first: after `pnpm package`, dist/server.js sits next to
  // dist/bundled_templates, so HERE = dist/. Drop it and the remaining
  // probes climb above WORKDIR — node:path.resolve clamps at `/` and
  // every candidate collapses to the same wrong path.
  //   1. <HERE>/bundled_templates/...      — packaged dist (HERE = dist/).
  //   2. <HERE>/../../bundled_templates/... — dev source tree (tsx).
  //   3. <cwd>/bundled_templates/...        — relocated dist/.
  const candidates = [
    resolve(HERE, 'bundled_templates/alert/page-setup.json'),
    resolve(HERE, '../../bundled_templates/alert/page-setup.json'),
    resolve(process.cwd(), 'bundled_templates/alert/page-setup.json'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  throw new Error(
    `bundled alert page-setup not found in: ${candidates.join(', ')}`,
  );
}
