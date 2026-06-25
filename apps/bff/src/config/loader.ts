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
 * wired yet. Kept as a separate function (rather than inlined into
 * `loadConfig`) so callers can choose to skip it (tests) or run it on
 * config hot-reload too.
 *
 * The historical contract was fail-loud — a misconfigured deployment
 * crashed on boot. That was inconvenient for first-touch operators:
 * a clean `docker run` produced a CrashLoopBackOff instead of a UI
 * with a "set up auth" hint. We now boot, log a warning, and surface
 * the same information to the login page so the first interaction is
 * "open browser → see the next step" rather than "watch container
 * logs → guess what's wrong".
 *
 * Returns the input on success so callers can chain.
 */
export function validateBootstrap(cfg: HorizonConfig): HorizonConfig {
  if (cfg.auth.backend === 'local' && cfg.auth.local.users.length === 0) {
    logger.warn(
      'auth.backend is "local" but auth.local.users is empty. ' +
        'BFF is booting but no login will succeed until you add at least one user ' +
        '(use `pnpm --filter bff cli:hash` for the password hash) or switch to LDAP. ' +
        'The login page will surface this state to the operator.',
    );
  } else if (cfg.auth.backend === 'ldap') {
    if (!cfg.auth.ldap) {
      logger.warn(
        'auth.backend is "ldap" but auth.ldap is missing. ' +
          'BFF is booting but every login attempt will fail until you configure ' +
          'the directory connection or switch to local users.',
      );
    } else if (cfg.auth.ldap.groupMappings.length === 0) {
      logger.warn(
        'auth.ldap.groupMappings is empty — no LDAP user would be assigned any role, ' +
          'so every login will fail. Add at least one mapping (use `group: "*"` to ' +
          'assign a fallback role to everyone). BFF is booting; the login page will ' +
          'surface this state.',
      );
    }
  }
  return cfg;
}

function parseFile(absPath: string): HorizonConfig {
  let raw = '';
  try {
    raw = readFileSync(absPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      // No config file → use full defaults. Bootstrap validation still
      // runs and will reject this (no users, no ldap) on first start.
      return configSchema.parse({});
    }
    throw err;
  }
  const interpolated = interpolateEnv(raw);
  const parsed = YAML.parse(interpolated) ?? {};
  return configSchema.parse(stripNullish(parsed));
}

export function loadConfig(configPath: string): ConfigSource {
  const absPath = resolve(configPath);
  let current = parseFile(absPath);
  validateBootstrap(current);
  const listeners = new Set<(cfg: HorizonConfig) => void>();

  const watcher = chokidar.watch(absPath, { ignoreInitial: true, awaitWriteFinish: true });
  watcher.on('change', () => {
    try {
      const next = parseFile(absPath);
      validateBootstrap(next);
      current = next;
      for (const fn of listeners) fn(next);
    } catch {
      // Swallow; the server logs the parse/validation error elsewhere when
      // it tries to use the new config. We don't want a malformed reload
      // to kill the watcher — the previous valid config keeps serving.
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
