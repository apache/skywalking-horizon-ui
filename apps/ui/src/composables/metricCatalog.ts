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
 * Display metadata for the MQE-result keys we surface on cards and widgets.
 *
 * Definitions cribbed from booster-ui's widget configs in
 * `oap-server/.../ui-initialized-templates` — each upstream widget carries
 * `{name, title, tips}` per expression, which we collapse to one
 * `MetricMeta` per logical metric. Phase 7's admin UI lets operators
 * extend/override this catalog per deployment.
 */

export interface MetricMeta {
  key: string;
  /** Short header label (e.g. `cpm`, `p99`). */
  label: string;
  /** Full readable name (e.g. `Calls per minute`). */
  longLabel: string;
  /** Suffix unit; rendered in subtle tone after the label. */
  unit?: string;
  /** Tooltip explanation rendered as `title` on hover. */
  tip: string;
  /** Optional category for grouping in the setup UI. */
  category?: 'throughput' | 'latency' | 'reliability' | 'resource';
}

export const METRICS: Record<string, MetricMeta> = {
  cpm: {
    key: 'cpm',
    label: 'cpm',
    longLabel: 'Calls per minute',
    tip: 'Throughput — average number of requests served per minute over the time window.',
    category: 'throughput',
  },
  resp: {
    key: 'resp',
    label: 'avg resp',
    longLabel: 'Average response time',
    unit: 'ms',
    tip: 'Mean latency across all calls in the time window.',
    category: 'latency',
  },
  p50: {
    key: 'p50',
    label: 'p50',
    longLabel: '50th percentile latency',
    unit: 'ms',
    tip: 'Median response time — half of requests complete within this latency.',
    category: 'latency',
  },
  p75: {
    key: 'p75',
    label: 'p75',
    longLabel: '75th percentile latency',
    unit: 'ms',
    tip: '75% of requests complete within this latency.',
    category: 'latency',
  },
  p95: {
    key: 'p95',
    label: 'p95',
    longLabel: '95th percentile latency',
    unit: 'ms',
    tip: '95% of requests complete within this latency — useful for the long tail.',
    category: 'latency',
  },
  p99: {
    key: 'p99',
    label: 'p99',
    longLabel: '99th percentile latency',
    unit: 'ms',
    tip: '99% of requests complete within this latency — the slow tail experienced by 1% of users.',
    category: 'latency',
  },
  sla: {
    key: 'sla',
    label: 'SLA',
    longLabel: 'Service Level Agreement',
    unit: '%',
    tip: 'Percentage of successful requests — `(successful / total) * 100`. Higher is better.',
    category: 'reliability',
  },
  apdex: {
    key: 'apdex',
    label: 'apdex',
    longLabel: 'Application Performance Index',
    tip: 'User-satisfaction score on a 0–1 scale. Computed from response-time thresholds.',
    category: 'reliability',
  },
  err: {
    key: 'err',
    label: 'err',
    longLabel: 'Error rate',
    unit: '%',
    tip: 'Percentage of failed requests. Lower is better.',
    category: 'reliability',
  },
};

/** Lookup with a graceful fallback so unknown metrics render readable. */
export function metricMeta(key: string): MetricMeta {
  return (
    METRICS[key] ?? {
      key,
      label: key,
      longLabel: key,
      tip: `Custom metric: ${key}`,
    }
  );
}

export const METRIC_KEYS: ReadonlyArray<string> = Object.keys(METRICS);
