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
 * The Kubernetes Pod logs SOURCE controls for Log inspect — a specific pod
 * (instance) + container, scoped to a `caps.podLogs` layer. The SERVICE
 * field has its own Pick/Type toggle (Pod + Container stay dropdowns either
 * way): in Pick mode the service is chosen from the layer's catalog (→ the
 * shared `pickServiceId`); in Type mode the operator types a service name (→
 * `podTypeService`), which the instances route resolves per-layer. The
 * instance IS the pod; the container list is lazy-loaded from the pod's id.
 * No endpoint — a pod log scopes to one container.
 *
 * This composable owns the pod-form state + its cascade (service → pods →
 * containers), the trailing-window / interval / include-exclude condition,
 * and the option lists. It drives the SHARED entity refs (`instances`,
 * `pickServiceId`, `pickInstanceId`) so the pod and raw/browser sources reuse
 * one cascade spine; the cascade watches gate on the active `logSource` so
 * the wrong downstream never fires (loading pod containers for a browser
 * service, etc.). The live-tail engine + the actual fetch stay in the view.
 */

import { computed, ref, watch, type Ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { bff } from '@/api/client';
import type { useLayers } from '@/shell/useLayers';

type AvailableLayers = ReturnType<typeof useLayers>['availableLayers'];

export interface PodLogSourceDeps {
  /** Active log source — cascades gate on this being `pods`. */
  logSource: Ref<string>;
  availableLayers: AvailableLayers;
  // Shared entity refs (from useExploreEntity) the pod cascade drives.
  pickLayer: Ref<string>;
  pickServiceId: Ref<string>;
  pickInstanceId: Ref<string>;
  instances: Ref<Array<{ id: string; name: string }>>;
  // Shared raw/browser loaders the pickLayer / pickServiceId cascade fans to.
  loadServices: () => Promise<void>;
  loadInstances: () => Promise<void>;
  loadEndpoints: () => Promise<void>;
}

export function usePodLogSource(deps: PodLogSourceDeps) {
  const { t } = useI18n();
  const { logSource, availableLayers, pickLayer, pickServiceId, pickInstanceId, instances } = deps;

  type PodEntityMode = 'pick' | 'type';
  const podEntityMode = ref<PodEntityMode>('pick');
  const podTypeService = ref<string>('');
  // Real flag for the typed service. Pod logs are real-only in practice
  // (a virtual/peer service has no pods), so this defaults to real.
  const podTypeReal = ref(true);
  const podContainer = ref<string>('');
  const podContainers = ref<string[]>([]);
  const containersLoading = ref(false);
  const containersError = ref<string | null>(null);

  const podInstancesLoading = ref(false);
  // Pods service identity for the instances route: a picked OAP service-id
  // (Pick) or the typed name (Type). Both resolve per-layer server-side.
  const podServiceArg = computed(() =>
    podEntityMode.value === 'pick' ? pickServiceId.value : podTypeService.value.trim(),
  );

  // ── pods condition — a trailing SECOND-precision window (live tail), in
  // seconds. Reuses the per-layer Pod Logs window + interval options. No
  // cold-stage: pod logs are never persisted. ─────────────────────────────
  const podWindowSeconds = ref<number>(60);
  const podIntervalSeconds = ref<number>(5);
  // Include / Exclude are RAW regex (no `.*…*` wrap — the operator types the
  // regex), passed verbatim as keywordsOfContent / excludingKeywordsOfContent,
  // exactly like the per-layer Pod Logs tab.
  const podIncludes = ref<string[]>([]);
  const podExcludes = ref<string[]>([]);
  const podIncludeInput = ref('');
  const podExcludeInput = ref('');
  function addPodInclude(): void {
    const v = podIncludeInput.value.trim();
    if (v && !podIncludes.value.includes(v)) podIncludes.value = [...podIncludes.value, v];
    podIncludeInput.value = '';
  }
  function removePodInclude(i: number): void {
    podIncludes.value = podIncludes.value.filter((_, idx) => idx !== i);
  }
  function addPodExclude(): void {
    const v = podExcludeInput.value.trim();
    if (v && !podExcludes.value.includes(v)) podExcludes.value = [...podExcludes.value, v];
    podExcludeInput.value = '';
  }
  function removePodExclude(i: number): void {
    podExcludes.value = podExcludes.value.filter((_, idx) => idx !== i);
  }

  // `caps.podLogs` marks K8s-deployed layers (k8s_service / mesh — the same
  // flag that gates the per-layer Pod Logs tab). The pods Layer dropdown lists
  // EVERY layer (the layer is cosmetic on the pod-log wire, so operators may
  // pick any); this narrower set only auto-defaults the Pick layer when exactly
  // one such layer exists.
  const podLayers = computed(() => availableLayers.value.filter((l) => l.caps?.podLogs));
  // The layer key for the pod-log fetches: the picked layer in Pick mode; in
  // Type mode the Layer field is hidden, so fall back to any caps.podLogs layer.
  // OAP resolves the pod by its instance id, not the layer (the BFF only checks
  // the key's shape), so any pod-log layer works — without this, Type mode
  // dead-ends whenever more than one caps.podLogs layer exists.
  const podFetchLayer = computed(() =>
    podEntityMode.value === 'pick' ? pickLayer.value : (podLayers.value[0]?.key ?? ''),
  );

  /** Encode a typed service name to an OAP service id (base64 of the UTF-8
   *  name + the real flag). Type mode sends this so the instances route's
   *  id-passthrough resolves the pods without a per-layer name lookup,
   *  which is why Type needs no layer. */
  function encodePodServiceId(name: string, real: boolean): string {
    const bytes = new TextEncoder().encode(name);
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return `${btoa(bin)}.${real ? 1 : 0}`;
  }

  /** Load the pod (instance) list for the chosen/typed service of the pods
   *  source, scoped to its `caps.podLogs` layer. Cascade-clears the pod +
   *  container picks first so a stale pod never sits under the new list. */
  async function loadPodInstances(): Promise<void> {
    instances.value = [];
    pickInstanceId.value = '';
    podContainer.value = '';
    podContainers.value = [];
    containersError.value = null;
    // Pick resolves the service within the chosen layer. Type needs no layer:
    // the typed name is encoded to a service id, and the instances route
    // ignores the layer key for an id, so any caps.podLogs layer works.
    let layer: string | undefined;
    let arg: string;
    if (podEntityMode.value === 'pick') {
      layer = pickLayer.value;
      arg = pickServiceId.value;
    } else {
      const name = podTypeService.value.trim();
      layer = podLayers.value[0]?.key;
      arg = name ? encodePodServiceId(name, podTypeReal.value) : '';
    }
    if (!layer || !arg) return;
    podInstancesLoading.value = true;
    try {
      const res = await bff.layer.instances(layer, arg);
      instances.value = res.reachable ? res.instances : [];
      // Single pod → auto-pin it (the common single-replica case); the
      // `pickInstanceId` watch then lists its containers.
      if (instances.value.length === 1) pickInstanceId.value = instances.value[0]!.id;
    } catch {
      instances.value = [];
    } finally {
      podInstancesLoading.value = false;
    }
  }

  async function loadContainers(): Promise<void> {
    podContainer.value = '';
    podContainers.value = [];
    containersError.value = null;
    const id = pickInstanceId.value;
    const layer = podFetchLayer.value;
    if (!layer || !id) return;
    containersLoading.value = true;
    try {
      const r = await bff.log.podContainers(layer, id);
      if (r.errorReason) {
        containersError.value = r.errorReason;
      } else if (!r.reachable) {
        containersError.value = r.error ?? t('OAP unreachable');
      } else {
        podContainers.value = r.containers;
        // Auto-pick the first container (OAP lists the app container first).
        podContainer.value = r.containers[0] ?? '';
      }
    } catch (e) {
      containersError.value = e instanceof Error ? e.message : String(e);
    } finally {
      containersLoading.value = false;
    }
  }

  // The shared cascade serves two sources with different downstreams:
  //  · raw/browser → service list, then instances + endpoints.
  //  · pods        → service list (Pick mode), then pods (instances), then
  //                  containers; no endpoints.
  // Each cascade gates on the active source so the wrong downstream never
  // fires (loading pod containers for a browser service, etc.).
  watch(pickLayer, () => {
    // pods Pick reloads its service list here; pods Type ignores the layer
    // (it encodes the name to an id), so no pods-specific branch is needed.
    void deps.loadServices();
  });
  watch(pickServiceId, () => {
    if (logSource.value === 'pods') {
      if (podEntityMode.value === 'pick') void loadPodInstances();
      return;
    }
    void deps.loadInstances();
    void deps.loadEndpoints();
  });
  // Type mode: the typed name + real flag encode to a service id → resolve pods.
  watch([podTypeService, podTypeReal], () => {
    if (logSource.value === 'pods' && podEntityMode.value === 'type') void loadPodInstances();
  });
  // Only the pods source needs containers — fetch when its pinned pod
  // changes (operator pick OR the single-pod auto-pin in loadPodInstances).
  // Entering pods always wipes the shared entity, so a pod can only ever be
  // set from within the pods cascade — no "carried-in pod" case to handle.
  watch(pickInstanceId, () => {
    if (logSource.value === 'pods') void loadContainers();
  });
  // Pick↔Type for the pods service is a fresh start: drop the service in
  // both representations + the downstream pod / container so neither mode
  // inherits the other's pick. The layer stays (Type still needs one).
  watch(podEntityMode, () => {
    pickServiceId.value = '';
    podTypeService.value = '';
    instances.value = [];
    pickInstanceId.value = '';
    podContainer.value = '';
    podContainers.value = [];
    containersError.value = null;
  });

  const podContainerOptions = computed(() => podContainers.value.map((c) => ({ value: c, label: c })));
  // Pods source: the instance is REQUIRED (it is the pod), so no "All
  // instances" sentinel row — just the raw instance list.
  const podInstanceOptions = computed(() => instances.value.map((i) => ({ value: i.id, label: i.name })));
  const podInstanceSel = computed<string>({ get: () => pickInstanceId.value, set: (v) => (pickInstanceId.value = v ?? '') });

  return {
    podEntityMode,
    podTypeService,
    podTypeReal,
    podContainer,
    podContainers,
    containersLoading,
    containersError,
    podInstancesLoading,
    podServiceArg,
    podWindowSeconds,
    podIntervalSeconds,
    podIncludes,
    podExcludes,
    podIncludeInput,
    podExcludeInput,
    addPodInclude,
    removePodInclude,
    addPodExclude,
    removePodExclude,
    podLayers,
    podFetchLayer,
    podContainerOptions,
    podInstanceOptions,
    podInstanceSel,
  };
}
