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
 * `POST /api/layer/:key/dashboard` — runs each widget's MQE expression
 * against the OAP server and returns the result keyed by widget id.
 *
 * Body shape: `{ service?: string, widgets?: DashboardWidget[] }`. When
 * `widgets` is omitted, the BFF substitutes the layer's built-in
 * default set (see `defaults.ts`). When `service` is omitted, the BFF
 * picks the first service from `listServices(layer)` so the response
 * is never empty — UIs can pass an explicit service to scope.
 *
 * Each widget's expressions are batched into one GraphQL query via
 * aliases — same pattern as the landing route. Card widgets collapse
 * to a scalar (avg across the time-series window); line widgets keep
 * the full series per expression.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type {
  DashboardResponse,
  DashboardWidget,
  DashboardWidgetResult,
  FetchLike,
  UITemplateClient,
} from '@skywalking-horizon-ui/api-client';
import type { ConfigSource } from '../../config/loader.js';
import type { SessionStore } from '../../user/sessions.js';
import { requireAuth } from '../../user/middleware.js';
import { graphqlPost, buildOapOpts } from '../../client/graphql.js';
import { withColdStage } from '../../util/duration.js';
import {
  defaultMinuteWindow,
  fmtForStep,
  getServerOffsetMinutes,
  windowFromRange,
  type TimeStep,
  type Window,
} from '../../util/window.js';
import { widgetsForScope } from '../../logic/layers/loader.js';
import { resolveEffectiveLayer } from '../../logic/layers/effective.js';
import { defaultWidgetsFor } from '../../logic/dashboard/defaults.js';

export interface DashboardRouteDeps {
  config: ConfigSource;
  sessions: SessionStore;
  fetch?: FetchLike;
  /** OAP UI-template client — serve the in-use (remote-or-bundled)
   *  widget set when the caller doesn't pass explicit widgets. */
  uiTemplateClient?: () => UITemplateClient;
}

/** Shared with config/layer-template.ts — kept here because the
 *  runtime POST handler is the canonical user; the admin-template
 *  schema reuses widgetSchema for nested validation. */
export const widgetSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  tip: z.string().optional(),
  type: z.enum(['card', 'line', 'top', 'record', 'table']),
  // Bumped from 8 to 16: JVM Memory Detail carries 11 pool metrics
  // (code cache + young/old/survivor/permgen/metaspace + z-heap +
  // compressed class space + 3 segmented codeheaps), and a few of the
  // language families approach the same range. 16 gives headroom for
  // future relabeled bundles without blowing the cap.
  expressions: z.array(z.string().min(1)).min(1).max(16),
  expressionLabels: z.array(z.string()).max(16).optional(),
  expressionUnits: z.array(z.string()).max(16).optional(),
  expressionAxes: z.array(z.number().int().min(0).max(1)).max(16).optional(),
  unit: z.string().optional(),
  tableHeaders: z.tuple([z.string(), z.string()]).optional(),
  showTableValues: z.boolean().optional(),
  span: z.number().int().min(1).max(12).optional(),
  rowSpan: z.number().int().min(1).max(64).optional(),
  visibleWhen: z.string().optional(),
  layerScope: z.boolean().optional(),
  // Legacy x/y/w/h kept optional for back-compat.
  x: z.number().int().min(0).optional(),
  y: z.number().int().min(0).optional(),
  w: z.number().int().positive().optional(),
  h: z.number().int().positive().optional(),
});
/** Shared with config/dashboard.ts (GET-config handler). */
export const scopeSchema = z.enum([
  'service',
  'instance',
  'endpoint',
  'dependency',
  'topology',
  'trace',
  'logs',
  'traceProfiling',
  'ebpfProfiling',
  'asyncProfiling',
]);
const bodySchema = z.object({
  service: z.string().optional(),
  /** Selected instance name. Honored only when `scope === 'instance'`
   *  (or any instance-derived scope) — the BFF flips the MQE entity to
   *  `{ scope: ServiceInstance, serviceName, serviceInstanceName }` so
   *  every widget on the Instance page evaluates against the chosen
   *  pair instead of the parent service. */
  serviceInstance: z.string().optional(),
  /** Selected endpoint name, analogous to `serviceInstance` but for
   *  the Endpoint page. Switches the entity to
   *  `{ scope: Endpoint, serviceName, endpointName }`. */
  endpoint: z.string().optional(),
  // Hard cap per request — protects OAP's storage page-size cliffs
  // (CLAUDE.md warns about backend-specific thresholds). The UI is
  // responsible for chunking widget sets larger than this across
  // multiple requests; the BFF refuses oversized bodies up-front so
  // an accidentally-huge template never reaches OAP.
  widgets: z.array(widgetSchema).max(40).optional(),
  scope: scopeSchema.optional(),
  /** Global time-range, forwarded by the SPA's time picker. When all
   *  three are present the BFF queries OAP at the requested precision
   *  and window; otherwise it falls back to the last-hour MINUTE
   *  default. `step` must match OAP's downsampling tiers and drives the
   *  date-string format (verifyDateTimeString rejects a mismatch). */
  step: z.enum(['MINUTE', 'HOUR', 'DAY']).optional(),
  startMs: z.number().int().positive().optional(),
  endMs: z.number().int().positive().optional(),
});

