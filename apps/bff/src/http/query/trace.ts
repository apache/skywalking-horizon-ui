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
 * Per-layer Traces feed.
 *
 *   POST /api/layer/:key/traces    — list
 *   GET  /api/trace/:traceId       — detail by id (native or zipkin)
 *
 * The route is dual-source aware: when the layer's `traces.source`
 * is `both` (default) or the operator explicitly asks for both via
 * the query string, the BFF fans out to SkyWalking-native AND
 * Zipkin in parallel and returns each backend's results on its own
 * slot. The UI renders two tables side-by-side; there's no field
 * mapping between the two — zipkin spans keep their zipkin shape.
 *
 * The native query (`queryTraces` vs `queryBasicTraces`) is
 * auto-detected via {@link detectTraceQueryApi} — the caller doesn't
 * need to know which one the OAP backend answers with.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type {
  FetchLike,
  NativeSpan,
  NativeTraceDetailResponse,
  NativeTraceListResponse,
  TraceDetailResponse,
  TraceListResponse,
  TraceQueryOrder,
  TraceQueryState,
  TraceSource,
  TracesConfig,
  UITemplateClient,
  ZipkinTraceDetailResponse,
  ZipkinTraceListResponse,
} from '@skywalking-horizon-ui/api-client';
import type { ConfigSource } from '../../config/loader.js';
import type { SessionStore } from '../../user/sessions.js';
import { requireAuth } from '../../user/middleware.js';
import {  graphqlPost, buildOapOpts, type GraphqlOptions } from '../../client/graphql.js';
import {
  overFetchSize,
  readPage,
  takeOverFetched,
  type OapPaging,
  type PagedQuerySpec,
} from '../../logic/paging/read-page.js';
import { tracesConfigFor } from '../../logic/layers/loader.js';
import { resolveEffectiveLayer } from '../../logic/layers/effective.js';
import { serviceScopeOf } from '../../logic/oap/service-scope.js';
import { parsePreviewTraces } from '../../logic/layers/preview.js';
import { detectTraceQueryApi } from '../../util/trace-protocol-cache.js';
import { withColdStage } from '../../util/duration.js';
import { fmtSecond, getServerOffsetMinutes, windowFromRange } from '../../util/window.js';
import { zipkinFetchTraces, zipkinFetchTraceById, summariseZipkinTrace } from '../../client/zipkin.js';

export interface TraceRouteDeps {
  config: ConfigSource;
  sessions: SessionStore;
  fetch?: FetchLike;
  /** OAP UI-template client — serve the in-use (remote-or-bundled) config. */
  uiTemplateClient?: () => UITemplateClient;
}

const DEFAULT_WINDOW_MIN = 30;
const MAX_WINDOW_MIN = 60 * 24 * 7; // 1 week guard
/** OAP feeds `paging.pageSize` straight to its storage layer as a
 *  LIMIT clause (PaginationUtils.java). A direct API caller could
 *  otherwise pass `pageSize: 100000` and exhaust the backend. The cap
 *  is `performance.limits.maxPageSize.traces` (default 100) — match the
 *  UI picker server-side, allowing graceful defaulting when the body
 *  omits or mangles the field. */
function clampPageSize(requested: number | undefined, fallback: number, max: number): number {
  if (!Number.isFinite(requested as number) || (requested as number) < 1) return fallback;
  return Math.min(max, Math.round(requested as number));
}
// Traces are RECORD-style data and have no metric-bucket cap on OAP
// (`DurationUtils.MAX_TIME_RANGE` only applies to metric queries via
// `assembleDurationPoints()`). Trace queries use SECOND precision so a
// span that just finished still falls inside the window — MINUTE rounding
// would chop off the most recent (most interesting) traces during triage.
function rollingWindow(minutes: number, offsetMinutes: number): { start: string; end: string } {
  const m = Math.max(1, Math.min(MAX_WINDOW_MIN, Math.round(minutes)));
  const endMs = Date.now();
  const startMs = endMs - m * 60_000;
  return { start: fmtSecond(startMs, offsetMinutes), end: fmtSecond(endMs, offsetMinutes) };
}
function explicitWindow(
  startMs: number,
  endMs: number,
  offsetMinutes: number,
): { start: string; end: string } | null {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return null;
  return { start: fmtSecond(startMs, offsetMinutes), end: fmtSecond(endMs, offsetMinutes) };
}

