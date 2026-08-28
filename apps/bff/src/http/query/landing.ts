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
import type { AuthDeps } from '../../user/middleware.js';
import { requireAuth } from '../../user/middleware.js';
import {  graphqlPost, buildOapOpts } from '../../client/graphql.js';
import { clientGone } from '../client-gone.js';
import { resolveEffectiveLayerTemplate } from '../../logic/layers/effective.js';
import type { UITemplateClient } from '@skywalking-horizon-ui/api-client';
import {
  bucketHasValues,
  getHeaderKpis,
  rankFromCache,
  type KpiRead,
  type ScanFn,
} from '../../logic/layers/header-kpi-cache.js';
import { expressionForServiceMetricSeries } from '../../util/mqe-catalog.js';
import {
  defaultMinuteWindow,
  getServerOffsetMinutes,
  windowFromRange,
  type Window,
} from '../../util/window.js';

export interface LandingRouteDeps extends AuthDeps {
  fetch?: FetchLike;
  /** Reads the layer's effective template, so the route can refuse a metric
   *  the template does not declare instead of fetching it. */
  uiTemplateClient?: () => UITemplateClient;
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
// Batch size + pool width are config-tunable via
// `performance.bulk.landing.{bulkSize,concurrency}` (read in the handler).

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
  unit: z.string().optional(),
  mqe: z.string().optional(),
  aggregation: aggSchema.optional(),
  scale: z.number().finite().optional(),
  precision: z.number().int().min(0).max(6).optional(),
  // Self-aggregating column: the `mqe` folds the layer to one scalar
  // server-side, so the BFF fires it once (no per-service fan-out).
  selfAggregate: z.boolean().optional(),
});
export const bodySchema = z.object({
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
  // Ask for the layer header's HOURLY figures instead of the window above.
  // Opt-in, and only the layer header sets it — it is the one screen that
  // renders the hour's label, so it is the one caller for which substituting a
  // different window is honest. See the cache gate below.
  hourlyKpi: z.boolean().optional(),
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

/** Fragment for a self-aggregating column — the MQE (`sum|avg(top_n(...))`)
 *  already rolls the whole layer up server-side, so the entity carries no
 *  `serviceName`: OAP's `top_n` ranks across every service of the scope.
 *
 *  `normal: true` is safe here even for the VIRTUAL_* layers whose services
 *  are `normal: false`: `top_n` is a cross-entity scan over the METRIC's own
 *  entities (`database_access_*` etc. belong only to virtual services), and
 *  it ignores the query entity's `normal` flag. Verified against the demo —
 *  `sum(top_n(database_access_cpm,100,DES))` returns the same value with
 *  `normal: true` and `normal: false`. (The flag only matters for a
 *  single-entity metric query that names one service.) */
function buildAggFragment(aliasName: string, expression: string, w: Window, coldStage: boolean): string {
  const coldFrag = coldStage ? ', coldStage: true' : '';
  return (
    `${aliasName}: execExpression(\n` +
    `      expression: ${JSON.stringify(expression)},\n` +
    `      entity: { scope: Service, normal: true },\n` +
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

      // The template is the boundary of what may be asked for.
      //
      // A column names a metric; the cache holds one value per (service,
      // metric) for exactly the metrics the layer declares. Accepting an
      // undeclared one would widen both the request and the cache by asking —
      // so it is refused, and refused rather than dropped, because a caller
      // that asked for a column and got a row without it cannot tell whether
      // the metric was rejected or the read failed.
      const tpl = await resolveEffectiveLayerTemplate(deps.uiTemplateClient, layerKey);
      // `layer-header` in the JSON; the parser renames it to `metrics`.
      const declared = tpl?.metrics?.columns;
      // A column that BRINGS its own MQE names the expression to evaluate. The
      // Overview is built that way — `w_0`, `w_1`… from its own widgets, which
      // no layer template declares and never will — so those pass through.
      //
      // A column with no expression has the BFF build one from the METRIC NAME,
      // and reporting a name this layer does not declare is worth doing: it is
      // almost always a typo or a stale client, and the alternative is a silent
      // column of dashes.
      //
      // It is NOT an authorization boundary. Whether a caller may query metrics
      // at all is the RBAC query verb's decision; this is template analysis, and
      // the same request may carry any `mqe` it likes without passing through
      // here. So it runs only where there is something to check against — a
      // layer whose template could not be read refuses nothing, since refusing
      // would cost real callers a working page during a template-store outage
      // and withhold nothing from anyone.
      // For an HOURLY request the template's values win, because they decide
      // the number rather than its presentation: `aggregation` picks sum or avg
      // for the rollup, and `orderBy` picks WHICH services are in the top-N that
      // gets rolled up. Trusting the caller for those would let two requests
      // read one cached hour and report different KPIs from it — and would make
      // "the template decides" false for the two fields that decide most.
      //
      // For everything else the caller's own values stand: it asked about its
      // own window and is not claiming to render this layer's header.
      const declaredByMetric = new Map((declared ?? []).map((c) => [c.metric, c]));
      if (cfg.hourlyKpi === true && declaredByMetric.size > 0) {
        cfg.columns = cfg.columns.map((c) => {
          const d = declaredByMetric.get(c.metric);
          return d ? { ...c, aggregation: d.aggregation ?? c.aggregation } : c;
        });
        const templateOrderBy = tpl?.metrics?.orderBy;
        if (templateOrderBy && declaredByMetric.has(templateOrderBy)) {
          cfg.orderBy = templateOrderBy;
        }
      }

      const namedOnly = cfg.columns.filter((c) => !c.mqe);
      if (Array.isArray(declared) && declared.length > 0 && namedOnly.length > 0) {
        const allowed = new Set(declared.map((c) => c.metric));
        const refused = namedOnly.map((c) => c.metric).filter((m) => !allowed.has(m));
        if (refused.length > 0) {
          return reply.code(400).send({ error: 'undeclared_metric', metrics: refused });
        }
      }
      const oapLayer = layerKey.toUpperCase();
      const cfgCurrent = deps.config.current;
      const { bulkSize: maxServicesPerBatch, concurrency: batchConcurrency } =
        cfgCurrent.performance.bulk.landing;
      const signal = clientGone(reply);
      const opts = buildOapOpts(cfgCurrent, deps.fetch, signal);
      // The hourly scan OUTLIVES the request that starts it: it is left running
      // so the next caller is served from it. Carrying this request's
      // cancellation would mean navigating away kills the work meant to warm
      // the page you navigate to, and the next request starts it over.
      const scanOpts = buildOapOpts(cfgCurrent, deps.fetch);
      const offset = await getServerOffsetMinutes(deps.config, deps.fetch, signal);
      // Honor the SPA's topbar time picker when all three triplet fields
      // are present; otherwise fall back to the last-hour MINUTE window
      // (legacy callers + the BFF's own service-count probes).
      const window =
        cfg.step && cfg.startMs && cfg.endMs
          ? windowFromRange(cfg.step, cfg.startMs, cfg.endMs, offset) ??
            defaultMinuteWindow(offset, DEFAULT_WINDOW_MIN)
          : defaultMinuteWindow(offset, DEFAULT_WINDOW_MIN);

      let services: ListServicesRow[];
      let layerRoster: ListServicesRow[] = [];
      try {
        const data = await graphqlPost<{ services: ListServicesRow[] }>(
          opts,
          LIST_SERVICES_QUERY,
          { layer: oapLayer },
        );
        services = data.services ?? [];
        // The LAYER's whole roster, before any narrowing. The hourly scan reads
        // this rather than the filtered list: the bucket is keyed by service id,
        // which is unique across the deployment, so one scan answers every
        // group. Scanning the narrowed list instead would fill the hour with
        // only the first group asked for, and every other group would read its
        // own services as absent for the rest of that hour.
        layerRoster = services;
        // Optional `?group=` (split-by-service-group menu entry) — narrow
        // the roster to that OAP Service.group before the top-N rollup.
        const group = (req.query as { group?: string }).group;
        if (group !== undefined) {
          services = services.filter((s) => ((s as { group?: string }).group ?? '') === group);
        }
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

      const coldStage = !!req.coldStage;

      // Split header columns by the caller's explicit `selfAggregate` flag.
      //  - self-aggregating columns fold the whole layer to one scalar
      //    server-side (`sum|avg(top_n(<metric>,{{topn}},DES[,attr0=…]))`);
      //    the BFF fires each ONCE globally. A per-service fan-out here would
      //    re-aggregate an already-aggregated number (the Overview `topN:1`
      //    bug). `{{topn}}` is substituted with `query.overviewTopN`.
      //  - every other column keeps the per-service fan-out + page-side topN
      //    rollup below (composite KPIs, the per-layer landing header). The
      //    flag is opt-in, so legacy callers stay on the fan-out path.
      const overviewTopN = deps.config.current.query.overviewTopN;
      const allResolved = cfg.columns.map((c) => ({
        column: c,
        expression: resolveMqe(c.metric, c.mqe, layerKey),
      }));
      const aggResolved = allResolved
        .filter((r) => r.column.selfAggregate === true && r.expression !== null)
        .map((r) => ({
          column: r.column,
          expression: (r.expression as string).replace(/\{\{\s*topn\s*\}\}/g, String(overviewTopN)),
        }));
      const resolved = allResolved.filter((r) => r.column.selfAggregate !== true);

      // How much of the metric fan-out could not be read.
      //
      // A batch failure used to be entirely silent: its cells stayed empty,
      // empty sorted as absent, and the response still said it succeeded. So a
      // single timeout could push the busiest services out of the top-N and
      // rename the layer's default service, with nothing on the wire to say the
      // ranking had been decided on partial information.
      /** This request's own fan-out ledger: batches attempted, batches lost,
       *  and the services those lost batches left UNREAD.
       *
       *  Unread is not the same as idle, and the distinction is the whole
       *  point: absent means zero, unread means we do not know. Ranking an
       *  unread service as though it reported nothing is a claim about the
       *  operator's system made from a failure to measure it. */
      const requestAcct = { total: 0, failed: 0, unread: new Set<string>() };

      // Probe `cols` for every service in `svcList`, chunked into
      // per-request batches and drained through the bounded pool. Keyed by
      // `${serviceId}#${colIdx}` so the row assembly reads back by id, not
      // by a fragile global index.
      const probeColumns = async (
        svcList: typeof services,
        cols: typeof resolved,
        /** Overrides the request's window. The hourly KPI scan asks for its own
         *  completed hour rather than whatever the topbar currently shows. */
        windowOverride?: Window,
        /** Where to charge this fan-out. Defaults to the request's own ledger.
         *  The hourly scan passes its own, because it OUTLIVES the request that
         *  started it: a scan still running while that request assembles its
         *  reply would otherwise be adding to — and, on the stale-fallback path,
         *  overwriting — counters the reply is about to read. */
        acct: { total: number; failed: number; unread: Set<string> } = requestAcct,
        /** Which storage stage to read. Defaults to what the request asked for.
         *
         *  The hourly scan passes `false` — always hot. The hour it holds is a
         *  property of the layer, not of the pill a particular operator happens
         *  to have on, and one cache keyed by layer cannot hold two answers for
         *  the same hour. Reading hot keeps it one answer, and the header is
         *  the one place a cold read buys nothing anyway: a completed hour that
         *  is minutes old has not aged into cold storage. */
        stage: boolean = coldStage,
        /** Which OAP options — i.e. whose cancellation — this fan-out runs
         *  under. The hourly scan passes `scanOpts`, which carries none. */
        oapOpts: typeof opts = opts,
      ): Promise<Map<string, MqeResultShape>> => {
        const w = windowOverride ?? window;
        const out = new Map<string, MqeResultShape>();
        if (svcList.length === 0 || !cols.some((c) => !!c.expression)) return out;
        const chunks: (typeof svcList)[] = [];
        for (let i = 0; i < svcList.length; i += maxServicesPerBatch) {
          chunks.push(svcList.slice(i, i + maxServicesPerBatch));
        }
        acct.total += chunks.length;
        await mapPool(chunks, batchConcurrency, async (batch) => {
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
                  w,
                  stage,
                ),
              );
            });
          });
          if (fragments.length === 0) return;
          try {
            const data = await graphqlPost<Record<string, MqeResultShape>>(
              oapOpts,
              `query LandingMqe { ${fragments.join('\n    ')} }`,
            );
            for (const { a, key } of back) {
              if (data[a] !== undefined) out.set(key, data[a]);
            }
          } catch {
            // Batch-local failure. Those cells stay empty — but remember WHICH
            // services they were, because an unread metric is not a low one and
            // must not be ranked as though it were. See the ledger above.
            acct.failed++;
            for (const svc of batch) acct.unread.add(svc.id);
          }
        });
        return out;
      };

      // The header's values come from the hourly cache, not from this request.
      //
      // Ranking used to be the expensive half: to find the top `cap` we read
      // the sort metric for EVERY service, which at `bulkSize: 6` is hundreds
      // of requests on a large layer, repeated every refresh, for numbers that
      // describe an hour. The cache holds one completed hour's scalar per
      // (service, metric) — the same bulk fan-out, run once per layer per hour
      // over that hour — so ranking is now a sort in memory and costs nothing.
      //
      // `null` means the cache has neither the hour nor one before it and the
      // scan outran its bound. The header shows a dash rather than the page
      // hanging on a first visit to a large layer.
      const cap = deps.config.current.query.landingServiceCap;

      // WHAT may be cached: the header's KPI metrics, and nothing else.
      //
      // This is not a general metric cache — it holds ONE completed hour for
      // the KPI strip at the top of a layer, so the only expressions that may
      // enter it are the ones the layer template declares under
      // `layer-header.columns`. Anything outside that set takes the live
      // fan-out below.
      //
      // The whitelist is a set of (MQE, entity) pairs and does not ask who is
      // calling. A column's name is the caller's own — the Overview calls
      // `service_cpm` "w_0" — so keying on the name would both miss the match
      // and let two different expressions collide under one familiar label.
      // Keyed on what was actually evaluated, the answer is the same value for
      // whoever asks, and a column whose MQE was overridden in setup simply
      // falls outside the set instead of quietly collecting numbers computed
      // for the original expression.
      //
      // The scan reads the WHOLE whitelist regardless of how much of it this
      // request wanted. Filling only the requested part would let whichever
      // request arrived first decide the hour's contents, and the rest would
      // read as dashes until the hour rolled.
      const declaredResolved = (declared ?? [])
        .map((c) => ({ column: c, expression: resolveMqe(c.metric, c.mqe, layerKey) }))
        .filter((r) => r.expression !== null);
      const whitelist = new Set(declaredResolved.map((r) => r.expression as string));
      // Doubles as the cache's identity: an admin editing the header's columns
      // changes what the hour means, so buckets held for the old set are
      // dropped rather than served under the new one.
      //
      // The OAP offset is part of it because the hour is floored on the SERVER's
      // clock. If the timezone probe falls back to UTC during an outage and then
      // recovers, buckets read on the wrong grid would otherwise stay held under
      // the same signature and be served as if they were the right hour.
      const headerSignature = `${offset}\n${[...whitelist].sort().join('\n')}`;
      // TWO conditions, and they answer different questions.
      //
      // `hourlyKpi` is the caller saying it wants the completed hour rather
      // than the window it sent — only the layer header says that, because it
      // is the only screen that prints the hour's label beside the numbers.
      // Without it the Overview's page-side widgets would be handed hour-old
      // figures under `durationStart`/`durationEnd` describing the ten minutes
      // they asked for, with nothing on screen to tell.
      //
      // The whitelist then bounds WHAT such a caller may be given, by
      // expression and without regard to who asked.
      const cacheable =
        cfg.hourlyKpi === true &&
        resolved.length > 0 &&
        resolved.every((r) => r.expression !== null && whitelist.has(r.expression));

      let sampled: typeof services = services;
      // Did the hourly path actually answer? If it did not — a deployment too
      // young for OAP's hour flush to have run, so neither the completed hour
      // nor the one in progress holds anything — the request reads the
      // operator's own window instead, exactly as it did before this cache
      // existed. An empty hour must not decide the ranking: it would sort the
      // layer alphabetically and change which service the page opens on.
      let servedFromCache = false;
      let scalarByService = new Map<string, Record<string, number | null>>();
      let kpiRead: KpiRead | null = null;
      // Whether a scan is actually running for the hour. Distinct from "no
      // bucket": an hour that was read and holds nothing, or one whose read
      // failed, also come back without a bucket, and neither is worth waiting
      // for. See `KpiRead.state`.
      let hourScanRunning = false;
      // The fan-out path probes every sampled service in full, so it already
      // holds the series the header draws; the cache path holds scalars only
      // and reads the series separately for the top rows.
      let probedCells: Awaited<ReturnType<typeof probeColumns>> | null = null;

      if (cacheable) {
        const scan: ScanFn = async (_layerKey, hourStartMs) => {
          // The scan's fan-out is charged to the BUCKET, not to this request:
          // the bucket outlives us, and whoever is served from it later must
          // be able to say how complete it is.
          const acct = { total: 0, failed: 0, unread: new Set<string>() };
          // The SAME bulk path, asked for the target hour at HOUR precision, so
          // OAP returns one bucket per service instead of sixty the BFF would
          // then collapse.
          const hourWindow = windowFromRange('HOUR', hourStartMs, hourStartMs + 3_599_999, offset);
          const byService = new Map<string, Record<string, number | null>>();
          const nothing = { total: 0, failed: 0 };
          if (!hourWindow) {
            return { byService, unread: acct.unread, batches: nothing };
          }
          const cells = await probeColumns(
            layerRoster,
            declaredResolved,
            hourWindow,
            acct,
            false,
            scanOpts,
          );
          for (const svc of layerRoster) {
            const row: Record<string, number | null> = {};
            declaredResolved.forEach(({ expression }, ci) => {
              if (expression) row[expression] = collapseToScalar(cells.get(`${svc.id}#${ci}`));
            });
            byService.set(svc.id, row);
          }
          return {
            byService,
            unread: acct.unread,
            batches: { total: acct.total, failed: acct.failed },
          };
        };
        const read = await getHeaderKpis(layerKey, headerSignature, scan, Date.now(), offset);
        hourScanRunning = read.state === 'warming';
        if (read.state === 'hit' && read.bucket && bucketHasValues(read.bucket)) {
          const orderByExpr =
            resolved.find((r) => r.column.metric === cfg.orderBy)?.expression ?? '';
          sampled = rankFromCache(read.bucket, services, orderByExpr, cap, (x) => x.value);
          scalarByService = read.bucket.byService;
          servedFromCache = true;
          kpiRead = read;
        }
        // Anything else leaves `kpiRead` null: the response says nothing about
        // an hour, and the values below describe the picked window like any
        // other read.
      }
      // Still WARMING: the hour is being scanned and nothing is held to answer
      // from yet. Reading the picked window live instead costs a second fan-out
      // the size of the one already running, and every concurrent caller adds
      // another — on a large layer that is the whole expense this cache exists
      // to remove, paid twice. Above `headerWarmupMaxServices` the header says
      // it is still reading and the running scan warms the next request; below
      // it a live read is cheap enough to be worth doing.
      //
      // Only a caller that ASKED for the hour can be told to wait for it.
      // Everything else wanted the window it sent and gets it.
      // Waiting is only honest when a scan IS running that will answer. An hour
      // read and found empty, a read that failed, and a request whose columns
      // fall outside the whitelist all come back without a bucket too — and
      // telling any of them to wait leaves "still reading" on screen for an
      // answer that is never coming. `hourScanRunning` is the cache saying so
      // rather than the route inferring it from an absence.
      const warmupCap = deps.config.current.performance.limits.headerWarmupMaxServices;
      const kpiWarming =
        cfg.hourlyKpi === true &&
        hourScanRunning &&
        !servedFromCache &&
        layerRoster.length > warmupCap;

      if (kpiWarming) {
        // Trim to the same cap the fan-out would have. Skipping the block below
        // also skips its capping, which would put the layer's WHOLE roster in
        // `sampledRows` — ten thousand rows of nulls on exactly the layer this
        // valve exists for. Order is the roster's own; there is nothing read to
        // rank on yet, and the header says so.
        sampled = services.slice(0, cap);
      }

      if (!servedFromCache && !kpiWarming) {
        // Bound the column fan-out to `landingServiceCap` services. At or under
        // the cap everyone is probed; above it a cheap single-metric ranking
        // pass over every service picks the true top-`cap` first. The UI
        // surfaces "top N of M" so the trim is never silent.
        sampled = services;
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
            sampled = services.slice(0, cap);
          }
        }
        probedCells = await probeColumns(sampled, resolved);
        for (const svc of sampled) {
          const row: Record<string, number | null> = {};
          resolved.forEach(({ expression }, ci) => {
            if (expression) row[expression] = collapseToScalar(probedCells!.get(`${svc.id}#${ci}`));
          });
          scalarByService.set(svc.id, row);
        }
      }

      // Step 3 — rows from the CACHE, series for the top rows only.
      //
      // The values are already held: the hourly scan read every service, so a
      // second fan-out over the sampled hundred would ask for what is in hand.
      // The series is the one thing the cache deliberately does not hold — at
      // 100k services it would be tens of millions of points — and it is only
      // ever drawn for the template's `topN` rows, so it is read for those and
      // nobody else. That read is a handful of fragments whatever the layer's
      // size, which is the property the old shape did not have.
      const rows: LandingServiceRow[] = sampled.map((svc) => {
        const held = scalarByService.get(svc.id) ?? {};
        const metrics: Record<string, number | null> = {};
        for (const { column, expression } of resolved) {
          metrics[column.metric] = postProcess(
            (expression ? held[expression] : null) ?? null,
            column.scale,
            column.precision,
          );
        }
        return {
          serviceId: svc.id,
          serviceName: svc.value,
          ...(svc.shortName ? { shortName: svc.shortName } : {}),
          ...(svc.group ? { group: svc.group } : {}),
          metrics,
        };
      });

      // A cache-served page arrives ranked — `rankFromCache` sorted on the same
      // values these rows carry, so re-sorting could only disagree with it.
      // The fan-out path does not: its roster is in listing order, so the
      // ranking happens here.
      //
      // A service whose metric we could not READ is not a service with no
      // traffic, and must not be ranked as one — sorting it last is a claim
      // about the operator's system made from a failure to measure it. Unread
      // services rank ABOVE the genuinely-absent, so a timeout cannot silently
      // evict the busiest service from the top-N; the response says the ranking
      // was partial so the reason is visible rather than inferred from a gap.
      if (!servedFromCache) {
        const rank = (r: (typeof rows)[number]): 0 | 1 | 2 => {
          if (r.metrics[cfg.orderBy] != null) return 0;
          return requestAcct.unread.has(r.serviceId) ? 1 : 2;
        };
        rows.sort((a, b) => {
          const ra = rank(a);
          const rb = rank(b);
          if (ra !== rb) return ra - rb;
          const av = a.metrics[cfg.orderBy];
          const bv = b.metrics[cfg.orderBy];
          if (av == null || bv == null) return a.serviceName.localeCompare(b.serviceName);
          return bv - av;
        });
      }

      // Nothing while warming. The rows are in roster order then — the ranking
      // has not been read — so these would be an arbitrary handful of services
      // drawn under a "top N" heading, and each one costs a live query on the
      // layer the valve exists to protect.
      const topRowsForSeries = kpiWarming ? [] : rows.slice(0, cfg.topN);
      const seriesByServiceMetric = new Map<string, Map<string, Array<number | null>>>();
      if (topRowsForSeries.length > 0) {
        const byId = new Map(sampled.map((svc) => [svc.id, svc]));
        // The fan-out path already read the full series for every sampled
        // service — the scalars it produced were collapsed FROM them — so
        // asking again for the top rows would be the same query twice. Only a
        // cache hit needs this read: the bucket holds scalars and nothing else.
        const seriesProbe =
          probedCells ??
          (await probeColumns(
            topRowsForSeries.map((r) => byId.get(r.serviceId)).filter((x): x is (typeof sampled)[number] => !!x),
            resolved,
          ));
        topRowsForSeries.forEach((r) => {
          const seriesMap = new Map<string, Array<number | null>>();
          resolved.forEach(({ column }, cIdx) => {
            const series = collapseToSeries(seriesProbe.get(`${r.serviceId}#${cIdx}`));
            if (series) {
              seriesMap.set(
                column.metric,
                series.map((v) => postProcess(v, column.scale, column.precision)),
              );
            }
          });
          seriesByServiceMetric.set(r.serviceId, seriesMap);
        });
      }

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
      for (const { column: col } of resolved) {
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

      // Self-aggregating columns — one global execExpression each. The MQE
      // collapses to a SINGLE_VALUE, so the lone scalar IS the KPI: no rows,
      // no page-side rollup. Batched in one GraphQL trip; a batch failure
      // leaves those KPIs null (the plain-column aggregates still stand).
      if (aggResolved.length > 0) {
        const back = aggResolved.map((r, i) => ({ a: `agg${i}`, column: r.column, expression: r.expression }));
        try {
          const data = await graphqlPost<Record<string, MqeResultShape>>(
            opts,
            `query LandingAggMqe { ${back.map((b) => buildAggFragment(b.a, b.expression, window, coldStage)).join('\n    ')} }`,
          );
          for (const { a, column } of back) {
            aggregates.metrics[column.metric] = postProcess(
              collapseToScalar(data[a]),
              column.scale,
              column.precision,
            );
          }
        } catch {
          for (const { column } of back) aggregates.metrics[column.metric] = null;
        }
      }

      // Say it on the wire. `reachable` stays true — a partial metric read is
      // still a drawable answer, and the graph layer's acceptance rule depends
      // on that — but the ranking was decided on incomplete data and a caller
      // that shows a "busiest service" is entitled to know.
      // The response is as complete as everything that fed it: this request's
      // own reads, plus the scan behind whichever bucket answered the header.
      // Charging only the live reads meant an hour whose scan lost a batch was
      // reported as sound on every request but the one that filled it.
      const bucketBatches = kpiRead?.bucket?.batches ?? { total: 0, failed: 0 };
      const failedAll = requestAcct.failed + bucketBatches.failed;
      const metricsPartial =
        failedAll > 0
          ? { failedChunks: failedAll, totalChunks: requestAcct.total + bucketBatches.total }
          : undefined;

      const body: LandingResponse = {
        layer: layerKey,
        topN: cfg.topN,
        orderBy: cfg.orderBy,
        generatedAt: Date.now(),
        step: window.step,
        durationStart: window.start,
        durationEnd: window.end,
        ...(metricsPartial ? { metricsPartial } : {}),
        ...(kpiWarming ? { kpiWarming: true } : {}),
        ...(kpiRead?.bucket
          ? {
              kpiHour: {
                hourStartMs: kpiRead.bucket.hourStartMs,
                stale: kpiRead.stale === true,
                ...(kpiRead.partial ? { partial: true } : {}),
              },
            }
          : {}),
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
