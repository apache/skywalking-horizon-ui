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
 * a scalar-collapsing MQE (latest/max/min/avg-of-plain/sum) MUST use show_card;
 * series/list-shaped MQE uses show_line / show_top / show_table / show_record.
 */

import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import type { StructuredToolInterface } from '@langchain/core/tools';
import type {
  DashboardScope,
  DashboardWidget,
  DashboardWidgetResult,
  DashboardWidgetType,
} from '@skywalking-horizon-ui/api-client';
import type { AiRequestContext } from '../../context.js';
import type { HierarchyGroup, SubPageKind } from '../../types.js';
import { runWidgets } from '../../../logic/dashboard/run.js';
import { serviceLayerCatalog } from '../../../logic/services/service-layer-catalog.js';
import { getServiceHierarchy } from '../../../logic/oap/hierarchy.js';
import { getServiceEgoTopology } from '../../../logic/oap/topology.js';
import { zipkinFetchServices } from '../../../client/zipkin.js';

const renderInput = z.object({
  title: z.string().describe('Human title shown above the figure'),
  layer: z.string().describe('OAP layer key, e.g. GENERAL'),
  service: z.string().describe('Service NAME (from list_services)'),
  expressions: z.array(z.string()).min(1).describe('MQE expression(s) — use catalog MQE verbatim'),
  labels: z
    .array(z.string())
    .optional()
    .describe(
      'One short human label PER expression. REQUIRED when you pass 2+ expressions on one chart (e.g. ["read","write"]) — without it every line inherits the title and the operator cannot tell them apart. Omit for a single expression.',
    ),
  instance: z.string().optional().describe('ServiceInstance name → renders at instance scope'),
  endpoint: z.string().optional().describe('Endpoint name → renders at endpoint scope'),
  unit: z.string().optional().describe('Unit suffix, e.g. ms, %, cpm'),
  group: z
    .string()
    .optional()
    .describe(
      'Optional group label. Give several related figures the SAME group to cluster them into ONE tabbed block (e.g. an entity breakdown); omit for a standalone figure.',
    ),
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
      const first = s[0]?.data ?? [];
      const last = first.length ? first[first.length - 1] : null;
      return `${s.length} series, ${first.length} points, last ≈ ${last ?? 'n/a'}`;
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

export function visualizationTools(ctx: AiRequestContext): StructuredToolInterface[] {
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
    return `Rendered ${type} "${input.title}" (${summarize(type, result)}).`;
  }

  const make = (type: DashboardWidgetType, when: string): StructuredToolInterface =>
    tool((input: RenderInput) => render(type, input), {
      name: `show_${type}`,
      description: `Render a ${type} figure in the chat. ${when} Provide the layer, service name, and the MQE expression(s) (use catalog MQE verbatim). Pass instance/endpoint to render at that finer scope. Give several related figures the same group label to cluster them into one tabbed block.`,
      schema: renderInput,
    });

  // Sub-page tools mount an embeddable feature VIEW inline (not a widget). They
  // carry only params — the UI view fetches its own data over the chat's range.
  const SUBPAGES: Array<{
    kind: SubPageKind;
    verb: string;
    when: string;
    needsService: boolean;
  }> = [
    { kind: 'service-list', verb: 'metrics:read', when: 'the services in a layer with their key metrics', needsService: false },
  ];
  const subPageTools = SUBPAGES.map(({ kind, verb, when, needsService }) =>
    tool(
      async ({ layer, service, title }: { layer: string; service?: string; title?: string }): Promise<string> => {
        if (!ctx.hasVerb(verb)) return `Permission denied: the current user lacks ${verb}.`;
        if (needsService && !service) return `${kind} needs a service name.`;
        const heading = title || `${kind} — ${service ?? layer}`;
        ctx.emitSubPage({ kind, title: heading, layer: layer.toUpperCase(), service, range: ctx.range });
        return `Mounted the ${kind} view for ${service ?? layer}. It renders interactively in the chat.`;
      },
      {
        name: `show_${kind.replace(/-/g, '_')}`,
        description: `Render ${when} inline in the chat as an interactive view (the same component the dashboards use). Provide the layer${needsService ? ' and the service name' : ' (and optionally a service to focus)'}.`,
        schema: z.object({
          layer: z.string().describe('OAP layer key, e.g. GENERAL'),
          service: needsService
            ? z.string().describe('service NAME')
            : z.string().optional().describe('optional service NAME to focus on'),
          title: z.string().optional().describe('optional heading for the view'),
        }),
      },
    ),
  );

  // show_hierarchy renders the topology page's cross-layer Smartscape overlay
  // inline: the focus service + the same logical service projected into upper
  // (K8S_SERVICE ← MESH ← GENERAL) and lower (→ infra) layers. Params only — the
  // BFF resolves the peers from getServiceHierarchy; the UI draws the ribbon.
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
      });
      const peerCount = groups.reduce((n, g) => n + g.peers.filter((p) => p.role !== 'self').length, 0);
      return res.reachable
        ? `Rendered the cross-layer hierarchy for ${service}: ${peerCount} peer(s) across ${groups.length} layer(s).`
        : `Hierarchy for ${service} is unreachable (${res.error ?? 'no data'}).`;
    },
    {
      name: 'show_hierarchy',
      description:
        "Render a service's CROSS-LAYER hierarchy inline (the topology page's Smartscape overlay): the focused service plus the same logical service projected into its upper layers (e.g. a GENERAL service's MESH / K8S_SERVICE mirrors) and lower layers (backing infrastructure). Use this to show how one service maps across layers — NOT for same-layer dependencies (use show_topology for those). Provide the layer and service name.",
      schema: z.object({
        layer: z.string().describe('OAP layer key of the focused service, e.g. GENERAL'),
        service: z.string().describe('service NAME (from list_services)'),
        title: z.string().optional().describe('optional heading for the block'),
      }),
    },
  );

  // show_topology renders the service's FOCUSED one-hop dependency topology
  // inline — the ego graph: the service + its DIRECT upstream callers and DIRECT
  // downstream dependencies. NOT the whole-layer map. The BFF resolves the one
  // hop from getServiceEgoTopology; the UI draws two lanes around the focus.
  const topologyTool = tool(
    async ({ layer, service, title }: { layer: string; service: string; title?: string }): Promise<string> => {
      if (!ctx.hasVerb('topology:read')) return 'Permission denied: the current user lacks topology:read.';
      const cat = await catalog();
      const row = (cat.byLayer.get(layer.toUpperCase()) ?? []).find((s) => s.name === service);
      if (!row) return `Unknown service "${service}" in layer ${layer}. Use list_services first.`;
      const ego = await getServiceEgoTopology(ctx.config.current, row.id, service, ctx.window, ctx.fetch);
      const toPeer = (p: { id: string; name: string; isReal: boolean; type: string | null; layer: string | null }) => ({
        id: p.id,
        name: p.name,
        isReal: p.isReal,
        type: p.type,
        layer: p.layer,
      });
      ctx.emitTopology({
        title: title || `Topology — ${service}`,
        layer: layer.toUpperCase(),
        service,
        serviceId: row.id,
        upstream: ego.upstream.map(toPeer),
        downstream: ego.downstream.map(toPeer),
        reachable: ego.reachable,
        errorReason: ego.reachable ? null : (ego.error ?? 'topology unreachable'),
        // Hand the embedded map the same window we resolved the ego graph over,
        // so it owns its time like the traces/logs blocks instead of following
        // the global topbar picker (or the /ai default).
        windowMinutes: Math.max(1, Math.round((ctx.range.endMs - ctx.range.startMs) / 60_000)),
      });
      return ego.reachable
        ? `Rendered the one-hop topology for ${service}: ${ego.upstream.length} upstream caller(s), ${ego.downstream.length} downstream dependency(ies).`
        : `Topology for ${service} is unreachable (${ego.error ?? 'no data'}).`;
    },
    {
      name: 'show_topology',
      description:
        "Render a service's FOCUSED one-hop dependency topology inline (the ego graph): the service plus its DIRECT upstream callers (services that call it) and DIRECT downstream dependencies (services it calls). This is one hop each way — NOT the whole-layer map. Use it to show who a service talks to / walk the dependency step of an investigation. Provide the layer and service name.",
      schema: z.object({
        layer: z.string().describe('OAP layer key, e.g. GENERAL'),
        service: z.string().describe('service NAME (from list_services)'),
        title: z.string().optional().describe('optional heading for the block'),
      }),
    },
  );

  // show_deployment mounts the real per-service Deployment view inline (read-
  // only): the instance-to-instance call graph WITHIN one service. Service-
  // scoped, so the tool resolves the serviceId (the deployment query keys on it)
  // and hands the UI a frozen window; the UI view fetches its own graph and owns
  // the pan/zoom + node/edge detail.
  const deploymentTool = tool(
    async ({ layer, service, title }: { layer: string; service: string; title?: string }): Promise<string> => {
      if (!ctx.hasVerb('topology:read')) return 'Permission denied: the current user lacks topology:read.';
      const cat = await catalog();
      const row = (cat.byLayer.get(layer.toUpperCase()) ?? []).find((s) => s.name === service);
      if (!row) return `Unknown service "${service}" in layer ${layer}. Use list_services first.`;
      ctx.emitDeployment({
        title: title || `Deployment — ${service}`,
        layer: layer.toUpperCase(),
        service,
        serviceId: row.id,
        windowMinutes: Math.max(1, Math.round((ctx.range.endMs - ctx.range.startMs) / 60_000)),
      });
      return `Mounted the deployment view for ${service} — the instance-to-instance call graph within the service. The operator browses it inline.`;
    },
    {
      name: 'show_deployment',
      description:
        "Mount the per-service DEPLOYMENT view inline (read-only): the instance-to-instance call graph WITHIN one service (its instances/pods and the intra-service relations between them), the same view as the layer Deployment tab. Use it to show how a service's own instances talk to each other — NOT the cross-service topology (use show_topology for that). Provide the layer and service name.",
      schema: z.object({
        layer: z.string().describe('OAP layer key, e.g. GENERAL'),
        service: z.string().describe('service NAME (from list_services)'),
        title: z.string().optional().describe('optional heading for the block'),
      }),
    },
  );

  // show_instance_topology mounts the real per-PAIR instance map inline (read-
  // only): the instances of a SOURCE (client) service and a DEST (server) service
  // as two columns, with the instance-to-instance calls between them. The tool
  // resolves BOTH service ids; the two must have a call relationship (client →
  // server) or the map is empty. The UI owns pan/zoom + node/edge detail.
  const instanceTopologyTool = tool(
    async ({ layer, sourceService, destService, title }: { layer: string; sourceService: string; destService: string; title?: string }): Promise<string> => {
      if (!ctx.hasVerb('topology:read')) return 'Permission denied: the current user lacks topology:read.';
      const cat = await catalog();
      const rows = cat.byLayer.get(layer.toUpperCase()) ?? [];
      const client = rows.find((s) => s.name === sourceService);
      if (!client) return `Unknown source service "${sourceService}" in layer ${layer}. Use list_services first.`;
      const server = rows.find((s) => s.name === destService);
      if (!server) return `Unknown dest service "${destService}" in layer ${layer}. Use list_services first.`;
      ctx.emitInstanceTopology({
        title: title || `Instance map — ${sourceService} → ${destService}`,
        layer: layer.toUpperCase(),
        clientService: sourceService,
        clientServiceId: client.id,
        serverService: destService,
        serverServiceId: server.id,
        windowMinutes: Math.max(1, Math.round((ctx.range.endMs - ctx.range.startMs) / 60_000)),
      });
      return `Mounted the instance map for ${sourceService} → ${destService} — the instances of each service and the calls between them. The operator browses it inline. (If the two services have no call relationship in this window, the map is empty.)`;
    },
    {
      name: 'show_instance_topology',
      description:
        "Mount the per-PAIR INSTANCE-TOPOLOGY view inline (read-only): the instances of a SOURCE (client) service and a DEST (server) service as two columns, with the instance-to-instance calls BETWEEN them (the same instance-map drill-down the Topology tab opens from a call edge). Requires BOTH a source and a dest service that have a call relationship (source calls dest) — use it to show how one service's instances talk to another's. Distinct from show_deployment (one service's OWN instances) and show_topology (service-level one-hop). Provide the layer, the source (client) service name, and the dest (server) service name.",
      schema: z.object({
        layer: z.string().describe('OAP layer key, e.g. GENERAL'),
        sourceService: z.string().describe('SOURCE (client) service NAME — the caller (from list_services)'),
        destService: z.string().describe('DEST (server) service NAME — the callee it calls (from list_services)'),
        title: z.string().optional().describe('optional heading for the block'),
      }),
    },
  );

  // show_endpoint_dependency mounts the real per-endpoint API-dependency view
  // inline (read-only). Service-scoped: the tool resolves the serviceId; the
  // embedded view auto-picks the service's top endpoint and draws its upstream/
  // downstream dependency chain. The UI owns the expand + node/edge detail.
  const endpointDependencyTool = tool(
    async ({ layer, service, title }: { layer: string; service: string; title?: string }): Promise<string> => {
      if (!ctx.hasVerb('topology:read')) return 'Permission denied: the current user lacks topology:read.';
      const cat = await catalog();
      const row = (cat.byLayer.get(layer.toUpperCase()) ?? []).find((s) => s.name === service);
      if (!row) return `Unknown service "${service}" in layer ${layer}. Use list_services first.`;
      ctx.emitEndpointDependency({
        title: title || `API dependency — ${service}`,
        layer: layer.toUpperCase(),
        service,
        serviceId: row.id,
        windowMinutes: Math.max(1, Math.round((ctx.range.endMs - ctx.range.startMs) / 60_000)),
      });
      return `Mounted the API-dependency view for ${service} — its top endpoint's upstream/downstream dependency chain. The operator browses it inline (and can expand any node).`;
    },
    {
      name: 'show_endpoint_dependency',
      description:
        "Mount the per-endpoint API-DEPENDENCY view inline (read-only): the focused endpoint's upstream callers and downstream callees as a dependency chain (the same view as the layer API-dependency tab). The embedded view auto-picks the service's busiest endpoint and draws its chain; the operator can expand any node. Use it to show what a service's endpoints depend on across services. Provide the layer and service name.",
      schema: z.object({
        layer: z.string().describe('OAP layer key, e.g. GENERAL'),
        service: z.string().describe('service NAME (from list_services)'),
        title: z.string().optional().describe('optional heading for the block'),
      }),
    },
  );

  // show_traces mounts the real native Traces view inline (read-only), focused
  // on the service — the operator gets the actual trace LIST + span WATERFALL to
  // browse. Params only; the UI view fetches its own traces + owns the
  // list→detail interaction.
  const tracesTool = tool(
    async ({ layer, service, title, windowMinutes }: { layer: string; service: string; title?: string; windowMinutes?: number }): Promise<string> => {
      if (!ctx.hasVerb('traces:read')) return 'Permission denied: the current user lacks traces:read.';
      const cat = await catalog();
      const row = (cat.byLayer.get(layer.toUpperCase()) ?? []).find((s) => s.name === service);
      if (!row) return `Unknown service "${service}" in layer ${layer}. Use list_services first.`;
      ctx.emitTraces({
        title: title || `Traces — ${service}`,
        layer: layer.toUpperCase(),
        service,
        serviceId: row.id,
        windowMinutes: windowMinutes && windowMinutes > 0 ? windowMinutes : undefined,
      });
      return `Mounted the native Traces view for ${service}. The operator can browse the trace list and open a span waterfall in the chat.`;
    },
    {
      name: 'show_traces',
      description:
        "Mount the native distributed-tracing view inline for a service — the real trace LIST plus the span WATERFALL, which the operator browses (click a trace to open its spans). Use it to surface slow / erroring traces for a service so a human can inspect them; there is no tool to read individual span data yourself. Provide the layer and service name; optionally a look-back windowMinutes (default 30). ONLY for a layer whose traces run NATIVE (SkyWalking segments) — for a Zipkin-tracing layer use list_zipkin_services + show_zipkin_traces instead.",
      schema: z.object({
        layer: z.string().describe('OAP layer key, e.g. GENERAL'),
        service: z.string().describe('service NAME (from list_services)'),
        title: z.string().optional().describe('optional heading for the block'),
        windowMinutes: z.number().optional().describe('look-back window in minutes (default 30)'),
      }),
    },
  );

  // Zipkin traces are keyed on Zipkin's OWN service universe (span
  // localEndpoint.serviceName), which is GLOBAL and differs from the SkyWalking
  // service names. So the assistant first LISTS the Zipkin services (this tool),
  // matches the intended service by name, then renders with show_zipkin_traces.
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
      description:
        "List the ZIPKIN service names (the span localEndpoint.serviceName universe — GLOBAL, not per-layer, and DIFFERENT from the SkyWalking service names). Use this for a Zipkin-tracing layer to find the Zipkin-side service name that matches the SkyWalking service (or the user's phrasing), THEN pass the matched name to show_zipkin_traces. Optionally pass a keyword to narrow the list.",
      schema: z.object({
        keyword: z.string().optional().describe('case-insensitive substring to narrow the Zipkin service list'),
      }),
    },
  );

  // show_zipkin_traces mounts the real Zipkin Traces view inline (read-only),
  // focused on a ZIPKIN service name the model matched via list_zipkin_services.
  const zipkinTracesTool = tool(
    async ({ layer, service, title, windowMinutes }: { layer: string; service: string; title?: string; windowMinutes?: number }): Promise<string> => {
      if (!ctx.hasVerb('traces:read')) return 'Permission denied: the current user lacks traces:read.';
      ctx.emitZipkinTraces({
        title: title || `Zipkin traces — ${service}`,
        layer: layer.toUpperCase(),
        service,
        windowMinutes: windowMinutes && windowMinutes > 0 ? windowMinutes : undefined,
      });
      return `Mounted the Zipkin Traces view for ${service}. The operator can browse the trace list and open a span waterfall in the chat. (If no traces match, the service name may not be a Zipkin service — re-check with list_zipkin_services.)`;
    },
    {
      name: 'show_zipkin_traces',
      description:
        "Mount the Zipkin distributed-tracing view inline — the real trace LIST + span WATERFALL for a ZIPKIN service, which the operator browses. `service` MUST be a Zipkin service name from list_zipkin_services (NOT the SkyWalking name — they differ). Use this for a layer whose traces run on Zipkin (Envoy ALS / rover) after matching the service. Provide the layer (for context) and the matched Zipkin service name; optionally a look-back windowMinutes (default 30).",
      schema: z.object({
        layer: z.string().describe('OAP layer key, e.g. MESH'),
        service: z.string().describe('ZIPKIN service name (from list_zipkin_services)'),
        title: z.string().optional().describe('optional heading for the block'),
        windowMinutes: z.number().optional().describe('look-back window in minutes (default 30)'),
      }),
    },
  );

  // show_logs mounts the real layer Logs view inline (read-only), focused on the
  // service — the operator gets the actual log stream + row→detail. Distinct
  // from fetch_pod_logs (the k8s on-demand live tail); this is the layer Logs tab.
  const logsTool = tool(
    async ({ layer, service, title, windowMinutes }: { layer: string; service: string; title?: string; windowMinutes?: number }): Promise<string> => {
      if (!ctx.hasVerb('logs:read')) return 'Permission denied: the current user lacks logs:read.';
      const cat = await catalog();
      const row = (cat.byLayer.get(layer.toUpperCase()) ?? []).find((s) => s.name === service);
      if (!row) return `Unknown service "${service}" in layer ${layer}. Use list_services first.`;
      ctx.emitLogs({
        title: title || `Logs — ${service}`,
        layer: layer.toUpperCase(),
        service,
        serviceId: row.id,
        windowMinutes: windowMinutes && windowMinutes > 0 ? windowMinutes : undefined,
      });
      return `Mounted the Logs view for ${service}. The operator can browse the log stream and open a record's detail in the chat.`;
    },
    {
      name: 'show_logs',
      description:
        "Mount the layer LOGS view inline for a service — the real log stream the operator browses (click a row for its detail). Use it to surface a service's logs for a human to read. This is the layer Logs tab (stored logs); it is NOT fetch_pod_logs (that is the Kubernetes on-demand live tail). Provide the layer and service name; optionally a look-back windowMinutes (default 30).",
      schema: z.object({
        layer: z.string().describe('OAP layer key, e.g. GENERAL'),
        service: z.string().describe('service NAME (from list_services)'),
        title: z.string().optional().describe('optional heading for the block'),
        windowMinutes: z.number().optional().describe('look-back window in minutes (default 30)'),
      }),
    },
  );

  // show_browser_logs mounts the real browser-monitoring error list inline
  // (read-only), focused on the browser app — the operator gets the client-side
  // error stream + its row→stack-trace detail (BROWSER-family layers only).
  const browserErrorsTool = tool(
    async ({ layer, service, title, windowMinutes }: { layer: string; service: string; title?: string; windowMinutes?: number }): Promise<string> => {
      if (!ctx.hasVerb('browser-errors:read')) return 'Permission denied: the current user lacks browser-errors:read.';
      const cat = await catalog();
      const row = (cat.byLayer.get(layer.toUpperCase()) ?? []).find((s) => s.name === service);
      if (!row) return `Unknown service "${service}" in layer ${layer}. Use list_services first.`;
      ctx.emitBrowserErrors({
        title: title || `Browser errors — ${service}`,
        layer: layer.toUpperCase(),
        service,
        serviceId: row.id,
        windowMinutes: windowMinutes && windowMinutes > 0 ? windowMinutes : undefined,
      });
      return `Mounted the Browser errors view for ${service}. The operator can browse the client-side error list and open a stack trace in the chat.`;
    },
    {
      name: 'show_browser_logs',
      description:
        "Mount the browser-monitoring ERROR list inline for a browser app — the client-side JS error stream the operator browses (click a row for its stack trace). Use it for a BROWSER-family layer's app to surface front-end errors for a human. Provide the layer and service (browser-app) name; optionally a look-back windowMinutes (default 30).",
      schema: z.object({
        layer: z.string().describe('OAP browser-layer key'),
        service: z.string().describe('browser-app service NAME (from list_services)'),
        title: z.string().optional().describe('optional heading for the block'),
        windowMinutes: z.number().optional().describe('look-back window in minutes (default 30)'),
      }),
    },
  );

  return [
    make('line', 'Use for a time series (a metric that varies over the window).'),
    make('card', 'Use ONLY when the MQE collapses to a single scalar (latest/max/min/avg-of-plain/sum).'),
    make('top', 'Use for a sorted top-N list (an MQE wrapped in top_n(...)).'),
    make('table', 'Use for a labeled table (e.g. latest(...) of a labeled metric).'),
    make('record', 'Use for RECORD-typed rows (e.g. sampled records / slow traces list).'),
    ...subPageTools,
    hierarchyTool,
    topologyTool,
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
