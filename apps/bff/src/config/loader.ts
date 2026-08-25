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
import { resolve } from 'node:path';
import chokidar from 'chokidar';
import YAML from 'yaml';
import { ZodError } from 'zod';
import { configSchema, type HorizonConfig } from './schema.js';
import { logger } from '../logger.js';

export interface ConfigSource {
  readonly current: HorizonConfig;
  readonly path: string;
  /** Function form for code paths that prefer a getter call. Returns the same as `.current`. */
  current_(): HorizonConfig;
  onChange(fn: (cfg: HorizonConfig) => void): () => void;
  close(): Promise<void>;
}

/**
 * Resolve `${VAR}` and `${VAR:default}` references in the raw YAML text
 * BEFORE handing it to the YAML parser. We operate on the text rather
 * than walking the parsed tree so a `${VAR}` inside any string value
 * (including ones embedded in quotes) is handled uniformly. Unset vars
 * with no default expand to the empty string; the zod schema then
 * decides whether that's acceptable for the field in question.
 */
export function interpolateEnv(
  raw: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return raw.replace(/\$\{([A-Z_][A-Z0-9_]*)(?::([^}]*))?\}/gi, (_m, name, def) => {
    const v = env[name];
    if (v !== undefined && v !== '') return v;
    return def ?? '';
  });
}

/**
 * Recursively drop keys whose value is `null`. A `${VAR:null}` token (used for
 * optional blocks + structured defaults like `oap.auth`, `auth.ldap`,
 * `rbac.roles`, `performance`) resolves to `null` when the env var is unset,
 * meaning "not provided — use the schema default", NOT an explicit null. No
 * config field legitimately accepts null, so stripping them lets the strict
 * schema fall through to its default instead of rejecting `key: null`.
 */
export function stripNullish(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripNullish);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === null) continue;
      out[k] = stripNullish(v);
    }
    return out;
  }
  return value;
}

/** Raised when the loaded config is structurally valid but operationally
 *  unusable in a way that cannot be deferred to runtime (reserved — no
 *  current callers; the auth-unconfigured cases boot and surface the
 *  problem on the login page instead). */
export class BootstrapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BootstrapError';
  }
}

/**
 * Returns `true` when the loaded config has a usable auth backend wired
 * (at least one local user, or an LDAP block with a non-empty group
 * mappings table). Returns `false` when the operator hasn't finished
 * setting up auth — the BFF still boots, login attempts are rejected
 * with helpful messages, and the login page shows a setup-required
 * banner driven by `/api/auth/health`. The frame for this is that an
 * out-of-the-box `docker run` should reach a visible UI rather than
 * crash with a log line a beginner won't see.
 */
export function isAuthConfigured(cfg: HorizonConfig): boolean {
  // A configured sign-in provider IS a way in, and the only one an SSO-only
  // deployment has. Without this the login page shows "Auth not configured"
  // above a working Continue-with button, which reads as broken.
  if (cfg.auth.sso.providers.length > 0) return true;
  if (cfg.auth.backend === 'local') {
    return cfg.auth.local.users.length > 0;
  }
  if (cfg.auth.backend === 'ldap') {
    return !!cfg.auth.ldap && cfg.auth.ldap.groupMappings.length > 0;
  }
  return false;
}

/**
 * Inspect the loaded config and emit a startup warning if auth isn't
 * wired yet, or if a risky-but-legal combination is set (break-glass
 * under local backend, wire log without auth redaction, insecure
 * session cookies outside dev). Separate from `loadConfig` so callers
 * can skip it (tests) or run it on config hot-reload too.
 *
 * A misconfigured deployment boots and logs a warning rather than
 * crashing, surfacing the same information to the login page so the
 * first interaction is "open browser → see the next step" rather than
 * "watch container logs → guess what's wrong".
 *
 * Returns the input on success so callers can chain.
 */
/**
 * Boot-time configuration report, and the line between its two levels.
 *
 * ERROR means you asked for something and it is NOT running: nobody can log
 * in, or a feature you switched on stayed off. WARN means it IS running and
 * carries a risk you may have chosen deliberately — an open provider on a
 * public demo, plain HTTP in local development.
 *
 * The distinction matters because some of these have no other surface. There
 * is no admin page showing whether the authorization server came up, so a
 * misconfigured `oauth` block is visible only here — buried among warnings an
 * operator has learned to scroll past, it is invisible.
 */
