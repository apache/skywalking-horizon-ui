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
import type { OverviewKpi, OverviewWidget } from '@skywalking-horizon-ui/api-client';
import {
  fitMaxToStyle,
  moveKpi,
  normalRankBy,
  removeKpi,
  setAggregateOnPage,
  setKpiSource,
  setOptionalNumber,
  setOptionalText,
} from './widgetEdits';

const mqe = (label: string): OverviewKpi => ({ label, mqe: `m_${label}` });
const count = (label: string): OverviewKpi => ({ label, source: 'service-count' });

function composite(kpis: OverviewKpi[], rankBy?: OverviewWidget['rankBy']): OverviewWidget {
  return {
    id: 'w',
    title: 'w',
    type: 'metric-composite',
    layer: 'MESH_CP',
    aggregateOnPage: true,
    limit: 5,
    kpis,
    ...(rankBy ? { rankBy } : {}),
  };
}
const labels = (w: OverviewWidget): string[] => (w.kpis ?? []).map((k) => k.label);

describe('normalRankBy', () => {
  it('keeps an index naming an mqe row other than the first', () => {
    expect(normalRankBy({ kpi: 1 }, [mqe('a'), mqe('b')])).toEqual({ kpi: 1 });
  });

  it('stores the first mqe row as absent, the default it already is', () => {
    expect(normalRankBy({ kpi: 0 }, [mqe('a'), mqe('b')])).toBeUndefined();
    expect(normalRankBy({ kpi: 1 }, [count('n'), mqe('a'), mqe('b')])).toBeUndefined();
  });

  it('drops an index the renderer cannot rank by', () => {
    expect(normalRankBy({ kpi: 2 }, [mqe('a'), mqe('b')])).toBeUndefined();
    expect(normalRankBy({ kpi: 1 }, [mqe('a'), count('n')])).toBeUndefined();
    expect(normalRankBy({ kpi: 0 }, undefined)).toBeUndefined();
  });

  it('keeps a separate ranking MQE, even an empty one, and only that', () => {
    expect(normalRankBy({ mqe: 'service_cpm', kpi: 1 }, [mqe('a'), mqe('b')])).toEqual({ mqe: 'service_cpm' });
    expect(normalRankBy({ mqe: '' }, [mqe('a')])).toEqual({ mqe: '' });
  });
});

describe('moving a KPI row', () => {
  it('carries an explicit rankBy with the row it names', () => {
    const w = composite([mqe('a'), mqe('b'), mqe('c')], { kpi: 2 });
    moveKpi(w, 2, -1);
    expect(labels(w)).toEqual(['a', 'c', 'b']);
    expect(w.rankBy).toEqual({ kpi: 1 });
  });

  it('carries it when the neighbour is the one that moves', () => {
    const w = composite([mqe('a'), mqe('b'), mqe('c')], { kpi: 2 });
    moveKpi(w, 1, 1);
    expect(labels(w)).toEqual(['a', 'c', 'b']);
    expect(w.rankBy).toEqual({ kpi: 1 });
  });

  it('stores absent once the ranked row becomes the first mqe row', () => {
    const w = composite([mqe('a'), mqe('b')], { kpi: 1 });
    moveKpi(w, 1, -1);
    expect(labels(w)).toEqual(['b', 'a']);
    expect(w.rankBy).toBeUndefined();
    expect('rankBy' in w).toBe(false);
  });

  it('pins the ranked row when another row takes the first place', () => {
    const w = composite([mqe('a'), mqe('b'), mqe('c')], { kpi: 1 });
    moveKpi(w, 2, -1);
    moveKpi(w, 1, -1);
    expect(labels(w)).toEqual(['c', 'a', 'b']);
    expect(w.rankBy).toEqual({ kpi: 2 });
  });

  it('leaves a separate ranking MQE alone and ignores a move off either end', () => {
    const w = composite([mqe('a'), mqe('b')], { mqe: 'service_cpm' });
    moveKpi(w, 0, -1);
    moveKpi(w, 1, 1);
    expect(labels(w)).toEqual(['a', 'b']);
    moveKpi(w, 0, 1);
    expect(labels(w)).toEqual(['b', 'a']);
    expect(w.rankBy).toEqual({ mqe: 'service_cpm' });
  });
});

describe('removing a KPI row', () => {
  it('drops a rankBy that named the removed row', () => {
    const w = composite([mqe('a'), mqe('b'), mqe('c')], { kpi: 1 });
    removeKpi(w, 1);
    expect(labels(w)).toEqual(['a', 'c']);
    expect(w.rankBy).toBeUndefined();
  });

  it('shifts a rankBy that named a later row', () => {
    const w = composite([mqe('a'), mqe('b'), mqe('c')], { kpi: 2 });
    removeKpi(w, 1);
    expect(w.rankBy).toEqual({ kpi: 1 });
  });

  it('leaves a rankBy that named an earlier row', () => {
    const w = composite([mqe('a'), mqe('b'), mqe('c')], { kpi: 1 });
    removeKpi(w, 2);
    expect(w.rankBy).toEqual({ kpi: 1 });
  });

  it('keeps a separate ranking MQE when the row its stale index named goes', () => {
    const w = composite([mqe('a'), mqe('b')], { kpi: 1, mqe: 'service_cpm' });
    removeKpi(w, 1);
    expect(w.rankBy).toEqual({ mqe: 'service_cpm' });
  });
});

