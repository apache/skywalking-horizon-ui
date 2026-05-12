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
import { allLayerTemplates } from '../layers/loader.js';
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
  type: z.enum(['card', 'line']),
  expressions: z.array(z.string().min(1)).min(1).max(8),
  unit: z.string().optional(),
  x: z.number().int().min(0),
  y: z.number().int().min(0),
  w: z.number().int().positive(),
  h: z.number().int().positive(),
});
const bodySchema = z.object({
  service: z.string().optional(),
  widgets: z.array(widgetSchema).max(40).optional(),
});

interface MqeValuesShape {
  values?: Array<{ id?: string | null; value?: string | null }>;
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
  return (
    `${alias}: execExpression(\n` +
    `      expression: ${JSON.stringify(expression)},\n` +
    `      entity: { scope: Service, serviceName: ${JSON.stringify(serviceName)}, normal: ${normal ? 'true' : 'false'} },\n` +
    `      duration: { start: ${JSON.stringify(w.start)}, end: ${JSON.stringify(w.end)}, step: MINUTE }\n` +
    `    ) { type error results { values { value } } }`
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
      const widgets: DashboardWidget[] = parsed.data.widgets ?? defaultWidgetsFor(layerKey);
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

      // Step 3 — collapse per widget.
      const results: DashboardWidgetResult[] = widgets.map((widget, wIdx) => {
        const series = widget.expressions.map((_, eIdx) => parseSeries(data[`w${wIdx}_e${eIdx}`]));
        const allFailed = series.every((s) => s === null);
        if (allFailed) {
          return { id: widget.id, error: 'no data' };
        }
        if (widget.type === 'card') {
          // Card collapses to scalar from the first non-null series.
          const first = series.find((s) => s !== null) ?? null;
          return { id: widget.id, value: avgOf(first) };
        }
        return {
          id: widget.id,
          series: series.map((s, eIdx) => ({
            label: widget.expressions[eIdx],
            data: s ?? [],
          })),
        };
      });

      return reply.send({ ...baseResp, widgets: results });
    },
  );

  // GET version returns the default widget config without running queries —
  // useful for the SPA to know what to render before invoking POST.
  app.get(
    '/api/layer/:key/dashboard/config',
    { preHandler: auth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const params = req.params as { key: string };
      const layerKey = params.key;
      if (!layerKey || !/^[a-z0-9_]+$/i.test(layerKey)) {
        return reply.code(400).send({ error: 'invalid_layer_key' });
      }
      return reply.send({ layer: layerKey, widgets: defaultWidgetsFor(layerKey) });
    },
  );

  // Admin: enumerate every loaded JSON layer template. Used by the
  // /admin/layer-dashboards page to render a layer picker + current
  // widget set per layer.
  app.get('/api/admin/layer-templates', { preHandler: auth }, async (_req, reply) => {
    return reply.send({ templates: allLayerTemplates() });
  });
}
