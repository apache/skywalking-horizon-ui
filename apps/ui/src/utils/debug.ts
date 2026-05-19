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
 * Scoped, opt-in console logger. Most operators don't need browser-side
 * trace logs — the BFF's pino output is authoritative for backend flow.
 * But "did the template sync actually load?" and "which OAP-side row are
 * we showing?" questions are easier to answer in the browser than by
 * tailing the BFF, so this wrapper makes per-scope tracing one toggle.
 *
 * Enable any of:
 *   - `localStorage.setItem('horizon:debug', '1')`            — all scopes
 *   - `localStorage.setItem('horizon:debug', 'templates')`    — one scope
 *   - `localStorage.setItem('horizon:debug', 'templates,api')` — many
 *   - `?debug=1` / `?debug=templates` in the URL              — same set
 *
 * Output prefixes the scope so `[templates] sync: 12 synced, 2 diverged`
 * is easy to grep in devtools. `console.debug` is hidden by default in
 * Chrome — operators must enable the "Verbose" log level to see it.
 */

const SCOPES_KEY = 'horizon:debug';

function readEnabledScopes(): Set<string> | null {
  const sources: string[] = [];
  if (typeof localStorage !== 'undefined') {
    try {
      const raw = localStorage.getItem(SCOPES_KEY);
      if (raw) sources.push(raw);
    } catch {
      /* private mode / disabled storage — ignore */
    }
  }
  if (typeof location !== 'undefined') {
    try {
      const v = new URLSearchParams(location.search).get('debug');
      if (v) sources.push(v);
    } catch {
      /* malformed URL — ignore */
    }
  }
  if (sources.length === 0) return null;
  const all = new Set<string>();
  for (const s of sources) {
    for (const t of s.split(',').map((x) => x.trim()).filter(Boolean)) {
      all.add(t);
    }
  }
  return all;
}

let cachedScopes: Set<string> | null | undefined;

function enabledFor(scope: string): boolean {
  if (cachedScopes === undefined) cachedScopes = readEnabledScopes();
  if (!cachedScopes) return false;
  return cachedScopes.has('1') || cachedScopes.has('*') || cachedScopes.has(scope);
}

/** Refresh the cached scope set — call after the operator toggles
 *  localStorage at runtime, otherwise the cached value sticks. */
export function reloadDebugScopes(): void {
  cachedScopes = undefined;
}

/** Emit a `console.debug(...)` line prefixed with `[scope]`, but only
 *  when that scope (or the wildcard) is enabled. Cheap when disabled —
 *  the args are still evaluated, so prefer `if (debugEnabled('x'))`
 *  around expensive computations. */
export function debug(scope: string, ...args: unknown[]): void {
  if (!enabledFor(scope)) return;
  console.debug(`[${scope}]`, ...args);
}

export function debugEnabled(scope: string): boolean {
  return enabledFor(scope);
}
