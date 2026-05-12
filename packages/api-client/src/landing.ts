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
 * Wire shape for `GET /api/layer/:key/landing` — the per-layer top-N
 * service rollup the Overview cards render.
 */

export interface LandingServiceRow {
  /** OAP service id. */
  serviceId: string;
  serviceName: string;
  /** Short display name (often `serviceName` without the group prefix). */
  shortName?: string;
  /** Group prefix if present. */
  group?: string;
  /**
   * metric key → numeric value pulled from MQE. `null` means the catalog
   * has no MQE mapping for this metric or the query errored. The UI
   * renders `null` as a muted em-dash.
   */
  metrics: Record<string, number | null>;
  /**
   * Sparkline series for `cfg.spark.metric`, when configured. Same order
   * as the `step` buckets returned by OAP — left-to-right oldest-to-newest.
   * `null` entries mark missing samples.
   */
  spark?: Array<number | null>;
}

/**
 * Layer-wide rollup numbers — used by the compact KPI tile on the
 * Overview page. Aggregations are computed BFF-side using the per-column
 * `aggregation` field from setup; UI doesn't have to recompute.
 */
export interface LandingAggregates {
  /** Whole-layer service count (pre-topN slice). */
  serviceCount: number;
  /** Aggregated value per column metric, keyed by metric short key.
   *  `null` when the column has no MQE mapping or every cell failed. */
  metrics: Record<string, number | null>;
  /** Aggregated sparkline series for the `throughput.metric` (or `spark`)
   *  using the throughput aggregation. `null` when not configured. */
  spark?: Array<number | null> | null;
  /** Echo of the throughput metric key the spark series was computed
   *  against (so the UI can label the tile). */
  throughputMetric?: string;
  /** Value of the throughput metric across the layer (null when
   *  unconfigured or unmapped). */
  throughputValue?: number | null;
}

export interface LandingResponse {
  layer: string;
  topN: number;
  orderBy: string;
  /** Server epoch ms when the response was assembled. */
  generatedAt: number;
  /** Step the BFF asked OAP to bucket on (`MINUTE` for a 15m window). */
  step: 'MINUTE' | 'HOUR' | 'DAY';
  /** Echo of the window the BFF queried — server-TZ formatted. */
  durationStart: string;
  durationEnd: string;
  rows: LandingServiceRow[];
  /** Whole-layer rollup KPIs for the Overview strip tile. */
  aggregates: LandingAggregates;
  /**
   * True when the BFF reached OAP and got a service list back. Per-metric
   * MQE errors don't flip this — only `listServices` failures do.
   */
  reachable: boolean;
  /** Set when `reachable === false`. */
  error?: string;
}
