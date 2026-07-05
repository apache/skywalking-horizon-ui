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
 * d3 pan / zoom / node-drag lifecycle for the service-map SVG. Owns the
 * d3.zoom + d3.drag behaviours and tears them down on unmount — the view
 * never touches d3 directly.
 *
 * Pan + zoom via d3.zoom: wheel scrolls in/out, trackpad pinch zooms,
 * drag pans. Browser-level Ctrl+/- still works for whole-page zoom; this
 * is the in-canvas equivalent operators expect on a service-map. The
 * transform applies to a `<g class="zoom-layer">` inside the SVG, so the
 * gradient, baselines, edges, and nodes all transform together. We
 * auto-fit on mount and on graph-shape changes so the operator lands on
 * a sensible default no matter how wide the chain is.
 *
 * Node drag: pointer-drives the (cx, cy) override for the dragged
 * service via the caller-supplied `nodePos` accessor + `dragOverrides`
 * ref. The whole edge set re-routes live because every edge's `d`
 * attribute reads from `nodePos`, which surfaces the override.
 */

import { nextTick, onBeforeUnmount, onMounted, ref, watch, type Ref } from 'vue';
import * as d3 from 'd3';
import type { Pos } from '@/layer/service-map/useTopologyLayout';

interface TopologyCanvasOptions {
  svgEl: Ref<SVGSVGElement | null>;
  zoomLayerEl: Ref<SVGGElement | null>;
  containerEl: Ref<HTMLDivElement | null>;
  /** Graph bounding-box width / height (drive fit-to-screen). */
  W: Ref<number>;
  H: Ref<number>;
  /** Flat node id list — re-fit + re-bind drag when its shape changes. */
  nodeCount: Ref<number>;
  /** Live (cx, cy) lookup — already folds in drag overrides. */
  nodePos: Ref<Map<string, Pos>>;
  /** Drag override map; the composable writes the dropped position here. */
  dragOverrides: Ref<Map<string, Pos>>;
  /** Cap for the fit-to-screen scale. The full page keeps the readable 0.79
   *  default (don't blow the canvas up); an embedded host with a small stage
   *  (the AI chat) passes a higher value so a small focused graph fills its box
   *  instead of sitting tiny. */
  maxFitScale?: number;
}

