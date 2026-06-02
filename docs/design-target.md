# Design Target

Horizon UI is an **observability-class UI**. Every design decision is downstream of that.

## What it is for

A site-reliability operator opens Horizon to answer one of:

1. **Is the production system healthy right now?** (overview / war-room view)
2. **A specific service is misbehaving — what does it look like across metrics, traces, logs, and topology?** (per-layer drill-down)
3. **An alarm fired — what fired it, what was happening at the time, where did it propagate?** (alarms + trace context)
4. **The backend itself (OAP cluster) is the suspect — is it healthy, are the right modules on, are storage and receivers keeping up?** (operate / cluster page)

Every screen in Horizon is built to answer one of these questions in seconds, not minutes.

## Principles

### Obs-focused, highly pre-developed widgets

Horizon ships dedicated widget primitives for observability stacks instead of generic chart-builder tooling:

- **MetricWidget** — single MQE scalar (latency, throughput, error rate).
- **KpiTileWidget** — compound tile combining a service count with N KPI rows (number or progress-bar style).
- **MetricCompositeWidget** — mixed-style KPI grid (e.g., Kubernetes cluster summary: node count + CPU/memory progress bars).
- **AlarmsWidget** — read-only active-incident rail with a 60-minute window, dual-mode (modern `queryAlarms` capability + legacy `getAlarm` fallback).
- **Topology** — embedded service-map snapshot for the configured layer, showing live services and call flows on an overview.
- **TimeChart** — multi-series line chart with dual y-axis, synced crosshairs across all widgets on the same page.
- **TopList** — top-N sorted list with optional tab switcher for multiple expressions.
- **AlarmsTimeline** — per-minute stacked bar with brush selection for triage.
- **SectionBreak** — pure layout, lets a template carve an overview into "Latency", "Throughput", "Errors" rows.

See [Components → Overview Widgets](components/overview-widgets.md) and [Dashboard Widgets](components/dashboard-widgets.md) for field-level reference.

### War-room overview support

The overview perspective is a first-class concept. An overview template is an ordered list of widgets laid out on a 12-column grid with per-section column overrides. Bundled examples include `services.json` (cross-layer service health + Kubernetes capacity) and `mesh.json` (Istio data-plane services + pilot activity).

Overviews are scoped per-layer (each widget declares its `layer` key, allowing MQE evaluation against the right entity scope), or layer-agnostic for cross-cutting summaries.

### Integrated trace, log, metric, profiling

The per-layer drill-down presents a single service through every data type SkyWalking captures:

| Tab | Scope | Data source |
|---|---|---|
| Service / Instance / Endpoint | per-entity dashboards | MQE expressions, per-scope widget sets |
| Topology | service-map snapshot | `getServicesTopology` GraphQL |
| Traces | distributed traces | native query + Zipkin (configurable per layer) |
| Logs | log records | per-layer scope (service / instance / endpoint) |
| Profiling | trace / eBPF / async profiler | scope-aware widget set |

The renderer is template-driven (see [Customization → Layer Dashboard Templates](customization/layer-templates.md)). New layers require a JSON template, not a custom UI build.

### Customization is the whole key

Every visual decision a site operator wants to make is template-driven:

- **Sidebar layer order** — per-user layer priority, persisted in the setup state file.
- **Layer alias / color / group / visibility** — layer template fields (`alias`, `color`, `group`, `visibility`).
- **Which tabs appear on a layer** — `components` flags on the layer template.
- **What appears under each tab** — `dashboards.<scope>` widget arrays.
- **Overview content** — overview template JSON; type-aware admin editor edits each widget's only-relevant fields.
- **Authentication / authorization** — `horizon.yaml` + `/admin/auth-status` page.

There is no custom UI plugin extension point. Adding a new rendering primitive requires a Horizon release; adding **content** is configuration.

### Density beats whitespace

Horizon is dark-first, dense, and Grafana-style. The 12-column grid uses 14px row units. A typical layer dashboard fits 6–12 widgets above the fold on a 1440px viewport. This is deliberate: an operator scanning a dashboard during an incident benefits from seeing more at once.

### Synced crosshairs

Multiple time-series on the same page share one hover cursor. Pointing at minute 32 on the throughput chart highlights minute 32 on the latency chart, the error-rate chart, and any sparkline tile. The shared-crosshair contract is enforced at the chart wrapper level — no widget can opt out.

### Cascade-clear, then load

When an upstream control changes (service / instance / endpoint pick, time-range change, layer / scope nav) and the downstream queries have to refire, the dependent area visibly resets first and shows an explicit "Reading data…" hint while the new query is in flight. This is non-negotiable: leaving the prior value under a spinner reads as the new state and trains operators to trust broken data.

### MQE is a core capability, not a config-screen afterthought

Every widget definition includes a user-editable MQE expression. The DSL Management page provides syntax highlighting, autocomplete, and a debugger (Live Debugger) — MQE is meant to be edited, not just consumed.

### Admin views use the same look

LDAP / RBAC / setup pages are dark, dense, design-token-driven — not a separate "settings" UI. Alarms are read-only on the UI side: recovery is backend-automatic (no acknowledge / close / silence actions). This matches OAP's design — Horizon does not invent state OAP does not own.

## Non-goals

- **Not a dashboard builder.** Widgets are pre-developed primitives; the customization surface is template JSON + the admin editor. There is no "drop an iframe of an external chart" affordance.
- **Not a notebook / exploration tool.** Horizon assumes the operator knows what they're looking for. The Inspect page exists for catalog browsing, but it is scoped to OAP's metric catalog, not arbitrary data exploration.
- **Not a multi-tenant SaaS UI.** Horizon assumes one OAP cluster behind it (one query URL, one admin URL). Federation is OAP's concern.

## Relationship to booster-ui

Horizon is a **greenfield rewrite**, not a fork. Backend contracts do not change: the same GraphQL query protocol, the same admin REST surface, the same MQE language, the same layer concept. A site running booster-ui can swap to Horizon against the same OAP without backend changes — provided the OAP version meets the [minimum requirement](compatibility/oap-version.md).

What changes is the UI side: tighter visual vocabulary, template-driven render, an integrated admin surface that owns auth/RBAC/audit (booster-ui defers these to deployment-level controls).
