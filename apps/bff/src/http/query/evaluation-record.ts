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
} from '@skywalking-horizon-ui/api-client';
import type { ConfigSource } from '../../config/loader.js';
import type { SessionStore } from '../../user/sessions.js';
import { requireAuth } from '../../user/middleware.js';
import {  graphqlPost, buildOapOpts, type GraphqlOptions } from '../../client/graphql.js';
import { withColdStage } from '../../util/duration.js';
import { fmtSecond, getServerOffsetMinutes } from '../../util/window.js';
import { readPage, type PagedQuerySpec } from '../../logic/paging/read-page.js';
import { serviceLayerCatalog } from '../../logic/services/service-layer-catalog.js';

export interface EvaluationRecordRouteDeps {
  config: ConfigSource;
  sessions: SessionStore;
  fetch?: FetchLike;
}

const DEFAULT_WINDOW_MIN = 30;
const SCORE_SCALE = 1_000_000;
const WINDOW_CAP_MS = 7 * 24 * 60 * 60_000;
/** OAP feeds `paging.pageSize` straight to its storage layer as a
 *  LIMIT clause. The cap is `performance.limits.maxPageSize.logs`
 *  (default 100); mirror that server-side so the cap holds against
 *  direct API callers. */
function clampPageSize(requested: number | undefined, fallback: number, max: number): number {
  if (!Number.isFinite(requested as number) || (requested as number) < 1) return fallback;
  return Math.min(max, Math.round(requested as number));
}

function optionalFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function scoreBoundToStoredValue(value: number | null, lowerBound: boolean): number | null {
  if (value == null) return null;
  const scaled = value * SCORE_SCALE;
  return lowerBound ? Math.ceil(scaled) : Math.floor(scaled);
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
function defaultWindow(offsetMinutes: number, minutes?: number, explicit?: { startTime?: number; endTime?: number }):
    { start: string; end: string } | { error: string } {
  const hasStart = explicit?.startTime != null;
  const hasEnd = explicit?.endTime != null;
  if (hasStart || hasEnd) {
    if (!hasStart || !hasEnd) return { error: 'startTime and endTime must be provided together' };
    const start = Number(explicit?.startTime);
    const end = Number(explicit?.endTime);
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      return { error: 'startTime and endTime must be epoch milliseconds' };
    }
    if (end <= start) return { error: 'endTime must be greater than startTime' };
    if (end - start > WINDOW_CAP_MS) return { error: 'time window cannot exceed 7 days' };
    return { start: fmtSecond(start, offsetMinutes), end: fmtSecond(end, offsetMinutes) };
  }
  const m = Number.isFinite(minutes) && (minutes as number) > 0
      ? Math.min(60 * 24 * 7, Math.round(minutes as number))
      : DEFAULT_WINDOW_MIN;
  const endMs = Date.now();
  const startMs = endMs - m * 60_000;
  return { start: fmtSecond(startMs, offsetMinutes), end: fmtSecond(endMs, offsetMinutes) };
}

const EVALUATION_RECORD_SELECTION = /* GraphQL */ `
        traceRef { type traceId segmentId spanIndex spanId }
        serviceId
        serviceName
        providerId
        providerName
        modelId
        modelName
        operationName
        scoreValue
        taskName
        valueType
        booleanValue
        stringValue
        evaluationLevel
        reason
        judgeModel
        evaluationTime
`;
const EVALUATION_RECORD_PAGE: PagedQuerySpec = {
  operationName: 'QueryGenAIEvaluationRecords',
  conditionType: 'GenAIEvaluationRecordQueryCondition',
  field: 'queryGenAIEvaluationRecord',
  rowsField: 'genAIEvaluationRecordList',
  rowsSelection: EVALUATION_RECORD_SELECTION,
  probeSelection: 'traceRef { traceId }',
};
const QUERY_EVALUATION_RECORD_FACETS = /* GraphQL */ `
  query QueryGenAIEvaluationRecordFacets($evaluationRecordCondition: GenAIEvaluationRecordQueryCondition) {
    data: queryGenAIEvaluationRecord(condition: $evaluationRecordCondition) {
      genAIEvaluationRecordList { ${EVALUATION_RECORD_SELECTION} }
    }
  }
`;
// OAP's `Logs.total` field was removed in newer query-protocol
// versions (>=10.x — the paging model went cursor-based and the
// caller computes total client-side). We don't ask for it anymore;
// the response handler falls back to `logs.length` for the pagination
// hint, which is what booster-ui does now.

