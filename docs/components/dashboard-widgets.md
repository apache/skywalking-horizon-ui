# Dashboard Widgets

Five widget types render on per-layer dashboards. Each `widget.type` you set in a template selects one of them.

## Grid context

- 12-column grid (`grid-template-columns: repeat(12, minmax(0, 1fr))`).
- Row height 120 px (`grid-auto-rows`).
- Gap 10 px.
- `grid-auto-flow: dense` — gaps backfill with smaller widgets.
- `span` defaults to 4 (three widgets per row); `rowSpan` defaults to 1.
- Legacy 24-col coordinates: `w` halves to 12-col, `h / 8` becomes row count. Old templates keep working.
- Responsive collapse below 1100 px viewport.

## Common widget shape

| Field | Notes |
|---|---|
| `id` | Unique widget id within the dashboard. |
| `title` | Widget title shown in the card header. |
| `tip` | Optional hover hint. |
| `type` | One of `card`, `line`, `top`, `record`, or `table`. |
| `expressions[]` | MQE expressions. `card` typically uses one; `line` one-per-series; `top` one-per-tab; `table` one labeled `latest(…)` metric. |
| `expressionLabels[]` | Used by `top` for tab labels and by `line` for legend names. |
| `expressionUnits[]` | Per-expression unit override (mixed-unit charts). |
| `expressionAxes[]` | `0` = left axis (default), `1` = right axis. |
| `unit` | Widget-level default. |
| `format` | `int`, `decimal`, `compact`, `duration` (a seconds value rendered as a human time-ago, e.g. "5m 20s ago"), `enum` (a coded value mapped to a label via `valueMap`). |
| `tableHeaders` | `table` only — `[, valueHeader]`; the value column's header. Label columns are headed by their dimension name. |
| `showTableValues` | `table` only — show the value column. `false` for presence-only lists (e.g. node conditions). Default `true`. |
| `visibleWhen` | Structured visibility predicate (object form). An MQE gate `{ "kind": "mqe", "expression": "<mqe>", "op": "exists" \| "gt" \| "lt", "value"?: <n> }` hides the widget unless the expression returns data (`exists`) or crosses a threshold; an entity gate `{ "kind": "entity", "attribute": "<attr>", "op": "exists" \| "eq", "value"?: "<v>" }` hides it unless the selected entity has that attribute (Instance-scope only). |
| `layerScope` | Evaluate against the whole layer rather than the selected service. |

## `card`

**Renders:** Single scalar value with optional unit, formatted per `format`.

### When to use

The widget's MQE collapses to a single number. Detect by looking at the outermost MQE call: `latest(...)`, `max(...)`, `min(...)`, `avg(<plain-metric>)`, `sum(<plain-metric>)` are scalar-collapse functions.

A `line` widget with a scalar-shaped MQE renders a one-point chart, which is misleading. Use `card`.

### Example

```json
{
  "id": "error_rate",
  "title": "Error rate",
  "type": "card",
  "expressions": ["service_sla/100"],
  "unit": "%",
  "format": "decimal",
  "span": 3
}
```

## `line`

**Renders:** Multi-series line chart.

### Multi-series

One series per expression in `expressions[]`. Labels from `expressionLabels[]` populate the legend.

```json
{
  "id": "latency",
  "title": "Latency percentiles",
  "type": "line",
  "expressions": [
    "service_percentile{p='50'}",
    "service_percentile{p='95'}",
    "service_percentile{p='99'}"
  ],
  "expressionLabels": ["P50", "P95", "P99"],
  "unit": "ms",
  "span": 6,
  "rowSpan": 2
}
```

### Dual y-axis

When any expression sets `expressionAxes` to `1`, the right axis appears. Use for mixed-unit charts where one series is throughput (rpm) and another is latency (ms).

```json
{
  "id": "traffic_vs_latency",
  "title": "Traffic vs P95",
  "type": "line",
  "expressions": ["service_cpm", "service_percentile{p='95'}"],
  "expressionLabels": ["Throughput", "P95"],
  "expressionUnits": ["rpm", "ms"],
  "expressionAxes": [0, 1],
  "span": 6,
  "rowSpan": 2
}
```

### Behavior

- Smooth lines with circle markers.
- Legend visible when more than one series; hidden for single series.
- Tooltip is positioned so it does not clip near grid edges.
- **Synced crosshairs**: pointing at a time on this chart highlights the same time on every other `line` chart on the page.
- Data-only updates (same structure, new values) animate smoothly. Structure changes do a full replace.

