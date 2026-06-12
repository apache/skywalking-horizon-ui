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
 * Per-layer template config — the source of truth for a layer's
 * presentation (alias, color, slots, enabled components) AND its data
 * shape (landing card columns, dashboard widgets, MQE expressions).
 *
 * The bundled defaults live under `../bundled_templates/layers/<key>.json`,
 * one file per OAP layer enum. Operator overrides land in the SetupStore
 * (JSON file on disk) and merge on top.
 *
 * Lifting these from TS code into JSON gets us:
 *   - One file per layer to review or copy
 *   - Operator-editable surface (the future admin/layer-dashboards page
 *     reads + writes JSON-shaped configs)
 *   - Clean separation between code (the loader) and content (the
 *     widget catalog)
 */

import { readdirSync, readFileSync, watch as fsWatch, writeFileSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  DashboardScope,
  DashboardWidget,
  EndpointDependencyConfig,
  InstanceTopologyConfig,
  ProcessTopologyConfig,
  DeploymentConfig,
  InstanceListConfig,
  ServiceNamingRule,
  TopologyConfig,
  TopologyMetricDef,
  TracesConfig,
} from '@skywalking-horizon-ui/api-client';
import { isOverlayFilename, reloadI18nStore } from '../../i18n/store.js';

export type { TopologyConfig, InstanceTopologyConfig, EndpointDependencyConfig, ProcessTopologyConfig, DeploymentConfig, TopologyMetricDef, TracesConfig, ServiceNamingRule };

export interface LayerComponentFlags {
  service?: boolean;
  instances?: boolean;
  endpoints?: boolean;
  endpointDependency?: boolean;
  topology?: boolean;
  traces?: boolean;
  logs?: boolean;
  /** BROWSER-layer JS error logs + source-map de-obfuscation (#6784). */
  browserErrors?: boolean;
  /** Trace-driven thread profiling (original SkyWalking profile). */
  traceProfiling?: boolean;
  /** Kernel-level CPU / off-CPU profiling via eBPF agents. */
  ebpfProfiling?: boolean;
  /** JVM async-profiler integration. */
  asyncProfiling?: boolean;
  /** eBPF network profiling (process-level conversation graph). */
  networkProfiling?: boolean;
  /** Go pprof integration. */
  pprofProfiling?: boolean;
  /** On-demand Kubernetes pod logs — live-tail a pod's container logs
   *  fetched on demand from the K8s API (never persisted). Only K8s-
   *  deployed layers (k8s_service, mesh) carry pods that resolve. */
  podLogs?: boolean;
  /** Service-deployment tab — instance-to-instance call graph
   *  within one service. Opt-in; the tab also requires a
   *  `deployment` config block. */
  deployment?: boolean;
}

export interface LayerSlotsConfig {
  services?: string;
  instances?: string;
  endpoints?: string;
  endpointDependency?: string;
  /** Service-topology tab label (default "Topology"). */
  topology?: string;
  /** Instance-topology sub-tab label (default "Instance map"). */
  instanceTopology?: string;
  /** Service-deployment tab label (default "Deployment"). */
  deployment?: string;
}

export interface LayerMetricColumn {
  metric: string;
  label: string;
  unit?: string;
  mqe?: string;
  aggregation?: 'sum' | 'avg';
  scale?: number;
  precision?: number;
}

/**
 * Per-layer page header / service-list config — drives the per-layer
 * Service page picker columns + default sort. Stored under
 * `layer-header` in the JSON (with `metrics` accepted as a legacy
 * alias).
 */
export interface LayerHeaderConfig {
  /** Default sort metric for the service list. */
  orderBy?: string;
  columns?: LayerMetricColumn[];
}

/** @deprecated alias kept for callers — same shape as LayerHeaderConfig. */
export type LayerMetricsConfig = LayerHeaderConfig;

/**
 * One Overview-tile metric. Self-contained: carries its own MQE +
 * presentation hints (label / tip / unit / aggregation / scale /
 * precision). The Overview tile no longer cross-references the
 * per-layer header columns.
 *
 * `id` is auto-assigned by the loader (`ov_0`, `ov_1`, …) when the
 * source JSON omits it, so the SPA + BFF always have a stable key to
 * thread requests + results on.
 */
