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
 * Wire types for the per-layer service-map and API-dependency feeds.
 *
 * Both feeds share one shape: a list of node + edge metric *definitions*
 * (label, MQE, unit, visual role) and a list of nodes/edges carrying
 * a `metrics: Record<id, number | null>` keyed by the definitions' ids.
 *
 * Why this shape?
 *   - The MQE expression for every metric (cpm, sla, …) is now operator-
 *     editable per layer (mirrors booster-ui's `nodeExpressions` /
 *     `linkServerExpressions` / `linkClientExpressions` settings).
 *   - The visual mapping (which metric drives the circle's ring colour,
 *     which renders as the centre value, what unit to print) is also
 *     operator-editable via the `role` and `unit` fields.
 *   - Adding a new metric to a layer's topology requires JSON edits only;
 *     the renderer iterates over `topology.nodeMetrics` blindly.
 *
 * The legacy node-level shortcut fields (`cpm`, `respTime`, `sla` and
 * the per-side server/client variants on edges) are kept around for
 * back-compat with older client code; new UI should read from `metrics`
 * keyed by metric id.
 */

/** One operator-editable metric on a topology node or edge. */
export interface TopologyMetricDef {
  /** Stable id keyed in the per-node / per-edge `metrics` map. */
  id: string;
  /** Display label (UI surfaces this in tooltips + detail panels). */
  label: string;
  /** The MQE expression evaluated against the entity scope. */
  mqe: string;
  /** Optional unit shown next to the value (e.g. `"rpm"`, `"ms"`, `"%"`). */
  unit?: string;
  /** Numeric formatting override for the displayed value — same hints as a
   *  dashboard widget (`'int'` / `'decimal'` / `'compact'` / `'duration'`,
   *  the last rendering a SECONDS value as a human time-ago like `5m ago`). */
  format?: 'int' | 'decimal' | 'compact' | 'duration';
  /**
   * Visual binding for the renderer:
   *   - `center`     — number printed in the centre of the circle / box.
   *   - `ring`       — controls the node's perimeter colour band.
   *   - `secondary`  — surfaced in detail panel + edge tooltip.
   *   - `lineServer` — drives edge thickness / labels on the server side.
   *   - `lineClient` — same, client side.
   * Absent ⇒ tooltip-only.
   */
  role?: 'center' | 'ring' | 'secondary' | 'lineServer' | 'lineClient';
  /** Aggregation across the duration window. Defaults to `avg`. */
  aggregation?: 'sum' | 'avg';
  /**
   * Operator-editable 4-band thresholds. Used when this metric drives
   * a colour band (typically the metric with `role: 'ring'`). Three
   * boundaries → four bands rendered as:
   *
   *   value ≤ ok       → green   (var(--sw-ok))
   *   ok < value ≤ warn      → light yellow (#fbbf24)
   *   warn < value ≤ danger  → dark yellow  (var(--sw-warn))
   *   value > danger          → red     (var(--sw-err))
   *
   * For "higher is better" metrics (SLA / apdex / success rate)
   * set `invertHealth: true`; the renderer evaluates the bands on
   * `(invertBase - value)` instead. `invertBase` defaults to 100
   * for percent-style metrics.
   *
   * When the block is absent, the renderer falls back to the
   * historical heuristic (`error %` ≤ 0.1 / 1 / 5).
   */
  thresholds?: {
    ok?: number;
    warn?: number;
    danger?: number;
    invertHealth?: boolean;
    invertBase?: number;
  };
}

/** Operator-editable topology dashboard config. Lives in the layer
 *  JSON's `topology` block. */
export interface TopologyConfig {
  /** Per-node MQE under `{ scope: Service }`. */
  nodeMetrics: TopologyMetricDef[];
  /** Per-edge MQE under `{ scope: ServiceRelation, ..., side: server }`. */
  linkServerMetrics?: TopologyMetricDef[];
  /** Per-edge MQE under `{ scope: ServiceRelation, ..., side: client }`. */
  linkClientMetrics?: TopologyMetricDef[];
  /** Whether to expose OAP's `<group>::<base>` legacy prefix as a
   *  separate chip in the node detail panel. When `true`, the panel
   *  renders the prefix in its own chip (next to the cluster chip);
   *  the topology node label still shows the pure service name.
   *  When falsy (default), the prefix is dropped from the UI
   *  entirely — base name everywhere. */
  showGroup?: boolean;
  /** Optional instance-to-instance topology drill-down config. Present
   *  only on layers that support it (the BFF seeds general / mesh /
   *  k8s_service / cilium_service). Same metric shape as the service
   *  map but evaluated under the ServiceInstance / ServiceInstanceRelation
   *  scope. Echoed in the topology response's `config`, so the service
   *  map can decide whether to offer the edge drill-down without a
   *  second round-trip. Absent ⇒ the map offers no instance drill-down. */
  instanceTopology?: InstanceTopologyConfig;
}

