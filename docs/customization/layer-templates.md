# Layer Dashboard Templates

A **layer template** is a single JSON file that describes everything Horizon needs to know about one OAP layer: its display name, color, sidebar grouping, which sub-tabs to expose, the service-list picker columns, the per-scope widget grids, the trace/log/topology routing, and the service-name parsing rule.

There is **one template per layer**. Horizon ships a bundled template for every supported layer, and an administrator customizes them in the **Layer Dashboards** admin page (under *Dashboard setup*) — a visual editor that saves a local draft and publishes to OAP with **Check diff & push**. You don't hand-edit JSON on the page; the shape documented below is the stored format the editor reads and writes, useful for understanding what each control maps to and for authoring templates as files.

## Template shape (reference)

```json
{
  "key": "GENERAL",
  "alias": "General Service",
  "group": "Application",
  "visibility": "public",
  "color": "var(--sw-accent)",
  "documentLink": "https://skywalking.apache.org/docs/main/next/en/concepts-and-designs/scopes/",
  "slots": { ... },
  "components": { ... },
  "header": { ... },
  "overview": { ... },
  "dashboards": {
    "service":   [ ... widgets ... ],
    "instance":  [ ... widgets ... ],
    "endpoint":  [ ... widgets ... ],
    "dependency":[ ... widgets ... ],
    "topology":  [ ... widgets ... ],
    "trace":     [ ... widgets ... ],
    "logs":      [ ... widgets ... ],
    "traceProfiling":  [ ... widgets ... ],
    "ebpfProfiling":   [ ... widgets ... ],
    "asyncProfiling":  [ ... widgets ... ]
  },
  "topology": { ... },
  "endpointDependency": { ... },
  "traces": { "source": "native" },
  "log": { ... },
  "naming": { ... }
}
```

Every field is optional except `key`. Defaults are baked in for the rest.

## Top-level fields

| Field | Type | Default | Notes |
|---|---|---|---|
| `key` | string (UPPER_SNAKE) | **required** | Matches the OAP layer enum. The filename is the lowercased key. |
| `alias` | string | OAP-reported name | Display name in the sidebar and page headers. |
| `group` | string | — | Sidebar grouping label. Layers sharing a `group` collapse together. |
| `visibility` | `public` \| `operate` | `public` | Section placement. `operate` puts the layer under the Operate group. |
| `color` | string | `var(--sw-accent)` | Hex or CSS variable for the layer's accent. |
| `documentLink` | string (URL) | — | External docs URL; renders as a small chip on the layer page. |
| `slots` | object | OAP defaults | Per-layer entity term overrides (see below). |
| `components` | object | all-`true` | Which sub-tabs are enabled (see below). |
| `header` | object | — | Service-list picker columns + default sort. |
| `overview` | object | — | Overview tile config (groups of self-contained metrics) shown above the dashboard. |
| `dashboards` | object | — | Per-scope widget arrays (the bulk of the template). |
| `topology` | object | — | Topology MQE override for the service-map view. |
| `endpointDependency` | object | — | API-dependency dashboard MQE override. |
| `traces` | `{ source?: 'native' \| 'zipkin' \| 'both' }` | `native` | Trace backend selection for this layer. |
| `log` | object | — | Logs tab scope (service / instance / endpoint). |
| `naming` | object | — | Service-name parsing rule (extracts cluster or other tokens from the OAP-reported name). |

## `slots`

Layer-specific term overrides used in UI labels.

```json
"slots": {
  "services":         "services",
  "instances":        "instances",
  "endpoints":        "endpoints",
  "endpointDependency": "API dependency",
  "topology":         "Topology",
  "instanceTopology": "Instance map"
}
```

