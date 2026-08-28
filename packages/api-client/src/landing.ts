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
  /** Per-column aggregated time series (one entry per bucket in the
   *  default MINUTE-stepped window). Aggregation kind comes from the
   *  column's `aggregation` field — sum for cpm-shaped throughput
   *  metrics, avg for ratio/latency metrics. Used by the per-layer
   *  header to render a trend line under each KPI. */
  seriesByMetric: Record<string, Array<number | null>>;
}

export interface LandingResponse {
  /**
   * Part of the metric fan-out could not be read.
   *
   * `reachable` is still true — a partial metric read is a drawable answer,
   * and the graph layer's acceptance rule depends on that. What this says is
   * narrower and easy to miss without it: the ROWS were ranked on incomplete
   * data. A caller presenting a "busiest service" or picking a default from
   * `rows[0]` is choosing on a measurement that did not fully happen.
   *
   * Services whose metric a failed chunk left unread are ranked ABOVE the
   * genuinely-absent, so a timeout cannot silently evict the busiest service
   * from the top-N.
   *
   * Same shape as the topology responses' field, deliberately.
   */
  metricsPartial?: { failedChunks: number; totalChunks: number };
  /**
   * The header's KPI values describe one COMPLETED hour, not the picked range.
   *
   * They are read once per layer per hour rather than on every refresh — the
   * fan-out that produces them is proportional to the layer's service count,
   * and repeating it every thirty seconds is what it cannot survive. Present
   * whenever `rows[].metrics` and `aggregates` came from that hour.
   *
   * A renderer must SAY so. The values sit beside charts that do follow the
   * time picker, and nothing else on screen distinguishes them; `hourStartMs`
   * is the label to show, not a relative age, which would jump from "an hour
   * ago" to "two hours ago" at the roll and read as a fault.
   *
   * `stale` means a newer hour is being read and this is the one before it.
   *
   * `partial` means these are the hour IN PROGRESS, read live and not cached —
   * it happens only while no completed hour holds anything, which is a
   * deployment installed minutes ago. An empty header would be the wrong answer
   * there, since the data plainly exists; it is just not finished.
   */
  kpiHour?: { hourStartMs: number; stale: boolean; partial?: boolean };
  /**
   * The hour is being read and there is nothing to show yet.
   *
   * Only on a layer above `performance.limits.headerWarmupMaxServices`, where
   * reading the picked window instead would cost a second fan-out the size of
   * the one already running — once per concurrent caller. The rows come back
   * without metric values; a renderer should say the figures are still being
   * read rather than drawing the blanks as zero or as "no traffic".
   */
  kpiWarming?: boolean;
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
  /**
   * Every service the BFF probed for this layer (up to `query.landingServiceCap`,
   * default 100; the true top-N by `orderBy` when the layer exceeds it).
   * `rows` is a sorted+sliced subset (the top-`topN`); the per-layer service
   * picker uses the full `sampledRows` so it can list the whole layer.
   */
  sampledRows?: LandingServiceRow[];
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
