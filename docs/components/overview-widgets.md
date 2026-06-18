# Overview Widgets

Six widget types render on overview pages. Each `widget.type` you set in a template selects one of them, and reads its own set of fields.

## Grid context (recap)

- 12 columns per row, overrideable per section via the most recent `section-break.cols`.
- Row height 72 px (`grid-auto-rows`).
- `span` (1–12) controls column width; `rowSpan` (1–8) controls row count.
- Gap 12 px. Single-column responsive collapse below 1100 px viewport.

## `metric`

**Renders:** Single scalar with optional unit. Used for headline KPIs on overviews.

### Fields

| Field | Type | Notes |
|---|---|---|
| `id` | string | Required. |
| `title` | string | Required. Card title. |
| `tip` | string | Optional hover hint. |
| `layer` | string | Layer key for MQE scope. |
| `mqe` | string | MQE expression. Must collapse to one scalar. |
| `unit` | string | Unit suffix (e.g. `ms`, `%`, `rpm`). |
| `aggregation` | `sum` \| `avg` | Window aggregation. |
| `span` | 1–12 | Default depends on context, typically 3. |
| `rowSpan` | 1–8 | Default 1. |

### Behavior

Values are formatted compactly:

- M / k suffixes for large numbers (1.2M, 3.4k).
- Two decimal places for fractional values.
- `null` / `undefined` → `—` placeholder.
- Unit appended.

### Example

```json
{
  "id": "total_rpm",
  "title": "Total RPM",
  "type": "metric",
  "layer": "GENERAL",
  "mqe": "sum(service_cpm)",
  "unit": "rpm",
  "aggregation": "sum",
  "span": 3
}
```

## `kpi-tile`

**Renders:** Compound tile — optional service-count header row plus N KPI rows. Each KPI row is either a number readout or a progress bar.

### Fields

| Field | Type | Notes |
|---|---|---|
| `id`, `title`, `tip`, `layer`, `span`, `rowSpan` | — | Common. |
| `showCount` | boolean | If true, renders the layer's service count as a header row. Clicking it navigates to `/layer/<layer>/service`. |
| `kpis` | `OverviewKpi[]` | One per row. |

### `OverviewKpi`

| Field | Notes |
|---|---|
| `label` | Row label. |
| `mqe` | Required when `source: mqe` (the default). |
| `unit` | Unit suffix. |
| `aggregation` | `sum` or `avg`. |
| `style` | `number` (default) or `progress-bar`. |
| `max` | Required for `progress-bar`. The 100 % value. |
| `source` | `mqe` (default) or `service-count`. |

### Behavior

- `style: number` — value formatted compactly, right-aligned.
- `style: progress-bar` — fill ratio = `value / max`. Color follows the layer accent.
- `showCount` row clickable; KPI rows are not (the whole tile is the unit of action).

### Example

```json
{
  "id": "general_summary",
  "title": "General services",
  "type": "kpi-tile",
  "layer": "GENERAL",
  "showCount": true,
  "span": 4,
  "rowSpan": 3,
  "kpis": [
    { "label": "Apdex", "mqe": "avg(service_apdex/10000)", "aggregation": "avg", "style": "progress-bar", "max": 1 },
    { "label": "P95",   "mqe": "avg(service_percentile{p='95'})", "unit": "ms", "aggregation": "avg" }
  ]
}
```

## `metric-composite`

**Renders:** Mixed KPI layout — number-style KPIs go into auto-fit count tiles; progress-bar-style (or `unit: '%'`) KPIs go into the bar grid. One widget can carry both shapes.

This is the unified replacement for the old per-feature widgets (`k8s-service-count`, `pilot`, `service-count`). Anything compound now goes through `metric-composite`.

### Fields

| Field | Type | Notes |
|---|---|---|
| `id`, `title`, `tip`, `layer`, `span`, `rowSpan` | — | Common. |
| `kpis` | `OverviewKpi[]` | Auto-split between count tiles and the bar grid (see below). |

### Layout

- Count tiles: `grid-template-columns: repeat(auto-fit, minmax(100px, 1fr))`, gap 8 px.
- Bar rows: `grid-template-columns: repeat(auto-fit, minmax(180px, 1fr))`, gap 12 px.

### Auto-split rule

A KPI lands in the bar grid when:

- `style === 'progress-bar'`, **or**
- `unit === '%'`.

Otherwise it lands in the count tiles. This lets you author a Kubernetes-style summary (count of nodes + count of pods + CPU % bar + memory % bar) as one widget.

### Example

