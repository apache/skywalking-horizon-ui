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
 * `POST /api/layer/:key/logs`
 *
 * Wraps OAP's `queryLogs(LogQueryCondition)`. Body shape is the
 * `LogQueryRequest` from `@skywalking-horizon-ui/api-client/logs`.
 *
 * Tag filters + content keyword filters are AND-joined server-side.
 * The body carries the picked service's identity (`serviceId` + `service`);
 * the log condition keys on the id.
 *
 * Returns one page of logs plus `hasNext`, read through the shared
 * over-fetch-by-one seam. OAP exposes no cross-page total, so none is
 * reported.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type {
  FetchLike,
  LogFacetsResponse,
  LogKeyValue,
  LogQueryRequest,
  LogRow,
  LogTagFilter,
  LogsResponse,
  TraceLogsResponse,
} from '@skywalking-horizon-ui/api-client';
import { TRACE_LOG_WINDOW_PAD_MS } from '@skywalking-horizon-ui/api-client';
import type { AuthDeps } from '../../user/middleware.js';
import { clientGone } from '../client-gone.js';
import { getOapCapabilities } from '../../logic/oap/capabilities.js';
import { requireAuth } from '../../user/middleware.js';
import { buildOapOpts, type GraphqlOptions } from '../../client/graphql.js';
import { serviceScopeOf } from '../../logic/oap/service-scope.js';
import {
  readPage,
  type OapPaging,
  type PagedQuerySpec,
} from '../../logic/paging/read-page.js';
import { withColdStage } from '../../util/duration.js';
import { fmtSecond, getServerOffsetMinutes } from '../../util/window.js';
import { ServiceLookupUnavailable } from '../../logic/services/service-identity.js';

export interface LogRouteDeps extends AuthDeps {
  fetch?: FetchLike;
}

const DEFAULT_WINDOW_MIN = 30;
const MAX_WINDOW_MIN = 60 * 24 * 7; // 1 week guard, mirrors trace.ts
/** OAP feeds `paging.pageSize` straight to its storage layer as a
 *  LIMIT clause. The cap is `performance.limits.maxPageSize.logs`
 *  (default 100); mirror that server-side so the cap holds against
 *  direct API callers. */
function clampPageSize(requested: number | undefined, fallback: number, max: number): number {
  if (!Number.isFinite(requested as number) || (requested as number) < 1) return fallback;
  return Math.min(max, Math.round(requested as number));
}

/** Build the log query window as SECOND-precision strings. Logs are
 *  RECORD-style data (no metric bucket-cap) — using MINUTE step would
 *  round off the most recent log lines for up to a minute, which is
 *  exactly when an operator is triaging.
 *
 *  Two shapes: an explicit absolute window (epoch ms) formatted OAP-local
 *  via `fmtSecond`, or a rolling fallback in minutes ending at "now". */
function defaultWindow(
  offsetMinutes: number,
  minutes?: number,
  explicit?: { startMs?: number; endMs?: number },
): { start: string; end: string } {
  if (
    typeof explicit?.startMs === 'number' &&
    typeof explicit.endMs === 'number' &&
    explicit.startMs < explicit.endMs
  ) {
    // Clamped to the same week the rolling arm below is: an explicit range was
    // the one path that could ask storage for a month or a year. The most
    // recent slice is kept rather than refusing outright.
    const from = Math.max(explicit.startMs, explicit.endMs - MAX_WINDOW_MIN * 60_000);
    return {
      start: fmtSecond(from, offsetMinutes),
      end: fmtSecond(explicit.endMs, offsetMinutes),
    };
  }
  const m = Number.isFinite(minutes) && (minutes as number) > 0
    ? Math.min(MAX_WINDOW_MIN, Math.round(minutes as number))
    : DEFAULT_WINDOW_MIN;
  const endMs = Date.now();
  const startMs = endMs - m * 60_000;
  return { start: fmtSecond(startMs, offsetMinutes), end: fmtSecond(endMs, offsetMinutes) };
}

const LOG_ROW_SELECTION = `
        serviceName
        serviceId
        serviceInstanceName
        serviceInstanceId
        endpointName
        endpointId
        traceId
        timestamp
        contentType
        content
        tags { key value }`;

/** OAP's `Logs` type carries `errorReason` / `logs` / `debuggingTrace` — no
 *  total and no has-more, so paging facts come from the over-fetch seam. */
