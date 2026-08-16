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
 * Drag-to-reorder on the layer-dashboard admin canvas.
 *
 * Three drops are possible and each means something different: onto
 * another top-level widget reorders, onto a tab container moves the
 * dragged leaf INTO that tab's active panel, and dragging a widget out of
 * a tab onto the canvas (or onto a top-level widget) lifts it back to the
 * grid. Nothing mutates during the drag — the dragged widget keeps its
 * slot and dims, the hover target gets a leading marker.
 */

import { reactive, type ComputedRef, type Ref } from 'vue';
import type { DashboardWidget } from '@skywalking-horizon-ui/api-client';

export interface CanvasReorderDeps {
  /** Widgets of the page being edited. */
  currentWidgets: ComputedRef<DashboardWidget[]>;
  /** Read the page's widgets fresh (a drag out of a tab rewrites the
   *  container in the same pass, so it needs the array, not the computed). */
  readWidgets: () => DashboardWidget[];
  /** Write the page's widgets back to the draft. */
  setWidgets: (widgets: DashboardWidget[]) => void;
  selectedIdx: Ref<number | null>;
  subSel: Ref<{ widgetId: string; tabIdx: number; subIdx: number } | null>;
  selectSub: (widgetId: string, tabIdx: number, subIdx: number) => void;
  activeTabOf: (id: string) => number;
}

export function useCanvasReorder(deps: CanvasReorderDeps) {
  /** Active reorder session: tracks the dragged widget index and the
   *  current hover target. */
  const reorder = reactive<{
    active: boolean;
    from: number;
    over: number;
    sub: { widgetId: string; tabIdx: number; subIdx: number } | null;
  }>({
    active: false,
    from: -1,
    over: -1,
    sub: null,
  });

  function onReorderStart(e: DragEvent, i: number): void {
    // Only allow drag from the widget's header. The header sets
    // draggable=true; resize handles + drawer inputs do not.
    reorder.active = true;
    reorder.from = i;
    reorder.over = i;
    reorder.sub = null;
    deps.selectedIdx.value = i;
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(i));
    }
  }

  /** Start dragging a widget that lives INSIDE a tab — dropping it on the
   *  top-level canvas (or a top-level widget) moves it OUT of the tab. */
  function onSubReorderStart(e: DragEvent, widgetId: string, tabIdx: number, subIdx: number): void {
    reorder.active = true;
    reorder.from = -1;
    reorder.over = -1;
    reorder.sub = { widgetId, tabIdx, subIdx };
    deps.selectSub(widgetId, tabIdx, subIdx);
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', 'sub');
    }
  }

  /** Move the dragged in-tab widget out to the page's top-level grid. */
  function moveSubToScope(insertAt: number | null): void {
    if (!reorder.sub) return;
    const { widgetId, tabIdx, subIdx } = reorder.sub;
    const scope = [...deps.readWidgets()];
    const twIdx = scope.findIndex((w) => w.id === widgetId && w.type === 'tab');
    const tw = twIdx >= 0 ? scope[twIdx] : null;
    const sub = tw?.tabs?.[tabIdx]?.widgets[subIdx];
    if (!tw?.tabs || !sub) return;
    const tabs = [...tw.tabs];
    tabs[tabIdx] = { ...tabs[tabIdx], widgets: tabs[tabIdx].widgets.filter((_, j) => j !== subIdx) };
    scope[twIdx] = { ...tw, tabs };
    const at = insertAt == null ? scope.length : Math.min(insertAt, scope.length);
    scope.splice(at, 0, sub);
    deps.setWidgets(scope);
    deps.subSel.value = null;
    deps.selectedIdx.value = scope.indexOf(sub);
  }

  /** Drop on the canvas background (not on a widget) — moves a dragged in-tab
   *  widget OUT to the end of the top-level grid. */
  function onCanvasDrop(e: DragEvent): void {
    if (!reorder.active || !reorder.sub) return;
    e.preventDefault();
    moveSubToScope(null);
    reorder.active = false;
    reorder.from = -1;
    reorder.over = -1;
    reorder.sub = null;
  }

  function onReorderOver(e: DragEvent, i: number): void {
    if (!reorder.active) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    if (reorder.over !== i) reorder.over = i;
  }

  function onReorderDrop(e: DragEvent, i: number): void {
    if (!reorder.active) return;
    e.preventDefault();
    // Dragging a widget OUT of a tab, dropped over a top-level widget → insert
    // it into the page at that position.
    if (reorder.sub) {
      moveSubToScope(i);
      reorder.active = false;
      reorder.from = -1;
      reorder.over = -1;
      reorder.sub = null;
      return;
    }
    const from = reorder.from;
    const to = i;
    if (from !== to) {
      const widgets = [...deps.currentWidgets.value];
      const target = widgets[to];
      const dragged = widgets[from];
      if (target && dragged && target.type === 'tab' && dragged.type !== 'tab') {
        // Dropped a leaf onto a tab container → MOVE it into that tab's ACTIVE
        // panel (it leaves the top-level grid).
        widgets.splice(from, 1);
        const tabs = [...(target.tabs ?? [])];
        if (tabs.length === 0) tabs.push({ name: 'Tab 1', widgets: [] });
        const ti = Math.min(deps.activeTabOf(target.id), tabs.length - 1);
        tabs[ti] = { ...tabs[ti], widgets: [...tabs[ti].widgets, dragged] };
        const tIdx = widgets.indexOf(target);
        widgets[tIdx] = { ...target, tabs };
        deps.setWidgets(widgets);
        deps.selectedIdx.value = tIdx;
      } else {
        widgets.splice(from, 1);
        widgets.splice(to, 0, dragged);
        deps.setWidgets(widgets);
        deps.selectedIdx.value = to;
      }
    }
    reorder.active = false;
    reorder.from = -1;
    reorder.over = -1;
  }

  function onReorderEnd(): void {
    reorder.active = false;
    reorder.from = -1;
    reorder.over = -1;
    reorder.sub = null;
  }

  return {
    reorder,
    onReorderStart,
    onSubReorderStart,
    onCanvasDrop,
    onReorderOver,
    onReorderDrop,
    onReorderEnd,
  };
}