describe('the ranked row keeps ranking through row edits', () => {
  it('moving the ranked row through first place and back', () => {
    const w = composite([mqe('A'), mqe('B')], { kpi: 1 });
    moveKpi(w, 1, -1);
    expect(w.rankBy).toBeUndefined();
    moveKpi(w, 0, 1);
    expect(labels(w)).toEqual(['A', 'B']);
    expect(w.rankBy).toEqual({ kpi: 1 });
  });

  it('a default-ranked first row keeps ranking when another row moves above it', () => {
    const w = composite([mqe('A'), mqe('B')]);
    moveKpi(w, 1, -1);
    expect(labels(w)).toEqual(['B', 'A']);
    expect(w.rankBy).toEqual({ kpi: 1 });
  });

  it('a row turned into an mqe row ahead of the ranked one does not take over', () => {
    const w = composite([count('C'), mqe('A'), mqe('B')]);
    setKpiSource(w, 0, undefined);
    expect(w.rankBy).toEqual({ kpi: 1 });
  });

  it('a server-side widget, which does not rank, gains no rankBy', () => {
    const w = composite([mqe('A'), mqe('B')]);
    delete w.aggregateOnPage;
    moveKpi(w, 1, -1);
    expect('rankBy' in w).toBe(false);
  });
});

describe("switching a KPI's source", () => {
  it('to service-count drops its MQE, its range total and a rankBy naming it', () => {
    const w = composite([mqe('a'), { label: 'b', mqe: 'm_b', rangeTotal: true }], { kpi: 1 });
    setKpiSource(w, 1, 'service-count');
    expect(w.kpis?.[1]).toEqual({ label: 'b', source: 'service-count' });
    expect(w.rankBy).toBeUndefined();
  });

  it('to service-count keeps a rankBy naming another row', () => {
    const w = composite([mqe('a'), mqe('b'), mqe('c')], { kpi: 2 });
    setKpiSource(w, 1, 'service-count');
    expect(w.rankBy).toEqual({ kpi: 2 });
  });

  it('back to mqe starts from an empty expression, as a new row does', () => {
    const w = composite([mqe('a'), count('n')]);
    setKpiSource(w, 1, 'mqe');
    expect(w.kpis?.[1]).toEqual({ label: 'n', mqe: '' });
  });

  it('to the source it already has changes nothing', () => {
    const w = composite([mqe('a')]);
    setKpiSource(w, 0, 'mqe');
    expect(w.kpis?.[0]).toEqual(mqe('a'));
  });
});

describe('fitMaxToStyle', () => {
  it('drops max off a number KPI', () => {
    const k: OverviewKpi = { label: 'cpu', mqe: 'm', unit: '%', style: 'number', max: 1 };
    fitMaxToStyle(k);
    expect('max' in k).toBe(false);
  });

  it('seeds the default on a progress bar with none, and keeps one that is set', () => {
    const seeded: OverviewKpi = { label: 'sla', mqe: 'm', style: 'progress-bar' };
    fitMaxToStyle(seeded);
    expect(seeded.max).toBe(100);
    const kept: OverviewKpi = { label: 'sla', mqe: 'm', style: 'progress-bar', max: 5 };
    fitMaxToStyle(kept);
    expect(kept.max).toBe(5);
  });
});

describe('setAggregateOnPage', () => {
  it('back to server-side drops what only page-side reads, and stores the mode absent', () => {
    const w = composite([{ label: 'a', mqe: 'm', rangeTotal: true, aggregation: 'sum' }], { kpi: 0 });
    setAggregateOnPage(w, false);
    expect(w).toEqual({
      id: 'w',
      title: 'w',
      type: 'metric-composite',
      layer: 'MESH_CP',
      kpis: [{ label: 'a', mqe: 'm', aggregation: 'sum' }],
    });
  });

  it("drops a metric widget's page-side rollup", () => {
    const w: OverviewWidget = { id: 'm', title: 'm', type: 'metric', mqe: 'service_cpm', aggregateOnPage: true, aggregation: 'sum', limit: 3 };
    setAggregateOnPage(w, false);
    expect(w).toEqual({ id: 'm', title: 'm', type: 'metric', mqe: 'service_cpm' });
  });

  it('to page-side stores it', () => {
    const w: OverviewWidget = { id: 'm', title: 'm', type: 'metric', mqe: 'service_cpm' };
    setAggregateOnPage(w, true);
    expect(w.aggregateOnPage).toBe(true);
  });
});

describe('emptied fields', () => {
  it('an emptied number field is absent; a number is stored as one', () => {
    const w: OverviewWidget = { id: 'w', title: 'w', type: 'alarms', limit: 10 };
    setOptionalNumber(w, 'limit', '');
    expect('limit' in w).toBe(false);
    setOptionalNumber(w, 'limit', '25');
    expect(w.limit).toBe(25);
    setOptionalNumber(w, 'limit', '  ');
    expect('limit' in w).toBe(false);
  });

  it('an emptied optional text field is absent', () => {
    const w: OverviewWidget = { id: 'w', title: 'w', type: 'topology', tip: 'hint' };
    setOptionalText(w, 'tip', '');
    expect('tip' in w).toBe(false);
    setOptionalText(w, 'tip', 'again');
    expect(w.tip).toBe('again');
  });
});
