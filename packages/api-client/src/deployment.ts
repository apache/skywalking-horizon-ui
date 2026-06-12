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
 * Wire types for the per-layer **Deployment** feed — the deployment topology
 * of all of a service's instances: the instance-to-instance call graph WITHIN
 * one selected service, queried via OAP's `getServiceInstanceTopology(svc,
 * svc)`. Node MQE evaluates under `{ scope: ServiceInstance }`; edge MQE under
 * ServiceInstanceRelation (server / client families).
 *
 * A SELF-CONTAINED concern: Deployment shares no config type with the
 * service-map `topology` block. The two are allowed to diverge — Deployment
 * owns its own metric-definition shape ({@link DeploymentMetricDef}) so adding
 * a Deployment-only field never perturbs the topology types and vice versa.
 */

/** One operator-editable metric on a Deployment node or edge. */
export interface DeploymentMetricDef {
  /** Stable id keyed in the per-node / per-edge `metrics` map. */
  id: string;
  /** Display label (UI surfaces this in tooltips + detail panels). */
  label: string;
  /** Short label shown before the value on the edge pill (e.g. `"W"`, `"R"`),
   *  so a multi-metric edge reads `W 1.9 · R 2.4`. Absent ⇒ value only. */
  alias?: string;
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
   *   - `center`     — number printed in the centre of the hex.
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
   * Operator-editable 4-band thresholds for the metric that drives the ring
   * colour band. Three boundaries → four bands:
   *
   *   value ≤ ok               → green   (var(--sw-ok))
   *   ok   < value ≤ warn      → light yellow (#fbbf24)
   *   warn < value ≤ danger    → dark yellow  (var(--sw-warn))
   *   value > danger           → red     (var(--sw-err))
   *
   * For "higher is better" metrics (success rate / apdex) set
   * `invertHealth: true`; the renderer evaluates the bands on
   * `(invertBase - value)` instead. `invertBase` defaults to 100.
   */
  thresholds?: {
    ok?: number;
    warn?: number;
    danger?: number;
    invertHealth?: boolean;
    invertBase?: number;
  };
}

/**
 * A rule that derives a key per instance — reused for the Deployment view's
 * three independent grouping dimensions (`clusterBy` → dashed boxes,
 * `siblingBy` → which instances bundle into one pod, `roleBy` → container
 * role). Three modes:
 *
 *   - `nameRegex`   — parse the INSTANCE name with a named-capture regex; the
 *     `valueGroup` capture becomes the key (`banyandb-data-hot-0` → `data`).
 *   - `attribute`   — one instance ATTRIBUTE value (the `attributes
 *     [{name,value}]` bag carried on each instance, e.g. `node_role`); matched
 *     case-insensitively on the attribute name.
 *   - `attributes`  — several attribute values combined into one composite key
 *     (see below).
 *
 * Absent (for `clusterBy`) ⇒ no clustering (all nodes in one ungrouped pane).
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
  nodeMetrics?: DeploymentMetricDef[];
}

/**
 * Edge metrics scoped to a specific (source-role → target-role) pair, layered
 * ON TOP of the global {@link DeploymentConfig.linkServerMetrics} /
 * `linkClientMetrics`. Lets a `liaison → data` edge surface a different metric
 * set (and a different headline number) than `data → data`, without forcing one
 * flat metric list onto every relation.
 *
 * Each metric reuses {@link DeploymentMetricDef}; its `role` (`lineServer` /
 * `lineClient`) picks the relation side, exactly like the flat link defs. The
 * view resolves an edge's pair via `roleBy`, then renders this pair's metrics in
 * the edge panel + Flows table; `primary` names the one metric printed on the
 * edge itself in the map.
 */
export interface RolePairMetrics {
  /** Source-node role key (the value `roleBy` yields), or `'*'` for any.
   *  Matched case-insensitively. */
  from: string;
  /** Target-node role key, or `'*'` for any. Matched case-insensitively. */
  to: string;
  /** Metric id(s) (within `metrics`) printed inline on the edge — up to 3,
   *  stacked. A single string or an ordered array. Absent ⇒ no inline number
   *  (panel + table only). */
  primary?: string | string[];
  /** This pair's edge metrics. Each metric's `role` (`lineServer` /
   *  `lineClient`) selects the relation side. */
  metrics: DeploymentMetricDef[];
}

/**
 * Operator-editable Deployment config. Lives in the layer JSON's own top-level
 * `deployment` block, independent of the service-map `topology` block. Drives
 * the per-layer "Deployment" tab.
 *
 * The three rules are independent: `clusterBy` separates pod-groups into dashed
 * boxes; `siblingBy` bundles a pod's containers into one hex group; `roleBy`
 * (with `roles`) classifies each container, picking the main hex and its MQE.
 */
export interface DeploymentConfig {
  /** Per-instance MQE under `{ scope: ServiceInstance }`. Optional: it's the
   *  metric set for instances with NO role (the simple, no-sibling case) and
   *  the FALLBACK for a role that defines none. When `roles` cover every
   *  container, this can be omitted — metrics come from `roles[].nodeMetrics`. */
  nodeMetrics?: DeploymentMetricDef[];
  /** Per-edge MQE under ServiceInstanceRelation, server side. The FALLBACK
   *  metric set for an edge whose role-pair matches no {@link roleToRole}
   *  entry. */
  linkServerMetrics?: DeploymentMetricDef[];
  /** Per-edge MQE under ServiceInstanceRelation, client side. Fallback, as
   *  {@link linkServerMetrics}. */
  linkClientMetrics?: DeploymentMetricDef[];
  /** Per-(role → role) edge metrics, layered on the flat link defs. An edge
   *  uses the FIRST matching entry (most-specific first: exact `from`/`to`
   *  beat a `'*'` wildcard); when none matches it falls back to
   *  `linkServerMetrics`/`linkClientMetrics`. Drives the edge's inline
   *  `primary` number, the edge panel, and the Flows table. */
  roleToRole?: RolePairMetrics[];
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

/** One instance node in the deployment graph. Carries the instance's
 *  `attributes` bag (so the view can cluster by attribute). All nodes share
 *  one `serviceId` — the selected service. */
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

/** One instance-to-instance call within the selected service. `source ===
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

/** Response of `GET /api/layer/:key/deployment?service=<id>`. The graph is the
 *  instance topology WITHIN one service. */
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
