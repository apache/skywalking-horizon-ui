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
  getServerOffsetMinutes,
  windowFromRange,
} from '../../util/window.js';
import { widgetsForScope } from '../../logic/layers/loader.js';
import { serviceLayerCatalog } from '../../logic/services/service-layer-catalog.js';
import { resolveEffectiveLayer } from '../../logic/layers/effective.js';
import { defaultWidgetsFor } from '../../logic/dashboard/defaults.js';
import { bodySchema, MAX_REQUEST_WIDGETS } from '../../logic/dashboard/schema.js';
import { buildFragment, type MqeResultShape } from '../../logic/dashboard/mqe.js';
import {
  parseSeries,
  avgOf,
  parseLabeledSeries,
  parseTopList,
  parseRecords,
  parseTable,
} from '../../logic/dashboard/parsers.js';
import {
  flattenValues,
  mqeGatePass,
  buildAttrMap,
  entityGatePass,
  vwOf,
  isSelfGate,
  flattenTabWidgets,
} from '../../logic/dashboard/gates.js';

export interface DashboardRouteDeps {
  config: ConfigSource;
  sessions: SessionStore;
  fetch?: FetchLike;
  /** OAP UI-template client — serve the in-use (remote-or-bundled)
   *  widget set when the caller doesn't pass explicit widgets. */
  uiTemplateClient?: () => UITemplateClient;
}

const LIST_FIRST_SERVICE = /* GraphQL */ `
  query FirstService($layer: String!) {
    services: listServices(layer: $layer) { id name normal group }
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
/** Selected-instance attribute feed for `entity` visibility gates. Mirrors
 *  the field set in http/query/instance.ts — `ServiceInstance` is the only
 *  entity scope OAP exposes an attribute bag on. */
const LIST_INSTANCE_ATTRS = /* GraphQL */ `
  query InstanceAttrs($serviceId: ID!, $duration: Duration!) {
    instances: listInstances(serviceId: $serviceId, duration: $duration) {
      name
      language
      attributes { name value }
    }
  }
