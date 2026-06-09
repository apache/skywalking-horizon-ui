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
 * Wire types for `GET /api/menu`. The BFF aliases three OAP GraphQL queries
 * (`listLayers`, `getMenuItems`, `listLayerLevels`) into a single roundtrip
 * and stitches the result into the shape below — same as what the sidebar
 * (`apps/ui/src/components/shell/layers.ts`) renders.
 *
 * `caps` flags reflect what the LAYER supports; the UI hides rows whose
 * cap is false. `slots` carries per-layer term aliases (e.g. General's
 * endpoint → "API"). Layer-level overrides (term aliases, menu mode) live
 * in `horizon.yaml` and per-user state — the BFF merges all three sources.
 */

export interface LayerSlots {
  /** Renamed service-equivalent (functions / workloads / clusters / apps / databases / virtual service / …). */
  services?: string;
  /** Renamed instance-equivalent (versions / pods / brokers / sessions / nodes / …). */
  instances?: string;
  /** Renamed endpoint-equivalent. "API" for General, "Topics" for MQ, "Pages" for Browser. */
  endpoints?: string;
  /** Label for the endpoint-to-endpoint dependency feature. Defaults to `${endpoints} dependency`. */
  endpointDependency?: string;
  /** Label for the service-topology tab. Defaults to "Topology". */
  topology?: string;
  /** Label for the instance-topology sub-tab. Defaults to "Instance map". */
  instanceTopology?: string;
}

export interface LayerCaps {
  serviceMap?: boolean;
  endpointDependency?: boolean;
  instances?: boolean;
  endpoints?: boolean;
  instanceTopology?: boolean;
  processTopology?: boolean;
  dashboards?: boolean;
  traces?: boolean;
  logs?: boolean;
  /** Trace-driven thread profiling (the original SkyWalking profile). */
  traceProfiling?: boolean;
  /** Kernel-level CPU / off-CPU profiling sourced from eBPF agents. */
  ebpfProfiling?: boolean;
  /** JVM async-profiler integration (Java-only). */
  asyncProfiling?: boolean;
  /** eBPF network-profiling (process-level conversation topology + 4xx/5xx sampling). */
  networkProfiling?: boolean;
  /** Go pprof integration. */
  pprofProfiling?: boolean;
  /** On-demand Kubernetes pod logs — live-tail a pod's container logs
   *  fetched on demand from the K8s API (never persisted). Gates the
   *  per-layer "Pod Logs" tab; only K8s-deployed layers set it. */
  podLogs?: boolean;
  events?: boolean;
  /** Bundle a dedicated square tile per layer on the Overview strip,
   *  showing live service count. When on, regular tiles drop the
   *  "N services" counter from their header (no duplicate). */
  serviceCountTile?: boolean;
}

/**
 * One metric column for the layer's landing / summary KPI strip.
 * Mirrors `dashboards.<layer>.json:metrics.columns[]` so the SPA can
 * render the operator-edited labels / MQEs / aggregations instead of
 * static catalog defaults.
 */
export interface LayerMetricsColumn {
  metric: string;
  label: string;
  unit?: string;
  mqe?: string;
  aggregation?: 'sum' | 'avg';
  scale?: number;
  precision?: number;
}

/**
 * Per-layer page header / service-list config — drives the service
 * picker table on the per-layer Service page (RPM / Apdex / Error
 * Rate columns + their default sort).
 *
 * Renamed from `metrics` in the JSON to `layer-header` to reflect
 * where the data actually surfaces; the old `metrics` key is still
 * accepted by the loader for back-compat. Overview tile config lives
 * separately on `LayerOverviewConfig` with its own self-contained
 * metrics.
 */
export interface LayerHeaderConfig {
  /** Default sort metric for the service list. */
  orderBy?: string;
  columns?: LayerMetricsColumn[];
}

/** @deprecated alias kept for callers — same shape as LayerHeaderConfig. */
export type LayerMetricsConfig = LayerHeaderConfig;

