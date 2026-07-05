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

// The MQE executor: resolve visibility gates, batch each widget × expression as
// aliased execExpression fragments, then collapse per widget type. Extracted from the
// dashboard route so both the route AND the AI `emit_widgets` tool run one code path.
// Caller resolves service/instance/endpoint + the OAP-local Window; this takes them as
// data (no Fastify req). `widgets` must already be flattenTabWidgets'd + cap-checked.
import type {
  DashboardScope,
  DashboardWidget,
  DashboardWidgetResult,
} from '@skywalking-horizon-ui/api-client';
import { graphqlPost, type GraphqlOptions } from '../../client/graphql.js';
import { withColdStage } from '../../util/duration.js';
import type { Window } from '../../util/window.js';
import { buildFragment, type MqeResultShape } from './mqe.js';
import { parseSeries, avgOf, parseLabeledSeries, parseTopList, parseRecords, parseTable } from './parsers.js';
import { flattenValues, mqeGatePass, buildAttrMap, entityGatePass, vwOf, isSelfGate } from './gates.js';

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

export interface WidgetRunEntity {
  service: string;
  /** Needed only for the entity-gate attribute probe; absent → entity gates fail open (visible). */
  serviceId?: string;
  instance?: string | null;
  endpoint?: string | null;
  scope: DashboardScope;
  normal: boolean;
}

export interface WidgetRunDeps {
  opts: GraphqlOptions;
  bulkSize: number;
  coldStage?: boolean;
}

export async function runWidgets(
  widgets: DashboardWidget[],
  entity: WidgetRunEntity,
  window: Window,
  deps: WidgetRunDeps,
): Promise<{ widgets: DashboardWidgetResult[]; reachable: boolean }> {
  const { opts, bulkSize } = deps;
  const serviceName = entity.service;
  const serviceId = entity.serviceId ?? '';
  const normal = entity.normal;
  const selectedInstance = entity.instance ?? null;
  const selectedEndpoint = entity.endpoint ?? null;
  const scopeHonorsInstance = entity.scope === 'instance';
  const scopeHonorsEndpoint = entity.scope === 'endpoint';
  const cold = { coldStage: deps.coldStage };

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
          duration: withColdStage(cold, { start: window.start, end: window.end, step: window.step }),
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
            coldStage: !!deps.coldStage,
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
  const MAX_WIDGETS_PER_BATCH = bulkSize;
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
              coldStage: !!deps.coldStage,
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

  return { widgets: results, reachable: !oapUnreachable };
}
