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
 * d3 pan / zoom / pod-drag lifecycle for the Deployment SVG — same lifecycle as
 * the instance map. Owns the d3.zoom + d3.drag behaviours and tears them down
 * on unmount; the view never touches d3 directly.
 *
 * Pod drag moves a WHOLE pod (main + its siblings) as a unit: the drag handler
 * writes into the caller-supplied `podDelta` ref keyed by podId, and every node
 * `<g>` reads its delta back through `nodeToPod`. The zoom filter bows out for
 * `[data-node-id]` / `[data-edge-id]` targets so dragging an element never pans.
 */

import { nextTick, onBeforeUnmount, ref, watch, type Ref } from 'vue';
import * as d3 from 'd3';

interface DeploymentPanZoomOptions {
  svgEl: Ref<SVGSVGElement | null>;
  zoomLayerEl: Ref<SVGGElement | null>;
  containerEl: Ref<HTMLDivElement | null>;
  /** Graph bounding-box width / height (drive fit-to-screen). */
  W: Ref<number>;
  H: Ref<number>;
  /** node id → podId, so a dragged hex moves its whole pod. */
  nodeToPod: Ref<Map<string, string>>;
  /** Per-pod drag offsets; the composable writes the accumulated delta here. */
  podDelta: Ref<Map<string, { dx: number; dy: number }>>;
  /** Dataset-identity signal — re-bind drag + re-fit whenever it changes (a
   *  service switch that re-keys the v-for nodes drops the d3 drag listeners). */
  datasetKey: Ref<string>;
}

export function useDeploymentPanZoom(opts: DeploymentPanZoomOptions) {
  const { svgEl, zoomLayerEl, containerEl, W, H, nodeToPod, podDelta, datasetKey } = opts;
  let zoomBehaviour: d3.ZoomBehavior<SVGSVGElement, unknown> | null = null;
  const zoomT = ref<{ k: number; x: number; y: number }>({ k: 1, x: 0, y: 0 });

  function viewportSize(): { width: number; height: number } {
    const el = containerEl.value;
    if (!el) return { width: W.value, height: H.value };
    const r = el.getBoundingClientRect();
    return { width: r.width || W.value, height: r.height || H.value };
  }
  function fitToScreen(animate = true): void {
    if (!svgEl.value || !zoomBehaviour) return;
    const vp = viewportSize();
    const pad = 24;
    const fit = Math.min((vp.width - pad * 2) / W.value, (vp.height - pad * 2) / H.value);
    // Same readable cap as the service map (0.79) so the hexes + fonts render at
    // the SAME on-screen scale across the two topologies. The canvas now has a
    // concrete height, so the fit actually reaches this cap instead of starving.
    const k = Math.max(0.15, Math.min(fit, 0.79));
    const tx = (vp.width - W.value * k) / 2;
    const ty = (vp.height - H.value * k) / 2;
    const transform = d3.zoomIdentity.translate(tx, ty).scale(k);
    const sel = d3.select(svgEl.value);
    if (animate) sel.transition().duration(200).call(zoomBehaviour.transform, transform);
    else sel.call(zoomBehaviour.transform, transform);
  }
  function zoomBy(factor: number): void {
    if (!svgEl.value || !zoomBehaviour) return;
    d3.select(svgEl.value).transition().duration(150).call(zoomBehaviour.scaleBy, factor);
  }
  function installZoom(): void {
    if (!svgEl.value || !zoomLayerEl.value) return;
    const sel = d3.select(svgEl.value);
    zoomBehaviour = d3
      .zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.15, 5])
      .filter((event) => {
        if (event.type === 'mousedown' && (event as MouseEvent).button !== 0) return false;
        const target = event.target as Element | null;
        if (target?.closest?.('[data-node-id], [data-edge-id]')) return false;
        return !(event as MouseEvent).button;
      })
      .on('zoom', (ev) => {
        zoomT.value = { k: ev.transform.k, x: ev.transform.x, y: ev.transform.y };
        d3.select(zoomLayerEl.value).attr('transform', ev.transform.toString());
      });
    sel.call(zoomBehaviour);
    sel.on('dblclick.zoom', null);
    sel.on('dblclick', () => fitToScreen(true));
  }
  // Drag a pod (any hex in it) to reposition the whole pod — main + its
  // siblings move together. The zoom filter bows out for `[data-node-id]`
  // targets, so dragging never pans. d3.drag's event.dx/dy are post-transform
  // (zoom-aware), so they apply straight to the pod delta. Re-bound on every
  // (re)render since Vue recreates the node `<g>` elements.
  function installNodeDrag(): void {
    if (!zoomLayerEl.value) return;
    const sel = d3.select(zoomLayerEl.value).selectAll<SVGGElement, unknown>('g.sit-node');
    sel.on('.drag', null);
    sel.call(
      d3
        .drag<SVGGElement, unknown>()
        .clickDistance(4)
        .on('start', (event) => { (event.sourceEvent as MouseEvent).stopPropagation(); })
        .on('drag', function (event) {
          const id = (this as SVGGElement).getAttribute('data-node-id');
          if (!id) return;
          const pid = nodeToPod.value.get(id);
          if (!pid) return;
          const cur = podDelta.value.get(pid) ?? { dx: 0, dy: 0 };
          const m = new Map(podDelta.value);
          m.set(pid, { dx: cur.dx + event.dx, dy: cur.dy + event.dy });
          podDelta.value = m;
        }),
    );
  }
  function installZoomAndFit(): void {
    if (!svgEl.value || !zoomLayerEl.value) return;
    installZoom();
    void nextTick(() => { installNodeDrag(); fitToScreen(false); });
  }
  // The <svg> lives behind a v-else and unmounts whenever a new service's
  // data is in flight, then remounts when it lands — so re-bind zoom on every
  // (re)mount (a one-shot latch would leave pan/zoom dead after the first
  // service switch).
  watch(svgEl, (el) => { if (el && zoomLayerEl.value) installZoomAndFit(); }, { flush: 'post' });
  // datasetKey folds in selectedId: a service switch that lands on cached data
  // with identical counts still re-keys every v-for node element, which kills
  // the per-element d3 drag listeners — rebind + refit on dataset identity,
  // not just shape.
  watch(datasetKey, () => {
    if (svgEl.value && zoomBehaviour) void nextTick(() => { installNodeDrag(); fitToScreen(false); });
  });
  onBeforeUnmount(() => {
    if (svgEl.value) d3.select(svgEl.value).on('.zoom', null).on('dblclick', null);
    zoomBehaviour = null;
  });

  return { zoomT, fitToScreen, zoomBy };
}