export interface OverviewMetric {
  id?: string;
  label: string;
  mqe: string;
  tip?: string;
  unit?: string;
  aggregation?: 'sum' | 'avg';
  scale?: number;
  precision?: number;
}

/**
 * One Overview-tile group — a layer can have N groups, each rendered
 * as its own tile in the Overview strip with the group's `title` in
 * the header. `size: square` is the dense-fleet variant and should
 * carry exactly 1 metric.
 */
export interface OverviewGroup {
  title: string;
  size: 'auto' | 'square';
  metrics: OverviewMetric[];
}

/**
 * Overview-tile config. `groups` is the canonical shape; legacy
 * `metrics` is migrated to a single auto-size group at load time.
 */
export interface LayerOverviewConfig {
  groups?: OverviewGroup[];
  /** @deprecated — wrapped into a single auto-size group on load. */
  metrics?: OverviewMetric[];
}

/**
 * Per-scope dashboards bundled with a layer template. Each scope is an
 * independent widget set; the SPA picks one based on the active route
 * (`/layer/:key/service`, `/instance`, `/endpoint`, `/trace`,
 * `/profiling`). Legacy `widgets` (flat array) is migrated to
 * `dashboards.service` at load time.
 */
export interface LayerDashboards {
  service?: DashboardWidget[];
  instance?: DashboardWidget[];
  endpoint?: DashboardWidget[];
  dependency?: DashboardWidget[];
  topology?: DashboardWidget[];
  trace?: DashboardWidget[];
  logs?: DashboardWidget[];
  traceProfiling?: DashboardWidget[];
  ebpfProfiling?: DashboardWidget[];
  asyncProfiling?: DashboardWidget[];
}

export interface LayerTemplate {
  /** UPPER_SNAKE enum key (matches OAP). */
  key: string;
  /** Display name override. */
  alias?: string;
  /** Sidebar grouping label. Layers that share a `group` value collapse
   *  under one expandable section in the sidebar — used to keep related
   *  layers together (Istio Managed SVCs / Control Plane / Data Plane
   *  → "Istio"; so11y_* → "Self-Observability"). Layers without a
   *  group hang at the top level on their own. */
  group?: string;
  /** Sidebar placement — `public` (default) → regular Layers section;
   *  `operate` → operations section (e.g. self-observability layers). */
  visibility?: 'public' | 'operate';
  /** Layer-dot color (CSS var or hex). */
  color?: string;
  /** Doc link surfaced as a chip on the layer page. */
  documentLink?: string;
  slots: LayerSlotsConfig;
  components: LayerComponentFlags;
  /** Per-layer page header / service-list config — drives the picker
   *  columns on the per-layer Service page. */
  header: LayerHeaderConfig;
  /** @deprecated alias for `header` — populated by the loader so old
   *  callers reading `template.metrics` keep working. */
  metrics: LayerHeaderConfig;
  /** Overview-tile config. Self-contained metric entries. */
  overview?: LayerOverviewConfig;
  /** Per-scope widget sets. `service` is the layer's primary landing. */
  dashboards?: LayerDashboards;
  /** Legacy single widget list — treated as `dashboards.service`. */
  widgets?: DashboardWidget[];
  /** Service-map dashboard config — operator-editable node + edge MQE.
   *  When absent the loader fills it from {@link BOOSTER_TOPOLOGY_DEFAULTS}. */
  topology?: TopologyConfig;
  /** API-dependency dashboard config — operator-editable node + edge MQE.
   *  When absent the loader fills it from {@link BOOSTER_ENDPOINT_DEP_DEFAULTS}. */
  endpointDependency?: EndpointDependencyConfig;
  /** Process-topology (network-profiling) edge-metric config — operator-
   *  editable ProcessRelation MQE. When absent the loader fills it from
   *  {@link BOOSTER_PROCESS_TOPOLOGY_DEFAULTS}. */
  processTopology?: ProcessTopologyConfig;
  /** Service-deployment config — operator-editable node + per-side
   *  edge MQE (ServiceInstance / ServiceInstanceRelation scope) plus an
   *  optional node-clustering rule. Top-level + independent of `topology`;
   *  its presence opts the layer into the "Deployment" tab.
   *  No defaults — absent ⇒ the tab is off. */
  deployment?: DeploymentConfig;
  /** Traces tab config. The `source` field picks which trace backend
   *  the UI's filter selector defaults to (`both` shows two parallel
   *  tables; `native` / `zipkin` pin to one). Default `both` when
   *  absent. The native query choice (`queryTraces` vs
   *  `queryBasicTraces`) is decided at runtime by probing
   *  `hasQueryTracesV2Support`, not in this config. */
  traces?: TracesConfig;
  /** Logs tab config. Some layers carry per-instance logs (Istio Data
   *  Plane / sidecar access logs, eBPF profiling targets) — they need
   *  an instance picker on the Logs tab and the BFF must thread
   *  `serviceInstance` to the OAP log query. Other layers (traced
   *  agents) carry per-service logs. Defaults to `service` when absent.
   *  Operators can also pre-seed default custom tag filters that ride
   *  along with every query — useful for layers whose logs are always
   *  filtered by `logger=` or `source=`. */
  log?: LogConfig;
  /** Service-name parsing rule. Surfaced verbatim on the menu response
   *  so the UI can derive `{ display, cluster }` per service and
   *  cluster topology nodes accordingly. */
  naming?: ServiceNamingRule;
  /** Instance-list config (badge attribute). Surfaced on the menu response. */
  instances?: InstanceListConfig;
}

