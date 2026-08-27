# Layer Dashboard Templates

A **layer template** is a single JSON file that describes everything Horizon needs to know about one OAP layer: its display name, color, sidebar grouping, which sub-tabs to expose, the service-list picker columns, the per-scope widget grids, the trace/log/topology routing, and the service-name parsing rule.

There is **one template per layer**. Horizon ships bundled templates for the common layers, and every layer your OAP reports — with or without a bundled template — is editable in the **Layer Dashboards** admin page (under *Dashboard setup*): a visual editor that saves a local draft and publishes to OAP with **Check diff & push**. You don't hand-edit JSON on the page; the shape documented below is the stored format the editor reads and writes, useful for understanding what each control maps to and for authoring templates as files.

## Template shape (reference)

```json
{
  "key": "GENERAL",
  "alias": "General Service",
  "group": "Application",
  "visibility": "public",
  "color": "var(--sw-accent)",
  "documentLink": "https://skywalking.apache.org/docs/main/next/en/concepts-and-designs/scopes/",
  "aliases": { ... },
  "components": { ... },
  "header": { ... },
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
| `splitByServiceGroup` | boolean | `false` | Split this layer into one sidebar entry per OAP service group (the `<group>::` prefix), each scoped to that group. Off keeps a single combined entry. Toggled in the admin right after **Alias**. |
| `group` | string | — | Sidebar grouping label. Layers sharing a `group` collapse together. |
| `visibility` | `public` \| `operate` | `public` | Section placement. `operate` puts the layer under the Operate group. |
| `color` | string | `var(--sw-accent)` | Hex or CSS variable for the layer's accent. |
| `documentLink` | string (URL) | — | External docs URL; renders as a small chip on the layer page. |
| `aliases` | object | OAP defaults | Per-layer entity term overrides (see below). `slots` is an accepted legacy alias for this key. |
| `components` | object | — | Which sub-tabs are enabled (see below). Every tab except the service dashboard is off unless explicitly set `true`. |
| `header` | object | — | Service-list picker columns + default sort. |
| `dashboards` | object | — | Per-scope widget arrays (the bulk of the template). |
| `topology` | object | — | Topology MQE override for the service-map view. |
| `endpointDependency` | object | — | API-dependency dashboard MQE override. |
| `traces` | `{ source?: 'native' \| 'zipkin' \| 'both' }` | `native` | Trace backend selection for this layer. |
| `log` | object | — | Logs tab scope (service / instance / endpoint). |
| `naming` | object | — | Service-name parsing rule (extracts cluster or other tokens from the OAP-reported name). |

## `aliases`

Layer-specific term overrides used in UI labels. (`slots` is an accepted legacy alias for this key; every bundled template uses `aliases`.)

```json
"aliases": {
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
  "pprofProfiling":     false,
  "deployment":         false
}
```

The keys are the per-layer sub-tabs. `networkProfiling` and `podLogs` are also available. Only the **service** dashboard is on when its key is omitted; every other tab is **off unless explicitly set `true`** — the bundled templates enable each tab they want (`general.json` sets every flag `true` for exactly this reason). The row a layer opens on is the **first enabled** in the order `service → instances → endpoints → topology → deployment → endpointDependency → traces → logs → profiling`. See [Menu and layers](menu-structure.md) for the full row order and how to change it.

`deployment` is the exception: it is **off by default** and only appears when the layer also carries a [`deployment`](#deployment) config block — see [Deployment](#deployment) below.

## `header`

The service-list picker on the layer landing page. Columns sortable, with one designated default sort.

The block is also accepted as `layer-header` — what every bundled template authors — and as `metrics`, which is what a template exported from the editor carries. All three name the same thing; pick one per template.

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
| `orderBy` | string, optional | `metric` value of the column that should sort by default. Omit it and the service list sorts by the first column; deleting the column it names clears it back to that default. |
| `columns[].metric` | string | Unique id for the column (referenced by `orderBy`). Required, and must be non-empty. |
| `columns[].label` | string | Column header label. Required, and must be non-empty. |
| `columns[].mqe` | string | MQE expression evaluated per service. |
| `columns[].unit` | string | Optional unit suffix. |
| `columns[].aggregation` | `sum` \| `avg` | Aggregation across the time window. |

At most **10** columns — the service list's query rejects more. Publishing is refused outright if two columns share a `metric`, if `orderBy` names no column, if a `metric` or `label` is empty, or if there are more than 10 columns. The editor holds you to the first two and the cap automatically, and marks an emptied `metric` or `label` invalid as you type.

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
| `type` | Widget kind: `card` for a single scalar (MQE collapses to one number), `line` for time-series, `top` for a sorted list, `record` for tabular records (slow SQL, slow statements), `table` for a labeled key→value table, or `tab` (a container of named tab panels, each holding its own widgets — see [Tab widgets](#tab-widgets)). |
| `tabs[]` | `tab` widgets only: the tab panels. Each is `{ "name": "…", "widgets": [ … ] }` — a label plus its own set of widgets. |
| `expressions[]` | MQE expressions to run. `card` typically uses one; `line` uses one per series; `top` may use multiple (each becomes a tab). A `tab` container has none of its own. |
| `expressionLabels[]` | Tab labels for `top`, legend labels for `line`. |
| `expressionUnits[]` | Per-expression unit override when expressions have heterogeneous units (e.g. ms + count). |
| `expressionAxes[]` | Two-axis charting. `0` = left y-axis (default), `1` = right. |
| `unit` | Widget-level unit suffix (used when all expressions share the same unit). |
| `format` | Value formatting: `int`, `decimal`, `compact` (K / M suffixes), `duration` (a seconds value rendered as a human time-ago), `enum` (a coded value mapped to a label via `valueMap`). |
| `valueMap` / `valueColors` | Enum-card display maps — value → label, and value → status-chip color (`ok` / `warn` / `err` / `info` / `neutral`). See [Dashboard Widgets → Status chips](../components/dashboard-widgets.md#status-chips-valuecolors). |
| `traceDrill` | `line` only — `{ "mode": "latency" \| "error" }` makes data points clickable, opening the layer's Traces tab pre-filtered to the slow or error traces around the clicked moment. See [Dashboard Widgets → Metric-to-trace drill](../components/dashboard-widgets.md#metric-to-trace-drill-tracedrill). |
| `span` | Column span in the 12-col grid. Default 4 = three widgets per row. |
| `rowSpan` | Vertical span. Default 1 (one 120 px row). |
| `visibleWhen` | Structured visibility predicate (object form). An MQE gate `{ "kind": "mqe", "expression": "<mqe>", "op": "exists" \| "gt" \| "lt", "value"?: <n> }` shows the widget only when the expression returns data (`exists`) or crosses a threshold; an entity gate `{ "kind": "entity", "attribute": "<attr>", "op": "exists" \| "eq", "value"?: "<v>" }` shows it only when the selected entity has that attribute — entity gates are Instance-scope only. |
| `x`, `y`, `w`, `h` | Legacy coordinates kept for old templates. Prefer `span` and `rowSpan`. |

### Choosing `type`

The widget type **must match the MQE shape**:

- Outermost call `latest(...)`, `max(...)`, `min(...)`, `avg(<plain-metric>)`, `sum(<plain-metric>)` → collapses to one scalar → `type: card`.
- Outermost call `relabels(...)`, `top_n(...)`, `histogram*(...)`, `rate(...)`, `increase(...)`, `aggregate_labels(...)` without scalar collapse → series → `type: line`.
- Outermost call `top_n(...)` returning a labeled list → `type: top`.
- Database-shaped record returns → `type: record`.

A `line` widget with a scalar-collapsed MQE renders a one-point chart and confuses operators. The widget editor warns; the schema does not enforce.

### Tab widgets

A `tab` widget is a sized grid slot that holds several **named tab panels**, each with its own set of widgets — its own little dashboard. Use it when several groups of widgets belong in one place — one tab per subsystem, or traffic vs. errors vs. saturation — without spending a slot on each.

A tab is just a `name` plus its own `widgets`. Switching a tab swaps the whole sub-grid; the widgets inside lay out in a 12-column grid within the slot. Only the **active** tab is queried — switching to a tab loads its widgets on demand and then keeps them warm, so an unopened tab costs nothing and flipping back is instant. A tab's widgets are ordinary widgets (`card` / `line` / `top` / `record` / `table`); a tab cannot contain another tab (one level deep).

To author one in the admin: add a widget, set its **Type** to `tab`, and size its slot (span / row span). The tile shows a **segmented tab bar** — click a tab to make it active, **+ tab** to add one — and the active tab's widgets are edited **inline, right on the tile**: a per-tab **+ widget** drops a widget into the active tab, and clicking a widget opens its config in the drawer. Manage the tabs themselves (rename / reorder / delete) from the drawer's **Tabs** list when the tab widget is selected. The tab slot is framed by an open top/bottom rule so its inner widgets keep full width.

The stored shape — a container with empty `expressions` and a `tabs[]` array of `{ name, widgets }` panels:

```json
{
  "id": "svc_signals",
  "title": "Service signals",
  "type": "tab",
  "span": 6,
  "rowSpan": 4,
  "expressions": [],
  "tabs": [
    {
      "name": "Golden signals",
      "widgets": [
        { "id": "sig_traffic", "title": "Traffic", "type": "line", "unit": "rpm", "span": 6, "rowSpan": 2, "expressions": ["service_cpm"] },
        { "id": "sig_latency", "title": "Latency", "type": "line", "unit": "ms", "span": 6, "rowSpan": 2, "expressions": ["service_resp_time"] },
        { "id": "sig_apdex", "title": "Apdex", "type": "card", "format": "decimal", "span": 4, "rowSpan": 2, "expressions": ["service_apdex/10000"] }
      ]
    },
    {
      "name": "Endpoints",
      "widgets": [
        { "id": "sig_top_api", "title": "Top APIs", "type": "top", "span": 12, "rowSpan": 3, "expressions": ["top_n(endpoint_cpm,20,des)"] }
      ]
    }
  ]
}
```

## `dashboardExtPages`

A component's `dashboards` grid is its **default page**. When one grid grows past what an operator can scan — or when a group of services deserves its own view — a component can expose additional pages. Each becomes its own row under the layer, with its own URL.

Only the three entity components can carry them: **service**, **instance**, and **endpoint**. Topology, traces, logs and the profilings are single-page features.

### Authoring them

Open **Dashboard setup → Layer dashboards**, pick a layer and a component, then use the **Page** dropdown above the widget canvas. The component's existing grid is listed as `DEFAULT` and cannot be renamed or removed. **+ Page** adds one; with a page selected, **Rename** and **Delete** act on it. Each page shows its id beside its name, because two pages may share a display name.

Adding widgets works exactly as it does on the default page — the canvas edits whichever page is selected.

A few rules the editor enforces as you type:

- A page's **id** is derived from its name and may not collide with a built-in tab (`topology`, `pprof`, `zipkin-trace`, …), because pages and tabs share a URL space. The name itself is never refused: calling a page "Topology" simply gives it the id `topology-2`.
- A page is created with a **name** and an **id**. The id is proposed from the name and can be edited before the page is added — after that it is fixed. It is the page's URL segment, its entry in a custom menu order, and the key its translations are stored under, so renaming the page later never moves it. An id is at most 48 characters and a name at most 64. The id is shown again on the **Menu key** line when the entry is selected in the Setup tab's menu preview.
- Two pages of one component may share a display name; they are told apart by their ids.
- A widget id must be unique across **all** pages of one component. The editor mints ids for you, so this only matters when importing a template by hand.
- Twelve pages per component is the maximum.

### Choosing which entities a page is about

A page can narrow the pickers it sits above, so it shows only the entities it is about.

**Every** entity page can filter the **service** list — an Instance or Endpoint page shows the service picker too, because a service is picked before the entity the page is about. An **Instance** page can additionally filter the instance list within that service, and match on instance attributes.

This includes the **default** page. It is the page every component already has, not an unfiltered one: the same fields appear with DEFAULT selected, and the only thing that makes it special is that it cannot be renamed or removed.

Name matching is the same for both:

- `agent` — case-insensitive substring
- `/^agent::/` — regular expression

The **regex** switch beside the field writes and reads those slashes for you. Both forms match the **full name** as OAP reports it, including any `group::` or `namespace.` prefix — that is what lets a page target one group without a separate group control.

An **Instance** page can also require attributes:

- `namespace` **exists** — the instance carries that attribute, with a non-empty value
- `language` **equals** `java` — case-insensitive

Attribute names are matched case-insensitively, and `language` counts as an attribute. Every condition must hold, and they apply on top of the name filter. These are the same words a widget's visibility rule uses, and they mean the same thing there.

**Checking a filter before it reaches anyone.** **Preview matches** opens the list the filter selects, twenty entities at a time, with an **All / Filtered** switch — All lists every candidate with the selected ones lit, so a pattern that matches the wrong thing is visible, not just a smaller number. On an Instance or Endpoint page it also lists what sits under a sampled service, since those pages show the service picker first.

**Naming what a page lists.** An extension page can set an **Entity label** — what that page calls the entity it shows, used by its picker and its back-link. Leave it blank and the layer's own **Menu labels** apply, which is what names the default page. The label is translatable like any other display text.

**The filter is configuration, not a control.** The page shows the entities it selects and nothing else — no filter box, no pattern, no way to widen it. The person reading the page did not write the filter and does not need to know one exists; the page's name is what tells them what it holds. An operator's own search box inside the picker still works, and searches within the page's set.

Because the filter is invisible on the page, the editor is where you check it. It lists every candidate and lights the ones the page will show, and warns when nothing matches — on the page itself, an over-narrow filter is indistinguishable from a layer with nothing reporting. Instance conditions preview against a sample service you pick, since instances only exist under one.

What filtering does to the current selection differs by component, and deliberately:

- On a **Service** page the service you had picked stays picked, even if the page's filter excludes it — the page narrows the list you choose from, not the choice you already made.
- On an **Instance** page the page's set owns what the widgets read: an instance the page excludes is replaced, for that page only, by the first one in its set. Your selection is untouched everywhere else in the layer and comes back when you leave the page.

The layer header's KPIs and its service count stay layer-wide either way; the picker's own count reads within the page's set.

### Stored shape

```json
{
  "dashboardExtPages": {
    "service": [
      {
        "id": "resource",
        "name": "Resource usage",
        "widgets": [ ... ]
      },
      {
        "id": "agents",
        "name": "Agents",
        "serviceFilter": "/^agent::/",
        "widgets": [ ... ]
      }
    ],
    "instance": [
      {
        "id": "brokers",
        "name": "Broker JVMs",
        "instanceFilter": "/^broker-/",
        "instanceAttributes": [
          { "attribute": "language", "op": "eq", "value": "java" },
          { "attribute": "namespace", "op": "exists" }
        ],
        "widgets": [ ... ]
      }
    ]
  }
}
```

`id` is the URL segment (`/layer/<key>/service/resource`) and the key translations are attached to, so it is stable across renames and reordering. `name` is translatable; `widgets` uses the same widget schema as `dashboards`.

`serviceFilter` may appear on any entity page, because all three show the service picker, and on `dashboardDefaultFilters.<scope>` — the same fields for the page that has no page object of its own. `alias` is an extension page's entity label. `instanceFilter` and `instanceAttributes` belong to Instance pages; placed on another component they are refused, because they would otherwise travel to the browser and be ignored, which reads as a filter that does not work. `op` is `exists` or `eq` (the editor labels it **equals**), an `eq` needs a value, and a page carries at most eight conditions.

Bundled templates ship no extension pages — the default grids are the pages every layer has.

## `menuOrder`

By default a layer's rows follow the built-in order, with each component's pages directly after it. `menuOrder` overrides that for one layer.

Edit it through **Rearrange menu** in the Setup tab rather than by hand; see [Menu and layers](menu-structure.md#rearranging-the-menu).

```json
{
  "menuOrder": ["service", "service/agents", "topology", "instance", "logs"]
}
```

Entries are row paths — a component is its own name, an extension page is `<component>/<pageId>`. Display names never appear, so renaming a page does not move it.

Absence means the built-in order. A row the list does not mention keeps its default placement and is appended, so enabling a component later adds its row instead of hiding it.

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

## `deployment`

Config for the **Deployment** tab — the **deployment topology of all of a service's instances**. Where the [instance map](#instance-map) drills into the instances *between* two services, Deployment shows how **one** service's own instances are deployed and call each other (for example a clustered store whose nodes call one another). Pick a service from the layer's Service header and the tab draws its instances as health-ring nodes with the intra-service calls between them — pan/zoom, animated edge flow, a per-call client/server metric panel, and a node popover with **Open instance dashboard**. The boxes lay out left → right along the calls between them, so an upstream → downstream chain reads in order.

It is **opt-in**: off for every layer until you enable the `deployment` component **and** add a `deployment` block — the **Deployment** sub-tab appears only when both are set. When the backend exposes no intra-service instance relations for the selected service, the tab simply shows an empty state — it is a pure consumer of what OAP reports.

**Node grouping.** Instances can be grouped into labelled boxes by one of three rules:

- **by one instance attribute** — e.g. group by `node_role`;
- **by several attributes** (composite) — combine attribute values into one key (e.g. `node_role` + `node_type`); an attribute that is absent on a node drops out of its key, so nodes carrying only the first attribute stay in one box while those carrying both split further;
- **by a name regex** — a named-capture pattern run on the instance name (same mechanism as the service-map grouping).

A second rule can **bundle a pod**: instances sharing a value (e.g. the same `pod_name`) render as one pod — a **main** hexagon with its sidecar containers attached as smaller hexes. A third rule picks each container's **role**, which sets the main container and lets each role carry its own metrics.

**Per role-pair edge metrics (`roleToRole`).** Once roles are defined, a deployment can give each *kind* of edge its own metrics with `roleToRole[]` — one entry per source-role → dest-role pair (e.g. `liaison → data`). The pair's metrics layer on top of the flat `linkServerMetrics` / `linkClientMetrics` fallback, so a `liaison → data` call can surface a different metric set — and a different headline number on the edge — than a `data → data` call, without forcing one flat list onto every relation. An edge resolves its pair from the two nodes' roles; the **most specific** entry wins (an exact `from` / `to` beats a `*` wildcard), and an edge matching no entry uses the flat link metrics. Each `roleToRole` entry's `primary` names the metric id(s) printed inline on the edge in the map (up to three, stacked; omit for panel-only).

When at least one role-pair is configured, the Deployment map gains a **Flows** sub-tab beside the topology graph: a single grid listing every edge, grouped by role-pair — one aligned sub-table per pair (a `liaison → data` group, a `data → data` group, …) showing that pair's metrics across every matching edge in the window. Clicking a row selects that edge on the map. The Flows tab appears only when `roleToRole` is non-empty.

**Configure it in the admin.** Open the layer in **Dashboard setup → Layer dashboards**, enable **Deployment** under **Components**, then open the **Deployment** scope. It has its own node / server-edge / client-edge metric editors (evaluated at instance scope — `service_instance_*` for nodes, instance-relation metrics for edges) plus the **Node clustering** picker (off / by attribute / by attributes / by name regex) and, once roles are defined, a **role-pair** editor where you add one `from → to` pair at a time (role keys or `*`) with its own metrics. The block is self-contained on the layer template, independent of the service-map topology config, so it travels with template export/import.

### Stored format (reference)

```json
"deployment": {
  "clusterBy": { "kind": "attributes", "attributes": ["node_role", "node_type"], "separator": " / ", "alias": "role" },
  "siblingBy": { "kind": "attribute", "attribute": "pod_name", "alias": "pod" },
  "roleBy":    { "kind": "attribute", "attribute": "container_name", "alias": "container" },
  "roles": [
    { "key": "data", "label": "Data", "main": true, "nodeMetrics": [ { "id": "write", "label": "Write/s", "mqe": "service_instance_cpm", "unit": "w/s", "role": "center", "aggregation": "avg" } ] }
  ],
  "roleToRole": [
    {
      "from": "liaison", "to": "data", "primary": ["write", "query"],
      "metrics": [
        { "id": "write", "label": "Write/s", "unit": "msg/s", "aggregation": "avg", "mqe": "meter_banyandb_instance_relation_publish_throughput{operation='batch-write'}", "role": "lineClient" },
        { "id": "write", "label": "Write/s", "unit": "msg/s", "aggregation": "avg", "mqe": "meter_banyandb_instance_relation_queue_sub_throughput{operation='batch-write'}", "role": "lineServer" }
      ]
    },
    { "from": "*", "to": "*", "primary": "msg", "metrics": [ ... ] }
  ],
  "linkServerMetrics": [ ... ],
  "linkClientMetrics": [ ... ]
}
```

| Field | Purpose |
|---|---|
| `clusterBy` | Which dashed box an instance lands in. `kind: "attribute"` (one attribute), `kind: "attributes"` (several, joined by `separator`, default ` / `), or `kind: "nameRegex"` (named-capture regex on the instance name). |
| `siblingBy` | Bundles instances that share this value into one pod (main + sidecar hexes). Same `kind` choices. Omit for one hex per instance. |
| `roleBy` | Resolves each instance's role (e.g. by `container_name`); the role decides the main container and which `roles[]` metrics apply. |
| `roles[]` | Per-role display: `key` (matches the `roleBy` value), `label`, `main` (true for the pod's primary hex), and `nodeMetrics[]` (same metric-def shape as the topology node metrics). |
| `nodeMetrics[]` | Fallback per-instance metrics for instances with no matching role. Optional when `roles[]` cover every instance. |
| `linkServerMetrics[]` / `linkClientMetrics[]` | Fallback per-call metrics on the server and client side of each intra-service edge — used by any edge whose role-pair matches no `roleToRole` entry. |
| `roleToRole[]` | Per source-role → dest-role edge metrics, layered on the flat link fallback. Each entry: `from` / `to` (a role key or `*` for any, matched case-insensitively; most-specific entry wins), `metrics[]` (same metric-def shape, each `role: lineServer` or `lineClient` picking the relation side), and `primary` (metric id or ordered id array printed inline on the edge — up to three). Drives the **Flows** sub-tab. |

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

Layer templates are editable at runtime via **Dashboard setup → Layer dashboards** (`/admin/layer-dashboards`, opened with `dashboard:read`; publishing a layer requires `dashboard:write`). The picker lists **every layer your OAP reports**, not just the ones with a shipped template — a layer with no template yet opens on a blank default you can configure and publish on first save. Pick a layer from the filterable dropdown (alias + key + sync status), then edit its service / instance / endpoint / topology / trace / log / profiling views. A live menu preview sits beside the Alias / Components / Menu-labels editor; clicking a menu item jumps to that component's config.

### How edits flow: draft → preview → publish

Your work-in-progress lives **in your browser**, never on the server until you publish. The live page everyone sees stays on the published OAP version throughout.

1. **Save (local).** Stores your edit as a draft in this browser only. Nobody else sees it, and your own normal browsing still shows the published version. The picker tags a layer with a local draft as **local**.
2. **Reset to ▾.** Loads the **Bundled** (shipped default) or **Remote** (OAP live) version into the editor as a fresh starting point.
3. **Preview ▾.** Opens the real layer page in a new tab rendering your **Local** draft, the **Bundled** default, or **Remote** — using sample data, so you can check layout, enabled components, and menu labels without touching the server. Preview works even for layers OAP currently reports no services for.
4. **Check diff & push.** Shows a side-by-side *remote → local* diff and publishes to OAP (the runtime source of truth). Enabled only when your draft actually differs from remote. The template is structurally checked before anything is stored: an unknown field, an unknown component flag or dashboard scope, a widget the dashboard grid cannot run (unknown kind, or no expression at all), or a service-list column the service list cannot query (a roll-up other than `sum` / `avg`, or more columns than it accepts) is refused and **nothing is written to OAP**. Work in progress is fine — a config section you opened but haven't filled in, or a metric row whose expression is still empty, publishes normally. After publishing, the draft is cleared and everyone sees the change.

   A template is also refused when it isn't the layer it is being published as — its `key` naming a different layer than the one you're publishing, a key spelled in lower case, or one of OAP's legacy layer names (`CACHE`, `DATABASE`, `MQ`, `GENAI`) where Horizon reads the modern one (`VIRTUAL_CACHE`, `VIRTUAL_DATABASE`, `VIRTUAL_MQ`, `VIRTUAL_GENAI`). Such a template would be stored under a name no page ever asks for: the push would report success and nothing would change on screen. The refusal names the one spelling the layer is read under. This is normally invisible through the editor and shows up when you import a hand-authored file or push through the API.

A top banner summarizes page state — *Synced from OAP — N diverged, Y local* plus how many layers are *not configured yet* — and **Diverged** / **Local** / **Not configured** filters narrow the picker. Each row shows a status chip: **synced** (bundled == OAP), **diverged** (OAP differs from bundled — OAP wins at render), **remote-only** (on OAP, no bundled default), **disabled** (deleted — see below), or **bundled** (OAP has no copy right now).

If OAP already holds a record that isn't readable as the template it is stored as — pushed by an older Horizon, by another tool, or by hand — the banner turns to **UNREADABLE** and lists each one with its OAP record id and the reason. Two shapes end up there: a record stored under a name Horizon never asks for (a lower-case layer key, an OAP legacy alias), and a record stored under the right name whose content declares a *different* layer. Neither renders anywhere: a layer whose only record is unreadable falls back to Horizon's built-in defaults, exactly as a layer with no published template does, and never to the other layer's dashboard. To clean one up, republish it so its stored name and its content agree — and if that means publishing under a different name, retire the record left behind on OAP afterwards; Horizon never retires a record on its own.

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

Import/export covers the **source layer template** (the English authoring layer) only. Per-locale translations are stored separately in OAP and managed on the [Translations](i18n.md) page — they're not part of this file. A layer exported to a *different* OAP arrives with its English source only; move its translations across on the Translations page if you need them there.

### Disabling / reactivating a layer

OAP has no hard delete, so the **Disable** button next to the layer title soft-disables the layer on OAP. A disabled layer is dropped from the sidebar and renders nowhere, for everyone.

A disabled layer still appears in this admin page (struck-through, status **disabled**) and offers a **Reactivate** button that re-enables it from the bundled default. A layer that exists only as an unpublished local draft is simply removed from your browser. Both actions are confirmed in a dialog first.

> **Note:** re-enabling depends on the OAP UI-template API clearing the disabled flag. On OAP versions that don't support this, a disabled layer must be re-enabled from the OAP side. Treat disabling a built-in layer as a heavyweight action.

## Bundled examples

| File | Layer | Notes |
|---|---|---|
| `general.json` | `GENERAL` | Reference shape — `service`/`instance`/`endpoint` dashboards, `top_apis`, header columns. |
| `mesh.json` | `MESH` | Istio data-plane. Uses `mesh_` metric family. |
| `k8s.json` | `K8S` | Kubernetes cluster. Aliases instances to **Nodes**, services to **Clusters**. |
| `mesh_cp.json` | `MESH_CP` | Istio control-plane (Pilot). |
| `so11y_oap.json` | `SO11Y_OAP` | OAP server self-observability. Grouped under **Self-Observability**. |
| `so11y_satellite.json` | `SO11Y_SATELLITE` | Satellite collector self-observability. |
| `so11y_java_agent.json` | `SO11Y_JAVA_AGENT` | Java agent self-observability. |
| `so11y_go_agent.json` | `SO11Y_GO_AGENT` | Go agent self-observability. |
| `banyandb.json` | `BANYANDB` | BanyanDB storage self-observability. Uses the `deployment` tab with `roleToRole` role-pair edges (liaison → data, …). |
| ... | various | One per OAP layer. |

Read the bundled JSON for the closest layer to yours before authoring a new template — most of the work is renaming MQE expressions to match your layer's metric prefix.

## Hot reload

Template changes made in the admin editor take effect on the next menu or dashboard refresh. Bundled file changes made outside Horizon require a BFF restart.

A change published **elsewhere** — from another Horizon, from `swctl`, from anything writing the same OAP store — reaches an open browser within about a minute. Horizon re-reads the template store on a slow cycle of its own, separate from the topbar refresh, so a dashboard someone else pushed appears without anyone reloading the page.

## When the template store cannot be read

In live mode the OAP-stored template is the only thing Horizon renders, so a store it cannot reach is worth saying plainly: the topbar shows **Dashboard template store unreachable**, along with how long ago the last successful read was, and the template admin pages become read-only until it recovers.

What stays on screen depends on whether Horizon has ever read the store:

- **It has read it before** — the dashboards, overviews and maps keep rendering the templates from that last successful read. Those are your published templates, only stale, so a brief outage of the admin port does not empty the console. The banner is what tells you they are not current.
- **It has never read it** — there is nothing of yours to show, so those pages are blocked and stay empty behind the banner.

In neither case does Horizon fall back to the templates bundled in the release. Showing shipped defaults in place of your own configuration would misrepresent what the console is displaying; an honest empty state is better. If you want the bundled templates rendered deliberately, that is what `templates.mode: readonly` is for.

Recovery needs no action: Horizon keeps re-reading, and the banner clears on its own once the store answers again.

## Common patterns

### Borrow from another layer

Templates are not inheritance-aware. To "inherit" from `general.json`, copy it and rename MQE expressions. There is no `extends:` keyword.

### Hide a tab entirely

```json
"components": { "logs": false }
```

The Logs tab disappears from the layer page nav. Existing direct-URL navigation to `/layer/<key>/logs` redirects to the first enabled tab.

### Link a latency or error widget to its traces

```json
{
  "id": "resp_time_line",
  "type": "line",
  "title": "Avg Response Time",
  "expressions": ["service_resp_time"],
  "unit": "ms",
  "traceDrill": { "mode": "latency" }
}
```

`traceDrill` makes the line's data points clickable — a click opens the layer's Traces tab pre-filtered to the slow (`latency` mode) or error (`error` mode) traces around the clicked moment. It needs the layer's `traces` component enabled with the native trace source. See [Dashboard Widgets → Metric-to-trace drill](../components/dashboard-widgets.md#metric-to-trace-drill-tracedrill).
