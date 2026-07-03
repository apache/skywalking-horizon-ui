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
import { z } from 'zod';
import type {
  ExploreEntity,
  ExploreRequest,
  ExploreResolved,
  ExploreResponse,
  ExploreWindow,
  FetchLike,
  LogTagFilter,
  ZipkinTraceListResponse,
} from '@skywalking-horizon-ui/api-client';
import type { ConfigSource } from '../../config/loader.js';
import type { SessionStore } from '../../user/sessions.js';
import { requireAuth } from '../../user/middleware.js';
import { buildOapOpts } from '../../client/graphql.js';
import { fmtSecond, getServerOffsetMinutes } from '../../util/window.js';
import { buildEndpointId, buildInstanceId, buildServiceId } from '../../util/entityId.js';
import { fetchNativeList, type TraceListBody } from './trace.js';
import { fetchLogs } from './log.js';
import { fetchBrowserErrors } from './browser-errors.js';
import { zipkinFetchTraces } from '../../client/zipkin.js';

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
 *  `startMs`/`endMs` and `windowMinutes` as the fallback. */
function traceWindowFields(w: ExploreWindow): Pick<TraceListBody, 'windowMinutes' | 'startMs' | 'endMs'> {
  if (typeof w.startMs === 'number' && typeof w.endMs === 'number' && w.endMs > w.startMs) {
    return { startMs: w.startMs, endMs: w.endMs };
  }
  return { windowMinutes: w.windowMinutes };
}

/** Zipkin queries the window `[endTs - lookback, endTs]` (ms). Explicit
 *  epoch-ms bounds map to `endTs = endMs`, `lookback = endMs - startMs`;
 *  the rolling minutes preset maps to `endTs = now`, `lookback = mins`. */
function zipkinWindow(w: ExploreWindow): { endTs: number; lookback: number } {
  if (typeof w.startMs === 'number' && typeof w.endMs === 'number' && w.endMs > w.startMs) {
    return { endTs: w.endMs, lookback: w.endMs - w.startMs };
  }
  return { endTs: Date.now(), lookback: Math.max(1, w.windowMinutes ?? 30) * 60_000 };
}

const DEFAULT_LOG_WINDOW_MIN = 30;
const MAX_LOG_WINDOW_MIN = 60 * 24 * 7; // 1 week guard, mirrors the per-layer route
/** Log queries are SECOND-precision RECORD reads (same as the per-layer
 *  Logs tab) — MINUTE rounding would chop off the most recent lines.
 *  Explicit epoch-ms bounds win; otherwise the rolling minutes preset
 *  anchors at "now". Both formatted OAP-local via the cached offset. */
function logWindowSecond(w: ExploreWindow, offsetMinutes: number): { start: string; end: string } {
  if (typeof w.startMs === 'number' && typeof w.endMs === 'number' && w.endMs > w.startMs) {
    return { start: fmtSecond(w.startMs, offsetMinutes), end: fmtSecond(w.endMs, offsetMinutes) };
  }
  const m = Math.max(1, Math.min(MAX_LOG_WINDOW_MIN, Math.round(w.windowMinutes ?? DEFAULT_LOG_WINDOW_MIN)));
  const endMs = Date.now();
  return { start: fmtSecond(endMs - m * 60_000, offsetMinutes), end: fmtSecond(endMs, offsetMinutes) };
}