export interface TraceListBody {
  source?: TraceSource;
  /** Identity pair — see {@link serviceScopeOf}. The native list keys on the
   *  id; Zipkin has no ids and keys on the name. */
  serviceId?: string;
  service?: string;
  instanceId?: string;
  endpointId?: string;
  traceId?: string;
  traceState?: TraceQueryState;
  queryOrder?: TraceQueryOrder;
  minTraceDuration?: number;
  maxTraceDuration?: number;
  pageNum?: number;
  pageSize?: number;
  /** Free-form span tags (`http.status_code=500`, …). Matches OAP's
   *  `TraceQueryCondition.tags: [KeyValue]`. */
  tags?: Array<{ key: string; value: string }>;
  /** Rolling window in minutes. Default 30; clamped to [1, 10080]. */
  windowMinutes?: number;
  /** Explicit absolute epoch ms. When both are set they override
   *  `windowMinutes`; the BFF applies the OAP offset. */
  startMs?: number;
  endMs?: number;
  /** Admin Preview: the operator's draft `traces` block (JSON string).
   *  When present + valid, it picks the source instead of the remote
   *  template — same preview path as topology / endpoint-dependency. */
  previewConfig?: string;
}

/** `TraceBrief` carries `traces` + `debuggingTrace` — no total and no
 *  has-more, so the "capped" signal comes from the over-fetch seam. */
const BASIC_TRACES_PAGE: PagedQuerySpec = {
  operationName: 'QueryBasicTraces',
  conditionType: 'TraceQueryCondition',
  field: 'queryBasicTraces',
  rowsField: 'traces',
  rowsSelection: `
        key: segmentId
        endpointNames
        duration
        start
        isError
        traceIds`,
  probeSelection: 'segmentId',
};

/** `Trace` exposes only `spans` + `debuggingTrace`, so the probe row is a whole
 *  trace's span array — select one scalar per span and nothing else. */
const TRACES_PAGE: PagedQuerySpec = {
  operationName: 'QueryTraces',
  conditionType: 'TraceQueryCondition',
  field: 'queryTraces',
  rowsField: 'traces',
  rowsSelection: `
        spans {
          traceId
          segmentId
          spanId
          parentSpanId
          refs { traceId parentSegmentId parentSpanId type }
          serviceCode
          serviceInstanceName
          startTime
          endTime
          endpointName
          type
          peer
          component
          isError
          layer
          tags { key value }
          logs { time data { key value } }
          attachedEvents {
            startTime { seconds nanos }
            event
            endTime { seconds nanos }
            tags { key value }
            summary { key value }
          }
        }`,
  probeSelection: 'spans { spanId }',
};

/* `duration` is BanyanDB-only and optional. When the caller passes a
 * window (start/end/step), OAP scopes the trace lookup to that window
 * — necessary for IDs older than 1 day, since the default search is
 * "last 1 day" only. Pair with `Duration.coldStage: true` (spliced by
 * the `withColdStage` helper) for trace IDs whose data has migrated
 * past hot+warm. Older OAP versions ignore the unknown variable;
 * older non-BanyanDB backends ignore the Duration entirely. */
const QUERY_TRACE_DETAIL = /* GraphQL */ `
  query QueryTrace($traceId: ID!, $duration: Duration) {
    trace: queryTrace(traceId: $traceId, duration: $duration) {
      spans {
        traceId
        segmentId
        spanId
        parentSpanId
        refs { traceId parentSegmentId parentSpanId type }
        serviceCode
        serviceInstanceName
        startTime
        endTime
        endpointName
        type
        peer
        component
        isError
        layer
        tags { key value }
        logs { time data { key value } }
        attachedEvents {
          startTime { seconds nanos }
          event
          endTime { seconds nanos }
          tags { key value }
          summary { key value }
        }
      }
    }
  }
`;

