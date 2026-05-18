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

/** Raised when the loaded config is structurally valid but operationally
 *  unusable (e.g. no auth backend wired). */
export class BootstrapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BootstrapError';
  }
}

/**
 * Refuse to start when neither auth backend has a usable configuration.
 * The principle is fail-loud: a misconfigured deployment should crash on
 * boot with a clear pointer, not silently accept no logins.
 *
 * Returns the input on success so callers can chain.
 */
export function validateBootstrap(cfg: HorizonConfig): HorizonConfig {
  if (cfg.auth.backend === 'local') {
    if (cfg.auth.local.users.length === 0) {
      throw new BootstrapError(
        'auth.backend is "local" but auth.local.users is empty. ' +
          'Add at least one user (use `pnpm --filter bff cli:hash` for the password hash) ' +
          'or switch to LDAP.',
      );
    }
  } else if (cfg.auth.backend === 'ldap') {
    if (!cfg.auth.ldap) {
      throw new BootstrapError(
        'auth.backend is "ldap" but auth.ldap is missing. ' +
          'Configure the directory connection or switch to local users.',
      );
    }
    if (cfg.auth.ldap.groupMappings.length === 0) {
      throw new BootstrapError(
        'auth.ldap.groupMappings is empty — no LDAP user would be assigned any role. ' +
          'Add at least one mapping (use `group: "*"` to assign a fallback role to everyone).',
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
  return configSchema.parse(parsed);
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
