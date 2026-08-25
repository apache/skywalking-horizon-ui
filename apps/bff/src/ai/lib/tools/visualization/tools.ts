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
 * visualization skill — one render tool PER widget type (the user's "a tool for
 * each component"). Each builds a `DashboardWidget` spec, runs it through the
 * SAME `runWidgets` executor the dashboards use, pushes the resolved figure to
 * the SSE stream out-of-band, and returns only a terse text SUMMARY to the model
 * so it can narrate ("as the figure shows…"). Widget type follows the MQE shape:
 * a scalar-collapsing MQE (latest/max/min/avg-of-plain/sum) MUST use
 * show_figure with `type: 'card'`; series/list-shaped MQE uses line / top /
 * table / record. One tool, one `type` — the shape of the expression decides.
 */

import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { EMITS_CARD } from '../../graphic-card.js';
import type { StructuredToolInterface } from '@langchain/core/tools';
import type {
  DashboardScope,
  DashboardWidget,
  DashboardWidgetResult,
  DashboardWidgetType,
  NativeSpan,
  TopologyResponse,
  TraceListResponse,
  ZipkinTraceListResponse,
} from '@skywalking-horizon-ui/api-client';
import type { ToolContext } from '../../tool-context.js';
import type { HierarchyGroup, TopoPeer } from '../../graphic-card.js';
import { runWidgets } from '../../../../logic/dashboard/run.js';
import { resolveEffectiveLayer } from '../../../../logic/layers/effective.js';
import {
  allWidgetsForScope,
  topologyConfigFor,
  deploymentConfigFor,
  instanceTopologyConfigFor,
  endpointDependencyConfigFor,
} from '../../../../logic/layers/loader.js';
import { flattenEveryTabPanel } from '../../../../logic/dashboard/gates.js';
import { serviceLayerCatalog } from '../../../../logic/services/service-layer-catalog.js';
import { getServiceHierarchy } from '../../../../logic/oap/hierarchy.js';
import { buildServiceTopology, emptyTopologyResponse } from '../../../../logic/oap/service-topology.js';
import { buildDeployment } from '../../../../logic/oap/deployment.js';
import { buildInstanceTopology } from '../../../../logic/oap/instance-topology.js';
import { buildEndpointDependency } from '../../../../logic/oap/endpoint-dependency.js';
import { zipkinFetchServices, zipkinFetchTraces } from '../../../../client/zipkin.js';
import { overFetchSize, takeOverFetched } from '../../../../logic/paging/read-page.js';
// Reuse the exported list fetchers so a captured triage block freezes the EXACT
// response the interactive route produces (no re-derived query, no drift). They
// take a resolved serviceId + OAP-local window and reach OAP only through
// client/graphqlPost — the load-bearing rule holds. They live in http/query only
// because their trace core (detectTraceQueryApi / TraceListBody / fetchZipkinList)
// is entangled there; a move to logic/oap would relocate that whole core.
import { fetchNativeList, fetchNativeTraceSpans } from '../../../../http/query/trace.js';
import { fetchLogs } from '../../../../http/query/log.js';
import { fetchBrowserErrors } from '../../../../http/query/browser-errors.js';
import { getServerOffsetMinutes, fmtSecond } from '../../../../util/window.js';
import { toolPrompt } from '../../skills/loader.js';

// Capture caps for the frozen triage lists — each is further clamped by the
// operator's `performance.limits.maxPageSize.*`.
//
// ONE trace cap, for every source. It used to be two: 30 where spans arrive
// inline (v2, Zipkin) and 10 for v1, whose rows carry none and need a per-trace
// fetch to hydrate. That made the number a statement about QUERY COUNT on one
// path and about payload size on the others, and two numbers for one idea is a
// thing a reader has to learn twice.
//
// Ten, because the cost is real on both axes: v1 still spends a query per trace
// — Horizon does that nested fetch so the protocol difference stays inside and
// a v1 deployment replays a waterfall like any other — and the whole capture now
// travels to the model, where thirty traces of spans is a large fraction of a
// context for evidence a reader looks at ten of.
const TRACE_CAP = 10;
const LIST_CAP = 100;
// Derive the captured window (minutes) from the chat's global range — the same
// value the map tools emit, so the frozen block's window matches what was read.
const rangeWindowMinutes = (r: { startMs: number; endMs: number }): number =>
  Math.max(1, Math.round((r.endMs - r.startMs) / 60_000));

const ri = toolPrompt('visualization', 'show_figure');
/** The five widget types a derived MQE can render. Which one is correct
 *  follows from the MQE's shape, not from taste — see the `type` description. */
const WIDGET_TYPES = ['line', 'card', 'top', 'table', 'record'] as const;

const renderInput = z.object({
  title: z.string().describe(ri.p('title')),
  layer: z.string().describe(ri.p('layer')),
  service: z.string().describe(ri.p('service')),
  expressions: z.array(z.string()).min(1).describe(ri.p('expressions')),
  labels: z.array(z.string()).optional().describe(ri.p('labels')),
  instance: z.string().optional().describe(ri.p('instance')),
  endpoint: z.string().optional().describe(ri.p('endpoint')),
  unit: z.string().optional().describe(ri.p('unit')),
  group: z.string().optional().describe(ri.p('group')),
});
type RenderInput = z.infer<typeof renderInput>;

function summarize(type: DashboardWidgetType, r: DashboardWidgetResult): string {
  if (r.error) return `error: ${r.error}`;
  if (r.hidden) return 'no data (hidden by a visibility gate)';
  switch (type) {
    case 'card': {
      return r.value == null ? 'no data' : `value ≈ ${r.value}`;
    }
    case 'line': {
      const s = r.series ?? [];
      // Across ALL series, not just the first. A multi-expression widget whose
      // first series is the empty one — status codes, where 1xx is usually
      // silent — announced itself as "0 points, last ≈ n/a" while four other
      // series carried traffic, and that sentence is read before the payload.
      const points = s.reduce((m, x) => Math.max(m, (x.data ?? []).length), 0);
      const carrying = s.filter((x) => (x.data ?? []).some((v) => v != null));
      const values = carrying[0]?.data?.filter((v) => v != null) ?? [];
      const last = values.length ? values[values.length - 1] : null;
      const carried = s.length > 1 ? ` (${carrying.length} with values)` : '';
      return `${s.length} series${carried}, ${points} points, last ≈ ${last ?? 'n/a'}`;
    }
    case 'top': {
      const items = r.topList ?? r.topGroups?.[0]?.items ?? [];
      const head = items[0];
      return `${items.length} entries${head ? `, top: ${head.name} = ${head.value}` : ''}`;
    }
    case 'table':
      return `${r.table?.length ?? 0} rows`;
    case 'record':
      return `${r.records?.length ?? 0} records`;
    default:
      return 'rendered';
  }
}

// Compact value formatter for topology node/edge metrics — the same
// magnitude-aware rounding the UI uses, so the agent reads real numbers.
function fmtTopoVal(v: number | null | undefined, unit?: string): string {
  if (v == null) return '—';
  const s = Math.abs(v) >= 100 ? String(Math.round(v)) : String(Math.round(v * 10) / 10);
  return unit ? (unit === '%' ? `${s}%` : `${s} ${unit}`) : s;
}
// Structural metric legend — both TopologyMetricDef and DeploymentMetricDef fit.
type MetricLegend = { id: string; label?: string; unit?: string };
function dedupeLegend(defs: MetricLegend[]): MetricLegend[] {
  const seen = new Set<string>();
  return defs.filter((d) => (seen.has(d.id) ? false : (seen.add(d.id), true)));
}
function topoMetricLine(metrics: Record<string, number | null>, defs: MetricLegend[]): string {
  return defs
    .map((d) => `${d.label ?? d.id} ${fmtTopoVal(metrics[d.id], d.unit)}`)
    .join(', ');
}

// Compact "N nodes: name (metrics); …" line for the map builders' model text —
// the WS2 rich read for deployment / instance / endpoint graphs.
function summarizeMapNodes(
  nodes: Array<{ name: string; metrics: Record<string, number | null> }>,
  nodeDefs: MetricLegend[],
  cap: number,
): string {
  if (nodes.length === 0) return '';
  const head = nodes
    .slice(0, cap)
    .map((n) => {
      const line = topoMetricLine(n.metrics, nodeDefs);
      return line ? `${n.name} (${line})` : n.name;
    })
    .join('; ');
  return `${head}${nodes.length > cap ? `; …${nodes.length - cap} more` : ''}`;
}

// Metric ids measured on BOTH sides of an edge (server ∩ client), so a client-vs-
// server delta is comparable.
function pairedLinkDefs(srv: MetricLegend[], cli: MetricLegend[]): MetricLegend[] {
  const cliIds = new Set(cli.map((d) => d.id));
  return srv.filter((d) => cliIds.has(d.id));
}

/**
 * The two-sided edge read a human gets by CLICKING an edge — surfaced for the
 * model so RCA reasons about it without a click. On one hop, the caller's client
 * metric minus the callee's server metric is the slice spent OUTSIDE the server:
 * a client>server LATENCY gap ⇒ network / firewall / TLS / big-payload
 * (de)serialization; a client>server THROUGHPUT gap ⇒ calls that never landed
 * (drops / timeouts / retries). Only flags gaps past a relative floor so it stays
 * signal, not noise.
 */
function edgeGapSummary(
  calls: Array<{ source: string; target: string; serverMetrics?: Record<string, number | null>; clientMetrics?: Record<string, number | null> }>,
  nameOf: (id: string) => string,
  defs: MetricLegend[],
  cap: number,
): string {
  if (defs.length === 0) return '';
  const gaps: string[] = [];
  for (const c of calls) {
    const notes: string[] = [];
    for (const d of defs) {
      const cl = c.clientMetrics?.[d.id];
      const sv = c.serverMetrics?.[d.id];
      if (cl == null || sv == null) continue;
      const diff = cl - sv;
      const rel = Math.abs(sv) > 0 ? Math.abs(diff) / Math.abs(sv) : Math.abs(diff) > 0 ? 1 : 0;
      if (rel >= 0.25 && Math.abs(diff) > 0) {
        notes.push(`${d.label ?? d.id} client ${fmtTopoVal(cl, d.unit)} vs server ${fmtTopoVal(sv, d.unit)}`);
      }
    }
    if (notes.length) gaps.push(`${nameOf(c.source)}→${nameOf(c.target)}: ${notes.join(', ')}`);
  }
  if (gaps.length === 0) return '';
  return ` CLIENT↔SERVER edge gaps (delta is outside-the-server time/calls — suspect network / firewall / (de)serialization): ${gaps.slice(0, cap).join('; ')}${gaps.length > cap ? `; …${gaps.length - cap} more` : ''}.`;
}

/**
 * Turn the captured ego graph into a metric-carrying text summary for the
 * model — the WS2 "rich read": real focus/peer/edge VALUES (server-side edge
 * metrics = the callee's view of the traffic), not bare upstream/downstream
 * counts. The full graph rides the figure snapshot; this is what the LLM
 * reasons over.
 */
function summarizeTopology(snap: TopologyResponse, focusId: string, service: string): string {
  const nodeById = new Map(snap.nodes.map((n) => [n.id, n]));
  const nodeDefs = snap.config.nodeMetrics ?? [];
  const srvDefs = snap.config.linkServerMetrics ?? [];
  const CAP = 12;
  const lines: string[] = [];
  const focus = nodeById.get(focusId);
  if (focus) lines.push(`Focus ${service}: ${topoMetricLine(focus.metrics, nodeDefs)}.`);
  // Read BOTH the peer's OWN health (its node metrics — what a human sees by
  // clicking the peer hex) AND the edge to it. A real peer carries node metrics;
  // a virtual peer (untraced DB/cache/external) has none, so only the edge shows.
  const peerLine = (callId: string, peerId: string): string => {
    const call = snap.calls.find((c) => c.id === callId);
    const node = nodeById.get(peerId);
    const name = node?.name ?? peerId;
    const hasNodeVal = !!node && Object.values(node.metrics ?? {}).some((v) => v != null);
    const health = hasNodeVal ? topoMetricLine(node!.metrics, nodeDefs) : '';
    const edge = call ? topoMetricLine(call.serverMetrics, srvDefs) : '';
    const parts = [health && `node ${health}`, edge && `edge ${edge}`].filter(Boolean);
    return parts.length ? `${name} (${parts.join(' · ')})` : name;
  };
  const up = snap.calls.filter((c) => c.target === focusId);
  const down = snap.calls.filter((c) => c.source === focusId);
  lines.push(
    up.length
      ? `Upstream callers (${up.length}): ${up.slice(0, CAP).map((c) => peerLine(c.id, c.source)).join('; ')}${up.length > CAP ? `; …${up.length - CAP} more` : ''}.`
      : 'No upstream callers in this window.',
  );
  lines.push(
    down.length
      ? `Downstream dependencies (${down.length}): ${down.slice(0, CAP).map((c) => peerLine(c.id, c.target)).join('; ')}${down.length > CAP ? `; …${down.length - CAP} more` : ''}.`
      : 'No downstream dependencies in this window.',
  );
  const gapDefs = pairedLinkDefs(srvDefs, snap.config.linkClientMetrics ?? []);
  return lines.join(' ') + edgeGapSummary(snap.calls, (id) => nodeById.get(id)?.name ?? id, gapDefs, 6);
}

export function visualizationTools(ctx: ToolContext): StructuredToolInterface[] {
  const catalog = () => serviceLayerCatalog({ config: ctx.config, fetch: ctx.fetch }).get();

  async function render(type: DashboardWidgetType, input: RenderInput): Promise<string> {
    if (!ctx.hasVerb('metrics:read')) {
      return 'Permission denied: the current user lacks metrics:read.';
    }
    // SkyWalking has no instance×endpoint scope: an Endpoint is measured across
    // the whole service, a ServiceInstance across all its endpoints. Combining
    // them returns empty — reject it so the model re-renders at one scope.
    if (input.instance && input.endpoint) {
      return 'Invalid scope: SkyWalking has no instance×endpoint metric. An Endpoint is service-scoped (across all instances) and a ServiceInstance is service-scoped (across all endpoints) — they do not combine. Render at instance scope OR endpoint scope, not both.';
    }

    // Resolve serviceId + `normal` from the shared catalog (normal rides with
    // the entity — VIRTUAL_* layers use normal:false and MQE returns null
    // without it). Fall back to name-only if the catalog misses.
    const cat = await catalog();
    const row = (cat.byLayer.get(input.layer.toUpperCase()) ?? []).find((s) => s.name === input.service);
    const scope: DashboardScope = input.instance ? 'instance' : input.endpoint ? 'endpoint' : 'service';

    // Per-expression series labels: use the model's `labels` when given; else,
    // for a MULTI-expression chart, fall back to the expressions themselves so
    // the lines stay distinct instead of all inheriting the widget title. A
    // single expression keeps the title (readable) as before.
    const expressionLabels =
      input.labels && input.labels.length > 0
        ? input.labels
        : input.expressions.length > 1
          ? input.expressions
          : undefined;

    const spec: DashboardWidget = {
      id: 'ai_fig',
      title: input.title,
      type,
      expressions: input.expressions,
      expressionLabels,
      unit: input.unit,
    };

    const { widgets } = await runWidgets(
      [spec],
      {
        service: input.service,
        serviceId: row?.id,
        instance: input.instance ?? null,
        endpoint: input.endpoint ?? null,
        scope,
        normal: row ? row.normal !== false : true,
      },
      ctx.window,
      { opts: ctx.opts, bulkSize: ctx.bulkSize },
    );
    const result = widgets[0] ?? { id: 'ai_fig', error: 'no result' };

    ctx.emitFigure({
      title: input.title,
      group: input.group,
      figures: [{ spec, result, xaxis: type === 'line' ? ctx.range : undefined }],
    });
    return `Captured ${type} "${input.title}" (${summarize(type, result)}).`;
  }

  // ONE tool with a `type` discriminator rather than five near-identical ones.
  // They always shared a description template and an input schema — the only
  // difference was which widget type the MQE's shape calls for — so five
  // entries cost five copies of the same parameter list in every tools/list.
  // The per-type guidance moves into the `type` parameter's own description,
  // which is where the model reads it while choosing.
  const figPrompt = toolPrompt('visualization', 'show_figure');
  const figureTool: StructuredToolInterface = tool(
    (input: RenderInput & { type: DashboardWidgetType }) => render(input.type, input),
    {
      name: 'show_figure',
      // Draws a card; see EMITS_CARD.
      metadata: EMITS_CARD,
      description: figPrompt.description,
      schema: renderInput.extend({
        type: z.enum(WIDGET_TYPES).describe(figPrompt.p('type')),
      }),
    },
  );

  // show_widget renders an EXISTING catalog widget by id with the template's
  // FULL config (tip/explanation, unit, format, valueMap, thresholds, per-rank
  // legends) — captured whole, so the figure persists mqe + explanation +
  // response + config. Preferred over show_figure for a catalog metric.
  const widgetPrompt = toolPrompt('visualization', 'show_widget');
  const widgetTool = tool(
    async ({
      layer,
      scope,
      service,
      widgetId,
      instance,
      endpoint,
      group,
    }: {
      layer: string;
      scope?: DashboardScope;
      service: string;
      widgetId: string;
      instance?: string;
      endpoint?: string;
      group?: string;
    }): Promise<string> => {
      if (!ctx.hasVerb('metrics:read')) return 'Permission denied: the current user lacks metrics:read.';
      if (instance && endpoint) return 'Invalid scope: pass instance OR endpoint, not both.';
      const eff = await resolveEffectiveLayer(ctx.uiTemplateClient, layer);
      if (eff.blocked || !eff.template)
        return `No template for layer "${layer.toUpperCase()}" (${eff.blocked ? 'template store unreachable' : 'unknown layer'}).`;
      const sc: DashboardScope = scope ?? (instance ? 'instance' : endpoint ? 'endpoint' : 'service');
      const widget = flattenEveryTabPanel(allWidgetsForScope(eff.template, sc)).find((w) => w.id === widgetId);
      if (!widget)
        return `No widget "${widgetId}" on ${layer.toUpperCase()}/${sc}. Call kb_browse_catalog(${layer}, ${sc}) for the widget ids.`;
      if (widget.type === 'tab') return `"${widgetId}" is a tab container — pass one of its inner widget ids.`;
      const cat = await catalog();
      const row = (cat.byLayer.get(layer.toUpperCase()) ?? []).find((s) => s.name === service);
      const { widgets } = await runWidgets(
        [widget],
        {
          service,
          serviceId: row?.id,
          instance: instance ?? null,
          endpoint: endpoint ?? null,
          scope: sc,
          normal: row ? row.normal !== false : true,
        },
        ctx.window,
        { opts: ctx.opts, bulkSize: ctx.bulkSize },
      );
      const result = widgets[0] ?? { id: widget.id, error: 'no result' };
      ctx.emitFigure({
        title: widget.title,
        group,
        figures: [{ spec: widget, result, xaxis: widget.type === 'line' ? ctx.range : undefined }],
      });
      return `Captured "${widget.title}" (${summarize(widget.type, result)})${widget.tip ? ` — ${widget.tip}` : ''}.`;
    },
    {
      name: 'show_widget',
      // Draws a card; see EMITS_CARD.
      metadata: EMITS_CARD,
      description: widgetPrompt.description,
      schema: z.object({
        layer: z.string().describe(widgetPrompt.p('layer')),
        scope: z.enum(['service', 'instance', 'endpoint']).optional().describe(widgetPrompt.p('scope')),
        service: z.string().describe(widgetPrompt.p('service')),
        widgetId: z.string().describe(widgetPrompt.p('widgetId')),
        instance: z.string().optional().describe(widgetPrompt.p('instance')),
        endpoint: z.string().optional().describe(widgetPrompt.p('endpoint')),
        group: z.string().optional().describe(widgetPrompt.p('group')),
      }),
    },
  );

  // show_hierarchy renders the topology page's cross-layer Smartscape overlay
  // inline: the focus service + the same logical service projected into upper
  // (K8S_SERVICE ← MESH ← GENERAL) and lower (→ infra) layers. Params only — the
  // BFF resolves the peers from getServiceHierarchy; the UI draws the ribbon.
  const hierarchyPrompt = toolPrompt('visualization', 'show_hierarchy');
  const hierarchyTool = tool(
    async ({ layer, service, title }: { layer: string; service: string; title?: string }): Promise<string> => {
      if (!ctx.hasVerb('topology:read')) return 'Permission denied: the current user lacks topology:read.';
      const cat = await catalog();
      const row = (cat.byLayer.get(layer.toUpperCase()) ?? []).find((s) => s.name === service);
      if (!row) return `Unknown service "${service}" in layer ${layer}. Use list_services first.`;
      const res = await getServiceHierarchy(ctx.config.current, row.id, layer, ctx.fetch);
      // Order layers request-near → infra (level DESC), matching the topology
      // overlay's top-to-bottom stack; unknown-level layers fall to the end.
      const levelOf = new Map(res.levels.map((L) => [L.layer, L.level] as const));
      const ordered = [...res.peers].sort((a, b) => {
        const la = levelOf.get(a.layer);
        const lb = levelOf.get(b.layer);
        if (la !== undefined && lb !== undefined && la !== lb) return lb - la;
        if (la !== undefined && lb === undefined) return -1;
        if (lb !== undefined && la === undefined) return 1;
        return a.layer.localeCompare(b.layer);
      });
      const groups: HierarchyGroup[] = ordered.map((g) => ({
        layer: g.layer,
        peers: g.services.map((s) => ({ id: s.id, name: s.name, normal: s.normal, role: s.role })),
      }));
      ctx.emitHierarchy({
        title: title || `Hierarchy — ${service}`,
        layer: layer.toUpperCase(),
        service,
        serviceId: row.id,
        groups,
        reachable: res.reachable,
        errorReason: res.reachable ? null : (res.error ?? 'hierarchy unreachable'),
        // Always frozen: carry the raw hierarchy so the embedded overlay replays
        // statically (or its empty/unreachable state); it never re-queries.
        replayData: res,
      });
      const peerCount = groups.reduce((n, g) => n + g.peers.filter((p) => p.role !== 'self').length, 0);
      return res.reachable
        ? `Captured the cross-layer hierarchy for ${service}: ${peerCount} peer(s) across ${groups.length} layer(s).`
        : `Hierarchy for ${service} is unreachable (${res.error ?? 'no data'}).`;
    },
    {
      name: 'show_hierarchy',
      // Draws a card; see EMITS_CARD.
      metadata: EMITS_CARD,
      description: hierarchyPrompt.description,
      schema: z.object({
        layer: z.string().describe(hierarchyPrompt.p('layer')),
        service: z.string().describe(hierarchyPrompt.p('service')),
        title: z.string().optional().describe(hierarchyPrompt.p('title')),
      }),
    },
  );

  // show_topology renders the service's FOCUSED one-hop dependency topology
  // inline — the ego graph: the service + its DIRECT upstream callers and DIRECT
  // downstream dependencies. NOT the whole-layer map. It runs the SAME builder
  // the Topology tab uses (depth 1), so the block carries the WHOLE graph —
  // nodes+edges WITH metric values + edge series — as a snapshot: the embedded
  // view seeds from it (static on reload) and the model reads real values.
  const topologyPrompt = toolPrompt('visualization', 'show_topology');
  const topologyTool = tool(
    async ({ layer, service, services, depth, title }: { layer: string; service?: string; services?: string[]; depth?: number; title?: string }): Promise<string> => {
      if (!ctx.hasVerb('topology:read')) return 'Permission denied: the current user lacks topology:read.';
      const cat = await catalog();
      // One name or several. The map seeds from a LIST of focus services at a
      // BFS depth, so two services that call each other can be drawn in ONE
      // graph rather than as two ego graphs repeating the edge between them.
      const wanted = (services?.length ? services : service ? [service] : []).map((n) => n.trim()).filter(Boolean);
      if (!wanted.length) return 'Name at least one service, or use show_layer_topology for the whole layer.';
      const inLayer = cat.byLayer.get(layer.toUpperCase()) ?? [];
      const rows = wanted.map((n) => inLayer.find((r) => r.name === n));
      const missing = wanted.filter((_, i) => !rows[i]);
      if (missing.length) {
        return `Unknown service(s) ${missing.map((m) => `"${m}"`).join(', ')} in layer ${layer}. Use list_services first.`;
      }
      const row = rows[0]!;
      // TWO hops by default, because this tool is for a SUBSET. One hop shows
      // only who the named services touch, which is the answer you already had
      // when you named them; the second hop is where the rest of the path
      // appears. The whole-layer map needs one, since every service is already
      // a seed there and a further hop can only add inferred peers.
      const hops = Math.min(3, Math.max(1, Math.round(depth ?? 2)));
      // The card centres on the FIRST seed; with several, the rest ride in the
      // graph. Taken from the resolved row so it is always a real name.
      const focus = row.name;
      const alsoSeeded = rows.length > 1 ? ` (+${rows.length - 1} more seeded)` : '';
      // Same window we hand the embedded map, so it owns its time like the
      // traces/logs blocks rather than following the global topbar picker.
      const windowMinutes = Math.max(1, Math.round((ctx.range.endMs - ctx.range.startMs) / 60_000));
      const eff = await resolveEffectiveLayer(ctx.uiTemplateClient, layer);
      if (eff.blocked) {
        ctx.emitTopology({
          title: title || `Topology — ${focus}${alsoSeeded}`,
          layer: layer.toUpperCase(),
          service: focus,
          serviceId: row.id,
          upstream: [],
          downstream: [],
          reachable: false,
          errorReason: 'template store unreachable',
          windowMinutes,
          // Frozen empty response so the seeded view replays the unreachable
          // state on reload instead of treating a missing payload as live and
          // re-querying — the same zero-query contract as the success path.
          replayData: emptyTopologyResponse(
            layer.toUpperCase(),
            row.id,
            1,
            topologyConfigFor(null),
            false,
            'template store unreachable',
          ),
        });
        return `Topology for ${focus} is unavailable (template store unreachable).`;
      }
      const snapshot = await buildServiceTopology({
        opts: ctx.opts,
        perf: ctx.config.current.performance,
        window: ctx.window,
        coldStage: false,
        cfg: topologyConfigFor(eff.template),
        layerKey: layer.toUpperCase(),
        // Comma-joined ids: how the builder takes several seeds, and how the
        // layer's own map page passes a roster selection.
        serviceArg: rows.map((r) => r!.id).join(','),
        depth: hops,
      });
      const nodeById = new Map(snapshot.nodes.map((n) => [n.id, n]));
      const toPeer = (id: string): TopoPeer | null => {
        const n = nodeById.get(id);
        return n ? { id: n.id, name: n.name, isReal: n.isReal, type: n.type, layer: n.layers?.[0] ?? null } : null;
      };
      const upstream = snapshot.calls.filter((c) => c.target === row.id).map((c) => toPeer(c.source)).filter((p): p is TopoPeer => !!p);
      const downstream = snapshot.calls.filter((c) => c.source === row.id).map((c) => toPeer(c.target)).filter((p): p is TopoPeer => !!p);
      const tooLarge = !!snapshot.tooLarge;
      ctx.emitTopology({
        title: title || `Topology — ${focus}${alsoSeeded}`,
        layer: layer.toUpperCase(),
        service: focus,
        serviceId: row.id,
        upstream,
        downstream,
        depth: hops,
        reachable: snapshot.reachable,
        errorReason: snapshot.reachable ? null : (snapshot.error ?? 'topology unreachable'),
        windowMinutes,
        // ALWAYS carry the replayData — the block is a static file of what was read.
        // If the read had no value (empty / unreachable / too-large), the seeded
        // view replays THAT state ("no data" / "unreachable" / "too large"),
        // frozen; it never re-queries on reload.
        replayData: snapshot,
      });
      if (!snapshot.reachable) return `Topology for ${focus} is unreachable (${snapshot.error ?? 'no data'}).`;
      if (tooLarge) return `Topology for ${focus} is too large to draw legibly (${snapshot.tooLarge!.nodes} nodes, ${snapshot.tooLarge!.edges} edges). Narrow the scope.`;
      return summarizeTopology(snapshot, row.id, focus);
    },
    {
      name: 'show_topology',
      // Draws a card; see EMITS_CARD.
      metadata: EMITS_CARD,
      description: topologyPrompt.description,
      schema: z.object({
        layer: z.string().describe(topologyPrompt.p('layer')),
        service: z.string().optional().describe(topologyPrompt.p('service')),
        services: z.array(z.string()).optional().describe(topologyPrompt.p('services')),
        depth: z.number().int().min(1).max(3).optional().describe(topologyPrompt.p('depth')),
        title: z.string().optional().describe(topologyPrompt.p('title')),
      }),
    },
  );

  // show_layer_topology draws the WHOLE layer, not one service's neighbourhood.
  //
  // A separate capability from show_topology rather than an optional argument on
  // it: they answer different questions. "Who does this service talk to" is an
  // ego graph and stays one hop; "what does this layer look like" is every
  // service at once, and walking it service-by-service returns the same edges
  // repeatedly and never says how many services there are.
  const layerTopologyPrompt = toolPrompt('visualization', 'show_layer_topology');
  const layerTopologyTool = tool(
    async ({ layer, title }: { layer: string; title?: string }): Promise<string> => {
      if (!ctx.hasVerb('topology:read')) return 'Permission denied: the current user lacks topology:read.';
      const windowMinutes = Math.max(1, Math.round((ctx.range.endMs - ctx.range.startMs) / 60_000));
      const eff = await resolveEffectiveLayer(ctx.uiTemplateClient, layer);
      if (eff.blocked) {
        return `The ${layer.toUpperCase()} layer map is unavailable (template store unreachable).`;
      }
      const snapshot = await buildServiceTopology({
        opts: ctx.opts,
        perf: ctx.config.current.performance,
        window: ctx.window,
        coldStage: false,
        cfg: topologyConfigFor(eff.template),
        layerKey: layer.toUpperCase(),
        // No seed ids: an empty serviceArg is what asks OAP for the whole layer,
        // the same call the layer's own map page makes.
        serviceArg: '',
        depth: 1,
      });
      if (!snapshot.reachable) {
        return `The ${layer.toUpperCase()} layer map is unreachable (${snapshot.error ?? 'no data'}).`;
      }
      ctx.emitTopology({
        title: title || `${layer.toUpperCase()} layer map`,
        layer: layer.toUpperCase(),
        // No focus: this IS the whole layer. The block reads an empty serviceId
        // as "no ego", which is the map view's own natural state.
        service: '',
        serviceId: '',
        upstream: [],
        downstream: [],
        depth: 1,
        reachable: true,
        windowMinutes,
        replayData: snapshot,
      });
      // Over the limit the builder returns an EMPTY graph with the counts it
      // would have had — it refuses rather than truncating, because a partial
      // map reads as the whole one. Reporting it as "capped, so it is SHORT"
      // would describe a trimmed graph that does not exist.
      if (snapshot.tooLarge) {
        return (
          `The ${layer.toUpperCase()} layer map is too large to draw legibly ` +
          `(${snapshot.tooLarge.nodes} nodes, ${snapshot.tooLarge.edges} edges) and nothing was captured. ` +
          `Narrow it: name the services you care about with show_topology, or shorten the window.`
        );
      }
      const real = snapshot.nodes.filter((n) => n.isReal !== false).length;
      const inferred = snapshot.nodes.length - real;
      return (
        `Captured the whole ${layer.toUpperCase()} layer map over the last ${windowMinutes} min: ` +
        `${snapshot.nodes.length} node(s) (${real} observed, ${inferred} inferred peers) and ${snapshot.calls.length} call(s). ` +
        `The nodes and the calls between them are in this result — present them as two tables, not as one service at a time.`
      );
    },
    {
      name: 'show_layer_topology',
      // Draws a card; see EMITS_CARD.
      metadata: EMITS_CARD,
      description: layerTopologyPrompt.description,
      schema: z.object({
        layer: z.string().describe(layerTopologyPrompt.p('layer')),
        title: z.string().optional().describe(layerTopologyPrompt.p('title')),
      }),
    },
  );

  // show_deployment mounts the real per-service Deployment view inline (read-
  // only): the instance-to-instance call graph WITHIN one service. Service-
  // scoped, so the tool resolves the serviceId (the deployment query keys on it)
  // and hands the UI a frozen window; the UI view fetches its own graph and owns
  // the pan/zoom + node/edge detail.
  const deploymentPrompt = toolPrompt('visualization', 'show_deployment');
  const deploymentTool = tool(
    async ({ layer, service, title }: { layer: string; service: string; title?: string }): Promise<string> => {
      if (!ctx.hasVerb('topology:read')) return 'Permission denied: the current user lacks topology:read.';
      const cat = await catalog();
      const row = (cat.byLayer.get(layer.toUpperCase()) ?? []).find((s) => s.name === service);
      if (!row) return `Unknown service "${service}" in layer ${layer}. Use list_services first.`;
      const windowMinutes = Math.max(1, Math.round((ctx.range.endMs - ctx.range.startMs) / 60_000));
      const eff = await resolveEffectiveLayer(ctx.uiTemplateClient, layer);
      if (eff.blocked) return `Deployment for ${service} is unavailable (template store unreachable).`;
      const cfg = deploymentConfigFor(eff.template);
      if (!cfg) return `The ${layer.toUpperCase()} layer doesn't configure a deployment view (no intra-service instance graph).`;
      const snapshot = await buildDeployment({
        opts: ctx.opts,
        perf: ctx.config.current.performance,
        window: ctx.window,
        coldStage: false,
        cfg,
        layerKey: layer.toUpperCase(),
        serviceId: row.id,
      });
      ctx.emitDeployment({
        title: title || `Deployment — ${service}`,
        layer: layer.toUpperCase(),
        service,
        serviceId: row.id,
        windowMinutes,
        // Always frozen: replay the captured graph (or its empty/unreachable state).
        replayData: snapshot,
      });
      if (!snapshot.reachable) return `Deployment for ${service} is unreachable (${snapshot.error ?? 'no data'}).`;
      // A role-clustered deployment (e.g. BanyanDB) keeps its metric defs under
      // roles[].nodeMetrics, not the top-level list — union both, else the node
      // values (which ARE populated, keyed by the role's metric ids) read blank.
      const depLegend = dedupeLegend([...(cfg.nodeMetrics ?? []), ...(cfg.roles ?? []).flatMap((r) => r.nodeMetrics ?? [])]);
      const nodes = summarizeMapNodes(snapshot.nodes, depLegend, 8);
      const depName = new Map(snapshot.nodes.map((n) => [n.id, n.name]));
      const depGap = edgeGapSummary(snapshot.calls, (id) => depName.get(id) ?? id, pairedLinkDefs(cfg.linkServerMetrics ?? [], cfg.linkClientMetrics ?? []), 6);
      return `Deployment of ${service}: ${snapshot.nodes.length} instance(s), ${snapshot.calls.length} intra-service edge(s).${nodes ? ` ${nodes}.` : ''}${depGap}`;
    },
    {
      name: 'show_deployment',
      // Draws a card; see EMITS_CARD.
      metadata: EMITS_CARD,
      description: deploymentPrompt.description,
      schema: z.object({
        layer: z.string().describe(deploymentPrompt.p('layer')),
        service: z.string().describe(deploymentPrompt.p('service')),
        title: z.string().optional().describe(deploymentPrompt.p('title')),
      }),
    },
  );

  // show_instance_topology mounts the real per-PAIR instance map inline (read-
  // only): the instances of a SOURCE (client) service and a DEST (server) service
  // as two columns, with the instance-to-instance calls between them. The tool
  // resolves BOTH service ids; the two must have a call relationship (client →
  // server) or the map is empty. The UI owns pan/zoom + node/edge detail.
  const instanceTopologyPrompt = toolPrompt('visualization', 'show_instance_topology');
  const instanceTopologyTool = tool(
    async ({ layer, sourceService, destService, title }: { layer: string; sourceService: string; destService: string; title?: string }): Promise<string> => {
      if (!ctx.hasVerb('topology:read')) return 'Permission denied: the current user lacks topology:read.';
      const cat = await catalog();
      const rows = cat.byLayer.get(layer.toUpperCase()) ?? [];
      const client = rows.find((s) => s.name === sourceService);
      if (!client) return `Unknown source service "${sourceService}" in layer ${layer}. Use list_services first.`;
      const server = rows.find((s) => s.name === destService);
      if (!server) return `Unknown dest service "${destService}" in layer ${layer}. Use list_services first.`;
      const windowMinutes = Math.max(1, Math.round((ctx.range.endMs - ctx.range.startMs) / 60_000));
      const eff = await resolveEffectiveLayer(ctx.uiTemplateClient, layer);
      if (eff.blocked) return `The instance map is unavailable (template store unreachable).`;
      const cfg = instanceTopologyConfigFor(eff.template);
      if (!cfg) return `The ${layer.toUpperCase()} layer doesn't configure an instance map.`;
      const snapshot = await buildInstanceTopology({
        opts: ctx.opts,
        perf: ctx.config.current.performance,
        window: ctx.window,
        coldStage: false,
        cfg,
        layerKey: layer.toUpperCase(),
        clientServiceId: client.id,
        serverServiceId: server.id,
      });
      ctx.emitInstanceTopology({
        title: title || `Instance map — ${sourceService} → ${destService}`,
        layer: layer.toUpperCase(),
        clientService: sourceService,
        clientServiceId: client.id,
        serverService: destService,
        serverServiceId: server.id,
        windowMinutes,
        // Always frozen: replay the captured pair map (or its empty/unreachable state).
        replayData: snapshot,
      });
      if (!snapshot.reachable) return `The instance map for ${sourceService} → ${destService} is unreachable (${snapshot.error ?? 'no data'}).`;
      if (snapshot.nodes.length === 0) return `${sourceService} → ${destService}: no instance-level call relationship in this window (empty map).`;
      const nodes = summarizeMapNodes(snapshot.nodes, cfg.nodeMetrics ?? [], 8);
      const instName = new Map(snapshot.nodes.map((n) => [n.id, n.name]));
      const instGap = edgeGapSummary(snapshot.calls, (id) => instName.get(id) ?? id, pairedLinkDefs(cfg.linkServerMetrics ?? [], cfg.linkClientMetrics ?? []), 6);
      return `Instance map ${sourceService} → ${destService}: ${snapshot.nodes.length} instance(s), ${snapshot.calls.length} edge(s).${nodes ? ` ${nodes}.` : ''}${instGap}`;
    },
    {
      name: 'show_instance_topology',
      // Draws a card; see EMITS_CARD.
      metadata: EMITS_CARD,
      description: instanceTopologyPrompt.description,
      schema: z.object({
        layer: z.string().describe(instanceTopologyPrompt.p('layer')),
        sourceService: z.string().describe(instanceTopologyPrompt.p('sourceService')),
        destService: z.string().describe(instanceTopologyPrompt.p('destService')),
        title: z.string().optional().describe(instanceTopologyPrompt.p('title')),
      }),
    },
  );

  // show_endpoint_dependency mounts the real per-endpoint API-dependency view
  // inline (read-only). Service-scoped: the tool resolves the serviceId; the
  // embedded view auto-picks the service's top endpoint and draws its upstream/
  // downstream dependency chain. The UI owns the expand + node/edge detail.
  const endpointDependencyPrompt = toolPrompt('visualization', 'show_endpoint_dependency');
  const endpointDependencyTool = tool(
    async ({ layer, service, endpoint, title }: { layer: string; service: string; endpoint?: string; title?: string }): Promise<string> => {
      if (!ctx.hasVerb('topology:read')) return 'Permission denied: the current user lacks topology:read.';
      const cat = await catalog();
      const row = (cat.byLayer.get(layer.toUpperCase()) ?? []).find((s) => s.name === service);
      if (!row) return `Unknown service "${service}" in layer ${layer}. Use list_services first.`;
      const windowMinutes = Math.max(1, Math.round((ctx.range.endMs - ctx.range.startMs) / 60_000));
      const eff = await resolveEffectiveLayer(ctx.uiTemplateClient, layer);
      if (eff.blocked) return `API dependency for ${service} is unavailable (template store unreachable).`;
      // Naming the endpoint pins the chain to THAT one; leaving it out lets the
      // builder pick the service's busiest, and either way the response's
      // endpointId records which was drawn so a reload replays the same chain.
      const snapshot = await buildEndpointDependency({
        opts: ctx.opts,
        perf: ctx.config.current.performance,
        window: ctx.window,
        coldStage: false,
        cfg: endpointDependencyConfigFor(eff.template),
        layerKey: layer.toUpperCase(),
        service: { id: row.id, name: row.name, normal: row.normal !== false },
        endpointArg: endpoint ?? '',
      });
      ctx.emitEndpointDependency({
        title: title || `API dependency — ${service}`,
        layer: layer.toUpperCase(),
        service,
        serviceId: row.id,
        windowMinutes,
        // Always frozen: replay the captured chain (or its empty/no-endpoint state).
        replayData: snapshot,
      });
      if (!snapshot.reachable) return `API dependency for ${service} is unreachable (${snapshot.error ?? 'no data'}).`;
      if (!snapshot.endpointId) {
        // Two different failures wore one sentence: a service with no endpoints
        // at all, and a NAMED endpoint that did not match one. The second told
        // the reader the service was silent when it was not.
        return endpoint
          ? `No endpoint matching "${endpoint}" on ${service} in this window. Use kb_resolve_scope_drill(serviceId, "endpoint") to list the real names, or omit it to take the busiest.`
          : `${service} exposes no endpoints in this window (no dependency chain to draw).`;
      }
      const nodes = summarizeMapNodes(snapshot.nodes, snapshot.config.nodeMetrics ?? [], 8);
      // Name WHICH endpoint the chain hangs off. Saying "its primary endpoint"
      // when the caller named one is a claim about the wrong endpoint.
      const which = snapshot.endpoint ? `endpoint ${snapshot.endpoint}` : 'its busiest endpoint';
      return `API dependency for ${service} (${which}): ${snapshot.nodes.length} node(s), ${snapshot.calls.length} dependency edge(s).${nodes ? ` ${nodes}.` : ''}`;
    },
    {
      name: 'show_endpoint_dependency',
      // Draws a card; see EMITS_CARD.
      metadata: EMITS_CARD,
      description: endpointDependencyPrompt.description,
      schema: z.object({
        layer: z.string().describe(endpointDependencyPrompt.p('layer')),
        service: z.string().describe(endpointDependencyPrompt.p('service')),
        endpoint: z.string().optional().describe(endpointDependencyPrompt.p('endpoint')),
        title: z.string().optional().describe(endpointDependencyPrompt.p('title')),
      }),
    },
  );

  // show_traces mounts the real native Traces view inline (read-only), focused
  // on the service — the operator gets the actual trace LIST + span WATERFALL to
  // browse. Params only; the UI view fetches its own traces + owns the
  // list→detail interaction.
  const tracesPrompt = toolPrompt('visualization', 'show_traces');
  const tracesTool = tool(
    async ({ layer, service, title }: { layer: string; service: string; title?: string }): Promise<string> => {
      if (!ctx.hasVerb('traces:read')) return 'Permission denied: the current user lacks traces:read.';
      const cat = await catalog();
      const row = (cat.byLayer.get(layer.toUpperCase()) ?? []).find((s) => s.name === service);
      if (!row) return `Unknown service "${service}" in layer ${layer}. Use list_services first.`;
      // Freeze the native list (frozen-always) so the block replays offline.
      const windowMinutes = rangeWindowMinutes(ctx.range);
      const offsetMinutes = await getServerOffsetMinutes(ctx.config, ctx.fetch);
      const cfgTraceCap = ctx.config.current.performance.limits.maxPageSize.traces;
      const maxTraces = Math.min(TRACE_CAP, cfgTraceCap);
      const native = await fetchNativeList(
        ctx.opts,
        { service, serviceId: row.id, startMs: ctx.range.startMs, endMs: ctx.range.endMs, pageSize: maxTraces },
        false,
        offsetMinutes,
        cfgTraceCap,
      );
      // v2 rows carry inline spans; v1 rows have none, so each is hydrated with
      // a per-trace fetch — the compatibility lives HERE, inside Horizon, so a
      // v1 deployment's waterfall replays offline exactly like a v2 one and
      // nothing downstream has to know which protocol answered.
      if (native.api === 'queryBasicTraces') {
        // v1 rows are SEGMENT-shaped: several rows can share one traceId, so
        // fetch each distinct trace once and share its spans across its rows.
        const spansByTrace = new Map<string, NativeSpan[]>();
        for (const t of native.traces) {
          const tid = t.traceIds[0];
          if (!tid) continue;
          let spans = spansByTrace.get(tid);
          if (!spans) {
            spans = await fetchNativeTraceSpans(ctx.opts, tid);
            spansByTrace.set(tid, spans);
          }
          t.spans = spans;
        }
      } else {
        native.traces = native.traces.slice(0, maxTraces);
      }
      const replayData: TraceListResponse = { generatedAt: Date.now(), source: 'native', native };
      ctx.emitTraces({
        title: title || `Traces — ${service}`,
        layer: layer.toUpperCase(),
        service,
        serviceId: row.id,
        windowMinutes,
        replayData,
      });
      if (!native.reachable) return `Traces for ${service} are unavailable (${native.error ?? 'unreachable'}).`;
      return `Captured ${native.traces.length} native trace(s) for ${service} (${native.api === 'queryBasicTraces' ? 'v1' : 'v2'}). The operator can browse the frozen list and open a span waterfall in the chat.`;
    },
    {
      name: 'show_traces',
      // Draws a card; see EMITS_CARD.
      metadata: EMITS_CARD,
      description: tracesPrompt.description,
      schema: z.object({
        layer: z.string().describe(tracesPrompt.p('layer')),
        service: z.string().describe(tracesPrompt.p('service')),
        title: z.string().optional().describe(tracesPrompt.p('title')),
      }),
    },
  );

  // Zipkin traces are keyed on Zipkin's OWN service universe (span
  // localEndpoint.serviceName), which is GLOBAL and differs from the SkyWalking
  // service names. So the assistant first LISTS the Zipkin services (this tool),
  // matches the intended service by name, then renders with show_zipkin_traces.
  const listZipkinServicesPrompt = toolPrompt('visualization', 'list_zipkin_services');
  const listZipkinServicesTool = tool(
    async ({ keyword }: { keyword?: string }): Promise<string> => {
      if (!ctx.hasVerb('traces:read')) return 'Permission denied: the current user lacks traces:read.';
      const oap = ctx.config.current.oap;
      let names: string[];
      try {
        names = await zipkinFetchServices({
          queryUrl: oap.zipkinUrl,
          timeoutMs: oap.timeoutMs,
          auth: oap.auth,
          fetch: ctx.fetch,
        });
      } catch (err) {
        return `Could not reach the Zipkin service list (${err instanceof Error ? err.message : String(err)}).`;
      }
      const k = keyword?.trim().toLowerCase();
      const filtered = k ? names.filter((n) => n.toLowerCase().includes(k)) : names;
      const CAP = 200;
      const out = filtered.slice(0, CAP);
      return JSON.stringify({ services: out, total: filtered.length, truncated: filtered.length > out.length });
    },
    {
      name: 'list_zipkin_services',
      description: listZipkinServicesPrompt.description,
      schema: z.object({
        keyword: z.string().optional().describe(listZipkinServicesPrompt.p('keyword')),
      }),
    },
  );

  // show_zipkin_traces mounts the real Zipkin Traces view inline (read-only),
  // focused on a ZIPKIN service name the model matched via list_zipkin_services.
  const zipkinTracesPrompt = toolPrompt('visualization', 'show_zipkin_traces');
  const zipkinTracesTool = tool(
    async ({ layer, service, title }: { layer: string; service: string; title?: string }): Promise<string> => {
      if (!ctx.hasVerb('traces:read')) return 'Permission denied: the current user lacks traces:read.';
      const oap = ctx.config.current.oap;
      const zopts = { queryUrl: oap.zipkinUrl, timeoutMs: oap.timeoutMs, auth: oap.auth, fetch: ctx.fetch };
      // Freeze the Zipkin list WITH spans so the waterfall replays offline.
      let replayData: ZipkinTraceListResponse;
      const cap = Math.min(TRACE_CAP, ctx.config.current.performance.limits.maxPageSize.traces);
      try {
        const fetched = await zipkinFetchTraces(
          zopts,
          {
            serviceName: service,
            endTs: ctx.range.endMs,
            lookback: ctx.range.endMs - ctx.range.startMs,
            limit: overFetchSize(cap),
          },
          true,
        );
        const { rows, hasNext } = takeOverFetched(fetched, cap);
        replayData = { source: 'zipkin', traces: rows, hasNext, reachable: true };
      } catch (err) {
        replayData = { source: 'zipkin', traces: [], hasNext: false, reachable: false, error: err instanceof Error ? err.message : String(err) };
      }
      ctx.emitZipkinTraces({
        title: title || `Zipkin traces — ${service}`,
        layer: layer.toUpperCase(),
        service,
        windowMinutes: rangeWindowMinutes(ctx.range),
        replayData,
      });
      if (!replayData.reachable) return `Could not reach Zipkin for ${service} (${replayData.error}).`;
      return `Captured ${replayData.traces.length} Zipkin trace(s) for ${service}. The operator can browse the frozen list and open a span waterfall in the chat. (If empty, the name may not be a Zipkin service — re-check with list_zipkin_services.)`;
    },
    {
      name: 'show_zipkin_traces',
      // Draws a card; see EMITS_CARD.
      metadata: EMITS_CARD,
      description: zipkinTracesPrompt.description,
      schema: z.object({
        layer: z.string().describe(zipkinTracesPrompt.p('layer')),
        service: z.string().describe(zipkinTracesPrompt.p('service')),
        title: z.string().optional().describe(zipkinTracesPrompt.p('title')),
      }),
    },
  );

  // show_logs mounts the real layer Logs view inline (read-only), focused on the
  // service — the operator gets the actual log stream + row→detail. Distinct
  // from fetch_pod_logs (the k8s on-demand live tail); this is the layer Logs tab.
  const logsPrompt = toolPrompt('visualization', 'show_logs');
  const logsTool = tool(
    async ({ layer, service, title }: { layer: string; service: string; title?: string }): Promise<string> => {
      if (!ctx.hasVerb('logs:read')) return 'Permission denied: the current user lacks logs:read.';
      const cat = await catalog();
      const row = (cat.byLayer.get(layer.toUpperCase()) ?? []).find((s) => s.name === service);
      if (!row) return `Unknown service "${service}" in layer ${layer}. Use list_services first.`;
      const maxLogs = Math.min(LIST_CAP, ctx.config.current.performance.limits.maxPageSize.logs);
      // Logs query at SECOND step — format the window in SECOND (ctx.window is the
      // chat's MINUTE-step string; mixing step + format throws verifyDateTimeString).
      const logOffset = await getServerOffsetMinutes(ctx.config, ctx.fetch);
      const logWindow = { start: fmtSecond(ctx.range.startMs, logOffset), end: fmtSecond(ctx.range.endMs, logOffset) };
      const replayData = await fetchLogs(
        ctx.opts,
        { serviceId: row.id },
        logWindow,
        { pageNum: 1, pageSize: maxLogs },
        false,
      );
      ctx.emitLogs({
        title: title || `Logs — ${service}`,
        layer: layer.toUpperCase(),
        service,
        serviceId: row.id,
        windowMinutes: rangeWindowMinutes(ctx.range),
        replayData,
      });
      if (!replayData.reachable) return `Logs for ${service} are unavailable (${replayData.error ?? 'unreachable'}).`;
      return `Captured ${replayData.logs.length} log row(s) for ${service}. The operator can browse the frozen stream and open a record's detail in the chat.`;
    },
    {
      name: 'show_logs',
      // Draws a card; see EMITS_CARD.
      metadata: EMITS_CARD,
      description: logsPrompt.description,
      schema: z.object({
        layer: z.string().describe(logsPrompt.p('layer')),
        service: z.string().describe(logsPrompt.p('service')),
        title: z.string().optional().describe(logsPrompt.p('title')),
      }),
    },
  );

  // show_browser_logs mounts the real browser-monitoring error list inline
  // (read-only), focused on the browser app — the operator gets the client-side
  // error stream + its row→stack-trace detail (BROWSER-family layers only).
  const browserErrorsPrompt = toolPrompt('visualization', 'show_browser_logs');
  const browserErrorsTool = tool(
    async ({ layer, service, title }: { layer: string; service: string; title?: string }): Promise<string> => {
      if (!ctx.hasVerb('browser-errors:read')) return 'Permission denied: the current user lacks browser-errors:read.';
      const cat = await catalog();
      const row = (cat.byLayer.get(layer.toUpperCase()) ?? []).find((s) => s.name === service);
      if (!row) return `Unknown service "${service}" in layer ${layer}. Use list_services first.`;
      const maxBrowser = Math.min(LIST_CAP, ctx.config.current.performance.limits.maxPageSize.browserLogs);
      const beOffset = await getServerOffsetMinutes(ctx.config, ctx.fetch);
      const beWindow = { start: fmtSecond(ctx.range.startMs, beOffset), end: fmtSecond(ctx.range.endMs, beOffset) };
      const replayData = await fetchBrowserErrors(
        ctx.opts,
        { serviceId: row.id },
        beWindow,
        { pageNum: 1, pageSize: maxBrowser },
        false,
      );
      ctx.emitBrowserErrors({
        title: title || `Browser errors — ${service}`,
        layer: layer.toUpperCase(),
        service,
        serviceId: row.id,
        windowMinutes: rangeWindowMinutes(ctx.range),
        replayData,
      });
      if (!replayData.reachable) return `Browser errors for ${service} are unavailable (${replayData.error ?? 'unreachable'}).`;
      return `Captured ${replayData.logs.length} browser error(s) for ${service}. The operator can browse the frozen list and open a stack trace in the chat.`;
    },
    {
      name: 'show_browser_logs',
      // Draws a card; see EMITS_CARD.
      metadata: EMITS_CARD,
      description: browserErrorsPrompt.description,
      schema: z.object({
        layer: z.string().describe(browserErrorsPrompt.p('layer')),
        service: z.string().describe(browserErrorsPrompt.p('service')),
        title: z.string().optional().describe(browserErrorsPrompt.p('title')),
      }),
    },
  );

  return [
    figureTool,
    widgetTool,
    hierarchyTool,
    topologyTool,
    layerTopologyTool,
    deploymentTool,
    instanceTopologyTool,
    endpointDependencyTool,
    tracesTool,
    listZipkinServicesTool,
    zipkinTracesTool,
    logsTool,
    browserErrorsTool,
  ];
}