export interface LogConfig {
  /** Entity granularity the log query scopes to. Picks which entity
   *  the BFF pins on every query, and which optional selectors the
   *  conditions bar surfaces:
   *   - `service`   (default): service is pinned; conditions bar
   *     offers instance + endpoint selectors as narrowers.
   *   - `instance`  : the picked instance (sidecar / JVM) is the pinned
   *     entity; only an endpoint selector is shown alongside.
   *   - `endpoint`  : the picked endpoint is pinned; only an instance
   *     selector is shown alongside.
   *  Matches booster-ui's ConditionTags routing (`EntityType[1|2|3]`). */
  scope?: 'service' | 'instance' | 'endpoint';
  /** Default tag filters appended to every log query. Operators can
   *  add more on the page via the conditions bar. */
  defaultTags?: Array<{ key: string; value: string }>;
}

/**
 * Booster-ui defaults for the service-map dashboard. Lifted from
 * `general-service-relation.json:nodeExpressions / linkServerExpressions /
 * linkClientExpressions` so a layer template without an explicit
 * `topology` block still draws something meaningful. Operators can
 * override any field by adding a `topology` block to the layer JSON.
 *
 * The ROLE bindings decide what each metric maps to on screen:
 *   - `ring`   on `sla`        — circle stroke colour band
 *   - `center` on `cpm`        — number printed inside the circle
 *   - `secondary` on `respTime` — surfaced in detail panel
 *
 * Edge side: server has priority; the main-path computation picks the
 * server cpm and falls back to client when null. The order in the
 * `linkServerMetrics` / `linkClientMetrics` arrays drives the fallback
 * priority for the renderer.
 */
export const BOOSTER_TOPOLOGY_DEFAULTS: TopologyConfig = {
  nodeMetrics: [
    { id: 'cpm', label: 'RPM', mqe: 'service_cpm', unit: 'rpm', role: 'center', aggregation: 'avg' },
    { id: 'sla', label: 'SLA', mqe: 'service_sla/100', unit: '%', role: 'ring', aggregation: 'avg' },
    { id: 'respTime', label: 'Latency', mqe: 'service_resp_time', unit: 'ms', role: 'secondary', aggregation: 'avg' },
  ],
  // Per-edge line metrics — mirror booster-ui's per-side family:
  // RPM, avg response time, p95 percentile, and SLA%. The ids match
  // across server and client so the right-sidebar pairing renders
  // both sides aligned per row.
  linkServerMetrics: [
    { id: 'cpm', label: 'RPM', mqe: 'service_relation_server_cpm', unit: 'rpm', role: 'lineServer', aggregation: 'avg' },
    { id: 'respTime', label: 'Avg response time', mqe: 'service_relation_server_resp_time', unit: 'ms', aggregation: 'avg' },
    { id: 'p95', label: 'p95', mqe: "service_relation_server_percentile{p='95'}", unit: 'ms', aggregation: 'avg' },
    { id: 'sla', label: 'SLA', mqe: 'service_relation_server_call_sla/100', unit: '%', aggregation: 'avg' },
  ],
  linkClientMetrics: [
    { id: 'cpm', label: 'RPM', mqe: 'service_relation_client_cpm', unit: 'rpm', role: 'lineClient', aggregation: 'avg' },
    { id: 'respTime', label: 'Avg response time', mqe: 'service_relation_client_resp_time', unit: 'ms', aggregation: 'avg' },
    { id: 'p95', label: 'p95', mqe: "service_relation_client_percentile{p='95'}", unit: 'ms', aggregation: 'avg' },
    { id: 'sla', label: 'SLA', mqe: 'service_relation_client_call_sla/100', unit: '%', aggregation: 'avg' },
  ],
};

