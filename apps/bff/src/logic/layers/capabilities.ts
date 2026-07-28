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

// layer-template-as-skill: a compact capability descriptor projected from a
// layer template — the entity VOCABULARY, the COMPONENTS present, the trace
// source, per-scope metric COUNTS, and each relationship's metric LEGEND (role
// health/load + thresholds). Read at runtime so the agent reasons in the layer's
// own terms without hardcoding per-layer facts. Descriptor only — no OAP fan-out.
import type { DashboardScope, UITemplateClient } from '@skywalking-horizon-ui/api-client';
import { resolveEffectiveLayer } from './effective.js';
import {
  widgetsForScope,
  topologyConfigFor,
  instanceTopologyConfigFor,
  deploymentConfigFor,
  endpointDependencyConfigFor,
  tracesConfigFor,
  logConfigFor,
  type LayerTemplate,
  type LayerComponentFlags,
  type TopologyMetricDef,
} from './loader.js';
import { flattenTabWidgets } from '../dashboard/gates.js';

export interface MetricLegend {
  id: string;
  label: string;
  mqe: string;
  unit?: string;
  role?: string;
  /** role 'ring' — the colour-band / status metric; judge against thresholds. */
  health: boolean;
  /** role 'center' — the headline magnitude (load); read as a value, not pass/fail. */
  load: boolean;
  thresholds?: TopologyMetricDef['thresholds'];
}

export interface RelationLegend {
  node: MetricLegend[];
  edgeServer?: MetricLegend[];
  edgeClient?: MetricLegend[];
}

export interface LayerCapabilities {
  layer: string;
  displayName: string;
  vocabulary: {
    service: string;
    instance: string;
    endpoint: string;
    /** Present when service names encode a grouping dimension (e.g. namespace). */
    naming?: { dimension: string; pattern: string };
    instanceBadge?: string;
  };
  components: string[];
  tracesSource: string;
  logsScope: string;
  metricCounts: { service: number; instance: number; endpoint: number };
  relations: {
    topology?: RelationLegend;
    instanceTopology?: RelationLegend;
    endpointDependency?: RelationLegend;
    deployment?: RelationLegend;
  };
  note: string;
}

function legendOf(def: TopologyMetricDef): MetricLegend {
  return {
    id: def.id,
    label: def.label,
    mqe: def.mqe,
    unit: def.unit,
    role: def.role,
    health: def.role === 'ring',
    load: def.role === 'center',
    thresholds: def.thresholds,
  };
}

function relationOf(cfg: {
  nodeMetrics?: TopologyMetricDef[];
  linkServerMetrics?: TopologyMetricDef[];
  linkClientMetrics?: TopologyMetricDef[];
  linkMetrics?: TopologyMetricDef[];
}): RelationLegend {
  const server = cfg.linkServerMetrics ?? cfg.linkMetrics;
  return {
    node: (cfg.nodeMetrics ?? []).map(legendOf),
    edgeServer: server?.map(legendOf),
    edgeClient: cfg.linkClientMetrics?.map(legendOf),
  };
}

function componentList(flags: LayerComponentFlags): string[] {
  return Object.entries(flags)
    .filter(([, on]) => on)
    .map(([k]) => k);
}

function scopeCount(template: LayerTemplate, scope: DashboardScope): number {
  return flattenTabWidgets(widgetsForScope(template, scope)).length;
}

export async function layerCapabilities(
  uiTemplateClient: (() => UITemplateClient) | undefined,
  layer: string,
): Promise<LayerCapabilities | null> {
  const eff = await resolveEffectiveLayer(uiTemplateClient, layer);
  if (eff.blocked || !eff.template) return null;
  const t = eff.template;
  const naming = t.naming;

  const relations: LayerCapabilities['relations'] = {};
  if (t.components.topology) relations.topology = relationOf(topologyConfigFor(t));
  const inst = instanceTopologyConfigFor(t);
  if (inst) relations.instanceTopology = relationOf(inst);
  if (t.components.endpointDependency) relations.endpointDependency = relationOf(endpointDependencyConfigFor(t));
  const dep = deploymentConfigFor(t);
  if (dep) {
    // Deployment metrics can live top-level OR per node-role / per role-pair
    // (roleToRole edges) — fold all (BanyanDB defines every edge under roleToRole).
    const roleNode = (dep.roles ?? []).flatMap((r) => r.nodeMetrics ?? []);
    const pairEdges = (dep.roleToRole ?? []).flatMap((rr) => rr.metrics ?? []);
    const server = [...(dep.linkServerMetrics ?? []), ...pairEdges];
    relations.deployment = {
      node: [...(dep.nodeMetrics ?? []), ...roleNode].map(legendOf),
      edgeServer: server.length ? server.map(legendOf) : undefined,
      edgeClient: dep.linkClientMetrics?.map(legendOf),
    };
  }

  return {
    layer: t.key,
    displayName: t.alias ?? t.key,
    vocabulary: {
      // slots is typed non-optional but remote OAP rows authored with the
      // documented `aliases` key aren't migrated to `slots` — guard the deref.
      service: t.slots?.services ?? 'Service',
      instance: t.slots?.instances ?? 'Instance',
      endpoint: t.slots?.endpoints ?? 'Endpoint',
      naming: naming ? { dimension: naming.alias, pattern: naming.pattern } : undefined,
      instanceBadge: t.instances?.badge,
    },
    components: componentList(t.components),
    // Gate on the component flag — the config resolvers default to 'both'/'service'
    // even for layers that carry no traces/logs, which would mislead the tool choice.
    tracesSource: t.components.traces ? (tracesConfigFor(t).source ?? 'both') : 'none',
    logsScope: t.components.logs ? (logConfigFor(t).scope ?? 'service') : 'none',
    metricCounts: {
      service: scopeCount(t, 'service'),
      instance: scopeCount(t, 'instance'),
      endpoint: scopeCount(t, 'endpoint'),
    },
    relations,
    note: 'Metric LIST per (layer,scope) = kb_browse_catalog. Relation legend roles: ring = HEALTH (judge the value against its thresholds), center = LOAD (magnitude). Cite label + unit, never the raw MQE.',
  };
}
