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
 * Explore — cross-layer trace/log query.
 *
 *   POST /api/explore/query
 *
 * Dispatches an {@link ExploreRequest} by kind+source onto the SAME query
 * logic the per-layer Traces/Logs tabs use, but with NO layer: the entity
 * arrives either as pre-resolved OAP ids (Pick mode) or as a name + the
 * real/normal flag (Type mode), which we encode here. Trace detail reuses
 * the existing GET /api/trace/:traceId route — no detail route here.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type {
  ExploreEntity,
  ExploreRequest,
  ExploreResolved,
  ExploreResponse,
  ExploreWindow,
  FetchLike,
} from '@skywalking-horizon-ui/api-client';
import type { ConfigSource } from '../../config/loader.js';
import type { SessionStore } from '../../user/sessions.js';
import { requireAuth } from '../../user/middleware.js';
import { buildOapOpts } from '../../client/graphql.js';
import { getServerOffsetMinutes } from '../../util/window.js';
import { buildEndpointId, buildInstanceId, buildServiceId } from '../../util/entityId.js';
import { fetchNativeList, fetchZipkinList, type TraceListBody } from './trace.js';

export interface ExploreRouteDeps {
  config: ConfigSource;
  sessions: SessionStore;
  fetch?: FetchLike;
}

/** Resolve the entity to the ids the native trace/log queries take. Pick
 *  mode forwards the ids the metadata routes minted; Type mode encodes
 *  base64(name).{1|0} (+ nested instance/endpoint) — no layer needed. */
function resolveNativeEntity(e: ExploreEntity): {
  serviceId?: string;
  instanceId?: string;
  endpointId?: string;
} {
  const serviceId =
    e.serviceId ?? (e.serviceName ? buildServiceId(e.serviceName, e.isReal ?? true) : undefined);
  const instanceId =
    e.instanceId ?? (serviceId && e.instanceName ? buildInstanceId(serviceId, e.instanceName) : undefined);
  const endpointId =
    e.endpointId ?? (serviceId && e.endpointName ? buildEndpointId(serviceId, e.endpointName) : undefined);
  return { serviceId, instanceId, endpointId };
}

/** Explicit epoch-ms window overrides the rolling minutes; trace.ts reads
 *  `start`/`end` as ISO and `windowMinutes` as the fallback. */
function traceWindowFields(w: ExploreWindow): Pick<TraceListBody, 'windowMinutes' | 'start' | 'end'> {
  if (typeof w.startMs === 'number' && typeof w.endMs === 'number' && w.endMs > w.startMs) {
    return { start: new Date(w.startMs).toISOString(), end: new Date(w.endMs).toISOString() };
  }
  return { windowMinutes: w.windowMinutes };
}

export function registerExploreRoutes(app: FastifyInstance, deps: ExploreRouteDeps): void {
  const auth = requireAuth(deps);

  app.post(
    '/api/explore/query',
    { preHandler: auth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const body = (req.body ?? {}) as ExploreRequest;
      const opts = buildOapOpts(deps.config.current, deps.fetch);
      const offset = await getServerOffsetMinutes(deps.config, deps.fetch);
      const generatedAt = Date.now();

      if (body.kind === 'trace') {
        const traceSource = body.traceSource ?? 'native';
        const maxTraces = deps.config.current.performance.limits.maxPageSize.traces;
        const win = traceWindowFields(body.window ?? {});
        const base: TraceListBody = {
          ...win,
          traceId: body.traceId,
          traceState: body.traceState,
          queryOrder: body.queryOrder,
          minTraceDuration: body.minTraceDuration,
          maxTraceDuration: body.maxTraceDuration,
          tags: body.tags,
          pageNum: body.pageNum,
          pageSize: body.pageSize,
        };

        if (traceSource === 'native') {
          // Entity is optional — no service means "all services in the
          // window" (OAP's TraceQueryCondition.serviceId is nullable).
          const ids = body.entity ? resolveNativeEntity(body.entity) : {};
          const native = await fetchNativeList(
            opts,
            { ...base, ...ids },
            '', // layer-less: serviceId is pre-resolved, resolveServiceId never runs
            !!req.coldStage,
            offset,
            maxTraces,
          );
          const resolved: ExploreResolved = {
            kind: 'trace',
            source: 'native',
            backend: native.api,
            entityId: ids.serviceId,
            condition: {
              ...ids,
              ...(body.traceId ? { traceId: body.traceId } : {}),
              traceState: body.traceState ?? 'ALL',
              queryOrder: body.queryOrder ?? 'BY_START_TIME',
              ...win,
            },
          };
          return reply.send({
            kind: 'trace',
            traceSource: 'native',
            generatedAt,
            native,
            resolved,
          } satisfies ExploreResponse);
        }

        // zipkin: a raw service name (no OAP id). remoteService/span/
        // annotation enrichment lands with the zipkin form increment.
        const service = body.entity?.serviceName;
        const zipkin = await fetchZipkinList(opts, { ...base, service }, maxTraces);
        const resolved: ExploreResolved = {
          kind: 'trace',
          source: 'zipkin',
          entityId: service,
          condition: {
            ...(service ? { serviceName: service } : {}),
            ...(typeof body.minTraceDuration === 'number' ? { minDuration: body.minTraceDuration } : {}),
            ...(typeof body.maxTraceDuration === 'number' ? { maxDuration: body.maxTraceDuration } : {}),
            ...win,
          },
        };
        return reply.send({
          kind: 'trace',
          traceSource: 'zipkin',
          generatedAt,
          zipkin,
          resolved,
        } satisfies ExploreResponse);
      }

      // kind === 'log' — raw + browser, added in the log increment.
      return reply.code(501).send({ error: 'log_not_implemented' });
    },
  );
}