interface MqeOwner {
  scope?: string | null;
  serviceName?: string | null;
  serviceInstanceName?: string | null;
  endpointName?: string | null;
}
interface MqeValueShape {
  id?: string | null;
  value?: string | null;
  owner?: MqeOwner | null;
}
interface MqeLabelShape {
  key: string;
  value: string;
}
interface MqeMetadataShape {
  labels?: MqeLabelShape[] | null;
}
interface MqeValuesShape {
  metric?: MqeMetadataShape | null;
  values?: MqeValueShape[];
}
export interface MqeResultShape {
  type: string;
  error?: string | null;
  results?: MqeValuesShape[];
}

const LIST_FIRST_SERVICE = /* GraphQL */ `
  query FirstService($layer: String!) {
    services: listServices(layer: $layer) { id name normal }
  }
`;

/** Auto-pick a default instance/endpoint when the caller asks for the
 *  matching scope but doesn't carry an explicit `serviceInstance` /
 *  `endpoint` body field. Without this the dashboard fires with a
 *  Service-scope entity and every ServiceInstance / Endpoint metric
 *  (so11y_* meters, envoy_cluster_*, JVM metrics, endpoint_cpm, …)
 *  returns "no data" on first paint. */
const LIST_FIRST_INSTANCE = /* GraphQL */ `
  query FirstInstance($serviceId: ID!, $duration: Duration!) {
    instances: listInstances(serviceId: $serviceId, duration: $duration) {
      id name
    }
  }
`;
const FIND_FIRST_ENDPOINT = /* GraphQL */ `
  query FirstEndpoint($serviceId: ID!, $duration: Duration!) {
    endpoints: findEndpoint(serviceId: $serviceId, keyword: "", limit: 1, duration: $duration) {
      id name
    }
  }
`;

const DEFAULT_WINDOW_MIN = 60;
function defaultWindow(offsetMinutes: number) {
  return defaultMinuteWindow(offsetMinutes, DEFAULT_WINDOW_MIN);
}
// Re-export so the existing `./dashboard.js` consumers (the test file
// today; future fragment helpers that import Window from here) don't
// need to know the helpers moved into the shared util.
export { fmtForStep, type TimeStep, type Window };

/** Build one aliased `execExpression` GraphQL fragment for a single
 *  widget expression. The entity scope flips based on opts:
 *    - `layerScope: true` → `{ scope: All }` (no service filter — GLOBAL,
 *      not layer-restricted; use with care since OAP's Entity has no
 *      `layer` field, so this leaks across layers if the metric is
 *      shared between layers)
 *    - `serviceInstanceName` set → ServiceInstance scope
 *    - `endpointName` set → Endpoint scope
 *    - otherwise → Service scope with the supplied serviceName
 *
 *  Exported for unit testing (see dashboard.test.ts). */