export function useTopologyCanvas(opts: TopologyCanvasOptions) {
  const { svgEl, zoomLayerEl, containerEl, W, H, nodeCount, nodePos, dragOverrides } = opts;
  const maxFitScale = opts.maxFitScale ?? 0.79;
  let zoomBehaviour: d3.ZoomBehavior<SVGSVGElement, unknown> | null = null;
  const zoomT = ref<{ k: number; x: number; y: number }>({ k: 1, x: 0, y: 0 });

  function viewportSize(): { width: number; height: number } {
    const el = containerEl.value;
    if (!el) return { width: W.value, height: H.value };
    const rect = el.getBoundingClientRect();
    return { width: rect.width || W.value, height: rect.height || H.value };
  }

  /** Fit the graph's bounding box into the visible canvas, leaving a
   *  little padding. Called on mount + when the graph shape changes
   *  + when the operator hits the Fit button. */
  function fitToScreen(animate = true): void {
    if (!svgEl.value || !zoomBehaviour) return;
    const vp = viewportSize();
    const pad = 24;
    const fit = Math.min(
      (vp.width - pad * 2) / W.value,
      (vp.height - pad * 2) / H.value,
    );
    // Operator-validated readable scale: at ~79% the node labels + metric line
    // both stay legible. Default cap is that; an embedded small-stage host (the
    // chat) raises it so a small focused graph fills its box. Never overshoot
    // the cap — blowing the canvas up past it just wastes pixels.
    const k = Math.max(0.15, Math.min(fit, maxFitScale));
    const tx = (vp.width - W.value * k) / 2;
    const ty = (vp.height - H.value * k) / 2;
    const sel = d3.select(svgEl.value);
    const transform = d3.zoomIdentity.translate(tx, ty).scale(k);
    if (animate) {
      sel.transition().duration(220).call(zoomBehaviour.transform, transform);
    } else {
      sel.call(zoomBehaviour.transform, transform);
    }
  }
  function zoomBy(factor: number): void {
    if (!svgEl.value || !zoomBehaviour) return;
    d3.select(svgEl.value).transition().duration(160).call(zoomBehaviour.scaleBy, factor);
  }

  function installZoom(): void {
    if (!svgEl.value || !zoomLayerEl.value) return;
    const sel = d3.select(svgEl.value);
    zoomBehaviour = d3
      .zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.15, 5])
      .filter((event) => {
        // Ignore zoom on right-click — leaves the context menu usable.
        // Wheel + dblclick + drag all proceed normally; pinch on
        // trackpads fires `wheel` with ctrlKey=true which d3 handles.
        if (event.type === 'mousedown' && (event as MouseEvent).button !== 0) return false;
        // Skip when the pointer started on a node — that's a node-drag,
        // not a canvas pan. The `data-node-id` attribute identifies the
        // node-group target; bubbles up through SVG groups.
        const t = event.target as Element | null;
        if (t && t.closest && t.closest('[data-node-id]')) return false;
        return !(event as MouseEvent).button;
      })
      .on('zoom', (ev) => {
        zoomT.value = { k: ev.transform.k, x: ev.transform.x, y: ev.transform.y };
        d3.select(zoomLayerEl.value).attr('transform', ev.transform.toString());
      });
    sel.call(zoomBehaviour);
    // Double-click resets to fit — friendlier than d3's default
    // "double-click to zoom in by 2x" which often takes the operator by
    // surprise.
    sel.on('dblclick.zoom', null);
    sel.on('dblclick', () => fitToScreen(true));
  }

  // Node drag: pointer-drives the (cx, cy) override for the dragged
  // service. The whole edge set re-routes live because every edge's `d`
  // attribute reads from `nodePos`, which surfaces the override. Drop =
  // commit position. We don't fight the user with a snap-back.
  function installNodeDrag(): void {
    if (!zoomLayerEl.value) return;
    const sel = d3.select(zoomLayerEl.value).selectAll<SVGGElement, unknown>('g.sm-node');
    sel.on('.drag', null);
    sel.call(
      d3
        .drag<SVGGElement, unknown>()
        .clickDistance(4)
        .on('start', function (event) {
          // Mark which node is being dragged so the zoom filter knows to
          // bow out for this pointer sequence.
          (event.sourceEvent as MouseEvent).stopPropagation();
        })
        .on('drag', function (event) {
          const el = this as SVGGElement;
          const id = el.getAttribute('data-node-id');
          if (!id) return;
          const cur = nodePos.value.get(id);
          if (!cur) return;
          // event.dx / event.dy are post-transform deltas (d3.drag does
          // the math on the parent's CTM internally), so we can add them
          // directly to the override coordinates without unzooming.
          const next = { cx: cur.cx + event.dx, cy: cur.cy + event.dy };
          const m = new Map(dragOverrides.value);
          m.set(id, next);
          dragOverrides.value = m;
        }),
    );
  }

  onMounted(() => {
    // Defer one tick so the SVG has been rendered (layoutNodes drives its
    // mount through v-if).
    void nextTick(() => {
      installZoom();
      installNodeDrag();
      if (svgEl.value) fitToScreen(false);
    });
  });
  onBeforeUnmount(() => {
    if (svgEl.value) d3.select(svgEl.value).on('.zoom', null).on('dblclick', null);
    zoomBehaviour = null;
  });
  // Re-fit when the graph's shape changes substantially (depth toggle,
  // data refresh that adds/removes nodes). Layout-dependent dims (W/H)
  // are the cheapest signal that something visible changed.
  watch(
    () => `${W.value}x${H.value}x${nodeCount.value}`,
    () => {
      // If the SVG remounts (v-if), we need to re-install zoom. Defer.
      // Also re-bind drag — `selectAll('g.sm-node')` is bound to the
      // current DOM nodes, so a remount drops the handlers.
      void nextTick(() => {
        installNodeDrag();
        if (!zoomBehaviour) installZoom();
        fitToScreen(false);
      });
    },
  );

  return { zoomT, fitToScreen, zoomBy };
}
