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
 *  }
 * ```
 *
 * One GraphQL trip lists services, a second batches per-service column
 * MQE values (one alias per service × column). Errors anywhere in the
 * MQE batch are local — failing cells become `null`, the rest of the
 * response stands.
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
// Services × columns are chunked into batches of N services per OAP
// round-trip — OAP enforces a per-request GraphQL complexity ceiling, so a
// 25×10 single batch reliably 5xx'd busy backends and blanked every cell.
// The batches then drain through a bounded-concurrency pool so a large
// layer fans out in controlled waves, not a thundering herd. The number of
// services probed per request is itself bounded by `query.landingServiceCap`.
const MAX_SERVICES_PER_BATCH = 6;
const LANDING_BATCH_CONCURRENCY = 8;

/** Run `fn` over `items` with at most `limit` promises in flight at once. */
async function mapPool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        await fn(items[i]);
      }
    }),
  );
}

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
const bodySchema = z.object({
  topN: z.number().int().min(1).max(8),
  orderBy: z.string().min(1),
  // Bumped from 5 to 10: Overview tile metrics are now self-contained
  // and threaded as synthetic columns in the same query as the
  // per-layer header columns. Up to 3 + 5 = 8 in the worst case; 10
  // gives headroom without making the BFF wide-open.
  columns: z.array(columnSchema).max(10),
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
      const resolved = cfg.columns.map((c) => ({
        column: c,
        expression: resolveMqe(c.metric, c.mqe, layerKey),
      }));
      const coldStage = !!req.coldStage;

      // Probe `cols` for every service in `svcList`, chunked into
      // per-request batches and drained through the bounded pool. Keyed by
      // `${serviceId}#${colIdx}` so the row assembly reads back by id, not
      // by a fragile global index. Per-batch failures are local — those
      // cells just stay empty.
      const probeColumns = async (
        svcList: typeof services,
        cols: typeof resolved,
      ): Promise<Map<string, MqeResultShape>> => {
        const out = new Map<string, MqeResultShape>();
        if (svcList.length === 0 || !cols.some((c) => !!c.expression)) return out;
        const chunks: (typeof svcList)[] = [];
        for (let i = 0; i < svcList.length; i += MAX_SERVICES_PER_BATCH) {
          chunks.push(svcList.slice(i, i + MAX_SERVICES_PER_BATCH));
        }
        await mapPool(chunks, LANDING_BATCH_CONCURRENCY, async (batch) => {
          const fragments: string[] = [];
          const back: { a: string; key: string }[] = [];
          batch.forEach((svc, li) => {
            cols.forEach(({ expression }, ci) => {
              if (!expression) return;
              const a = `s${li}c${ci}`;
              back.push({ a, key: `${svc.id}#${ci}` });
              fragments.push(
                buildMqeFragment(
                  a,
                  { expression, serviceName: svc.value, normal: svc.normal !== false },
                  window,
                  coldStage,
                ),
              );
            });
          });
          if (fragments.length === 0) return;
          try {
            const data = await graphqlPost<Record<string, MqeResultShape>>(
              opts,
              `query LandingMqe { ${fragments.join('\n    ')} }`,
            );
            for (const { a, key } of back) {
              if (data[a] !== undefined) out.set(key, data[a]);
            }
          } catch {
            /* batch-local failure → leave those cells empty */
          }
        });
        return out;
      };

      // Bound the column fan-out to `landingServiceCap` services. The
      // landing lists ALL services; when a layer exceeds the cap we run a
      // cheap single-metric ranking pass (the `orderBy` column over every
      // service) to pick the TRUE top-`cap`, then fetch the full columns for
      // just those. At or under the cap we probe everyone directly. The UI
      // surfaces "top N of M" so the trim is never silent.
      const cap = deps.config.current.query.landingServiceCap;
      let sampled = services;
      if (totalServiceCount > cap) {
        const orderByCol = resolved.find((r) => r.column.metric === cfg.orderBy && r.expression);
        if (orderByCol) {
          const ranked = await probeColumns(services, [orderByCol]);
          const scored = services.map((svc) => ({ svc, v: collapseToScalar(ranked.get(`${svc.id}#0`)) }));
          scored.sort((a, b) => {
            if (a.v == null && b.v == null) return 0;
            if (a.v == null) return 1;
            if (b.v == null) return -1;
            return b.v - a.v;
          });
          sampled = scored.slice(0, cap).map((x) => x.svc);
        } else {
          // No orderBy column to rank by — fall back to the first `cap`.
          sampled = services.slice(0, cap);
        }
      }
      const probed = await probeColumns(sampled, resolved);

      // Step 3 — assemble per-row metrics + retain the per-bucket
      // series so the layer header can render a sparkline under each
      // KPI (aggregated point-wise across topN below).
      const seriesByServiceMetric = new Map<string, Map<string, Array<number | null>>>();
      const rows: LandingServiceRow[] = sampled.map((svc) => {
        const metrics: Record<string, number | null> = {};
        const seriesMap = new Map<string, Array<number | null>>();
        resolved.forEach(({ column }, cIdx) => {
          const raw = probed.get(`${svc.id}#${cIdx}`);
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

      // Step 5 — aggregates for the KPI tile. Each header column becomes a
      // KPI: a point value (sum/avg across the topN per the column's
      // `aggregation`) plus the point-wise aggregated series the header
      // renders as a trend line beneath it.
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