/**
 * Booster-ui defaults for the API-dependency dashboard. Endpoint
 * relations only expose a server-side MQE family, so there's no
 * `linkClientMetrics`.
 */
export const BOOSTER_ENDPOINT_DEP_DEFAULTS: EndpointDependencyConfig = {
  nodeMetrics: [
    { id: 'cpm', label: 'RPM', mqe: 'endpoint_cpm', unit: 'rpm', role: 'center', aggregation: 'avg' },
    { id: 'sla', label: 'SLA', mqe: 'endpoint_sla/100', unit: '%', role: 'ring', aggregation: 'avg' },
    { id: 'respTime', label: 'Latency', mqe: 'endpoint_resp_time', unit: 'ms', role: 'secondary', aggregation: 'avg' },
  ],
  // Server-side only (OAP has no `endpoint_relation_client_*` family).
  // Same four-metric set as the service map for visual consistency.
  linkMetrics: [
    { id: 'cpm', label: 'RPM', mqe: 'endpoint_relation_cpm', unit: 'rpm', role: 'lineServer', aggregation: 'avg' },
    { id: 'respTime', label: 'Avg response time', mqe: 'endpoint_relation_resp_time', unit: 'ms', aggregation: 'avg' },
    { id: 'p95', label: 'p95', mqe: "endpoint_relation_percentile{p='95'}", unit: 'ms', aggregation: 'avg' },
    { id: 'sla', label: 'SLA', mqe: 'endpoint_relation_sla/100', unit: '%', aggregation: 'avg' },
  ],
};

/**
 * Defaults for the network-profiling process-topology edge panel. The
 * metric names come from OAP's `meter-analyzer-config/network-profiling.yaml`
 * (metricPrefix `process_relation`), validated live against the demo's
 * mesh process topology (envoy → pilot-agent returns non-null cpm). OAP
 * observes each conversation from both eBPF probe sides, so client and
 * server families both exist. cpm metrics are per-minute rates; the
 * `*_total_bytes` are cumulative counters summed over the window.
 */
