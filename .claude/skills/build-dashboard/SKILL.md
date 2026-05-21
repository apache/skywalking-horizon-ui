---
name: build-dashboard
description: Build a NEW Horizon UI dashboard from scratch — either a cross-layer Overview dashboard (apps/bff/src/bundled_templates/overviews/*.json) or a per-layer dashboard widget set (apps/bff/src/bundled_templates/layers/*.json). Greenfield authoring, NOT migration: design the widgets, write the MQE, validate every expression against a live OAP, then render-check in the browser.
user-invocable: true
---

# Build a new Horizon dashboard

Two dashboard families live in the BFF as static JSON, loaded at boot and served to the SPA's generic renderers. You author JSON; you do not write Vue.

| Family | JSON dir | TS shape | Served by | Rendered by |
|---|---|---|---|---|
| **Overview** (cross-layer landing) | `apps/bff/src/bundled_templates/overviews/*.json` | `OverviewDashboard` — `packages/api-client/src/overview.ts` | `GET /api/overview/dashboards[/:id]` (`apps/bff/src/http/config/overview.ts`) | `apps/ui/src/render/overview/` + `apps/ui/src/render/widgets/` |
| **Layer dashboard** (per-layer drill-down) | `apps/bff/src/bundled_templates/layers/*.json` | `LayerTemplate` — `apps/bff/src/logic/layers/loader.ts`; widgets are `DashboardWidget` — `packages/api-client/src/dashboard.ts` | `GET /api/admin/layer-templates`, data via `POST /api/layer/:key/dashboard` | `apps/ui/src/render/layer-dashboard/` |

**Always read the TS interface for the family you're touching before writing JSON** — fields change, and the interface (plus its comments) is the contract. The existing `general.json` (layer) and `services.json` (overview) are the canonical references; copy their shape and swap the metrics, don't invent a new structure.

---

## The non-negotiable rule: validate MQE against a live OAP

A dashboard is only "done" when every expression has been run against a real OAP and returns the shape the widget expects. Type-checks prove nothing about whether a metric exists or is at the right scope. Boot a local env first:

> Use the **`local-boot`** skill to start the BFF+UI against a local OAP (or the demo). UI on `:9091`, BFF on `:8081`, login `admin`/`admin`.

If no OAP is available, **stop and ask for one**. Do not guess metric names, do not fabricate wire shapes.

### How to validate one expression

1. **Confirm the metric exists and its catalog scope + value type** — `listMetrics`:
   ```bash
   curl -s -H 'Content-Type: application/json' -X POST http://localhost:12800/graphql \
     -d '{"query":"query{listMetrics(regex:\"^service_cpm$\"){name catalog type}}"}'
   ```
   `catalog` is the entity scope (`SERVICE` / `SERVICE_INSTANCE` / `ENDPOINT` / `SERVICE_RELATION` / …). `type` is `REGULAR_VALUE` vs `LABELED_VALUE` — it decides whether `aggregate_labels(...)` is legal.
2. **Run the MQE** at the scope the widget will render. The simplest path is to exercise the actual BFF route the widget uses (overview tile / layer dashboard) once the env is up, and inspect the JSON. Confirm a `card`/scalar MQE returns one number and a `line`/series MQE returns a time series.

---

## Entity scope is load-bearing (read this before picking metrics)

Every OAP metric lives under exactly ONE entity scope and OAP does **not** auto-rollup between scopes — querying at the wrong scope returns empty, no error. (CLAUDE.md: "Metric entity-scope is load-bearing".)

- A `SERVICE_INSTANCE`-scope metric (e.g. `instance_jvm_cpu`) **cannot** be a bare `line`/`card` in a SERVICE-scope dashboard. Options: aggregate to a scalar with `avg(...)`/`sum(...)` for a card/overview tile, OR show per-instance trend as a `top` widget with `top_n(...)`, OR put the bare metric under `dashboards.instance`.
- Same one level deeper for `ENDPOINT`-scope metrics in a service dashboard.
- Never bridge a scope mismatch with a BFF-side rollup — move the metric to the right scope or leave the slot empty.

## Widget type follows MQE shape (card vs line)

Verbatim from CLAUDE.md:
> A widget whose MQE collapses to a single scalar must be `type: "card"`, not `type: "line"`. The tell-tale is the outermost call: `latest(...)`, `max(...)`, `min(...)`, `avg(<plain-metric>)`, `sum(<plain-metric>)` all reduce the window to one number. Series-shaped wrappers (`relabels(...)`, `top_n(...)`, `histogram*(...)`, `aggregate_labels(...)` without an outer scalar collapse, `rate(...)`, `increase(...)`) stay `line`. Look at the outermost function first.

`LABELED_VALUE`-only: `aggregate_labels(metric, sum)` is valid only for labeled metrics; for `REGULAR_VALUE` use plain `sum()` / `avg()`. Mixing throws "result is not a labeled result".

---

## Building an OVERVIEW dashboard

`OverviewDashboard` top-level: `id`, `title`, `description?`, `visibility?` (`'public'`|`'operate'`), `icon?`, `order?`, `layers?` (auto-hide when none of these layers report), `widgets[]`.

Widget `type`s (`OverviewWidgetType`):
- `section-break` — row header, layout only. `cols` sets the grid column count for the widgets that follow it. No data.
- `kpi-tile` — one layer's health: `layer`, optional `showCount` (service count header), `kpis[]`. Each KPI: `{ label, mqe, unit?, aggregation?: 'sum'|'avg', style?: 'number'|'progress-bar', max? (required for progress-bar), source?: 'mqe'|'service-count' }`.
- `metric-composite` — multi-KPI tile mixing numbers + progress bars (same `kpis[]` shape).
- `metric` — a single scalar `mqe` (rarely needed; prefer kpi-tile).
- `alarms` — active-alarm rail; layer-agnostic, `limit?`. Omit `layer`.
- `topology` — embedded static service-map for a `layer`, click-through to the full map.
- Grid: `span` (12-col) + `rowSpan`.

Procedure:
1. Decide the story the page tells (which layers, which 3-ish KPIs each). Overview tiles are a health-at-a-glance strip — prefer RPM / latency / SLA per layer.
2. Author the JSON next to `services.json`. Group with `section-break`s.
3. For each KPI `mqe`: validate scope+type, then confirm it reduces to a scalar (overview KPIs are scalar — the renderer shows one number or a bar). Use `aggregation` to pick sum (throughput) vs avg (everything else).
4. Set `visibility`/`order`/`icon`/`layers`. Boot and eyeball at `http://localhost:9091`.

## Building a LAYER dashboard

A `LayerTemplate` (file basename must match `key` UPPER_SNAKE) carries far more than widgets — read `apps/bff/src/logic/layers/loader.ts` for the full interface. The widget sets live under `dashboards.{service,instance,endpoint,dependency,topology,trace,logs,traceProfiling,ebpfProfiling,asyncProfiling}`, each an array of `DashboardWidget`.

`DashboardWidget`: `id`, `title`, `tip?`, `type` (`'card'|'line'|'top'|'record'`), `expressions[]` (MQE), `expressionLabels?` (legend / `top` tabs), `expressionUnits?`, `expressionAxes?` (0=left,1=right for dual-axis line), `unit?`, `format?` (`'int'|'decimal'|'compact'`), `span?` (default 4, 12-col), `rowSpan?` (default 8), `visibleWhen?` (hide until a metric reports — e.g. for multi-runtime instance widgets), `layerScope?`.

Widget-type cheatsheet:
- `card` — one scalar (see the card-vs-line rule). Drop a redundant outer `avg()` if the renderer already averages, unless removing it changes shape.
- `line` — one labeled series per expression. Multi-series → set `expressionLabels` (required for the legend); dual-axis → `expressionAxes` + `expressionUnits`.
- `top` — sorted list, usually `top_n(metric, N, des)`. Fold several rankings of the same thing into ONE `top` with multiple `expressions`+`expressionLabels`+`expressionUnits` (rendered as in-widget tabs).
- `record` — RECORD-typed MQE (slow statements/SQL). Use `record`, not `top`.

Other blocks you may need (each has its own config interface in loader.ts — read before use): `header.columns` (service-list picker columns + `orderBy`), `overview.groups` (hero tile above the picker), `topology` (node/edge metrics for the service map), `endpointDependency`, `processTopology`, `traces`, `log`, plus `components.*` feature flags that light up tabs.

Procedure:
1. Read `general.json` end-to-end as the reference, and the `LayerTemplate` interface.
2. Decide which scopes the layer has data for (service always; instance/endpoint only if those scopes carry distinct metrics). Set `components.*`.
3. Author widgets per scope. Apply the scope rule and the card-vs-line rule to every expression.
4. Grid: `span` is the 12-col width; bump `rowSpan` for top-lists / percentile charts.
5. Validate every MQE against the live OAP, then render-check each scope in the browser.

---

## Validate (code) then render-check (browser)

```bash
# from repo root
pnpm --filter @skywalking-horizon-ui/bff run type-check    # schema typechecks
pnpm --filter @skywalking-horizon-ui/bff run test:unit      # loaders still parse
pnpm license:check                                          # headers (JSON is exempt, but vue/ts edits aren't)
```

Then with the local env up (via `local-boot`):
- Overview: open `http://localhost:9091`, find the dashboard in the sidebar (placement = `visibility`+`order`), confirm every tile shows a number (not `—`/blank).
- Layer: navigate the layer's Service/Instance/Endpoint tabs; confirm each widget renders data and that cards are scalars, lines are series. A blank widget almost always means a scope mismatch or a metric that doesn't exist on this OAP — re-run `listMetrics`.

## Pitfalls

1. **Scope mismatch returns empty, not an error.** The #1 cause of a blank widget. Verify `catalog` with `listMetrics` and match it to the dashboard's scope.
2. **Card MQE that's actually a series (or vice-versa).** Look at the outermost MQE function; pick the type from it.
3. **`aggregate_labels` on a `REGULAR_VALUE` metric** → "result is not a labeled result". Check `type` first.
4. **File/key mismatch.** A layer file `foo.json` must declare `"key": "FOO"`.
5. **Inventing fields/metrics.** The OAP query-protocol and metric catalog are fixed and owned upstream. If a screen needs data the protocol doesn't expose, flag it — don't fabricate an MQE or a BFF rollup.
6. **No `Co-Authored-By` / AI footers** on commits or PRs (project rule).
