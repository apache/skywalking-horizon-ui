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
 * metric-catalog skill — model-facing tools that answer "WHAT can I query on
 * this page, and where can I drill?". Pure reads: `kb_browse_catalog` returns
 * the template-derived metric list; `kb_resolve_scope_drill` enumerates the
 * child entities to re-query the SAME metric at a finer scope (never a rollup).
 */

import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import type { StructuredToolInterface } from '@langchain/core/tools';
import type { DashboardScope } from '@skywalking-horizon-ui/api-client';
import type { AiRequestContext } from '../../context.js';
import { graphqlPost } from '../../../client/graphql.js';
import { serviceLayerCatalog } from '../../../logic/services/service-layer-catalog.js';
import { getServiceHierarchy } from '../../../logic/oap/hierarchy.js';
import { getLayerCatalog } from './catalog.js';

const SEARCH_CAP = 40;

const SCOPES = ['service', 'instance', 'endpoint'] as const;

const LIST_INSTANCES = /* GraphQL */ `
  query DrillInstances($serviceId: ID!, $duration: Duration!) {
    instances: listInstances(serviceId: $serviceId, duration: $duration) { id name }
  }
`;
const FIND_ENDPOINTS = /* GraphQL */ `
  query DrillEndpoints($serviceId: ID!, $keyword: String!, $duration: Duration!) {
    endpoints: findEndpoint(serviceId: $serviceId, keyword: $keyword, limit: 20, duration: $duration) { id name }
  }
`;

