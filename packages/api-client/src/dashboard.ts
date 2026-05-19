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
 * Per-layer dashboard wire types.
 *
 * The Dashboards tab on each layer page renders a grid of widgets. Each
 * widget is one or more MQE expressions plus presentation hints (chart
 * type, unit, position in a 24-column grid — mirrors booster-ui's
 * grid units for visual parity).
 *
 * Defaults per layer are seeded from `apps/bff/src/dashboard/defaults.ts`
 * — those defaults are lifted from the equivalent booster-ui templates
 * so the metric coverage matches what operators expect on day one.
 * Operators edit + persist their own widget set via the Dashboard
 * setup admin pages, which write the override to OAP through the
 * UI-template sync surface.
 */

/**
 * Built-in widget renderers.
 *
 *   card   — single scalar (avg across the window)
 *   line   — one labeled series per expression
 *   top    — sorted list with optional tab-switchable expressions
 *   record — tabular record list, one row per RECORD-typed MQE result.
 *            Used for "slow statements" / slow-SQL widgets and similar
 *            row-level views where each entry has a name + value +
 *            optional refs (trace id, span id) rather than a metric
 *            sample. The runtime is responsible for the table render;
 *            the admin canvas previews with mock rows.
 */
export type DashboardWidgetType = 'card' | 'line' | 'top' | 'record';

/**
 * Per-entity dashboard scope. Each layer carries an independent widget
 * set per scope; the SPA picks the right set based on the active
 * sub-route under `/layer/:key/`.
 *
 *   `service`   = the layer's primary landing (was `/dashboards`)
 *   `instance`  = drill into a single service instance
 *   `endpoint`  = drill into a single endpoint
 *   `trace`     = trace explorer for the selected entity
 *   `profiling` = flame graphs / sampled stacks
 */
/**
 * One scope per component on a layer. Each scope owns its own widget
 * grid (`dashboards.<scope>` array). The set mirrors the layer's
 * component toggles 1:1 — every enabled component is configurable.
 */
export type DashboardScope =
  | 'service'
  | 'instance'
  | 'endpoint'
  | 'dependency'
  | 'topology'
  | 'trace'
  | 'logs'
  | 'traceProfiling'
  | 'ebpfProfiling'
  | 'asyncProfiling';

export interface DashboardWidget {
  /** Stable id within the layer's dashboard. */
  id: string;
  title: string;
  /** Hover tip — typically the booster-ui `widget.tips`. */
  tip?: string;
  type: DashboardWidgetType;
  /** One or more MQE expressions. `card` collapses to a scalar (avg);
   *  `line` renders one labeled series per expression; `top` treats
   *  every expression as a switchable view (see `expressionLabels`). */
  expressions: string[];
  /**
   * Optional human-readable label per entry in `expressions`. For
   * `top` widgets these drive the in-widget switcher tabs (e.g.
   * "Traffic" / "Slow" / "Errors"). When missing the SPA falls back
   * to the expression text. Indices align with `expressions`.
   */
  expressionLabels?: string[];
  /**
   * Optional per-expression unit overrides. Used by `top` widgets
   * where switching tabs changes the metric unit too (e.g. Traffic →
   * rpm, Slow → ms, SR → %). Falls back to the widget-level `unit`
   * when entries are missing. Indices align with `expressions`.
   */
  expressionUnits?: string[];
  /**
   * Optional y-axis index per expression (`0` = left, `1` = right).
   * Lets a single `line` widget plot two metrics on separate scales —
   * e.g. MQ consume count + latency. Defaults to 0 for every series
   * when omitted. Indices align with `expressions`.
   */
  expressionAxes?: number[];
  /** Suffix unit (`%`, `ms`, `calls / min`). */
  unit?: string;
  /**
   * Numeric formatting override. Defaults to the SPA's smart
   * compact-readable rule (1 decimal under 100, integer ≥ 100, SI
   * suffix ≥ 10k). Set explicitly when the metric is intrinsically
   * integral (pod count, replica count, error count) so the value
   * reads as `8` not `8.0`.
   *
   *   - `'int'`     → round to nearest integer (no decimals)
   *   - `'decimal'` → always 1 decimal place
   *   - `'compact'` → the default smart rule (explicit opt-in is fine)
   */
  format?: 'int' | 'decimal' | 'compact';
  /**
   * Column span in a 12-column flow grid. Default 4. Widgets pack via
   * `grid-auto-flow: dense` so positions are dynamic — operators
   * describe a widget's width once and the grid lays it out.
   */
  span?: number;
  /** Row span (number of 14px rows). Default 8. */
  rowSpan?: number;
  /**
   * Optional visibility predicate. When set, the widget only renders if
   * the predicate is truthy for the active entity. Supported forms:
   *   - `#entity.<key>`                — entity attribute exists
   *   - `<metric_name> has value`      — at least one bucket is non-null
   * Future-compatible; the SPA evaluates this client-side.
   */
  visibleWhen?: string;
  /**
   * When true, the BFF runs this widget's MQE against the whole layer
   * rather than scoping it to the currently-selected service. Used for
   * cross-service rollups (e.g. "Top 20 endpoints by traffic across the
   * layer"). MQE entity flips to `{ scope: All }`.
   */
  layerScope?: boolean;
  /** Legacy 24-col grid coordinates — kept for back-compat during the
   *  span-based flow-layout migration. New widgets should leave these
   *  unset and use `span` / `rowSpan` instead. */
  x?: number;
  y?: number;
  w?: number;
  h?: number;
}

