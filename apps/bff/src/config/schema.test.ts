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
import { interpolateEnv, stripNullish } from './loader.js';

describe('configSchema defaults', () => {
  it('parses an empty object — every non-optional field has a default', () => {
    expect(() => configSchema.parse({})).not.toThrow();
  });
});

// horizon.example.yaml is the SHIPPED default + the env-var reference: every
// field is a `${HORIZON_…:default}` token. Two contracts guarded here:
//   1. With NO env set, the tokens' defaults parse to EXACTLY the schema
//      defaults — so the file is a faithful "this is what you get" reference.
//   2. Every top-level config section appears in the example, so a new
//      section can't be added to the schema without an env-overridable token.
describe('horizon.example.yaml — tokenized default + parity', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const examplePath = resolve(here, '../../../../horizon.example.yaml');
  const raw = readFileSync(examplePath, 'utf8');

  it('with NO env set, parses to exactly the schema defaults', () => {
    const parsed = stripNullish(YAML.parse(interpolateEnv(raw, {})) ?? {});
    expect(configSchema.parse(parsed)).toEqual(configSchema.parse({}));
  });

  it('every top-level config section has a token in the example', () => {
    const sections = Object.keys(configSchema.parse({}) as Record<string, unknown>);
    const exampleKeys = Object.keys((YAML.parse(raw) ?? {}) as Record<string, unknown>);
    for (const s of sections) {
      // `infra3d` is the deprecated/ignored passthrough — never tokenized.
      if (s === 'infra3d') continue;
      expect(exampleKeys, `config section "${s}" is missing from horizon.example.yaml`).toContain(s);
    }
  });

  it('key fields are env tokens (not literals), so they are overridable', () => {
    expect(raw).toContain('${HORIZON_OAP_QUERY_URL');
    expect(raw).toContain('${HORIZON_AUTH_LOCAL_USERS');
    expect(raw).toContain('${HORIZON_TEMPLATES_MODE');
    expect(raw).toContain('${HORIZON_OAP_ADMIN_URL');
  });
});
