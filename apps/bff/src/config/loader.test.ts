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

import { describe, expect, it } from 'vitest';
import { configSchema } from './schema.js';
import { BootstrapError, interpolateEnv, validateBootstrap } from './loader.js';

describe('interpolateEnv', () => {
  it('substitutes a defined variable', () => {
    expect(interpolateEnv('hello ${NAME}', { NAME: 'world' })).toBe('hello world');
  });

  it('uses the default when the variable is unset', () => {
    expect(interpolateEnv('hello ${NAME:friend}', {})).toBe('hello friend');
  });

  it('uses the default when the variable is set to an empty string', () => {
    expect(interpolateEnv('hello ${NAME:friend}', { NAME: '' })).toBe('hello friend');
  });

  it('expands an unset variable with no default to empty', () => {
    expect(interpolateEnv('pre-${MISSING}-post', {})).toBe('pre--post');
  });

  it('handles multiple substitutions on one line — each ref carries its own default', () => {
    // The second ${A:x} uses ITS default `x`, not the first ref's `a`.
    expect(interpolateEnv('${A:a}-${B:b}-${A:x}', { B: 'real' })).toBe('a-real-x');
  });

  it('matches lowercase env-var names too (regex is case-insensitive)', () => {
    expect(interpolateEnv('${lowercase}', { lowercase: 'ok' })).toBe('ok');
    expect(interpolateEnv('${lowercase:fallback}', {})).toBe('fallback');
  });

  it('survives newlines and YAML formatting', () => {
    const raw = `auth:\n  ldap:\n    bindPassword: "\${HORIZON_LDAP_BIND_PW:dev-only}"\n`;
    const out = interpolateEnv(raw, {});
    expect(out).toContain('bindPassword: "dev-only"');
  });
});

describe('validateBootstrap', () => {
  function cfgWith(overrides: Record<string, unknown>) {
    return configSchema.parse({
      auth: { backend: 'local', local: { users: [] }, ...overrides },
    });
  }

  it('refuses to start with backend:local and zero users', () => {
    const cfg = cfgWith({});
    expect(() => validateBootstrap(cfg)).toThrow(BootstrapError);
  });

  it('accepts backend:local with at least one user', () => {
    const cfg = configSchema.parse({
      auth: {
        backend: 'local',
        local: {
          users: [{ username: 'a', passwordHash: '$argon2id$x', roles: ['admin'] }],
        },
      },
    });
    expect(() => validateBootstrap(cfg)).not.toThrow();
  });

  it('refuses to start with backend:ldap and no auth.ldap', () => {
    const cfg = configSchema.parse({ auth: { backend: 'ldap', local: { users: [] } } });
    expect(() => validateBootstrap(cfg)).toThrow(BootstrapError);
  });

  it('refuses backend:ldap when ldap.groupMappings is empty', () => {
    const cfg = configSchema.parse({
      auth: {
        backend: 'ldap',
        local: { users: [] },
        ldap: {
          url: 'ldap://localhost',
          userBaseDn: 'ou=people,dc=corp',
          groupMappings: [],
        },
      },
    });
    expect(() => validateBootstrap(cfg)).toThrow(BootstrapError);
  });

  it('accepts backend:ldap when ldap has at least one group mapping', () => {
    const cfg = configSchema.parse({
      auth: {
        backend: 'ldap',
        local: { users: [] },
        ldap: {
          url: 'ldap://localhost',
          userBaseDn: 'ou=people,dc=corp',
          groupMappings: [{ group: '*', role: 'viewer' }],
        },
      },
    });
    expect(() => validateBootstrap(cfg)).not.toThrow();
  });
});
