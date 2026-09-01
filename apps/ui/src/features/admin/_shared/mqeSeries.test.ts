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

import { describe, it, expect } from 'vitest';
import type { ExpressionResult } from '@skywalking-horizon-ui/api-client';
import { alignSeries, seriesLabel } from './mqeSeries';

function series(labels: Array<[string, string]>, values: Array<[string, string | null]>) {
  return {
    metric: { labels: labels.map(([key, value]) => ({ key, value })) },
    values: values.map(([id, value]) => ({ id, value })),
  };
}
const res = (results: ReturnType<typeof series>[]): ExpressionResult => ({
  type: 'TIME_SERIES_VALUES',
  results,
});

describe('alignSeries', () => {
  it('aligns on the UNION of bucket ids, not on array index', () => {
    // p=50 is missing the middle bucket. Aligned by index, its 1200 sample
    // would slide under 1100 and the chart would be wrong rather than sparse.
    const out = alignSeries(
      res([
        series([['p', '50']], [['1000', '1'], ['1200', '3']]),
        series([['p', '95']], [['1000', '9'], ['1100', '8'], ['1200', '7']]),
      ]),
      'MINUTE',
      'value',
    );
    expect(out.ids).toEqual(['1000', '1100', '1200']);
    expect(out.series[0]!.data).toEqual([1, null, 3]);
    expect(out.series[1]!.data).toEqual([9, 8, 7]);
  });

  it('gives every series the same length as xLabels — TimeChart ignores them otherwise', () => {
    const out = alignSeries(
      res([
        series([['p', '50']], [['1000', '1']]),
        series([['p', '95']], [['1000', '9'], ['1100', '8']]),
      ]),
      'MINUTE',
      'value',
    );
    for (const s of out.series) expect(s.data).toHaveLength(out.xLabels.length);
  });

  it('sorts buckets numerically, not lexically', () => {
    const out = alignSeries(
      res([series([], [['1100', '2'], ['900', '1'], ['1000', '3']])]),
      'MINUTE',
      'value',
    );
    expect(out.ids).toEqual(['900', '1000', '1100']);
    expect(out.series[0]!.data).toEqual([1, 3, 2]);
  });

  it('keeps a null value as a gap rather than a zero', () => {
    const out = alignSeries(res([series([], [['1000', null], ['1100', '5']])]), 'MINUTE', 'value');
    expect(out.series[0]!.data).toEqual([null, 5]);
  });

  it('falls back to the caller label when the metric carries none', () => {
    const out = alignSeries(res([series([], [['1000', '1']])]), 'MINUTE', 'value');
    expect(out.series[0]!.label).toBe('value');
  });

  it('is empty for a result with no rows', () => {
    const out = alignSeries({ type: 'TIME_SERIES_VALUES', results: [] }, 'MINUTE', 'value');
    expect(out.ids).toEqual([]);
    expect(out.series).toEqual([]);
  });
});

describe('seriesLabel', () => {
  it('names a series by the label that VARIES across the set', () => {
    // `status` is constant, so naming off it would make three legend chips
    // that differ only in the percentile buried at the end.
    const all = [
      series([['p', '50'], ['status', 'all']], []),
      series([['p', '95'], ['status', 'all']], []),
    ];
    expect(seriesLabel(all[0]!, all, 'value')).toBe('p=50');
    expect(seriesLabel(all[1]!, all, 'value')).toBe('p=95');
  });

  it('keeps every label when none of them vary — a lone labelled series', () => {
    const all = [series([['p', '95'], ['status', 'all']], [])];
    expect(seriesLabel(all[0]!, all, 'value')).toBe('p=95 · status=all');
  });

  it('joins several varying labels', () => {
    const all = [
      series([['a', '1'], ['b', 'x']], []),
      series([['a', '2'], ['b', 'y']], []),
    ];
    expect(seriesLabel(all[0]!, all, 'value')).toBe('a=1 · b=x');
  });
});
