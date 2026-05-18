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
import { buildOapOpts, graphqlPost } from '../../client/graphql.js';
import { getOapCapabilities } from '../../logic/oap/capabilities.js';

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

export function registerOapInfoRoute(app: FastifyInstance, deps: InfoRouteDeps): void {
  const auth = requireAuth(deps);
  app.get('/api/oap/info', { preHandler: auth }, async (_req: FastifyRequest, reply: FastifyReply) => {
    const cfg = deps.config.current;
    const queryUrl = cfg.oap.queryUrl;
    try {
      /* Capability probe runs in parallel with the info call — both
       * are GraphQL POSTs to the same endpoint; serialising would add
       * round-trip latency to every poll without changing semantics.
       * The probe is internally cached for 5 min so the wire traffic
       * is one-off per OAP restart, not per call. */
      const [raw, capabilities] = await Promise.all([
        graphqlPost<InfoRaw>(buildOapOpts(cfg, deps.fetch), INFO_QUERY),
        getOapCapabilities(cfg, deps.fetch),
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
      };
      return reply.send(body);
    } catch (err) {
      const body: OapInfo = {
        reachable: false,
        queryUrl,
        error: err instanceof Error ? err.message : String(err),
      };
      return reply.status(200).send(body);
    }
  });
}
