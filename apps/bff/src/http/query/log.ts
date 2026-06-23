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
 * We accept a `service` name on the body so the SPA doesn't have to
 * pre-resolve names → ids; mirror of the topology + endpoint feeds.
 *
 * Returns at most one page of logs plus the OAP-reported total so
 * the UI's "page N of M" + density histogram can scope correctly.
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
} from '@skywalking-horizon-ui/api-client';
import type { ConfigSource } from '../../config/loader.js';
import type { SessionStore } from '../../user/sessions.js';
import { requireAuth } from '../../user/middleware.js';
import {  graphqlPost, buildOapOpts, type GraphqlOptions } from '../../client/graphql.js';
import { withColdStage } from '../../util/duration.js';
import { fmtSecond, getServerOffsetMinutes } from '../../util/window.js';

export interface LogRouteDeps {
  config: ConfigSource;
  sessions: SessionStore;
  fetch?: FetchLike;
}

const DEFAULT_WINDOW_MIN = 30;
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
 *  Three input shapes:
 *    - explicit MINUTE form `YYYY-MM-DD HHmm` (legacy UI custom-range) —
 *      padded to seconds with `00`. The UI emits these in its current TZ;
 *      OAP reads them in OAP-TZ. (Same convention as booster-ui.)
 *    - explicit SECOND form `YYYY-MM-DD HHmmss` — forwarded verbatim.
 *    - no explicit form → rolling fallback, formatted OAP-local at
 *      SECOND precision using the cached server offset. */
function defaultWindow(
  offsetMinutes: number,
  minutes?: number,
  explicit?: { startTime?: string; endTime?: string },
): { start: string; end: string } {
  if (explicit?.startTime && explicit.endTime) {
    return { start: toSecond(explicit.startTime), end: toSecond(explicit.endTime) };
  }
  const m = Number.isFinite(minutes) && (minutes as number) > 0
    ? Math.min(60 * 24 * 7, Math.round(minutes as number))
    : DEFAULT_WINDOW_MIN;
  const endMs = Date.now();
  const startMs = endMs - m * 60_000;
  return { start: fmtSecond(startMs, offsetMinutes), end: fmtSecond(endMs, offsetMinutes) };
}

function toSecond(s: string): string {
  // Pad MINUTE-precision strings ("YYYY-MM-DD HHmm") to seconds. Pass
  // SECOND-precision strings through unchanged.
  return /\s\d{4}$/.test(s) ? `${s}00` : s;
}

const LIST_SERVICES_FOR_RESOLVE = /* GraphQL */ `
  query ListServicesForLogs($layer: String!) {
    services: listServices(layer: $layer) {
      id
      name
    }
  }
`;

const QUERY_LOGS = /* GraphQL */ `
  query QueryLogs($condition: LogQueryCondition) {
    data: queryLogs(condition: $condition) {
      logs {
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
        tags { key value }
      }
    }
  }
`;
// OAP's `Logs.total` field was removed in newer query-protocol
// versions (>=10.x — the paging model went cursor-based and the
// caller computes total client-side). We don't ask for it anymore;
// the response handler falls back to `logs.length` for the pagination
// hint, which is what booster-ui does now.

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
  keywordsOfContent?: string[];
  tags?: LogTagFilter[];
}

/** Run OAP's `queryLogs(LogQueryCondition)` for a pre-resolved scope +
 *  SECOND-precision window + page, and map the rows to {@link LogRow}.
 *  Shared by the per-layer Logs route and the cross-layer Log inspect
 *  branch. Soft-fails to `reachable: false` on any OAP error. */
