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
import { tracesConfigFor } from '../../logic/layers/loader.js';
import { resolveEffectiveLayer } from '../../logic/layers/effective.js';
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
 *  otherwise pass `pageSize: 100000` and exhaust the backend. The UI
 *  picker caps at 200 — match that server-side, allowing graceful
 *  defaulting when the body omits or mangles the field. */
const MAX_TRACE_PAGE_SIZE = 200;
function clampPageSize(requested: number | undefined, fallback: number): number {
  if (!Number.isFinite(requested as number) || (requested as number) < 1) return fallback;
  return Math.min(MAX_TRACE_PAGE_SIZE, Math.round(requested as number));
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
  startIso: string,
  endIso: string,
  offsetMinutes: number,
): { start: string; end: string } | null {
  const s = new Date(startIso);
  const e = new Date(endIso);
  if (!Number.isFinite(s.getTime()) || !Number.isFinite(e.getTime()) || e.getTime() < s.getTime()) {
    return null;
  }
  return { start: fmtSecond(s.getTime(), offsetMinutes), end: fmtSecond(e.getTime(), offsetMinutes) };
}

// ── Wire request shape ─────────────────────────────────────────────

interface TraceListBody {
  source?: TraceSource;
  service?: string;
  serviceId?: string;
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
  /** Explicit ISO start (UTC). When both `start` and `end` are
   *  provided they override `windowMinutes`. */
  start?: string;
  /** Explicit ISO end (UTC). Pair with `start`. */
  end?: string;
  /** Admin Preview: the operator's draft `traces` block (JSON string).
   *  When present + valid, it picks the source instead of the remote
   *  template — same preview path as topology / endpoint-dependency. */
  previewConfig?: string;
}

// ── Native GraphQL queries ────────────────────────────────────────

const LIST_SERVICES_FOR_RESOLVE = /* GraphQL */ `
  query ListServicesForTrace($layer: String!) {
    services: listServices(layer: $layer) {
      id
      name
      normal
    }
  }
`;

const QUERY_BASIC_TRACES = /* GraphQL */ `
  query QueryBasicTraces($condition: TraceQueryCondition) {
    data: queryBasicTraces(condition: $condition) {
      traces {
        key: segmentId
        endpointNames
        duration
        start
        isError
        traceIds
      }
    }
  }
`;

const QUERY_TRACES = /* GraphQL */ `
  query QueryTraces($condition: TraceQueryCondition) {
    data: queryTraces(condition: $condition) {
      traces {
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
  }
`;

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

// ── Helpers ────────────────────────────────────────────────────────

// OAP service-id shape: `<base64>.<digits>`. Match strictly so we
// don't mis-classify names containing `.` (e.g. `*.sample-services`)
// as ids — the earlier "contains `.` and no whitespace" heuristic was
// too loose and broke trace queries on mesh-layer services.
const OAP_SERVICE_ID_RE = /^[A-Za-z0-9+/=]+\.\d+$/;
async function resolveServiceId(
  opts: GraphqlOptions,
  layer: string,
  serviceArg: string,
): Promise<string | null> {
  if (!serviceArg) return null;
  if (OAP_SERVICE_ID_RE.test(serviceArg)) return serviceArg;
  const data = await graphqlPost<{
    services: Array<{ id: string; name: string }>;
  }>(opts, LIST_SERVICES_FOR_RESOLVE, { layer: layer.toUpperCase() });
  return (
    data.services.find((s) => s.name === serviceArg)?.id ??
    data.services.find((s) => s.id === serviceArg)?.id ??
    null
  );
}

function buildTraceCondition(
  body: TraceListBody,
  resolvedServiceId: string | null,
  w: { start: string; end: string },
  coldStage: boolean,
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
    paging: {
      pageNum: Math.max(1, Math.round(body.pageNum ?? 1)),
      // OAP forwards `pageSize` straight to storage as a LIMIT
      // (PaginationUtils.java). The UI picker caps at 200; mirror that
      // server-side so the cap holds against direct API callers.
      pageSize: clampPageSize(body.pageSize, 20),
    },
  };
}

async function fetchNativeList(
  opts: GraphqlOptions,
  body: TraceListBody,
  layerKey: string,
  coldStage: boolean,
  offsetMinutes: number,
): Promise<NativeTraceListResponse> {
  const api = await detectTraceQueryApi(opts);
  // Explicit start+end takes precedence over windowMinutes; falling
  // back to the rolling default when the explicit range is invalid.
  const explicit = body.start && body.end ? explicitWindow(body.start, body.end, offsetMinutes) : null;
  const window = explicit ?? rollingWindow(body.windowMinutes ?? DEFAULT_WINDOW_MIN, offsetMinutes);
  let serviceId: string | null = null;
  try {
    serviceId = body.serviceId
      ? body.serviceId
      : body.service
        ? await resolveServiceId(opts, layerKey, body.service)
        : null;
  } catch (err) {
    return {
      source: 'native',
      api,
      traces: [],
      reachable: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  const condition = buildTraceCondition(body, serviceId, window, coldStage);
  try {
    if (api === 'queryTraces') {
      const env = await graphqlPost<{
        data: { traces: Array<{ spans: NativeSpan[] }> };
      }>(opts, QUERY_TRACES, { condition });
      const traces = (env.data?.traces ?? []).map((t) => {
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
      return { source: 'native', api, traces, reachable: true };
    }
    const env = await graphqlPost<{
      data: {
        traces: Array<{
          key: string;
          endpointNames: string[];
          duration: number;
          start: string;
          isError: boolean;
          traceIds: string[];
        }>;
      };
    }>(opts, QUERY_BASIC_TRACES, { condition });
    const traces = (env.data?.traces ?? []).map((t) => ({
      key: t.key,
      segmentId: t.key,
      endpointNames: t.endpointNames,
      duration: t.duration,
      start: t.start,
      isError: t.isError,
      traceIds: t.traceIds,
    }));
    return { source: 'native', api, traces, reachable: true };
  } catch (err) {
    return {
      source: 'native',
      api,
      traces: [],
      reachable: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function fetchZipkinList(
  opts: GraphqlOptions,
  body: TraceListBody,
): Promise<ZipkinTraceListResponse> {
  try {
    const traces = await zipkinFetchTraces(opts, {
      serviceName: body.service,
      minDuration: body.minTraceDuration,
      maxDuration: body.maxTraceDuration,
      limit: clampPageSize(body.pageSize, 20),
    });
    return { source: 'zipkin', traces, reachable: true };
  } catch (err) {
    return {
      source: 'zipkin',
      traces: [],
      reachable: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ── Routes ─────────────────────────────────────────────────────────

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

      const wantNative = requestedSource === 'both' || requestedSource === 'native';
      const wantZipkin = requestedSource === 'both' || requestedSource === 'zipkin';
      // Fan out in parallel; partial failures don't drop the whole
      // response — the UI's empty / error states cover each slot.
      const [native, zipkin] = await Promise.all([
        wantNative
          ? fetchNativeList(opts, body, layerKey, !!req.coldStage, offset)
          : Promise.resolve(undefined),
        wantZipkin ? fetchZipkinList(opts, body) : Promise.resolve(undefined),
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
