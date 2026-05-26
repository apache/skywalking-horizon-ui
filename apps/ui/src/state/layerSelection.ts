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
 * In-memory store for the layer dashboard's current
 * service/instance/endpoint selection.
 *
 * Lifecycle: **per layer**. The selection survives intra-layer
 * navigation (switching between the Service / Instance / Endpoint /
 * Trace / Logs / Topology tabs in the sidebar) so the operator's
 * pick is sticky while they explore that layer. When the operator
 * leaves to a different layer, the store resets — the previous
 * layer's service id is meaningless on the new layer's roster, and
 * carrying it over fired a stale "service not found" modal.
 *
 * URL deep-linking: a layer URL with `?service=<id>` (and optionally
 * `?instance=` / `?endpoint=`) seeds the store on entry. The seed
 * is read once per layer change — switching tabs within the layer
 * doesn't re-read. The downstream auto-pick watch waits for the
 * FULL service roster to load and silently swaps to the first
 * available service only if the URL-seeded id isn't in the layer.
 * Stale-id "service not found" modals are gone.
 *
 * No localStorage persistence — refreshing starts fresh, reading
 * the URL's query params if present.
 */

import { defineStore } from 'pinia';
import { ref } from 'vue';

function pickQueryString(v: unknown): string | null {
  if (typeof v !== 'string' || v.length === 0) return null;
  return v;
}

export const useLayerSelectionStore = defineStore('layer-selection', () => {
  const service = ref<string | null>(null);
  const instance = ref<string | null>(null);
  const endpoint = ref<string | null>(null);
  /** Key of the LAYER the store currently holds selection for.
   *  Cross-layer transitions reset; intra-layer scope/tab changes
   *  don't (the operator's pick stays sticky across tabs). */
  const ownerKey = ref<string | null>(null);

  /**
   * Bind the store to a layer + seed from the URL query. On layer
   * change, drops the previous pick and reads any
   * `?service=` / `?instance=` / `?endpoint=` deep-link from the
   * new URL. On the same layer (scope/tab change within), this is
   * a no-op — the operator's pick survives.
   */
  function resetForLayer(layerKey: string, query: Record<string, unknown>): void {
    if (ownerKey.value === layerKey) return;
    ownerKey.value = layerKey;
    service.value = pickQueryString(query.service);
    instance.value = pickQueryString(query.instance);
    endpoint.value = pickQueryString(query.endpoint);
  }

  /** Drop ownership entirely. Called from LayerShell.onBeforeUnmount
   *  so leaving the layer (to /alarms, settings, any non-layer route)
   *  clears the pick — coming back to the same layer then re-hydrates
   *  from URL instead of carrying the stale selection. */
  function clear(): void {
    ownerKey.value = null;
    service.value = null;
    instance.value = null;
    endpoint.value = null;
  }

  /**
   * Service pick. Default semantics drop the narrower picks because
   * the previous instance/endpoint belonged to the OLD service and
   * almost certainly won't exist on the new one. `keepNarrower`
   * preserves them — used by the auto-repair path so a URL-hint
   * survives the first-visit service auto-fill (`current === null`).
   */
  function setService(id: string | null, opts: { keepNarrower?: boolean } = {}): void {
    if (id === service.value) return;
    const current = service.value;
    service.value = id;
    if (current !== null && !opts.keepNarrower) {
      instance.value = null;
      endpoint.value = null;
    }
  }
  function setInstance(name: string | null): void {
    if (name === instance.value) return;
    instance.value = name;
  }
  function setEndpoint(name: string | null): void {
    if (name === endpoint.value) return;
    endpoint.value = name;
  }

  return {
    service,
    instance,
    endpoint,
    ownerKey,
    resetForLayer,
    clear,
    setService,
    setInstance,
    setEndpoint,
  };
});