const LOG_PAGE: PagedQuerySpec = {
  operationName: 'QueryLogs',
  conditionType: 'LogQueryCondition',
  field: 'queryLogs',
  rowsField: 'logs',
  rowsSelection: LOG_ROW_SELECTION,
  probeSelection: 'timestamp',
};

interface OapLogRow {
  serviceName?: string | null;
  serviceId?: string | null;
  serviceInstanceName?: string | null;
  serviceInstanceId?: string | null;
  endpointName?: string | null;
  endpointId?: string | null;
  traceId?: string | null;
  timestamp: number;
  contentType: string;
  content: string;
  tags?: LogKeyValue[] | null;
}

function mapLogRow(r: OapLogRow): LogRow {
  return {
    serviceName: r.serviceName ?? null,
    serviceId: r.serviceId ?? null,
    serviceInstanceName: r.serviceInstanceName ?? null,
    serviceInstanceId: r.serviceInstanceId ?? null,
    endpointName: r.endpointName ?? null,
    endpointId: r.endpointId ?? null,
    traceId: r.traceId ?? null,
    timestamp: r.timestamp,
    contentType: r.contentType,
    content: r.content,
    tags: r.tags ?? [],
  };
}

/** Entity ids the log query scopes by — all PRE-RESOLVED by the caller
 *  (no `listServices(layer)` lookup, no name → id resolution). The
 *  per-layer route resolves a name first; explore forwards ids it
 *  already minted. */
export interface LogFetchScope {
  serviceId?: string | null;
  serviceInstanceId?: string | null;
  endpointId?: string | null;
  traceId?: string | null;
  /** Narrow `traceId` to one native span; ignored without a trace id. */
  segmentId?: string | null;
  spanId?: number | null;
  /** Narrow `traceId` to one OTLP or Zipkin span. */
  otlpSpanId?: string | null;
  keywordsOfContent?: string[];
  tags?: LogTagFilter[];
  /** OAP orders by timestamp, newest first unless told otherwise. */
  queryOrder?: 'ASC' | 'DES';
}

/** `TraceScopeCondition`. Span id 0 is a span — a segment's first. */
function relatedTraceOf(traceId: string, scope: LogFetchScope): Record<string, unknown> {
  return {
    traceId,
    ...(scope.segmentId ? { segmentId: scope.segmentId } : {}),
    ...(typeof scope.spanId === 'number' ? { spanId: scope.spanId } : {}),
    ...(scope.otlpSpanId ? { otlpSpanId: scope.otlpSpanId } : {}),
  };
}

/** Build the `LogQueryCondition` for one paging pair. Curried over the
 *  already-resolved window so the page and its next-page probe read the same
 *  range — a second `defaultWindow()` call would drift by the round-trip. */
function logCondition(
  scope: LogFetchScope,
  window: { start: string; end: string },
  coldStage: boolean,
): (paging: OapPaging) => Record<string, unknown> {
  return (paging) => ({
    ...(scope.serviceId ? { serviceId: scope.serviceId } : {}),
    ...(scope.serviceInstanceId ? { serviceInstanceId: scope.serviceInstanceId } : {}),
    ...(scope.endpointId ? { endpointId: scope.endpointId } : {}),
    ...(scope.traceId ? { relatedTrace: relatedTraceOf(scope.traceId, scope) } : {}),
    ...(scope.keywordsOfContent && scope.keywordsOfContent.length > 0
      ? { keywordsOfContent: scope.keywordsOfContent }
      : {}),
    ...(scope.tags && scope.tags.length > 0 ? { tags: scope.tags } : {}),
    ...(scope.queryOrder ? { queryOrder: scope.queryOrder } : {}),
    queryDuration: {
      start: window.start,
      end: window.end,
      step: 'SECOND',
      ...(coldStage ? { coldStage: true } : {}),
    },
    paging,
  });
}

/** Run OAP's `queryLogs(LogQueryCondition)` for a pre-resolved scope +
 *  SECOND-precision window + page, and map the rows to {@link LogRow}.
 *  Shared by the per-layer Logs route and the cross-layer Log inspect
 *  branch. Soft-fails to `reachable: false` on any OAP error. */
