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
 * Pinia store for the per-layer service map's Smartscape hierarchy
 * overlay. Holds open/close state, the focused node id, and the
 * captured zoom transform at open time (the topology pan/zoom is
 * frozen while the overlay is up so peers don't drift under the
 * operator).
 *
 * The store also gates the global auto-refresh ticker via
 * suspend()/resume() — pausing all topology refetches (and any other
 * subscriber on the page) while the operator explores the hierarchy
 * so the background graph doesn't shift under the spotlight. The
 * ticker's `resume()` fires one immediate tick on close, so the topology
 * snaps back to live data the moment the overlay shuts.
 */

import { defineStore } from 'pinia';
import { ref } from 'vue';
import { useAutoRefreshStore } from '@/controls/autoRefresh';

/** Captured zoom transform — d3.ZoomTransform-equivalent. Held on the
 *  store so the overlay can re-anchor peers when the topology view
 *  re-mounts (e.g. tab swap and back). */
export interface ZoomSnapshot {
  k: number;
  x: number;
  y: number;
}

export const useHierarchyOverlayStore = defineStore('service-hierarchy-overlay', () => {
  const isOpen = ref(false);
  /** OAP service id of the focused node. Null when overlay is closed. */
  const focusServiceId = ref<string | null>(null);
  /** Service name of the focused node — used in the rail header and as
   *  a fallback if the BFF response's `self` peer is missing (rare). */
  const focusServiceName = ref<string | null>(null);
  /** OAP layer key of the focus's home layer (e.g. `GENERAL`). */
  const focusLayer = ref<string | null>(null);
  /** Zoom snapshot taken when the overlay opens. The overlay re-applies
   *  this to its own SVG group so peers + connectors track the focus
   *  hex's current screen position; the topology's own zoom behaviour
   *  is paused while the overlay is up. */
  const zoom = ref<ZoomSnapshot>({ k: 1, x: 0, y: 0 });

  function open(args: {
    serviceId: string;
    serviceName: string;
    layer: string;
    zoom: ZoomSnapshot;
  }): void {
    focusServiceId.value = args.serviceId;
    focusServiceName.value = args.serviceName;
    focusLayer.value = args.layer.toUpperCase();
    zoom.value = args.zoom;
    isOpen.value = true;
    // Freeze every refetch path on the page (topology, KPIs, dependency
    // graph, etc.) — operators expect the background to stay still
    // while they pan through the hierarchy.
    useAutoRefreshStore().suspend();
  }

  function close(): void {
    if (!isOpen.value) return;
    isOpen.value = false;
    focusServiceId.value = null;
    focusServiceName.value = null;
    focusLayer.value = null;
    // resume() fires one immediate tick — the topology snaps back to
    // live data the moment the overlay shuts. Operators reading
    // "closed" expect the numbers to refresh, not stay stale.
    useAutoRefreshStore().resume();
  }

  /** Replace the captured zoom — called by the topology view when the
   *  operator changes layer/service while the overlay is open (the
   *  overlay stays up via the URL `?hierarchy=1` flag; we just re-aim
   *  it at the new focus). */
  function updateZoom(next: ZoomSnapshot): void {
    zoom.value = next;
  }

  return {
    isOpen,
    focusServiceId,
    focusServiceName,
    focusLayer,
    zoom,
    open,
    close,
    updateZoom,
  };
});
