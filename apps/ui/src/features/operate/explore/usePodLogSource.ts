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

import { computed, onUnmounted, ref, watch, type Ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { bff } from '@/api/client';
import type { PodLogsRequest } from '@/api/scopes/log';
import { serviceRef, type ServiceRef } from '@/utils/serviceRef';
import type { useLayers } from '@/shell/useLayers';

type AvailableLayers = ReturnType<typeof useLayers>['availableLayers'];

export interface PodLogRequestSnapshot {
  generation: number;
  layer: string;
  serviceArg: string;
  intervalSeconds: number;
  body: PodLogsRequest;
}

export interface PodLogSourceDeps {
  /** Active log source — cascades gate on this being `pods`. */
  logSource: Ref<string>;
  availableLayers: AvailableLayers;
  // Shared entity refs (from useExploreEntity) the pod cascade drives.
  pickLayer: Ref<string>;
  pickServiceId: Ref<string>;
  /** Name of the picked service — the other half of `pickServiceId`, from the
   *  same roster row. */
  pickServiceName: Ref<string>;
  pickInstanceId: Ref<string>;
  instances: Ref<Array<{ id: string; name: string }>>;
  // Shared raw/browser loaders the pickLayer / pickServiceId cascade fans to.
  loadServices: () => Promise<void>;
  loadInstances: () => Promise<void>;
  loadEndpoints: () => Promise<void>;
  /** Abandons the raw cascade's in-flight requests. `instances` is shared with
   *  the pods cascade, so a raw load still in flight when the operator switches
   *  to pods would otherwise publish its rows into the pod dropdown. */
  invalidateEntityRequests: () => void;
}

export function usePodLogSource(deps: PodLogSourceDeps) {
  const { t } = useI18n();
  const { logSource, availableLayers, pickLayer, pickServiceId, pickServiceName, pickInstanceId, instances } = deps;

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
  let podInstancesRequestGeneration = 0;
  let containersRequestGeneration = 0;
  let podLogRequestGeneration = 0;
  let activePodLogRequestGeneration: number | null = null;

  function invalidatePodInstancesRequest(): void {
    podInstancesRequestGeneration += 1;
    podInstancesLoading.value = false;
  }

  function invalidateContainersRequest(): void {
    containersRequestGeneration += 1;
    containersLoading.value = false;
  }

  /** Orphan an outstanding log fetch. The transport may still resolve, but
   *  its generation can no longer publish into the current pod pane. */
  function invalidatePodLogRequest(): void {
    podLogRequestGeneration += 1;
    activePodLogRequestGeneration = null;
  }

  function currentPodServiceKey(): string {
    if (podEntityMode.value === 'pick') {
      return `pick\u0000${pickLayer.value}\u0000${pickServiceId.value}\u0000${pickServiceName.value}`;
    }
    return `type\u0000${podLayers.value[0]?.key ?? ''}\u0000${podTypeService.value.trim()}\u0000${podTypeReal.value ? '1' : '0'}`;
  }

  function sameOptionalList(a: string[] | undefined, b: string[]): boolean {
    if (a === undefined) return b.length === 0;
    return a.length === b.length && a.every((value, index) => value === b[index]);
  }
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

  /** Capture every input for one pod-log request and serialize polling for
   *  that exact input generation. A re-target creates a new generation, so
   *  it can run immediately while an orphaned old request winds down. */
  function beginPodLogRequest(): PodLogRequestSnapshot | null {
    const layer = podFetchLayer.value;
    const serviceInstanceId = pickInstanceId.value;
    const container = podContainer.value;
    if (logSource.value !== 'pods' || !layer || !serviceInstanceId || !container) return null;
    const generation = podLogRequestGeneration;
    if (activePodLogRequestGeneration === generation) return null;
    activePodLogRequestGeneration = generation;
    return {
      generation,
      layer,
      serviceArg: podServiceArg.value,
      intervalSeconds: podIntervalSeconds.value,
      body: {
        serviceInstanceId,
        container,
        windowSeconds: podWindowSeconds.value,
        ...(podIncludes.value.length > 0 ? { keywordsOfContent: [...podIncludes.value] } : {}),
        ...(podExcludes.value.length > 0 ? { excludingKeywordsOfContent: [...podExcludes.value] } : {}),
      },
    };
  }

  function isPodLogRequestCurrent(request: PodLogRequestSnapshot): boolean {
    return request.generation === podLogRequestGeneration
      && logSource.value === 'pods'
      && request.layer === podFetchLayer.value
      && request.serviceArg === podServiceArg.value
      && request.intervalSeconds === podIntervalSeconds.value
      && request.body.serviceInstanceId === pickInstanceId.value
      && request.body.container === podContainer.value
      && request.body.windowSeconds === podWindowSeconds.value
      && sameOptionalList(request.body.keywordsOfContent, podIncludes.value)
      && sameOptionalList(request.body.excludingKeywordsOfContent, podExcludes.value);
  }

  function finishPodLogRequest(request: PodLogRequestSnapshot): void {
    if (activePodLogRequestGeneration === request.generation) activePodLogRequestGeneration = null;
  }

  /** Encode a typed service name to an OAP service id (base64 of the UTF-8
   *  name + the real flag — `IDManager.ServiceID.buildId`). Type mode sends it
   *  in the route's `serviceId` slot, which is taken as an id with no per-layer
   *  roster lookup — which is why Type needs no layer. */
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
    const generation = ++podInstancesRequestGeneration;
    podInstancesLoading.value = false;
    invalidateContainersRequest();
    invalidatePodLogRequest();
    instances.value = [];
    pickInstanceId.value = '';
    podContainer.value = '';
    podContainers.value = [];
    containersError.value = null;
    // Both modes hold the whole identity — Pick from the roster row, Type from
    // the typed name plus the real flag the operator set, which is exactly what
    // the id encodes. The layer key then only has to exist, which is why Type
    // mode works under any caps.podLogs layer.
    let layer: string | undefined;
    let service: ServiceRef | null;
    if (podEntityMode.value === 'pick') {
      layer = pickLayer.value;
      service = serviceRef(pickServiceId.value, pickServiceName.value);
    } else {
      const name = podTypeService.value.trim();
      layer = podLayers.value[0]?.key;
      service = serviceRef(name ? encodePodServiceId(name, podTypeReal.value) : '', name, podTypeReal.value);
    }
    if (!layer || !service) return;
    const serviceKey = currentPodServiceKey();
    podInstancesLoading.value = true;
    try {
      const res = await bff.layer.instances(layer, service);
      if (
        generation !== podInstancesRequestGeneration
        || logSource.value !== 'pods'
        || serviceKey !== currentPodServiceKey()
      ) return;
      instances.value = res.reachable ? res.instances : [];
      // Single pod → auto-pin it (the common single-replica case); the
      // `pickInstanceId` watch then lists its containers.
      if (instances.value.length === 1) pickInstanceId.value = instances.value[0]!.id;
    } catch {
      if (
        generation !== podInstancesRequestGeneration
        || logSource.value !== 'pods'
        || serviceKey !== currentPodServiceKey()
      ) return;
      instances.value = [];
    } finally {
      if (generation === podInstancesRequestGeneration) podInstancesLoading.value = false;
    }
  }

  async function loadContainers(): Promise<void> {
    const generation = ++containersRequestGeneration;
    containersLoading.value = false;
    invalidatePodLogRequest();
    podContainer.value = '';
    podContainers.value = [];
    containersError.value = null;
    const id = pickInstanceId.value;
    const layer = podFetchLayer.value;
    if (!layer || !id) return;
    containersLoading.value = true;
    try {
      const r = await bff.log.podContainers(layer, id);
      if (
        generation !== containersRequestGeneration
        || logSource.value !== 'pods'
        || layer !== podFetchLayer.value
        || id !== pickInstanceId.value
      ) return;
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
      if (
        generation !== containersRequestGeneration
        || logSource.value !== 'pods'
        || layer !== podFetchLayer.value
        || id !== pickInstanceId.value
      ) return;
      containersError.value = e instanceof Error ? e.message : String(e);
    } finally {
      if (generation === containersRequestGeneration) containersLoading.value = false;
    }
  }

  // The shared cascade serves two sources with different downstreams:
  //  · raw/browser → service list, then instances + endpoints.
  //  · pods        → service list (Pick mode), then pods (instances), then
  //                  containers; no endpoints.
  // Each cascade gates on the active source so the wrong downstream never
  // fires (loading pod containers for a browser service, etc.).
  watch(pickLayer, () => {
    invalidatePodInstancesRequest();
    invalidateContainersRequest();
    invalidatePodLogRequest();
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
    invalidatePodInstancesRequest();
    invalidateContainersRequest();
    invalidatePodLogRequest();
    pickServiceId.value = '';
    podTypeService.value = '';
    instances.value = [];
    pickInstanceId.value = '';
    podContainer.value = '';
    podContainers.value = [];
    containersError.value = null;
  });

  // A log reply belongs to the complete target + condition, not merely the
  // selected container. Invalidate it on every input that changes what the
  // operator believes the result represents.
  watch(
    [logSource, podFetchLayer, podServiceArg, pickInstanceId, podContainer, podWindowSeconds, podIntervalSeconds],
    invalidatePodLogRequest,
  );
  watch([podIncludes, podExcludes], invalidatePodLogRequest, { deep: true });
  watch(logSource, (next, prev) => {
    invalidatePodInstancesRequest();
    invalidateContainersRequest();
    // Only when the shared entity picker is actually being reset, which the
    // view does exactly when pods is on one side of the switch. Between raw
    // and browser the picker is deliberately preserved, so orphaning its
    // in-flight request there would leave it empty with its "Reading…" gone
    // and nothing to restart it.
    if (next === 'pods' || prev === 'pods') deps.invalidateEntityRequests();
  });

  onUnmounted(() => {
    invalidatePodInstancesRequest();
    invalidateContainersRequest();
    invalidatePodLogRequest();
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
    beginPodLogRequest,
    isPodLogRequestCurrent,
    finishPodLogRequest,
    invalidatePodLogRequest,
  };
}
