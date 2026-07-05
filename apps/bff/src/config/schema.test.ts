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

// horizon.yaml is the SHIPPED default + the env-var reference: every
// field is a `${HORIZON_…:default}` token. Two contracts guarded here:
//   1. With NO env set, the tokens' defaults parse to EXACTLY the schema
//      defaults — so the file is a faithful "this is what you get" reference.
//   2. Every top-level config section appears in the example, so a new
//      section can't be added to the schema without an env-overridable token.
describe('horizon.yaml — tokenized default + parity', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const examplePath = resolve(here, '../../../../horizon.yaml');
  const raw = readFileSync(examplePath, 'utf8');

  it('parses to exactly the schema defaults (token defaults match the schema)', () => {
    // configSchema.parse({}) reads a FIXED set of HORIZON_* env vars inline for
    // its defaults (server host/port, the *_FILE paths, sourcemaps dir,
    // templates mode). Interpolate the example with ONLY those — so the two
    // sides agree on the env-derived defaults, while every OTHER stray HORIZON_*
    // in a dev/CI env is ignored (it would otherwise read as drift, since the
    // schema default for e.g. oap.queryUrl is a literal, not env-read).
    const SCHEMA_ENV = [
      'HORIZON_SERVER_HOST', 'HORIZON_SERVER_PORT', 'HORIZON_AUDIT_FILE',
      'HORIZON_WIRE_LOG_FILE', 'HORIZON_SOURCEMAPS_DIR', 'HORIZON_TEMPLATES_MODE',
    ];
    const env: NodeJS.ProcessEnv = {};
    for (const k of SCHEMA_ENV) if (process.env[k] !== undefined) env[k] = process.env[k];
    const parsed = stripNullish(YAML.parse(interpolateEnv(raw, env)) ?? {});
    expect(configSchema.parse(parsed)).toEqual(configSchema.parse({}));
  });

  it('every top-level config section has a token in the example', () => {
    const sections = Object.keys(configSchema.parse({}) as Record<string, unknown>);
    const exampleKeys = Object.keys((YAML.parse(raw) ?? {}) as Record<string, unknown>);
    for (const s of sections) {
      // `infra3d` is the deprecated/ignored passthrough — never tokenized.
      if (s === 'infra3d') continue;
      expect(exampleKeys, `config section "${s}" is missing from horizon.yaml`).toContain(s);
    }
  });

  it('key fields are env tokens (not literals), so they are overridable', () => {
    expect(raw).toContain('${HORIZON_OAP_QUERY_URL');
    expect(raw).toContain('${HORIZON_AUTH_LOCAL_USERS');
    expect(raw).toContain('${HORIZON_TEMPLATES_MODE');
    expect(raw).toContain('${HORIZON_OAP_ADMIN_URL');
  });

  // The real contract: EVERY schema-default field is env-overridable. Walk the
  // fully-defaulted config and assert each node is covered in the example by a
  // `${HORIZON_…}` token — either a scalar token at that path, or a JSON-env
  // token standing in for a whole subtree (performance, rbac.roles, …). Catches
  // a new nested field shipped without env coverage, which the top-level-section
  // check above would miss.
  it('every schema-default field is env-tokenized in the example (recursive)', () => {
    const defaults = configSchema.parse({}) as Record<string, unknown>;
    const example = (YAML.parse(raw) ?? {}) as Record<string, unknown>;
    const TOKEN = /\$\{HORIZON_[A-Z0-9_]+(:[\s\S]*)?\}/;
    const uncovered: string[] = [];
    const walk = (schemaNode: unknown, exampleNode: unknown, path: string): void => {
      // A token string covers this node (scalar token, or a JSON-env token
      // collapsing a whole subtree to one var).
      if (typeof exampleNode === 'string' && TOKEN.test(exampleNode)) return;
      if (schemaNode !== null && typeof schemaNode === 'object' && !Array.isArray(schemaNode)) {
        if (exampleNode === null || typeof exampleNode !== 'object' || Array.isArray(exampleNode)) {
          uncovered.push(`${path} (section absent from example)`);
          return;
        }
        for (const key of Object.keys(schemaNode)) {
          if (path === '' && key === 'infra3d') continue; // deprecated passthrough, never tokenized
          walk(
            (schemaNode as Record<string, unknown>)[key],
            (exampleNode as Record<string, unknown>)[key],
            path ? `${path}.${key}` : key,
          );
        }
        return;
      }
      uncovered.push(`${path} (leaf not tokenized)`);
    };
    walk(defaults, example, '');
    expect(uncovered, `fields lacking an env token in horizon.yaml:\n  ${uncovered.join('\n  ')}`).toEqual([]);
  });
});
