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

/** The three lockable entity scopes for multi-entity cross-check. */
export type CompareScope = 'service' | 'instance' | 'endpoint';

/** Hard cap on the active comparison set — matches the six-hue
 *  `ENTITY_PALETTE` so every locked entity gets a distinct color. */
export const MAX_LOCKED = 6;

/** Instance/endpoint locks are CROSS-SERVICE: a pin carries its service
 *  so pins from different services compare together. Each is stored as a
 *  compound `service<SEP>name` key; `compoundKey`/`splitCompound` encode
 *  and decode it. (Service-scope locks are plain service ids.) */
const CK_SEP = '\u0001';
export function compoundKey(service: string, name: string): string {
  return `${service}${CK_SEP}${name}`;
}
export function splitCompound(key: string): { service: string; name: string } {
  const i = key.indexOf(CK_SEP);
  return i < 0 ? { service: '', name: key } : { service: key.slice(0, i), name: key.slice(i + 1) };
}

export const useLayerSelectionStore = defineStore('layer-selection', () => {
  const service = ref<string | null>(null);
  const instance = ref<string | null>(null);
  const endpoint = ref<string | null>(null);
  /** Key of the LAYER the store currently holds selection for.
   *  Cross-layer transitions reset; intra-layer scope/tab changes
   *  don't (the operator's pick stays sticky across tabs). */
  const ownerKey = ref<string | null>(null);

  // --- Multi-entity lock (cross-check) state ---
  // `lockedServices` = service-scope set (service ids). `lockedInstances`
  // / `lockedEndpoints` = CROSS-SERVICE sets of compound `service<SEP>
  // name` keys, so pins from different services stay locked together and
  // compare side by side. Every read goes through `activeCompareSet`.
  const lockedServices = ref<string[]>([]);
  const lockedInstances = ref<string[]>([]);
  const lockedEndpoints = ref<string[]>([]);

  /**
   * Bind the store to a layer + seed from the URL query. On layer
   * change, drops the previous pick and reads any
   * `?service=` / `?instance=` / `?endpoint=` deep-link from the
   * new URL. On the same layer (scope/tab change within), this is
   * a no-op — the operator's pick survives.
   */
  function resetForLayer(layerKey: string, query: Record<string, unknown>): void {
    const hasSeed =
      query.service != null || query.instance != null || query.endpoint != null;
    // Same layer + NO deep-link params → keep the sticky pick (scope/tab
    // nav within the layer). Same layer WITH params (a deep link into the
    // layer the operator is already on) DOES re-seed, otherwise the new
    // ?service/?instance/?endpoint would be silently ignored.
    if (ownerKey.value === layerKey && !hasSeed) return;
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
    lockedServices.value = [];
    lockedInstances.value = [];
    lockedEndpoints.value = [];
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

  // The compound-key list backing a non-service scope.
  function listRefFor(scope: CompareScope) {
    if (scope === 'service') return lockedServices;
    return scope === 'instance' ? lockedInstances : lockedEndpoints;
  }
  function addOrRemove(scope: CompareScope, key: string): void {
    const r = listRefFor(scope);
    if (r.value.includes(key)) r.value = r.value.filter((k) => k !== key);
    else if (r.value.length < MAX_LOCKED) r.value = [...r.value, key];
  }

  /** Toggle a lock on `name` at `scope`, from the picker / row list.
   *  Service scope toggles the service id; instance/endpoint toggle the
   *  compound (CURRENT primary service, name) so a pin remembers which
   *  service it belongs to and pins of DIFFERENT services coexist.
   *  Cap-guarded at MAX_LOCKED; instance/endpoint no-op without a
   *  primary service. */
  function toggleLock(scope: CompareScope, name: string): void {
    if (!name) return;
    if (scope === 'service') {
      addOrRemove('service', name);
      return;
    }
    const primary = service.value;
    if (!primary) return;
    addOrRemove(scope, compoundKey(primary, name));
  }

  /** Remove an EXACT locked key — used by the cohort chip's ×, where the
   *  key may belong to a service other than the current primary. */
  function removeKey(scope: CompareScope, key: string): void {
    const r = listRefFor(scope);
    r.value = r.value.filter((k) => k !== key);
  }

  /** Is `name` locked at `scope` under the CURRENT primary service (for
   *  instance/endpoint)? Drives the picker / row pin state. */
  function isLocked(scope: CompareScope, name: string): boolean {
    if (scope === 'service') return lockedServices.value.includes(name);
    const primary = service.value;
    if (!primary) return false;
    return listRefFor(scope).value.includes(compoundKey(primary, name));
  }

  function clearLocks(scope: CompareScope): void {
    listRefFor(scope).value = [];
  }

  /** THE read seam — the locked set for a scope. Service ids for service
   *  scope; cross-service compound `service<SEP>name` keys for
   *  instance/endpoint (decode with `splitCompound`). */
  function activeCompareSet(scope: CompareScope): string[] {
    return listRefFor(scope).value;
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
    // Multi-entity lock. App code reads through activeCompareSet(scope)
    // + isLocked()/toggleLock()/removeKey(); the raw lists are exposed
    // for devtools + unit tests only.
    lockedServices,
    lockedInstances,
    lockedEndpoints,
    toggleLock,
    removeKey,
    isLocked,
    clearLocks,
    activeCompareSet,
  };
});