// Runtime validation for the explore body — a direct API caller gets a 400
// rather than a silent mis-dispatch (an unknown `kind` would otherwise fall
// into log handling, an unknown log source into browser handling). The k8s
// pods source never reaches this route (it uses the per-layer pod-log routes),
// so logSource here is raw|browser only.
const exploreEntitySchema = z.object({
  mode: z.enum(['pick', 'type']),
  serviceId: z.string().optional(),
  instanceId: z.string().optional(),
  endpointId: z.string().optional(),
  serviceName: z.string().optional(),
  isReal: z.boolean().optional(),
  instanceName: z.string().optional(),
  endpointName: z.string().optional(),
});
const exploreWindowSchema = z.object({
  windowMinutes: z.number().optional(),
  startMs: z.number().optional(),
  endMs: z.number().optional(),
});
const exploreBodySchema = z
  .object({
    kind: z.enum(['trace', 'log']),
    traceSource: z.enum(['native', 'zipkin']).optional(),
    logSource: z.enum(['raw', 'browser']).optional(),
    entity: exploreEntitySchema.optional(),
    window: exploreWindowSchema.optional(),
    pageNum: z.number().optional(),
    pageSize: z.number().optional(),
    traceId: z.string().optional(),
    traceState: z.string().optional(),
    queryOrder: z.string().optional(),
    minTraceDuration: z.number().optional(),
    maxTraceDuration: z.number().optional(),
    tags: z.array(z.object({ key: z.string(), value: z.string() })).optional(),
    remoteServiceName: z.string().optional(),
    spanName: z.string().optional(),
    annotationQuery: z.string().optional(),
    keywordsOfContent: z.array(z.string()).optional(),
    relatedTraceId: z.string().optional(),
    category: z.string().optional(),
  })
  .refine((b) => b.kind !== 'log' || b.logSource === 'raw' || b.logSource === 'browser', {
    message: 'logSource must be "raw" or "browser" when kind is "log"',
    path: ['logSource'],
  });