export function buildFragment(
  alias: string,
  expression: string,
  serviceName: string,
  normal: boolean,
  w: Window,
  opts: {
    layerScope?: boolean;
    serviceInstanceName?: string | null;
    endpointName?: string | null;
    /** When true, splice `coldStage: true` into the Duration literal.
     *  OAP ignores it for non-BanyanDB backends, so callers can pass it
     *  unconditionally when the request asked for cold-stage data. */
    coldStage?: boolean;
  } = {},
): string {
  // We fetch metric.labels (for multi-series Line widgets — relabels()
  // returns one labeled result per percentile) and value.id /
  // owner.endpointName (for TopList widgets — top_n() returns a
  // sorted list of entities + values).
  //
  // layerScope=true skips the serviceName filter so the MQE runs
  // across the whole layer — used for cross-service rollups like the
  // "Top 20 endpoints" widget on the per-layer Service page.
  let entity: string;
  if (opts.layerScope) {
    entity = '{ scope: All }';
  } else if (opts.serviceInstanceName) {
    entity =
      `{ scope: ServiceInstance, serviceName: ${JSON.stringify(serviceName)},` +
      ` serviceInstanceName: ${JSON.stringify(opts.serviceInstanceName)},` +
      ` normal: ${normal ? 'true' : 'false'} }`;
  } else if (opts.endpointName) {
    entity =
      `{ scope: Endpoint, serviceName: ${JSON.stringify(serviceName)},` +
      ` endpointName: ${JSON.stringify(opts.endpointName)},` +
      ` normal: ${normal ? 'true' : 'false'} }`;
  } else {
    entity = `{ scope: Service, serviceName: ${JSON.stringify(serviceName)}, normal: ${normal ? 'true' : 'false'} }`;
  }
  const coldFrag = opts.coldStage ? ', coldStage: true' : '';
  return (
    `${alias}: execExpression(\n` +
    `      expression: ${JSON.stringify(expression)},\n` +
    `      entity: ${entity},\n` +
    `      duration: { start: ${JSON.stringify(w.start)}, end: ${JSON.stringify(w.end)}, step: ${w.step}${coldFrag} }\n` +
    `    ) {\n` +
    `      type error\n` +
    `      results {\n` +
    `        metric { labels { key value } }\n` +
    `        values { id value owner { scope serviceName serviceInstanceName endpointName } }\n` +
    `      }\n` +
    `    }`
  );
}

