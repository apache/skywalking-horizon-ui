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
 * `POST /api/layer/:key/landing` — top-N services for a layer with their
 * configured column metrics + whole-layer aggregates for the Overview
 * KPI strip tile.
 *
 * Body shape (subset of `LandingConfig` from the setup wire types):
 * ```
 *  {
 *    topN, orderBy, columns: LandingColumn[],
 *    spark?: { metric, height },
 *    throughput?: ThroughputConfig,
 *  }
 * ```
 *
 * One GraphQL trip lists services, a second batches per-service column
 * MQE values (one alias per service × column), a third optional trip
 * fetches the sparkline + throughput series for the surviving topN
 * rows. Errors anywhere in the MQE batch are local — failing cells
 * become `null`, the rest of the response stands.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type {
  AggregationKind,
  FetchLike,
  LandingAggregates,
  LandingResponse,
  LandingServiceRow,
} from '@skywalking-horizon-ui/api-client';
import type { ConfigSource } from '../../config/loader.js';
import type { SessionStore } from '../../user/sessions.js';
import { requireAuth } from '../../user/middleware.js';
import {  graphqlPost, buildOapOpts } from '../../client/graphql.js';
import { expressionForServiceMetricSeries } from '../../util/mqe-catalog.js';
import {
  defaultMinuteWindow,
  getServerOffsetMinutes,
  windowFromRange,
  type Window,
} from '../../util/window.js';

export interface LandingRouteDeps {
  config: ConfigSource;
  sessions: SessionStore;
  fetch?: FetchLike;
}

interface ListServicesRow {
  id: string;
  value: string;
  shortName?: string | null;
  group?: string | null;
  normal?: boolean | null;
}

interface MqeValuesShape {
  metric?: { labels?: Array<{ key: string; value: string }> | null };
  values?: Array<{ id?: string | null; value?: string | null }>;
}
interface MqeResultShape {
  type: string;
  error?: string | null;
  results?: MqeValuesShape[];
}

const LIST_SERVICES_QUERY = /* GraphQL */ `
  query LandingServices($layer: String!) {
    services: listServices(layer: $layer) {
      id
      value: name
      shortName
      group
      normal
    }
  }
`;

const DEFAULT_WINDOW_MIN = 60;
const SERVICE_QUERY_CAP = 25;

const aggSchema = z.enum(['sum', 'avg']);
const columnSchema = z.object({
  metric: z.string().min(1),
  label: z.string().min(1),
  tip: z.string().optional(),
  unit: z.string().optional(),
  mqe: z.string().optional(),
  aggregation: aggSchema.optional(),
  scale: z.number().finite().optional(),
  precision: z.number().int().min(0).max(6).optional(),
});
const throughputSchema = z.object({
  metric: z.string().min(1),
  label: z.string().optional(),
  unit: z.string().optional(),
  mqe: z.string().optional(),
  aggregation: aggSchema.optional(),
  scale: z.number().finite().optional(),
  precision: z.number().int().min(0).max(6).optional(),
});
const bodySchema = z.object({
  topN: z.number().int().min(1).max(8),
  orderBy: z.string().min(1),
  // Bumped from 5 to 10: Overview tile metrics are now self-contained
  // and threaded as synthetic columns in the same query as the
  // per-layer header columns. Up to 3 + 5 = 8 in the worst case; 10
  // gives headroom without making the BFF wide-open.
  columns: z.array(columnSchema).max(10),
  spark: z
    .object({ metric: z.string().min(1), height: z.number().int().positive() })
    .optional(),
  throughput: throughputSchema.optional(),
  // Topbar time picker — same triplet shape the dashboard route accepts.
  // When all three are present the BFF queries OAP at the requested
  // window/precision; otherwise it falls back to the last-hour MINUTE
  // window (DEFAULT_WINDOW_MIN). The Overview composable
  // (apps/ui/src/render/overview/useOverviewDashboard.ts) forwards
  // these so flipping the topbar Time / Cold pills actually changes
  // what the overview KPIs see.
  step: z.enum(['MINUTE', 'HOUR', 'DAY']).optional(),
  startMs: z.number().int().positive().optional(),
  endMs: z.number().int().positive().optional(),
});