export function registerExploreRoutes(app: FastifyInstance, deps: ExploreRouteDeps): void {
  const auth = requireAuth(deps);

  app.post(
    '/api/explore/query',
    { preHandler: auth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const parsed = exploreBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_body', detail: parsed.error.flatten() });
      }
      const body = parsed.data as ExploreRequest;
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
              ...(typeof body.minTraceDuration === 'number' ? { minTraceDuration: body.minTraceDuration } : {}),
              ...(typeof body.maxTraceDuration === 'number' ? { maxTraceDuration: body.maxTraceDuration } : {}),
              ...(body.tags && body.tags.length ? { tags: body.tags } : {}),
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

        // zipkin: a raw service name (no OAP id) plus the rich query
        // params Zipkin's REST API takes. Duration arrives in ms (the
        // shared condition unit) — Zipkin wants µs.
        const service = body.entity?.serviceName;
        const { endTs, lookback } = zipkinWindow(body.window ?? {});
        const minUs = typeof body.minTraceDuration === 'number' ? Math.max(0, body.minTraceDuration * 1000) : undefined;
        const maxUs = typeof body.maxTraceDuration === 'number' ? Math.max(0, body.maxTraceDuration * 1000) : undefined;
        const limit = Math.min(maxTraces, Math.max(1, Math.round(body.pageSize ?? 20)));
        const zipkinOpts = { ...opts, queryUrl: deps.config.current.oap.zipkinUrl };
        let zipkin: ZipkinTraceListResponse;
        try {
          const traces = await zipkinFetchTraces(zipkinOpts, {
            serviceName: service,
            remoteServiceName: body.remoteServiceName || undefined,
            spanName: body.spanName || undefined,
            annotationQuery: body.annotationQuery || undefined,
            minDuration: minUs,
            maxDuration: maxUs,
            endTs,
            lookback,
            limit,
          });
          zipkin = { source: 'zipkin', traces, reachable: true };
        } catch (err) {
          zipkin = {
            source: 'zipkin',
            traces: [],
            reachable: false,
            error: err instanceof Error ? err.message : String(err),
          };
        }
        const resolved: ExploreResolved = {
          kind: 'trace',
          source: 'zipkin',
          entityId: service,
          condition: {
            ...(service ? { serviceName: service } : {}),
            ...(body.remoteServiceName ? { remoteServiceName: body.remoteServiceName } : {}),
            ...(body.spanName ? { spanName: body.spanName } : {}),
            ...(body.annotationQuery ? { annotationQuery: body.annotationQuery } : {}),
            ...(typeof minUs === 'number' ? { minDuration: minUs } : {}),
            ...(typeof maxUs === 'number' ? { maxDuration: maxUs } : {}),
            endTs,
            lookback,
            limit,
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

      // kind === 'log'. Two sources: `raw` (queryLogs) and `browser`
      // (queryBrowserErrorLogs — BROWSER-layer JS errors). Default `raw`.
      const logSource = body.logSource ?? 'raw';
      if (logSource === 'raw') {
        // Entity optional — no service means "all services in the window"
        // (OAP's LogQueryCondition.serviceId is nullable).
        const ids = body.entity ? resolveNativeEntity(body.entity) : {};
        const win = logWindowSecond(body.window ?? {}, offset);
        const keywords = (body.keywordsOfContent ?? []).filter((k) => k.length > 0);
        const tags = (body.tags ?? []) as LogTagFilter[];
        const maxLogs = deps.config.current.performance.limits.maxPageSize.logs;
        const paging = {
          pageNum: Math.max(1, Math.round(body.pageNum ?? 1)),
          pageSize: Math.min(maxLogs, Math.max(1, Math.round(body.pageSize ?? 50))),
        };
        const scope = {
          serviceId: ids.serviceId,
          serviceInstanceId: ids.instanceId,
          endpointId: ids.endpointId,
          traceId: body.relatedTraceId,
          keywordsOfContent: keywords,
          tags,
        };
        const logs = await fetchLogs(opts, scope, win, paging, !!req.coldStage);
        const resolved: ExploreResolved = {
          kind: 'log',
          source: 'raw',
          entityId: ids.serviceId,
          condition: {
            ...(ids.serviceId ? { serviceId: ids.serviceId } : {}),
            ...(ids.instanceId ? { serviceInstanceId: ids.instanceId } : {}),
            ...(ids.endpointId ? { endpointId: ids.endpointId } : {}),
            ...(body.relatedTraceId ? { traceId: body.relatedTraceId } : {}),
            ...(keywords.length > 0 ? { keywordsOfContent: keywords } : {}),
            ...(tags.length > 0 ? { tags } : {}),
            ...win,
          },
        };
        return reply.send({
          kind: 'log',
          logSource: 'raw',
          generatedAt,
          logs,
          resolved,
        } satisfies ExploreResponse);
      }

      // kind === 'log' && logSource === 'browser' — BROWSER-layer JS error
      // logs. The entity is a browser SERVICE (Pick forwards an id; Type
      // encodes base64(name).{1|0}). BROWSER versions ARE instances and
      // pages ARE endpoints, so the resolved instanceId/endpointId map onto
      // serviceVersionId/pagePathId. SECOND-precision window (error logs are
      // event-style — MINUTE rounding chops the newest).
      const ids = body.entity ? resolveNativeEntity(body.entity) : {};
      const win = logWindowSecond(body.window ?? {}, offset);
      const category = body.category ?? 'ALL';
      const maxBrowser = deps.config.current.performance.limits.maxPageSize.browserLogs;
      const paging = {
        pageNum: Math.max(1, Math.round(body.pageNum ?? 1)),
        pageSize: Math.min(maxBrowser, Math.max(1, Math.round(body.pageSize ?? 50))),
      };
      const browser = await fetchBrowserErrors(
        opts,
        { serviceId: ids.serviceId, serviceVersionId: ids.instanceId, pagePathId: ids.endpointId, category },
        win,
        paging,
        !!req.coldStage,
      );
      const resolved: ExploreResolved = {
        kind: 'log',
        source: 'browser',
        entityId: ids.serviceId,
        condition: {
          ...(ids.serviceId ? { serviceId: ids.serviceId } : {}),
          ...(ids.instanceId ? { serviceVersionId: ids.instanceId } : {}),
          ...(ids.endpointId ? { pagePathId: ids.endpointId } : {}),
          ...(category && category !== 'ALL' ? { category } : {}),
          ...win,
        },
      };
      return reply.send({
        kind: 'log',
        logSource: 'browser',
        generatedAt,
        browser,
        resolved,
      } satisfies ExploreResponse);
    },
  );
}
