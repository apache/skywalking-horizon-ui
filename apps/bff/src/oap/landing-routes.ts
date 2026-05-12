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
 * `GET /api/layer/:key/landing` — top-N services for a layer with their
 * configured column metrics, ready for the Overview landing card.
 *
 * One round-trip to OAP for `listServices(layer)`, then a second
 * round-trip that batches `execExpression(...)` aliases — one per
 * service × column. We sort the result by `orderBy desc` and slice to
 * `topN`. MQE failures are soft — the affected cell becomes `null` so
 * the rest of the card still renders.
 *
 * The duration window is always a fixed look-back (default 15 min,
 * MINUTE step) anchored to the BFF clock. Phase 2.7's per-layer detail
 * page introduces a proper time-range picker; Overview cards stay on
 * the cheap default.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type {
  FetchLike,
  LandingResponse,
  LandingServiceRow,
} from '@skywalking-horizon-ui/api-client';
import type { ConfigSource } from '../config/loader.js';
import type { SessionStore } from '../auth/sessions.js';
import { requireAuth } from '../auth/middleware.js';
import { graphqlPost } from './graphql-client.js';
import { expressionForServiceMetric, resolveColumnExpressions } from './mqe-catalog.js';

export interface LandingRouteDeps {
  config: ConfigSource;
  sessions: SessionStore;
  fetch?: FetchLike;
}

