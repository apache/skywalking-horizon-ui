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
 * `POST /api/layer/:key/evaluation-records`
 *
 * Wraps OAP's `queryGenAIEvaluationRecord(GenAIEvaluationRecordQueryCondition)`. Body shape is the
 * `EvaluationRecordQueryRequest` from `@skywalking-horizon-ui/api-client`.
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
  EvaluationRecordFacetsResponse,
  EvaluationRecordQueryRequest,
  EvaluationRecordRow,
  EvaluationRecordsResponse,
  FetchLike,
  LogTagFilter,
} from '@skywalking-horizon-ui/api-client';
import type { ConfigSource } from '../../config/loader.js';
import type { SessionStore } from '../../user/sessions.js';
import { requireAuth } from '../../user/middleware.js';
import {  graphqlPost, buildOapOpts, type GraphqlOptions } from '../../client/graphql.js';
import { withColdStage } from '../../util/duration.js';
import { fmtSecond, getServerOffsetMinutes } from '../../util/window.js';

export interface EvaluationRecordRouteDeps {
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

const QUERY_EVALUATION_RECORDS = /* GraphQL */ `
  query QueryGenAIEvaluationRecords($evaluationRecordCondition: GenAIEvaluationRecordQueryCondition) {
    data: queryGenAIEvaluationRecord(condition: $evaluationRecordCondition) {
      genAIEvaluationRecordList {
        traceId
        serviceId
        serviceInstanceId
        segmentId
        spanId
        spanType
        taskName
        valueType
        value
        evaluationLevel
        reason
        judgeModel
        evaluationTime
      }
      errorReason
    }
  }
`;
// OAP's `Logs.total` field was removed in newer query-protocol
// versions (>=10.x — the paging model went cursor-based and the
// caller computes total client-side). We don't ask for it anymore;
// the response handler falls back to `logs.length` for the pagination
// hint, which is what booster-ui does now.

interface OapEvaluationRecordRow {
  traceId?: string | null;
  serviceId?: string | null;
  serviceInstanceId?: string | null;
  segmentId?: string | null;
  spanId?: string | null;
  spanType?: string | null;
  taskName?: string | null;
  valueType?: string | null;
  value?: string | null;
  evaluationLevel?: string | null;
  reason?: string | null;
  judgeModel?: string | null;
  evaluationTime?: number | null;
}

function mapEvaluationRecordRow(r: OapEvaluationRecordRow): EvaluationRecordRow {
  return {
    traceId: r.traceId ?? null,
    serviceId: r.serviceId ?? null,
    serviceInstanceId: r.serviceInstanceId ?? null,
    segmentId: r.segmentId ?? null,
    spanId: r.spanId ?? null,
    spanType: r.spanType ?? null,
    taskName: r.taskName ?? null,
    valueType: r.valueType ?? null,
    value: r.value ?? null,
    evaluationLevel: r.evaluationLevel ?? null,
    reason: r.reason ?? null,
    judgeModel: r.judgeModel ?? null,
    evaluationTime: r.evaluationTime ?? 0,
  };
}

/** Entity ids the log query scopes by — all PRE-RESOLVED by the caller
 *  (no `listServices(layer)` lookup, no name → id resolution). The
 *  per-layer route resolves a name first; explore forwards ids it
 *  already minted. */
export interface EvaluationRecordFetchScope {
  serviceId?: string | null;
  serviceInstanceId?: string | null;
  traceId?: string | null;
  tags?: LogTagFilter[];
}

/** Run OAP's `queryGenAIEvaluationRecord(GenAIEvaluationRecordQueryCondition)` for a pre-resolved scope +
 *  SECOND-precision window + page, and map the rows to evaluation records.
 *  Shared by the per-layer Logs route and the cross-layer Log inspect
 *  branch. Soft-fails to `reachable: false` on any OAP error. */
export async function fetchEvaluationRecords(
    opts: GraphqlOptions,
    scope: EvaluationRecordFetchScope,
    window: { start: string; end: string },
    paging: { pageNum: number; pageSize: number },
    coldStage: boolean,
): Promise<EvaluationRecordsResponse> {
  const evaluationRecordCondition = {
    ...(scope.serviceId ? { serviceId: scope.serviceId } : {}),
    ...(scope.serviceInstanceId ? { serviceInstanceId: scope.serviceInstanceId } : {}),
    ...(scope.traceId ? { relatedTrace: { traceId: scope.traceId } } : {}),
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
    const env = await graphqlPost<{
      data: {
        genAIEvaluationRecordList: OapEvaluationRecordRow[];
        errorReason?: string | null;
      } | null;
    }>(opts, QUERY_EVALUATION_RECORDS, { evaluationRecordCondition });
    const records = (env.data?.genAIEvaluationRecordList ?? []).map(mapEvaluationRecordRow);
    return {
      generatedAt: Date.now(),
      query: {},
      total: records.length,
      records,
      reachable: true,
      errorReason: env.data?.errorReason ?? undefined,
    };
  } catch (err) {
    return {
      generatedAt: Date.now(),
      query: {},
      total: 0,
      records: [],
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

interface EvaluationRecordBody extends EvaluationRecordQueryRequest {
  service?: string;
}

export function registerEvaluationRecordRoute(app: FastifyInstance, deps: EvaluationRecordRouteDeps): void {
  const auth = requireAuth(deps);
  app.post(
      '/api/layer/:key/evaluation-records',
      { preHandler: auth },
      async (req: FastifyRequest, reply: FastifyReply) => {
        const params = req.params as { key: string };
        const layerKey = params.key;
        if (!layerKey || !/^[a-z0-9_]+$/i.test(layerKey)) {
          return reply.code(400).send({ error: 'invalid_layer_key' });
        }
        const body = (req.body ?? {}) as EvaluationRecordBody;
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
              records: [],
              reachable: false,
              error: err instanceof Error ? err.message : String(err),
            } satisfies EvaluationRecordsResponse);
          }
        }
        const res = await fetchEvaluationRecords(
            opts,
            {
              serviceId,
              serviceInstanceId: body.serviceInstanceId,
              traceId: body.traceId,
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
        return reply.send({ ...res, query: body } satisfies EvaluationRecordsResponse);
      },
  );

  /**
   * POST /api/layer/:key/evaluation-records/facets
   *
   * Fetches a larger window-scoped sample (default 200 rows) just for
   * facet aggregation. The UI calls this in parallel with the page
   * fetch so the left-rail counts reflect the query window, not the
   * displayed page.
   */
  app.post(
      '/api/layer/:key/evaluation-records/facets',
      { preHandler: auth },
      async (req: FastifyRequest, reply: FastifyReply) => {
        const params = req.params as { key: string };
        const layerKey = params.key;
        if (!layerKey || !/^[a-z0-9_]+$/i.test(layerKey)) {
          return reply.code(400).send({ error: 'invalid_layer_key' });
        }
        const body = (req.body ?? {}) as EvaluationRecordBody & { sampleSize?: number };
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
              level: { fail: 0, warning: 0, good: 0, excellent: 0, undefined: 0 },
              services: [],
              reachable: false,
              error: err instanceof Error ? err.message : String(err),
            } satisfies EvaluationRecordFacetsResponse);
          }
        }
        const evaluationRecordCondition = {
          ...(serviceId ? { serviceId } : {}),
          ...(body.serviceInstanceId ? { serviceInstanceId: body.serviceInstanceId } : {}),
          ...(body.traceId ? { relatedTrace: { traceId: body.traceId } } : {}),
          // Facet sample intentionally ignores level/tag filters so the
          // counts show the unfiltered distribution; the user picks a
          // level from the breakdown.
          queryDuration: withColdStage(req, { start: window.start, end: window.end, step: 'SECOND' }),
          paging: { pageNum: 1, pageSize: sampleSize },
        };

