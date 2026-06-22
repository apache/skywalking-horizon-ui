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

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { configSchema } from './schema.js';
import { interpolateEnv } from './loader.js';

describe('configSchema defaults', () => {
  it('parses an empty object — every non-optional field has a default', () => {
    expect(() => configSchema.parse({})).not.toThrow();
  });
});

// Guard against horizon.example.yaml drifting from the schema defaults. The
// example is "reference, not override" — every value it shows is meant to
// equal what the BFF runs with when the block is omitted. If a default
// changes (or someone edits the example to a non-default), this fails so the
// two are reconciled before merge.
describe('horizon.example.yaml matches schema defaults', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const examplePath = resolve(here, '../../../../horizon.example.yaml');
  const example = YAML.parse(interpolateEnv(readFileSync(examplePath, 'utf8'))) ?? {};
  const defaults = configSchema.parse({}) as Record<string, unknown>;

  // YAML omits a value as null; the schema models the same absence as the
  // empty string (interpolated `${VAR:}`). Treat the two as equal so an
  // unset path doesn't read as drift.
  const norm = (v: unknown): unknown => (v === null || v === undefined ? '' : v);

  // Walk only what the example actually declares; the example is allowed to
  // omit fields (those fall back to defaults at runtime). Every scalar /
  // array it DOES carry must match the parsed default at the same path.
  const walk = (exVal: unknown, defVal: unknown, path: string): void => {
    if (Array.isArray(exVal) || (exVal !== null && typeof exVal === 'object')) {
      if (Array.isArray(exVal)) {
        expect(defVal, `${path} should be an array in defaults`).toEqual(exVal);
        return;
      }
      const exObj = exVal as Record<string, unknown>;
      const defObj = (defVal ?? {}) as Record<string, unknown>;
      for (const key of Object.keys(exObj)) {
        walk(exObj[key], defObj[key], path ? `${path}.${key}` : key);
      }
      return;
    }
    expect(norm(exVal), `${path} drifted from schema default`).toEqual(norm(defVal));
  };

  it('every value present in the example equals the schema default', () => {
    walk(example, defaults, '');
  });
});
