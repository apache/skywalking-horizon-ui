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
  /** Where the operator put each pod, in absolute canvas coordinates — the
   *  composable writes here on every drag. Absolute rather than an offset so a
   *  repack does not carry a placed pod along with it. */
  podAnchor: Ref<Map<string, { cx: number; cy: number }>>;
  /** Where the PACKING put each pod. The first drag of a pod starts from here. */
  podBase: Ref<Map<string, { cx: number; cy: number }>>;
  /** Rebinding signal — the IDENTITY of what is drawn, sorted. Vue re-keys the
   *  node `<g>` elements whenever that changes, which drops the per-element d3
   *  drag listeners, so they are re-attached on it. Never a count: a refresh
   *  that swaps one node for another leaves every count where it was. */
  datasetKey: Ref<string>;
  /** Identity of the QUESTION. The viewport refits on this alone. */
  predicateKey: Ref<string>;
}

export function useDeploymentPanZoom(opts: DeploymentPanZoomOptions) {
  const { svgEl, zoomLayerEl, containerEl, W, H, nodeToPod, podAnchor, podBase, datasetKey, predicateKey } =
    opts;
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
          // Untouched pods start from where the packing put them; touched ones
          // continue from where they were left.
          const cur = podAnchor.value.get(pid) ?? podBase.value.get(pid);
          if (!cur) return;
          const m = new Map(podAnchor.value);
          m.set(pid, { cx: cur.cx + event.dx, cy: cur.cy + event.dy });
          podAnchor.value = m;
        }),
    );
  }
  /**
   * Put the operator's framing back on a REPLACEMENT canvas.
   *
   * The transform lives on the `<svg>`, which is behind a `v-if` — a valid
   * empty result followed by nodes returning destroys and recreates it, and
   * without this the graph comes back at identity having lost the framing.
   */
  function restoreTransform(): void {
    if (!svgEl.value || !zoomBehaviour) return;
    const t = zoomT.value;
    d3.select(svgEl.value).call(
      zoomBehaviour.transform,
      d3.zoomIdentity.translate(t.x, t.y).scale(t.k),
    );
  }
  function installZoomAndFit(): void {
    if (!svgEl.value || !zoomLayerEl.value) return;
    installZoom();
    // Fits on FIRST mount only. Once a canvas is on screen its framing is the
    // operator's; see the predicate watcher below.
    void nextTick(() => {
      installNodeDrag();
      if (!svgEl.value) return;
      if (fittedOnce) {
        restoreTransform();
        return;
      }
      // Only LATCH a fit that had something to fit: fitting an empty canvas
      // measures nothing, and latching it left the real graph unframed when
      // nodes finally arrived.
      fitToScreen(false);
      if (W.value > 0 && H.value > 0) fittedOnce = true;
    });
  }
  let fittedOnce = false;
  // The <svg> lives behind a v-else and unmounts whenever a new service's
  // data is in flight, then remounts when it lands — so re-bind zoom on every
  // (re)mount (a one-shot latch would leave pan/zoom dead after the first
  // service switch).
  watch(svgEl, (el) => { if (el && zoomLayerEl.value) installZoomAndFit(); }, { flush: 'post' });
  // REBIND on dataset identity. A service switch that lands on cached data
  // with identical counts still re-keys every v-for element, killing the
  // per-element d3 drag listeners — so this watches identity, not shape. It
  // no longer refits: a refresh that adds a pod must not re-frame the canvas.
  watch(datasetKey, () => {
    if (svgEl.value && zoomBehaviour) {
      void nextTick(() => {
        installNodeDrag();
        // The FIRST drawn graph after a question change is what gets framed.
        // Fitting at the moment the question changed was too early and
        // sometimes impossible: the canvas is behind a `v-if` and unmounts
        // while the new read is out, so the fit silently did nothing while the
        // latch still recorded it as done — and the new graph arrived
        // unframed, at whatever zoom belonged to the previous one.
        if (!fittedOnce && svgEl.value) {
          fitToScreen(false);
          if (W.value > 0 && H.value > 0) fittedOnce = true;
        }
      });
    }
  });
  // A different question deserves a fresh frame — but taken when its graph is
  // actually on screen, which is the watcher above.
  watch(predicateKey, () => {
    fittedOnce = false;
  });
  onBeforeUnmount(() => {
    if (svgEl.value) d3.select(svgEl.value).on('.zoom', null).on('dblclick', null);
    zoomBehaviour = null;
  });

  return { zoomT, fitToScreen, zoomBy };
}
