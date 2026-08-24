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

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import YAML from 'yaml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configSchema } from './schema.js';
import { interpolateEnv, stripNullish, isAuthConfigured, validateBootstrap, loadConfig } from './loader.js';
import { logger } from '../logger.js';

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

describe('validateBootstrap risky-combination warnings (docs/setup/horizon-yaml.md "Warnings")', () => {
  const warnings = (): string[] =>
    vi
      .mocked(logger.warn)
      .mock.calls.map((c) => c.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));

  afterEach(() => vi.restoreAllMocks());

  const localUser = { username: 'a', passwordHash: '$argon2id$x', roles: ['admin'] };

  it('warns when auth.breakGlass is set under backend:local', () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const cfg = configSchema.parse({
      auth: {
        backend: 'local',
        local: { users: [localUser] },
        breakGlass: { username: 'bg', passwordHash: '$argon2id$y' },
      },
    });
    validateBootstrap(cfg);
    expect(warnings().some((w) => w.includes('breakGlass'))).toBe(true);
  });

  it('warns when debugLog.enabled with redactAuthHeaders false', () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const cfg = configSchema.parse({
      auth: { backend: 'local', local: { users: [localUser] } },
      debugLog: { enabled: true, redactAuthHeaders: false },
    });
    validateBootstrap(cfg);
    expect(warnings().some((w) => w.includes('redactAuthHeaders'))).toBe(true);
  });

  it('stays quiet when debugLog redaction is on and no risky combo is set', () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const cfg = configSchema.parse({
      auth: { backend: 'local', local: { users: [localUser] } },
      debugLog: { enabled: true },
      session: { cookieSecure: true },
    });
    validateBootstrap(cfg);
    expect(warnings()).toEqual([]);
  });

  it('warns on cookieSecure:false outside dev (NODE_ENV-dependent)', () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const prevEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const cfg = configSchema.parse({
        auth: { backend: 'local', local: { users: [localUser] } },
      });
      validateBootstrap(cfg);
      expect(warnings().some((w) => w.includes('cookieSecure'))).toBe(true);
    } finally {
      process.env.NODE_ENV = prevEnv;
    }
  });
});

/**
 * `oauth.signingKey` is the only secret behind every token, authorization code
 * and client registration this server issues — and because none of them are
 * stored, there is no issued-credential list to check a forgery against.
 * Anyone who can guess the key mints working credentials for any user.
 */
describe('a signing key too short to be a secret disables the authorization server', () => {
  const withKey = (signingKey: string) => {
    const cfg = configSchema.parse({
      server: { publicUrl: 'https://horizon.example.com' },
      oauth: { enabled: true, signingKey, issuer: 'https://horizon.example.com' },
    });
    validateBootstrap(cfg);
    return cfg;
  };

  it('clears a short key, so every "no key means off" path applies unchanged', () => {
    expect(withKey('local-test-key').oauth.signingKey).toBe('');
  });

  it('keeps a key of the minimum length and longer', () => {
    const ok = 'x'.repeat(32);
    expect(withKey(ok).oauth.signingKey).toBe(ok);
    const long = 'y'.repeat(64);
    expect(withKey(long).oauth.signingKey).toBe(long);
  });

  it('rejects one character below the floor', () => {
    expect(withKey('z'.repeat(31)).oauth.signingKey).toBe('');
  });
});

/**
 * The boot report has two levels and the line between them is a contract, not
 * a style choice: ERROR means you asked for something and it is NOT running,
 * WARN means it is running with a risk you may have chosen.
 *
 * It matters because some of these have no other surface — nothing in the admin
 * UI shows whether the authorization server came up, so a misconfigured `oauth`
 * block is visible only in this log. Among warnings an operator scrolls past,
 * it may as well be silent.
 */
describe('boot report: error means it is not running, warn means it is', () => {
  afterEach(() => vi.restoreAllMocks());

  const boot = (over: Record<string, unknown>) => {
    const errors: string[] = [];
    const warns: string[] = [];
    vi.spyOn(logger, 'error').mockImplementation(((...a: unknown[]) => {
      errors.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
    }) as never);
    vi.spyOn(logger, 'warn').mockImplementation(((...a: unknown[]) => {
      warns.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
    }) as never);
    validateBootstrap(configSchema.parse(over));
    return { errors: errors.join('\n'), warns: warns.join('\n') };
  };

  it('errors when an enabled authorization server cannot start', () => {
    const r = boot({
      server: { publicUrl: 'https://h.example.com' },
      auth: { local: { users: [{ username: 'a', passwordHash: 'x', roles: ['admin'] }] } },
      oauth: { enabled: true, signingKey: 'too-short', issuer: 'https://h.example.com' },
    });
    expect(r.errors).toMatch(/signingKey is too short/);
    expect(r.warns).not.toMatch(/signingKey is too short/);
  });

  it('errors when no login could possibly succeed', () => {
    expect(boot({ auth: { backend: 'local', local: { users: [] } } }).errors)
      .toMatch(/auth\.local\.users is empty/);
  });

  /** Running, and open on purpose for a public demo — the operator's call. */
  it('only warns about a risk that is still working', () => {
    const r = boot({
      auth: {
        local: { users: [{ username: 'a', passwordHash: 'x', roles: ['admin'] }] },
        sso: { providers: [{ id: 'g', issuer: 'https://idp.example', clientId: 'c', clientSecret: 's' }] },
      },
    });
    expect(r.warns).toMatch(/allowedDomains is empty/);
    expect(r.errors).not.toMatch(/allowedDomains is empty/);
  });
});

