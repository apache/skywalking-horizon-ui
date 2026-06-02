# Overview Templates

An **overview template** is a JSON file describing a war-room / cross-cutting dashboard composed from MQE-driven widgets on a 12-column grid. Overviews are independent of any single layer and are designed for the operator's "is everything OK?" pane.

Horizon ships bundled overview templates, and an administrator customizes them in the **Overview Templates** admin page (`/admin/overview-templates`, under *Dashboard setup*) — a visual editor that saves a local draft and publishes to OAP with **Check diff & push**. You don't hand-edit JSON on the page; the shape documented below is the stored format the editor reads and writes. Bundled examples:

- **Service Health** — cross-layer service health + Kubernetes capacity summary.
- **Mesh** — Istio data-plane services + pilot activity + Kubernetes.

## Template shape (reference)

```json
{
  "id": "services",
  "title": "Service Health",
  "description": "Cross-layer service traffic, latency, errors, and capacity.",
  "visibility": "public",
  "icon": "services",
  "order": 1,
  "layers": ["GENERAL", "MESH", "K8S_SERVICE"],
  "widgets": [
    { "type": "section-break", "title": "Service traffic", "cols": 12 },
    { ... metric widget ... },
    { ... kpi-tile ... },
    { "type": "section-break", "title": "Cluster capacity", "cols": 6 },
    { ... metric-composite ... }
  ]
}
```

## Top-level fields

