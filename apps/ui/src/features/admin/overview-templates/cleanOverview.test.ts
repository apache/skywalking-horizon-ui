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
import type { OverviewDashboard, OverviewWidget } from '@skywalking-horizon-ui/api-client';
import { cleanOverview } from './cleanOverview';

function dash(widgets: OverviewWidget[], extra: Partial<OverviewDashboard> = {}): OverviewDashboard {
  return { id: 'd', title: 'D', widgets, ...extra };
}
const only = (w: OverviewWidget): OverviewWidget => cleanOverview(dash([w])).widgets[0]!;
/** What `v-model.number` stored for a field the operator emptied. */
const emptied = '' as unknown as number;

describe('cleanOverview', () => {
  it('returns a copy and leaves the input alone', () => {
    const input = dash([{ id: 'w', title: 'w', type: 'topology', layer: 'MESH', tip: '' }], { layers: ['MESH'] });
    const before = JSON.stringify(input);
    const out = cleanOverview(input);
    expect(JSON.stringify(input)).toBe(before);
    expect(out).not.toBe(input);
    expect(out.widgets[0]).not.toBe(input.widgets[0]);
  });

  it("drops the dashboard's layers — its widgets name them", () => {
    const out = cleanOverview(dash([{ id: 'w', title: 'w', type: 'topology', layer: 'MESH' }], { layers: ['MESH', 'K8S'] }));
    expect('layers' in out).toBe(false);
  });

  it('keeps the dashboard fields the sidebar reads', () => {
    const out = cleanOverview(dash([], { description: 'Mesh', visibility: 'operate', icon: 'mesh', order: 2 }));
    expect(out).toEqual({ id: 'd', title: 'D', description: 'Mesh', visibility: 'operate', icon: 'mesh', order: 2, widgets: [] });
  });

  it('stores an emptied description and tip as absent', () => {
    const out = cleanOverview(dash([{ id: 'w', title: 'w', type: 'topology', layer: 'MESH', tip: '  ' }], { description: '' }));
    expect('description' in out).toBe(false);
    expect('tip' in out.widgets[0]!).toBe(false);
  });

  it('stores emptied number fields as absent', () => {
    const w = only({
      id: 'w',
      title: 'w',
      type: 'calendar-heatmap',
      layer: 'AI_AGENT',
      mqe: 'm',
      span: emptied,
      rowSpan: 3,
      windowDays: emptied,
    });
    expect(w).toEqual({ id: 'w', title: 'w', type: 'calendar-heatmap', layer: 'AI_AGENT', mqe: 'm', rowSpan: 3 });
    expect('cols' in only({ id: 's', title: 's', type: 'section-break', cols: emptied })).toBe(false);
    expect('limit' in only({ id: 'a', title: 'a', type: 'alarms', limit: emptied })).toBe(false);
  });

  it('keeps the limit that alarms and ranking widgets read', () => {
    expect(only({ id: 'a', title: 'a', type: 'alarms', limit: 20 }).limit).toBe(20);
    expect(only({ id: 'r', title: 'r', type: 'ranking', layer: 'GENERAL', mqe: 'm', limit: 15 }).limit).toBe(15);
  });

  it("drops a metric widget's KPI rows", () => {
    const w = only({ id: 'm', title: 'm', type: 'metric', layer: 'GENERAL', mqe: 'x', kpis: [{ label: 'a', mqe: 'y' }] });
    expect('kpis' in w).toBe(false);
  });

  it('drops what only page-side reads from a server-side widget', () => {
    const metric = only({
      id: 'm',
      title: 'm',
      type: 'metric',
      layer: 'GENERAL',
      mqe: 'x',
      aggregateOnPage: false,
      aggregation: 'sum',
      limit: 3,
      rankBy: { mqe: 'y' },
    });
    expect(metric).toEqual({ id: 'm', title: 'm', type: 'metric', layer: 'GENERAL', mqe: 'x' });

    const tile = only({
      id: 't',
      title: 't',
      type: 'kpi-tile',
      layer: 'GENERAL',
      limit: 3,
      rankBy: { kpi: 1 },
      kpis: [
        { label: 'a', mqe: 'x', rangeTotal: true },
        { label: 'b', mqe: 'y' },
      ],
    });
    expect(tile).toEqual({
      id: 't',
      title: 't',
      type: 'kpi-tile',
      layer: 'GENERAL',
      kpis: [
        { label: 'a', mqe: 'x' },
        { label: 'b', mqe: 'y' },
      ],
    });
  });

  it('keeps what a page-side widget reads', () => {
    const w: OverviewWidget = {
      id: 'p',
      title: 'p',
      type: 'metric-composite',
      layer: 'MESH_CP',
      aggregateOnPage: true,
      limit: 5,
      rankBy: { kpi: 1 },
      kpis: [
        { label: 'a', mqe: 'x', aggregation: 'sum', rangeTotal: true },
        { label: 'b', mqe: 'y' },
        { label: 'n', source: 'service-count' },
      ],
    };
    expect(only(w)).toEqual(w);
    const metric: OverviewWidget = { id: 'm', title: 'm', type: 'metric', layer: 'GENERAL', mqe: 'x', aggregateOnPage: true, aggregation: 'sum', limit: 3 };
    expect(only(metric)).toEqual(metric);
  });

  it('drops a rankBy the renderer cannot honour, or that only restates the default', () => {
    const base: OverviewWidget = {
      id: 'p',
      title: 'p',
      type: 'kpi-tile',
      layer: 'MESH_CP',
      aggregateOnPage: true,
      kpis: [
        { label: 'n', source: 'service-count' },
        { label: 'a', mqe: 'x' },
        { label: 'b', mqe: 'y' },
      ],
    };
    expect('rankBy' in only({ ...base, rankBy: { kpi: 0 } })).toBe(false);
    expect('rankBy' in only({ ...base, rankBy: { kpi: 1 } })).toBe(false);
    expect('rankBy' in only({ ...base, rankBy: { kpi: 7 } })).toBe(false);
    expect(only({ ...base, rankBy: { kpi: 2 } }).rankBy).toEqual({ kpi: 2 });
    expect(only({ ...base, rankBy: { kpi: 2, mqe: 'z' } }).rankBy).toEqual({ mqe: 'z' });
  });

  it('drops a rankBy on a widget type that has no ranking choice', () => {
    const w = only({ id: 'r', title: 'r', type: 'ranking', layer: 'GENERAL', mqe: 'm', rankBy: { mqe: 'other' } });
    expect('rankBy' in w).toBe(false);
  });

  it("drops a service-count KPI's MQE and range total", () => {
    const w = only({
      id: 't',
      title: 't',
      type: 'metric-composite',
      layer: 'K8S',
      aggregateOnPage: true,
      kpis: [{ label: 'n', source: 'service-count', mqe: 'stale', rangeTotal: true, unit: '' }],
    });
    expect(w.kpis).toEqual([{ label: 'n', source: 'service-count', unit: '' }]);
  });

  it("drops max off a KPI that is not a progress bar, and gives a progress bar one", () => {
    const w = only({
      id: 't',
      title: 't',
      type: 'metric-composite',
      layer: 'K8S',
      kpis: [
        { label: 'cpu', mqe: 'x', unit: '%', max: 1 },
        { label: 'sla', mqe: 'y', style: 'progress-bar', max: emptied },
        { label: 'mem', mqe: 'z', style: 'progress-bar', max: 64 },
      ],
    });
    expect(w.kpis).toEqual([
      { label: 'cpu', mqe: 'x', unit: '%' },
      { label: 'sla', mqe: 'y', style: 'progress-bar', max: 100 },
      { label: 'mem', mqe: 'z', style: 'progress-bar', max: 64 },
    ]);
  });

  it('leaves work in progress the push accepts', () => {
    const tile: OverviewWidget = {
      id: 't',
      title: '',
      type: 'kpi-tile',
      layer: 'GENERAL',
      aggregateOnPage: true,
      rankBy: { mqe: '' },
      kpis: [{ label: 'new KPI', mqe: '' }],
    };
    expect(only(tile)).toEqual(tile);
    const empty: OverviewWidget = { id: 'e', title: 'e', type: 'metric-composite', layer: 'K8S', kpis: [] };
    expect(only(empty)).toEqual(empty);
  });

  it('is idempotent', () => {
    const d = dash(
      [
        { id: 'm', title: 'm', type: 'metric', layer: 'GENERAL', mqe: 'x', kpis: [{ label: 'a', mqe: 'y' }], span: emptied },
        { id: 'p', title: 'p', type: 'kpi-tile', layer: 'GENERAL', aggregateOnPage: true, rankBy: { kpi: 1 }, kpis: [{ label: 'a', mqe: 'x' }, { label: 'b', mqe: 'y' }] },
      ],
      { layers: ['GENERAL'], description: '' },
    );
    const once = cleanOverview(d);
    expect(cleanOverview(once)).toEqual(once);
  });
});