export interface DashboardConfig {
  /** Layer enum (UPPER_SNAKE). */
  layer: string;
  /** Widget set for the requested scope. */
  scope?: DashboardScope;
  /** Order is irrelevant — flow grid drives placement. */
  widgets: DashboardWidget[];
}

export interface DashboardSeries {
  label: string;
  data: Array<number | null>;
  /** `0` = left axis (default), `1` = right axis. Used by dual-axis
   *  line widgets like "MQ count + latency". */
  yAxisIndex?: number;
  /** Optional axis unit hint — shown as a small label near the axis
   *  when present. */
  unit?: string;
}

export interface DashboardTopItem {
  /** Service / instance / endpoint name returned by OAP. */
  name: string;
  value: number | null;
}

/**
 * One row in a `record` widget. RECORD-typed MQE results (e.g. slow
 * SQL statements) carry a primary name (the statement / endpoint /
 * event), a metric value (latency / duration), and optional refs the
 * UI can link to (trace id / span id / instance). All fields except
 * `name` are optional so different record families can share the
 * shape.
 */
export interface DashboardRecordItem {
  /** Display label — for slow SQL this is the statement text. */
  name: string;
  /** Primary metric value (typically latency in ms). */
  value?: number | null;
  /** Optional row-level refs to drill into the originating trace. */
  traceId?: string;
  segmentId?: string;
  spanId?: string;
  /** Sortable timestamp in ms since epoch when present. */
  timestamp?: number;
  /** Free-form extra columns the UI can surface as a side note. */
  extra?: Record<string, string | number | null>;
}

export interface DashboardWidgetResult {
  id: string;
  /** Set when every MQE expression for this widget errored. */
  error?: string;
  /** `card` payload — single scalar (avg across the time window). */
  value?: number | null;
  /** `line` payload — one entry per expression. The line chart picks
   *  up its line labels from the metric.labels relabel values returned
   *  by OAP when present (e.g. `percentile='99'`); otherwise the raw
   *  expression string is used. */
  series?: DashboardSeries[];
  /** `top` payload — legacy single sorted list. Present when the
   *  widget has exactly one expression. */
  topList?: DashboardTopItem[];
  /** `top` payload — multi-expression results, one entry per
   *  `expressions[i]`. UI renders a switcher (one tab per group) and
   *  shows the active group's list. `expression` is echoed so the UI
   *  can surface the MQE in the tab tooltip; `unit` may override the
   *  widget-level unit per tab. Indices align with `widget.expressions`. */
  topGroups?: Array<{
    label: string;
    expression: string;
    unit?: string;
    items: DashboardTopItem[];
  }>;
  /** `record` payload — one row per RECORD-typed MQE entry. The first
   *  expression drives the list; subsequent expressions are ignored for
   *  now (a future iteration could promote them to extra columns). */
  records?: DashboardRecordItem[];
}

export interface DashboardResponse {
  layer: string;
  /** Service name the widgets were scoped to. `null` for layer-wide. */
  service: string | null;
  generatedAt: number;
  step: 'MINUTE' | 'HOUR' | 'DAY';
  durationStart: string;
  durationEnd: string;
  widgets: DashboardWidgetResult[];
  reachable: boolean;
  error?: string;
}