`;

const DEFAULT_WINDOW_MIN = 60;
function defaultWindow(offsetMinutes: number) {
  return defaultMinuteWindow(offsetMinutes, DEFAULT_WINDOW_MIN);
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
      const scope = parsed.data.scope ?? 'service';
      const eff = await resolveEffectiveLayer(deps.uiTemplateClient, layerKey);
      // Blocked (template store unreachable / layer disabled) → no
      // BFF-derived widgets and no in-code defaults; the grid stays empty.
      // An explicit `widgets[]` in the body still runs — the caller owns it.
      const widgets: DashboardWidget[] = flattenTabWidgets(
        parsed.data.widgets ??
          (eff.blocked
            ? []
            : eff.template
              ? widgetsForScope(eff.template, scope)
              : defaultWidgetsFor(eff.template, layerKey)),
      );
      // Re-apply the cap AFTER expansion for a body-PROVIDED set: a tab counts
      // as 1 in the zod cap but flattens to many leaves, so a hand-built body
      // could fan past it. The SPA pre-flattens + chunks, so this never trips
      // it; the template fallback is trusted (and the OAP batch is bulk-chunked).
      if (parsed.data.widgets && widgets.length > MAX_REQUEST_WIDGETS) {
        return reply.code(400).send({
          error: 'too_many_widgets',
          detail: `${widgets.length} widgets after tab expansion exceeds ${MAX_REQUEST_WIDGETS}`,
        });
      }
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

      // Step 1 — resolve service. The `normal` flag has to ride along with
      // the service entity: some layers (VIRTUAL_MQ, VIRTUAL_DATABASE,
      // VIRTUAL_CACHE, AWS_*) use `normal: false` services, and without it
      // every MQE on those layers comes back null because the entity-scope
      // filter doesn't match the dimension OAP stored them under.
      //
      // Read the shared per-layer catalog first (60s TTL, kept warm by the
      // sidebar) so the common case needs no per-dashboard `listServices`.
      // Fall back to a live `listServices` on a miss — a cold/empty
      // snapshot, a just-registered service, or OAP being unreachable: the
      // catalog soft-fails to empty, so only the live probe tells
      // "unreachable" (reachable:false) apart from "no such service".
      //
      // `?group=` (split-by-service-group menu entry) constrains the
      // auto-pick default to that OAP Service.group; an explicit `service`
      // is honored regardless of group.
      const group = (req.query as { group?: string }).group;
      type PickRow = { id: string; name: string; normal: boolean | null; group?: string | null };
      const pick = (all: PickRow[]): PickRow | undefined => {
        if (serviceName) return all.find((s) => s.name === serviceName) ?? all.find((s) => s.id === serviceName);
        const inGroup = group === undefined ? all : all.filter((s) => (s.group ?? '') === group);
        return inGroup[0];
      };
      let picked = pick((await serviceLayerCatalog(deps).get()).byLayer.get(layerKey.toUpperCase()) ?? []);
      if (!picked) {
        try {
          const data = await graphqlPost<{ services: PickRow[] }>(opts, LIST_FIRST_SERVICE, {
            layer: layerKey.toUpperCase(),
          });
          picked = pick(data.services ?? []);
        } catch (err) {
          return reply.send({
            ...baseResp,
            reachable: false,
            error: err instanceof Error ? err.message : String(err),
            widgets: widgets.map((w) => ({ id: w.id, error: 'oap unreachable' })),
          });
        }
        if (!picked) {
          return reply.send({
            ...baseResp,
            widgets: widgets.map((w) => ({
              id: w.id,
              error: serviceName ? `service "${serviceName}" not in layer` : 'no service in layer',
            })),
          });
        }
      }
      serviceName = picked.name;
      serviceId = picked.id;
      normal = picked.normal !== false;
      baseResp.service = serviceName;

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

      const scopeHonorsInstance = scope === 'instance';
      const scopeHonorsEndpoint = scope === 'endpoint';

      // Step 1c — resolve visibility gates BEFORE the widget batch so a
      // failing GROUP or ENTITY gate skips its widgets' MQE entirely (a
      // non-JVM instance never runs the JVM widget group). SELF gates
      // (the predicate names one of the widget's own expressions) add
      // zero queries — they're read from the widget's own batch result
      // in Step 3. Probes here only run when such gates are present, so
      // the common all-self-gate templates keep today's query cost.
      const entityGated = widgets.some((w) => vwOf(w)?.kind === 'entity');
      // Each unique group-gate expression is probed once, shared across widgets.
      const groupGates = new Map<string, { expression: string }>();
      for (const w of widgets) {
        const vw = vwOf(w);
        if (vw?.kind === 'mqe' && !isSelfGate(w, vw)) {
          groupGates.set(vw.expression, { expression: vw.expression });
        }
      }
      // `null` = no entity context / probe failed → entity gates no-op.
      let entityAttrs: Map<string, string> | null = null;
      // expression → flattened values, or `null` when the probe failed
      // (fail OPEN: run the widgets rather than hide on an OAP hiccup).
      const groupGateVals = new Map<string, number[] | null>();
      await Promise.all([
        (async () => {
          if (!entityGated || !scopeHonorsInstance || !selectedInstance || !serviceId) return;
          try {
            const d = await graphqlPost<{
              instances: Array<{
                name: string;
                language?: string | null;
                attributes?: Array<{ name: string; value: string }> | null;
              }>;
            }>(opts, LIST_INSTANCE_ATTRS, {
              serviceId,
              duration: withColdStage(req, { start: window.start, end: window.end, step: window.step }),
            });
            const inst = (d.instances ?? []).find((i) => i.name === selectedInstance);
            if (inst) entityAttrs = buildAttrMap(inst.language, inst.attributes ?? []);
          } catch {
            /* leave entityAttrs null → entity gates stay visible */
          }
        })(),
        (async () => {
          if (groupGates.size === 0) return;
          const entries = [...groupGates.entries()];
          try {
            const fragments = entries.map(([, g], i) =>
              buildFragment(`g${i}`, g.expression, serviceName, normal, window, {
                serviceInstanceName: scopeHonorsInstance ? selectedInstance : null,
                endpointName: scopeHonorsEndpoint ? selectedEndpoint : null,
                coldStage: !!req.coldStage,
              }),
            );
            const probe = await graphqlPost<Record<string, MqeResultShape>>(
              opts,
              `query GateProbe { ${fragments.join('\n    ')} }`,
            );
            entries.forEach(([key], i) => groupGateVals.set(key, flattenValues(probe[`g${i}`])));
          } catch {
            for (const [key] of entries) groupGateVals.set(key, null);
          }
        })(),
      ]);

      /** Widgets whose GROUP/ENTITY gate failed — excluded from the
       *  batch and returned `hidden: true`. Self gates are applied after
       *  the batch (they need the widget's own data). */
      const skipped = new Set<number>();
      widgets.forEach((w, i) => {
        const vw = vwOf(w);
        if (!vw) return;
        if (vw.kind === 'entity') {
          if (!entityGatePass(vw, entityAttrs)) skipped.add(i);
          return;
        }
        if (!isSelfGate(w, vw)) {
          const vals = groupGateVals.get(vw.expression);
          if (vals == null) return; // probe failed / missing → fail open
          if (!mqeGatePass(vw.op, 'value' in vw ? vw.value : undefined, vals)) skipped.add(i);
        }
      });

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
      // Gate-skipped widgets are excluded here (their wIdx keeps its
      // original index so Step 3's result map still lines up).
      const MAX_WIDGETS_PER_BATCH = cfgCurrent.performance.bulk.dashboard.bulkSize;
      const batchWidgets = widgets
        .map((widget, wIdx) => ({ widget, wIdx }))
        .filter(({ wIdx }) => !skipped.has(wIdx));
      const widgetChunks: { widget: DashboardWidget; wIdx: number }[][] = [];
      for (let i = 0; i < batchWidgets.length; i += MAX_WIDGETS_PER_BATCH) {
        widgetChunks.push(batchWidgets.slice(i, i + MAX_WIDGETS_PER_BATCH));
      }
      const data: Record<string, MqeResultShape> = {};
      // One chunk failing (transient 5xx / timeout / OAP complexity-limit) must
      // not blank the whole dashboard — catch per chunk, mark only that chunk's
      // widgets, and let the rest render their own no-data/value state.
      const failedWidgetIdx = new Set<number>();
      const chunkResults = await Promise.all(
        widgetChunks.map(async (chunk) => {
          const fragments: string[] = [];
          for (const { widget, wIdx } of chunk) {
            widget.expressions.forEach((expr, eIdx) => {
              const alias = `w${wIdx}_e${eIdx}`;
              fragments.push(
                buildFragment(alias, expr, serviceName, normal, window, {
                  serviceInstanceName: scopeHonorsInstance ? selectedInstance : null,
                  endpointName: scopeHonorsEndpoint ? selectedEndpoint : null,
                  coldStage: !!req.coldStage,
                }),
              );
            });
          }
          if (fragments.length === 0) return {} as Record<string, MqeResultShape>;
          const query = `query DashboardMqe { ${fragments.join('\n    ')} }`;
          try {
            return await graphqlPost<Record<string, MqeResultShape>>(opts, query);
          } catch {
            for (const { wIdx } of chunk) failedWidgetIdx.add(wIdx);
            return {} as Record<string, MqeResultShape>;
          }
        }),
      );
      for (const chunk of chunkResults) {
        Object.assign(data, chunk);
      }

      // Step 3 — collapse per widget. Per-type handling:
      //  - 'card': scalar = avg of the first non-null series
      //  - 'line': flatten every MQE result (one per series) — handles
      //    both the simple case (1 expression → 1 series) and the
      //    relabels() case (1 expression → N labeled series)
      //  - 'top':  extract sorted list from the first expression
      const collapse = (widget: DashboardWidget, wIdx: number): DashboardWidgetResult => {
        if (widget.type === 'top') {
          const groups: Array<{
            label: string;
            expression: string;
            unit?: string;
            items: NonNullable<ReturnType<typeof parseTopList>>;
          }> = [];
          widget.expressions.forEach((expr, eIdx) => {
            const items = parseTopList(data[`w${wIdx}_e${eIdx}`]);
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
          // RECORD-typed MQE (slow SQL / slow statements). Each sample
          // carries the originating trace id (MQE `traceID`), forwarded so
          // the row can show a jump-to-trace icon; the statement text is
          // click-to-copy on the UI side.
          const first = parseRecords(data[`w${wIdx}_e0`]);
          if (!first) return { id: widget.id, error: 'no data' };
          return {
            id: widget.id,
            records: first.map((r) => ({
              name: r.name,
              value: r.value,
              ...(r.traceId ? { traceId: r.traceId } : {}),
            })),
          };
        }

        if (widget.type === 'card') {
          // A colored enum card whose metric is labeled (e.g. K8s node
          // conditions → one row per active condition) keeps the labels so
          // the tile renders them as colored status chips; every other card
          // collapses to the scalar average as before.
          if (widget.format === 'enum' && widget.valueColors) {
            const rows = parseTable(data[`w${wIdx}_e0`]);
            if (rows && rows.some((r) => r.labels.length > 0)) {
              return { id: widget.id, table: rows };
            }
          }
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
        widget.expressions.forEach((_expr, eIdx) => {
          // Fallback label for an un-labeled single series is the widget
          // TITLE, not the raw MQE — operators read titles, never MQE.
          // `expressionLabels[eIdx]` (when set) still takes precedence
          // below; this only affects the no-label, no-override case.
          const labeled = parseLabeledSeries(data[`w${wIdx}_e${eIdx}`], widget.title);
          if (!labeled) return;
          const labelOverride = widget.expressionLabels?.[eIdx];
          const axis = widget.expressionAxes?.[eIdx];
          const unit = widget.expressionUnits?.[eIdx];
          for (const s of labeled) {
            flat.push({
              // Multi-series: prefix the label onto each metric label so
              // paired label-dimensioned expressions stay distinct.
              label: labelOverride
                ? labeled.length === 1
                  ? labelOverride
                  : `${labelOverride}·${s.label}`
                : s.label,
              data: s.data,
              ...(axis !== undefined ? { yAxisIndex: axis } : {}),
              ...(unit !== undefined ? { unit } : {}),
            });
          }
        });
        if (flat.length === 0) return { id: widget.id, error: 'no data' };
        return { id: widget.id, series: flat };
      };

      // Reachability now follows the data batch, not Step 1: a warm catalog hit
      // skips the Step-1 OAP probe, so "every batched widget failed" is the
      // OAP-down tell — flip `reachable` so the UI's outage banner still fires.
      const oapUnreachable = batchWidgets.length > 0 && failedWidgetIdx.size === batchWidgets.length;
      const results: DashboardWidgetResult[] = widgets.map((widget, wIdx) => {
        // Group/entity gate already decided this one out (no MQE ran).
        if (skipped.has(wIdx)) return { id: widget.id, hidden: true };
        if (failedWidgetIdx.has(wIdx)) {
          return { id: widget.id, error: oapUnreachable ? 'oap unreachable' : 'mqe batch failed' };
        }
        const result = collapse(widget, wIdx);
        // SELF gate — evaluate the predicate against the widget's own
        // gate expression result (exact: only that expression's values,
        // not the whole flattened widget result).
        const vw = vwOf(widget);
        if (vw?.kind === 'mqe' && isSelfGate(widget, vw)) {
          const eIdx = widget.expressions.indexOf(vw.expression);
          const vals = flattenValues(data[`w${wIdx}_e${eIdx}`]);
          if (!mqeGatePass(vw.op, 'value' in vw ? vw.value : undefined, vals)) {
            return { id: widget.id, hidden: true };
          }
        }
        return result;
      });

      return reply.send({ ...baseResp, reachable: !oapUnreachable, widgets: results });
    },
  );
}