        try {
          const env = await graphqlPost<{
            data: { genAIEvaluationRecordList: OapEvaluationRecordRow[] } | null;
          }>(opts, QUERY_EVALUATION_RECORDS, { evaluationRecordCondition });
          const rows = env.data?.genAIEvaluationRecordList ?? [];
          const level: EvaluationRecordFacetsResponse['level'] = {
            fail: 0,
            warning: 0,
            good: 0,
            excellent: 0,
            undefined: 0,
          };
          const svcMap = new Map<string, number>();
          for (const r of rows) {
            const raw = (r.evaluationLevel ?? '').toLowerCase();
            if (raw === 'fail') level.fail++;
            else if (raw === 'warning') level.warning++;
            else if (raw === 'good') level.good++;
            else if (raw === 'excellent') level.excellent++;
            else level.undefined++;
            const svc = r.serviceId ?? '(none)';
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
          } satisfies EvaluationRecordFacetsResponse);
        } catch (err) {
          return reply.send({
            generatedAt: Date.now(),
            total: 0,
            sampled: 0,
            level: { fail: 0, warning: 0, good: 0, excellent: 0, undefined: 0 },
            services: [],
            reachable: false,
            error: err instanceof Error ? err.message : String(err),
          } satisfies EvaluationRecordFacetsResponse);
        }
      },
  );

  // Log tag autocomplete lives in `trace-tag-routes.ts` under
  // /api/log-tags/{keys,values} — they wrap OAP's
  // `queryLogTagAutocomplete{Keys,Values}` GraphQL endpoints, the same
  // API booster-ui's ConditionTags uses. We co-located them with
  // trace-tags because the request/response shape is identical.
}
