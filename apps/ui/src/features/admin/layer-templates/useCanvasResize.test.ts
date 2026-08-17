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
 * Corner-drag resize, driven through real window events.
 *
 * The drag lives on the window rather than the handle, because the pointer
 * leaves the widget almost immediately — so the listeners are the feature,
 * not an implementation detail, and dispatching real events is what proves
 * they are attached and, more importantly, REMOVED. A leaked mousemove
 * listener resizes whatever was last dragged whenever the operator moves
 * the mouse, which is the kind of fault a mocked handler call cannot see.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ref, computed } from 'vue';
import type { DashboardWidget } from '@skywalking-horizon-ui/api-client';
import { useCanvasResize } from './useCanvasResize';
import { CANVAS_COLS, CANVAS_GAP_PX, CANVAS_ROW_PX } from './layer-dashboards.geometry';

const w = (id: string, span = 6, rowSpan = 2): DashboardWidget =>
  ({ id, type: 'line', title: id, expressions: ['x'], span, rowSpan }) as DashboardWidget;

/** Canvas width chosen so one column step is a round number of pixels. */
const CANVAS_W = 1000;
const cellW = (CANVAS_W - 2 * 12 - CANVAS_GAP_PX * (CANVAS_COLS - 1)) / CANVAS_COLS + CANVAS_GAP_PX;
const cellH = CANVAS_ROW_PX + CANVAS_GAP_PX;

function harness(initial: DashboardWidget[]) {
  const widgets = ref<DashboardWidget[]>(initial);
  const selectedIdx = ref<number | null>(null);
  const api = useCanvasResize({
    currentWidgets: computed(() => widgets.value),
    setWidgets: (next) => (widgets.value = next),
    subWidgetsOf: () => [],
    commitSubWidgets: () => {},
    selectedIdx,
    selectSub: () => {},
  });
  // The pitch is measured off the canvas element, so the drag cannot be
  // exercised without one.
  const el = document.createElement('div');
  el.getBoundingClientRect = () => ({ width: CANVAS_W, height: 600, x: 0, y: 0, top: 0, left: 0, right: CANVAS_W, bottom: 600, toJSON: () => ({}) });
  api.canvasEl.value = el as HTMLDivElement;
  return { api, widgets, selectedIdx };
}

const down = (): MouseEvent => new MouseEvent('mousedown', { clientX: 0, clientY: 0 });
const move = (dx: number, dy: number): void => {
  window.dispatchEvent(new MouseEvent('mousemove', { clientX: dx, clientY: dy }));
};

beforeEach(() => {
  window.dispatchEvent(new MouseEvent('mouseup'));
});

describe('resizing a top-level widget', () => {
  it('grows by whole columns and rows as the pointer moves', () => {
    const { api, widgets } = harness([w('a', 6, 2)]);
    api.onResizeStart(down(), 0);
    move(cellW * 2, cellH);
    expect(widgets.value[0].span).toBe(8);
    expect(widgets.value[0].rowSpan).toBe(3);
  });

  it('snaps to the nearest column rather than truncating', () => {
    // Just past the halfway point of one cell is already the next span —
    // truncation would make the widget feel like it lags the pointer.
    const { api, widgets } = harness([w('a', 6, 2)]);
    api.onResizeStart(down(), 0);
    move(cellW * 0.6, 0);
    expect(widgets.value[0].span).toBe(7);
  });

  it('clamps to the grid instead of running off it', () => {
    const { api, widgets } = harness([w('a', 6, 2)]);
    api.onResizeStart(down(), 0);
    move(cellW * 50, cellH * 50);
    expect(widgets.value[0].span).toBe(CANVAS_COLS);
    expect(widgets.value[0].rowSpan).toBe(8);
    move(-cellW * 50, -cellH * 50);
    expect(widgets.value[0].span).toBe(1);
    expect(widgets.value[0].rowSpan).toBe(1);
  });

  it('selects the widget being dragged', () => {
    const { api, selectedIdx } = harness([w('a'), w('b')]);
    api.onResizeStart(down(), 1);
    expect(selectedIdx.value).toBe(1);
  });

  it('leaves the other widgets alone', () => {
    const { api, widgets } = harness([w('a', 6, 2), w('b', 4, 3)]);
    api.onResizeStart(down(), 0);
    move(cellW, 0);
    expect(widgets.value[1]).toEqual(w('b', 4, 3));
  });

  it('does not start without a canvas to measure', () => {
    const { api, widgets } = harness([w('a', 6, 2)]);
    api.canvasEl.value = null;
    api.onResizeStart(down(), 0);
    move(cellW * 2, 0);
    expect(widgets.value[0].span).toBe(6);
    expect(api.resize.active).toBe(false);
  });
});

describe('ending the drag', () => {
  it('stops writing once the button is released', () => {
    const { api, widgets } = harness([w('a', 6, 2)]);
    api.onResizeStart(down(), 0);
    move(cellW, 0);
    expect(widgets.value[0].span).toBe(7);
    window.dispatchEvent(new MouseEvent('mouseup'));
    // The listener is gone, so this movement reaches nothing. If it were
    // still attached the widget would keep resizing with the mouse.
    move(cellW * 4, 0);
    expect(widgets.value[0].span).toBe(7);
    expect(api.resize.active).toBe(false);
  });

  it('is idempotent — a second release changes nothing', () => {
    const { api } = harness([w('a')]);
    api.onResizeStart(down(), 0);
    api.onResizeEnd();
    api.onResizeEnd();
    expect(api.resize.active).toBe(false);
  });
});
