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
 * Changing a widget's type keeps only what the new type reads. The editor
 * shows a field only on the types that read it, so a field left over from the
 * old type would be stored where nobody can see or clear it — and a push rule
 * holding that field to its own type then refuses the whole layer.
 */

import type { DashboardWidget, DashboardWidgetType } from '@skywalking-horizon-ui/api-client';

const LEAF: readonly DashboardWidgetType[] = ['card', 'line', 'top', 'record', 'table'];

/**
 * Which types read each field. Total over `DashboardWidget`, so a field cannot
 * be added to the widget without saying which types own it. `derived` is
 * filled in by the BFF when it resolves a template, and is never authored.
 */
const READ_BY: { [K in keyof Required<DashboardWidget>]: 'all' | 'derived' | readonly DashboardWidgetType[] } = {
  id: 'all',
  title: 'all',
  type: 'all',
  span: 'all',
  rowSpan: 'all',
  x: 'all',
  y: 'all',
  w: 'all',
  h: 'all',
  expressions: LEAF,
  tip: LEAF,
  expressionLabels: LEAF,
  expressionUnits: LEAF,
  unit: LEAF,
  format: LEAF,
  visibleWhen: LEAF,
  valueMap: ['card'],
  valueColors: ['card'],
  expressionAxes: ['line'],
  traceDrill: ['line'],
  recordTrace: ['record'],
  labelTopN: ['table'],
  tableHeaders: ['table'],
  showTableValues: ['table'],
  tabs: ['tab'],
  topNOrder: 'derived',
};

/** `widget` as a `type` widget: its own copy, holding only what `type` reads. */
export function retypeWidget(widget: DashboardWidget, type: DashboardWidgetType): DashboardWidget {
  const next: Record<string, unknown> = {};
  for (const [field, readBy] of Object.entries(READ_BY)) {
    if (!(field in widget)) continue;
    if (readBy === 'all' || (readBy !== 'derived' && readBy.includes(type))) {
      next[field] = (widget as unknown as Record<string, unknown>)[field];
    }
  }
  const out = { ...next, type } as DashboardWidget;
  if (type === 'tab') {
    out.expressions = [];
    if (!out.tabs?.length) out.tabs = [{ name: 'Tab 1', widgets: [] }];
  } else {
    if (!out.expressions?.length) out.expressions = [''];
    // Of the formats, only `enum` is a card's own: it reads `valueMap`.
    if (out.format === 'enum' && type !== 'card') delete out.format;
  }
  return out;
}
