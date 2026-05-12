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
} from '@skywalking-horizon-ui/api-client';
import type { ConfigSource } from '../config/loader.js';
import type { SessionStore } from '../auth/sessions.js';
import { requireAuth } from '../auth/middleware.js';
import { graphqlPost } from '../oap/graphql-client.js';
import {
  allLayerTemplates,
  getLayerTemplate,
  widgetsForScope,
  writeLayerTemplate,
  type LayerTemplate,
} from '../layers/loader.js';
import { defaultWidgetsFor } from './defaults.js';

export interface DashboardRouteDeps {
  config: ConfigSource;
  sessions: SessionStore;
  fetch?: FetchLike;
}

const widgetSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  tip: z.string().optional(),
  type: z.enum(['card', 'line', 'top']),
  expressions: z.array(z.string().min(1)).min(1).max(8),
  unit: z.string().optional(),
  span: z.number().int().min(1).max(12).optional(),
  rowSpan: z.number().int().min(1).max(64).optional(),
  visibleWhen: z.string().optional(),
  // Legacy x/y/w/h kept optional for back-compat.
  x: z.number().int().min(0).optional(),
  y: z.number().int().min(0).optional(),
  w: z.number().int().positive().optional(),
  h: z.number().int().positive().optional(),
});
const scopeSchema = z.enum(['service', 'instance', 'endpoint', 'trace', 'profiling']);
const bodySchema = z.object({
  service: z.string().optional(),
  widgets: z.array(widgetSchema).max(40).optional(),
  scope: scopeSchema.optional(),
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
interface MqeResultShape {
  type: string;
  error?: string | null;
  results?: MqeValuesShape[];
}

const LIST_FIRST_SERVICE = /* GraphQL */ `
  query FirstService($layer: String!) {
    services: listServices(layer: $layer) { id name normal }
  }
`;

const DEFAULT_WINDOW_MIN = 15;

interface Window {
  start: string;
  end: string;
}
function fmtMinute(d: Date): string {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mi = String(d.getUTCMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}${mi}`;
}
function defaultWindow(): Window {
  const end = new Date();
  end.setUTCSeconds(0, 0);
  const start = new Date(end.getTime() - DEFAULT_WINDOW_MIN * 60_000);
  return { start: fmtMinute(start), end: fmtMinute(end) };
}

function buildFragment(
  alias: string,
  expression: string,
  serviceName: string,
  normal: boolean,
  w: Window,
): string {
  // We fetch metric.labels (for multi-series Line widgets — relabels()
  // returns one labeled result per percentile) and value.id /
  // owner.endpointName (for TopList widgets — top_n() returns a
  // sorted list of entities + values).
  return (
    `${alias}: execExpression(\n` +
    `      expression: ${JSON.stringify(expression)},\n` +
    `      entity: { scope: Service, serviceName: ${JSON.stringify(serviceName)}, normal: ${normal ? 'true' : 'false'} },\n` +
    `      duration: { start: ${JSON.stringify(w.start)}, end: ${JSON.stringify(w.end)}, step: MINUTE }\n` +
    `    ) {\n` +
    `      type error\n` +
    `      results {\n` +
    `        metric { labels { key value } }\n` +
    `        values { id value owner { scope serviceName serviceInstanceName endpointName } }\n` +
    `      }\n` +
    `    }`
  );
}

function parseSeries(r: MqeResultShape | undefined): Array<number | null> | null {
  if (!r || r.error) return null;
  const values = r.results?.[0]?.values ?? [];
  if (values.length === 0) return null;
  return values.map((v) => {
    if (v.value === null || v.value === undefined) return null;
    const n = Number(v.value);
    return Number.isFinite(n) ? n : null;
  });
}
function avgOf(series: Array<number | null> | null): number | null {
  if (!series) return null;
  const xs = series.filter((v): v is number => v !== null);
  if (xs.length === 0) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/**
 * Time-series MQE responses can carry multiple labeled results (one
 * relabel() call returns 5 results, one per percentile). Convert each
 * to a `DashboardSeries`. The label preference order:
 *  - explicit `relabels(..., key='...')` from metric.labels
 *  - the OAP id field (e.g., `endpoint_percentile{p='99'}`)
 *  - fallback to the raw expression
 */
function parseLabeledSeries(
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
    // Prefer the most-specific label OAP returned. relabels() adds a
    // `percentile` key; raw `service_percentile{p='99'}` shows up as
    // `p='99'`. Either way, take the last (most-derived) entry.
    const labels = rs.metric?.labels ?? [];
    const lbl =
      labels.length > 0
        ? labels[labels.length - 1].value
        : values[0]?.id ?? fallbackLabel;
    out.push({ label: lbl, data });
  }
  return out.length > 0 ? out : null;
}

/** Extract a sorted list from a `top_n(...)` MQE response. Owner.endpointName
 *  / serviceInstanceName / serviceName takes priority over the bare id
 *  so operators see readable rows. */
function parseTopList(
  r: MqeResultShape | undefined,
): Array<{ name: string; value: number | null }> | null {
  if (!r || r.error) return null;
  const values = r.results?.[0]?.values ?? [];
  if (values.length === 0) return null;
  return values.map((v) => {
    const name =
      v.owner?.endpointName ??
      v.owner?.serviceInstanceName ??
      v.owner?.serviceName ??
      v.id ??
      '—';
    const num = v.value !== null && v.value !== undefined ? Number(v.value) : null;
    return { name, value: Number.isFinite(num as number) ? (num as number) : null };
  });
}

export function registerDashboardRoute(app: FastifyInstance, deps: DashboardRouteDeps): void {
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
      const scope = parsed.data.scope ?? 'service';
      const tpl = getLayerTemplate(layerKey);
      const widgets: DashboardWidget[] =
        parsed.data.widgets ??
        (tpl ? widgetsForScope(tpl, scope) : defaultWidgetsFor(layerKey));
      let serviceName = parsed.data.service ?? '';
      let normal = true;
      const cfgCurrent = deps.config.current;
      const opts = {
        statusUrl: cfgCurrent.oap.statusUrl,
        timeoutMs: cfgCurrent.oap.timeoutMs,
        fetch: deps.fetch,
      };
      const window = defaultWindow();

      const baseResp: DashboardResponse = {
        layer: layerKey,
        service: serviceName || null,
        generatedAt: Date.now(),
        step: 'MINUTE',
        durationStart: window.start,
        durationEnd: window.end,
        widgets: [],
        reachable: true,
      };

      // Step 1 — resolve service if not provided.
      if (!serviceName) {
        try {
          const data = await graphqlPost<{ services: Array<{ id: string; name: string; normal: boolean }> }>(
            opts,
            LIST_FIRST_SERVICE,
            { layer: layerKey.toUpperCase() },
          );
          const first = data.services?.[0];
          if (first) {
            serviceName = first.name;
            normal = first.normal !== false;
            baseResp.service = serviceName;
          } else {
            return reply.send({
              ...baseResp,
              widgets: widgets.map((w) => ({ id: w.id, error: 'no service in layer' })),
            });
          }
        } catch (err) {
          return reply.send({
            ...baseResp,
            reachable: false,
            error: err instanceof Error ? err.message : String(err),
            widgets: widgets.map((w) => ({ id: w.id, error: 'oap unreachable' })),
          });
        }
      }

      // Step 2 — batch all widget × expression queries into one GraphQL trip.
      const fragments: string[] = [];
      const aliasMap = new Map<string, { wIdx: number; eIdx: number }>();
      widgets.forEach((widget, wIdx) => {
        widget.expressions.forEach((expr, eIdx) => {
          const alias = `w${wIdx}_e${eIdx}`;
          aliasMap.set(alias, { wIdx, eIdx });
          fragments.push(buildFragment(alias, expr, serviceName, normal, window));
        });
      });
      let data: Record<string, MqeResultShape> = {};
      if (fragments.length > 0) {
        const query = `query DashboardMqe { ${fragments.join('\n    ')} }`;
        try {
          data = await graphqlPost<Record<string, MqeResultShape>>(opts, query);
        } catch (err) {
          return reply.send({
            ...baseResp,
            reachable: false,
            error: err instanceof Error ? err.message : String(err),
            widgets: widgets.map((w) => ({ id: w.id, error: 'mqe batch failed' })),
          });
        }
      }

      // Step 3 — collapse per widget. Per-type handling:
      //  - 'card': scalar = avg of the first non-null series
      //  - 'line': flatten every MQE result (one per series) — handles
      //    both the simple case (1 expression → 1 series) and the
      //    relabels() case (1 expression → N labeled series)
      //  - 'top':  extract sorted list from the first expression
      const results: DashboardWidgetResult[] = widgets.map((widget, wIdx) => {
        if (widget.type === 'top') {
          const r = data[`w${wIdx}_e0`];
          const top = parseTopList(r);
          return top ? { id: widget.id, topList: top } : { id: widget.id, error: 'no data' };
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
        // 1:1 between expressions and series.
        const flat: { label: string; data: Array<number | null> }[] = [];
        widget.expressions.forEach((expr, eIdx) => {
          const labeled = parseLabeledSeries(data[`w${wIdx}_e${eIdx}`], expr);
          if (labeled) flat.push(...labeled);
        });
        if (flat.length === 0) return { id: widget.id, error: 'no data' };
        return { id: widget.id, series: flat };
      });

      return reply.send({ ...baseResp, widgets: results });
    },
  );

  // GET version returns the default widget config without running queries —
  // useful for the SPA to know what to render before invoking POST.
  // Accepts ?scope=service|instance|endpoint|trace|profiling.
  app.get(
    '/api/layer/:key/dashboard/config',
    { preHandler: auth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const params = req.params as { key: string };
      const layerKey = params.key;
      if (!layerKey || !/^[a-z0-9_]+$/i.test(layerKey)) {
        return reply.code(400).send({ error: 'invalid_layer_key' });
      }
      const q = req.query as { scope?: string };
      const scopeParsed = q.scope ? scopeSchema.safeParse(q.scope) : null;
      const scope = scopeParsed?.success ? scopeParsed.data : 'service';
      const tpl = getLayerTemplate(layerKey);
      const widgets = tpl ? widgetsForScope(tpl, scope) : defaultWidgetsFor(layerKey);
      return reply.send({ layer: layerKey, scope, widgets });
    },
  );

  // Admin: enumerate every loaded JSON layer template. Used by the
  // /admin/layer-dashboards page to render a layer picker + current
  // widget set per layer.
  app.get('/api/admin/layer-templates', { preHandler: auth }, async (_req, reply) => {
    return reply.send({ templates: allLayerTemplates() });
  });

  // Admin: persist an operator-edited template back to its JSON file.
  // Body is the whole template; the BFF rewrites the file and
  // invalidates its in-memory cache so subsequent reads see the new
  // shape immediately.
  const adminTemplateSchema = z.object({
    key: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
    alias: z.string().optional(),
    color: z.string().optional(),
    documentLink: z.string().optional(),
    slots: z
      .object({
        services: z.string().optional(),
        instances: z.string().optional(),
        endpoints: z.string().optional(),
        endpointDependency: z.string().optional(),
      })
      .strict(),
    components: z
      .object({
        service: z.boolean().optional(),
        instances: z.boolean().optional(),
        endpoints: z.boolean().optional(),
        endpointDependency: z.boolean().optional(),
        topology: z.boolean().optional(),
        traces: z.boolean().optional(),
        logs: z.boolean().optional(),
        profiling: z.boolean().optional(),
      })
      .strict(),
    metrics: z
      .object({
        orderBy: z.string().optional(),
        throughput: z.string().optional(),
        spark: z.string().optional(),
        columns: z
          .array(
            z.object({
              metric: z.string().min(1),
              label: z.string(),
              unit: z.string().optional(),
              mqe: z.string().optional(),
              aggregation: z.enum(['sum', 'avg']).optional(),
              scale: z.number().finite().optional(),
              precision: z.number().int().min(0).max(6).optional(),
            }),
          )
          .max(5)
          .optional(),
      })
      .strict(),
    dashboards: z
      .object({
        service: z.array(widgetSchema).max(40).optional(),
        instance: z.array(widgetSchema).max(40).optional(),
        endpoint: z.array(widgetSchema).max(40).optional(),
        trace: z.array(widgetSchema).max(40).optional(),
        profiling: z.array(widgetSchema).max(40).optional(),
      })
      .strict()
      .optional(),
    widgets: z.array(widgetSchema).max(40).optional(),
  });

  app.post(
    '/api/admin/layer-templates/:key',
    { preHandler: auth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const params = req.params as { key: string };
      const layerKey = params.key.toUpperCase();
      const parsed = adminTemplateSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_template', detail: parsed.error.flatten() });
      }
      if (parsed.data.key.toUpperCase() !== layerKey) {
        return reply.code(400).send({ error: 'key_mismatch', detail: 'URL key does not match body key' });
      }
      try {
        writeLayerTemplate(parsed.data as LayerTemplate);
      } catch (err) {
        return reply.code(500).send({
          error: 'write_failed',
          detail: err instanceof Error ? err.message : String(err),
        });
      }
      const refreshed = getLayerTemplate(layerKey);
      return reply.send({ template: refreshed });
    },
  );
}
