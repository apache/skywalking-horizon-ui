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
 * Wire shape for the per-layer customization persisted by the BFF.
 *
 * Eventually these configs will live in OAP via `addTemplate` mutations
 * (under the `horizon-` ID prefix) — see PLAN.md "Locked decisions" #2.
 * Until then, the BFF stores them in a JSON file on disk. The UI and
 * server agree on this shape so the swap is a one-place change.
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
  /** Hover tip (string only, no markdown). Used by the Overview tile
   *  metric cells; the SPA surfaces it via the cell label's `title`
   *  attribute. */
  tip?: string;
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
   */
  aggregation?: AggregationKind;
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
  /** @deprecated kept for back-compat; new code reads `overviewGroups`. */
  overviewMetrics?: string[];
  /** Explicit per-layer page header columns — distinct from `columns`
   *  which mixes header + overview-promoted entries (the BFF batches
   *  every MQE in one query). The LayerShell KPI strip iterates ONLY
   *  this list so overview-only metrics don't leak into the header.
   *  Absent on legacy configs → LayerShell falls back to `columns`. */
  headerColumns?: LandingColumn[];
  /** Resolved Overview tile groups. Each group becomes one tile on
   *  the Overview strip with the group's `title` in the header.
   *  Metrics are referenced by id — those ids show up as synthetic
   *  entries in `columns[]` so the BFF batches their MQE in the
   *  same landing query. */
  overviewGroups?: Array<{
    title: string;
    size: 'auto' | 'square';
    /** Column-key references into `columns[]`. */
    metricIds: string[];
  }>;
  style: 'table' | 'bar' | 'mini-topology';
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

export interface SetupResponse {
  generatedAt: number;
  /** Layer key → operator-overridden config. Layers without an override
   *  fall through to horizon-side defaults at render time. */
  layers: Record<string, LayerConfig>;
}

export interface SetupSavePayload {
  layers: Record<string, LayerConfig>;
}
