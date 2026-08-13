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
 * `GET /api/layer/:key/endpoints?serviceId=<id>&service=<name>&q=<keyword>&limit=<n>`
 * — keyword-searchable, top-N endpoint list.
 * Drives the endpoint picker on the per-layer Endpoint page.
 *
 * Endpoints are unbounded by nature (a service can expose thousands)
 * so we don't page through them. The operator types a search term;
 * OAP's `findEndpoint(keyword, serviceId, limit)` returns the top-N
 * matches over the 15-minute traffic window.
 *
 *   q       trimmed search keyword (empty → all-recent endpoints).
 *   limit   clamped to 20…50. Default 20.
 *
 * `findEndpoint(serviceId)` keys on the id the request already carries,
 * exactly as on the instances route — no roster lookup.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ConfigSource } from '../../config/loader.js';
import type { SessionStore } from '../../user/sessions.js';
import type { FetchLike } from '@skywalking-horizon-ui/api-client';
import { requireAuth } from '../../user/middleware.js';
import {  graphqlPost, buildOapOpts } from '../../client/graphql.js';
import { serviceScopeOf } from '../../logic/oap/service-scope.js';
import { overFetchSize, takeOverFetched } from '../../logic/paging/read-page.js';
import { withColdStage } from '../../util/duration.js';
import { defaultMinuteWindow, getServerOffsetMinutes } from '../../util/window.js';

export interface EndpointRouteDeps {
  config: ConfigSource;
  sessions: SessionStore;
  fetch?: FetchLike;
}

const FIND_ENDPOINTS = /* GraphQL */ `
  query LayerEndpoints($serviceId: ID!, $keyword: String!, $limit: Int!, $duration: Duration!) {
    endpoints: findEndpoint(serviceId: $serviceId, keyword: $keyword, limit: $limit, duration: $duration) {
      id
      name
    }
  }
`;

const DEFAULT_WINDOW_MIN = 60;

export interface EndpointRow {
  id: string;
  name: string;
}

export interface EndpointsResponse {
  layer: string;
  service: string;
  query: string;
  limit: number;
  generatedAt: number;
  endpoints: EndpointRow[];
  /** `findEndpoint` is a top-N by contract and reports no count. Asking for
   *  one endpoint more than the limit turns the silent cut into an honest
   *  "there are more matches — narrow the keyword". */
  hasMore: boolean;
  reachable: boolean;
  error?: string;
}

export function registerEndpointRoute(app: FastifyInstance, deps: EndpointRouteDeps): void {
  const auth = requireAuth(deps);
  app.get(
    '/api/layer/:key/endpoints',
    { preHandler: auth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const params = req.params as { key: string };
      const layerKey = params.key;
      if (!layerKey || !/^[a-z0-9_]+$/i.test(layerKey)) {
        return reply.code(400).send({ error: 'invalid_layer_key' });
      }
      const q = req.query as {
        serviceId?: string;
        service?: string;
        q?: string;
        limit?: string;
      };
      const scope = serviceScopeOf(q);
      if (scope.kind === 'all') return reply.code(400).send({ error: 'missing_service' });
      if (scope.kind === 'incomplete') {
        return reply.code(400).send({ error: 'incomplete_service', message: scope.message });
      }
      const serviceId = scope.service.id;
      // The handle the caller sent, echoed back on every reply below.
      const serviceArg = scope.service.name || serviceId;
      const keyword = (q.q ?? '').trim();
      const limit = Math.max(20, Math.min(50, Number(q.limit) || 20));

      const cfgCurrent = deps.config.current;
      const opts = buildOapOpts(cfgCurrent, deps.fetch);
      const offset = await getServerOffsetMinutes(deps.config, deps.fetch);
      const window = defaultMinuteWindow(offset, DEFAULT_WINDOW_MIN);

      try {
        const data = await graphqlPost<{ endpoints: EndpointRow[] }>(opts, FIND_ENDPOINTS, {
          serviceId,
          keyword,
          limit: overFetchSize(limit),
          duration: withColdStage(req, { start: window.start, end: window.end, step: 'MINUTE' }),
        });
        const { rows, hasNext } = takeOverFetched(data.endpoints ?? [], limit);
        return reply.send({
          layer: layerKey,
          service: serviceArg,
          query: keyword,
          limit,
          generatedAt: Date.now(),
          endpoints: rows,
          hasMore: hasNext,
          reachable: true,
        } satisfies EndpointsResponse);
      } catch (err) {
        return reply.send({
          layer: layerKey,
          service: serviceArg,
          query: keyword,
          limit,
          generatedAt: Date.now(),
          endpoints: [],
          hasMore: false,
          reachable: false,
          error: err instanceof Error ? err.message : String(err),
        } satisfies EndpointsResponse);
      }
    },
  );
}
