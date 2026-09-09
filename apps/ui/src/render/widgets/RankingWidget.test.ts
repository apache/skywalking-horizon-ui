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

import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { i18n } from '@/i18n';
import RankingWidget from './RankingWidget.vue';
import { rankingLayout, type RankingRow } from './ranking';

function rows(n: number): RankingRow[] {
  return Array.from({ length: n }, (_, i) => ({ serviceId: `s${i}`, name: `runtime-${i + 1}`, value: (n - i) * 1000 }));
}

function draw(props: Record<string, unknown>) {
  return mount(RankingWidget, { props: { title: 'Top ten runtimes', unit: 'tokens', ...props }, global: { plugins: [i18n] } });
}

describe('rankingLayout', () => {
  it('runs a list past five rows in at least two columns, and in more when the height calls for it', () => {
    expect([1, 5, 6, 10].map((n) => rankingLayout(n, 10).columns)).toEqual([1, 1, 2, 2]);
    expect(rankingLayout(20, 10)).toEqual({ columns: 2, perColumn: 10 });
    expect(rankingLayout(20, 9)).toEqual({ columns: 3, perColumn: 7 });
    expect(rankingLayout(7, 10)).toEqual({ columns: 2, perColumn: 4 });
    expect(rankingLayout(40, 5).columns).toBe(4);
    expect(rankingLayout(0, 10)).toEqual({ columns: 1, perColumn: 0 });
  });
});

describe('RankingWidget', () => {
  it('lists ten rows busiest first in two columns of five, the bar against the top value', () => {
    const w = draw({ rows: rows(10), total: 10 });
    const list = w.find('.list');
    expect(list.attributes('style')).toContain('--cols: 2');
    expect(list.attributes('style')).toContain('--per: 5');
    expect(w.findAll('.rank').map((r) => r.text())).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10']);
    expect(w.findAll('.name')[0]!.text()).toBe('runtime-1');
    expect(w.findAll('.fill')[0]!.attributes('style')).toContain('width: 100%');
    expect(w.findAll('.fill')[9]!.attributes('style')).toContain('width: 10%');
    expect(w.find('.note').exists()).toBe(false);
  });

  it('keeps a short list in one column and says when the layer has more services than it lists', () => {
    const w = draw({ rows: rows(3), total: 12 });
    expect(w.find('.list').attributes('style')).toContain('--cols: 1');
    expect(w.find('.note').text()).toBe('The 3 busiest of 12 services.');
  });

  it('says it is reading before the first answer, that the read failed, and when nothing reported', () => {
    expect(draw({}).find('.empty').text()).toBe('Reading data…');
    expect(draw({ failed: true }).find('.empty').text()).toBe('Could not read Top ten runtimes.');
    expect(draw({ rows: [], total: 0 }).find('.empty').text()).toBe('No services reported in this range.');
  });
});
