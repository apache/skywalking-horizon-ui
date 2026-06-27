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
 * Scope vocabulary for the layer-dashboard admin: the AdminScope union and
 * its label / slot / component maps, plus the alias-aware label resolver.
 * Lifted out of LayerDashboardsAdmin.vue so every per-scope editor and the
 * scope-tab bar can import AdminScope (for prop / emit typing) and the maps
 * (for dispatch) without reaching into the parent SFC. Pure data + one pure
 * function — no reactivity.
 */
import type { AdminLayerTemplate } from '@/api/client';
import type { DashboardScope, TopologyMetricDef } from '@skywalking-horizon-ui/api-client';

/** A `components.*` toggle key. */
export type ComponentKey = keyof AdminLayerTemplate['components'];
/** A `slots.*` alias key. */
export type SlotKey = keyof NonNullable<AdminLayerTemplate['slots']>;

/** Admin-only scopes that aren't dashboard-widget scopes. `networkProfiling`
 *  is the process-topology edge editor; `deployment` is the
 *  instance-deployment config (node + edge MQE + clusterBy). Both
 *  live outside `DashboardScope` but surface as editable config tabs. */
export type AdminScope = DashboardScope | 'networkProfiling' | 'deployment';

export const SCOPES: AdminScope[] = [
  'service',
  'instance',
  'endpoint',
  // Topology before dependency — operator order request: service map
  // is the primary canvas; API dependency drills into one endpoint.
  'topology',
  'deployment',
  'dependency',
  'trace',
  'logs',
  'traceProfiling',
  'ebpfProfiling',
  'asyncProfiling',
  'networkProfiling',
];

/** Display label for each scope — kebab-cases the profiling scopes
 *  so the scope tab strip reads as "trace profiling" instead of the
 *  camelCase key. */
export const SCOPE_LABELS: Record<AdminScope, string> = {
  service: 'service',
  instance: 'instance',
  endpoint: 'endpoint',
  dependency: 'dependency',
  topology: 'topology',
  deployment: 'deployment',
  trace: 'trace',
  logs: 'logs',
  traceProfiling: 'trace profiling',
  ebpfProfiling: 'eBPF profiling',
  asyncProfiling: 'async profiling',
  networkProfiling: 'network profiling',
};

/** Scopes whose page is a built-in, runtime-configured explore view with no
 *  per-layer widget grid to author (the trace / logs / profiling tabs render
 *  dedicated views). `networkProfiling` is excluded — it has its own
 *  edge-metric editor. */
export const RUNTIME_ONLY_SCOPES = new Set<AdminScope>([
  'trace',
  'logs',
  'traceProfiling',
  'ebpfProfiling',
  'asyncProfiling',
]);

/** Scopes that hold a widget list (so a tab count is meaningful). Config /
 *  topology scopes and runtime-only views carry none. */
export const WIDGET_SCOPES = new Set<AdminScope>(['service', 'instance', 'endpoint']);

/** Each scope's `components.*` flag — drives which scopes a layer surfaces. */
export const SCOPE_COMPONENT: Record<AdminScope, ComponentKey> = {
  service: 'service',
  instance: 'instances',
  endpoint: 'endpoints',
  dependency: 'endpointDependency',
  topology: 'topology',
  deployment: 'deployment',
  trace: 'traces',
  logs: 'logs',
  // Profiling scopes: each granular component flag controls one tab. The
  // legacy `profiling` umbrella flag is implied by the BFF loader.
  traceProfiling: 'traceProfiling' as ComponentKey,
  ebpfProfiling: 'ebpfProfiling' as ComponentKey,
  asyncProfiling: 'asyncProfiling' as ComponentKey,
  networkProfiling: 'networkProfiling' as ComponentKey,
};

/** Scope → slot-alias key, for the scopes that carry a configurable noun.
 *  Drives alias-aware scope-tab + section-heading labels so the admin reads
 *  in the layer's own vocabulary (e.g. "Nodes" not "instance"). */
export const SCOPE_SLOT: Partial<Record<AdminScope, SlotKey>> = {
  service: 'services',
  instance: 'instances',
  endpoint: 'endpoints',
  dependency: 'endpointDependency',
};

/** Alias-aware scope label: the layer's slot alias for the scope's noun if
 *  set, else the generic label. Pure — callers pass `draft.template`. */
export function scopeLabelOf(template: AdminLayerTemplate | null | undefined, s: AdminScope): string {
  const sk = SCOPE_SLOT[s];
  return (sk && template?.slots?.[sk]) || SCOPE_LABELS[s];
}

/** Role-binding options for a topology/dependency metric — the dropdown in
 *  every metric-row editor. Shared across the per-scope config editors. */
export const TOPOLOGY_ROLE_OPTIONS: Array<{ value: TopologyMetricDef['role'] | ''; label: string }> = [
  { value: '', label: '(tooltip only)' },
  { value: 'center', label: 'center · node big number' },
  { value: 'ring', label: 'ring · node colour band' },
  { value: 'secondary', label: 'secondary · detail panel' },
  { value: 'lineServer', label: 'lineServer · edge server side' },
  { value: 'lineClient', label: 'lineClient · edge client side' },
];