export const BOOSTER_PROCESS_TOPOLOGY_DEFAULTS: ProcessTopologyConfig = {
  // Default ProcessRelation TCP metric set — fully operator-editable via
  // the admin network-profiling config. ids pair across client/server so
  // the edge dashboard renders matching rows side-by-side; bytes are
  // /1024 → KB and exe times /1000000 → ms for readable units.
  edgeClientMetrics: [
    { id: 'write_cpm', label: 'Write OP / min', mqe: 'process_relation_client_write_cpm', aggregation: 'avg' },
    { id: 'read_cpm', label: 'Read OP / min', mqe: 'process_relation_client_read_cpm', aggregation: 'avg' },
    { id: 'write_kb', label: 'Write package size', mqe: 'process_relation_client_write_total_bytes/1024', unit: 'KB', aggregation: 'avg' },
    { id: 'read_kb', label: 'Read package size', mqe: 'process_relation_client_read_total_bytes/1024', unit: 'KB', aggregation: 'avg' },
    { id: 'write_avg_ms', label: 'Write OP avg time', mqe: 'process_relation_client_write_avg_exe_time/1000000', unit: 'ms', aggregation: 'avg' },
    { id: 'read_avg_ms', label: 'Read OP avg time', mqe: 'process_relation_client_read_avg_exe_time/1000000', unit: 'ms', aggregation: 'avg' },
    { id: 'connect_cpm', label: 'Connect OP / min', mqe: 'process_relation_client_connect_cpm', aggregation: 'avg' },
    { id: 'close_cpm', label: 'Close OP / min', mqe: 'process_relation_client_close_cpm', aggregation: 'avg' },
  ],
  edgeServerMetrics: [
    { id: 'write_cpm', label: 'Write OP / min', mqe: 'process_relation_server_write_cpm', aggregation: 'avg' },
    { id: 'read_cpm', label: 'Read OP / min', mqe: 'process_relation_server_read_cpm', aggregation: 'avg' },
    { id: 'write_kb', label: 'Write package size', mqe: 'process_relation_server_write_total_bytes/1024', unit: 'KB', aggregation: 'avg' },
    { id: 'read_kb', label: 'Read package size', mqe: 'process_relation_server_read_total_bytes/1024', unit: 'KB', aggregation: 'avg' },
    { id: 'write_avg_ms', label: 'Write OP avg time', mqe: 'process_relation_server_write_avg_exe_time/1000000', unit: 'ms', aggregation: 'avg' },
    { id: 'read_avg_ms', label: 'Read OP avg time', mqe: 'process_relation_server_read_avg_exe_time/1000000', unit: 'ms', aggregation: 'avg' },
    { id: 'connect_cpm', label: 'Connect OP / min', mqe: 'process_relation_server_connect_cpm', aggregation: 'avg' },
    { id: 'close_cpm', label: 'Close OP / min', mqe: 'process_relation_server_close_cpm', aggregation: 'avg' },
  ],
};

const __dirname = dirname(fileURLToPath(import.meta.url));
/** Locate bundled_templates/layers/ at runtime.
 *
 *   - **Dev** (tsx-watched source files): this file lives at
 *     `apps/bff/src/logic/layers/loader.ts`, so two `..` reaches
 *     `apps/bff/src/bundled_templates/`.
 *   - **Prod** (esbuild bundle): every import collapses into
 *     `/app/dist/server.js`, so `__dirname` is `/app/dist/` and only
 *     one `..` reaches the Dockerfile's `/app/bundled_templates/`.
 *
 *   We probe candidates in order — first existing wins. `process.cwd()`
 *   is the last fallback for operators running the bundle from an
 *   arbitrary working dir with the templates beside them. */
function locateConfigDir(): string {
  const candidates = [
    // Self-contained flat dist (`pnpm package` output: server.js +
    // bundled_templates as siblings inside ./dist/).
    join(__dirname, 'bundled_templates', 'layers'),
    // Dev (tsx watch: apps/bff/src/logic/layers/loader.ts).
    join(__dirname, '..', '..', 'bundled_templates', 'layers'),
    // Docker image (/app/dist/server.js → /app/bundled_templates).
    join(__dirname, '..', 'bundled_templates', 'layers'),
    join(process.cwd(), 'bundled_templates', 'layers'),
  ];
  for (const dir of candidates) {
    try {
      readdirSync(dir);
      return dir;
    } catch {
      /* try next */
    }
  }
  // Last-resort default — first candidate. The first readdir of an
  // empty result will surface the underlying ENOENT to the operator.
  return candidates[0];
}
const CONFIG_DIR = locateConfigDir();

let cache: Map<string, LayerTemplate> | null = null;