export function metricCatalogTools(ctx: AiRequestContext): StructuredToolInterface[] {
  const duration = () => ({ start: ctx.window.start, end: ctx.window.end, step: ctx.window.step });
  const denied = (): string => 'Permission denied: the current user lacks metrics:read.';

  const browse = tool(
    async ({ layer, scope }): Promise<string> => {
      if (!ctx.hasVerb('metrics:read')) return denied();
      const entries = await getLayerCatalog(
        { config: ctx.config, uiTemplateClient: ctx.uiTemplateClient },
        layer,
        (scope ?? 'service') as DashboardScope,
      );
      if (entries.length === 0) {
        return `No metrics available for layer "${layer}" at scope "${scope ?? 'service'}" (unknown/unsynced layer or no template).`;
      }
      // Compact projection — enough for the model to pick a metric + build a
      // render call, without the whole widget config.
      return JSON.stringify(
        entries.map((e) => ({
          widgetId: e.widgetId,
          title: e.title,
          type: e.widgetType,
          unit: e.unit,
          explanation: e.explanation,
          expressions: e.expressions,
          metricIds: e.metricIds,
        })),
      );
    },
    {
      name: 'kb_browse_catalog',
      description:
        'List the metrics available on a layer dashboard page: the curated title, ready MQE expression(s), unit, widget type, and (when present) a human explanation. ALWAYS use these MQE expressions verbatim rather than inventing metric names — they are scope-correct. scope is one of service | instance | endpoint (default service).',
      schema: z.object({
        layer: z.string().describe('OAP layer key, e.g. GENERAL, MESH, K8S_SERVICE'),
        scope: z.enum(SCOPES).optional().describe('service (default) | instance | endpoint'),
      }),
    },
  );

  const drill = tool(
    async ({ serviceId, toScope, keyword }): Promise<string> => {
      if (!ctx.hasVerb('metrics:read')) return denied();
      try {
        if (toScope === 'instance') {
          const data = await graphqlPost<{ instances: Array<{ id: string; name: string }> }>(
            ctx.opts,
            LIST_INSTANCES,
            { serviceId, duration: duration() },
          );
          return JSON.stringify({
            toScope,
            note: 'Re-query the SAME metric family at instance scope for each — OAP does not roll up between scopes.',
            children: data.instances ?? [],
          });
        }
        const data = await graphqlPost<{ endpoints: Array<{ id: string; name: string }> }>(
          ctx.opts,
          FIND_ENDPOINTS,
          { serviceId, keyword: keyword ?? '', duration: duration() },
        );
        return JSON.stringify({
          toScope,
          note: 'Re-query the SAME metric family at endpoint scope for each — OAP does not roll up between scopes.',
          children: data.endpoints ?? [],
        });
      } catch (err) {
        return `Drill failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
    {
      name: 'kb_resolve_scope_drill',
      description:
        'Drill DOWN from a service to its child entities so you can re-query the same metric at a finer scope. Returns the child instance/endpoint ids+names. Entity-scope is load-bearing: to see a Service metric per-instance you MUST re-query at instance scope with the child id — there is no automatic rollup.',
      schema: z.object({
        serviceId: z.string().describe('OAP service id (from list_services)'),
        toScope: z.enum(['instance', 'endpoint']).describe('drill target scope'),
        keyword: z.string().optional().describe('endpoint name filter (endpoint drill only)'),
      }),
    },
  );

  const describe = tool(
    async ({ layer, scope, id }): Promise<string> => {
      if (!ctx.hasVerb('metrics:read')) return denied();
      const entries = await getLayerCatalog(
        { config: ctx.config, uiTemplateClient: ctx.uiTemplateClient },
        layer,
        (scope ?? 'service') as DashboardScope,
      );
      const hit = entries.find((e) => e.widgetId === id || e.metricIds.includes(id));
      if (!hit) return `No metric "${id}" on ${layer}/${scope ?? 'service'}.`;
      return JSON.stringify({
        layer: hit.layer,
        scope: hit.scope,
        widgetId: hit.widgetId,
        title: hit.title,
        type: hit.widgetType,
        unit: hit.unit,
        explanation: hit.explanation,
        expressions: hit.expressions,
        metricIds: hit.metricIds,
      });
    },
    {
      name: 'kb_describe_metric',
      description:
        'Get the full catalog detail for ONE metric on a (layer, scope) page — title, MQE, unit, explanation, widget type — looked up by its widget id (from kb_browse_catalog) or a metric id it contains.',
      schema: z.object({
        layer: z.string(),
        scope: z.enum(SCOPES).optional(),
        id: z.string().describe('widget id (from kb_browse_catalog) or a raw metric id'),
      }),
    },
  );

  const search = tool(
    async ({ keyword, scope }): Promise<string> => {
      if (!ctx.hasVerb('metrics:read')) return denied();
      const k = keyword.toLowerCase();
      const sc = (scope ?? 'service') as DashboardScope;
      const cat = await serviceLayerCatalog({ config: ctx.config, fetch: ctx.fetch }).get();
      const out: Array<{ layer: string; widgetId: string; title: string; type: string; expressions: string[]; unit?: string }> = [];
      let truncated = false;
      for (const layer of cat.layers) {
        const entries = await getLayerCatalog(
          { config: ctx.config, uiTemplateClient: ctx.uiTemplateClient },
          layer,
          sc,
        );
        for (const e of entries) {
          const hay = `${e.title} ${e.metricIds.join(' ')} ${e.explanation ?? ''}`.toLowerCase();
          if (!hay.includes(k)) continue;
          if (out.length >= SEARCH_CAP) {
            truncated = true;
            break;
          }
          out.push({
            layer: e.layer,
            widgetId: e.widgetId,
            title: e.title,
            type: e.widgetType,
            expressions: e.expressions,
            unit: e.unit,
          });
        }
        if (truncated) break;
      }
      if (out.length === 0) return `No metrics matching "${keyword}" at scope "${sc}".`;
      return JSON.stringify({ matches: out, truncated });
    },
    {
      name: 'kb_search_metrics',
      description:
        'Search the metric catalog ACROSS all layers by keyword (matches a metric title, id, or explanation) at a given scope (default service). Use when you do not already know which layer exposes the metric you need.',
      schema: z.object({
        keyword: z.string().describe('e.g. "gc", "heap", "latency", "cpu"'),
        scope: z.enum(SCOPES).optional(),
      }),
    },
  );

  const hierarchy = tool(
    async ({ serviceId, layer }): Promise<string> => {
      if (!ctx.hasVerb('topology:read')) return 'Permission denied: the current user lacks topology:read.';
      try {
        const res = await getServiceHierarchy(ctx.config.current, serviceId, layer, ctx.fetch);
        if (!res.reachable) return 'Hierarchy is unavailable (OAP unreachable).';
        type Peer = { id: string; name: string; role: string };
        type Group = { layer: string; services: Peer[] };
        const groups = ((res.peers ?? []) as Group[])
          .map((g) => ({
            layer: g.layer,
            peers: g.services
              .filter((s) => s.role !== 'self')
              .map((s) => ({ id: s.id, name: s.name, layer: g.layer, role: s.role })),
          }))
          .filter((grp) => grp.peers.length > 0);
        if (groups.length === 0) return 'No cross-layer hierarchy relations for this service.';
        return JSON.stringify({
          note: "Follow a peer INTO its layer and continue root-cause there — e.g. a K8S_SERVICE down to its backing database/infra layer, where memory / disk / connection causes live. Re-query that layer's metrics via kb_browse_catalog.",
          groups,
        });
      } catch (err) {
        return `Hierarchy lookup failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
    {
      name: 'kb_resolve_hierarchy',
      description:
        'Resolve a service\'s CROSS-LAYER hierarchy — the same entity projected into other layers (a K8S_SERVICE linked DOWN to its backing PostgreSQL / MongoDB infra layer, or a MESH service to its GENERAL / K8S mirror). Use to continue root-cause ACROSS a layer boundary: when the root service depends on an infra/database layer, follow the hierarchy there and check that layer\'s metrics (memory, disk, connections). Distinct from kb_resolve_scope_drill (which stays within a layer, drilling to instances/endpoints).',
      schema: z.object({
        serviceId: z.string().describe('OAP service id (from list_services)'),
        layer: z.string().describe("the service's current layer, e.g. K8S_SERVICE"),
      }),
    },
  );

  return [browse, describe, search, drill, hierarchy];
}