/** Operator-editable instance-topology config. Same node + per-side edge
 *  metric shape as {@link TopologyConfig}, but the node MQE evaluates
 *  under `{ scope: ServiceInstance }` and the edge MQE under
 *  ServiceInstanceRelation (server / client families). */
export interface InstanceTopologyConfig {
  /** Per-instance MQE under `{ scope: ServiceInstance }`. */
  nodeMetrics: TopologyMetricDef[];
  /** Per-edge MQE under ServiceInstanceRelation, server side. */
  linkServerMetrics?: TopologyMetricDef[];
  /** Per-edge MQE under ServiceInstanceRelation, client side. Some
   *  layers (e.g. cilium_service) only expose a server family — then
   *  this is absent and edges render server-only. */
  linkClientMetrics?: TopologyMetricDef[];
}

/** Operator-editable process-topology (network-profiling) dashboard
 *  config. Lives in the layer JSON's `processTopology` block. Drives the
 *  network-profiling page's edge detail panel: clicking a process→process
 *  call evaluates these MQE expressions under the ProcessRelation scope.
 *  OAP exposes a client family and a server family (the conversation is
 *  observed from both sides of the eBPF probe), so both lists exist —
 *  mirrors `process_relation_client_*` / `process_relation_server_*`. */
export interface ProcessTopologyConfig {
  /** Per-edge MQE under ProcessRelation, client side
   *  (`process_relation_client_*`). */
  edgeClientMetrics: TopologyMetricDef[];
  /** Per-edge MQE under ProcessRelation, server side
   *  (`process_relation_server_*`). */
  edgeServerMetrics: TopologyMetricDef[];
}

/** One resolved process-relation metric series for the edge panel. */
export interface ProcessRelationMetric {
  id: string;
  label: string;
  unit?: string;
  /** Per-bucket values over the duration window (MINUTE step). */
  values: Array<number | null>;
}

/** Response of `POST /api/ebpf/network/process-relation-metrics`. */
export interface ProcessRelationMetricsResponse {
  client: ProcessRelationMetric[];
  server: ProcessRelationMetric[];
  reachable: boolean;
  error?: string;
}

/** Source / dest descriptor the edge panel sends to resolve relation
 *  metrics. All names (not ids) — the ProcessRelation MQE entity keys on
 *  service / instance / process NAMES. */
export interface ProcessRelationEndpointRef {
  serviceName: string;
  serviceInstanceName: string;
  processName: string;
  normal?: boolean;
}

/** Operator-editable endpoint-dependency dashboard config. Lives in the
 *  layer JSON's `endpointDependency` block. */
export interface EndpointDependencyConfig {
  /** Per-node MQE under `{ scope: Endpoint }`. */
  nodeMetrics: TopologyMetricDef[];
  /** Per-edge MQE under `{ scope: EndpointRelation }`. OAP exposes
   *  only a server-side family here so there's no client list. */
  linkMetrics?: TopologyMetricDef[];
  /** See `TopologyConfig.showGroup` — same semantics for the
   *  endpoint-dependency view's node panel. */
  showGroup?: boolean;
}

export interface TopologyNode {
  id: string;
  name: string;
  type: string | null;
  isReal: boolean;
  layers: string[];
  /** Keyed by `TopologyMetricDef.id`. Missing keys ⇒ null. */
  metrics: Record<string, number | null>;
  /** @deprecated use `metrics['cpm']`. Kept for older callers. */
  cpm: number | null;
  /** @deprecated use `metrics['respTime']`. */
  respTime: number | null;
  /** @deprecated use `metrics['sla']`. */
  sla: number | null;
}