export function parseSeries(r: MqeResultShape | undefined): Array<number | null> | null {
  if (!r || r.error) return null;
  const values = r.results?.[0]?.values ?? [];
  if (values.length === 0) return null;
  return values.map((v) => {
    if (v.value === null || v.value === undefined) return null;
    const n = Number(v.value);
    return Number.isFinite(n) ? n : null;
  });
}
export function avgOf(series: Array<number | null> | null): number | null {
  if (!series) return null;
  const xs = series.filter((v): v is number => v !== null);
  if (xs.length === 0) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/**
 * Time-series MQE responses can carry multiple labeled results (one
 * relabel() call returns 5 results, one per percentile). Convert each
 * to a `DashboardSeries`. The label preference order:
 *  - explicit `relabels(..., key='...')` from metric.labels (multi-series)
 *  - fallback to the caller's expression text (single-series)
 *
 * Do NOT use `values[0].id` as a label — for time-series MQEs, OAP
 * returns the per-bucket timestamp/index as the value id, which is
 * useless as a series label.
 */
export function parseLabeledSeries(
  r: MqeResultShape | undefined,
  fallbackLabel: string,
): Array<{ label: string; data: Array<number | null> }> | null {
  if (!r || r.error) return null;
  const out: Array<{ label: string; data: Array<number | null> }> = [];
  for (const rs of r.results ?? []) {
    const values = rs.values ?? [];
    if (values.length === 0) continue;
    const data = values.map((v) => {
      if (v.value === null || v.value === undefined) return null;
      const n = Number(v.value);
      return Number.isFinite(n) ? n : null;
    });
    // For relabels() results OAP returns multi-result responses with
    // metric.labels populated — take the last (most-derived) label
    // value, e.g. `percentile='99'`. Single-series results have no
    // labels; fall back to the operator's expression text.
    const labels = rs.metric?.labels ?? [];
    const lbl = labels.length > 0 ? labels[labels.length - 1].value : fallbackLabel;
    out.push({ label: lbl, data });
  }
  return out.length > 0 ? out : null;
}

/**
 * Extract a sorted list from a `top_n(...)` MQE response. Names follow
 * an entity-scope priority:
 *   Endpoint    →  "<service> · <endpoint>" or just "<endpoint>"
 *   Instance    →  "<service> · <instance>" or just "<instance>"
 *   Service     →  service
 *   fallback    →  raw id
 *
 * The `<service> ·` prefix is only added when the list actually spans
 * MULTIPLE services (layer-wide top lists, where the same endpoint can
 * appear under different services and needs disambiguation). On a
 * single-service dashboard ("Top 20 APIs" under one service) every row
 * carries the same service, so the prefix is pure noise — drop it and
 * show just the endpoint / instance.
 */
export function parseTopList(
  r: MqeResultShape | undefined,
): Array<{ name: string; value: number | null }> | null {
  if (!r || r.error) return null;
  const values = r.results?.[0]?.values ?? [];
  if (values.length === 0) return null;
  const services = new Set<string>();
  for (const v of values) {
    if (v.owner?.serviceName) services.add(v.owner.serviceName);
  }
  const multiService = services.size > 1;
  return values.map((v) => {
    const o = v.owner;
    let name = '—';
    if (o?.endpointName) {
      name = multiService && o.serviceName ? `${o.serviceName} · ${o.endpointName}` : o.endpointName;
    } else if (o?.serviceInstanceName) {
      name = multiService && o.serviceName
        ? `${o.serviceName} · ${o.serviceInstanceName}`
        : o.serviceInstanceName;
    } else if (o?.serviceName) {
      name = o.serviceName;
    } else if (v.id) {
      name = v.id;
    }
    const num = v.value !== null && v.value !== undefined ? Number(v.value) : null;
    return { name, value: Number.isFinite(num as number) ? (num as number) : null };
  });
}

/**
 * Extract `table` rows from a LABELED `latest(...)` MQE response. Each
 * result is one label combination (e.g. `{phase: Running, service: x}`
 * or `{condition: Ready, node: y}`); the row name joins the label
 * VALUES (the status/phase/condition/entity dimensions) and the value
 * is the latest non-null bucket. Mirrors booster-ui's Table for
 * label-dimensioned meters that a scalar card / time-series line can't
 * represent. Rows are sorted by name for a stable render.
 */
export function parseTable(
  r: MqeResultShape | undefined,
): Array<{ labels: Array<{ key: string; value: string }>; value: number | null }> | null {
  if (!r || r.error) return null;
  const results = r.results ?? [];
  if (results.length === 0) return null;
  const rows = results.map((rs) => {
    const labels = (rs.metric?.labels ?? []).map((l) => ({ key: l.key, value: l.value }));
    // `latest(...)` yields one bucket, but be defensive: take the last
    // non-null value across the result's buckets.
    let value: number | null = null;
    for (const v of rs.values ?? []) {
      if (v.value === null || v.value === undefined) continue;
      const n = Number(v.value);
      if (Number.isFinite(n)) value = n;
    }
    // No labels (degenerate) → fall back to the value id as a single column.
    if (labels.length === 0 && rs.values?.[0]?.id) {
      labels.push({ key: 'name', value: rs.values[0].id as string });
    }
    return { labels, value };
  });
  // Stable order by the joined label values.
  rows.sort((a, b) =>
    a.labels.map((l) => l.value).join('·').localeCompare(b.labels.map((l) => l.value).join('·')),
  );
  return rows;
}

export function registerDashboardQueryRoute(app: FastifyInstance, deps: DashboardRouteDeps): void {
  const auth = requireAuth(deps);
  app.post(
    '/api/layer/:key/dashboard',
    { preHandler: auth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const params = req.params as { key: string };
      const layerKey = params.key;
      if (!layerKey || !/^[a-z0-9_]+$/i.test(layerKey)) {
        return reply.code(400).send({ error: 'invalid_layer_key' });
      }
      const parsed = bodySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_body', detail: parsed.error.flatten() });
      }
      // Dev-mode query param `?mockTop=N` pads every TopList result to
      // exactly N entries with synthetic rows. Use to verify widget
      // height / overflow without waiting for OAP to populate the layer.
      const mockTopRaw = (req.query as { mockTop?: string }).mockTop;
      const mockTopN = mockTopRaw ? Math.max(0, Math.min(40, Number(mockTopRaw))) : 0;
      const scope = parsed.data.scope ?? 'service';
      const eff = await resolveEffectiveLayer(deps.uiTemplateClient, layerKey);
      // Blocked (template store unreachable / layer disabled) → no
      // BFF-derived widgets and no in-code defaults; the grid stays empty.
      // An explicit `widgets[]` in the body still runs — the caller owns it.
      const widgets: DashboardWidget[] =
        parsed.data.widgets ??
        (eff.blocked
          ? []
          : eff.template
            ? widgetsForScope(eff.template, scope)
            : defaultWidgetsFor(eff.template, layerKey));
      let serviceName = parsed.data.service ?? '';
      let serviceId = '';
      let normal = true;
      const cfgCurrent = deps.config.current;
      const opts = buildOapOpts(cfgCurrent, deps.fetch);
      // Probe OAP's timezone so the Duration strings we emit match
      // OAP-server local time (not UTC, not browser-local). Cached 60s
      // inside getServerOffsetMinutes; ~one OAP round-trip per minute.
      const offset = await getServerOffsetMinutes(deps.config, deps.fetch);
      // Honor the SPA's time picker (step + start/end). Falls back to
      // the last-hour MINUTE default when the caller omits the range.
      const window =
        parsed.data.step && parsed.data.startMs && parsed.data.endMs
          ? windowFromRange(parsed.data.step, parsed.data.startMs, parsed.data.endMs, offset) ??
            defaultWindow(offset)
          : defaultWindow(offset);

      const baseResp: DashboardResponse = {
        layer: layerKey,
        service: serviceName || null,
        generatedAt: Date.now(),
        step: window.step,
        durationStart: window.start,
        durationEnd: window.end,
        widgets: [],
        reachable: true,
      };

      // Step 1 — resolve service. We always probe `listServices` so the
      // correct `normal` flag rides along with the service entity. Some
      // layers (VIRTUAL_MQ, VIRTUAL_DATABASE, VIRTUAL_CACHE, AWS_*) use
      // `normal: false` services — without this look-up every MQE on
      // those layers comes back null because the entity-scope filter
      // doesn't match the data dimension OAP stored them under.
      try {
        const data = await graphqlPost<{ services: Array<{ id: string; name: string; normal: boolean }> }>(
          opts,
          LIST_FIRST_SERVICE,
          { layer: layerKey.toUpperCase() },
        );
        const all = data.services ?? [];
        let picked: { id: string; name: string; normal: boolean } | undefined;
        if (serviceName) {
          picked = all.find((s) => s.name === serviceName) ?? all.find((s) => s.id === serviceName);
          if (!picked) {
            return reply.send({
              ...baseResp,
              service: serviceName,
              widgets: widgets.map((w) => ({ id: w.id, error: `service "${serviceName}" not in layer` })),
            });
          }
        } else {
          picked = all[0];
          if (!picked) {
            return reply.send({
              ...baseResp,
              widgets: widgets.map((w) => ({ id: w.id, error: 'no service in layer' })),
            });
          }
        }
        serviceName = picked.name;
        serviceId = picked.id;
        normal = picked.normal !== false;
        baseResp.service = serviceName;
      } catch (err) {
        return reply.send({
          ...baseResp,
          reachable: false,
          error: err instanceof Error ? err.message : String(err),
          widgets: widgets.map((w) => ({ id: w.id, error: 'oap unreachable' })),
        });
      }

      // Step 1b — auto-pick instance/endpoint when scope requires one
      // but the caller didn't pass one. Without this, the first paint
      // on /instance or /endpoint fires Service-scope queries against
      // ServiceInstance / Endpoint-scope metrics and every widget
      // shows "no data" until the UI's instance/endpoint picker
      // resolves and the dashboard re-fires. Symmetric to the
      // listServices auto-pick above.
      let selectedInstance: string | null = parsed.data.serviceInstance ?? null;
      let selectedEndpoint: string | null = parsed.data.endpoint ?? null;
      if (scope === 'instance' && !selectedInstance && serviceId) {
        try {
          const data = await graphqlPost<{ instances: Array<{ id: string; name: string }> }>(
            opts,
            LIST_FIRST_INSTANCE,
            {
              serviceId,
              duration: withColdStage(req, { start: window.start, end: window.end, step: window.step }),
            },
          );
          selectedInstance = data.instances?.[0]?.name ?? null;
        } catch {
          /* leave selectedInstance null — widgets surface "no data" */
        }
      }
      if (scope === 'endpoint' && !selectedEndpoint && serviceId) {
        try {
          const data = await graphqlPost<{ endpoints: Array<{ id: string; name: string }> }>(
            opts,
            FIND_FIRST_ENDPOINT,
            {
              serviceId,
              duration: withColdStage(req, { start: window.start, end: window.end, step: window.step }),
            },
          );
          selectedEndpoint = data.endpoints?.[0]?.name ?? null;
        } catch {
          /* leave selectedEndpoint null — widgets surface "no data" */
        }
      }

      // Step 2 — batch widget × expression queries via aliased
      // `execExpression(...)` fragments. Mirrors booster-ui's
      // `useExpressionsProcessor.fetchMetrics`: chunk widgets into
      // groups of 6 and fire each chunk as a separate GraphQL trip
      // in parallel. The OAP GraphQL server has per-request complexity
      // / depth limits (booster pins it at 6 widgets per trip) and
      // huge dashboards (10+ widgets × multiple expressions each)
      // would otherwise blow past the threshold and 5xx the whole
      // batch — losing every cell instead of degrading per chunk.
      // Chunked + Promise.all keeps the wall-clock close to a single
      // round-trip while staying inside OAP's per-query budget.
      const MAX_WIDGETS_PER_BATCH = 6;
      const aliasMap = new Map<string, { wIdx: number; eIdx: number }>();
      const scopeHonorsInstance = scope === 'instance';
      const scopeHonorsEndpoint = scope === 'endpoint';
      const widgetChunks: { widget: DashboardWidget; wIdx: number }[][] = [];
      for (let i = 0; i < widgets.length; i += MAX_WIDGETS_PER_BATCH) {
        widgetChunks.push(
          widgets.slice(i, i + MAX_WIDGETS_PER_BATCH).map((widget, idxInChunk) => ({
            widget,
            wIdx: i + idxInChunk,
          })),
        );
      }
      const data: Record<string, MqeResultShape> = {};
      try {
        const chunkResults = await Promise.all(
          widgetChunks.map(async (chunk) => {
            const fragments: string[] = [];
            for (const { widget, wIdx } of chunk) {
              widget.expressions.forEach((expr, eIdx) => {
                const alias = `w${wIdx}_e${eIdx}`;
                aliasMap.set(alias, { wIdx, eIdx });
                fragments.push(
                  buildFragment(alias, expr, serviceName, normal, window, {
                    layerScope: widget.layerScope === true,
                    serviceInstanceName:
                      widget.layerScope !== true && scopeHonorsInstance ? selectedInstance : null,
                    endpointName:
                      widget.layerScope !== true && scopeHonorsEndpoint ? selectedEndpoint : null,
                    coldStage: !!req.coldStage,
                  }),
                );
              });
            }
            if (fragments.length === 0) return {} as Record<string, MqeResultShape>;
            const query = `query DashboardMqe { ${fragments.join('\n    ')} }`;
            return graphqlPost<Record<string, MqeResultShape>>(opts, query);
          }),
        );
        for (const chunk of chunkResults) {
          Object.assign(data, chunk);
        }
      } catch (err) {
        return reply.send({
          ...baseResp,
          reachable: false,
          error: err instanceof Error ? err.message : String(err),
          widgets: widgets.map((w) => ({ id: w.id, error: 'mqe batch failed' })),
        });
      }

      // Step 3 — collapse per widget. Per-type handling:
      //  - 'card': scalar = avg of the first non-null series
      //  - 'line': flatten every MQE result (one per series) — handles
      //    both the simple case (1 expression → 1 series) and the
      //    relabels() case (1 expression → N labeled series)
      //  - 'top':  extract sorted list from the first expression
      const results: DashboardWidgetResult[] = widgets.map((widget, wIdx) => {
        if (widget.type === 'top') {
          const groups: Array<{
            label: string;
            expression: string;
            unit?: string;
            items: NonNullable<ReturnType<typeof parseTopList>>;
          }> = [];
          widget.expressions.forEach((expr, eIdx) => {
            let items = parseTopList(data[`w${wIdx}_e${eIdx}`]);
            // Pad with synthetic rows when mockTop is requested. Each
            // padded row gets a plausible name + a value tapered down
            // from the last real row so the list reads as ranked.
            if (mockTopN > 0) {
              const current = items ?? [];
              const padCount = Math.max(0, mockTopN - current.length);
              if (padCount > 0) {
                const last = current[current.length - 1]?.value ?? 100;
                const seed = current[current.length - 1]?.name ?? 'mock-service';
                const padded = Array.from({ length: padCount }, (_, i) => {
                  const idx = current.length + i + 1;
                  const decay = 1 - (i + 1) / (padCount + 2);
                  return {
                    name: `${seed} · mock-${idx}`,
                    value: typeof last === 'number' ? Math.round(last * decay * 100) / 100 : 0,
                  };
                });
                items = [...current, ...padded];
              }
              if (!items || items.length === 0) {
                items = Array.from({ length: mockTopN }, (_, i) => ({
                  name: `mock-entity-${i + 1}`,
                  value: Math.round((100 - i * 8) * 100) / 100,
                }));
              }
            }
            if (!items) return;
            const label = widget.expressionLabels?.[eIdx] ?? expr;
            const unit = widget.expressionUnits?.[eIdx];
            groups.push({
              label,
              expression: expr,
              ...(unit ? { unit } : {}),
              items,
            });
          });
          if (groups.length === 0) return { id: widget.id, error: 'no data' };
          return {
            id: widget.id,
            topGroups: groups,
            topList: groups[0].items,
          };
        }

        if (widget.type === 'table') {
          // Labeled latest(...) metric → one row per label combination.
          const rows = parseTable(data[`w${wIdx}_e0`]);
          if (!rows) return { id: widget.id, error: 'no data' };
          return { id: widget.id, table: rows };
        }

        if (widget.type === 'record') {
          // RECORD-typed MQE (slow SQL / slow statements) — the OAP
          // response is owner-keyed like topList but each entry also
          // carries a trace/segment id we surface for the drill-in.
          // We reuse parseTopList for the name/value pair; the
          // runtime record renderer is a separate phase and will
          // promote v.id / v.refId fields once it lands.
          const first = parseTopList(data[`w${wIdx}_e0`]);
          if (!first) return { id: widget.id, error: 'no data' };
          return {
            id: widget.id,
            records: first.map((r) => ({ name: r.name, value: r.value })),
          };
        }

        if (widget.type === 'card') {
          const first = widget.expressions.map((_, eIdx) =>
            parseSeries(data[`w${wIdx}_e${eIdx}`]),
          ).find((s) => s !== null);
          if (!first) return { id: widget.id, error: 'no data' };
          return { id: widget.id, value: avgOf(first) };
        }

        // 'line' — concat every result from every expression. One MQE
        // can return N labeled series (relabels()), so we don't assume
        // 1:1 between expressions and series. yAxisIndex + unit come
        // from the widget's per-expression overrides (when present).
        const flat: Array<{
          label: string;
          data: Array<number | null>;
          yAxisIndex?: number;
          unit?: string;
        }> = [];
        widget.expressions.forEach((expr, eIdx) => {
          const labeled = parseLabeledSeries(data[`w${wIdx}_e${eIdx}`], expr);
          if (!labeled) return;
          const labelOverride = widget.expressionLabels?.[eIdx];
          const axis = widget.expressionAxes?.[eIdx];
          const unit = widget.expressionUnits?.[eIdx];
          for (const s of labeled) {
            flat.push({
              // When the operator supplied an explicit expressionLabel
              // for a single-series expression, prefer that over the
              // OAP-side relabels value. Multi-series MQEs (relabels)
              // already arrive with sensible labels.
              label: labeled.length === 1 && labelOverride ? labelOverride : s.label,
              data: s.data,
              ...(axis !== undefined ? { yAxisIndex: axis } : {}),
              ...(unit !== undefined ? { unit } : {}),
            });
          }
        });
        if (flat.length === 0) return { id: widget.id, error: 'no data' };
        return { id: widget.id, series: flat };
      });

      return reply.send({ ...baseResp, widgets: results });
    },
  );
}
