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
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import { createPinia } from 'pinia';
import { i18n } from '@/i18n';
import CalendarHeatmapWidget from './CalendarHeatmapWidget.vue';
import type { CalendarHeatmapSeries } from './calendarHeatmap';

/** Rendered with a mock series, as the admin canvas does: no read goes out,
 *  and what is asserted is the grid the two layouts draw and the footer. A
 *  render error here is the class the pure tests cannot see — a formatter
 *  option the platform refuses, for instance. */
function draw(mock: CalendarHeatmapSeries, props: Record<string, unknown> = {}) {
  return mount(CalendarHeatmapWidget, {
    props: { title: 'Tokens', layer: 'AI_AGENT', mqe: 'meter_ai_agent_tokens', unit: 'tokens', mock, ...props },
    global: { plugins: [i18n, createPinia(), [VueQueryPlugin, { queryClient: new QueryClient() }]] },
  });
}

describe('CalendarHeatmapWidget', () => {
  it('draws a day window as week rows and weekday columns, with the total and the comparison', () => {
    const w = draw({ resolution: 'day', start: '2026-08-11', values: Array.from({ length: 30 }, (_, i) => (i + 1) * 100_000) }, { compareTo: true });
    expect(w.findAll('.col-label').map((c) => c.text())).toEqual(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
    expect(w.findAll('.row-label').map((r) => r.text())).toEqual(['Aug 11', 'Aug 17', 'Aug 24', 'Aug 31', 'Sep 7']);
    expect(w.findAll('.cell:not(.blank)')).toHaveLength(30);
    expect(w.find('.cell.current').exists()).toBe(true);
    expect(w.find('.window-tag').text()).toContain('by day');
    expect(w.find('footer .total').text()).toContain('Total, last 30 days');
    expect(w.find('footer .compare').text()).toMatch(/^about [\d,.]+ times the text of War and Peace$/);
    // Every cell names its bucket for a keyboard reader; one holds the tab stop.
    expect(w.findAll('.cell[role="button"]')).toHaveLength(30);
    expect(w.findAll('.cell[tabindex="0"]')).toHaveLength(1);
  });

  it('draws an hour window as day rows and 24 hour columns, the hour in progress outlined', () => {
    // 2 days × 24 hours ending at 09:00: three calendar rows, blank outside the window.
    const w = draw({ resolution: 'hour', start: '2026-08-09 10', values: Array.from({ length: 48 }, (_, i) => i + 1) }, { windowDays: 2 });
    expect(w.findAll('.row-label')).toHaveLength(3);
    expect(w.findAll('.col-label')).toHaveLength(24);
    expect(w.findAll('.col-label').map((c) => c.text()).filter(Boolean)).toEqual(['00', '06', '12', '18']);
    expect(w.findAll('.cell:not(.blank)')).toHaveLength(48);
    expect(w.find('.window-tag').text()).toContain('by hour');
    const current = w.find('.cell.current');
    expect(current.attributes('title')).toContain('this hour (incomplete)');
    expect(current.attributes('title')).toMatch(/09:00/);
  });

  it('says so when the window has no data, and averages under avg', () => {
    const empty = draw({ resolution: 'day', start: '2026-08-11', values: [null, null, null] });
    expect(empty.find('.empty').text()).toContain('No data in the last');
    const avg = draw({ resolution: 'hour', start: '2026-08-09 00', values: [10, 20, 30] }, { aggregation: 'avg', windowDays: 7 });
    expect(avg.find('footer .total').text()).toContain('Hourly average');
    expect(avg.find('footer .compare').exists()).toBe(false);
  });

  it('keeps a clicked cell picked and reads its day and value out in the footer', async () => {
    const w = draw({ resolution: 'day', start: '2026-09-07', values: [10, 20, 30] });
    expect(w.find('footer .compare').exists()).toBe(false);
    const cells = w.findAll('.cell:not(.blank)');
    await cells[1]!.trigger('click');
    expect(w.findAll('.cell.picked')).toHaveLength(1);
    expect(w.find('footer .picked-out').text()).toMatch(/Sep 8, 2026 · 20/);
    await cells[1]!.trigger('click');
    expect(w.find('.cell.picked').exists()).toBe(false);
    expect(w.find('footer .picked-out').exists()).toBe(false);
  });
});