export function validateBootstrap(cfg: HorizonConfig): HorizonConfig {
  // One public URL, two consumers. Resolved once here so neither feature has
  // to know about the other's config, and so a deployment sets it in one place.
  if (!cfg.oauth.issuer && cfg.server.publicUrl) cfg.oauth.issuer = cfg.server.publicUrl;
  if (cfg.auth.breakGlass && cfg.auth.backend === 'local') {
    logger.warn(
      'auth.breakGlass is configured but auth.backend is "local" — the break-glass ' +
        'account only exists as an LDAP-outage fallback, so the block is unused in local mode.',
    );
  }
  if (cfg.debugLog.enabled && !cfg.debugLog.redactAuthHeaders) {
    logger.warn(
      { file: cfg.debugLog.file },
      'debugLog.enabled with redactAuthHeaders: false — outbound OAP basic-auth ' +
        'credentials are being written to the wire log in clear text. Only run this ' +
        'way for a short troubleshooting session, and clear the file afterward.',
    );
  }
  if (!cfg.session.cookieSecure && process.env.NODE_ENV !== 'development') {
    logger.warn(
      'session.cookieSecure is false — session cookies are sent over plain HTTP. ' +
        'Fine for localhost; set it to true (and serve over HTTPS) in production.',
    );
  }
  /**
   * A local username that is an EMAIL ADDRESS collides with an SSO identity.
   *
   * Roles resolve local-first, so a local user named `boss@corp.com` answers
   * for the SSO identity at the same address — an operator whose SSO table
   * says `viewer` is issued `admin`, and the consent screen shows the roles
   * the SSO table gave while the token carries the local ones. Reproduced.
   *
   * Such a user is dropped, not merely warned about: leaving it configured
   * leaves the escalation in place, and its own password login is the thing
   * that has to give way — SSO is what the address is for. Rename it to
   * something without an `@` to keep it.
   */
  if (cfg.auth.sso.providers.length > 0) {
    const colliding = cfg.auth.local.users.filter((u) => u.username.includes('@'));
    if (colliding.length) {
      logger.error(
        { usernames: colliding.map((u) => u.username) },
        'auth.local: a local username that is an email address collides with an SSO identity at ' +
          'the same address, and local roles win — so these accounts would answer for SSO users ' +
          'and could grant them more than their SSO roles. They are IGNORED. Rename them without ' +
          'an "@", or remove them and grant the address through auth.sso.roles.',
      );
      cfg.auth.local.users = cfg.auth.local.users.filter((u) => !u.username.includes('@'));
    }
    if (cfg.auth.breakGlass?.username.includes('@')) {
      logger.error(
        { username: cfg.auth.breakGlass.username },
        'auth.breakGlass: the emergency username is an email address, which collides with an SSO ' +
          'identity at the same address. It is IGNORED — rename it without an "@".',
      );
      cfg.auth.breakGlass = undefined;
    }
  }

  if (cfg.oauth.enabled) {
    // Both are REQUIRED, and the endpoints refuse to serve without them rather
    // than improvising. `issuer` in particular is never derived from the Host
    // header: discovery tells a client where to send its user to log in, so a
    // guessed value is an invitation to point that somewhere else.
    /**
     * A weak signing key is treated as no key at all.
     *
     * This one HMAC secret signs every access token, refresh token,
     * authorization code, client registration and consent request. The server
     * keeps no record of what it issued, so anyone who can guess it can mint a
     * credential for any user and nothing on the server can tell the difference
     * — there is no issued-token list to compare against. `local-test-key` would
     * have started an authorization server as happily as 32 random bytes.
     *
     * Cleared rather than rejected so every existing "no key means OFF" path
     * applies unchanged, and so a bad value cannot take a running Horizon down
     * on restart — it takes only the authorization server down, loudly.
     */
    const MIN_SIGNING_KEY = 32;
    if (cfg.oauth.signingKey && cfg.oauth.signingKey.length < MIN_SIGNING_KEY) {
      logger.error(
        { length: cfg.oauth.signingKey.length, minimum: MIN_SIGNING_KEY },
        'oauth.signingKey is too short to be a secret — the authorization server stays OFF. ' +
          'It signs every token this server issues and none of them are recorded, so a guessable ' +
          'key mints valid credentials for any user. Generate one with `openssl rand -base64 32`.',
      );
      cfg.oauth.signingKey = '';
    }
    const missing = [
      ...(cfg.oauth.signingKey ? [] : ['oauth.signingKey']),
      ...(cfg.oauth.issuer ? [] : ['oauth.issuer']),
    ];
    if (missing.length) {
      logger.error(
        { missing },
        'oauth.enabled is true but the authorization server is not configured — ' +
          'it stays OFF and its endpoints answer 404. Set the missing values ' +
          '(issuer is the PUBLIC base URL clients reach Horizon at, e.g. ' +
          'https://horizon.example.com; signingKey is a secret, set it from the ' +
          'environment) or set oauth.enabled: false to silence this.',
      );
    } else if (!/^https?:\/\/[^/]+/.test(cfg.oauth.issuer)) {
      logger.error(
        { issuer: cfg.oauth.issuer },
        'oauth.issuer must be an absolute http(s) URL — the authorization server stays OFF.',
      );
    } else if (cfg.oauth.issuer.startsWith('http://') && process.env.NODE_ENV !== 'development') {
      logger.warn(
        { issuer: cfg.oauth.issuer },
        'oauth.issuer is plain HTTP — authorization codes and tokens will cross the ' +
          'network in clear text. Serve Horizon over HTTPS outside local development.',
      );
    }
  }
  // Every lookup of a provider is `find(p => p.id === id)`, so a duplicate id
  // is not a duplicate button — it is a DEAD one. Both entries render, and
  // clicking either signs the person in through the FIRST: under its client
  // credentials and, more to the point, under its `allowedDomains`. The second
  // provider's admission rule is silently never applied.
  const byId = new Map<string, number>();
  for (const p of cfg.auth.sso.providers) byId.set(p.id, (byId.get(p.id) ?? 0) + 1);
  const duplicated = [...byId].filter(([, n]) => n > 1).map(([id]) => id);
  if (duplicated.length) {
    logger.error(
      { ids: duplicated },
      'auth.sso: two or more providers share an id. Only the first is reachable — the others render a ' +
        'button that authenticates through it, under its client and its allowedDomains. Give each provider ' +
        'a distinct id.',
    );
  }

  for (const p of cfg.auth.sso.providers) {
    if (!p.clientSecret) {
      logger.error({ provider: p.id }, 'auth.sso: clientSecret is empty — this provider cannot complete a login.');
    }
    if (p.allowedDomains.length === 0) {
      logger.warn(
        { provider: p.id },
        'auth.sso: allowedDomains is empty — ANYONE with an account at this provider can sign in. ' +
          'Right for a public demo where every visitor is a viewer; almost never right otherwise.',
      );
    }
  }
  const ssoOnly = cfg.auth.sso.providers.length > 0;
  if (cfg.auth.backend === 'local' && cfg.auth.local.users.length === 0 && ssoOnly) {
    logger.info(
      { providers: cfg.auth.sso.providers.map((p) => p.id) },
      'auth: no local users, but single sign-on is configured — password login will reject everyone ' +
        'and the provider buttons are the way in. Consider one local break-glass account for the day ' +
        'a provider is unreachable.',
    );
  } else if (cfg.auth.backend === 'local' && cfg.auth.local.users.length === 0) {
    logger.error(
      'auth.backend is "local" but auth.local.users is empty. ' +
        'BFF is booting but no login will succeed until you add at least one user ' +
        '(use `pnpm --filter bff cli:hash` for the password hash) or switch to LDAP. ' +
        'The login page will surface this state to the operator.',
    );
  } else if (cfg.auth.backend === 'ldap') {
    if (!cfg.auth.ldap) {
      logger.error(
        'auth.backend is "ldap" but auth.ldap is missing. ' +
          'BFF is booting but every login attempt will fail until you configure ' +
          'the directory connection or switch to local users.',
      );
    } else if (cfg.auth.ldap.groupMappings.length === 0) {
      logger.error(
        'auth.ldap.groupMappings is empty — no LDAP user would be assigned any role, ' +
          'so every login will fail. Add at least one mapping (use `group: "*"` to ' +
          'assign a fallback role to everyone). BFF is booting; the login page will ' +
          'surface this state.',
      );
    }
  }
  return cfg;
}

