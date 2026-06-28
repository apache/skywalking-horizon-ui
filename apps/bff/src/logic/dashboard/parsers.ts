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
 * Pure parsers that turn an `execExpression` (MQE) result into each widget
 * type's render shape. Stateless and exported for unit testing.
 */

import type { MqeResultShape } from './mqe.js';

export function parseSeries(r: MqeResultShape | undefined): Array<number | null> | null {
  if (!r || r.error) return null;
  const values = r.results?.[0]?.values ?? [];
  if (values.length === 0) return null;
  return values.map((v) => {
    if (v.value === null || v.value === undefined) return null;
    const n = Number(v.value);
    return Number.isFinite(n) ? n : null;
  });
}
export function avgOf(series: Array<number | null> | null): number | null {
  if (!series) return null;
  const xs = series.filter((v): v is number => v !== null);
  if (xs.length === 0) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/**
 * Time-series MQE responses can carry multiple labeled results (one
 * relabel() call returns 5 results, one per percentile). Convert each
 * to a `DashboardSeries`. The label preference order:
 *  - explicit `relabels(..., key='...')` from metric.labels (multi-series)
 *  - fallback to the caller's expression text (single-series)
 *
 * Do NOT use `values[0].id` as a label — for time-series MQEs, OAP
 * returns the per-bucket timestamp/index as the value id, which is
 * useless as a series label.
 */
export function parseLabeledSeries(
  r: MqeResultShape | undefined,
  fallbackLabel: string,
): Array<{ label: string; data: Array<number | null> }> | null {
  if (!r || r.error) return null;
  const results = r.results ?? [];
  // Name each series by its DISCRIMINATING label(s). A labeled metric can
  // carry both an identity dimension (`pipe` / `pipeline`) and a constant
  // aggregation dimension (`status='all'`); naming off the last label alone
  // collapses every series onto the constant. Keep only labels whose value
  // varies across the whole result, then join them for the series name.
  const varyingKeys = new Set<string>();
  {
    const keys = new Set<string>();
    for (const rs of results) for (const l of rs.metric?.labels ?? []) keys.add(l.key);
    for (const key of keys) {
      const vals = new Set(results.map((rs) => (rs.metric?.labels ?? []).find((l) => l.key === key)?.value));
      if (vals.size > 1) varyingKeys.add(key);
    }
  }
  const out: Array<{ label: string; data: Array<number | null> }> = [];
  for (const rs of results) {
    const values = rs.values ?? [];
    if (values.length === 0) continue;
    const data = values.map((v) => {
      if (v.value === null || v.value === undefined) return null;
      const n = Number(v.value);
      return Number.isFinite(n) ? n : null;
    });
    // Series name = the varying label(s). Single-label relabels()/percentile
    // (`p='99'`) keep their lone varying label; a constant-only or unlabeled
    // series falls back to the last label, then the expression text.
    const labels = rs.metric?.labels ?? [];
    const varying = labels.filter((l) => varyingKeys.has(l.key));
    const lbl =
      varying.length > 0 ? varying.map((l) => l.value).join(', ')
      : labels.length > 0 ? labels[labels.length - 1].value
      : fallbackLabel;
    out.push({ label: lbl, data });
  }
  return out.length > 0 ? out : null;
}

/**
 * Extract a sorted list from a `top_n(...)` MQE response. Names follow
 * an entity-scope priority:
 *   Endpoint    →  "<service> · <endpoint>" or just "<endpoint>"
 *   Instance    →  "<service> · <instance>" or just "<instance>"
 *   Service     →  service
 *   fallback    →  raw id
 *
 * The `<service> ·` prefix is only added when the list actually spans
 * MULTIPLE services (layer-wide top lists, where the same endpoint can
 * appear under different services and needs disambiguation). On a
 * single-service dashboard ("Top 20 APIs" under one service) every row
 * carries the same service, so the prefix is pure noise — drop it and
 * show just the endpoint / instance.
 */
export function parseTopList(
  r: MqeResultShape | undefined,
): Array<{ name: string; value: number | null }> | null {
  if (!r || r.error) return null;
  const values = r.results?.[0]?.values ?? [];
  if (values.length === 0) return null;
  const services = new Set<string>();
  for (const v of values) {
    if (v.owner?.serviceName) services.add(v.owner.serviceName);
  }
  const multiService = services.size > 1;
  return values.map((v) => {
    const o = v.owner;
    let name = '—';
    if (o?.endpointName) {
      name = multiService && o.serviceName ? `${o.serviceName} · ${o.endpointName}` : o.endpointName;
    } else if (o?.serviceInstanceName) {
      name = multiService && o.serviceName
        ? `${o.serviceName} · ${o.serviceInstanceName}`
        : o.serviceInstanceName;
    } else if (o?.serviceName) {
      name = o.serviceName;
    } else if (v.id) {
      name = v.id;
    }
    const num = v.value !== null && v.value !== undefined ? Number(v.value) : null;
    return { name, value: Number.isFinite(num as number) ? (num as number) : null };
  });
}

/**
 * Extract slow-SQL / slow-statement samples from a RECORD_LIST MQE
 * response (e.g. `top_n(top_n_database_statement, …)`). Each entry is one
 * sampled statement execution: `name` is the statement text (the MQE
 * value `id`), `value` the latency, and `traceId` the originating trace —
 * which the `record` widget surfaces as a jump-to-trace icon per row.
 */
export function parseRecords(
  r: MqeResultShape | undefined,
): Array<{ name: string; value: number | null; traceId: string | null }> | null {
  if (!r || r.error) return null;
  const values = r.results?.[0]?.values ?? [];
  if (values.length === 0) return null;
  return values.map((v) => {
    const num = v.value !== null && v.value !== undefined ? Number(v.value) : null;
    return {
      name: v.id ?? '—',
      value: Number.isFinite(num as number) ? (num as number) : null,
      traceId: v.traceID ?? null,
    };
  });
}

/**
 * Extract `table` rows from a LABELED `latest(...)` MQE response. Each
 * result is one label combination (e.g. `{phase: Running, service: x}`
 * or `{condition: Ready, node: y}`); the row name joins the label
 * VALUES (the status/phase/condition/entity dimensions) and the value
 * is the latest non-null bucket. Mirrors booster-ui's Table for
 * label-dimensioned meters that a scalar card / time-series line can't
 * represent. Rows are sorted by name for a stable render.
 */
export function parseTable(
  r: MqeResultShape | undefined,
): Array<{ labels: Array<{ key: string; value: string }>; value: number | null }> | null {
  if (!r || r.error) return null;
  const results = r.results ?? [];
  if (results.length === 0) return null;
  const rows = results.map((rs) => {
    const labels = (rs.metric?.labels ?? []).map((l) => ({ key: l.key, value: l.value }));
    // `latest(...)` yields one bucket, but be defensive: take the last
    // non-null value across the result's buckets.
    let value: number | null = null;
    for (const v of rs.values ?? []) {
      if (v.value === null || v.value === undefined) continue;
      const n = Number(v.value);
      if (Number.isFinite(n)) value = n;
    }
    // No labels (degenerate) → fall back to the value id as a single column.
    if (labels.length === 0 && rs.values?.[0]?.id) {
      labels.push({ key: 'name', value: rs.values[0].id as string });
    }
    return { labels, value };
  });
  rows.sort((a, b) =>
    a.labels.map((l) => l.value).join('·').localeCompare(b.labels.map((l) => l.value).join('·')),
  );
  return rows;
}
