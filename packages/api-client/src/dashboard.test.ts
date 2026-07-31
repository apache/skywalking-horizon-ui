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
import {
  collectWidgetIds,
  findWidgetById,
  walkWidgets,
  type DashboardWidget,
} from './dashboard.js';

const leaf = (id: string, extra: Partial<DashboardWidget> = {}): DashboardWidget => ({
  id,
  title: id,
  type: 'line',
  expressions: [`${id}_expr`],
  ...extra,
});

// A container plus two panels — the shape the widget editor and the compare
// engine both have to see through.
const tree: DashboardWidget[] = [
  leaf('cpu', { type: 'card' }),
  {
    id: 'pods',
    title: 'Pods',
    type: 'tab',
    expressions: [],
    tabs: [
      { name: 'Running', widgets: [leaf('pods_running'), leaf('pods_top', { type: 'top' })] },
      { name: 'Pending', widgets: [leaf('pods_pending')] },
    ],
  },
  leaf('mem'),
];

describe('walkWidgets — one traversal that sees inside tab panels', () => {
  it('yields top-level widgets, the tab container itself, and every panel child', () => {
    expect([...walkWidgets(tree)].map((w) => w.id)).toEqual([
      'cpu',
      'pods',
      'pods_running',
      'pods_top',
      'pods_pending',
      'mem',
    ]);
  });

  it('tolerates an undefined list and a tab container with no panels', () => {
    expect([...walkWidgets(undefined)]).toEqual([]);
    expect([
      ...walkWidgets([{ id: 't', title: 'T', type: 'tab', expressions: [] }]),
    ]).toHaveLength(1);
  });
});

describe('findWidgetById', () => {
  it('finds a widget nested in a tab panel, not just top-level ones', () => {
    // The compare engine reads `topNOrder` off the found widget; missing a
    // tabbed widget silently flips its sort direction back to the default.
    expect(findWidgetById(tree, 'pods_top')?.type).toBe('top');
    expect(findWidgetById(tree, 'mem')?.title).toBe('mem');
  });

  it('returns undefined for an unknown id and for an empty tree', () => {
    expect(findWidgetById(tree, 'nope')).toBeUndefined();
    expect(findWidgetById(undefined, 'cpu')).toBeUndefined();
  });
});

describe('collectWidgetIds — the id-uniqueness source for the widget editor', () => {
  it('includes tab-panel children so a duplicate id inside a tab is still caught', () => {
    expect([...collectWidgetIds(tree)].sort()).toEqual([
      'cpu',
      'mem',
      'pods',
      'pods_pending',
      'pods_running',
      'pods_top',
    ]);
  });

  it('accumulates across several scope lists into one set', () => {
    const seen = collectWidgetIds([leaf('shared')]);
    collectWidgetIds(tree, seen);
    expect(seen.has('shared')).toBe(true);
    expect(seen.has('pods_running')).toBe(true);
    expect(seen.size).toBe(7);
  });
});
