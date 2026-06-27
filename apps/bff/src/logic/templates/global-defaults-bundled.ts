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
 * Bundled seeds for the two "global defaults" singletons:
 *
 *   - `horizon.theme.active`         — `{ themeId: '<id>' }`
 *   - `horizon.time-defaults.global` — `{ defaultWindowMinutes: 60 }`
 *
 * The five themes themselves are CSS files in the UI build; OAP only
 * remembers which one is currently selected. Time-defaults captures
 * the topbar global picker's default window (60 minutes shipped) —
 * triage pages (alarms / traces / logs / live-debug) keep their own
 * per-page time per `CLAUDE.md`, so only this one knob is global.
 *
 * Resolved with the same dev-tree / dist path search the alert bundled
 * loader uses.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

export interface ThemeActive {
  themeId: string;
}

export interface TimeDefaultsGlobal {
  defaultWindowMinutes: number;
}

let cachedTheme: ThemeActive | null = null;
let cachedTimeDefaults: TimeDefaultsGlobal | null = null;

export function loadBundledThemeActive(): ThemeActive {
  if (cachedTheme) return cachedTheme;
  const raw = readFileSync(locate('theme/active.json'), 'utf8');
  cachedTheme = JSON.parse(raw) as ThemeActive;
  return cachedTheme;
}

export function loadBundledTimeDefaults(): TimeDefaultsGlobal {
  if (cachedTimeDefaults) return cachedTimeDefaults;
  const raw = readFileSync(locate('time-defaults/global.json'), 'utf8');
  cachedTimeDefaults = JSON.parse(raw) as TimeDefaultsGlobal;
  return cachedTimeDefaults;
}

export function invalidateGlobalDefaultsBundledCache(): void {
  cachedTheme = null;
  cachedTimeDefaults = null;
}

function locate(rel: string): string {
  // Same probe order as the alert + layer + overview loaders:
  //   1. <HERE>/bundled_templates/...      — packaged dist (HERE = dist/).
  //   2. <HERE>/../../bundled_templates/... — dev source tree (tsx).
  //   3. <cwd>/bundled_templates/...       — relocated dist/.
  const candidates = [
    resolve(HERE, `bundled_templates/${rel}`),
    resolve(HERE, `../../bundled_templates/${rel}`),
    resolve(process.cwd(), `bundled_templates/${rel}`),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  throw new Error(`bundled file not found: ${rel} (tried: ${candidates.join(', ')})`);
}
