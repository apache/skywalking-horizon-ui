# Overview Widgets

Eight widget types render on overview pages. Each `widget.type` you set in a template selects one of them, and reads its own set of fields.

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

## `calendar-heatmap`

**Renders:** A calendar grid over a **fixed** window of the last `windowDays` days ending now, with a footer carrying the window total. The layout adapts to the window: up to 14 days is drawn **by the hour**, one row per day and one column per hour of the OAP's clock, so ten days read as 240 hour cells over the calendar days they touch, usually eleven rows since the window ends at the current hour; a longer window is drawn **by the day**, one row per week and one column per weekday, Monday first, so thirty days read as five week rows with the first and the last partly filled. The one overview widget that does not follow the time picker: the window is part of the template, so the grid reads the same whatever range the rest of the page is on. Built for usage-shaped metrics whose total per hour or day is the interesting number — tokens an AI agent consumed, requests a gateway served.

### Fields

| Field | Type | Notes |
|---|---|---|
| `id`, `title`, `tip`, `layer`, `span`, `rowSpan` | — | Common. `layer` is required. |
| `mqe` | string | Required. A plain **per-service** metric such as `meter_ai_agent_tokens` — not a `top_n(...)` expression. Horizon evaluates it per service at one bucket per hour or day and aggregates the layer's eight busiest services into each cell. |
| `aggregation` | `sum` \| `avg` | How the per-service bucket values combine into one cell. `sum` (default) for totals; `avg` for ratios, which also turns the footer into an hourly or daily average. |
| `unit` | string | Unit suffix on the footer total and the cell tooltips (`tokens`, `rpm`). |
| `windowDays` | 7–93 | How many days the grid covers, ending now. Default 30. The ceiling is the longest range OAP serves at daily precision. |
| `resolution` | `auto` \| `hour` \| `day` | Default `auto`: a window of up to 14 days is drawn by the hour, a longer one by the day. `hour` and `day` force one, except that `hour` past 14 days still draws days, the longest range OAP serves at hourly precision. |
| `compareTo` | boolean | Default `false`. Adds the footer line comparing a summed total to a well-known book (below); `false` hides it. Ignored for `avg`. |

### Behavior

- **Buckets are OAP-local.** A cell is one calendar day, or one hour, on the OAP server's clock, so the grid agrees with the buckets a layer dashboard shows on the same range. The last cell is the day or hour in progress and is outlined to say so; it fills in as time goes on. By the hour, a rolling window starts and ends mid-day, so the first and last rows are partial and the hours outside the window are blank.
- **Shades follow the window's distribution, not its range.** The five intensities are cut at the quantiles of the days that saw traffic, so one exceptionally heavy day does not flatten every other day into the faintest shade. A day with no data is drawn empty; the tooltip on each cell carries the date and the value.
- **The total is the sum of the cells** (or their average under `aggregation: avg`), formatted with the unit. When `compareTo` is on, the comparison line reads *about 95.1 times the text of War and Peace* for a 74.2M-token total — the total against the largest of four public-domain works whose approximate token count is below it (Animal Farm ~40k, The Great Gatsby ~63k, Moby-Dick ~275k, War and Peace ~780k, each the published word count × 1.3), so the multiplier is always at least 1; a total under 40k reads as a percentage of Animal Farm instead. The counts are estimates, and the titles stay in English in every language.
- **Refreshes with the page, keeps its cells while it reads.** The grid re-reads on the same refresh round as the rest of the overview, stays on screen while the new read is out, and says so in its header. A read that fails leaves the previous grid up with a note rather than drawing zeroes; a window with no data says so.
- **A cell can be picked.** Hovering a cell shows its date and value; clicking one (or Enter on a focused one) keeps it picked and reads its date and value out in the footer, until it is clicked again.
- **Fits its card.** The cells stretch to the width and the height the card gives them, up to two and a half times wider than tall or taller than wide, so a wide card fills its row; a card too narrow for the grid's long axis turns the grid the other way, days across and hours down, or weeks across and weekdays down, whichever gives the larger cells. A day cell wide enough shows its day number, and a wider one its value.
- **Eight services per read.** Every read covers the layer's eight services that rank highest on the metric over the window, and every cell aggregates those eight. On a layer with more services than that — many agent runtimes reporting to one OAP — the total is the busiest eight, not the whole layer, and the footer says how many of the layer's services it counts.

### Example

```json
{
  "id": "daily_tokens",
  "title": "Daily tokens",
  "tip": "Tokens per day over the last 30 days, the busiest agents summed.",
  "type": "calendar-heatmap",
  "layer": "AI_AGENT",
  "mqe": "meter_ai_agent_tokens",
  "aggregation": "sum",
  "unit": "tokens",
  "windowDays": 30,
  "span": 12,
  "rowSpan": 3
}
```

## `ranking`

**Renders:** The layer's services ranked by one per-service metric over the picked time range, busiest first: a row per service with its value and a bar against the top value. Past five rows the list runs in two or more columns, read down then across, as many as its height needs. The card links to the layer's Service page.

### Fields

| Field | Type | Notes |
|---|---|---|
| `id`, `title`, `tip`, `layer`, `span`, `rowSpan` | — | Common. |
| `mqe` | string | Required. A plain **per-service** metric such as `meter_ai_agent_tokens`, not a `top_n(...)` expression: Horizon evaluates it per service and ranks the services on it. |
| `unit` | string | Suffix on each value. |
| `limit` | number | How many services to list. Default 10, at most 20. |
| `rangeTotal` | boolean | Sum a service's buckets over the picked range, so a counter such as tokens reads as the range total. Default off: the value per bucket, which suits rates and ratios. |

### Behavior

- **Follows the time picker.** The values describe the picked range, at the step the range decides.
- **Twenty services per read.** A read covers at most the layer's twenty services that rank highest on the metric; when the layer has more, the card's header says how many of them it lists.
- **As many columns as the height needs.** The list measures its card: past five rows it runs in at least two columns, read down then across, and in more when the rows do not fit the height, up to four.
- **A partial read is said, not hidden.** When part of the fan-out failed, the page's partial-read notice covers this card like every other page-side widget.

### Example

```json
{
  "id": "top_agents",
  "title": "Top 20 agents",
  "type": "ranking",
  "layer": "AI_AGENT",
  "mqe": "meter_ai_agent_tokens",
  "unit": "tokens",
  "limit": 20,
  "rangeTotal": true,
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

The Overview Templates admin editor (`/admin/overview-templates`, verb `overview-template:read`) exposes per-type forms — only fields relevant to the chosen `type` are shown. See [Customization → Overview Templates](../customization/overview-templates.md#admin-editor).

## Choosing the right widget

| Need | Widget |
|---|---|
| One scalar headline. | `metric` |
| Service count + 1–3 KPI rows for one layer. | `kpi-tile` |
| Mixed counts + bars (e.g. Kubernetes capacity summary). | `metric-composite` |
| Active-incident rail. | `alarms` |
| Service map snapshot. | `topology` |
| Row separator with custom column count. | `section-break` |
| One cell per day over a fixed window, with the window total. | `calendar-heatmap` |

If you find yourself wanting a chart on an overview, that probably belongs on a layer dashboard instead (see [Dashboard Widgets](dashboard-widgets.md)). Overviews are KPI-shaped; dashboards are time-series-shaped.
