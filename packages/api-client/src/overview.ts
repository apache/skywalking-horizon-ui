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
 * Wire types for the per-dashboard Overview pages.
 *
 * Overview config is stored OUTSIDE the layer JSONs: operators
 * define one or more "overview dashboards" (e.g. *General service*,
 * *Mesh service*) in standalone files under
 * `apps/bff/src/bundled_templates/overviews/*.json`. Each dashboard is a list
 * of widgets, and each widget targets a specific layer. This keeps
 * the layer JSONs focused on per-layer concerns and lets one
 * dashboard pull metrics from multiple layers (e.g. an overview
 * combining General service metrics with Kubernetes service counts).
 *
 * Widget types (`OverviewWidgetType`):
 *   - `metric`          — an MQE expression evaluated layer-wide.
 *   - `topology`        — static service-map snapshot for the layer with
 *                         click-through to the full topology view.
 *   - `section-break`   — visual row header; pure layout, no data.
 *   - `kpi-tile`        — compound tile: optional service count + 1–N
 *                         KPI rows for one layer. Used for the
 *                         per-service-type rows on the Services / Mesh
 *                         dashboards.
 *   - `alarms`          — active-alarm rail. Carries no MQE — the
 *                         renderer queries `getAlarms` directly. Layer
 *                         filter is best-effort (server-side scope tags
 *                         today, no native layer filter).
 *   - `metric-composite`— mixed KPI grid (number tiles + progress-bar
 *                         rows) — the Kubernetes capacity + Istio pilot
 *                         blocks. `service-count` is a KPI *source*
 *                         within a tile, not a widget type.
 *
 * The layout uses the same 12-col / `span` + `rowSpan` model as the
 * per-layer dashboard, so the same renderer can place these widgets
 * on a grid.
 */

export type OverviewWidgetType =
  | 'metric'
  | 'topology'
  | 'section-break'
  | 'kpi-tile'
  | 'alarms'
  | 'metric-composite';

/** Visual style for a KPI row.
 *   - `number`        — value rendered as a right-aligned number with
 *                       an optional unit suffix. The default.
 *   - `progress-bar`  — value rendered as a fill against `max`. Use
 *                       for SLA, utilisation, or other 0..N metrics
 *                       where the operator wants "how close to the
 *                       ceiling" at a glance instead of the raw digit. */
export type OverviewKpiStyle = 'number' | 'progress-bar';

/** Value source for a KPI row.
 *   - `mqe`            — execute the row's `mqe` expression against
 *                        the widget's layer. The default.
 *   - `service-count`  — count the layer's services via `listServices`
 *                        and use the count as the row's value. Lets a
 *                        `metric-composite` widget mix "5 services"
 *                        with MQE-derived numbers like RPM / latency. */
export type OverviewKpiSource = 'mqe' | 'service-count';

/** One KPI row inside a `kpi-tile` / `metric-composite` widget. */
export interface OverviewKpi {
  label: string;
  /** Required when `source === 'mqe'` (the default); ignored when
   *  `source === 'service-count'`. */
  mqe?: string;
  unit?: string;
  aggregation?: 'sum' | 'avg';
  /** Defaults to `'number'`. */
  style?: OverviewKpiStyle;
  /** Required when `style === 'progress-bar'` — the value plotted at
   *  100% fill. Ignored otherwise. */
  max?: number;
  /** Defaults to `'mqe'`. */
  source?: OverviewKpiSource;
}

