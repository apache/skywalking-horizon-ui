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
 * The resolved per-layer config shape. The UI derives a `LayerConfig` for each
 * layer from that layer's template (slots / caps / metrics / overview) — see the
 * setup resolver in `apps/ui/src/state/setup.ts`. Layer config is authored in the
 * layer template (OAP-synced via the Layer dashboards admin); this is the shape
 * the renderer reads, not a separately-persisted override.
 */

import type { LayerCaps, LayerSlots } from './menu.js';

/**
 * How to roll up a metric's per-service values into a single layer-wide
 * KPI. `sum` matches "throughput / counting" semantics (cpm, msg/s,
 * invocations) — adding service rates gives whole-layer traffic. `avg`
 * matches "ratio / latency" semantics (sla, p99, err%) — averaging is
 * the only meaningful collapse.
 */
export type AggregationKind = 'sum' | 'avg';

export interface LandingColumn {
  /** Short metric key — looked up in the UI catalog for label/unit/tip. */
  metric: string;
  /** Short header label (e.g. `cpm`). */
  label: string;
  /** Suffix unit (`%`, `ms`, etc.). */
  unit?: string;
  /**
   * MQE expression override. When set, the BFF passes this verbatim to
   * `execExpression(...)` instead of looking up the built-in catalog
   * mapping. Use this when the built-in is wrong, or when the layer
   * has a custom metric the catalog doesn't know about.
   */
  mqe?: string;
  /**
   * Aggregation when collapsing the top-N service values to the
   * per-layer KPI tile. Defaults to `avg` on the UI when unset — the
   * landing card itself (per-service rows) doesn't consult this field.
   * Consulted only for page-side (fan-out) columns; a `selfAggregate`
   * column carries its aggregation inside the MQE.
   */
  aggregation?: AggregationKind;
  /**
   * When true, the `mqe` already folds the whole layer to one scalar
   * server-side (`sum|avg(top_n(<metric>,{{topn}},DES[,attr0='<layer>']))`),
   * so the BFF fires it ONCE globally instead of fanning out per service
   * and aggregating page-side. `{{topn}}` is substituted with the BFF's
   * `query.overviewTopN` before firing. Default false (fan-out) — every
   * legacy caller (the per-layer landing header) stays on the fan-out
   * path untouched. The Overview KPI tiles set this; composites don't.
   */
  selfAggregate?: boolean;
  /**
   * Multiplier applied BFF-side after MQE returns. Use for unit
   * normalization — e.g. SkyWalking's `service_sla` is integer
   * percent-times-100 (`9923` for 99.23%), so a `scale: 0.01` brings
   * it into a familiar `99.23%` range. Default `1` (no-op).
   */
  scale?: number;
  /**
   * Suggested decimal precision for display. The UI formatter honors
   * this when present, otherwise picks a sensible default from the
   * value's magnitude.
   */
  precision?: number;
}

export interface LandingConfig {
  /** Lower number → higher on the Overview. */
  priority: number;
  /** Number of services to surface in the landing card, clamped 5..8. */
  topN: number;
  /** Metric key used to rank the top-N. */
  orderBy: string;
  columns: LandingColumn[];
  /**
   * Per-user threshold overrides for topology + endpoint-dependency
   * metrics. Keyed by `<scope>.<metricId>` where scope is
   * `topology` or `dependency`. Merged on top of the template's
   * default thresholds at render time.
   */
  thresholdOverrides?: Record<
    string,
    {
      ok?: number;
      warn?: number;
      danger?: number;
      invertHealth?: boolean;
      invertBase?: number;
    }
  >;
}

export interface LayerConfig {
  /** Override display name (defaults to OAP `getMenuItems.title`). */
  displayName?: string;
  slots: LayerSlots;
  caps: LayerCaps;
  landing: LandingConfig;
}