function load(): Map<string, LayerTemplate> {
  const out = new Map<string, LayerTemplate>();
  for (const file of readdirSync(CONFIG_DIR)) {
    if (!file.endsWith('.json')) continue;
    // Translation overlays (`<key>.i18n.<lang>.json`) live alongside
    // sources but follow a different schema — they're picked up by the
    // i18n store, not by the layer loader.
    if (isOverlayFilename(file)) continue;
    const raw = readFileSync(join(CONFIG_DIR, file), 'utf-8');
    let parsed: LayerTemplate & { alias_terms?: LayerSlotsConfig; alias?: LayerSlotsConfig | string };
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(`failed to parse layer config ${file}: ${err instanceof Error ? err.message : err}`);
    }
    const expected = basename(file, '.json').toUpperCase();
    if (parsed.key && parsed.key.toUpperCase() !== expected) {
      throw new Error(
        `layer config ${file}: file basename does not match \`key\` (${parsed.key})`,
      );
    }
    // Schema migration: per-layer entity term overrides used to live
    // under `slots` in the JSON; the more readable `aliases` (plural,
    // distinct from the existing top-level `alias` = layer display
    // name) is now accepted as the primary key. TS code keeps `slots`
    // internally — we normalize here so the rest of the BFF + UI
    // doesn't need to know which the operator wrote.
    const aliases = (parsed as { aliases?: LayerSlotsConfig }).aliases;
    if (!parsed.slots && aliases) {
      parsed.slots = aliases;
    }
    // Migrate legacy `widgets` (flat array) → `dashboards.service` so
    // the rest of the codebase only needs to know about the new shape.
    if (parsed.widgets && (!parsed.dashboards || !parsed.dashboards.service)) {
      parsed.dashboards = { ...parsed.dashboards, service: parsed.widgets };
    }
    // Profiling split: the old shape had a single `profiling` component
    // / dashboards bucket; we now split into Trace / eBPF / Async
    // profiling. Older JSONs are migrated by promoting the legacy
    // single bucket to `traceProfiling` — operators can fill the
    // remaining two slots through the admin UI on first edit.
    const legacyComponents = parsed.components as
      | (LayerComponentFlags & { profiling?: boolean })
      | undefined;
    if (legacyComponents && legacyComponents.profiling !== undefined) {
      if (legacyComponents.traceProfiling === undefined) {
        legacyComponents.traceProfiling = legacyComponents.profiling;
      }
      delete legacyComponents.profiling;
    }
    const legacyDashboards = parsed.dashboards as
      | (LayerDashboards & { profiling?: DashboardWidget[] })
      | undefined;
    if (legacyDashboards && legacyDashboards.profiling) {
      if (!legacyDashboards.traceProfiling) {
        legacyDashboards.traceProfiling = legacyDashboards.profiling;
      }
      delete legacyDashboards.profiling;
    }
    // Header block: accept the new `layer-header` JSON key (preferred)
    // and the legacy `metrics` alias. Internal callers read
    // `template.header`; we also populate `template.metrics` so older
    // code paths keep working without churn.
    const headerSrc = (parsed as unknown as Record<string, unknown>)['layer-header'] as
      | LayerHeaderConfig
      | undefined;
    if (headerSrc && !parsed.header) parsed.header = headerSrc;
    if (!parsed.header && parsed.metrics) parsed.header = parsed.metrics;
    if (!parsed.header) parsed.header = { columns: [] };
    parsed.metrics = parsed.header;

    // Overview tile schema: self-contained `OverviewMetric[]`. Support
    // two input shapes and normalize to the new one:
    //   1. `metrics: OverviewMetric[]`   ← new shape, pass through.
    //   2. `metrics: string[]`           ← previous shape (key refs
    //      into the header columns); resolve each ref to a full entry.
    if (parsed.overview) {
      const ov = parsed.overview as LayerOverviewConfig & {
        metrics?: unknown;
      };
      const columns = parsed.header?.columns ?? [];
      const findCol = (key: string): LayerMetricColumn | undefined =>
        columns.find((c) => c.metric === key);
      const fromRef = (key: string, fallbackLabel?: string): OverviewMetric => {
        const col = findCol(key);
        // mqe falls back to the bare metric key — the BFF landing
        // route resolves unknown keys through the metric catalog, so
        // legacy short keys like `cpm` keep working without an
        // explicit expression in the JSON.
        return {
          id: key,
          label: col?.label ?? fallbackLabel ?? key,
          mqe: col?.mqe ?? key,
          ...(col?.unit ? { unit: col.unit } : {}),
          ...(col?.aggregation ? { aggregation: col.aggregation } : {}),
          ...(col?.scale !== undefined ? { scale: col.scale } : {}),
          ...(col?.precision !== undefined ? { precision: col.precision } : {}),
        };
      };
      let resolved: OverviewMetric[] = [];
      if (Array.isArray(ov.metrics)) {
        for (const m of ov.metrics as Array<OverviewMetric | string>) {
          if (typeof m === 'string') {
            resolved.push(fromRef(m));
          } else if (m && typeof m === 'object' && 'mqe' in m) {
            resolved.push(m);
          } else if (m && typeof m === 'object' && 'label' in m) {
            // Object without an explicit mqe — treat the label as a
            // metric-key ref so older JSONs writing { label: "cpm" }
            // keep working.
            resolved.push(fromRef((m as { label: string }).label, (m as { label: string }).label));
          }
        }
      }
      // Assign auto-ids to any unkeyed entry. The id is what the SPA
      // threads through the landing query as the synthetic column key.
      resolved = resolved.map((m, i) => ({ id: m.id ?? `ov_${i}`, ...m }));

      // Groups migration: if the JSON didn't supply `groups`, wrap the
      // resolved metric list into a single auto-size group so older
      // configs still light up. JSON authors writing `groups` directly
      // win.
      const ovGroups = (ov as { groups?: OverviewGroup[] }).groups;
      if (!ovGroups || ovGroups.length === 0) {
        ov.groups = resolved.length > 0
          ? [{ title: '', size: 'auto', metrics: resolved }]
          : [];
      } else {
        // For author-supplied groups, also assign ov_* ids to any
        // unkeyed entries so the SPA has a stable synthetic column key
        // to query through.
        let counter = 0;
        ov.groups = ovGroups.map((g) => ({
          title: g.title ?? '',
          size: g.size === 'square' ? 'square' : 'auto',
          metrics: (g.metrics ?? []).map((m) => ({
            id: m.id ?? `ov_${counter++}`,
            ...m,
          })),
        }));
      }
      // Keep the legacy `metrics` array in sync with the flattened
      // groups so any caller still reading the old field keeps working.
      ov.metrics = (ov.groups ?? []).flatMap((g) => g.metrics);
    }
    out.set(parsed.key.toUpperCase(), parsed);
  }
  return out;
}

