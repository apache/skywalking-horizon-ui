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
 * Preflight — a REACHABILITY check of every OAP admin feature Horizon
 * depends on. Each feature declares the relative admin REST path it
 * actually calls; the BFF fires a safe GET at that path and reports
 * whether it responds.
 *
 * Health = `reachable`, NOT `enabled`. The config-dump prefix check
 * (`enabled`) only tells us the *official upstream release* advertises
 * that selector — a fork / rename / different layout can be perfectly
 * reachable yet show "disabled", or advertise a selector that 404s. So
 * `enabled` is demoted to an informational footnote and the real GET
 * decides green/red. A 404 = the route isn't there = unreachable.
 *
 * Cost is bounded by a single-flight cache (`getPreflight`): concurrent
 * / multi-user `/api/preflight` reads share one round of probes. It
 * stays on-demand (only runs while a page is watching), not a timer.
 *
 * If the admin port itself is down (`/debugging/config/dump` fails) we
 * return early with `adminReachable: false` and every feature
 * `reachable: false` — fix the network / port first, not selectors.
 */

import type {
  FetchLike,
  PreflightModule,
  PreflightResult,
} from '@skywalking-horizon-ui/api-client';
import type { HorizonConfig } from '../../config/schema.js';

export type { PreflightModule, PreflightResult };

interface ModuleDef {
  name: string;
  envVar: string;
  required: boolean;
  /** Relative admin REST path the BFF GETs to test reachability. */
  probePath: string;
  affects: string;
}

const REQUIRED_MODULES: readonly ModuleDef[] = [
  {
    name: 'admin-server',
    envVar: 'SW_ADMIN_SERVER',
    required: true,
    probePath: '/debugging/config/dump',
    affects:
      'Everything Studio does against the admin port. Without admin-server, the other modules fail at boot with ModuleNotFoundException.',
  },
  {
    name: 'receiver-runtime-rule',
    envVar: 'SW_RECEIVER_RUNTIME_RULE',
    required: true,
    probePath: '/runtime/rule/list',
    affects:
      "DSL Management (Catalog, OAL catalog), Editor save/load, Cluster status rule matrix, Live debugger rule picker, and the Inspect drawer's source attribution.",
  },
  {
    name: 'dsl-debugging',
    envVar: 'SW_DSL_DEBUGGING',
    required: true,
    probePath: '/dsl-debugging/status',
    affects:
      'Live debugger across MAL / LAL / OAL (start / poll / stop) and the DSL-debugging health pane on Cluster status.',
  },
  {
    name: 'inspect',
    envVar: 'SW_INSPECT',
    required: true,
    probePath: '/inspect/metrics',
    affects:
      'The Inspect page — every /api/inspect/* call returns 404 inspect_not_enabled and the page shows a banner instead of the board.',
  },
  {
    name: 'ui-management',
    envVar: 'SW_UI_MANAGEMENT',
    required: true,
    probePath: '/ui-management/templates',
    affects:
      'Dashboard templates — the layer / overview / alert / 3D template store the config surface reads and writes. Unreachable in live mode blocks the config surface; in readonly mode Horizon serves bundled templates and never calls it.',
  },
];

export async function runPreflight(
  config: HorizonConfig,
  fetch: FetchLike,
): Promise<PreflightResult> {
  const adminUrl = config.oap.adminUrl;
  const templatesMode = config.templates.mode;
  const generatedAt = Date.now();
  const dump = await fetchConfigDump(adminUrl, fetch, config.oap.timeoutMs, config.oap.auth);

  if (!dump.ok) {
    // Admin port down — nothing downstream is reachable. Probing each
    // path would just repeat the same failure N times.
    return {
      adminUrl,
      adminReachable: false,
      adminError: dump.error,
      templatesMode,
      modules: REQUIRED_MODULES.map((m) => ({
        name: m.name,
        envVar: m.envVar,
        required: m.required,
        probePath: m.probePath,
        reachable: false,
        enabled: false,
        affects: m.affects,
      })),
      dumpKeyCount: 0,
      generatedAt,
    };
  }

  const enabledPrefixes = new Set<string>();
  for (const k of Object.keys(dump.body)) {
    const top = k.split('.', 1)[0];
    if (top) enabledPrefixes.add(top);
  }

  const modules: PreflightModule[] = await Promise.all(
    REQUIRED_MODULES.map(async (m): Promise<PreflightModule> => {
      const base = {
        name: m.name,
        envVar: m.envVar,
        required: m.required,
        probePath: m.probePath,
        enabled: enabledPrefixes.has(m.name),
        affects: m.affects,
      };
      // admin-server's probe IS the dump fetch we just did.
      if (m.name === 'admin-server') return { ...base, reachable: true };
      // ui_template is not called in readonly mode — don't probe it.
      if (m.name === 'ui-management' && templatesMode === 'readonly') {
        return { ...base, reachable: null };
      }
      const reachable = await probeReachable(adminUrl, m.probePath, fetch, config.oap.timeoutMs, config.oap.auth);
      return { ...base, reachable };
    }),
  );

  return {
    adminUrl,
    adminReachable: true,
    templatesMode,
    modules,
    dumpKeyCount: Object.keys(dump.body).length,
    generatedAt,
  };
}

