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

import { computed, nextTick, onMounted, ref, watch, type Ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import type { LayerDef } from '@skywalking-horizon-ui/api-client';
import { firstLayerTab } from '@/shell/useLayers';

/**
 * Stateless route-active reads, shared by the sidebar shell and the
 * extracted layer-children component so the active-match rule lives in
 * exactly one place. No expand state, no watchers — just the current
 * route plus the two case-insensitive predicates.
 */
export function useRouteActive() {
  const route = useRoute();
  // Case-insensitive: layer keys are UPPER_SNAKE in the menu/links but a
  // URL may arrive lowercased (overview KPI tiles link lowercased, hand-typed
  // URLs, etc.). Without normalising, the active row wouldn't get the accent
  // colour and the auto-scroll couldn't find it.
  const routePathLc = computed(() => route.path.toLowerCase());
  function isActive(path: string): boolean {
    const p = path.toLowerCase();
    return routePathLc.value === p || routePathLc.value.startsWith(p + '/');
  }
  /** Use this — not {@link isActive} — for sibling routes where one is
   *  a prefix of another (e.g. `/operate/live-debug` vs
   *  `/operate/live-debug/history`); prefix-match would light both up. */
  function isActiveExact(path: string): boolean {
    return routePathLc.value === path.toLowerCase();
  }
  return { route, isActive, isActiveExact };
}

/**
 * Route-active plumbing for the sidebar: the case-insensitive active-match
 * reads (via {@link useRouteActive}), the per-layer accordion expand state,
 * and the scroll-the-active-row-into-view behaviour. Pass the rendered
 * (landing-ordered) layer list so `toggleLayer` can resolve a key to its
 * first tab without re-deriving landing order.
 *
 * The route watch + `onMounted` register here, so they tear down with the
 * owning component.
 */
export function useSidebarActive(orderedLayers: Ref<readonly LayerDef[]>) {
  const router = useRouter();
  const { route, isActive, isActiveExact } = useRouteActive();

  const expandedLayer = ref<string | null>(null);
  function toggleLayer(key: string): void {
    const wasExpanded = expandedLayer.value === key;
    expandedLayer.value = wasExpanded ? null : key;
    if (!wasExpanded) {
      const L = orderedLayers.value.find((l) => l.key === key);
      if (!L) return;
      const target = `/layer/${L.key}/${firstLayerTab(L)}`;
      if (route.path === target) return;
      if (route.path.startsWith(`/layer/${L.key}/`)) return;
      void router.push(target);
    }
  }

  // Only the layer the route currently points at is auto-expanded. We do
  // NOT pre-expand the first layer (General) on a non-layer landing —
  // expanding a section is an explicit user action (a click), and a
  // default-open accordion misleads operators into thinking that layer is
  // "selected" when they've navigated nowhere.
  const navRef = ref<HTMLElement | null>(null);
  /** Bring the route's active nav row into view (it may sit below the fold
   *  on a long sidebar). Waits a tick so the route-driven expand has
   *  rendered the L2 children that contain the active row. */
  async function scrollActiveIntoView(): Promise<void> {
    await nextTick();
    // Both the layer row and its active child carry `.is-active`; scroll to
    // the LAST (deepest) one — the active tab — so it lands in view.
    // Exclude `.sw-nav-toggle` (the bottom "Debug events" button is
    // `.is-active` whenever the panel is on — default on localhost — and
    // being last in the DOM it would otherwise scroll the sidebar to the
    // very end on every navigation regardless of the clicked item).
    const actives = navRef.value?.querySelectorAll('.is-active:not(.sw-nav-toggle)');
    actives?.[actives.length - 1]?.scrollIntoView({ block: 'nearest' });
  }

  // Expand the layer the route points at AND scroll its active item into
  // view — on every entry into a layer page (deep-link, reload, in-app
  // nav), not just the first paint.
  watch(
    [() => route.path, orderedLayers],
    ([path, rows]) => {
      const m = path.match(/^\/layer\/([^/]+)/);
      if (m) {
        const L = rows.find((l) => l.key.toUpperCase() === m[1]!.toUpperCase());
        if (L) expandedLayer.value = L.key;
      }
      void scrollActiveIntoView();
    },
    { immediate: true },
  );
  onMounted(scrollActiveIntoView);

  return {
    route,
    isActive,
    isActiveExact,
    expandedLayer,
    toggleLayer,
    navRef,
  };
}
