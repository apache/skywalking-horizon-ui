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
 * `MetricMeta` per logical metric. Operators extend / override per
 * deployment via the admin pages under Dashboard setup
 * (`/admin/overview-templates`, `/admin/layer-dashboards`).
 *
 * ---------------------------------------------------------------------
 * Terminology standard
 * ---------------------------------------------------------------------
 * Each entry has a short-key `key` (used in URLs / persisted config /
 * setup JSON) and a human display `label`. The conventions below are
 * authoritative — please don't introduce parallel spellings.
 *
 *   key          display label    notes
 *   ----         -------------    ----------------------------------
 *   cpm          RPM              The internal short key stays `cpm`
 *                                 (matches OAP's `service_cpm`), but
 *                                 the display label is "RPM" /
 *                                 "Requests per minute" — operators
 *                                 read web-throughput terms more
 *                                 naturally than "Calls per minute".
 *                                 Never display the raw "cpm".
 *   resp         Avg RT           "Average response time" in ms. Use
 *                                 "Avg RT" on tight chrome, "Average
 *                                 Response Time" in tooltips.
 *   p50/p75/p95/p99   P50/P75/P95/P99   Uppercase. Latency percentiles.
 *   sla          SLA              "Success Rate" is acceptable in body
 *                                 copy, but the short label stays SLA
 *                                 to match OAP's `service_sla` metric.
 *                                 NEVER lower-case as "sla".
 *   apdex        Apdex            Title-case, single word. Booster
 *                                 uses "Apdex Score"; "Apdex" alone
 *                                 fits our denser tile.
 *   err          Error Rate       "Error Rate" with a space. Lower is
 *                                 better. Avoid "error pct".
 *
 *   mq.msg-rate         Msg/s
 *   mq.consumer-lag     Lag
 *   mq.consume-latency  Consume
 *
 *   db.qps              QPS
 *   db.slow-queries     Slow
 *
 * Short labels appear on KPI tiles where pixels are scarce; long
 * labels appear in setup pickers / tooltips. The full sentence-form
 * lives in `longLabel`.
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

/**
 * Logical layer category. Used to pick a sensible default column set for
 * the Overview landing card. Concrete OAP layer enums map to one of these
 * via {@link layerCategory}.
 */
export type LayerCategory =
  | 'general'
  | 'mesh'
  | 'k8s'
  | 'browser'
  | 'database'
  | 'mq'
  | 'faas'
  | 'genai';

export const METRICS: Record<string, MetricMeta> = {
  cpm: {
    key: 'cpm',
    // Displayed as "RPM" (requests per minute) even though the OAP
    // metric key is `service_cpm`. RPM reads more naturally for
    // operators familiar with web-throughput terminology. The short
    // key stays `cpm` to match OAP / booster-ui everywhere data
    // flows through.
    label: 'RPM',
    longLabel: 'Requests per minute',
    tip: 'Throughput — average number of requests served per minute over the time window.',
    category: 'throughput',
  },
  resp: {
    key: 'resp',
    label: 'Avg RT',
    longLabel: 'Average response time',
    unit: 'ms',
    tip: 'Mean latency across all calls in the time window.',
    category: 'latency',
  },
  p50: {
    key: 'p50',
    label: 'P50',
    longLabel: '50th percentile latency',
    unit: 'ms',
    tip: 'Median response time — half of requests complete within this latency.',
    category: 'latency',
  },
  p75: {
    key: 'p75',
    label: 'P75',
    longLabel: '75th percentile latency',
    unit: 'ms',
    tip: '75% of requests complete within this latency.',
    category: 'latency',
  },
  p95: {
    key: 'p95',
    label: 'P95',
    longLabel: '95th percentile latency',
    unit: 'ms',
    tip: '95% of requests complete within this latency — useful for the long tail.',
    category: 'latency',
  },
  p99: {
    key: 'p99',
    label: 'P99',
    longLabel: '99th percentile latency',
    unit: 'ms',
    tip: '99% of requests complete within this latency — the slow tail experienced by 1% of users.',
    category: 'latency',
  },
  sla: {
    key: 'sla',
    label: 'SLA',
    longLabel: 'Service Level Agreement (success rate)',
    unit: '%',
    tip: 'Percentage of successful requests — `(successful / total) * 100`. Higher is better.',
    category: 'reliability',
  },
  apdex: {
    key: 'apdex',
    label: 'Apdex',
    longLabel: 'Application Performance Index',
    tip: 'User-satisfaction score on a 0–1 scale. Computed from response-time thresholds.',
    category: 'reliability',
  },
  err: {
    key: 'err',
    label: 'Error Rate',
    longLabel: 'Error rate',
    unit: '%',
    tip: 'Percentage of failed requests. Lower is better.',
    category: 'reliability',
  },

  // --- MQ-flavored layers (kafka / pulsar / rocketmq / rabbitmq / activemq / virtual_mq)
  // Names mirror the booster-ui MQ widget keys (`service_mq_consume_count`,
  // `service_mq_consumer_lag`) — we surface the short alias here, the MQE
  // expression is resolved per-deployment by the BFF in Stage 2.6.
  'mq.msg-rate': {
    key: 'mq.msg-rate',
    label: 'Msg/s',
    longLabel: 'Messages per second',
    tip: 'Producer or consumer message throughput across the cluster.',
    category: 'throughput',
  },
  'mq.consumer-lag': {
    key: 'mq.consumer-lag',
    label: 'Lag',
    longLabel: 'Consumer lag',
    tip: 'Number of messages a consumer is behind the latest offset. Lower is better.',
    category: 'reliability',
  },
  'mq.consume-latency': {
    key: 'mq.consume-latency',
    label: 'Consume',
    longLabel: 'Consume latency',
    unit: 'ms',
    tip: 'Time from publish to consumer acknowledgment.',
    category: 'latency',
  },

  // --- DB layers (mysql / postgresql / mongodb / elasticsearch / redis / clickhouse / virtual_database)
  'db.qps': {
    key: 'db.qps',
    label: 'QPS',
    longLabel: 'Queries per second',
    tip: 'Average query throughput over the time window.',
    category: 'throughput',
  },
  'db.slow-queries': {
    key: 'db.slow-queries',
    label: 'Slow',
    longLabel: 'Slow query count',
    tip: 'Number of queries exceeding the slow-query threshold.',
    category: 'reliability',
  },
  'db.conn': {
    key: 'db.conn',
    label: 'Conns',
    longLabel: 'Active connections',
    tip: 'Open client connections to the database.',
    category: 'resource',
  },

  // --- Cache (redis / virtual_cache)
  'cache.hit-rate': {
    key: 'cache.hit-rate',
    label: 'Hit',
    longLabel: 'Cache hit rate',
    unit: '%',
    tip: 'Percentage of lookups served from cache.',
    category: 'reliability',
  },

  // --- Browser layer
  'browser.pv': {
    key: 'browser.pv',
    label: 'pv',
    longLabel: 'Page views',
    tip: 'Page-view count over the time window.',
    category: 'throughput',
  },
  'browser.js-err': {
    key: 'browser.js-err',
    label: 'js-err',
    longLabel: 'JS errors',
    tip: 'Browser JavaScript exceptions reported by the agent.',
    category: 'reliability',
  },
  'browser.page-load': {
    key: 'browser.page-load',
    label: 'load',
    longLabel: 'Page load time',
    unit: 'ms',
    tip: 'Full document load time as measured by the navigation timing API.',
    category: 'latency',
  },
  'browser.ajax-resp': {
    key: 'browser.ajax-resp',
    label: 'ajax',
    longLabel: 'AJAX response time',
    unit: 'ms',
    tip: 'Average AJAX round-trip latency.',
    category: 'latency',
  },

  // --- FaaS (no first-class layer enum yet — speculative for OpenFunction / AWS Lambda)
  'faas.invocations': {
    key: 'faas.invocations',
    label: 'invk',
    longLabel: 'Invocations',
    tip: 'Number of function invocations over the time window.',
    category: 'throughput',
  },
  'faas.cold-start': {
    key: 'faas.cold-start',
    label: 'cold',
    longLabel: 'Cold-start count',
    tip: 'Invocations that incurred a runtime cold start.',
    category: 'reliability',
  },
  'faas.duration': {
    key: 'faas.duration',
    label: 'dur',
    longLabel: 'Invocation duration',
    unit: 'ms',
    tip: 'Wall-clock execution time of the function.',
    category: 'latency',
  },

  // --- K8s layer
  'k8s.cpu': {
    key: 'k8s.cpu',
    label: 'cpu',
    longLabel: 'CPU usage',
    unit: '%',
    tip: 'Container or pod CPU as a percentage of the limit.',
    category: 'resource',
  },
  'k8s.mem': {
    key: 'k8s.mem',
    label: 'mem',
    longLabel: 'Memory usage',
    unit: '%',
    tip: 'Container or pod memory as a percentage of the limit.',
    category: 'resource',
  },
  'k8s.restart': {
    key: 'k8s.restart',
    label: 'restarts',
    longLabel: 'Pod restarts',
    tip: 'Restart count observed on the workload over the time window.',
    category: 'reliability',
  },

  // --- GenAI (virtual_genai)
  'genai.tokens': {
    key: 'genai.tokens',
    label: 'tok/s',
    longLabel: 'Tokens per second',
    tip: 'Combined input + output token throughput.',
    category: 'throughput',
  },
  'genai.req': {
    key: 'genai.req',
    label: 'req',
    longLabel: 'Requests',
    tip: 'Inference request count over the time window.',
    category: 'throughput',
  },
  'genai.latency': {
    key: 'genai.latency',
    label: 'latency',
    longLabel: 'Inference latency',
    unit: 'ms',
    tip: 'End-to-end request latency including queueing.',
    category: 'latency',
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

/**
 * Bucket an OAP layer enum into a logical category so we can pick a sane
 * default column set on the landing card. Unknown layers fall back to the
 * `general` (RPC-shaped) set.
 */
export function layerCategory(layerKey: string): LayerCategory {
  const k = layerKey.toLowerCase();
  if (k === 'general') return 'general';
  if (k === 'mesh' || k === 'mesh_cp' || k === 'mesh_dp') return 'mesh';
  if (k === 'k8s' || k === 'k8s_service') return 'k8s';
  if (k === 'browser') return 'browser';
  if (k === 'virtual_genai') return 'genai';
  if (k === 'faas' || k === 'so11y_openfunction' || k.endsWith('_faas')) return 'faas';
  if (
    k === 'mysql' || k === 'postgresql' || k === 'mongodb' || k === 'elasticsearch' ||
    k === 'redis' || k === 'clickhouse' || k === 'virtual_database' || k === 'virtual_cache'
  ) return 'database';
  if (
    k === 'kafka' || k === 'pulsar' || k === 'rocketmq' || k === 'rabbitmq' ||
    k === 'activemq' || k === 'virtual_mq'
  ) return 'mq';
  return 'general';
}

interface DefaultLandingSet {
  /** 3–4 columns; first one is usually a throughput-ish metric. */
  columns: Array<{ metric: string; label?: string; unit?: string }>;
  /** Metric key used to rank the top-N. */
  orderBy: string;
}

const LAYER_TYPE_DEFAULTS: Record<LayerCategory, DefaultLandingSet> = {
  general: {
    columns: [
      { metric: 'cpm' },
      { metric: 'p99' },
      { metric: 'sla' },
      { metric: 'err' },
    ],
    orderBy: 'cpm',
  },
  mesh: {
    columns: [
      { metric: 'cpm' },
      { metric: 'p99' },
      { metric: 'sla' },
      { metric: 'err' },
    ],
    orderBy: 'cpm',
  },
  k8s: {
    columns: [
      { metric: 'k8s.cpu' },
      { metric: 'k8s.mem' },
      { metric: 'k8s.restart' },
    ],
    orderBy: 'k8s.cpu',
  },
  browser: {
    columns: [
      { metric: 'browser.pv' },
      { metric: 'browser.page-load' },
      { metric: 'browser.ajax-resp' },
      { metric: 'browser.js-err' },
    ],
    orderBy: 'browser.pv',
  },
  database: {
    columns: [
      { metric: 'db.qps' },
      { metric: 'resp' },
      { metric: 'db.slow-queries' },
      { metric: 'db.conn' },
    ],
    orderBy: 'db.qps',
  },
  mq: {
    columns: [
      { metric: 'mq.msg-rate' },
      { metric: 'mq.consume-latency' },
      { metric: 'mq.consumer-lag' },
    ],
    orderBy: 'mq.msg-rate',
  },
  faas: {
    columns: [
      { metric: 'faas.invocations' },
      { metric: 'faas.duration' },
      { metric: 'faas.cold-start' },
      { metric: 'err' },
    ],
    orderBy: 'faas.invocations',
  },
  genai: {
    columns: [
      { metric: 'genai.req' },
      { metric: 'genai.tokens' },
      { metric: 'genai.latency' },
    ],
    orderBy: 'genai.req',
  },
};

/** Per-layer-type column defaults. Each column reads label + unit from the
 *  metric catalog so changes in METRICS flow through without touching this. */
export function defaultColumnsForLayer(
  layerKey: string,
): Array<{ metric: string; label: string; unit?: string }> {
  const set = LAYER_TYPE_DEFAULTS[layerCategory(layerKey)];
  return set.columns.map((c) => {
    const meta = metricMeta(c.metric);
    return {
      metric: c.metric,
      label: c.label ?? meta.label,
      unit: c.unit ?? meta.unit,
    };
  });
}

/** Metric key used to rank the top-N services on a layer's landing card. */
export function defaultOrderByForLayer(layerKey: string): string {
  return LAYER_TYPE_DEFAULTS[layerCategory(layerKey)].orderBy;
}

/**
 * Generic RPC-shaped metrics every layer can render — surfaced as a
 * fallback group in the setup UI's chip picker after the layer-specific
 * defaults.
 */
const GENERIC_METRIC_KEYS: ReadonlyArray<string> = [
  'cpm', 'resp', 'p50', 'p75', 'p95', 'p99', 'sla', 'apdex', 'err',
];

const LAYER_TYPE_METRIC_KEYS: Record<LayerCategory, ReadonlyArray<string>> = {
  general: GENERIC_METRIC_KEYS,
  mesh: GENERIC_METRIC_KEYS,
  k8s: ['k8s.cpu', 'k8s.mem', 'k8s.restart'],
  browser: ['browser.pv', 'browser.page-load', 'browser.ajax-resp', 'browser.js-err'],
  database: ['db.qps', 'db.slow-queries', 'db.conn', 'cache.hit-rate'],
  mq: ['mq.msg-rate', 'mq.consume-latency', 'mq.consumer-lag'],
  faas: ['faas.invocations', 'faas.duration', 'faas.cold-start'],
  genai: ['genai.req', 'genai.tokens', 'genai.latency'],
};

/**
 * Sort metric keys into two buckets for the setup UI: relevant to this
 * layer's category, vs. the rest of the catalog. Operators can still pick
 * anything, but the recommended ones surface first.
 */
export function metricsForLayer(layerKey: string): {
  recommended: MetricMeta[];
  other: MetricMeta[];
} {
  const cat = layerCategory(layerKey);
  const recoKeys = new Set<string>([
    ...LAYER_TYPE_METRIC_KEYS[cat],
    // Every layer can usefully render generic reliability/error metrics.
    ...(cat === 'general' || cat === 'mesh' ? [] : ['err']),
  ]);
  const recommended: MetricMeta[] = [];
  const other: MetricMeta[] = [];
  for (const m of Object.values(METRICS)) {
    (recoKeys.has(m.key) ? recommended : other).push(m);
  }
  return { recommended, other };
}