/**
 * Per-layer service-name parsing rule. Some layers (k8s, mesh, cilium)
 * encode a grouping dimension into the service name itself:
 *
 *   - `songs.sample`     → display: `songs`,    group: `sample` (k8s/mesh ⇒ namespace)
 *   - `agent::checkout`  → display: `checkout`, group: `agent`  (generic ⇒ group)
 *
 * The rule is a named-capture regex evaluated against the raw service
 * name. `display` is what UI surfaces as the service label; `group` is
 * the value used for clustering nodes in topology. `alias` is the
 * human-readable category label for that group (`namespace`, `group`,
 * `tenant`, `fleet`, …) and shows up next to the value in chips and
 * group bounding boxes.
 *
 * When the regex doesn't match a given name, the UI falls back to the
 * legacy `<group>::<base>` parser, then to "no group".
 */
export interface ServiceNamingRule {
  /** JavaScript regex source. MUST contain named groups for both
   *  `display` and `group` (the names below override the captures). */
  pattern: string;
  /** Flags passed to `new RegExp(pattern, flags)`. Default `''`. */
  flags?: string;
  /** Named-capture group name that yields the displayable service
   *  label. Defaults to `'service'`. */
  displayGroup?: string;
  /** Named-capture group name that yields the group/namespace value.
   *  Defaults to `'group'`. */
  valueGroup?: string;
  /** Human label for the dimension (e.g. `namespace`, `group`,
   *  `tenant`). Surfaced as a chip prefix and group-box title. */
  alias: string;
}

/**
 * One self-contained metric on the Overview tile. Each carries its own
 * MQE expression + label + presentation hints; the Overview tile does
 * NOT cross-reference the per-layer header columns any more.
 *
 * `id` is optional in source JSON — the loader assigns `ov_0`,
 * `ov_1`, … on load so the SPA has a stable key to thread through
 * the landing query (the BFF treats each as a synthetic column).
 */
export interface OverviewMetric {
  id?: string;
  label: string;
  mqe: string;
  /** Hover tip (string only, no markdown). */
  tip?: string;
  unit?: string;
  aggregation?: 'sum' | 'avg';
  scale?: number;
  precision?: number;
}

/**
 * One Overview tile **group** — a layer can have multiple groups, each
 * rendered as its own tile in the Overview strip. The group is the
 * unit of layout decisions:
 *
 *   - `title`  is shown in the tile header, alongside the layer name.
 *     Operators use it to label a group's purpose (e.g. "Throughput",
 *     "Health", "Cache hit rate").
 *   - `size`   = "auto" (full tile with up to 3 metric cells, 5/row)
 *               or "square" (compact 1-metric tile, 8/row).
 *     Square is for at-a-glance density; the recommendation is to put
 *     exactly ONE metric in a square group — the layer's primary
 *     headline (RPM for services, Msg/s for MQ, QPS for DB, …).
 *   - `metrics` are self-contained `OverviewMetric` entries (mqe +
 *     label + tip + unit + aggregation + scale + precision).
 */
export interface OverviewGroup {
  title: string;
  size: 'auto' | 'square';
  metrics: OverviewMetric[];
}

/**
 * Overview-page-only settings. A layer's overview is now a list of
 * groups; each group becomes one tile in the Overview strip. Most
 * layers carry a single auto-size group (the headline metrics), and
 * may add additional square groups to surface a primary KPI in dense
 * fleet views.
 *
 * Legacy shapes (migrated at load time):
 *   - `metrics: OverviewMetric[]`   → wrapped into a single group
 *                                     `{title: '', size: 'auto'}`.
 *   - `metrics: string[]` of column-key refs → resolved against
 *                                     `layer-header.columns` then
 *                                     wrapped as above.
 */
export interface LayerOverviewConfig {
  groups?: OverviewGroup[];
  /** @deprecated — wrapped into a single auto-size group on load. */
  metrics?: OverviewMetric[];
}