interface ListServicesRow {
  id: string;
  value: string; // alias for name
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

/** Default look-back window for the landing card. Kept small + cheap —
 *  matches what booster-ui's KPI tiles use under the global Overview. */
const DEFAULT_WINDOW_MIN = 15;

/** Cap how many services we'll spread MQE queries over. listServices
 *  can return hundreds for big deployments; querying all of them on
 *  every Overview render is wasteful since only top-N are rendered. We
 *  sort client-side after the queries, so this cap is a sampling
 *  ceiling rather than the true top-N.
 *
 *  In Phase 3 we'll move to MQE's `top_n(...)` aggregator which OAP can
 *  resolve server-side. Until then, 25 is the breakpoint where one
 *  request stays sub-second on a typical dev OAP. */
const SERVICE_QUERY_CAP = 25;

interface Window {
  start: string;
  end: string;
  step: 'MINUTE';
}

/** Format a Date in OAP's MINUTE step format: `yyyy-MM-dd HHmm`. */
function fmtMinute(d: Date): string {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mi = String(d.getUTCMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}${mi}`;
}

/**
 * Build the default look-back window. Anchored to the BFF UTC clock for
 * now — replacing this with the OAP-side `getTimeInfo` cache is a
 * follow-up so the duration aligns with the storage TZ. The
 * MQE-resolver tolerates a few minutes of skew either way.
 */
function defaultWindow(): Window {
  const end = new Date();
  // Round to the previous minute boundary so consecutive calls hit
  // the same OAP bucket — improves cache locality on the server side.
  end.setUTCSeconds(0, 0);
  const start = new Date(end.getTime() - DEFAULT_WINDOW_MIN * 60_000);
  return { start: fmtMinute(start), end: fmtMinute(end), step: 'MINUTE' };
}

/** GraphQL aliases must be valid identifiers. Index-based prefix. */
function alias(serviceIdx: number, columnIdx: number): string {
  return `r${serviceIdx}_c${columnIdx}`;
}

/**
 * Convert a SINGLE_VALUE MQE result to a number. OAP returns each value
 * as a stringified number (or `null`). For SINGLE_VALUE the `values`
 * array has one entry; for TIME_SERIES_VALUES it has many — we use the
 * `avg` of the non-null entries as the cell value, matching what
 * booster-ui does on its KPI tiles when an expression isn't wrapped in
 * `avg(...)` already.
 */
/**
 * Convert a TIME_SERIES_VALUES MQE result into an ordered series, one
 * bucket per `step` slot. Non-numeric / null values become `null` so
 * the SPA can render a gap in the sparkline.
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

function collapseToScalar(r: MqeResultShape | undefined): number | null {
  if (!r || r.error) return null;
  const values = r.results?.[0]?.values ?? [];
  const parsed: number[] = [];
  for (const v of values) {
    if (v.value === null || v.value === undefined) continue;
    const n = Number(v.value);
    if (Number.isFinite(n)) parsed.push(n);
  }
  if (parsed.length === 0) return null;
  const sum = parsed.reduce((a, b) => a + b, 0);
  return sum / parsed.length;
}

export function registerLandingRoute(app: FastifyInstance, deps: LandingRouteDeps): void {
  const auth = requireAuth(deps);
  app.get(
    '/api/layer/:key/landing',
    { preHandler: auth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const params = req.params as { key: string };
      const layerKey = params.key;
      if (!layerKey || !/^[a-z0-9_]+$/i.test(layerKey)) {
        return reply.code(400).send({ error: 'invalid_layer_key' });
      }

      const q = req.query as Record<string, string | undefined>;
      const topNRaw = Number(q.topN ?? 5);
      const topN = Math.max(1, Math.min(8, Number.isFinite(topNRaw) ? topNRaw : 5));
      const columnsRaw = (q.columns ?? '').split(',').filter(Boolean);
      const orderBy = q.orderBy ?? columnsRaw[0] ?? 'cpm';
      const labels = (q.labels ?? '').split('|');
      const units = (q.units ?? '').split('|');
      const columns = columnsRaw.map((metric, i) => ({
        metric,
        label: labels[i] || metric,
        ...(units[i] ? { unit: units[i] } : {}),
      }));
      const sparkMetric = q.spark && q.spark.length > 0 ? q.spark : null;

      // OAP enum is upper-case (`GENERAL`, `VIRTUAL_MQ`, …); the SPA
      // sends lower-case route keys.
      const oapLayer = layerKey.toUpperCase();
      const cfg = deps.config.current;
      const opts = {
        statusUrl: cfg.oap.statusUrl,
        timeoutMs: cfg.oap.timeoutMs,
        fetch: deps.fetch,
      };
      const window = defaultWindow();

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
          topN,
          orderBy,
          generatedAt: Date.now(),
          step: 'MINUTE',
          durationStart: window.start,
          durationEnd: window.end,
          rows: [],
          reachable: false,
          error: err instanceof Error ? err.message : String(err),
        };
        return reply.send(body);
      }

      // Empty layer is fine — no error, no rows.
      if (services.length === 0 || columns.length === 0) {
        const body: LandingResponse = {
          layer: layerKey,
          topN,
          orderBy,
          generatedAt: Date.now(),
          step: 'MINUTE',
          durationStart: window.start,
          durationEnd: window.end,
          rows: [],
          reachable: true,
        };
        return reply.send(body);
      }

      // Step 2 — batched MQE queries, one alias per (service, column).
      const sampled = services.slice(0, SERVICE_QUERY_CAP);
      const resolved = resolveColumnExpressions(columns, layerKey);
      // Trip is cheaper than 25× round-trips: one query with all aliases.
      const fragments: string[] = [];
      const aliasMap = new Map<string, { sIdx: number; cIdx: number }>();
      sampled.forEach((svc, sIdx) => {
        resolved.forEach(({ expression }, cIdx) => {
          if (!expression) return;
          const a = alias(sIdx, cIdx);
          aliasMap.set(a, { sIdx, cIdx });
          // Inline JSON.stringify keeps expressions safely quoted even
          // when they contain `{p='99'}` label selectors.
          const exprLit = JSON.stringify(expression);
          const svcLit = JSON.stringify(svc.value);
          const isNormal = svc.normal === false ? 'false' : 'true';
          const startLit = JSON.stringify(window.start);
          const endLit = JSON.stringify(window.end);
          fragments.push(
            `${a}: execExpression(\n` +
              `      expression: ${exprLit},\n` +
              `      entity: { scope: Service, serviceName: ${svcLit}, normal: ${isNormal} },\n` +
              `      duration: { start: ${startLit}, end: ${endLit}, step: MINUTE }\n` +
              `    ) { type error results { values { value } } }`,
          );
        });
      });

      let mqeData: Record<string, MqeResultShape> = {};
      if (fragments.length > 0) {
        const batchQuery = `query LandingMqe { ${fragments.join('\n    ')} }`;
        try {
          mqeData = await graphqlPost<Record<string, MqeResultShape>>(opts, batchQuery);
        } catch {
          // Soft-fail: leave mqeData empty, all cells render as null.
          mqeData = {};
        }
      }

      // Step 3 — assemble rows.
      const rows: LandingServiceRow[] = sampled.map((svc, sIdx) => {
        const metrics: Record<string, number | null> = {};
        resolved.forEach(({ column }, cIdx) => {
          const a = alias(sIdx, cIdx);
          metrics[column.metric] = collapseToScalar(mqeData[a]);
        });
        return {
          serviceId: svc.id,
          serviceName: svc.value,
          ...(svc.shortName ? { shortName: svc.shortName } : {}),
          ...(svc.group ? { group: svc.group } : {}),
          metrics,
        };
      });

      // Step 4 — sort by orderBy desc, with nulls last; slice topN.
      rows.sort((a, b) => {
        const av = a.metrics[orderBy];
        const bv = b.metrics[orderBy];
        if (av == null && bv == null) return a.serviceName.localeCompare(b.serviceName);
        if (av == null) return 1;
        if (bv == null) return -1;
        return bv - av;
      });

      const topRows = rows.slice(0, topN);

      // Step 5 — sparkline series for the surviving topN only.
      // Skipped when no spark metric was requested or its expression
      // can't be resolved for this layer.
      const sparkExpr = sparkMetric
        ? expressionForServiceMetric(sparkMetric, layerKey)
        : null;
      if (sparkExpr && topRows.length > 0) {
        const sparkFragments: string[] = [];
        const sparkAliasFor = (i: number) => `s${i}`;
        topRows.forEach((row, i) => {
          const svc = sampled.find((s) => s.id === row.serviceId);
          if (!svc) return;
          const isNormal = svc.normal === false ? 'false' : 'true';
          sparkFragments.push(
            `${sparkAliasFor(i)}: execExpression(\n` +
              `      expression: ${JSON.stringify(sparkExpr)},\n` +
              `      entity: { scope: Service, serviceName: ${JSON.stringify(svc.value)}, normal: ${isNormal} },\n` +
              `      duration: { start: ${JSON.stringify(window.start)}, end: ${JSON.stringify(window.end)}, step: MINUTE }\n` +
              `    ) { type error results { values { value } } }`,
          );
        });
        if (sparkFragments.length > 0) {
          const sparkQuery = `query LandingSpark { ${sparkFragments.join('\n    ')} }`;
          try {
            const sparkData = await graphqlPost<Record<string, MqeResultShape>>(opts, sparkQuery);
            topRows.forEach((row, i) => {
              const series = collapseToSeries(sparkData[sparkAliasFor(i)]);
              if (series) row.spark = series;
            });
          } catch {
            // Soft-fail: card renders without sparkline column data.
          }
        }
      }

      const body: LandingResponse = {
        layer: layerKey,
        topN,
        orderBy,
        generatedAt: Date.now(),
        step: 'MINUTE',
        durationStart: window.start,
        durationEnd: window.end,
        rows: topRows,
        reachable: true,
      };
      return reply.send(body);
    },
  );
}
