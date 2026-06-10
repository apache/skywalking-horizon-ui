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

/**
 * How the Deployment view groups instance nodes into
 * clusters (the dashed bounding boxes). Two mutually-exclusive modes:
 *
 *   - `nameRegex`  — parse the INSTANCE name with a named-capture regex,
 *     exactly the {@link ServiceNamingRule} shape (so the same resolver
 *     applies). The `valueGroup` capture becomes the cluster key. Use for
 *     fleets whose grouping dimension is encoded in the pod name
 *     (`banyandb-data-hot-0` → `data`).
 *   - `attribute`  — group by an instance ATTRIBUTE value (the
 *     `attributes [{name,value}]` bag carried on each instance, e.g.
 *     `node_role`, `node_type`). Lookup is case-insensitive on the
 *     attribute name. This mode is unique to instance topology — service
 *     topology has no per-node attributes.
 *
 * Absent ⇒ no clustering (all nodes in one ungrouped pane).
 */
export type ClusterByRule =
  | {
      kind: 'nameRegex';
      /** JS regex source, run against the instance name. */
      pattern: string;
      /** Flags for `new RegExp(pattern, flags)`. Default `''`. */
      flags?: string;
      /** Named-capture group for the display label. Defaults `'service'`. */
      displayGroup?: string;
      /** Named-capture group for the cluster value. Defaults `'group'`. */
      valueGroup?: string;
      /** Human label for the dimension (chip + box title). */
      alias: string;
    }
  | {
      kind: 'attribute';
      /** Instance-attribute name to group by (e.g. `node_role`). Matched
       *  case-insensitively against the instance's `attributes` bag. */
      attribute: string;
      /** Human label for the dimension. Defaults to `attribute`. */
      alias?: string;
    }
  | {
      kind: 'attributes';
      /** Several instance-attribute names combined into one composite cluster
       *  key — present values are joined by `separator`, and an attribute
       *  absent on a node is skipped (so an optional dimension like `node_type`
       *  drops out for nodes that lack it; e.g. a BanyanDB cluster grouped by
       *  `node_role` + `node_type` splits ROLE_DATA into hot/warm/cold while
       *  ROLE_LIAISON, which carries no node_type, stays one box). Matched
       *  case-insensitively. */
      attributes: string[];
      /** Joiner between present attribute values. Default ` / `. */
      separator?: string;
      /** Human label for the dimension. Defaults to the joined attribute names. */
      alias?: string;
    };

/** One container-role config for the sibling/pod model. `roleBy` yields a
 *  role key per instance; this entry configures that key. */
export interface NodeRoleConfig {
  /** Role key — the value `roleBy` extracts (regex `valueGroup` capture or
   *  attribute value), matched case-insensitively. */
  key: string;
  /** Display label for the role (tooltip / legend). */
  label?: string;
  /** This role's instance is the pod's MAIN container — rendered as the
   *  full-size hex; the other siblings attach to it at 50% size. At most one
   *  role per pod should be main; if none is, the first instance wins. */
  main?: boolean;
  /** Role-specific per-instance MQE (ServiceInstance scope). Falls back to
   *  {@link DeploymentConfig.nodeMetrics} when absent. */
  nodeMetrics?: TopologyMetricDef[];
}

/**
 * Operator-editable Deployment config. Lives in the layer
 * JSON's own top-level `deployment` block (independent of the
 * service-map `topology` block). Drives the per-layer "Deployment" tab:
 * the deployment topology of all of a service's instances — the
 * instance-to-instance call graph WITHIN one selected service, queried
 * via OAP's `getServiceInstanceTopology(svc, svc)`.
 *
 * Same node + per-side edge metric shape as {@link InstanceTopologyConfig}
 * (node MQE under `{ scope: ServiceInstance }`, edge MQE under
 * ServiceInstanceRelation server / client families), plus the optional
 * {@link ClusterByRule} for grouping nodes.
 */
export interface DeploymentConfig {
  /** Per-instance MQE under `{ scope: ServiceInstance }`. Optional: it's the
   *  metric set for instances with NO role (the simple, no-sibling case) and
   *  the FALLBACK for a role that defines none. When `roles` cover every
   *  container, this can be omitted — metrics come from `roles[].nodeMetrics`. */
  nodeMetrics?: TopologyMetricDef[];
  /** Per-edge MQE under ServiceInstanceRelation, server side. */
  linkServerMetrics?: TopologyMetricDef[];
  /** Per-edge MQE under ServiceInstanceRelation, client side. */
  linkClientMetrics?: TopologyMetricDef[];
  /** Node-clustering rule — separates pod-groups into dashed boxes. Absent ⇒
   *  no clustering. Independent of `siblingBy` / `roleBy`. */
  clusterBy?: ClusterByRule;
  /** Sibling rule — instances sharing this key belong to ONE pod and render
   *  as a bundled hex group (main + attached siblings). Absent ⇒ every
   *  instance is its own single-hex pod. */
  siblingBy?: ClusterByRule;
  /** Role rule — classifies each instance by container type; pairs with
   *  `roles`. Drives main-hex selection + per-role MQE. */
  roleBy?: ClusterByRule;
  /** Per-role config (main flag + role-specific MQE), keyed by the value
   *  `roleBy` yields. */
  roles?: NodeRoleConfig[];
}

/** One instance node in the deployment. Same shape as
 *  {@link InstanceTopologyNode} but carries the instance's `attributes`
 *  bag (so the view can cluster by attribute). All nodes share one
 *  `serviceId` — the selected service. */
export interface DeploymentNode {
  id: string;
  /** Instance name (e.g. `banyandb-data-hot-0`). */
  name: string;
  serviceId: string;
  serviceName: string;
  isReal: boolean;
  /** Keyed by the metric ids of this node's role (or `nodeMetrics` when the
   *  node has no role). */
  metrics: Record<string, number | null>;
  /** Instance attributes (`node_role`, `node_type`, …) from
   *  `listInstances`. Empty when OAP exposes none. */
  attributes: Array<{ name: string; value: string }>;
  /** Container role (from `roleBy`), when configured — drives main-hex
   *  selection + which role's metric defs render. Absent ⇒ unroled. */
  role?: string;
}

/** One instance-to-instance call within the selected service. Same
 *  per-side metric shape as {@link InstanceTopologyCall}. `source ===
 *  target` is possible (a node that calls itself). */
export interface DeploymentCall {
  id: string;
  source: string;
  target: string;
  detectPoints: string[];
  serverMetrics: Record<string, number | null>;
  clientMetrics: Record<string, number | null>;
  serverMetricSeries: Record<string, Array<number | null> | null>;
  clientMetricSeries: Record<string, Array<number | null> | null>;
}

/** Response of `GET /api/layer/:key/deployment?service=<id>`. The
 *  graph is the instance topology WITHIN one service. */
export interface DeploymentResponse {
  layer: string;
  serviceId: string;
  serviceName: string | null;
  generatedAt: number;
  config: DeploymentConfig;
  nodes: DeploymentNode[];
  calls: DeploymentCall[];
  reachable: boolean;
  error?: string;
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
