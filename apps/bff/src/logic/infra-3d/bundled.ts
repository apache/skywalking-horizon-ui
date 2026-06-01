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
 * Bundled defaults for the 3D Infrastructure Map config — single JSON
 * file at `apps/bff/src/bundled_templates/infra-3d/config.json`. Same
 * path-search as the alarms / overview loaders so dev + container layouts
 * both resolve.
 *
 * The bundled file is the BFF's read-only baseline; admin edits live on
 * OAP as the `horizon.infra-3d.config` template row (remote wins at
 * render, same policy as layer / overview dashboards).
 * `loadBundledInfra3dConfig` strips the `$comment` / `$note` JSON-Schema
 * helper keys so the returned object matches `Infra3dConfig` exactly.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Infra3dConfig } from './types.js';

const HERE = dirname(fileURLToPath(import.meta.url));

let cached: Infra3dConfig | null = null;

export function loadBundledInfra3dConfig(): Infra3dConfig {
  if (cached) return cached;
  const file = locateBundle();
  const raw = readFileSync(file, 'utf8');
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  cached = stripCommentKeys(parsed) as Infra3dConfig;
  return cached;
}

export function invalidateInfra3dBundleCache(): void {
  cached = null;
}

function locateBundle(): string {
  // Path probe mirrors `loadBundledAlertPageSetup` — dist-bundled BFF
  // first (HERE = .../dist; bundled_templates is a sibling), then dev
  // (HERE = .../src/logic/infra-3d/, two ups), then a relocated dist
  // where HORIZON's cwd is the only stable anchor.
  const candidates = [
    resolve(HERE, 'bundled_templates/infra-3d/config.json'),
    resolve(HERE, '../../bundled_templates/infra-3d/config.json'),
    resolve(process.cwd(), 'bundled_templates/infra-3d/config.json'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  throw new Error(`bundled infra-3d config not found in: ${candidates.join(', ')}`);
}

/** Recursively drop `$comment` / `$note` keys. The bundled JSON keeps
 *  them for readability; the loaded shape stays clean so downstream code
 *  doesn't have to special-case them. */
function stripCommentKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripCommentKeys);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === '$comment' || k === '$note') continue;
      out[k] = stripCommentKeys(v);
    }
    return out;
  }
  return value;
}