export interface TopologyCall {
  id: string;
  source: string;
  target: string;
  detectPoints: string[];
  /** Keyed by `linkServerMetrics[].id`. */
  serverMetrics: Record<string, number | null>;
  /** Keyed by `linkClientMetrics[].id`. */
  clientMetrics: Record<string, number | null>;
  /** Time-series buckets for each server-side line metric. Same id
   *  key as `serverMetrics`; the value is one number-per-minute over
   *  the duration window so the edge panel can render a sparkline. */
  serverMetricSeries: Record<string, Array<number | null> | null>;
  /** Same shape, client side. */
  clientMetricSeries: Record<string, Array<number | null> | null>;
  /** @deprecated convenience read of `serverMetrics['cpm']`. */
  serverCpm: number | null;
  /** @deprecated convenience read of `serverMetrics['respTime']`. */
  serverRespTime: number | null;
  /** @deprecated convenience read of `clientMetrics['cpm']`. */
  clientCpm: number | null;
  /** @deprecated convenience read of `clientMetrics['respTime']`. */
  clientRespTime: number | null;
}

export interface TopologyResponse {
  layer: string;
  service: string | null;
  depth: number;
  generatedAt: number;
  /** Echo of the operator-edited config so the SPA doesn't need a
   *  separate `GET /api/layer/:key/topology/config` round-trip. */
  config: TopologyConfig;
  nodes: TopologyNode[];
  calls: TopologyCall[];
  reachable: boolean;
  error?: string;
}

/** One instance node in the instance-topology drill-down. `id` is OAP's
 *  `<serviceId>_<base64-instance>` composite; `serviceId` splits it back
 *  to the owning service so the UI can group nodes into the two
 *  client / server columns. */
export interface InstanceTopologyNode {
  id: string;
  /** Instance name (e.g. `frontend-deployment-6ff5cbbdd5-8rxlg`). */
  name: string;
  serviceId: string;
  serviceName: string;
  isReal: boolean;
  /** Keyed by `InstanceTopologyConfig.nodeMetrics[].id`. */
  metrics: Record<string, number | null>;
}

/** One instance-to-instance call. Same per-side metric shape as
 *  {@link TopologyCall}. */
export interface InstanceTopologyCall {
  id: string;
  source: string;
  target: string;
  detectPoints: string[];
  serverMetrics: Record<string, number | null>;
  clientMetrics: Record<string, number | null>;
  serverMetricSeries: Record<string, Array<number | null> | null>;
  clientMetricSeries: Record<string, Array<number | null> | null>;
}

/** Response of `GET /api/layer/:key/instance-topology`. The graph is the
 *  instance topology between exactly two services (client + server). */
export interface InstanceTopologyResponse {
  layer: string;
  clientServiceId: string;
  serverServiceId: string;
  clientServiceName: string | null;
  serverServiceName: string | null;
  generatedAt: number;
  config: InstanceTopologyConfig;
  nodes: InstanceTopologyNode[];
  calls: InstanceTopologyCall[];
  reachable: boolean;
  error?: string;
}

export interface EndpointDependencyNode {
  id: string;
  name: string;
  serviceId: string;
  serviceName: string;
  type: string | null;
  isReal: boolean;
  /** Keyed by `EndpointDependencyConfig.nodeMetrics[].id`. */
  metrics: Record<string, number | null>;
  /** @deprecated use `metrics['cpm']`. */
  cpm: number | null;
  /** @deprecated use `metrics['respTime']`. */
  respTime: number | null;
  /** @deprecated use `metrics['sla']`. */
  sla: number | null;
}

export interface EndpointDependencyCall {
  id: string;
  source: string;
  target: string;
  detectPoints: string[];
  /** Keyed by `linkMetrics[].id`. Server-side only — OAP doesn't
   *  expose a client family for endpoint relations. */
  metrics: Record<string, number | null>;
  /** Time-series buckets per `linkMetrics[].id`. Same shape as
   *  `TopologyCall.serverMetricSeries`. */
  metricSeries: Record<string, Array<number | null> | null>;
  /** @deprecated convenience read. */
  cpm: number | null;
  /** @deprecated convenience read. */
  respTime: number | null;
}

export interface EndpointDependencyResponse {
  layer: string;
  service: string | null;
  endpoint: string | null;
  endpointId: string | null;
  generatedAt: number;
  config: EndpointDependencyConfig;
  nodes: EndpointDependencyNode[];
  calls: EndpointDependencyCall[];
  reachable: boolean;
  error?: string;
}
