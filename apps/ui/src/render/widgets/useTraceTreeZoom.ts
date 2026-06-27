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
 * and the zoom-by / reset controls.
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
  };
}