```json
{
  "id": "k8s_summary",
  "title": "Cluster capacity & utilisation",
  "type": "metric-composite",
  "layer": "K8S",
  "span": 12,
  "rowSpan": 3,
  "kpis": [
    { "label": "Nodes", "mqe": "latest(k8s_cluster_node_total)" },
    { "label": "Pods",  "mqe": "latest(k8s_cluster_pod_total)" },
    { "label": "CPU",   "mqe": "k8s_cluster_cpu_cores_requests/k8s_cluster_cpu_cores*100",
                        "unit": "%", "style": "progress-bar", "max": 100 },
    { "label": "Memory","mqe": "k8s_cluster_memory_requests/k8s_cluster_memory*100",
                        "unit": "%", "style": "progress-bar", "max": 100 }
  ]
}
```

## `alarms`

**Renders:** Active-incident rail. Top-N rows of the most recent firing alarms in the last 60 minutes, plus a total count chip.

### Fields

| Field | Type | Notes |
|---|---|---|
| `id`, `title`, `tip`, `span`, `rowSpan` | — | Common. |
| `layer` | string | Optional. If set, alarms are filtered by layer (server-side on modern OAP, client-side on legacy). |
| `limit` | number | Cap on rows. Default 10. |

### Behavior

- Fetches the most recent firing alarms over a 60-minute, server-resolved window.
- **Dual-mode fetch:**
  - **Modern** (`queryAlarms` capability present): server-side layer filter, server-side time window.
  - **Legacy** (`getAlarm` only): all-layers fetch, client-side layer filter.
- Read-only. No acknowledge / close / silence buttons — alarm recovery is backend-automatic in OAP.
- Clicking a row navigates to the full Alarms page filtered to that entity / time.

### Example

```json
{
  "id": "active_alarms",
  "title": "Active alarms",
  "type": "alarms",
  "layer": "GENERAL",
  "limit": 10,
  "span": 4,
  "rowSpan": 4
}
```

## `topology`

**Renders:** Service-map for the configured layer. Static snapshot of the current window — the full Topology tab on a per-layer page is interactive (node / edge selection, detail sidebar); the overview widget is a glanceable view. Both share the same map: nodes show their **detected technology's component icon** (PostgreSQL, Redis, Kafka, …), and a **Filter** control (top-left of the map) hides nodes by **layer** — each row shown with the layer's icon and localized name, the same as the sidebar — with an **Others** bucket for peers OAP couldn't resolve and a standalone **User** toggle — the quickest way to drop the conjectured "undefined" nodes from a busy map. The layer rows are built from whatever the map currently shows and default to showing everything.

### Fields

| Field | Type | Notes |
|---|---|---|
| `id`, `title`, `tip`, `layer`, `span`, `rowSpan` | — | Common. |

No MQE — uses the layer's topology metric from the layer template (`topology.metric`).

### Example

```json
{
  "id": "general_topology",
  "title": "Service map",
  "type": "topology",
  "layer": "GENERAL",
  "span": 8,
  "rowSpan": 4
}
```

## `section-break`

**Renders:** Visual row header with horizontal rules. No data fetch.

### Fields

| Field | Type | Notes |
|---|---|---|
| `type` | `'section-break'` | Required. |
| `title` | string | Section header text. |
| `cols` | number | **Overrides the grid column count for following widgets** (until the next `section-break`). Default 12. |

### Behavior

- Does not occupy a grid cell as a widget — it terminates the current section and starts a new one.
- The `cols` value travels with the section. Use to switch between a 12-col layout (full-width widgets) and a 6-col layout (paired side-by-side widgets).

### Example

```json
{ "type": "section-break", "title": "Cluster capacity", "cols": 6 }
```

## Type-aware admin editor

The Overview Templates admin editor (`/admin/overview-templates`, verb `overview:write`) exposes per-type forms — only fields relevant to the chosen `type` are shown. See [Customization → Overview Templates](../customization/overview-templates.md#admin-editor).

## Choosing the right widget

| Need | Widget |
|---|---|
| One scalar headline. | `metric` |
| Service count + 1–3 KPI rows for one layer. | `kpi-tile` |
| Mixed counts + bars (e.g. Kubernetes capacity summary). | `metric-composite` |
| Active-incident rail. | `alarms` |
| Service map snapshot. | `topology` |
| Row separator with custom column count. | `section-break` |

If you find yourself wanting a chart on an overview, that probably belongs on a layer dashboard instead (see [Dashboard Widgets](dashboard-widgets.md)). Overviews are KPI-shaped; dashboards are time-series-shaped.