### When `line` is wrong

- MQE collapses to one number → use `card`.
- MQE returns a sorted list of (label, value) → use `top`.

## `top`

**Renders:** Sorted list. Rank + name + value with a background fill bar normalized to the maximum.

### Tabs

When `expressions[]` has multiple entries, a tab switcher above the list lets the operator flip between expressions (each tab is a separate sort). Labels from `expressionLabels[]`; units from `expressionUnits[]`.

### Example

```json
{
  "id": "top_apis",
  "title": "Top 20 APIs",
  "type": "top",
  "expressions": [
    "top_n(endpoint_cpm, 20, des)",
    "top_n(endpoint_resp_time, 20, des)",
    "top_n(endpoint_sla, 20, asc)"
  ],
  "expressionLabels": ["Traffic", "Slow", "Errors"],
  "expressionUnits": ["rpm", "ms", "%"],
  "span": 3,
  "rowSpan": 4
}
```

### Behavior

- Rows are clickable when the result includes an entity reference — typically navigates to the per-endpoint or per-instance drill-down.
- Bar fill normalized per-tab (each tab has its own max).
- Background color follows the layer accent.

### MQE requirements

The MQE must return a labeled list. `top_n(<metric>, N, <des|asc>)` is the canonical shape. `aggregate_labels(...)` can also produce list-shaped output.

## `record`

**Renders:** Tabular records. Used for "slow SQL", "slow statements", and similar list-of-records output.

### When to use

The data source returns a record set (rows × typed columns) rather than a numeric time series. Examples:

- Slow SQL statements with execution time, count, statement text.
- Slow gRPC calls with method name, latency, status code.

### Example

```json
{
  "id": "slow_sql",
  "title": "Slow SQL",
  "type": "record",
  "expressions": ["top_n(database_slow_statement, 20, des)"],
  "span": 6,
  "rowSpan": 4
}
```

### Behavior

- Each row is one sampled record: the statement / command text, its value (e.g. latency), and — when the sample carries a trace id — a jump-to-trace icon at the row head that opens the originating trace in the trace viewer.
- Records are sampled, so a row's trace id can be absent; the jump-to-trace icon appears only when the sample has one.
- Click a row's statement text to copy it to the clipboard.

## `table`

**Renders:** A key→value table for a **labeled** `latest(…)` metric — one row per label combination, one column per label dimension, plus an optional value column.

### When to use

For multi-dimensional status metrics that a scalar `card` can't summarize and a time-series `line` misrepresents — e.g. pod phase per service, node condition, deployment replicas, queue depth per topic. The MQE is a single `latest(<labeled metric>)`; each returned label set becomes a row.

### Example

```json
{
  "id": "node_status",
  "title": "Node Status",
  "type": "table",
  "expressions": ["latest(k8s_cluster_node_status)"],
  "showTableValues": false
}
```

Renders columns `Condition | Node` (one per label key). A widget like Deployment Replicas sets `"showTableValues": true` and `"tableHeaders": ["", "Replicas"]` to show the value column headed "Replicas".

### Behavior

- Columns are derived from the union of label keys across rows; headers are the dimension names (the value column header comes from `tableHeaders[1]`).
- `showTableValues: false` drops the value column for presence-only lists (where the value is always 1).
- Scrolls within the widget when rows overflow.

## Visibility predicates

`visibleWhen` lets a widget hide itself based on context. It takes a structured object in one of two forms:

- **MQE gate** — `{ "kind": "mqe", "expression": "<mqe>", "op": "exists" | "gt" | "lt", "value"?: <n> }`. With `op: "exists"` the widget shows only when the expression returns non-null data (e.g. JVM metrics only on JVM-based services); `gt` / `lt` compare the result against `value`.
- **Entity gate** — `{ "kind": "entity", "attribute": "<attr>", "op": "exists" | "eq", "value"?: "<v>" }`. Shows the widget only when the selected entity carries that attribute (`exists`) or matches `value` (`eq`). Entity gates are Instance-scope only — use them for "instance details" widgets on the service page that should not render at the service-only level.

