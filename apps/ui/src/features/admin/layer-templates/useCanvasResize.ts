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
 * Drag-to-resize on the layer-dashboard admin canvas: the corner handle
 * that changes a widget's column span and row span.
 *
 * The same drag serves a top-level widget and one nested in a tab panel;
 * only the grid pitch differs, so the session records which it is and the
 * move handler writes back through the matching setter. Window listeners
 * are attached for the duration of a drag and torn down with the owner.
 */

import { onBeforeUnmount, reactive, ref, type ComputedRef, type Ref } from 'vue';
import type { DashboardWidget } from '@skywalking-horizon-ui/api-client';
import {
  CANVAS_COLS,
  CANVAS_GAP_PX,
  CANVAS_ROW_PX,
  SUBGRID_GAP_PX,
  SUBGRID_ROW_PX,
  widgetRowSpan,
  widgetSpan,
} from './layer-dashboards.geometry';

export interface CanvasResizeDeps {
  /** Widgets of the page being edited. */
  currentWidgets: ComputedRef<DashboardWidget[]>;
  /** Write the page's widgets back to the draft. */
  setWidgets: (widgets: DashboardWidget[]) => void;
  subWidgetsOf: (widgetId: string, tabIdx: number) => DashboardWidget[];
  commitSubWidgets: (widgetId: string, tabIdx: number, widgets: DashboardWidget[]) => void;
  selectedIdx: Ref<number | null>;
  selectSub: (widgetId: string, tabIdx: number, subIdx: number) => void;
}

export function useCanvasResize(deps: CanvasResizeDeps) {
  const canvasEl = ref<HTMLDivElement | null>(null);

  /** Active resize session: tracks the starting span/rowSpan + pixel
   *  origin so we can compute the new span from the mouse delta. */
  const resize = reactive<{
    active: boolean;
    idx: number;
    sub: { widgetId: string; tabIdx: number; subIdx: number } | null;
    startX: number;
    startY: number;
    startSpan: number;
    startRowSpan: number;
    cellW: number;
    cellH: number;
  }>({
    active: false,
    idx: -1,
    sub: null,
    startX: 0,
    startY: 0,
    startSpan: 1,
    startRowSpan: 1,
    cellW: 1,
    cellH: 1,
  });

  function onResizeStart(e: MouseEvent, i: number): void {
    e.preventDefault();
    e.stopPropagation();
    const widgets = deps.currentWidgets.value;
    const w = widgets[i];
    if (!w || !canvasEl.value) return;
    const rect = canvasEl.value.getBoundingClientRect();
    // The canvas grid uses 12 equal-width columns with a fixed gap. Column
    // width is therefore (canvasWidth - 11 gaps - 2 padding) / 12. We snap
    // the dragged span based on this cell pitch.
    const cellW = (rect.width - 2 * 12 - CANVAS_GAP_PX * (CANVAS_COLS - 1)) / CANVAS_COLS;
    resize.active = true;
    resize.idx = i;
    resize.startX = e.clientX;
    resize.startY = e.clientY;
    resize.startSpan = widgetSpan(w);
    resize.startRowSpan = widgetRowSpan(w);
    resize.cellW = cellW + CANVAS_GAP_PX;
    resize.cellH = CANVAS_ROW_PX + CANVAS_GAP_PX;
    deps.selectedIdx.value = i;
    window.addEventListener('mousemove', onResizeMove);
    window.addEventListener('mouseup', onResizeEnd);
  }

  /** Resize a widget INSIDE a tab — same drag as the top level, but snapped to
   *  the tab's own 12-col sub-grid pitch (measured from the .cw-subgrid). */
  function onSubResizeStart(e: MouseEvent, widgetId: string, tabIdx: number, subIdx: number): void {
    e.preventDefault();
    e.stopPropagation();
    const sw = deps.subWidgetsOf(widgetId, tabIdx)[subIdx];
    const grid = (e.target as HTMLElement).closest('.cw-subgrid') as HTMLElement | null;
    if (!sw || !grid) return;
    const rect = grid.getBoundingClientRect();
    const cellW = (rect.width - SUBGRID_GAP_PX * (CANVAS_COLS - 1)) / CANVAS_COLS;
    resize.active = true;
    resize.idx = -1;
    resize.sub = { widgetId, tabIdx, subIdx };
    resize.startX = e.clientX;
    resize.startY = e.clientY;
    resize.startSpan = widgetSpan(sw);
    resize.startRowSpan = widgetRowSpan(sw);
    resize.cellW = cellW + SUBGRID_GAP_PX;
    resize.cellH = SUBGRID_ROW_PX + SUBGRID_GAP_PX;
    deps.selectSub(widgetId, tabIdx, subIdx);
    window.addEventListener('mousemove', onResizeMove);
    window.addEventListener('mouseup', onResizeEnd);
  }

  function onResizeMove(e: MouseEvent): void {
    if (!resize.active) return;
    const dx = e.clientX - resize.startX;
    const dy = e.clientY - resize.startY;
    const newSpan = Math.max(1, Math.min(CANVAS_COLS, resize.startSpan + Math.round(dx / resize.cellW)));
    const newRowSpan = Math.max(1, Math.min(8, resize.startRowSpan + Math.round(dy / resize.cellH)));
    if (resize.sub) {
      const { widgetId, tabIdx, subIdx } = resize.sub;
      const ws = [...deps.subWidgetsOf(widgetId, tabIdx)];
      const w = ws[subIdx];
      if (w && (w.span !== newSpan || w.rowSpan !== newRowSpan)) {
        ws[subIdx] = { ...w, span: newSpan, rowSpan: newRowSpan };
        deps.commitSubWidgets(widgetId, tabIdx, ws);
      }
      return;
    }
    const widgets = [...deps.currentWidgets.value];
    const w = widgets[resize.idx];
    if (!w) return;
    if (w.span !== newSpan || w.rowSpan !== newRowSpan) {
      widgets[resize.idx] = { ...w, span: newSpan, rowSpan: newRowSpan };
      deps.setWidgets(widgets);
    }
  }

  function onResizeEnd(): void {
    resize.active = false;
    resize.sub = null;
    window.removeEventListener('mousemove', onResizeMove);
    window.removeEventListener('mouseup', onResizeEnd);
  }

  onBeforeUnmount(() => {
    window.removeEventListener('mousemove', onResizeMove);
    window.removeEventListener('mouseup', onResizeEnd);
  });

  return { canvasEl, resize, onResizeStart, onSubResizeStart, onResizeEnd };
}