/**
 * @param allowMissing at BOOT a missing file means "run on defaults" — the
 *   bootstrap validation that follows rejects it on first start anyway. On a
 *   RELOAD it must NOT: defaults are a valid config, so accepting them would
 *   silently swap every configured user, OAP URL, role and key for a default,
 *   which is the one outcome the reload path promises never to produce.
 */
function parseFile(absPath: string, allowMissing: boolean): HorizonConfig {
  let raw = '';
  try {
    raw = readFileSync(absPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT' && allowMissing) {
      return configSchema.parse({});
    }
    throw err;
  }
  const interpolated = interpolateEnv(raw);
  const parsed = YAML.parse(interpolated) ?? {};
  return configSchema.parse(stripNullish(parsed));
}

export interface LoadConfigOptions {
  /** How long chokidar waits for writes to settle before emitting `change`.
   *  Defaults to its own 2s. Tests shorten it so a reload case does not cost
   *  two seconds of wall clock each — the same seam `SessionStore` exposes
   *  for its reaper interval. */
  awaitWriteFinishMs?: number;
  /** How often to stat the config file. Polling is intentional: Kubernetes
   *  projected ConfigMap volumes update a file by rotating the `..data`
   *  symlink, which an exact-path filesystem watcher does not report as a
   *  `change`. The production default is inexpensive for this single file;
   *  tests shorten it alongside `awaitWriteFinishMs`. */
  pollIntervalMs?: number;
}