The bundled `BANYANDB` layer uses an entity gate to keep lifecycle-only widgets (Time Since Last Sync, Last Sync, and the rest of the lifecycle role's metrics) off instances of every other role. They show only when the selected instance's `container_name` is `lifecycle`:

```json
{
  "id": "lifecycle_last_run",
  "title": "Time Since Last Sync",
  "type": "card",
  "format": "duration",
  "expressions": ["latest(meter_banyandb_instance_lifecycle_last_run)"],
  "visibleWhen": {
    "kind": "entity",
    "attribute": "container_name",
    "op": "eq",
    "value": "lifecycle"
  }
}
```

The predicate is evaluated on every data refresh; the widget disappears (rather than rendering empty) when it does not hold. In compare mode (below), the gate is the union across the locked cohort — the widget shows if any compared entity satisfies it.

## Layer scope

`layerScope: true` runs the MQE against the layer rather than the currently selected service. Useful for layer-wide summaries on the service page (e.g., "this service" + "all services in this layer" side by side).

```json
{
  "id": "layer_total_rpm",
  "title": "Layer total RPM",
  "type": "card",
  "expressions": ["sum(service_cpm)"],
  "layerScope": true,
  "unit": "rpm",
  "span": 3
}
```

## Compare entities

Every widget type is compare-aware. From a service / instance / endpoint dashboard you can **pin** entities into a comparison cohort and see them side by side inline, without changing the primary selection that drives the page header. Pin from the entity list or a row's pin control; pinned entities collect into a cohort bar above the grid, each with its own color.

- **Up to 6 pins**, plus the primary entity — seven series at most. The primary keeps the layer accent color; each pin takes one of the six cohort hues, and an entity holds its hue across the cohort bar and every widget until you unpin it.
- **The pick stays put.** Pinning does not refocus the page — the header KPIs, the selector, and the entity list keep pointing at the primary. Pins only add to the comparison. Unpin from the cohort bar's `×`; the primary (current) chip can't be removed.
- **Cohort bar.** It appears from the first pin (`{n} locked · lock 1 more to compare`) and switches to a comparison summary at two or more (e.g. `Comparing {n} services`). Each chip shows its color, label, and per-entity load state, so a pin that failed or is still loading is visible rather than silently blank.
- **Cross-service for instances and endpoints.** Instance and endpoint pins remember which service they belong to, so you can compare instances (or endpoints) drawn from different services in one cohort. When every pin is from one service the bar names it (`Comparing {n} instances of {service}`); a mixed cohort reads `across services` and each chip carries its service prefix. Service-scope pins are plain services.

Comparison stays active while you navigate between the Service / Instance / Endpoint tabs of the same layer; leaving the layer clears it.

### How each widget renders in compare mode

The widget keeps its normal tile and lays all cohort entities inside it:

| Widget | Compare rendering |
|---|---|
| `card` | One row per entity — color dot, entity name, that entity's value. |
| `line` | One hued series per entity overlaid on the same axes; legend names the entity (and, for multi-series metrics, the series label too). Synced crosshairs still apply. |
| `top` | A per-entity tab plus a merged view, each tab sorting that entity's list. |
| `record` | A per-entity tab (the per-row jump-to-trace and click-to-copy are single-entity only; the compared view shows name + value). |
| `table` | A prepended **Entity** column groups the rows by entity, each tagged with its color dot. |

A failing or empty pin is isolated: a bad pin (or a primary that is itself outside the locked cohort) never blanks the other entities' results.

## Choosing the right widget

| MQE outermost call | Widget type |
|---|---|
| `latest(...)`, `max(...)`, `min(...)`, `avg(<plain>)`, `sum(<plain>)` (single scalar) | `card` |
| `latest(<labeled metric>)` returning many label sets (status / phase / condition per entity) | `table` |
| `rate(...)`, `increase(...)`, `relabels(...)`, `aggregate_labels(...)` without scalar collapse, `histogram*(...)` | `line` |
| `top_n(...)` returning labeled list | `top` |
| Record-shaped output (slow SQL, slow gRPC) | `record` |

The widget editor helps catch common type / MQE mismatches, but it does not replace testing against a live OAP window. After changing a widget, preview it with data before publishing.

## Per-scope widget sets

The `dashboards.<scope>` map on a layer template lets you define different widget grids for service / instance / endpoint / topology / trace / logs / profiling pages. If a specific scope is unset, it falls back to the `service` scope.

See [Customization → Layer Dashboard Templates](../customization/layer-templates.md) for the per-scope structure.