/**
 * Pick the time-series expression to fire for `(metric, layer)`. We
 * always go through the series variant (`avg(...)` stripped) so OAP
 * returns TIME_SERIES_VALUES; the BFF then collapses to a scalar via
 * bucket-average. This way every metric supports a sparkline AND a
 * KPI cell from the same query — no double round-trip.
 *
 * Honors the operator's explicit `mqe` override when set; the override
 * is assumed to already be the desired shape (we don't try to strip avg
 * from custom expressions).
 */
function resolveMqe(metric: string, mqe: string | undefined, layerKey: string): string | null {
  if (mqe && mqe.trim().length > 0) return mqe.trim();
  return expressionForServiceMetricSeries(metric, layerKey);
}

/** Apply optional scale + precision to a raw MQE value. */
function postProcess(v: number | null, scale: number | undefined, precision: number | undefined): number | null {
  if (v === null || !Number.isFinite(v)) return null;
  let out = scale ? v * scale : v;
  if (precision !== undefined) {
    const factor = Math.pow(10, precision);
    out = Math.round(out * factor) / factor;
  }
  return out;
}

/**
 * Collapse a TIME_SERIES_VALUES MQE result to an ordered series, one
 * bucket per `step` slot. Non-numeric / null values become `null`.
 */
function collapseToSeries(r: MqeResultShape | undefined): Array<number | null> | null {
  if (!r || r.error) return null;
  const values = r.results?.[0]?.values ?? [];
  if (values.length === 0) return null;
  return values.map((v) => {
    if (v.value === null || v.value === undefined) return null;
    const n = Number(v.value);
    return Number.isFinite(n) ? n : null;
  });
}

/**
 * Collapse to a single scalar (avg of non-null bucket values). MQE with
 * `step: MINUTE` over 15m typically returns ~15 buckets — averaging
 * matches what booster-ui's KPI tiles do.
 */
function collapseToScalar(r: MqeResultShape | undefined): number | null {
  const series = collapseToSeries(r);
  if (!series) return null;
  const ns = series.filter((x): x is number => x !== null);
  if (ns.length === 0) return null;
  return ns.reduce((a, b) => a + b, 0) / ns.length;
}

/** Apply the operator's chosen aggregation across the topN rows for one metric. */
function aggregate(values: Array<number | null>, kind: AggregationKind): number | null {
  const finite = values.filter((v): v is number => v !== null && Number.isFinite(v));
  if (finite.length === 0) return null;
  const sum = finite.reduce((a, b) => a + b, 0);
  return kind === 'avg' ? sum / finite.length : sum;
}

/** Same idea but point-by-point across multiple sparkline series. */
function aggregateSeries(
  serieses: Array<Array<number | null> | undefined>,
  kind: AggregationKind,
): Array<number | null> | null {
  const real = serieses.filter((s): s is Array<number | null> => Array.isArray(s) && s.length > 0);
  if (real.length === 0) return null;
  const len = Math.max(...real.map((s) => s.length));
  const out: Array<number | null> = [];
  for (let i = 0; i < len; i++) {
    const pts = real
      .map((s) => s[i])
      .filter((v): v is number => v !== null && v !== undefined && Number.isFinite(v));
    if (pts.length === 0) {
      out.push(null);
    } else {
      const sum = pts.reduce((a, b) => a + b, 0);
      out.push(kind === 'avg' ? sum / pts.length : sum);
    }
  }
  return out;
}

function alias(serviceIdx: number, columnIdx: number): string {
  return `r${serviceIdx}_c${columnIdx}`;
}

interface MqeRequest {
  expression: string;
  serviceName: string;
  normal: boolean;
}

function buildMqeFragment(aliasName: string, m: MqeRequest, w: Window, coldStage: boolean): string {
  const coldFrag = coldStage ? ', coldStage: true' : '';
  return (
    `${aliasName}: execExpression(\n` +
    `      expression: ${JSON.stringify(m.expression)},\n` +
    `      entity: { scope: Service, serviceName: ${JSON.stringify(m.serviceName)}, normal: ${m.normal ? 'true' : 'false'} },\n` +
    `      duration: { start: ${JSON.stringify(w.start)}, end: ${JSON.stringify(w.end)}, step: ${w.step}${coldFrag} }\n` +
    `    ) { type error results { values { value } } }`
  );
}

