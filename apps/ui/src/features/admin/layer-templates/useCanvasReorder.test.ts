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
 * The three drops the canvas distinguishes, and the selection each leaves
 * behind.
 *
 * The composable was lifted out of the widget editor unchanged, which is
 * exactly the state in which a later edit can shift one of these without
 * anyone noticing: all three end with a widget on screen, and only WHERE
 * it ended up says which branch ran. A browser cannot help much either —
 * HTML5 drag is the one gesture Playwright's synthetic events do not
 * produce.
 */

import { describe, it, expect } from 'vitest';
import { ref, computed } from 'vue';
import type { DashboardWidget } from '@skywalking-horizon-ui/api-client';
import { useCanvasReorder } from './useCanvasReorder';

const leaf = (id: string): DashboardWidget =>
  ({ id, type: 'line', title: id, expressions: ['x'] }) as DashboardWidget;

const tab = (id: string, panels: Array<{ name: string; widgets: DashboardWidget[] }>): DashboardWidget =>
  ({ id, type: 'tab', title: id, tabs: panels }) as DashboardWidget;

/** A canvas over `initial`, with the deps the composable actually reads. */
function harness(initial: DashboardWidget[], activeTab = 0) {
  const widgets = ref<DashboardWidget[]>(initial);
  const selectedIdx = ref<number | null>(null);
  const subSel = ref<{ widgetId: string; tabIdx: number; subIdx: number } | null>(null);
  const api = useCanvasReorder({
    currentWidgets: computed(() => widgets.value),
    readWidgets: () => widgets.value,
    setWidgets: (w) => (widgets.value = w),
    selectedIdx,
    subSel,
    selectSub: (widgetId, tabIdx, subIdx) => (subSel.value = { widgetId, tabIdx, subIdx }),
    activeTabOf: () => activeTab,
  });
  return { api, widgets, selectedIdx, subSel };
}

/** A drag event with only what the handlers touch. */
const evt = (): DragEvent =>
  ({
    preventDefault: () => {},
    dataTransfer: { effectAllowed: '', dropEffect: '', setData: () => {} },
  }) as unknown as DragEvent;

const ids = (w: DashboardWidget[]) => w.map((x) => x.id);

describe('dropping a leaf on another leaf', () => {
  it('reorders, and the dragged widget stays selected at its new index', () => {
    const { api, widgets, selectedIdx } = harness([leaf('a'), leaf('b'), leaf('c')]);
    api.onReorderStart(evt(), 0);
    api.onReorderDrop(evt(), 2);
    expect(ids(widgets.value)).toEqual(['b', 'c', 'a']);
    expect(selectedIdx.value).toBe(2);
  });

  it('does nothing when dropped on itself', () => {
    const { api, widgets } = harness([leaf('a'), leaf('b')]);
    api.onReorderStart(evt(), 1);
    api.onReorderDrop(evt(), 1);
    expect(ids(widgets.value)).toEqual(['a', 'b']);
  });
});

describe('dropping a leaf on a tab container', () => {
  it("moves it INTO the tab's active panel and off the grid", () => {
    const { api, widgets, selectedIdx } = harness(
      [leaf('a'), tab('t', [{ name: 'One', widgets: [] }, { name: 'Two', widgets: [] }])],
      1,
    );
    api.onReorderStart(evt(), 0);
    api.onReorderDrop(evt(), 1);
    expect(ids(widgets.value)).toEqual(['t']);
    // The ACTIVE panel, not the first — dropping into a tab the operator is
    // not looking at would put the widget somewhere they cannot see.
    expect(ids(widgets.value[0].tabs![1].widgets)).toEqual(['a']);
    expect(ids(widgets.value[0].tabs![0].widgets)).toEqual([]);
    expect(selectedIdx.value).toBe(0);
  });

  it('gives a tab with no panels one to receive the drop', () => {
    const { api, widgets } = harness([leaf('a'), tab('t', [])]);
    api.onReorderStart(evt(), 0);
    api.onReorderDrop(evt(), 1);
    expect(widgets.value[0].tabs).toHaveLength(1);
    expect(ids(widgets.value[0].tabs![0].widgets)).toEqual(['a']);
  });

  it('reorders rather than nests when a tab is dragged onto a tab', () => {
    // Nesting a tab container inside another is not a shape the renderer
    // supports, so this branch must fall through to a plain reorder.
    const { api, widgets } = harness([tab('t1', []), tab('t2', [])]);
    api.onReorderStart(evt(), 0);
    api.onReorderDrop(evt(), 1);
    expect(ids(widgets.value)).toEqual(['t2', 't1']);
    expect(widgets.value[0].tabs).toEqual([]);
  });
});

describe('dragging a widget out of a tab', () => {
  const nested = () => [leaf('a'), tab('t', [{ name: 'One', widgets: [leaf('inner')] }])];

  it('lands at the end of the grid when dropped on the canvas', () => {
    const { api, widgets, selectedIdx, subSel } = harness(nested());
    api.onSubReorderStart(evt(), 't', 0, 0);
    expect(subSel.value).toEqual({ widgetId: 't', tabIdx: 0, subIdx: 0 });
    api.onCanvasDrop(evt());
    expect(ids(widgets.value)).toEqual(['a', 't', 'inner']);
    expect(ids(widgets.value[1].tabs![0].widgets)).toEqual([]);
    // Selection follows the widget out — it is the one the operator just
    // moved, and it is no longer where the sub-selection pointed.
    expect(subSel.value).toBeNull();
    expect(selectedIdx.value).toBe(2);
  });

  it('lands at the drop position when dropped on a top-level widget', () => {
    const { api, widgets, selectedIdx } = harness(nested());
    api.onSubReorderStart(evt(), 't', 0, 0);
    api.onReorderDrop(evt(), 0);
    expect(ids(widgets.value)).toEqual(['inner', 'a', 't']);
    expect(selectedIdx.value).toBe(0);
  });

  it('ignores a canvas drop when nothing is being dragged out of a tab', () => {
    // The canvas background also receives drops from a plain grid reorder,
    // which it must leave to the widget handlers.
    const { api, widgets } = harness([leaf('a'), leaf('b')]);
    api.onReorderStart(evt(), 0);
    api.onCanvasDrop(evt());
    expect(ids(widgets.value)).toEqual(['a', 'b']);
  });
});

describe('the drag session', () => {
  it('tracks the hover target without mutating anything', () => {
    const { api, widgets } = harness([leaf('a'), leaf('b'), leaf('c')]);
    api.onReorderStart(evt(), 0);
    api.onReorderOver(evt(), 2);
    expect(api.reorder.over).toBe(2);
    expect(api.reorder.from).toBe(0);
    // The marker is a preview: the order is unchanged until the drop.
    expect(ids(widgets.value)).toEqual(['a', 'b', 'c']);
  });

  it('clears on end, so an abandoned drag leaves no armed session', () => {
    const { api } = harness([leaf('a'), leaf('b')]);
    api.onReorderStart(evt(), 0);
    api.onReorderEnd();
    expect(api.reorder.active).toBe(false);
    expect(api.reorder.from).toBe(-1);
    expect(api.reorder.sub).toBeNull();
  });

  it('ignores a drop that no drag started', () => {
    const { api, widgets } = harness([leaf('a'), leaf('b')]);
    api.onReorderDrop(evt(), 1);
    expect(ids(widgets.value)).toEqual(['a', 'b']);
  });
});
