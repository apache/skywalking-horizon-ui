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
import YAML from 'yaml';
import { describe, expect, it } from 'vitest';
import { configSchema } from './schema.js';
import { interpolateEnv, stripNullish, isAuthConfigured, validateBootstrap } from './loader.js';

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
});

describe('stripNullish', () => {
  it('drops null-valued keys (a ${VAR:null} that resolved to null = use default)', () => {
    expect(stripNullish({ a: 1, b: null, c: { d: null, e: 2 } })).toEqual({ a: 1, c: { e: 2 } });
  });
  it('keeps empty arrays + empty strings (those are real values, not "unset")', () => {
    expect(stripNullish({ a: [], b: '', c: 0, d: false })).toEqual({ a: [], b: '', c: 0, d: false });
  });
});

// The env-native contract: the tokenized horizon.yaml, interpolated +
// stripped + parsed, must accept env overrides for every kind of field.
describe('env-native config (horizon.yaml + env)', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const raw = readFileSync(resolve(here, '../../../../horizon.yaml'), 'utf8');
  const load = (env: NodeJS.ProcessEnv): ReturnType<typeof configSchema.parse> =>
    configSchema.parse(stripNullish(YAML.parse(interpolateEnv(raw, env)) ?? {}));

  it('scalar env overrides (oap url, templates mode, boolean)', () => {
    const cfg = load({
      HORIZON_OAP_QUERY_URL: 'http://oap.prod:12800',
      HORIZON_TEMPLATES_MODE: 'readonly',
      HORIZON_RBAC_ENABLED: 'false',
    });
    expect(cfg.oap.queryUrl).toBe('http://oap.prod:12800');
    expect(cfg.templates.mode).toBe('readonly');
    expect(cfg.rbac.enabled).toBe(false);
  });

  it('JSON-array env override seeds local users (incl. an argon2 $ hash)', () => {
    const hash = '$argon2id$v=19$m=65536,t=3,p=4$abc$def';
    const cfg = load({
      HORIZON_AUTH_LOCAL_USERS: JSON.stringify([{ username: 'admin', passwordHash: hash, roles: ['admin'] }]),
    });
    expect(cfg.auth.local.users).toEqual([{ username: 'admin', passwordHash: hash, roles: ['admin'] }]);
  });

  it('JSON-object env override sets the optional oap.auth block', () => {
    const cfg = load({ HORIZON_OAP_AUTH: '{"username":"sw","password":"sw"}' });
    expect(cfg.oap.auth).toEqual({ username: 'sw', password: 'sw' });
  });

  it('unset optional/structured blocks fall through to the schema default', () => {
    const cfg = load({});
    expect(cfg.oap.auth).toBeUndefined();
    expect(cfg.performance.bulk.dashboard.bulkSize).toBe(6);
    expect(cfg.layers.excluded.map((e) => e.key)).toEqual(['FAAS', 'VIRTUAL_GATEWAY']);
  });

  it('malformed JSON env throws at parse (fail loud, not silently default)', () => {
    expect(() => load({ HORIZON_AUTH_LOCAL_USERS: '[{bad json' })).toThrow();
  });

  it('quoted string scalars survive a value with YAML metacharacters (: and #)', () => {
    // The string tokens are quoted (`"${X:default}"`), so a metachar value
    // lands safely inside a YAML string instead of breaking the parse.
    const cfg = load({ HORIZON_SESSION_COOKIE_NAME: 'weird: name #x', HORIZON_OAP_QUERY_URL: 'http://oap:12800' });
    expect(cfg.session.cookieName).toBe('weird: name #x');
    expect(cfg.oap.queryUrl).toBe('http://oap:12800');
  });

  it('survives newlines and YAML formatting', () => {
    const raw = `auth:\n  ldap:\n    bindPassword: "\${HORIZON_LDAP_BIND_PW:dev-only}"\n`;
    const out = interpolateEnv(raw, {});
    expect(out).toContain('bindPassword: "dev-only"');
  });
});

describe('isAuthConfigured', () => {
  it('false for backend:local with zero users', () => {
    const cfg = configSchema.parse({ auth: { backend: 'local', local: { users: [] } } });
    expect(isAuthConfigured(cfg)).toBe(false);
  });

  it('true for backend:local with at least one user', () => {
    const cfg = configSchema.parse({
      auth: {
        backend: 'local',
        local: {
          users: [{ username: 'a', passwordHash: '$argon2id$x', roles: ['admin'] }],
        },
      },
    });
    expect(isAuthConfigured(cfg)).toBe(true);
  });

  it('false for backend:ldap with no auth.ldap', () => {
    const cfg = configSchema.parse({ auth: { backend: 'ldap', local: { users: [] } } });
    expect(isAuthConfigured(cfg)).toBe(false);
  });

  it('false for backend:ldap when ldap.groupMappings is empty', () => {
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
    expect(isAuthConfigured(cfg)).toBe(false);
  });

  it('true for backend:ldap when ldap has at least one group mapping', () => {
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
    expect(isAuthConfigured(cfg)).toBe(true);
  });
});

describe('validateBootstrap', () => {
  // Auth-unconfigured cases no longer throw — the BFF boots and surfaces
  // the state via /api/auth/health so the login page can render a
  // setup-required banner. The validator only logs.
  it('does not throw with backend:local and zero users', () => {
    const cfg = configSchema.parse({ auth: { backend: 'local', local: { users: [] } } });
    expect(() => validateBootstrap(cfg)).not.toThrow();
  });

  it('does not throw with backend:ldap and no auth.ldap', () => {
    const cfg = configSchema.parse({ auth: { backend: 'ldap', local: { users: [] } } });
    expect(() => validateBootstrap(cfg)).not.toThrow();
  });

  it('does not throw with backend:ldap and empty groupMappings', () => {
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
    expect(() => validateBootstrap(cfg)).not.toThrow();
  });

  it('does not throw for a fully configured local backend', () => {
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
});
