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
import type { DashboardWidget, DashboardWidgetType } from '@skywalking-horizon-ui/api-client';
import { retypeWidget } from './retypeWidget';

/** What the editor shows each type, besides id / title / span / rowSpan. */
const SHOWN: Record<DashboardWidgetType, string[]> = {
  card: ['tip', 'expressions', 'expressionLabels', 'expressionUnits', 'unit', 'format', 'visibleWhen', 'valueMap', 'valueColors'],
  line: ['tip', 'expressions', 'expressionLabels', 'expressionUnits', 'unit', 'format', 'visibleWhen', 'expressionAxes', 'traceDrill'],
  top: ['tip', 'expressions', 'expressionLabels', 'expressionUnits', 'unit', 'format', 'visibleWhen'],
  record: ['tip', 'expressions', 'expressionLabels', 'expressionUnits', 'unit', 'format', 'visibleWhen', 'recordTrace'],
  table: ['tip', 'expressions', 'expressionLabels', 'expressionUnits', 'unit', 'format', 'visibleWhen', 'labelTopN', 'tableHeaders', 'showTableValues'],
  tab: ['expressions', 'tabs'],
};
const TYPES = Object.keys(SHOWN) as DashboardWidgetType[];

/** A widget carrying everything `type` reads, set to non-default values. */
function full(type: DashboardWidgetType): DashboardWidget {
  const all: Record<string, unknown> = {
    tip: 'hint',
    expressions: ['service_cpm', 'service_resp_time'],
    expressionLabels: ['Load', 'Latency'],
    expressionUnits: ['rpm', 'ms'],
    unit: 'rpm',
    format: type === 'card' ? 'enum' : 'int',
    visibleWhen: { kind: 'entity', attribute: 'language', op: 'eq', value: 'JAVA' },
    valueMap: { '1': 'OK' },
    valueColors: { '1': 'ok' },
    expressionAxes: [0, 1],
    traceDrill: { mode: 'latency' },
    recordTrace: { source: 'traceql-otlp' },
    labelTopN: 3,
    tableHeaders: ['Node', 'Ready'],
    showTableValues: false,
    tabs: [{ name: 'Pods', widgets: [{ id: 'p', title: 'Pods', type: 'card', expressions: ['x'] }] }],
  };
  const w: Record<string, unknown> = { id: 'w1', title: 'Widget', type, span: 6, rowSpan: 4 };
  for (const field of SHOWN[type]) w[field] = all[field];
  if (type === 'tab') w.expressions = [];
  return w as unknown as DashboardWidget;
}

describe('retypeWidget — a type change keeps only what the new type reads', () => {
  for (const from of TYPES) {
    for (const to of TYPES) {
      if (from === to) continue;
      it(`${from} → ${to}`, () => {
        const before = full(from);
        const after = retypeWidget(before, to);
        const allowed = new Set(['id', 'title', 'type', 'span', 'rowSpan', ...SHOWN[to]]);
        expect(Object.keys(after).filter((k) => !allowed.has(k))).toEqual([]);
        expect(after).toMatchObject({ id: 'w1', title: 'Widget', type: to, span: 6, rowSpan: 4 });
        // Never the input: the caller decides what to write back.
        expect(before.type).toBe(from);
      });
    }
  }

  it('keeps what both types read, between two leaves', () => {
    const after = retypeWidget(full('line'), 'top');
    expect(after).toMatchObject({
      tip: 'hint',
      expressions: ['service_cpm', 'service_resp_time'],
      expressionLabels: ['Load', 'Latency'],
      expressionUnits: ['rpm', 'ms'],
      unit: 'rpm',
      format: 'int',
      visibleWhen: { kind: 'entity', attribute: 'language', op: 'eq', value: 'JAVA' },
    });
  });

  it('drops the enum format, which only a card reads, and keeps the others', () => {
    expect(retypeWidget(full('card'), 'line').format).toBeUndefined();
    expect(retypeWidget({ ...full('card'), format: 'duration' }, 'line').format).toBe('duration');
  });

  it('drops the trace store, which only a record widget reads', () => {
    expect('recordTrace' in retypeWidget(full('record'), 'table')).toBe(false);
  });

  it('drops a field it does not know, so a newer type-specific field cannot block a push', () => {
    const newer = { ...full('line'), someFutureField: { on: true } } as unknown as DashboardWidget;
    expect('someFutureField' in retypeWidget(newer, 'card')).toBe(false);
  });

  it('drops the sort order the BFF derives', () => {
    expect('topNOrder' in retypeWidget({ ...full('top'), topNOrder: 'asc' }, 'line')).toBe(false);
  });

  it('gives a new tab one empty panel and no expressions, and a former tab one blank expression', () => {
    expect(retypeWidget(full('card'), 'tab')).toMatchObject({ expressions: [], tabs: [{ name: 'Tab 1', widgets: [] }] });
    const leaf = retypeWidget(full('tab'), 'line');
    expect(leaf.expressions).toEqual(['']);
    expect('tabs' in leaf).toBe(false);
  });
});