interface OapEvaluationRecordRow {
  traceRef?: { type?: 'SKYWALKING_NATIVE' | 'OTLP'; traceId?: string | null; segmentId?: string | null; spanIndex?: number | null; spanId?: string | null } | null;
  serviceId?: string | null;
  serviceName?: string | null;
  providerId?: string | null;
  providerName?: string | null;
  modelId?: string | null;
  modelName?: string | null;
  operationName?: string | null;
  scoreValue?: number | null;
  booleanValue?: boolean | null;
  stringValue?: string | null;
  taskName?: string | null;
  valueType?: 'SCORE' | 'BOOLEAN' | 'STRING' | 'JSON' | null;
  evaluationLevel?: string | null;
  reason?: string | null;
  judgeModel?: string | null;
  evaluationTime?: number | null;
}

function mapEvaluationRecordRow(r: OapEvaluationRecordRow): EvaluationRecordRow {
  const traceRef = r.traceRef ? {
    type: r.traceRef.type ?? 'SKYWALKING_NATIVE',
    traceId: r.traceRef.traceId ?? '',
    segmentId: r.traceRef.segmentId ?? null,
    spanIndex: r.traceRef.spanIndex ?? null,
    spanId: r.traceRef.spanId ?? null,
  } : null;
  return {
    traceRef,
    traceId: traceRef?.traceId ?? null,
    serviceId: r.serviceId ?? null,
    serviceName: r.serviceName ?? null,
    providerId: r.providerId ?? null,
    providerName: r.providerName ?? null,
    modelId: r.modelId ?? null,
    modelName: r.modelName ?? null,
    operationName: r.operationName ?? null,
    scoreValue: r.scoreValue == null ? null : r.scoreValue / SCORE_SCALE,
    booleanValue: r.booleanValue ?? null,
    stringValue: r.stringValue ?? null,
    taskName: r.taskName ?? null,
    valueType: r.valueType ?? null,
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
  providerId?: string | null;
  modelId?: string | null;
  valueType?: 'SCORE' | 'BOOLEAN' | 'STRING' | 'JSON' | null;
  minScore?: number | null;
  maxScore?: number | null;
  booleanValue?: boolean | null;
  taskName?: string | null;
  evaluationLevel?: string | null;
  judgeModel?: string | null;
  sortField?: string | null;
  sortOrder?: 'ASC' | 'DES' | null;
  traceId?: string | null;
  traceType?: 'SKYWALKING_NATIVE' | 'OTLP' | null;
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
  const minScore = scope.valueType === 'SCORE'
    ? scoreBoundToStoredValue(optionalFiniteNumber(scope.minScore), true)
    : null;
  const maxScore = scope.valueType === 'SCORE'
    ? scoreBoundToStoredValue(optionalFiniteNumber(scope.maxScore), false)
    : null;
  const evaluationRecordCondition = (page: { pageNum: number; pageSize: number }) => ({
    ...(scope.serviceId ? { serviceId: scope.serviceId } : {}),
    ...(scope.providerId ? { providerId: scope.providerId } : {}),
    ...(scope.modelId ? { modelId: scope.modelId } : {}),
    ...(scope.valueType ? { valueType: scope.valueType } : {}),
    ...(minScore != null ? { minScore } : {}),
    ...(maxScore != null ? { maxScore } : {}),
    ...(scope.valueType === 'BOOLEAN' && scope.booleanValue != null ? { booleanValue: scope.booleanValue } : {}),
    ...(scope.taskName ? { taskName: scope.taskName } : {}),
    ...(scope.evaluationLevel ? { evaluationLevel: scope.evaluationLevel } : {}),
    ...(scope.judgeModel ? { judgeModel: scope.judgeModel } : {}),
    ...(scope.sortField ? { sortBy: scope.sortField } : {}),
    ...(scope.sortOrder ? { queryOrder: scope.sortOrder } : {}),
    ...(scope.traceId ? { relatedTrace: { type: scope.traceType ?? 'SKYWALKING_NATIVE', traceId: scope.traceId } } : {}),
    queryDuration: {
      start: window.start,
      end: window.end,
      step: 'SECOND',
      ...(coldStage ? { coldStage: true } : {}),
    },
    paging: page,
  });
  try {
    const page = await readPage<OapEvaluationRecordRow>(
      opts,
      EVALUATION_RECORD_PAGE,
      evaluationRecordCondition,
      paging,
    );
    const records = page.rows.map(mapEvaluationRecordRow);
    return {
      generatedAt: Date.now(),
      query: {},
      // OAP exposes page rows and a next-page probe, but no total count.
      // Do not present the current page length as a global total.
      total: null,
      records,
      reachable: true,
      hasNext: page.hasNext,
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
interface EvaluationRecordBody extends EvaluationRecordQueryRequest {
  service?: string;
  traceType?: 'SKYWALKING_NATIVE' | 'OTLP' | null;
}

export function registerEvaluationRecordRoute(app: FastifyInstance, deps: EvaluationRecordRouteDeps): void {
  const auth = requireAuth(deps);
  const catalog = serviceLayerCatalog({ config: deps.config, fetch: deps.fetch });
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
          startTime: body.startTime == null ? undefined : Number(body.startTime),
          endTime: body.endTime == null ? undefined : Number(body.endTime),
        });
        if ('error' in window) return reply.code(400).send({ error: window.error });

        let resolvedServiceId = body.serviceId ?? null;
        if (!resolvedServiceId && body.service) {
          const services = (await catalog.get()).byLayer.get(layerKey.toUpperCase()) ?? [];
          const match = services.find((s) => s.id === body.service || s.name === body.service);
          if (!match) return reply.code(400).send({ error: 'service not found in layer' });
          resolvedServiceId = match.id;
        }

        // Resolve a service NAME to an id if the caller used one.
        const res = await fetchEvaluationRecords(
            opts,
            {
              serviceId: resolvedServiceId,
              providerId: body.providerId,
              modelId: body.modelId,
              valueType: body.valueType,
              minScore: body.minScore,
              maxScore: body.maxScore,
              booleanValue: body.booleanValue,
              taskName: body.taskName,
              evaluationLevel: body.evaluationLevel,
              judgeModel: body.judgeModel,
              sortField: body.sortField,
              sortOrder: body.sortOrder,
              traceId: body.traceId,
              traceType: body.traceType,
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
          startTime: body.startTime == null ? undefined : Number(body.startTime),
          endTime: body.endTime == null ? undefined : Number(body.endTime),
        });
        if ('error' in window) return reply.code(400).send({ error: window.error });
        let resolvedServiceId = body.serviceId ?? null;
        if (!resolvedServiceId && body.service) {
          const services = (await catalog.get()).byLayer.get(layerKey.toUpperCase()) ?? [];
          const match = services.find((s) => s.id === body.service || s.name === body.service);
          if (!match) return reply.code(400).send({ error: 'service not found in layer' });
          resolvedServiceId = match.id;
        }
        const evaluationRecordCondition = {
          ...(resolvedServiceId ? { serviceId: resolvedServiceId } : {}),
          ...(body.providerId ? { providerId: body.providerId } : {}),
          ...(body.modelId ? { modelId: body.modelId } : {}),
          ...(body.valueType ? { valueType: body.valueType } : {}),
          ...(body.valueType === 'SCORE' && body.minScore != null
            ? { minScore: scoreBoundToStoredValue(Number(body.minScore), true) } : {}),
          ...(body.valueType === 'SCORE' && body.maxScore != null
            ? { maxScore: scoreBoundToStoredValue(Number(body.maxScore), false) } : {}),
          ...(body.valueType === 'BOOLEAN' && body.booleanValue != null ? { booleanValue: body.booleanValue } : {}),
          ...(body.taskName ? { taskName: body.taskName } : {}),
          ...(body.judgeModel ? { judgeModel: body.judgeModel } : {}),
          ...(body.traceId ? { relatedTrace: { type: body.traceType ?? 'SKYWALKING_NATIVE', traceId: body.traceId } } : {}),
          // Facet sample intentionally ignores level/tag filters so the
          // counts show the unfiltered distribution; the user picks a
          // level from the breakdown.
          queryDuration: withColdStage(req, { start: window.start, end: window.end, step: 'SECOND' }),
          paging: { pageNum: 1, pageSize: sampleSize },
        };

        try {
          const env = await graphqlPost<{
            data: { genAIEvaluationRecordList: OapEvaluationRecordRow[] } | null;
          }>(opts, QUERY_EVALUATION_RECORD_FACETS, { evaluationRecordCondition });
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
            level,
            services,
            reachable: true,
          } satisfies EvaluationRecordFacetsResponse);
        } catch (err) {
          return reply.send({
            generatedAt: Date.now(),
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