export interface LayerDef {
  key: string;
  /** Display name from OAP `getMenuItems.title` (preserving casing). */
  name: string;
  /** Hex / CSS color from horizon-side defaults; OAP doesn't provide one. */
  color: string;
  /** From `listServices(layer)` count; -1 if the BFF couldn't reach OAP. */
  serviceCount: number;
  /** True iff OAP returned this layer in `listLayers` (services reporting). */
  active: boolean;
  /** Sidebar grouping label from the layer template's `group` field.
   *  Layers sharing the same value collapse into one section in the
   *  sidebar (e.g. `Istio` aggregates mesh / mesh_cp / mesh_dp). When
   *  absent the layer renders at the top level on its own. */
  group?: string;
  /** Sidebar placement — `public` (default) for layers visible to
   *  everyone in the Layers section, `operate` for operations-only
   *  layers like the SO11Y self-observability tree that surface under
   *  the Operate section instead. */
  visibility?: 'public' | 'operate';
  /** OAP's per-service `normal` flag, sampled from the first service in
   *  the layer. In practice every service within a layer shares the
   *  same value (VIRTUAL_*, AWS_* are all `false`; GENERAL/MESH/etc are
   *  all `true`), so a single bool per layer is faithful. `null` when
   *  the layer has no services reporting. The MQE entity scope on the
   *  dashboard / landing routes pivots on this. */
  normal?: boolean | null;
  /** Hierarchy level from `listLayerLevels`; null if not in the hierarchy table. */
  level: number | null;
  /** External documentation link from `getMenuItems.documentLink`. */
  documentLink?: string;
  slots: LayerSlots;
  caps: LayerCaps;
  /** Per-layer page header / service-list table config. Came from the
   *  JSON template's `layer-header` block (or legacy `metrics`). UI
   *  uses it for the per-layer Service page picker columns. Falls
   *  back to static catalog defaults when absent. */
  header?: LayerHeaderConfig;
  /** @deprecated — same data as `header`. Kept for back-compat with
   *  callers reading the old field name. */
  metrics?: LayerHeaderConfig;
  /** Overview-tile settings — the 1 – 3 self-contained metric cells
   *  on the per-layer Overview tile. Empty when the layer template
   *  omits the `overview` block. */
  overview?: LayerOverviewConfig;
  /** Logs-tab config. Layers like `MESH_DP` carry per-instance
   *  (sidecar) logs and need an instance picker on the Logs tab; most
   *  agent-traced layers carry per-service logs. Drives the UI scope +
   *  the BFF query filter ride-along. */
  log?: LogConfig;
  /** Traces-tab config — picks which trace backend (native vs Zipkin
   *  vs both) the UI surfaces. Mesh / k8s layers ship Zipkin-format
   *  spans (Envoy ALS, rover) so they set `source: 'zipkin'`; agent-
   *  traced layers default to `native`. */
  traces?: { source?: 'native' | 'zipkin' | 'both' };
  /** Per-layer service-name parsing rule. When present, the UI runs
   *  every service name through this regex to derive `{ display, cluster }`
   *  and clusters topology nodes by cluster. Absent ⇒ no clustering. */
  naming?: ServiceNamingRule;
}

export interface LogConfig {
  /** Entity scope the log query rides on. Mirrors booster-ui's
   *  ConditionTags model:
   *   - `service`   → service is pinned; instance + endpoint selectors
   *     surface as optional narrowers.
   *   - `instance`  → instance is pinned (sidecar/JVM); only endpoint
   *     selector is offered.
   *   - `endpoint`  → endpoint is pinned; only instance selector is
   *     offered.
   *
   *  The pinned entity is the one the layer's data is indexed by. */
  scope?: 'service' | 'instance' | 'endpoint';
  defaultTags?: Array<{ key: string; value: string }>;
}

export interface MenuResponse {
  layers: LayerDef[];
  generatedAt: number;
  /** Best-effort status of the upstream OAP query host. */
  oap: { reachable: boolean; queryUrl: string; error?: string };
}
