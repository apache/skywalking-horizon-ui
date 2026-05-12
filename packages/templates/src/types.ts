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
 * Wire types for SkyWalking dashboard templates.
 *
 * Field-compatible with booster-ui's `LayoutConfig` so existing exports
 * round-trip without massage. New fields are additive; we never rename a
 * key that booster-ui or the OAP loader writes.
 *
 * Reference shape (from `oap-server/.../UITemplateInitializer.java`):
 *   `[{ id, configuration: { children, layer, entity, name, isRoot, ... } }]`
 * The outer single-element array is a Jackson loader artifact; we strip
 * it on read so consumers see `DashboardConfiguration` directly.
 */

/** Per-expression display options on a widget. */
export interface MetricConfigOpt {
  unit?: string;
  label?: string;
  labelsIndex?: string;
  sortOrder?: string;
  topN?: number;
  index?: number;
  detailLabel?: string;
}

/** Per-widget chart-style options. The literal `type` discriminates the union. */
export type GraphConfig =
  | { type: 'Line' | 'Area' | 'Bar' | 'Card' | 'Table' | 'TopList' | 'HeatMap'; [k: string]: unknown }
  | { type: 'ServiceList' | 'InstanceList' | 'EndpointList'; dashboardName?: string; [k: string]: unknown }
  | { type: 'Topology'; [k: string]: unknown }
  | { type: 'Text' | 'TimeRange'; [k: string]: unknown }
  | { type: string; [k: string]: unknown };

/** A widget node inside a dashboard configuration. */
export interface LayoutConfig {
  /** vue-grid-layout coords. */
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  /** Stable widget id (string, sometimes a tab-prefixed compound like `"4-0-10"`). */
  i?: string;

  /** Widget type enum. See `views/dashboard/data.ts` in booster-ui. */
  type: string;

  /** MQE expressions evaluated for this widget. Always plural. */
  expressions?: string[];
  subExpressions?: string[];
  typesOfMQE?: string[];

  metricConfig?: MetricConfigOpt[];

  widget?: {
    name?: string;
    title?: string;
    tips?: string;
    url?: string;
    type?: string;
  };

  graph?: GraphConfig;

  /**
   * For `Tab` widgets each child is a tab pane (`{name, children}`).
   * For everything else each child is a nested widget.
   */
  children?: (LayoutTab | LayoutConfig)[];

  associate?: Array<{ widgetId: string }>;
  relatedTrace?: {
    refIdType?: string;
    enableRelate?: boolean;
    latency?: boolean;
    status?: string;
    duration?: number;
    queryOrder?: string;
  };

  /** Drill-down dashboard names. */
  valueRelatedDashboard?: string;
  linkDashboard?: string;
  nodeDashboard?: Array<{ scope: string; dashboard: string }>;
  instanceDashboardName?: string;
  processDashboardName?: string;

  /** Topology-specific MQE bundles. */
  linkServerExpressions?: string[];
  linkClientExpressions?: string[];
  nodeExpressions?: string[];

  legendMQE?: { expression: string };

  filters?: unknown;
  auto?: boolean;
  autoPeriod?: number;

  /** Forward-compat escape hatch. Avoid relying on this in new code. */
  [key: string]: unknown;
}

export interface LayoutTab {
  name: string;
  children: LayoutConfig[];
  expression?: string;
  enable?: boolean;
}

/** Top-level dashboard configuration parsed from a template JSON file. */
export interface DashboardConfiguration {
  /** Source-of-truth identifier (e.g. `"General-Service"`). */
  id?: string;
  layer: string;
  entity: string;
  name: string;
  /** Landing dashboard for `(layer, entity)` when true. */
  isRoot?: boolean;
  /** Hierarchy default for `entity = Service` chains. */
  isDefault?: boolean;
  /** Optional URL fragment hint; rare. */
  path?: string;
  /** Top-level expressions (used by hierarchy widgets). */
  expressions?: string[];
  expressionsConfig?: MetricConfigOpt[];
  /** Widget tree. */
  children: LayoutConfig[];
}

/**
 * Menu item shape from OAP's `getMenuItems` query / our local `menu.yaml`
 * mirror. Identical wire shape so the BFF can substitute one for the other.
 */
export interface MenuItem {
  title: string;
  icon?: string;
  layer: string;
  /** Computed server-side from "layer has services?". */
  activate?: boolean;
  subItems?: MenuItem[];
  description?: string;
  documentLink?: string;
  i18nKey?: string;
}
