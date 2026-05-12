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
 * Lazy Node loader for the bundled `ui-initialized-templates` tree.
 *
 * Reads each layer subdirectory under `./data/`, parses the single-element
 * outer array OAP loader expects, returns flat `DashboardConfiguration`
 * records. `menu.yaml` is left as a raw string for the BFF to parse (we
 * don't pull a YAML dep into this leaf package).
 *
 * All public functions are pure — callers can memoize freely.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DashboardConfiguration } from './types.js';

const dataDir = join(dirname(fileURLToPath(import.meta.url)), 'data');

let _cache: DashboardConfiguration[] | null = null;
let _menuYamlCache: string | null = null;

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function parseTemplate(absPath: string): DashboardConfiguration | null {
  let raw: string;
  try {
    raw = readFileSync(absPath, 'utf8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // The upstream `custom/placeholder.json` uses JSON comments which the
    // OAP loader allows via Jackson but standard JSON.parse rejects. We
    // stripped it at copy time, but tolerate similar drift here.
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null;
  const first = parsed[0] as { id?: string; configuration?: unknown };
  const cfg = first?.configuration;
  if (!cfg || typeof cfg !== 'object') return null;
  const dc = cfg as DashboardConfiguration;
  // Promote the wrapper `id` into the configuration so callers can identify
  // the template by id without re-reading the outer array.
  if (first.id && dc.id === undefined) dc.id = first.id;
  return dc;
}

/** Load and cache every template in the bundle. */
export function loadAll(): readonly DashboardConfiguration[] {
  if (_cache) return _cache;
  const out: DashboardConfiguration[] = [];
  for (const entry of readdirSync(dataDir)) {
    const layerPath = join(dataDir, entry);
    if (!isDir(layerPath)) continue;
    for (const f of readdirSync(layerPath)) {
      if (!f.endsWith('.json')) continue;
      const t = parseTemplate(join(layerPath, f));
      if (t) out.push(t);
    }
  }
  _cache = out;
  return out;
}

/** Distinct layer values that have at least one template. */
export function listLayers(): string[] {
  const set = new Set<string>();
  for (const t of loadAll()) set.add(t.layer);
  return [...set].sort();
}

/** Templates filtered by layer (case-sensitive against the on-disk value). */
export function listTemplates(layer?: string): DashboardConfiguration[] {
  const all = loadAll();
  return layer ? all.filter((t) => t.layer === layer) : [...all];
}

/** Return the dashboard configuration matching the OAP de-dupe key `(layer, entity, name)`. */
export function getTemplate(
  layer: string,
  entity: string,
  name: string,
): DashboardConfiguration | undefined {
  return loadAll().find((t) => t.layer === layer && t.entity === entity && t.name === name);
}

/** Raw `menu.yaml` content. The BFF parses it. */
export function getMenuYaml(): string {
  if (_menuYamlCache !== null) return _menuYamlCache;
  const text = readFileSync(join(dataDir, 'menu.yaml'), 'utf8');
  _menuYamlCache = text;
  return text;
}

/** Total template count — useful for tests + boot logging. */
export function templateCount(): number {
  return loadAll().length;
}