export function registerLandingRoute(app: FastifyInstance, deps: LandingRouteDeps): void {
  const auth = requireAuth(deps);
  app.post(
    '/api/layer/:key/landing',
    { preHandler: auth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const params = req.params as { key: string };
      const layerKey = params.key;
      if (!layerKey || !/^[a-z0-9_]+$/i.test(layerKey)) {
        return reply.code(400).send({ error: 'invalid_layer_key' });
      }
      const parsed = bodySchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_body', detail: parsed.error.flatten() });
      }
      const cfg = parsed.data;
      const oapLayer = layerKey.toUpperCase();
      const cfgCurrent = deps.config.current;
      const opts = buildOapOpts(cfgCurrent, deps.fetch);
      const offset = await getServerOffsetMinutes(deps.config, deps.fetch);
      // Honor the SPA's topbar time picker when all three triplet fields
      // are present; otherwise fall back to the last-hour MINUTE window
      // (legacy callers + the BFF's own service-count probes).
      const window =
        cfg.step && cfg.startMs && cfg.endMs
          ? windowFromRange(cfg.step, cfg.startMs, cfg.endMs, offset) ??
            defaultMinuteWindow(offset, DEFAULT_WINDOW_MIN)
          : defaultMinuteWindow(offset, DEFAULT_WINDOW_MIN);

      // Step 1 — service list.
      let services: ListServicesRow[];
      try {
        const data = await graphqlPost<{ services: ListServicesRow[] }>(
          opts,
          LIST_SERVICES_QUERY,
          { layer: oapLayer },
        );
        services = data.services ?? [];
      } catch (err) {
        const body: LandingResponse = {
          layer: layerKey,
          topN: cfg.topN,
          orderBy: cfg.orderBy,
          generatedAt: Date.now(),
          step: window.step,
          durationStart: window.start,
          durationEnd: window.end,
          rows: [],
          aggregates: { serviceCount: 0, metrics: {}, seriesByMetric: {} },
          reachable: false,
          error: err instanceof Error ? err.message : String(err),
        };
        return reply.send(body);
      }

      const totalServiceCount = services.length;
      // Only short-circuit when the layer truly has no services — empty
      // `columns` still needs to flow through so the response carries
      // the service-list rows (with empty `metrics` objects). Without
      // those rows the SPA can't resolve `serviceName` from
      // `?service=<id>` and every downstream widget query stays gated
      // on `service.value` being truthy and never fires. This bit the
      // so11y_* layers when their header columns were intentionally
      // empty (their meters are SERVICE_INSTANCE-only — see
      // CLAUDE.md "Metric entity-scope validation").
      if (services.length === 0) {
        const body: LandingResponse = {
          layer: layerKey,
          topN: cfg.topN,
          orderBy: cfg.orderBy,
          generatedAt: Date.now(),
          step: window.step,
          durationStart: window.start,
          durationEnd: window.end,
          rows: [],
          aggregates: { serviceCount: 0, metrics: {}, seriesByMetric: {} },
          reachable: true,
        };
        return reply.send(body);
      }

      // Step 2 — resolve MQE expressions per column.
      const sampled = services.slice(0, SERVICE_QUERY_CAP);
      const resolved = cfg.columns.map((c) => ({
        column: c,
        expression: resolveMqe(c.metric, c.mqe, layerKey),
      }));

      const coldStage = !!req.coldStage;
      // Chunk services × columns into batches of N services per
      // round-trip, fired in parallel. OAP's GraphQL server enforces a
      // per-request complexity ceiling — same reason the dashboard route
      // pins at 6 widgets per trip (see dashboard.ts:555). A 25-service
      // × 10-column landing in one batch is 250 fragments and reliably
      // 5xx'd on busy backends, blanking every cell. Chunked +
      // Promise.all keeps wall-clock close to a single round-trip.
      const MAX_SERVICES_PER_BATCH = 6;
      const serviceChunks: { svc: (typeof sampled)[number]; sIdx: number }[][] = [];
      for (let i = 0; i < sampled.length; i += MAX_SERVICES_PER_BATCH) {
        serviceChunks.push(
          sampled.slice(i, i + MAX_SERVICES_PER_BATCH).map((svc, idxInChunk) => ({
            svc,
            sIdx: i + idxInChunk,
          })),
        );
      }
      let mqeData: Record<string, MqeResultShape> = {};
      if (sampled.length > 0 && resolved.some((r) => !!r.expression)) {
        try {
          const chunkResults = await Promise.all(
            serviceChunks.map(async (chunk) => {
              const fragments: string[] = [];
              for (const { svc, sIdx } of chunk) {
                resolved.forEach(({ expression }, cIdx) => {
                  if (!expression) return;
                  fragments.push(
                    buildMqeFragment(
                      alias(sIdx, cIdx),
                      { expression, serviceName: svc.value, normal: svc.normal !== false },
                      window,
                      coldStage,
                    ),
                  );
                });
              }
              if (fragments.length === 0) return {} as Record<string, MqeResultShape>;
              const query = `query LandingMqe { ${fragments.join('\n    ')} }`;
              return graphqlPost<Record<string, MqeResultShape>>(opts, query);
            }),
          );
          for (const chunk of chunkResults) Object.assign(mqeData, chunk);
        } catch {
          mqeData = {};
        }
      }

      // Step 3 — assemble per-row metrics + retain the per-bucket
      // series so the layer header can render a sparkline under each
      // KPI (aggregated point-wise across topN below).
      const seriesByServiceMetric = new Map<string, Map<string, Array<number | null>>>();
      const rows: LandingServiceRow[] = sampled.map((svc, sIdx) => {
        const metrics: Record<string, number | null> = {};
        const seriesMap = new Map<string, Array<number | null>>();
        resolved.forEach(({ column }, cIdx) => {
          const raw = mqeData[alias(sIdx, cIdx)];
          const series = collapseToSeries(raw);
          if (series) {
            seriesMap.set(
              column.metric,
              series.map((v) => postProcess(v, column.scale, column.precision)),
            );
          }
          metrics[column.metric] = postProcess(
            collapseToScalar(raw),
            column.scale,
            column.precision,
          );
        });
        seriesByServiceMetric.set(svc.id, seriesMap);
        return {
          serviceId: svc.id,
          serviceName: svc.value,
          ...(svc.shortName ? { shortName: svc.shortName } : {}),
          ...(svc.group ? { group: svc.group } : {}),
          metrics,
        };
      });

      // Step 4 — sort + slice.
      rows.sort((a, b) => {
        const av = a.metrics[cfg.orderBy];
        const bv = b.metrics[cfg.orderBy];
        if (av == null && bv == null) return a.serviceName.localeCompare(b.serviceName);
        if (av == null) return 1;
        if (bv == null) return -1;
        return bv - av;
      });
      const topRows = rows.slice(0, cfg.topN);

      // Step 5 — sparkline + throughput series for the surviving topN.
      const sparkExpr = cfg.spark ? resolveMqe(cfg.spark.metric, undefined, layerKey) : null;
      const throughputCol = cfg.throughput;
      const throughputExpr = throughputCol
        ? resolveMqe(throughputCol.metric, throughputCol.mqe, layerKey)
        : null;

      // The throughput tile reuses one MQE call per surviving row — but
      // only when it's a different expression than the column already
      // fetched. Most setups will pick throughput = orderBy, so we just
      // reuse `rows` values in that case.
      const sparkSeriesByRow = new Map<number, Array<number | null>>();
      const throughputSeriesByRow = new Map<number, Array<number | null>>();

      if ((sparkExpr || throughputExpr) && topRows.length > 0) {
        const sparkFragments: string[] = [];
        topRows.forEach((row, i) => {
          const svc = sampled.find((s) => s.id === row.serviceId);
          if (!svc) return;
          const r: MqeRequest = { expression: '', serviceName: svc.value, normal: svc.normal !== false };
          if (sparkExpr) {
            sparkFragments.push(buildMqeFragment(`s${i}`, { ...r, expression: sparkExpr }, window, coldStage));
          }
          if (throughputExpr && throughputExpr !== sparkExpr) {
            sparkFragments.push(buildMqeFragment(`t${i}`, { ...r, expression: throughputExpr }, window, coldStage));
          }
        });
        if (sparkFragments.length > 0) {
          const sparkQuery = `query LandingSpark { ${sparkFragments.join('\n    ')} }`;
          try {
            const sparkData = await graphqlPost<Record<string, MqeResultShape>>(opts, sparkQuery);
            topRows.forEach((row, i) => {
              const sk = sparkExpr ? collapseToSeries(sparkData[`s${i}`]) : null;
              if (sk && cfg.spark) {
                // Spark inherits the orderBy column's scale/precision if
                // we have a matching column; otherwise raw.
                const matchedCol = cfg.columns.find((c) => c.metric === cfg.spark!.metric);
                const scaled = sk.map((v) =>
                  postProcess(v, matchedCol?.scale, matchedCol?.precision),
                );
                row.spark = scaled;
                sparkSeriesByRow.set(i, scaled);
              }
              if (throughputExpr) {
                const series =
                  throughputExpr === sparkExpr
                    ? sk
                    : collapseToSeries(sparkData[`t${i}`]);
                if (series) {
                  const scaled = series.map((v) =>
                    postProcess(v, throughputCol?.scale, throughputCol?.precision),
                  );
                  throughputSeriesByRow.set(i, scaled);
                }
              }
            });
          } catch {
            // Soft-fail: leave spark / throughput-spark empty.
          }
        }
      }

      // Step 6 — aggregates for the KPI tile.
      const aggregates: LandingAggregates = {
        serviceCount: totalServiceCount,
        metrics: {},
        seriesByMetric: {},
      };
      for (const col of cfg.columns) {
        const kind: AggregationKind = col.aggregation ?? 'avg';
        aggregates.metrics[col.metric] = aggregate(
          topRows.map((r) => r.metrics[col.metric] ?? null),
          kind,
        );
        // Per-column aggregated time series — derived from the per-service
        // series we retained in step 3, aggregated point-wise.
        const colSeries = topRows.map(
          (r) => seriesByServiceMetric.get(r.serviceId)?.get(col.metric),
        );
        const agg = aggregateSeries(colSeries, kind);
        if (agg) aggregates.seriesByMetric[col.metric] = agg;
      }
      if (throughputCol) {
        const kind: AggregationKind = throughputCol.aggregation ?? 'sum';
        // Value: either reuse the per-row column value (when throughput
        // matches a column) or compute it now from the throughput series.
        const matchingCol = cfg.columns.find((c) => c.metric === throughputCol.metric);
        const values = matchingCol
          ? topRows.map((r) => r.metrics[throughputCol.metric] ?? null)
          : topRows.map((_, i) => {
              const series = throughputSeriesByRow.get(i);
              if (!series) return null;
              const finite = series.filter((v): v is number => v !== null);
              if (finite.length === 0) return null;
              return finite.reduce((a, b) => a + b, 0) / finite.length;
            });
        aggregates.throughputMetric = throughputCol.metric;
        aggregates.throughputValue = aggregate(values, kind);
        const seriesList = topRows.map((_, i) => throughputSeriesByRow.get(i));
        aggregates.spark = aggregateSeries(seriesList, kind);
      } else if (cfg.spark) {
        // No throughput configured — surface the spark metric's aggregated
        // series as a fallback so the KPI tile still has a trend line.
        const kind: AggregationKind = 'avg';
        const seriesList = topRows.map((_, i) => sparkSeriesByRow.get(i));
        aggregates.spark = aggregateSeries(seriesList, kind);
      }

      const body: LandingResponse = {
        layer: layerKey,
        topN: cfg.topN,
        orderBy: cfg.orderBy,
        generatedAt: Date.now(),
        step: window.step,
        durationStart: window.start,
        durationEnd: window.end,
        rows: topRows,
        // `rows` is already sorted desc by orderBy and sliced to topN;
        // `sampledRows` is the full set the BFF probed (post-sort), so
        // per-layer views can render the long tail without a second call.
        sampledRows: rows,
        aggregates,
        reachable: true,
      };
      return reply.send(body);
    },
  );
}