/**
 * Cached `runPreflight`. A single-flight 30s cache bounds OAP load when
 * many sessions poll `/api/preflight` (the UI polls every 60s). Pass
 * `force` for the cluster page's manual "re-check now" after the
 * operator fixes the network / a selector.
 */
let cache: { at: number; result: PreflightResult } | null = null;
let inFlight: Promise<PreflightResult> | null = null;
const CACHE_TTL_MS = 30_000;

export async function getPreflight(
  config: HorizonConfig,
  fetch: FetchLike,
  opts: { force?: boolean } = {},
): Promise<PreflightResult> {
  const now = Date.now();
  if (!opts.force && cache && now - cache.at < CACHE_TTL_MS) return cache.result;
  if (!opts.force && inFlight) return inFlight;
  inFlight = runPreflight(config, fetch)
    .then((result) => {
      cache = { at: Date.now(), result };
      inFlight = null;
      return result;
    })
    .catch((err) => {
      inFlight = null;
      throw err;
    });
  return inFlight;
}

/** Test seam — drop the cached probe round. */
export function invalidatePreflightCache(): void {
  cache = null;
  inFlight = null;
}

/**
 * Reachability of one admin REST path. Reachable = the GET got an HTTP
 * response that isn't 404 or 5xx; a 404 means the route isn't
 * registered (selector off / module absent), a 5xx / network error
 * means the feature can't serve. A 4xx like 400/401 still proves the
 * route exists, so it counts as reachable.
 */
async function probeReachable(
  adminUrl: string,
  path: string,
  fetch: FetchLike,
  timeoutMs: number,
  auth?: { username: string; password: string },
): Promise<boolean> {
  const url = `${adminUrl.replace(/\/$/, '')}${path}`;
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (auth) {
    const b64 = Buffer.from(`${auth.username}:${auth.password}`, 'utf8').toString('base64');
    headers.authorization = `Basic ${b64}`;
  }
  let init: RequestInit = { method: 'GET', headers };
  let timer: ReturnType<typeof setTimeout> | null = null;
  if (timeoutMs > 0) {
    const ctrl = new AbortController();
    timer = setTimeout(() => ctrl.abort(), timeoutMs);
    init = { ...init, signal: ctrl.signal };
  }
  try {
    const res = await fetch(url, init);
    return res.status !== 404 && res.status < 500;
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

interface DumpOk {
  ok: true;
  body: Record<string, string>;
}
interface DumpErr {
  ok: false;
  error: string;
}

async function fetchConfigDump(
  adminUrl: string,
  fetch: FetchLike,
  timeoutMs: number,
  auth?: { username: string; password: string },
): Promise<DumpOk | DumpErr> {
  const url = `${adminUrl.replace(/\/$/, '')}/debugging/config/dump`;
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (auth) {
    const b64 = Buffer.from(`${auth.username}:${auth.password}`, 'utf8').toString('base64');
    headers.authorization = `Basic ${b64}`;
  }
  let init: RequestInit = { method: 'GET', headers };
  let timer: ReturnType<typeof setTimeout> | null = null;
  if (timeoutMs > 0) {
    const ctrl = new AbortController();
    timer = setTimeout(() => ctrl.abort(), timeoutMs);
    init = { ...init, signal: ctrl.signal };
  }
  try {
    const res = await fetch(url, init);
    if (!res.ok) {
      const text = (await res.text()).slice(0, 200);
      return { ok: false, error: `HTTP ${res.status}${text ? ` — ${text}` : ''}` };
    }
    const body = (await res.json()) as Record<string, string>;
    return { ok: true, body };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
