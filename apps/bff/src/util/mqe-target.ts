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
 * Resolve the GraphQL base URL for MQE (`execExpression`) calls.
 *
 * Resolution order:
 *
 *   1. Operator override in studio.yaml under `oap.mqe.{host,port}`.
 *      Both fields are independently optional — if only host is set,
 *      port is discovered, and vice versa.
 *
 *   2. Admin-server `GET /debugging/config/dump` — a flat
 *      `Map<String,String>` with keys like `core.default.restPort`
 *      and (when the sharing-server module is enabled)
 *      `sharing-server.default.restPort`. Prefer the sharing-server
 *      values because OAP 11.x defaults the query GraphQL there; fall
 *      back to core's REST otherwise (the v10 layout).
 *
 *   3. Host fallback: if the discovered bind host is empty / wildcard
 *      (`0.0.0.0`, `::`), reuse the admin URL's hostname. Port-forward
 *      and ingress setups frequently bind on a wildcard but expose a
 *      reachable address as the admin URL.
 *
 * The result is cached in-process for `CACHE_TTL_MS`. Cache is busted
 * by either elapsed time or an explicit `refresh()` call (driven by
 * the SPA's manual refresh button).
 */

import type { FetchLike } from '@skywalking-horizon-ui/api-client';
import type { HorizonConfig } from '../config/schema.js';

export interface MqeTarget {
  /** e.g. `http://oap-rest.cluster.local:12800` — no trailing slash. */
  baseUrl: string;
  /** Human-readable rationale for the operator: `sharing-server`,
   *  `core.restPort`, `studio.yaml override`, `admin host fallback`,
   *  combinations thereof. */
  via: string;
  /** What the operator's studio.yaml had set (echo, not discovery). */
  configured: { host?: string; port?: number };
}

export interface ResolveDeps {
  config(): HorizonConfig;
  fetch: FetchLike;
}

const CACHE_TTL_MS = 60_000;

interface CacheEntry {
  target: MqeTarget;
  expiresAt: number;
}

export class MqeTargetCache {
  private entry: CacheEntry | null = null;

  invalidate(): void {
    this.entry = null;
  }

  async resolve(deps: ResolveDeps): Promise<MqeTarget> {
    const now = Date.now();
    if (this.entry && this.entry.expiresAt > now) return this.entry.target;
    const target = await resolveMqeTarget(deps);
    this.entry = { target, expiresAt: now + CACHE_TTL_MS };
    return target;
  }
}

async function resolveMqeTarget(deps: ResolveDeps): Promise<MqeTarget> {
  const cfg = deps.config().oap;
  const configured: { host?: string; port?: number } = {};
  if (cfg.mqe?.host !== undefined) configured.host = cfg.mqe.host;
  if (cfg.mqe?.port !== undefined) configured.port = cfg.mqe.port;

  // Fast path: full override — no admin call needed.
  if (configured.host !== undefined && configured.port !== undefined) {
    return {
      baseUrl: `http://${configured.host}:${configured.port}`,
      via: 'studio.yaml override (host + port)',
      configured,
    };
  }

  // Otherwise we need the config dump.
  const adminUrl = cfg.adminUrl;
  const dump = await fetchConfigDump(adminUrl, deps.fetch, cfg.timeoutMs);
  const adminHost = new URL(adminUrl).hostname;

  const picked = pickFromDump(dump, adminHost);

  const finalHost = configured.host ?? picked.host;
  const finalPort = configured.port ?? picked.port;

  if (finalPort === undefined) {
    throw new Error(
      'mqe target: could not discover REST port from /debugging/config/dump (neither sharing-server nor core REST appears in the dump)',
    );
  }

  const viaParts: string[] = [];
  viaParts.push(
    configured.host !== undefined ? 'host from studio.yaml' : `host from ${picked.hostFrom}`,
  );
  viaParts.push(
    configured.port !== undefined ? 'port from studio.yaml' : `port from ${picked.portFrom}`,
  );

  return {
    baseUrl: `http://${finalHost}:${finalPort}`,
    via: viaParts.join(', '),
    configured,
  };
}

interface PickResult {
  host: string;
  port: number | undefined;
  hostFrom: string;
  portFrom: string;
}

function pickFromDump(dump: Record<string, string>, adminHost: string): PickResult {
  // Prefer sharing-server over core (OAP 11.x defaults the query
  // GraphQL on the sharing-server REST; the v10 layout has it on core).
  const sharingHost = dump['sharing-server.default.restHost'];
  const sharingPortStr = dump['sharing-server.default.restPort'];
  const coreHost = dump['core.default.restHost'];
  const corePortStr = dump['core.default.restPort'];

  const sharingPort = parsePort(sharingPortStr);
  const corePort = parsePort(corePortStr);

  const preferSharing = sharingPort !== undefined;
  const host = preferSharing ? sharingHost : coreHost;
  const port = preferSharing ? sharingPort : corePort;
  const moduleLabel = preferSharing ? 'sharing-server.restHost' : 'core.restHost';
  const portLabel = preferSharing ? 'sharing-server.restPort' : 'core.restPort';

  // Wildcard host fallback. OAP commonly binds on 0.0.0.0; the operator
  // reaches it through the admin URL's host.
  const isWildcard = !host || host === '0.0.0.0' || host === '::' || host === '';
  const resolvedHost = isWildcard ? adminHost : host;
  const hostFrom = isWildcard ? `admin URL host (${moduleLabel} was wildcard)` : moduleLabel;

  return { host: resolvedHost, port, hostFrom, portFrom: portLabel };
}

function parsePort(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === '') return undefined;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0 || n > 65535) return undefined;
  return n;
}

async function fetchConfigDump(
  adminUrl: string,
  fetch: FetchLike,
  timeoutMs: number,
): Promise<Record<string, string>> {
  const base = adminUrl.replace(/\/$/, '');
  const url = `${base}/debugging/config/dump`;
  let init: RequestInit = { method: 'GET', headers: { Accept: 'application/json' } };
  let timer: ReturnType<typeof setTimeout> | null = null;
  if (timeoutMs > 0) {
    const ctrl = new AbortController();
    timer = setTimeout(() => ctrl.abort(), timeoutMs);
    init = { ...init, signal: ctrl.signal };
  }
  try {
    const res = await fetch(url, init);
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`config dump failed: HTTP ${res.status} from ${url} — ${body.slice(0, 200)}`);
    }
    return (await res.json()) as Record<string, string>;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