function buildTraceCondition(
  body: TraceListBody,
  resolvedServiceId: string | null,
  w: { start: string; end: string },
  coldStage: boolean,
  paging: OapPaging,
) {
  return {
    ...(resolvedServiceId ? { serviceId: resolvedServiceId } : {}),
    ...(body.instanceId ? { serviceInstanceId: body.instanceId } : {}),
    ...(body.endpointId ? { endpointId: body.endpointId } : {}),
    ...(body.traceId ? { traceId: body.traceId } : {}),
    ...(body.tags && body.tags.length > 0 ? { tags: body.tags } : {}),
    ...(typeof body.minTraceDuration === 'number' ? { minTraceDuration: body.minTraceDuration } : {}),
    ...(typeof body.maxTraceDuration === 'number' ? { maxTraceDuration: body.maxTraceDuration } : {}),
    queryDuration: {
      start: w.start,
      end: w.end,
      step: 'SECOND',
      ...(coldStage ? { coldStage: true } : {}),
    },
    traceState: (body.traceState ?? 'ALL') as TraceQueryState,
    queryOrder: (body.queryOrder ?? 'BY_START_TIME') as TraceQueryOrder,
    paging,
  };
}

export async function fetchNativeList(
  opts: GraphqlOptions,
  body: TraceListBody,
  coldStage: boolean,
  offsetMinutes: number,
  maxPageSize: number,
): Promise<NativeTraceListResponse> {
  const api = await detectTraceQueryApi(opts);
  // Explicit start+end takes precedence over windowMinutes; falling
  // back to the rolling default when the explicit range is invalid.
  const explicit =
    typeof body.startMs === 'number' && typeof body.endMs === 'number'
      ? explicitWindow(body.startMs, body.endMs, offsetMinutes)
      : null;
  const window = explicit ?? rollingWindow(body.windowMinutes ?? DEFAULT_WINDOW_MIN, offsetMinutes);
  const scope = serviceScopeOf(body);
  // Half an identity must NOT fall through as "no service":
  // `TraceQueryCondition.serviceId` is nullable, so the query would widen to
  // every service in the window and the rows would read as this service's.
  if (scope.kind === 'incomplete') {
    return { source: 'native', api, traces: [], hasNext: false, reachable: false, error: scope.message };
  }
  const serviceId = scope.kind === 'service' ? scope.service.id : null;
  // OAP forwards `pageSize` straight to storage as a LIMIT
  // (PaginationUtils.java). The UI picker caps at 200; mirror that server-side
  // so the cap holds against direct API callers.
  const paging: OapPaging = {
    pageNum: Math.max(1, Math.round(body.pageNum ?? 1)),
    pageSize: clampPageSize(body.pageSize, 20, maxPageSize),
  };
  const condition = (p: OapPaging): Record<string, unknown> =>
    buildTraceCondition(body, serviceId, window, coldStage, p);
  try {
    if (api === 'queryTraces') {
      const page = await readPage<{ spans: NativeSpan[] }>(opts, TRACES_PAGE, condition, paging);
      const traces = page.rows.map((t) => {
        // v2 spans are flat across all segments; every segment's entry span
        // has parentSpanId === -1, so match the global root by its empty refs
        // (booster-ui does the same) — else a downstream callee can win.
        const root = t.spans.find((s) => s.parentSpanId === -1 && s.refs.length === 0) ?? t.spans[0];
        const ids = Array.from(new Set(t.spans.map((s) => s.traceId)));
        return {
          key: root?.segmentId ?? ids[0] ?? '',
          segmentId: root?.segmentId ?? '',
          endpointNames: root?.endpointName ? [root.endpointName] : [],
          duration: root ? root.endTime - root.startTime : 0,
          start: root ? String(root.startTime) : '',
          isError: t.spans.some((s) => s.isError),
          traceIds: ids,
          spans: t.spans,
        };
      });
      return { source: 'native', api, traces, hasNext: page.hasNext, reachable: true };
    }
    const page = await readPage<{
      key: string;
      endpointNames: string[];
      duration: number;
      start: string;
      isError: boolean;
      traceIds: string[];
    }>(opts, BASIC_TRACES_PAGE, condition, paging);
    const traces = page.rows.map((t) => ({
      key: t.key,
      segmentId: t.key,
      endpointNames: t.endpointNames,
      duration: t.duration,
      start: t.start,
      isError: t.isError,
      traceIds: t.traceIds,
    }));
    return { source: 'native', api, traces, hasNext: page.hasNext, reachable: true };
  } catch (err) {
    return {
      source: 'native',
      api,
      traces: [],
      hasNext: false,
      reachable: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Fetch one native trace's spans (queryTrace). Hydrates v1 (queryBasicTraces)
 *  list rows — which carry no inline spans — so a captured list can replay the
 *  waterfall offline (the AI trace-capture path). Never throws: one unreadable
 *  trace degrades to no spans (that row replays without a waterfall) instead of
 *  failing the whole capture. */
export async function fetchNativeTraceSpans(opts: GraphqlOptions, traceId: string): Promise<NativeSpan[]> {
  try {
    const env = await graphqlPost<{ trace: { spans: NativeSpan[] } | null }>(opts, QUERY_TRACE_DETAIL, { traceId });
    return env.trace?.spans ?? [];
  } catch {
    return [];
  }
}

/** Zipkin's `/api/v2/traces` takes a `limit` and no offset at all, so this can
 *  only ever run the over-fetch half of the seam: ask limit+1, render limit,
 *  and report `hasNext` as "capped". A Zipkin PAGER would need a
 *  backwards-walking `endTs` cursor, which is a different feature. */
export async function fetchZipkinList(
  opts: GraphqlOptions,
  body: TraceListBody,
  maxPageSize: number,
): Promise<ZipkinTraceListResponse> {
  const limit = clampPageSize(body.pageSize, 20, maxPageSize);
  try {
    const fetched = await zipkinFetchTraces(opts, {
      serviceName: body.service,
      minDuration: body.minTraceDuration,
      maxDuration: body.maxTraceDuration,
      limit: overFetchSize(limit),
    });
    const { rows, hasNext } = takeOverFetched(fetched, limit);
    return { source: 'zipkin', traces: rows, hasNext, reachable: true };
  } catch (err) {
    return {
      source: 'zipkin',
      traces: [],
      hasNext: false,
      reachable: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function registerTraceRoutes(app: FastifyInstance, deps: TraceRouteDeps): void {
  const auth = requireAuth(deps);

  app.post(
    '/api/layer/:key/traces',
    { preHandler: auth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const params = req.params as { key: string };
      const layerKey = params.key;
      if (!layerKey || !/^[a-z0-9_]+$/i.test(layerKey)) {
        return reply.code(400).send({ error: 'invalid_layer_key' });
      }
      const body = (req.body ?? {}) as TraceListBody;
      // Admin Preview: draft `traces` block wins (bypasses remote + block).
      const previewCfg = parsePreviewTraces(body.previewConfig);
      let tracesCfg: TracesConfig;
      if (previewCfg) {
        tracesCfg = previewCfg;
      } else {
        const eff = await resolveEffectiveLayer(deps.uiTemplateClient, layerKey);
        if (eff.blocked) {
          // Template store unreachable / layer disabled — block: serve no
          // traces rather than guessing the source from a default config.
          return reply.send({ generatedAt: Date.now(), source: body.source ?? 'native' });
        }
        tracesCfg = tracesConfigFor(eff.template);
      }
      const requestedSource: TraceSource = body.source ?? tracesCfg.source;
      const opts = buildOapOpts(deps.config.current, deps.fetch);
      const offset = await getServerOffsetMinutes(deps.config, deps.fetch);
      const maxPageSize = deps.config.current.performance.limits.maxPageSize.traces;

      const wantNative = requestedSource === 'both' || requestedSource === 'native';
      const wantZipkin = requestedSource === 'both' || requestedSource === 'zipkin';
      // Fan out in parallel; partial failures don't drop the whole
      // response — the UI's empty / error states cover each slot.
      const [native, zipkin] = await Promise.all([
        wantNative
          ? fetchNativeList(opts, body, !!req.coldStage, offset, maxPageSize)
          : Promise.resolve(undefined),
        wantZipkin ? fetchZipkinList(opts, body, maxPageSize) : Promise.resolve(undefined),
      ]);

      const response: TraceListResponse = {
        generatedAt: Date.now(),
        source: requestedSource,
        ...(native ? { native } : {}),
        ...(zipkin ? { zipkin } : {}),
      };
      return reply.send(response);
    },
  );

  app.get(
    '/api/trace/:traceId',
    { preHandler: auth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const params = req.params as { traceId: string };
      const q = req.query as {
        source?: 'native' | 'zipkin';
        /** Approximate window the trace lives in (epoch ms + OAP step).
         *  When provided, the BFF spells the window in OAP-server TZ
         *  via `windowFromRange` and forwards it as `queryTrace.duration`
         *  so BanyanDB looks beyond its default 1-day search. Paired
         *  with the cold-stage header, this lets a trace ID from a log
         *  row resolve even when the trace data lives in the cold tier. */
        startMs?: string;
        endMs?: string;
        step?: 'MINUTE' | 'HOUR' | 'DAY';
      };
      const source: 'native' | 'zipkin' = q.source === 'zipkin' ? 'zipkin' : 'native';
      const opts = buildOapOpts(deps.config.current, deps.fetch);

      if (source === 'native') {
        const api = await detectTraceQueryApi(opts);
        try {
          // When the caller supplies an approximate window, forward it
          // as the optional `duration` so BanyanDB looks beyond its
          // default 1-day window. `withColdStage` adds `coldStage: true`
          // when the operator has the Cold pill on, letting trace IDs
          // whose data lives in the cold tier resolve from log rows.
          const startMs = Number(q.startMs);
          const endMs = Number(q.endMs);
          let duration: { start: string; end: string; step: string; coldStage?: true } | undefined;
          if (
            (q.step === 'MINUTE' || q.step === 'HOUR' || q.step === 'DAY') &&
            Number.isFinite(startMs) &&
            Number.isFinite(endMs)
          ) {
            const offset = await getServerOffsetMinutes(deps.config, deps.fetch);
            const w = windowFromRange(q.step, startMs, endMs, offset);
            if (w) duration = withColdStage(req, { start: w.start, end: w.end, step: w.step });
          }
          const env = await graphqlPost<{ trace: { spans: NativeSpan[] } }>(
            opts,
            QUERY_TRACE_DETAIL,
            { traceId: params.traceId, duration },
          );
          const detail: NativeTraceDetailResponse = {
            source: 'native',
            api,
            traceId: params.traceId,
            spans: env.trace?.spans ?? [],
            reachable: true,
          };
          return reply.send({
            generatedAt: Date.now(),
            source,
            native: detail,
          } satisfies TraceDetailResponse);
        } catch (err) {
          const detail: NativeTraceDetailResponse = {
            source: 'native',
            api,
            traceId: params.traceId,
            spans: [],
            reachable: false,
            error: err instanceof Error ? err.message : String(err),
          };
          return reply.send({
            generatedAt: Date.now(),
            source,
            native: detail,
          } satisfies TraceDetailResponse);
        }
      }
      // Zipkin.
      try {
        const spans = await zipkinFetchTraceById(opts, params.traceId);
        const detail: ZipkinTraceDetailResponse = {
          source: 'zipkin',
          traceId: params.traceId,
          spans,
          reachable: true,
        };
        return reply.send({
          generatedAt: Date.now(),
          source,
          zipkin: detail,
        } satisfies TraceDetailResponse);
      } catch (err) {
        const detail: ZipkinTraceDetailResponse = {
          source: 'zipkin',
          traceId: params.traceId,
          spans: [],
          reachable: false,
          error: err instanceof Error ? err.message : String(err),
        };
        return reply.send({
          generatedAt: Date.now(),
          source,
          zipkin: detail,
        } satisfies TraceDetailResponse);
      }
    },
  );
}

// Re-export the summariser so future callers can consume it; unused
// here but useful for tests.
export { summariseZipkinTrace };