| Field | Type | Default | Notes |
|---|---|---|---|
| `id` | string | **required** | Stable id, used in the route `/overview/:id`. |
| `title` | string | **required** | Display title in the sidebar and page header. |
| `description` | string | — | One-line description shown under the title. |
| `visibility` | `public` \| `operate` | `public` | Sidebar placement. `operate` puts the overview under the Operate group (admin-only by convention). |
| `icon` | string | — | Sidebar icon name (from Horizon's icon set). |
| `order` | number | — | Sort order within the visibility bucket (lower = earlier). |
| `layers` | string[] | — | Layer enums this overview aggregates. Optional — Horizon also unions in every widget's `layer` field, so a dashboard created via "+ New" (no `layers[]`) gates correctly off its widgets alone. See *Sidebar visibility* below. |
| `widgets` | array | **required** | Ordered widget list. The renderer iterates and lays out per the grid model. |

## Widget types

Six supported `type` values:

| Type | Renders |
|---|---|
| `metric` | Single MQE scalar with optional unit. |
| `topology` | Service-map snapshot for the configured layer. |
| `section-break` | Visual row header; carries `cols` to override the grid column count for following widgets. |
| `kpi-tile` | Compound tile: optional service count + N KPI rows. |
| `alarms` | Active-alarm rail (60 min window). |
| `metric-composite` | Mixed KPI grid — number tiles + progress-bar rows. |

See [Components → Overview Widgets](../components/overview-widgets.md) for the per-widget detail.

## Grid model

The overview renders on a CSS grid:

- Per-section column count, default 12, set by the most recent `section-break.cols`.
- Fixed row height 72 px.
- Per-widget `span` (column width, 1–12) and `rowSpan` (row height, 1–8).
- Gap 12 px between widgets.
- Single-column responsive collapse below 1100 px viewport.

The 72 px row height is tuned for KPI tile content; widgets that need more vertical space (a small chart, a multi-row composite) use `rowSpan: 2` or `rowSpan: 3`.

## Widget shape (common fields)

| Field | Notes |
|---|---|
| `id` | Unique within the dashboard. |
| `title` | Card title (not used by `section-break` — uses `title` as the section header). |
| `tip` | Optional one-line hover hint next to the title. |
| `layer` | Layer key (UPPER_SNAKE). Used to scope MQE evaluation. Optional for `section-break` and `alarms` (alarms can scope server-side if the layer is set). |
| `type` | One of `metric`, `topology`, `section-break`, `kpi-tile`, `alarms`, or `metric-composite`. |
| `span` | Column span. Defaults vary per widget type. |
| `rowSpan` | Row span. Defaults vary per widget type. |
| `mqe`, `unit`, `aggregation` | Metric-specific fields. |
| `cols` | Section-break column count for following widgets. |
| `kpis`, `showCount`, `limit` | Type-specific fields described below. |

## `OverviewKpi`

Used by `kpi-tile` and `metric-composite`:

| Field | Notes |
|---|---|
| `label` | Row label. |
| `mqe` | Required when `source === 'mqe'` (the default). |
| `unit` | Unit suffix. |
| `aggregation` | `sum` for throughput / count; `avg` for ratios and rates. |
| `style` | `number` (default) or `progress-bar`. |
| `max` | Required when `style === 'progress-bar'` — the 100% value. |
| `source` | `mqe` (default) or `service-count` — the latter reads the layer's service count from the menu response instead of evaluating MQE. |

## Worked examples

### `metric` widget

```json
{
  "id": "total_rpm",
  "title": "Total RPM",
  "type": "metric",
  "layer": "GENERAL",
  "mqe": "sum(service_cpm)",
  "unit": "rpm",
  "aggregation": "sum",
  "span": 3,
  "rowSpan": 1
}
```

Single scalar tile. The MQE collapses to one number (here, `sum` over the time window).

### `kpi-tile` with service count + two KPIs

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
    {
      "label": "Apdex",
      "mqe": "avg(service_apdex/10000)",
      "aggregation": "avg",
      "style": "progress-bar",
      "max": 1
    },
    {
      "label": "P95",
      "mqe": "avg(service_percentile{p='95'})",
      "unit": "ms",
      "aggregation": "avg"
    }
  ]
}
```

`showCount: true` adds a service-count header row above the KPIs.

### `metric-composite` — mixed number + bar grid

```json
{
  "id": "k8s_summary",
  "title": "Cluster capacity & utilisation",
  "type": "metric-composite",
  "layer": "K8S",
  "span": 12,
  "rowSpan": 3,
  "kpis": [
    { "label": "Nodes", "mqe": "latest(k8s_cluster_node_total)", "aggregation": "avg" },
    { "label": "Pods",  "mqe": "latest(k8s_cluster_pod_total)",  "aggregation": "avg" },
    { "label": "CPU",
      "mqe": "k8s_cluster_cpu_cores_requests / k8s_cluster_cpu_cores * 100",
      "unit": "%", "aggregation": "avg",
      "style": "progress-bar", "max": 100 },
    { "label": "Memory",
      "mqe": "k8s_cluster_memory_requests / k8s_cluster_memory * 100",
      "unit": "%", "aggregation": "avg",
      "style": "progress-bar", "max": 100 }
  ]
}
```

The widget auto-splits KPIs:

- `number`-style KPIs (Nodes, Pods) go into the count-tile row (auto-fit, min 100 px).
- `progress-bar`-style or `unit === '%'` KPIs go into the bar grid (auto-fit, min 180 px).

This single widget replaces what used to be three separate hand-crafted widgets (`k8s-service-count`, `pilot`, `service-count`) — anything compound now goes through `metric-composite`.

### `section-break` to start a new row

```json
{ "type": "section-break", "title": "Cluster capacity", "cols": 6 }
```

Following widgets render in a **6-column** grid (rather than 12) until the next `section-break`. Used for paired side-by-side panes.

### `alarms` rail

```json
{
  "id": "active_alarms",
  "title": "Active alarms (60 min)",
  "type": "alarms",
  "layer": "GENERAL",
  "limit": 10,
  "span": 4,
  "rowSpan": 4
}
```

Read-only — Horizon does not support acknowledge / close / silence operations. Alarm recovery is backend-automatic.

## Sidebar visibility

An overview entry appears in the sidebar only when **at least one of its declared layers is currently reporting services**. Declared layers come from two sources, unioned:

- the explicit `layers[]` field on the dashboard, and
- every `widget.layer` referenced by its widgets.

A dashboard with no layer reference on either side (no `layers[]` and no widgets with `layer` set — e.g. a future cross-layer "All" overview) is always shown.

This makes the sidebar honest: it stops listing a Services dashboard when nothing is reporting and lights it back up automatically when an agent / receiver does start, on the same 60-second cadence the menu refreshes. It also means a dashboard you create via "+ New" — which has no `layers[]` — gates correctly off its widgets without you having to maintain a separate list.

## Admin Editor

Overview templates are editable at runtime via **Dashboard setup → Overview templates** (`/admin/overview-templates`, verb `overview:write`). Pick a dashboard from the filterable dropdown (title + id + sync status), then lay it out on a **12-column canvas**: drag a widget to reorder, corner-drag to resize, click a widget to edit it in the right-hand drawer. Section breaks ("text widget" / line break) and the dashboard title are selectable too. The canvas shows **sample data** so you can judge layout; only the live page (Preview ▾) uses real OAP data.

**Per-widget fields** (the drawer shows only what the `widget.type` needs):

| Type | Fields shown |
|---|---|
| `section-break` | `title`, `cols` |
| `metric` | `layer`, `title`, `tip`, `mqe`, `unit`, `aggregation`, `span`, `rowSpan` |
| `topology` | `layer`, `title`, `tip`, `span`, `rowSpan` |
| `alarms` | `layer`, `title`, `tip`, `limit`, `span`, `rowSpan` |
| `kpi-tile` | `layer`, `title`, `tip`, `showCount`, KPI rows (add / remove), `span`, `rowSpan` |
| `metric-composite` | `layer`, `title`, `tip`, KPI rows (each a stacked card: label / source / MQE / unit / aggr / style / max), `span`, `rowSpan` |

### How edits flow: draft → preview → publish

Same model as [layer templates](/customization/layer-templates): your edit lives **in your browser**, and the live page everyone sees stays on the published OAP version until you publish.

1. **Save (local).** Stores your draft in this browser only; the dashboard is tagged **local** in the picker.
2. **Reset to ▾** loads the **Bundled** or **Remote** version into the canvas.
3. **Preview ▾** opens the real overview page in a new tab rendering **Local** / **Bundled** / **Remote**.
4. **Check diff & push** shows a *remote → local* diff and publishes to OAP (create-or-update). Enabled only when your draft differs from remote.

A **+ New dashboard** form (inside the picker) creates a dashboard the same way: it writes a **local draft** (id is the template name, must be unique) — edit and preview it, then **Check diff & push** publishes it to OAP. A pushed dashboard with no bundled default is **remote-only**; the picker, the live page, and the sidebar all show it.

A top banner summarizes state — *Synced from OAP — N diverged, Y local* — with **Diverged** / **Local** filters. Status chips per row: **synced**, **diverged** (OAP wins at render), **remote-only**, **disabled** (deleted), **bundled**.

### Deleting a dashboard

OAP has no hard delete, so the **Delete** button next to the title soft-disables the dashboard on OAP (a disabled dashboard drops from the picker's live state, the sidebar, and the live page). A dashboard that exists only as an unpublished local draft is removed from your browser instead. Either action is confirmed in a dialog first; deletion is irreversible from the UI, but a new dashboard can always be created with the same id.

## Hot reload

Admin editor changes apply on the next overview refresh. Bundled file changes made outside Horizon require a BFF restart.

## Common patterns

### A war-room single-screen view

One overview, `id: war-room`, with `layers: [ALL_YOUR_LAYERS]`, and:

1. `section-break` "Health" + 4 × `kpi-tile` (one per critical layer with service-count + RPS / error-rate KPIs).
2. `section-break` "Alarms" + 1 × `alarms` widget (span 12) showing every firing alarm.
3. `section-break` "Capacity" + 1 × `metric-composite` (span 12) with cluster capacity.

Layout fits a 1440 px display above the fold; works on a wall projector at 1920 px.

### A team-specific overview

`visibility: operate`, only granted to the team's role via `landingByRole`:

```yaml
landingByRole:
  payments-on-call: /overview/payments
```

The team lands directly on their own overview after login.

### Replacing the old k8s / pilot / service-count widgets

Use `metric-composite` with one widget per cluster summary. The old per-feature widget types are no longer rendered — `metric-composite` is the unified shape.
