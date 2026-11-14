// Licensed to the Apache Software Foundation (ASF) under one or more
// contributor license agreements.  See the NOTICE file distributed with
// this work for additional information regarding copyright ownership.
// The ASF licenses this file to You under the Apache License, Version 2.0
// (the "License"); you may not use this file except in compliance with
// the License.  You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { onBeforeUnmount, ref, type Ref } from 'vue';
import * as d3 from 'd3';

/**
 * d3.zoom lifecycle for the trace tree SVG. Owns the wheel/drag binding
 * and tears it down on unmount. The programmatic +/-/⊙ buttons drive the
 * same behaviour so the transform stays consistent. Re-binds whenever the
 * SVG element changes so drag-pan keeps working after re-renders.
 *
 * Returns the svg element ref to bind to the <svg>, the live transform to
 * project onto the inner <g>, `ensureZoom()` to (re)attach on activation,
 * the zoom-by / reset controls, and `revealNode()` to pan a node into view.
 */
export function useTraceTreeZoom() {
  const treeSvgEl = ref<SVGSVGElement | null>(null);
  const treeTransform = ref<{ x: number; y: number; k: number }>({ x: 0, y: 0, k: 1 });
  let treeZoomBehavior: ReturnType<typeof d3.zoom<SVGSVGElement, unknown>> | null = null;
  let treeZoomBoundEl: SVGSVGElement | null = null;

  function ensureZoom(): void {
    const el = treeSvgEl.value;
    if (!el) return;
    if (treeZoomBoundEl === el && treeZoomBehavior) return;
    if (treeZoomBoundEl) {
      d3.select(treeZoomBoundEl).on('.zoom', null);
    }
    treeZoomBehavior = d3.zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.2, 4])
      .on('zoom', (ev) => {
        treeTransform.value = { x: ev.transform.x, y: ev.transform.y, k: ev.transform.k };
      });
    d3.select(el).call(treeZoomBehavior);
    treeZoomBoundEl = el;
  }

  function zoomBy(factor: number): void {
    const el = treeSvgEl.value;
    if (!el || !treeZoomBehavior) return;
    d3.select(el).transition().duration(180).call(treeZoomBehavior.scaleBy, factor);
  }

  function zoomReset(): void {
    const el = treeSvgEl.value;
    if (!el || !treeZoomBehavior) return;
    d3.select(el).transition().duration(180).call(treeZoomBehavior.transform, d3.zoomIdentity);
    treeTransform.value = { x: 0, y: 0, k: 1 };
  }

  /** Pans a node — its box in layout coordinates — to the middle of the view,
   *  unless the whole box is in view already, then calls `then` (once the pan
   *  has landed). `viewW` / `viewH` are the SVG's viewBox size, which is also
   *  d3.zoom's extent. */
  function revealNode(x: number, y: number, w: number, h: number, viewW: number, viewH: number, then?: () => void): void {
    const el = treeSvgEl.value;
    const { x: tx, y: ty, k } = treeTransform.value;
    const left = x * k + tx;
    const top = y * k + ty;
    if (!el || !treeZoomBehavior || (left >= 0 && top >= 0 && left + w * k <= viewW && top + h * k <= viewH)) {
      then?.();
      return;
    }
    d3.select(el).transition().duration(240)
      .call(treeZoomBehavior.translateTo, x + w / 2, y + h / 2)
      .on('end', () => then?.());
  }

  onBeforeUnmount(() => {
    if (treeZoomBoundEl) d3.select(treeZoomBoundEl).on('.zoom', null);
    treeZoomBoundEl = null;
    treeZoomBehavior = null;
  });

  return {
    treeSvgEl: treeSvgEl as Ref<SVGSVGElement | null>,
    treeTransform,
    ensureZoom,
    zoomBy,
    zoomReset,
    revealNode,
  };
}