/** Resolve the widget set for a given scope, falling back to service. */
export function widgetsForScope(
  template: LayerTemplate,
  scope: DashboardScope,
): DashboardWidget[] {
  const d = template.dashboards;
  if (!d) return template.widgets ?? [];
  return d[scope] ?? d.service ?? template.widgets ?? [];
}

/** Resolve the topology config — operator override if present, else
 *  booster-ui defaults. Operators add a `topology` block to the layer
 *  JSON to swap MQE expressions, units, or visual role bindings. */
export function topologyConfigFor(template: LayerTemplate | null): TopologyConfig {
  if (template?.topology) return template.topology;
  return BOOSTER_TOPOLOGY_DEFAULTS;
}

/** Resolve the instance-topology drill-down config, or `null` when the
 *  layer doesn't opt in. Nested under the layer's `topology` block (so it
 *  rides the same import/export tooling); only the layers that ship it
 *  (general / mesh / k8s_service / cilium_service) return non-null. The
 *  service map keys the edge drill-down affordance off this presence. */
export function instanceTopologyConfigFor(
  template: LayerTemplate | null,
): InstanceTopologyConfig | null {
  return template?.topology?.instanceTopology ?? null;
}

/** Resolve the service-deployment config, or `null` when the layer
 *  doesn't opt in. A top-level `deployment` block (independent
 *  of `topology`); only layers that ship it return non-null. No
 *  booster-style defaults — the metric set is layer-specific (instance
 *  scope), so an unconfigured layer simply has no Deployment tab. */
export function deploymentConfigFor(
  template: LayerTemplate | null,
): DeploymentConfig | null {
  return template?.deployment ?? null;
}

/** Resolve the endpoint-dependency config — same fallback rule. */
export function endpointDependencyConfigFor(
  template: LayerTemplate | null,
): EndpointDependencyConfig {
  if (template?.endpointDependency) return template.endpointDependency;
  return BOOSTER_ENDPOINT_DEP_DEFAULTS;
}

/** Resolve the process-topology (network-profiling) config — same
 *  fallback rule. */
