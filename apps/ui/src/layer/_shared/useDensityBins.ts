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
 * Pure binning for the Loki/Datadog-style density histogram: buckets a
 * list of rows into `bins` (default 60) time buckets between the rows'
 * min/max timestamp, counting each row into its category lane. Feeds
 * `DensityHistogram`. Feature-agnostic — the host supplies the timestamp
 * accessor, the ordered category keys, and the per-row classifier, so
 * both the Logs (level) and Browser Logs (category) tabs use it.
 */

import { computed, type ComputedRef, type Ref } from 'vue';

export interface DensityBins<K extends string> {
  bins: Array<Record<K, number>>;
  max: number;
  t0: number;
  t1: number;
}

export function useDensityBins<T, K extends string>(
  rows: Ref<readonly T[]> | ComputedRef<readonly T[]>,
  opts: {
    keys: readonly K[];
    timeOf: (row: T) => number;
    keyOf: (row: T) => K;
    bins?: number;
  },
): ComputedRef<DensityBins<K>> {
  const BINS = opts.bins ?? 60;
  const empty = (): Record<K, number> => {
    const o = {} as Record<K, number>;
    for (const k of opts.keys) o[k] = 0;
    return o;
  };
  return computed<DensityBins<K>>(() => {
    const list = rows.value;
    if (list.length === 0) return { bins: [], max: 0, t0: 0, t1: 0 };
    let t0 = Infinity;
    let t1 = -Infinity;
    for (const r of list) {
      const ts = opts.timeOf(r);
      if (ts < t0) t0 = ts;
      if (ts > t1) t1 = ts;
    }
    if (!Number.isFinite(t0) || !Number.isFinite(t1) || t0 === t1) {
      t0 = (t1 || Date.now()) - 60_000;
      t1 = t1 || Date.now();
    }
    const span = t1 - t0 || 1;
    const bins: Array<Record<K, number>> = Array.from({ length: BINS }, empty);
    for (const r of list) {
      const idx = Math.min(BINS - 1, Math.floor(((opts.timeOf(r) - t0) / span) * BINS));
      bins[idx][opts.keyOf(r)] += 1;
    }
    let max = 0;
    for (const b of bins) {
      let total = 0;
      for (const k of opts.keys) total += b[k];
      if (total > max) max = total;
    }
    return { bins, max, t0, t1 };
  });
}