/**
 * Roles resolve local-first, so a local user NAMED with an email address
 * answers for the SSO identity at that address. Reproduced before the guard: an
 * SSO operator whose role table said `viewer` was issued `admin`, and the
 * consent screen showed the SSO roles while the token carried the local ones.
 */
describe('a local username that is an email collides with an SSO identity', () => {
  const build = (users: { username: string; passwordHash: string; roles: string[] }[], sso = true) => {
    const cfg = configSchema.parse({
      auth: {
        local: { users },
        ...(sso
          ? { sso: { providers: [{ id: 'g', issuer: 'https://idp.example', clientId: 'c', clientSecret: 's' }],
                     roles: { defaultRoles: ['viewer'] } } }
          : {}),
      },
    });
    validateBootstrap(cfg);
    return cfg;
  };

  it('drops the colliding account rather than letting it answer for the address', () => {
    const cfg = build([
      { username: 'boss@corp.com', passwordHash: 'x', roles: ['admin'] },
      { username: 'ops', passwordHash: 'x', roles: ['operator'] },
    ]);
    expect(cfg.auth.local.users.map((u) => u.username)).toEqual(['ops']);
  });

  it('leaves ordinary local users alone', () => {
    const cfg = build([{ username: 'admin', passwordHash: 'x', roles: ['admin'] }]);
    expect(cfg.auth.local.users.map((u) => u.username)).toEqual(['admin']);
  });

  /** With no SSO configured there is no identity to collide with, and an
   *  email-shaped local username is merely unusual. */
  it('keeps an email-shaped username when no provider is configured', () => {
    const cfg = build([{ username: 'boss@corp.com', passwordHash: 'x', roles: ['admin'] }], false);
    expect(cfg.auth.local.users.map((u) => u.username)).toEqual(['boss@corp.com']);
  });

  it('drops an email-shaped break-glass username too', () => {
    const cfg = configSchema.parse({
      auth: {
        backend: 'ldap',
        breakGlass: { username: 'sos@corp.com', passwordHash: 'x', roles: ['admin'] },
        sso: { providers: [{ id: 'g', issuer: 'https://idp.example', clientId: 'c', clientSecret: 's' }] },
      },
    });
    validateBootstrap(cfg);
    expect(cfg.auth.breakGlass).toBeUndefined();
  });
});

/**
 * Reload lifecycle. These drive the real watcher against a real file, because
 * the thing under test IS the file→config path — a mocked fs would prove the
 * test's own wiring. `awaitWriteFinishMs` is shortened so a case costs
 * milliseconds rather than chokidar's default two seconds.
 *
 * Both directions of a regression are damaging, which is why the rejection
 * cases outnumber the happy one: a reload that fails to apply leaves an
 * operator editing a file that does nothing, while a reload that applies the
 * WRONG thing silently swaps live configuration — credentials, roles, OAP
 * targets — for something nobody authored.
 */
