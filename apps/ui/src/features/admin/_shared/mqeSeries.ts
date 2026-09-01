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
 * Turn a `TIME_SERIES_VALUES` result into the `{ series, xLabels }` pair
 * `TimeChart` draws.
 *
 * The alignment is on the UNION of the bucket ids, not on array index. A
 * labelled metric returns one result per label combination and OAP may hand
 * back a different set of buckets for each — aligning positionally would
 * slide one percentile's 11:05 under another's 11:06 and draw a chart that
 * is wrong rather than merely sparse. Every series is re-indexed onto the
 * shared axis, with `null` where that series has no sample.
 *
 * `TimeChart` only honours `xLabels` when its length matches the first
 * series' data length, so producing equal-length rows here is a
 * requirement, not tidiness.
 */

import type { ExpressionResult, MqeValues } from '@skywalking-horizon-ui/api-client';
import { bucketTimeLabel } from '@/utils/formatters';

export interface AlignedSeries {
  label: string;
  data: Array<number | null>;
}

export interface AlignedChart {
  xLabels: string[];
  series: AlignedSeries[];
  /** Bucket ids behind `xLabels`, for the value table's own rows. */
  ids: string[];
}

/**
 * Name a series from its own labels.
 *
 * Only labels whose value VARIES across the result set discriminate: a
 * labelled metric often carries a constant dimension alongside the real one
 * (`status='all'` beside `p='95'`), and naming off every label makes three
 * legend chips that differ in one character. This mirrors the rule the BFF
 * already applies when it names dashboard series.
 */
export function seriesLabel(r: MqeValues, all: MqeValues[], fallback: string): string {
  const labels = r.metric?.labels ?? [];
  if (labels.length === 0) return fallback;
  const varying = new Set<string>();
  for (const key of new Set(labels.map((l) => l.key))) {
    const seen = new Set(all.map((x) => (x.metric?.labels ?? []).find((l) => l.key === key)?.value));
    if (seen.size > 1) varying.add(key);
  }
  const picked = labels.filter((l) => varying.has(l.key));
  const use = picked.length > 0 ? picked : labels;
  return use.map((l) => `${l.key}=${l.value}`).join(' · ');
}

/** Numeric value of an MQE cell — OAP sends every value as a string, and
 *  `null` means the bucket is absent rather than zero. */
function num(v: string | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function alignSeries(
  result: ExpressionResult,
  step: 'MINUTE' | 'HOUR' | 'DAY',
  fallbackLabel: string,
): AlignedChart {
  const results = result.results ?? [];
  const idSet = new Set<string>();
  for (const r of results) for (const v of r.values ?? []) if (v.id) idSet.add(v.id);
  // Bucket ids are epoch-ms; sort numerically so the axis runs in time order
  // rather than lexically ("9…" would sort after "10…").
  const ids = [...idSet].sort((a, b) => Number(a) - Number(b));
  const xLabels = ids.map((id) => {
    const ms = Number(id);
    return Number.isFinite(ms) ? bucketTimeLabel(step, ms) : id;
  });
  const series = results.map((r) => {
    const byId = new Map((r.values ?? []).map((v) => [v.id ?? '', v.value]));
    return {
      label: seriesLabel(r, results, fallbackLabel),
      data: ids.map((id) => num(byId.get(id))),
    };
  });
  return { xLabels, series, ids };
}
