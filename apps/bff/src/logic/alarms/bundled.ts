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
import type { AlarmsConfig } from './store.js';

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
  // Probe order:
  //   1. <HERE>/bundled_templates/...      — bundled BFF (esbuild). After
  //      `pnpm package`, dist/server.js sits next to dist/bundled_templates/,
  //      so HERE = .../dist and the file is one level deeper. In the
  //      container that's /app/server.js → /app/bundled_templates/. The
  //      sibling layer + overview loaders already include this entry
  //      first; the alert loader was missing it, which made every probe
  //      collapse above WORKDIR (node:path.resolve clamps at /) and
  //      print the same path three times.
  //   2. <HERE>/../../bundled_templates/...  — dev (tsx). Source is at
  //      apps/bff/src/logic/alarms/, bundled_templates is two levels up
  //      at apps/bff/src/bundled_templates/.
  //   3. <cwd>/bundled_templates/...        — operator running from a
  //      relocated dist/ where neither path above works.
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