A Kubernetes layer might use `Pods` instead of `Instances`. The page titles, sidebar tabs, and pickers pick up the override automatically. `topology` renames the **Topology** sidebar tab; `instanceTopology` renames the **Instance map** drill-down. Edit these in the admin under **Menu labels** (the alias fields render in sidebar/menu order, showing only the entries the layer's enabled components expose).

## `components`

Per-tab feature toggles. A `false` value hides the tab.

```json
"components": {
  "service":            true,
  "instances":          true,
  "endpoints":          true,
  "endpointDependency": true,
  "topology":           true,
  "traces":             true,
  "logs":               true,
  "traceProfiling":     true,
  "ebpfProfiling":      false,
  "asyncProfiling":     false,
  "pprofProfiling":     false
}
```

The keys are the per-layer sub-tabs. `networkProfiling` and `podLogs` are also available; any key omitted defaults to enabled. The landing tab when a layer is clicked is the **first enabled** in the priority order `service → instances → endpoints → endpointDependency → topology → traces → logs → traceProfiling`.

## `header`

The service-list picker on the layer landing page. Columns sortable, with one designated default sort.

```json
"header": {
  "orderBy": "cpm",
  "columns": [
    {
      "metric": "cpm",
      "label": "RPM",
      "mqe": "service_cpm",
      "aggregation": "sum"
    },
    {
      "metric": "apdex",
      "label": "Apdex",
      "mqe": "service_apdex/10000",
      "aggregation": "avg"
    },
    {
      "metric": "p95",
      "label": "P95",
      "mqe": "service_percentile{p='95'}",
      "unit": "ms",
      "aggregation": "avg"
    }
  ]
}
```

| Field | Type | Notes |
|---|---|---|
| `orderBy` | string | `metric` value of the column that should sort by default. |
| `columns[].metric` | string | Unique id for the column (referenced by `orderBy`). |
| `columns[].label` | string | Column header label. |
| `columns[].mqe` | string | MQE expression evaluated per service. |
| `columns[].unit` | string | Optional unit suffix. |
| `columns[].aggregation` | `sum` \| `avg` | Aggregation across the time window. |

## `overview`

Header summary tiles on the layer page (above the dashboard grid). Renders self-contained, sub-layout-aware groups of metrics.

```json
"overview": {
  "groups": [
    {
      "title": "Latency & errors",
      "size": "auto",
      "metrics": [
        {
          "id": "p95",
          "label": "P95",
          "mqe": "service_percentile{p='95'}",
          "unit": "ms",
          "aggregation": "avg"
        },
        {
          "id": "errors",
          "label": "Errors",
          "mqe": "service_resp_time_percent_99",
          "unit": "%",
          "aggregation": "avg"
        }
      ]
    }
  ]
}
```

| Field | Type | Notes |
|---|---|---|
| `groups[].title` | string | Group header. |
| `groups[].size` | `auto` \| `wide` | Layout hint. `wide` doubles the group's column allocation. |
| `groups[].metrics[].id` | string | Unique id within the group. |
| `groups[].metrics[].label` | string | Tile label. |
| `groups[].metrics[].mqe` | string | MQE expression evaluated layer-wide (or per-service if a service is selected). |
| `groups[].metrics[].unit` | string | Unit suffix. |
| `groups[].metrics[].aggregation` | `sum` \| `avg` | Aggregation across the time window. |

## `dashboards`

The bulk of the template. A map from scope to an ordered widget array.

```json
"dashboards": {
  "service": [
    { "id": "rpm", "type": "line", "title": "RPM", ... },
    { "id": "p95", "type": "line", "title": "P95 latency", ... },
    { "id": "errors", "type": "card", "title": "Error rate", ... },
    { "id": "top_apis", "type": "top",  "title": "Top 20 APIs", ... }
  ],
  "instance": [ ... ],
  "endpoint": [ ... ]
}
```

### Scope enum

| Scope | Page |
|---|---|
| `service` | Service drill-down (primary). Used as fallback when other scopes are unset. |
| `instance` | Single service instance. |
| `endpoint` | Single endpoint. |
| `dependency` | Endpoint-to-endpoint relationships. |
| `topology` | Service-map visualization. |
| `trace` | Trace explorer. |
| `logs` | Log viewer. |
| `traceProfiling` | SkyWalking trace-driven profiling. |
| `ebpfProfiling` | eBPF profiling. |
| `asyncProfiling` | JVM async-profiler. |

### Scope resolution

Widgets for a scope resolve in this order:

```
dashboards[scope] → dashboards.service → template.widgets (legacy)
```

A layer without an explicit `instance` widget set will reuse `service` widgets on the instance page. The fallback keeps minimal templates short.

### Dashboard widget fields

| Field | Notes |
|---|---|
| `id` | Unique widget id within the dashboard. |
| `title` | Widget title shown in the card header. |
| `tip` | Optional hover hint. |
| `type` | Widget kind, usually `card`, `line`, `top`, `record`, or `table`. |
| `expressions[]` | MQE expressions to run. |
| `expressionLabels[]` | Tab labels for `top`, legend labels for `line`. |
| `expressionUnits[]` | Per-expression unit override. |
| `expressionAxes[]` | `0` for left axis, `1` for right axis on dual-axis line charts. |
| `unit` | Widget-level unit suffix. |
| `format` | `int`, `decimal`, or `compact`. |
| `span` | 12-column width. Default 4. |
| `rowSpan` | Row count. Default 1. |
| `visibleWhen` | Visibility predicate. |
| `layerScope` | Evaluate against the whole layer rather than the selected service. |
| `x`, `y`, `w`, `h` | Legacy coordinates kept for old templates. Prefer `span` and `rowSpan`. |
| `type` | `card` for single scalar (MQE collapses to one number); `line` for time-series; `top` for sorted list; `record` for tabular records (slow SQL, slow statements). |
| `expressions[]` | Array of MQE expressions. `card` typically uses one; `line` uses one per series; `top` may use multiple (each becomes a tab). |
| `expressionLabels[]` | Used by `top` to label each tab. |
| `expressionUnits[]` | Per-expression unit when expressions have heterogeneous units (e.g. ms + count). |
| `expressionAxes[]` | Two-axis charting. `0` = left y-axis (default), `1` = right. |
| `unit` | Widget-level unit (used when all expressions share the same unit). |
| `format` | Numeric formatting: `int`, `decimal`, `compact` (K / M suffixes). |
| `span` | Column span in the 12-col grid. Default 4 = three widgets per row. |
| `rowSpan` | Vertical span. Default 1 (one 120 px row). |
| `visibleWhen` | Predicate. Two supported shapes: `#entity.<key>` (truthy if the named entity key is set; e.g. `#entity.serviceInstance` to show only when an instance is selected) and `<metric> has value` (only show if the metric returns data). |
| `layerScope` | If true, MQE evaluates against the whole layer rather than the selected service. Used for layer-level summaries on the service page. |

### Choosing `type`

The widget type **must match the MQE shape**:

- Outermost call `latest(...)`, `max(...)`, `min(...)`, `avg(<plain-metric>)`, `sum(<plain-metric>)` → collapses to one scalar → `type: card`.
- Outermost call `relabels(...)`, `top_n(...)`, `histogram*(...)`, `rate(...)`, `increase(...)`, `aggregate_labels(...)` without scalar collapse → series → `type: line`.
- Outermost call `top_n(...)` returning a labeled list → `type: top`.
- Database-shaped record returns → `type: record`.

A `line` widget with a scalar-collapsed MQE renders a one-point chart and confuses operators. The widget editor warns; the schema does not enforce.

## `topology`

Config for the **Topology** map (the service-map view): which MQE metrics decorate each service node and each service-to-service call edge — and, optionally, the **instance map** drill-down. Edited in the admin under the layer's **Topology** scope (node-metric / server-edge / client-edge editors). Without a block, a sensible default metric set is used.

```json
"topology": {
  "nodeMetrics": [
    { "id": "cpm",      "label": "RPM",     "mqe": "service_cpm",       "unit": "rpm", "role": "center",    "aggregation": "avg" },
    { "id": "sla",      "label": "SLA",     "mqe": "service_sla/100",   "unit": "%",   "role": "ring",      "aggregation": "avg",
      "thresholds": { "invertHealth": true, "ok": 0.1, "warn": 1, "danger": 5 } },
    { "id": "respTime", "label": "Latency", "mqe": "service_resp_time", "unit": "ms",  "role": "secondary", "aggregation": "avg" }
  ],
  "linkServerMetrics": [
    { "id": "cpm", "label": "RPM", "mqe": "service_relation_server_cpm", "unit": "rpm", "role": "lineServer", "aggregation": "avg" }
  ],
  "linkClientMetrics": [
    { "id": "cpm", "label": "RPM", "mqe": "service_relation_client_cpm", "unit": "rpm", "role": "lineClient", "aggregation": "avg" }
  ],
  "instanceTopology": { "nodeMetrics": [ ... ], "linkServerMetrics": [ ... ], "linkClientMetrics": [ ... ] }
}
```

| Field | Notes |
|---|---|
| `nodeMetrics[]` | Per-service-node metrics. `role`: `center` (the number inside the node), `ring` (the health colour band on the node), `secondary` (surfaced in the node detail). |
| `linkServerMetrics[]` / `linkClientMetrics[]` | Per-call-edge metrics — server side (`service_relation_server_*`) and client side (`service_relation_client_*`). Ids that match across the two render aligned in the edge detail panel. |
| `*.id` / `*.label` / `*.mqe` / `*.unit` | Stable id, display name, MQE expression, optional unit. Everything on screen — names, values, legend — comes from these, nothing is hardcoded. |
| `*.role` | Visual binding (above). Edge metrics use `lineServer` / `lineClient`. |
| `*.aggregation` | `sum` or `avg` across the window. |
| `*.thresholds` | Four-band colour for a `ring` metric: `ok` / `warn` / `danger` boundaries, plus `invertHealth: true` for higher-is-better metrics (SLA, apdex, success rate) and an optional `invertBase` (default 100). |
| `instanceTopology` | **Optional.** Enables the instance map (see below). Same `nodeMetrics` / `linkServerMetrics` / `linkClientMetrics` shape, but the MQE is evaluated at **instance** scope (`service_instance_*` and `service_instance_relation_server/client_*`). Absent ⇒ the layer offers no instance map. |

### Instance map

When `topology.instanceTopology` is set, the Topology map gains an **instance-to-instance** drill-down. On the service map, select a call between two services and click **Instance map →**: it opens the instances of each service as two columns (left = client, right = server) with the instance-level calls between them — the same node health-ring (with a colour legend reading the ring metric's thresholds), per-service grouping boxes, per-call client/server metric panel, and pan/zoom as the service map. A toolbar pair-picker swaps the two services; a back button returns to the service map. Each grouping box is named with its service (the `<group>::` prefix handled by the same naming rule as the service map), and labels follow the layer's instance term (the `instances` / `instanceTopology` slots — e.g. *Pods*, *Sidecars*).

Enable and configure it in the admin: open the layer's **Topology** scope and turn on **Enable instance topology**, which reveals its own node / server-edge / client-edge metric editors (kept separate from the service-topology metrics). Horizon ships it pre-enabled for **GENERAL**, **MESH**, **K8S_SERVICE**, and **CILIUM_SERVICE**; it rides the topology block, so it travels with template export/import.

## `endpointDependency`

Config for the **API dependency** view — the endpoint-to-endpoint dependency map: which MQE metrics decorate each endpoint node and each endpoint-to-endpoint call edge. Same metric-def shape as [`topology`](#topology), but the MQE is evaluated at **endpoint** scope (`endpoint_*`) for nodes and **endpoint-relation** scope (`endpoint_relation_*`) for edges. Without a block, a sensible default metric set is used.

```json
"endpointDependency": {
  "nodeMetrics": [
    { "id": "cpm",      "label": "RPM",     "mqe": "endpoint_cpm",       "unit": "rpm", "role": "center",    "aggregation": "avg" },
    { "id": "sla",      "label": "SLA",     "mqe": "endpoint_sla/100",   "unit": "%",   "role": "ring",      "aggregation": "avg" },
    { "id": "respTime", "label": "Latency", "mqe": "endpoint_resp_time", "unit": "ms",  "role": "secondary", "aggregation": "avg" }
  ],
  "linkMetrics": [
    { "id": "cpm",      "label": "RPM",               "mqe": "endpoint_relation_cpm",        "unit": "rpm", "role": "lineServer", "aggregation": "avg" },
    { "id": "respTime", "label": "Avg response time", "mqe": "endpoint_relation_resp_time",  "unit": "ms",  "aggregation": "avg" }
  ]
}
```

| Field | Notes |
|---|---|
| `nodeMetrics[]` | Per-endpoint-node metrics. Same `id` / `label` / `mqe` / `unit` / `role` / `aggregation` / `thresholds` fields as the topology node metrics. |
| `linkMetrics[]` | Per-call-edge metrics. **Server-side only** — OAP exposes no `endpoint_relation_client_*` family, so (unlike the service map) there's a single edge metric list; use `role: lineServer`. |
| `showGroup` | Group endpoints by their naming rule in the node panel, same semantics as the topology `showGroup`. |

Edited in the admin under the layer's **API dependency** scope.

## `traces`

```json
"traces": { "source": "native" }
```

| Source | Behavior |
|---|---|
| `native` (default) | Traces queried via OAP's native trace query. |
| `zipkin` | Traces queried via the Zipkin v2 endpoint at `oap.zipkinUrl`. |
| `both` | Both sources, with a UI toggle. |

## `log`

```json
"log": { "scope": "service" }
```

| Scope | Behavior |
|---|---|
| `service` | Logs are queried per service. |
| `instance` | Logs are queried per service instance. |
| `endpoint` | Logs are queried per endpoint. |

## `naming`

Service-name parsing rule. Extracts a cluster (or other token) from the OAP-reported service name so the UI can show a grouped picker.

```json
"naming": {
  "pattern": "^([^|]+)\\|(.+)$",
  "groups": { "cluster": 1, "name": 2 }
}
```

When set, the layer's service list groups by `cluster`. Without it, services are listed flat.

## Admin Editor

Layer templates are editable at runtime via **Dashboard setup → Layer dashboards** (`/admin/layer-dashboards`, verb `dashboard:write`). Pick a layer from the filterable dropdown (alias + key + sync status), then edit its service / instance / endpoint / topology / trace / log / profiling views. A live menu preview sits beside the Alias / Components / Menu-labels editor; clicking a menu item jumps to that component's config.

### How edits flow: draft → preview → publish

Your work-in-progress lives **in your browser**, never on the server until you publish. The live page everyone sees stays on the published OAP version throughout.

1. **Save (local).** Stores your edit as a draft in this browser only. Nobody else sees it, and your own normal browsing still shows the published version. The picker tags a layer with a local draft as **local**.
2. **Reset to ▾.** Loads the **Bundled** (shipped default) or **Remote** (OAP live) version into the editor as a fresh starting point.
3. **Preview ▾.** Opens the real layer page in a new tab rendering your **Local** draft, the **Bundled** default, or **Remote** — using sample data, so you can check layout, enabled components, and menu labels without touching the server. Preview works even for layers OAP currently reports no services for.
4. **Check diff & push.** Shows a side-by-side *remote → local* diff and publishes to OAP (the runtime source of truth). Enabled only when your draft actually differs from remote. After publishing, the draft is cleared and everyone sees the change.

A top banner summarizes page state — *Synced from OAP — N diverged, Y local* — and **Diverged** / **Local** filters narrow the picker. Each row shows a status chip: **synced** (bundled == OAP), **diverged** (OAP differs from bundled — OAP wins at render), **remote-only** (on OAP, no bundled default), **disabled** (deleted — see below), or **bundled** (OAP has no copy right now).

### Bundled defaults vs. your OAP-published templates

Each layer template has two copies: the **bundled** default shipped with Horizon, and the **remote** copy stored on OAP (what end users actually render — OAP wins at render time). On boot, Horizon seeds OAP **only with templates that are absent there** — a brand-new layer with no remote copy yet is pushed automatically so it works out of the box.

It does **not** overwrite a template that already exists on OAP. So when you upgrade Horizon and a bundled default changes — a new metric, a new capability such as the instance map, a tweaked widget — layers you've already published show as **diverged**: OAP keeps winning at render and your published edits are preserved. The new bundled default is *offered*, not forced.

To adopt a new bundled default on an existing layer, publish it from the admin:

- the **Diverged** filter narrows the picker to the affected layers;
- **Reset to ▾ → Bundled** loads the shipped default into the editor, then **Check diff & push** publishes it to OAP; or
- review the *remote → bundled* diff first and keep any of your own changes before pushing.

This is why a freshly shipped capability can read **diverged / off** until you push it: the new config is bundled, but your OAP copy stays the source of truth and only changes when you publish. (New layers absent from OAP are the one case that goes live automatically, via the boot-time seed above.)

### Import / Export

**Export** downloads the layer's **in-use version** — what end users render now (the OAP-live copy, or the bundled default when OAP has none) — as a JSON file, for backup, sharing, or moving the dashboard to another OAP.

**Import** reads a layer-template JSON file and loads it as a **local draft** in this browser — it never writes OAP directly. Preview it, then **Check diff & push** to publish. Because layer keys are a fixed set, import targets the layer the file names (e.g. `MESH`), and that layer must already be present on this deployment; a file for a layer not loaded here, or one that isn't a valid layer template, is rejected with a message.

Import/export covers the **source layer template** (the English authoring layer) only. Per-locale translations are stored separately in OAP and managed on the [Translations](/customization/i18n) page — they're not part of this file. A layer exported to a *different* OAP arrives with its English source only; move its translations across on the Translations page if you need them there.

### Disabling / reactivating a layer

OAP has no hard delete, so the **Disable** button next to the layer title soft-disables the layer on OAP. A disabled layer is dropped from the sidebar and renders nowhere, for everyone.

A disabled layer still appears in this admin page (struck-through, status **disabled**) and offers a **Reactivate** button that re-enables it from the bundled default. A layer that exists only as an unpublished local draft is simply removed from your browser. Both actions are confirmed in a dialog first.

> **Note:** re-enabling depends on the OAP UI-template API clearing the disabled flag. On OAP versions that don't support this, a disabled layer must be re-enabled from the OAP side. Treat disabling a built-in layer as a heavyweight action.

## Bundled examples

| File | Layer | Notes |
|---|---|---|
| `general.json` | `GENERAL` | Reference shape — `service`/`instance`/`endpoint` dashboards, `top_apis`, header columns. |
| `mesh.json` | `MESH` | Istio data-plane. Uses `mesh_` metric family. |
| `k8s.json` | `K8S` | Kubernetes cluster. Slots use `pod` instead of `instance`. |
| `mesh_cp.json` | `MESH_CP` | Istio control-plane (Pilot). |
| ... | various | One per OAP layer. |

Read the bundled JSON for the closest layer to yours before authoring a new template — most of the work is renaming MQE expressions to match your layer's metric prefix.

## Hot reload

Template changes made in the admin editor take effect on the next menu or dashboard refresh. Bundled file changes made outside Horizon require a BFF restart.

## Common patterns

### Borrow from another layer

Templates are not inheritance-aware. To "inherit" from `general.json`, copy it and rename MQE expressions. There is no `extends:` keyword.

### Hide a tab entirely

```json
"components": { "logs": false }
```

The Logs tab disappears from the layer page nav. Existing direct-URL navigation to `/layer/<key>/logs` redirects to the first enabled tab.

### Add a layer-wide summary widget on the service page

```json
{
  "id": "layer_total_rpm",
  "type": "card",
  "title": "Layer-wide RPM",
  "expressions": ["sum(service_cpm)"],
  "layerScope": true,
  "span": 3
}
```

`layerScope: true` evaluates the MQE against the entire layer rather than the selected service.