describe('config reload', () => {
  const WATCH_MS = 40;
  let dir: string;
  let file: string;
  const open: Array<{ close: () => Promise<void> }> = [];

  const yaml = (oapUrl: string): string =>
    `oap:\n  queryUrl: "${oapUrl}"\nauth:\n  backend: local\n  local:\n    users: []\n`;

  const load = (): ReturnType<typeof loadConfig> => {
    const src = loadConfig(file, {
      awaitWriteFinishMs: WATCH_MS,
      pollIntervalMs: 20,
    });
    open.push(src);
    return src;
  };

  /**
   * Re-apply `write` until `check` passes, or give up.
   *
   * The retry is not politeness about slow machines — chokidar attaches its
   * watcher asynchronously and `loadConfig` returns before that finishes, so a
   * single write racing construction is simply missed. Re-writing until the
   * change lands removes the race without a bare sleep, which would trade a
   * flake for a slower flake.
   */
  const settledAfter = async (
    write: () => void,
    check: () => boolean,
    ms = 4000,
  ): Promise<boolean> => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      write();
      const inner = Date.now() + WATCH_MS * 4;
      while (Date.now() < inner) {
        if (check()) return true;
        await new Promise((r) => setTimeout(r, 10));
      }
    }
    return check();
  };

  beforeEach(() => {
    // realpath, not the raw mkdtemp path: on macOS `tmpdir()` is a symlink
    // (/var → /private/var) and the watcher resolves the path without
    // following it, so events would arrive for a path it is not watching.
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'horizon-config-')));
    file = join(dir, 'horizon.yaml');
    writeFileSync(file, yaml('http://before:12800'));
  });

  afterEach(async () => {
    for (const s of open.splice(0)) await s.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('applies a valid edit without a restart, and notifies listeners', async () => {
    const src = load();
    expect(src.current.oap.queryUrl).toBe('http://before:12800');

    const seen: string[] = [];
    src.onChange((cfg) => seen.push(cfg.oap.queryUrl));

    expect(
      await settledAfter(
        () => writeFileSync(file, yaml('http://after:12800')),
        () => src.current.oap.queryUrl === 'http://after:12800',
      ),
    ).toBe(true);
    // The listener sees the NEW config, and `current` is already swapped by
    // the time it runs — a subscriber may read either and get the same answer.
    expect(seen.at(-1)).toBe('http://after:12800');
  });

  it('reloads when a Kubernetes projected volume rotates its ..data symlink', async () => {
    rmSync(file);
    let version = 0;
    const rotate = (oapUrl: string): void => {
      const versionName = `..2026_01_01_00_00_00.${version++}`;
      const versionDir = join(dir, versionName);
      mkdirSync(versionDir);
      writeFileSync(join(versionDir, 'horizon.yaml'), yaml(oapUrl));

      // Kubernetes' AtomicWriter publishes a new payload by atomically
      // replacing `..data`; the visible key symlink itself never changes.
      const nextData = join(dir, '..data_tmp');
      symlinkSync(versionName, nextData);
      renameSync(nextData, join(dir, '..data'));
    };

    rotate('http://before:12800');
    symlinkSync('..data/horizon.yaml', file);

    const src = load();
    const seen: string[] = [];
    src.onChange((cfg) => seen.push(cfg.oap.queryUrl));

    expect(
      await settledAfter(
        // Same byte length as "before": this must detect the projected-file
        // replacement itself, not merely notice that the target size changed.
        () => rotate('http://second:12800'),
        () => src.current.oap.queryUrl === 'http://second:12800',
      ),
    ).toBe(true);
    expect(readFileSync(file, 'utf8')).toContain('http://second:12800');
    expect(seen.at(-1)).toBe('http://second:12800');
  });

  it('rejects a malformed edit and keeps serving the previous config', async () => {
    const src = load();
    const errs = vi.spyOn(logger, 'error').mockImplementation(() => logger);

    expect(
      await settledAfter(
        () => writeFileSync(file, 'oap: [this is not the shape\n'),
        () => errs.mock.calls.length > 0,
      ),
    ).toBe(true);
    // The whole point: a bad edit changes nothing that is serving.
    expect(src.current.oap.queryUrl).toBe('http://before:12800');
    errs.mockRestore();
  });

  /**
   * An INVARIANT, not a reproduction — and the distinction matters to whoever
   * reads this next.
   *
   * `parseFile` treats ENOENT as "run on defaults", which is right at BOOT:
   * bootstrap validation rejects an empty config on first start. On a RELOAD it
   * would be silent and catastrophic, because defaults are a VALID config —
   * every configured user, OAP URL, role and key would be swapped for a default
   * with nothing to say so. `loadConfig` therefore passes `allowMissing: false`
   * on the reload path.
   *
   * This test could NOT be made to fail against the unfixed code, and that is a
   * fact about the watcher rather than about the fix: only `change` is
   * subscribed, so a deleted file never reaches the reload path. The guard is
   * defensive — it closes the door on the narrow race where `change` fires and
   * the file is gone by the time it is read, which is reachable in principle
   * (a symlink swap mid-stabilisation) and not reproducible on demand here.
   *
   * So: assert the invariant, and do not claim regression coverage the case
   * does not provide.
   */
  it('never serves schema defaults after the file goes missing', async () => {
    const src = load();
    const errs = vi.spyOn(logger, 'error').mockImplementation(() => logger);

    rmSync(file);
    await new Promise((r) => setTimeout(r, WATCH_MS * 10));

    expect(src.current.oap.queryUrl).toBe('http://before:12800');
    expect(src.current.oap.queryUrl).not.toBe(configSchema.parse({}).oap.queryUrl);
    errs.mockRestore();
  });

  it('stops watching once closed', async () => {
    const src = load();
    await src.close();
    open.length = 0;

    writeFileSync(file, yaml('http://after-close:12800'));
    await new Promise((r) => setTimeout(r, WATCH_MS * 10));
    expect(src.current.oap.queryUrl).toBe('http://before:12800');
  });
});