export async function fetchLogs(
  opts: GraphqlOptions,
  scope: LogFetchScope,
  window: { start: string; end: string },
  paging: { pageNum: number; pageSize: number },
  coldStage: boolean,
): Promise<LogsResponse> {
  const condition = {
    ...(scope.serviceId ? { serviceId: scope.serviceId } : {}),
    ...(scope.serviceInstanceId ? { serviceInstanceId: scope.serviceInstanceId } : {}),
    ...(scope.endpointId ? { endpointId: scope.endpointId } : {}),
    ...(scope.traceId ? { relatedTrace: { traceId: scope.traceId } } : {}),
    ...(scope.keywordsOfContent && scope.keywordsOfContent.length > 0
      ? { keywordsOfContent: scope.keywordsOfContent }
      : {}),
    ...(scope.tags && scope.tags.length > 0 ? { tags: scope.tags } : {}),
    queryDuration: {
      start: window.start,
      end: window.end,
      step: 'SECOND',
      ...(coldStage ? { coldStage: true } : {}),
    },
    paging,
  };
  try {
    const env = await graphqlPost<{ data: { logs: OapLogRow[] } }>(opts, QUERY_LOGS, { condition });
    const logs = (env.data?.logs ?? []).map(mapLogRow);
    return { generatedAt: Date.now(), query: {}, total: logs.length, logs, reachable: true };
  } catch (err) {
    return {
      generatedAt: Date.now(),
      query: {},
      total: 0,
      logs: [],
      reachable: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Resolve a service argument to an OAP service id. The arg can be
 * either a name (`mesh-svr::songs.sample-services`) or an id
 * (`bWVzaC1zdnI6OnNvbmdzLnNhbXBsZS1zZXJ2aWNlcw==.1`). OAP ids are
 * `<base64>.<digits>` — match strictly to avoid the previous bug
 * where a name containing `.` (e.g. `*.sample-services`) was wrongly
 * accepted as an id, leading to OAP returning empty / "service not
 * found" on the log query.
 */
const OAP_SERVICE_ID_RE = /^[A-Za-z0-9+/=]+\.\d+$/;
async function resolveServiceId(
  opts: GraphqlOptions,
  layer: string,
  serviceArg: string,
): Promise<string | null> {
  if (!serviceArg) return null;
  if (OAP_SERVICE_ID_RE.test(serviceArg)) return serviceArg;
  const data = await graphqlPost<{ services: Array<{ id: string; name: string }> }>(
    opts,
    LIST_SERVICES_FOR_RESOLVE,
    { layer: layer.toUpperCase() },
  );
  return (
    data.services.find((s) => s.name === serviceArg)?.id ??
    data.services.find((s) => s.id === serviceArg)?.id ??
    null
  );
}

interface LogBody extends LogQueryRequest {
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
        startTime: body.startTime,
        endTime: body.endTime,
      });

      // Resolve a service NAME to an id if the caller used one.
      let serviceId = body.serviceId ?? null;
      if (!serviceId && body.service) {
        try {
          serviceId = await resolveServiceId(opts, layerKey, body.service);
        } catch (err) {
          return reply.send({
            generatedAt: Date.now(),
            query: body,
            total: 0,
            logs: [],
            reachable: false,
            error: err instanceof Error ? err.message : String(err),
          } satisfies LogsResponse);
        }
      }
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
        {
          pageNum: Math.max(1, Math.round(body.page ?? 1)),
          pageSize: clampPageSize(body.pageSize, 50, deps.config.current.performance.limits.maxPageSize.logs),
        },
        !!req.coldStage,
      );
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
   * displayed page.
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
        startTime: body.startTime,
        endTime: body.endTime,
      });
      let serviceId = body.serviceId ?? null;
      if (!serviceId && body.service) {
        try {
          serviceId = await resolveServiceId(opts, layerKey, body.service);
        } catch (err) {
          return reply.send({
            generatedAt: Date.now(),
            total: 0,
            sampled: 0,
            level: { error: 0, warn: 0, info: 0, debug: 0, other: 0 },
            services: [],
            reachable: false,
            error: err instanceof Error ? err.message : String(err),
          } satisfies LogFacetsResponse);
        }
      }
      const condition = {
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
        paging: { pageNum: 1, pageSize: sampleSize },
      };

      try {
        const env = await graphqlPost<{
          data: { logs: OapLogRow[] };
        }>(opts, QUERY_LOGS, { condition });
        const rows = env.data?.logs ?? [];
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
          total: rows.length,
          sampled: rows.length,
          level,
          services,
          reachable: true,
        } satisfies LogFacetsResponse);
      } catch (err) {
        return reply.send({
          generatedAt: Date.now(),
          total: 0,
          sampled: 0,
          level: { error: 0, warn: 0, info: 0, debug: 0, other: 0 },
          services: [],
          reachable: false,
          error: err instanceof Error ? err.message : String(err),
        } satisfies LogFacetsResponse);
      }
    },
  );

  // Log tag autocomplete lives in `trace-tag-routes.ts` under
  // /api/log-tags/{keys,values} — they wrap OAP's
  // `queryLogTagAutocomplete{Keys,Values}` GraphQL endpoints, the same
  // API booster-ui's ConditionTags uses. We co-located them with
  // trace-tags because the request/response shape is identical.
}
