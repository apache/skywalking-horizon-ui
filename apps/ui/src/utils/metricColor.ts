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
 * Stable per-entity color palette for multi-entity compare (lock N
 * service / instance / endpoint entities and cross-check). Six visually
 * distinct hues — one per locked entity, assigned by id-keyed slot so a
 * given entity keeps its color across the chip bar, the compare grid,
 * and the overlay drill-out. Byte-identical to TimeChart's historic
 * multi-series `SECONDARY` palette, which now consumes this single
 * source; six hues is also what caps the lockable set at six.
 */
export const ENTITY_PALETTE = [
  '#60a5fa', // info-ish (blue)
  '#a78bfa', // purple
  '#22d3ee', // cyan
  '#f472b6', // pink
  '#34d399', // ok-ish (green)
  '#fbbf24', // amber
] as const;

/**
 * Per-metric color mapping for KPI tiles. Keeps the per-layer header
 * + selector pinned-bar visually consistent with the design's
 * `Landing / Layer · General` top KPI row (landing-layer.jsx:67-83).
 *
 *   Services / count       → info  (blue)
 *   cpm / throughput        → accent (orange)
 *   p99 / percentile / resp → warn  (yellow)
 *   sla / apdex             → purple
 *   err / failure           → err   (red)
 *   alarms                  → err
 *
 * Falls back to fg-0 for anything we don't recognise — operators can
 * still add custom metrics without the page going monochrome.
 */
export function colorForMetric(metricKey: string): string {
  const k = metricKey.toLowerCase();
  if (k === 'cpm' || k.endsWith('.msg-rate') || k.endsWith('.qps') || k.endsWith('.req') || k.endsWith('.invocations') || k.endsWith('.tokens') || k.endsWith('.pv')) {
    return 'var(--sw-accent)';
  }
  if (k.includes('resp') || k.startsWith('p50') || k.startsWith('p75') || k.startsWith('p90') || k.startsWith('p95') || k.startsWith('p99') || k.includes('percentile') || k.endsWith('latency') || k.endsWith('duration') || k.endsWith('page-load') || k.endsWith('ajax-resp')) {
    return 'var(--sw-warn)';
  }
  if (k === 'sla' || k === 'apdex' || k.endsWith('hit-rate')) {
    return 'var(--sw-purple)';
  }
  if (k === 'err' || k.endsWith('.js-err') || k.endsWith('-err') || k.endsWith('lag') || k.endsWith('slow-queries') || k.endsWith('cold-start') || k.endsWith('restart')) {
    return 'var(--sw-err)';
  }
  if (k === 'services' || k === 'instances' || k === 'endpoints') {
    return 'var(--sw-info)';
  }
  return 'var(--sw-fg-0)';
}

/**
 * Threshold-based color for a row cell. Used by the "Services in this
 * layer" table to color individual metric values by their health band:
 * p99 > 400ms = warn, err > 1% = err, sla < 99% = err, apdex < 0.85 =
 * warn. Returns null when the metric isn't one we threshold on, so the
 * cell can render in the default foreground.
 */
export function thresholdColor(metricKey: string, value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) return null;
  const k = metricKey.toLowerCase();
  if (k === 'err' || k.endsWith('-err') || k.endsWith('.js-err')) {
    if (value > 1) return 'var(--sw-err)';
    if (value > 0.5) return 'var(--sw-warn)';
  }
  if (k === 'sla') {
    if (value < 99) return 'var(--sw-err)';
    if (value < 99.9) return 'var(--sw-warn)';
  }
  if (k === 'apdex') {
    if (value < 0.85) return 'var(--sw-err)';
    if (value < 0.95) return 'var(--sw-warn)';
  }
  if (k.startsWith('p99') || k.startsWith('p95')) {
    if (value > 1000) return 'var(--sw-err)';
    if (value > 400) return 'var(--sw-warn)';
  }
  return null;
}

/**
 * Service-status from a row's metrics — used for the pulse dot and
 * traffic-share bar color in the expanded selector table.
 */
export function statusForMetrics(metrics: Record<string, number | null>): 'ok' | 'warn' | 'err' {
  const err = metrics['err'];
  const sla = metrics['sla'];
  if (err !== null && err !== undefined && err > 1) return 'err';
  if (sla !== null && sla !== undefined && sla < 99) return 'err';
  if (err !== null && err !== undefined && err > 0.5) return 'warn';
  if (sla !== null && sla !== undefined && sla < 99.9) return 'warn';
  return 'ok';
}