export function processTopologyConfigFor(
  template: LayerTemplate | null,
): ProcessTopologyConfig {
  if (template?.processTopology) return template.processTopology;
  return BOOSTER_PROCESS_TOPOLOGY_DEFAULTS;
}

/** Resolve the traces tab config. Defaults to surfacing both
 *  SkyWalking-native and Zipkin trace lists side-by-side. */
export function tracesConfigFor(template: LayerTemplate | null): TracesConfig {
  if (template?.traces) return template.traces;
  return { source: 'both' };
}

/** Resolve the logs tab config — defaults to per-service scope. */
export function logConfigFor(template: LayerTemplate | null): LogConfig {
  if (template?.log) return template.log;
  return { scope: 'service' };
}

/**
 * Persist an operator-edited template back to its JSON file. Validates
 * the basic shape, sorts keys for stable diffs, then refreshes the
 * in-memory cache so subsequent reads see the new state. Intentionally
 * naive: no concurrency control, no schema migrations — operators on
 * single-node BFF deployments, single admin user.
 */
export function writeLayerTemplate(template: LayerTemplate): void {
  if (!template.key || !/^[A-Z][A-Z0-9_]*$/.test(template.key)) {
    throw new Error('invalid template key (must be UPPER_SNAKE_CASE)');
  }
  const file = join(CONFIG_DIR, `${template.key.toLowerCase()}.json`);
  const serialised = JSON.stringify(template, null, 2) + '\n';
  writeFileSync(file, serialised, 'utf-8');
  reloadLayerTemplates();
}

/**
 * Lookup a layer template by enum key (case-insensitive). Returns
 * `null` when no template is defined for the layer — call sites should
 * fall back to a generic shape rather than failing.
 */
export function getLayerTemplate(layerKey: string): LayerTemplate | null {
  if (!cache) cache = load();
  return cache.get(layerKey.toUpperCase()) ?? null;
}

/** All loaded templates, useful for the admin layer-dashboards page. */
export function allLayerTemplates(): LayerTemplate[] {
  if (!cache) cache = load();
  return Array.from(cache.values());
}

/** Force a reload from disk — used by the admin save endpoint and by
 *  the file-watcher below when JSON config files change on disk. */
export function reloadLayerTemplates(): void {
  cache = null;
}

/**
 * Hot-reload bridge: watch the `config/` directory and invalidate the
 * cache whenever a JSON file changes. `tsx watch` only restarts on
 * `.ts` edits, so without this, JSON edits would be invisible until
 * the BFF was killed by hand. Debounced (50 ms) to coalesce the
 * editor-emitted rename+rename+change burst into a single reload.
 *
 * Errors are swallowed — a missing config dir is an existing
 * problem the loader surfaces elsewhere; failing to watch shouldn't
 * crash the BFF.
 *
 * MUST be called explicitly from `server.ts` rather than running at
 * import. Each test file that imports this module would otherwise
 * spawn its own fd, and large test suites EMFILE on low-ulimit
 * machines. Production calls `startLayerTemplateWatcher()` once during
 * server boot; tests skip it entirely.
 */
let watchTimer: NodeJS.Timeout | null = null;
let watcher: ReturnType<typeof fsWatch> | null = null;
export function startLayerTemplateWatcher(): void {
  if (watcher) return;
  try {
    watcher = fsWatch(CONFIG_DIR, (_event, filename) => {
      if (!filename || !filename.endsWith('.json')) return;
      if (watchTimer) clearTimeout(watchTimer);
      watchTimer = setTimeout(() => {
        cache = null;
        // Reload i18n overlays too — `*.i18n.<lang>.json` siblings are
        // watched alongside source templates, and overlay edits should
        // take effect without a BFF restart during dev / admin pushes.
        reloadI18nStore();
        watchTimer = null;
      }, 50);
    });
  } catch {
    // Best-effort. If fs.watch isn't supported on this filesystem
    // (e.g. some network FS), the operator can still reload through
    // the admin save endpoint.
  }
}
/** Tear down the watcher — for graceful shutdown + test cleanup. */
export function stopLayerTemplateWatcher(): void {
  if (watchTimer) {
    clearTimeout(watchTimer);
    watchTimer = null;
  }
  if (watcher) {
    watcher.close();
    watcher = null;
  }
}