export function loadConfig(configPath: string, opts: LoadConfigOptions = {}): ConfigSource {
  const absPath = resolve(configPath);
  let current = parseFile(absPath, true);
  validateBootstrap(current);
  const listeners = new Set<(cfg: HorizonConfig) => void>();

  const watcher = chokidar.watch(absPath, {
    ignoreInitial: true,
    // `fs.watch` follows the original projected-volume symlink and misses the
    // atomic target replacement. `fs.watchFile` (chokidar polling) stats the
    // configured pathname repeatedly, so both ordinary writes and Kubernetes
    // `..data` rotations arrive through the same `change` path below.
    usePolling: true,
    interval: opts.pollIntervalMs ?? 1000,
    awaitWriteFinish: opts.awaitWriteFinishMs
      ? { stabilityThreshold: opts.awaitWriteFinishMs, pollInterval: 20 }
      : true,
  });
  watcher.on('change', () => {
    let next: HorizonConfig;
    try {
      next = parseFile(absPath, false);
      validateBootstrap(next);
    } catch (err) {
      // A malformed reload must not kill the watcher — the previous valid
      // config keeps serving — but the operator has to hear that their edit
      // did NOT apply, in the same field-path shape the boot failure uses.
      if (err instanceof ZodError) {
        const issues = err.issues
          .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
          .join('; ');
        logger.error(
          { issues, configPath: absPath },
          'config reload rejected — fix the value at each path (previous valid config keeps serving)',
        );
      } else {
        // First line only: YAML parse errors carry a code frame quoting the
        // offending source, and by this point the text has real secrets
        // interpolated into it (oap.auth.password, ai.apiKey, …).
        const reason =
          err instanceof Error ? `${err.name}: ${err.message.split('\n')[0]}` : String(err);
        logger.error(
          { reason, configPath: absPath },
          'config reload failed to read/parse — fix the file (previous valid config keeps serving)',
        );
      }
      return;
    }
    current = next;
    for (const fn of listeners) {
      try {
        fn(next);
      } catch (err) {
        logger.error({ err }, 'config onChange listener failed — new config is active regardless');
      }
    }
  });

  return {
    get current() {
      return current;
    },
    current_: () => current,
    path: absPath,
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    async close() {
      await watcher.close();
    },
  };
}