export interface OverviewWidget {
  /** Stable id, unique within the dashboard. */
  id: string;
  /** Card title shown above the widget. */
  title: string;
  /** Optional one-line hint shown next to the title. */
  tip?: string;
  /** Which layer this widget pulls from. Upper-snake to match
   *  OAP's layer enum (`GENERAL`, `MESH`, `K8S_SERVICE`, …). Optional
   *  for `section-break` (purely visual) and `alarms` (queries are
   *  layer-agnostic in v1). */
  layer?: string;
  /** Widget kind. See module docs. */
  type: OverviewWidgetType;
  /** For `metric` widgets — MQE expression evaluated layer-wide. */
  mqe?: string;
  /** Display unit. */
  unit?: string;
  /** `sum` for throughput-shaped metrics, `avg` otherwise. Consulted only
   *  when `aggregateOnPage` is set (page-side fan-out); a self-aggregating
   *  tile carries its aggregation inside the MQE. */
  aggregation?: 'sum' | 'avg';
  /** For data widgets (`kpi-tile` / `metric-composite` / `metric`) — how the
   *  layer-wide KPI is aggregated:
   *   - omitted / false (the tile default): each KPI's `mqe` is
   *     self-aggregating (`sum|avg(top_n(<metric>,{{topn}},DES[,attr0=…]))`)
   *     and the BFF fires it ONCE — OAP does the rollup server-side.
   *   - true: the KPIs are plain per-service metrics; the BFF fans out
   *     across the layer's services and aggregates the top-`limit` of them
   *     page-side. Use for metrics that can't be `top_n`-wrapped (single-
   *     entity cluster/meter series, `latest(...)`, ratios) — e.g. the K8s
   *     cluster + Istio pilot composites. */
  aggregateOnPage?: boolean;
  /** For `section-break` — overrides the grid column count for widgets
   *  that follow this break, up to the next break. Default 12. Use 5
   *  for "five tiles across", etc. */
  cols?: number;
  /** For `kpi-tile` — KPI rows shown under the tile header. */
  kpis?: OverviewKpi[];
  /** For `kpi-tile` — also render the layer's service count above the
   *  KPIs. Defaults to false. */
  showCount?: boolean;
  /** For `alarms` — cap the alarm list at this many rows.
   *  For `aggregateOnPage` widgets — the page-side aggregation window: the
   *  tile sums/averages the layer's top-`limit` services (default 1, which
   *  suits single-entity composites like a K8s cluster; set higher for
   *  multi-instance control planes, e.g. 5 for a multi-replica istiod). */
  limit?: number;
  /** For `aggregateOnPage` widgets — how the top-`limit` services are RANKED
   *  before the aggregate. Default (absent): by the FIRST KPI. Set it when
   *  the first KPI is a `LABELED_VALUE` metric (a poor ranking basis) or to
   *  rank by something not shown as a KPI. `mqe` wins over `kpi`. */
  rankBy?: {
    /** Rank by an existing KPI, 0-based index into `kpis` (must be an `mqe`
     *  KPI, not `service-count`). */
    kpi?: number;
    /** Rank by a standalone MQE, not shown as a KPI. */
    mqe?: string;
  };
  /** Grid span in 12-col grid. */
  span?: number;
  /** Grid row span. */
  rowSpan?: number;
}

/** Where the overview appears in the sidebar. `public` overviews surface
 *  at the top of the menu for everyone; `operate` overviews are gated to
 *  the operations / admin section. */
export type OverviewVisibility = 'public' | 'operate';

export interface OverviewDashboard {
  /** Stable id, used in routes (`/overview/:id`). */
  id: string;
  /** Display title. */
  title: string;
  /** Optional description shown in the dashboard header. */
  description?: string;
  /** Sidebar placement — `public` (default) or `operate` (admin only). */
  visibility?: OverviewVisibility;
  /** Sidebar icon name. Falls back to the renderer's default. */
  icon?: string;
  /** Sort order within the visibility bucket. Lower = earlier. */
  order?: number;
  /** Layers this overview aggregates. Used for auto-activation: when
   *  none of the listed layers have services reporting, the overview
   *  is hidden from the menu. Widgets' own `layer` fields still drive
   *  data fetches independently. */
  layers?: string[];
  /** Ordered list of widgets. */
  widgets: OverviewWidget[];
}

/** Bundle returned by `GET /api/overview/dashboards`. */
export interface OverviewDashboardListResponse {
  generatedAt: number;
  dashboards: Array<{
    id: string;
    title: string;
    description?: string;
    visibility?: OverviewVisibility;
    icon?: string;
    order?: number;
    layers?: string[];
    widgetCount: number;
  }>;
}

/** Single dashboard returned by `GET /api/overview/dashboards/:id`. */
export interface OverviewDashboardResponse {
  generatedAt: number;
  dashboard: OverviewDashboard;
  reachable: boolean;
  error?: string;
}

