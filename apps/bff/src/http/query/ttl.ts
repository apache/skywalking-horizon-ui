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
 * `GET /api/oap/ttl` — one round-trip combining `getRecordsTTL` and
 * `getMetricsTTL` on the query port. Read-only data-retention view.
 * Never rejects on an unreachable OAP: returns `{ reachable: false }`
 * so the page degrades instead of 502-ing.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type {
  FetchLike,
  MetricsTTL,
  OapTtlResponse,
  RecordsTTL,
} from '@skywalking-horizon-ui/api-client';
import type { ConfigSource } from '../../config/loader.js';
import type { SessionStore } from '../../user/sessions.js';
import { requireAuth } from '../../user/middleware.js';
import { buildOapOpts, graphqlPost } from '../../client/graphql.js';

const TTL_QUERY = /* GraphQL */ `
  query HorizonOapTtl {
    records: getRecordsTTL {
      normal trace zipkinTrace log browserErrorLog
      coldNormal coldTrace coldZipkinTrace coldLog coldBrowserErrorLog
    }
    metrics: getMetricsTTL {
      minute hour day
      coldMinute coldHour coldDay
    }
  }
`;

interface TtlRaw {
  records?: RecordsTTL | null;
  metrics?: MetricsTTL | null;
}

export interface TtlRouteDeps {
  config: ConfigSource;
  sessions: SessionStore;
  fetch?: FetchLike;
}

export function registerTtlRoute(app: FastifyInstance, deps: TtlRouteDeps): void {
  const auth = requireAuth(deps);
  app.get('/api/oap/ttl', { preHandler: auth }, async (_req: FastifyRequest, reply: FastifyReply) => {
    const cfg = deps.config.current;
    try {
      const raw = await graphqlPost<TtlRaw>(buildOapOpts(cfg, deps.fetch), TTL_QUERY);
      const body: OapTtlResponse = {
        reachable: true,
        records: raw.records ?? undefined,
        metrics: raw.metrics ?? undefined,
      };
      return reply.send(body);
    } catch (err) {
      const body: OapTtlResponse = {
        reachable: false,
        error: err instanceof Error ? err.message : String(err),
      };
      return reply.status(200).send(body);
    }
  });
}