export async function fetchLogs(
  opts: GraphqlOptions,
  scope: LogFetchScope,
  window: { start: string; end: string },
  paging: OapPaging,
  coldStage: boolean,
): Promise<LogsResponse> {
  try {
    const page = await readPage<OapLogRow>(
      opts,
      LOG_PAGE,
      logCondition(scope, window, coldStage),
      paging,
    );
    return {
      generatedAt: Date.now(),
      query: {},
      pageNum: page.pageNum,
      pageSize: page.pageSize,
      hasNext: page.hasNext,
      logs: page.rows.map(mapLogRow),
      reachable: true,
    };
  } catch (err) {
    return {
      generatedAt: Date.now(),
      query: {},
      pageNum: paging.pageNum,
      pageSize: paging.pageSize,
      hasNext: false,
      logs: [],
      reachable: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

interface LogBody extends LogQueryRequest {
  /** Name half of the picked service's identity; `serviceId` (on
   *  `LogQueryRequest`) is the half the log condition queries with. */
  service?: string;
}

export function registerLogRoute(app: FastifyInstance, deps: LogRouteDeps): void {
  const auth = requireAuth(deps);
  app.post(
    '/api/layer/:key/logs',
    { preHandler: auth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const params = req.params as { key: string };
      const layerKey = params.key;
      if (!layerKey || !/^[a-z0-9_]+$/i.test(layerKey)) {
        return reply.code(400).send({ error: 'invalid_layer_key' });
      }
      const body = (req.body ?? {}) as LogBody;
      const opts = buildOapOpts(deps.config.current, deps.fetch);
      const offset = await getServerOffsetMinutes(deps.config, deps.fetch);
      const window = defaultWindow(offset, body.windowMinutes, {
        startMs: body.startMs,
        endMs: body.endMs,
      });

      const paging: OapPaging = {
        pageNum: Math.max(1, Math.round(body.page ?? 1)),
        pageSize: clampPageSize(body.pageSize, 50, deps.config.current.performance.limits.maxPageSize.logs),
      };

      // A name with no id refuses the read: `LogQueryCondition.serviceId` is
      // nullable, so falling through with `null` would stream EVERY service's
      // logs under the picked service's title.
      const scope = serviceScopeOf(body);
      if (scope.kind === 'incomplete') {
        return reply.send({
          generatedAt: Date.now(),
          query: body,
          ...paging,
          hasNext: false,
          logs: [],
          reachable: false,
          error: scope.message,
        } satisfies LogsResponse);
      }
      const serviceId = scope.kind === 'service' ? scope.service.id : null;
      const res = await fetchLogs(
        opts,
        {
          serviceId,
          serviceInstanceId: body.serviceInstanceId,
          endpointId: body.endpointId,
          traceId: body.traceId,
          keywordsOfContent: body.keywordsOfContent,
          tags: body.tags,
        },
        window,
        paging,
        !!req.coldStage,
      );
      // A read across every service keeps only the services this caller may
      // read — for a plain grant that leaves out the Platform monitoring ones.
      if (!serviceId && req.access) {
        try {
          res.logs = await req.access.keepReadable(['logs:read'], res.logs, (r) => ({ id: r.serviceId ?? '' }));
        } catch (err) {
          if (!(err instanceof ServiceLookupUnavailable)) throw err;
          return reply.send({ ...res, logs: [], hasNext: false, reachable: false, error: err.message, query: body } satisfies LogsResponse);
        }
      }
      // Echo the operator's query (the shared helper returns an empty
      // echo since it's entity-agnostic).
      return reply.send({ ...res, query: body } satisfies LogsResponse);
    },
  );

  /**
   * POST /api/layer/:key/logs/facets
   *
   * Fetches a larger window-scoped sample (default 200 rows) just for
   * facet aggregation. The UI calls this in parallel with the page
   * fetch so the left-rail counts reflect the query window, not the
   * displayed page. The sample is over-fetched by one, so `truncated`
   * says whether the window held more than the sample counted.
   */
  app.post(
    '/api/layer/:key/logs/facets',
    { preHandler: auth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const params = req.params as { key: string };
      const layerKey = params.key;
      if (!layerKey || !/^[a-z0-9_]+$/i.test(layerKey)) {
        return reply.code(400).send({ error: 'invalid_layer_key' });
      }
      const body = (req.body ?? {}) as LogBody & { sampleSize?: number };
      const sampleSize = Math.max(50, Math.min(1000, body.sampleSize ?? 200));
      const opts = buildOapOpts(deps.config.current, deps.fetch);
      const offset = await getServerOffsetMinutes(deps.config, deps.fetch);
      const window = defaultWindow(offset, body.windowMinutes, {
        startMs: body.startMs,
        endMs: body.endMs,
      });
      // Same refusal as the row query — a facet sample taken across every
      // service would count log lines this service never wrote.
      const scope = serviceScopeOf(body);
      if (scope.kind === 'incomplete') {
        return reply.send({
          generatedAt: Date.now(),
          sampled: 0,
          truncated: false,
          level: { error: 0, warn: 0, info: 0, debug: 0, other: 0 },
          services: [],
          reachable: false,
          error: scope.message,
        } satisfies LogFacetsResponse);
      }
      const serviceId = scope.kind === 'service' ? scope.service.id : null;
      const condition = (paging: OapPaging): Record<string, unknown> => ({
        ...(serviceId ? { serviceId } : {}),
        ...(body.serviceInstanceId ? { serviceInstanceId: body.serviceInstanceId } : {}),
        ...(body.endpointId ? { endpointId: body.endpointId } : {}),
        ...(body.traceId ? { relatedTrace: { traceId: body.traceId } } : {}),
        ...(body.keywordsOfContent && body.keywordsOfContent.length > 0
          ? { keywordsOfContent: body.keywordsOfContent }
          : {}),
        // Facet sample intentionally ignores level/tag filters so the
        // counts show the unfiltered distribution; the user picks a
        // level from the breakdown.
        queryDuration: withColdStage(req, { start: window.start, end: window.end, step: 'SECOND' }),
        paging,
      });

      try {
        const sample = await readPage<OapLogRow>(opts, LOG_PAGE, condition, {
          pageNum: 1,
          pageSize: sampleSize,
        });
        const rows =
          !serviceId && req.access
            ? await req.access.keepReadable(['logs:read'], sample.rows, (r) => ({ id: r.serviceId ?? '' }))
            : sample.rows;
        const level: LogFacetsResponse['level'] = { error: 0, warn: 0, info: 0, debug: 0, other: 0 };
        const svcMap = new Map<string, number>();
        for (const r of rows) {
          const tag = (r.tags ?? []).find((t) => t.key.toLowerCase() === 'level');
          const raw = (tag?.value ?? '').toLowerCase();
          if (raw.includes('error') || raw === 'err' || raw === 'fatal') level.error++;
          else if (raw.includes('warn')) level.warn++;
          else if (raw.includes('info')) level.info++;
          else if (raw.includes('debug') || raw.includes('trace')) level.debug++;
          else level.other++;
          const svc = r.serviceName ?? '(none)';
          svcMap.set(svc, (svcMap.get(svc) ?? 0) + 1);
        }
        const services = Array.from(svcMap.entries())
          .map(([name, count]) => ({ name, count }))
          .sort((a, b) => b.count - a.count)
          .slice(0, 12);
        return reply.send({
          generatedAt: Date.now(),
          sampled: rows.length,
          truncated: sample.hasNext,
          level,
          services,
          reachable: true,
        } satisfies LogFacetsResponse);
      } catch (err) {
        return reply.send({
          generatedAt: Date.now(),
          sampled: 0,
          truncated: false,
          level: { error: 0, warn: 0, info: 0, debug: 0, other: 0 },
          services: [],
          reachable: false,
          error: err instanceof Error ? err.message : String(err),
        } satisfies LogFacetsResponse);
      }
    },
  );

  /**
   * GET /api/trace/:traceId/logs?startMs&endMs[&segmentId&spanId | &otlpSpanId][&altTraceId][&page&pageSize]
   *
   * The log lines carrying a trace's id, or one span's: a native span by segment
   * id and span id, an OTLP or Zipkin span by its hex id. A trace crosses
   * services, so the read names none and keeps the rows whose services the
   * caller may read. The window is always sent: without one, OAP 11.0.0 on
   * BanyanDB searches only the last day, and cold storage is never reached.
   */
  app.get(
    '/api/trace/:traceId/logs',
    { preHandler: auth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { traceId } = req.params as { traceId: string };
      const q = req.query as Record<string, string | undefined>;
      const startMs = Number(q.startMs);
      const endMs = Number(q.endMs);
      if (!traceId || !(startMs > 0) || !Number.isFinite(endMs) || endMs < startMs) {
        return reply.code(400).send({ error: 'invalid_trace_window' });
      }
      const segmentId = q.segmentId || undefined;
      const spanId = q.spanId === undefined || q.spanId === '' ? undefined : Number(q.spanId);
      // A native span is its segment AND its number within it: either alone is
      // a partial address, which OAP refuses too.
      if ((segmentId || spanId !== undefined) && (!segmentId || spanId === undefined || !Number.isInteger(spanId))) {
        return reply.code(400).send({ error: 'invalid_span' });
      }
      const otlpSpanId = q.otlpSpanId || undefined;
      if (otlpSpanId !== undefined && (!/^[0-9a-f]{16}$/.test(otlpSpanId) || segmentId || spanId !== undefined)) {
        return reply.code(400).send({ error: 'invalid_otlp_span' });
      }
      const altTraceId = q.altTraceId && q.altTraceId !== traceId ? q.altTraceId : undefined;
      const pageNum = Math.max(1, Math.round(Number(q.page) || 1));
      const pageSize = clampPageSize(Number(q.pageSize), 50, deps.config.current.performance.limits.maxPageSize.logs);
      const signal = clientGone(reply);
      const opts = buildOapOpts(deps.config.current, deps.fetch, signal);
      const offset = await getServerOffsetMinutes(deps.config, deps.fetch, signal);
      const to = endMs + TRACE_LOG_WINDOW_PAD_MS;
      // One read searches at most a week, its last one — the reply names the
      // start actually searched, so a longer trace is not shown as covered.
      const from = Math.max(startMs - TRACE_LOG_WINDOW_PAD_MS, to - MAX_WINDOW_MIN * 60_000);
      const windowClipped = from > startMs - TRACE_LOG_WINDOW_PAD_MS;
      // An OAP without the field rejects the whole query, so it is not sent there.
      if (otlpSpanId && !(await getOapCapabilities(deps.config.current, deps.fetch, signal)).logOtlpSpanId) {
        return reply.send({
          generatedAt: Date.now(),
          pageNum,
          pageSize,
          traceId,
          startMs: from,
          endMs: to,
          windowClipped,
          hasNext: false,
          logs: [],
          withheld: 0,
          reachable: false,
          error: 'Reading the logs of an OTLP or Zipkin span requires SkyWalking 11.2.0 or later.',
        } satisfies TraceLogsResponse);
      }
      const window = defaultWindow(offset, undefined, { startMs: from, endMs: to });
      const read = (id: string) => fetchLogs(
        opts,
        { traceId: id, segmentId, spanId, otlpSpanId, queryOrder: 'ASC' },
        window,
        { pageNum, pageSize },
        !!req.coldStage,
      );
      let readBy = traceId;
      let res = await read(traceId);
      // OAP keeps a log under the id spelling its storage setting gives, which
      // the caller cannot know: the other spelling is tried once, on the first
      // page, and the reply names the one that answered for the pages after.
      if (altTraceId && pageNum === 1 && res.reachable && res.logs.length === 0 && !res.hasNext) {
        const alt = await read(altTraceId);
        // A failed second read is reported, not hidden behind the first's
        // empty answer: the lines may be exactly where it could not look.
        if (!alt.reachable || alt.logs.length > 0 || alt.hasNext) {
          res = alt;
          readBy = altTraceId;
        }
      }
      const base = { generatedAt: res.generatedAt, pageNum: res.pageNum, pageSize: res.pageSize, traceId: readBy, startMs: from, endMs: to, windowClipped };
      let logs = res.logs;
      if (req.access) {
        try {
          logs = await req.access.keepReadable(['logs:read'], logs, (r) => ({ id: r.serviceId ?? '' }));
        } catch (err) {
          if (!(err instanceof ServiceLookupUnavailable)) throw err;
          return reply.send({ ...base, hasNext: false, logs: [], withheld: 0, reachable: false, error: err.message } satisfies TraceLogsResponse);
        }
      }
      // Filtered after OAP paged, so the count travels with the page: an empty
      // page of withheld lines is not a trace without logs.
      return reply.send({
        ...base,
        hasNext: res.hasNext,
        logs,
        withheld: res.logs.length - logs.length,
        reachable: res.reachable,
        ...(res.error ? { error: res.error } : {}),
      } satisfies TraceLogsResponse);
    },
  );

  // Log tag autocomplete lives in `trace-tag-routes.ts` under
  // /api/log-tags/{keys,values} — they wrap OAP's
  // `queryLogTagAutocomplete{Keys,Values}` GraphQL endpoints, the same
  // API booster-ui's ConditionTags uses. We co-located them with
  // trace-tags because the request/response shape is identical.
}
