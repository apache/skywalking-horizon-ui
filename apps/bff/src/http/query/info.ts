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

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { FetchLike } from '@skywalking-horizon-ui/api-client';
import type { ConfigSource } from '../../config/loader.js';
import type { SessionStore } from '../../user/sessions.js';
import { requireAuth } from '../../user/middleware.js';
import { basicAuthHeader, buildOapOpts, graphqlPost } from '../../client/graphql.js';
import { getOapCapabilities } from '../../logic/oap/capabilities.js';
import { getOapBackend } from '../../logic/oap/backend.js';

/**
 * One round-trip combining `version`, `getTimeInfo`, and `checkHealth`.
 *
 *   - `version` returns the OAP build version string.
 *   - `getTimeInfo.timezone` is minutes-from-UTC (e.g. 480 for UTC+8).
 *   - `getTimeInfo.currentTimestamp` is the server's "now" in ms; lets the
 *     UI compute clock drift and convert user-input ranges into the
 *     server's TZ for query construction.
 *   - `checkHealth.score` is 0 healthy, >0 degraded, <0 not started.
 */
const INFO_QUERY = /* GraphQL */ `
  query HorizonOapInfo {
    version
    time: getTimeInfo {
      timezone
      currentTimestamp
    }
    health: checkHealth {
      score
      details
    }
  }
`;

interface InfoRaw {
  version?: string | null;
  time?: { timezone?: string | null; currentTimestamp?: number | null } | null;
  health?: { score?: number | null; details?: string | null } | null;
}

import type { OapInfo } from '@skywalking-horizon-ui/api-client';

export interface InfoRouteDeps {
  config: ConfigSource;
  sessions: SessionStore;
  fetch?: FetchLike;
}

/** Probe OAP's Zipkin v2 REST endpoint for reachability. Hits the
 *  cheapest path (`/api/v2/services`) and treats any 2xx as up. Never
 *  throws — a down Zipkin is a normal state (only the Zipkin trace menu
 *  depends on it), so failure is reported as `reachable: false`, not an
 *  exception that would mask the GraphQL info the same poll carries. */
async function probeZipkin(
  cfg: ConfigSource['current'],
  fetchFn: FetchLike | undefined,
): Promise<{ reachable: boolean; error?: string }> {
  const f = fetchFn ?? globalThis.fetch.bind(globalThis);
  const url = cfg.oap.zipkinUrl.replace(/\/$/, '') + '/api/v2/services';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.oap.timeoutMs);
  const headers: Record<string, string> = { accept: 'application/json' };
  if (cfg.oap.auth) {
    headers.authorization = basicAuthHeader(cfg.oap.auth.username, cfg.oap.auth.password);
  }
  try {
    const res = await f(url, { method: 'GET', headers, signal: controller.signal });
    if (!res.ok) return { reachable: false, error: `HTTP ${res.status} at ${url}` };
    return { reachable: true };
  } catch (err) {
    return { reachable: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

export function registerOapInfoRoute(app: FastifyInstance, deps: InfoRouteDeps): void {
  const auth = requireAuth(deps);
  app.get('/api/oap/info', { preHandler: auth }, async (_req: FastifyRequest, reply: FastifyReply) => {
    const cfg = deps.config.current;
    const queryUrl = cfg.oap.queryUrl;
    const zipkinUrl = cfg.oap.zipkinUrl;
    /* Zipkin reachability is probed independently of the GraphQL info
     * call (separate endpoint, often a different port/module). It never
     * rejects, so it stays available on both the success and catch paths
     * below. */
    const zipkinP = probeZipkin(cfg, deps.fetch);
    try {
      /* Capability probe runs in parallel with the info call — both
       * are GraphQL POSTs to the same endpoint; serialising would add
       * round-trip latency to every poll without changing semantics.
       * The probe is internally cached for 5 min so the wire traffic
       * is one-off per OAP restart, not per call. */
      const [raw, capabilities, backend, zipkin] = await Promise.all([
        graphqlPost<InfoRaw>(buildOapOpts(cfg, deps.fetch), INFO_QUERY),
        getOapCapabilities(cfg, deps.fetch),
        getOapBackend(cfg, deps.fetch),
        zipkinP,
      ]);
      const body: OapInfo = {
        reachable: true,
        queryUrl,
        version: raw.version ?? undefined,
        timezone: raw.time?.timezone ?? undefined,
        currentTimestamp: raw.time?.currentTimestamp ?? undefined,
        healthScore: raw.health?.score ?? undefined,
        healthDetails: raw.health?.details ?? undefined,
        capabilities,
        backend,
        zipkinUrl,
        zipkinReachable: zipkin.reachable,
        zipkinError: zipkin.error,
        overviewTopN: cfg.query.overviewTopN,
      };
      return reply.send(body);
    } catch (err) {
      const zipkin = await zipkinP;
      const body: OapInfo = {
        reachable: false,
        queryUrl,
        error: err instanceof Error ? err.message : String(err),
        zipkinUrl,
        zipkinReachable: zipkin.reachable,
        zipkinError: zipkin.error,
        overviewTopN: cfg.query.overviewTopN,
      };
      return reply.status(200).send(body);
    }
  });
}
