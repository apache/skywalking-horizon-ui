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
 * Endpoint picker cascade for the per-layer Endpoint scope. Same shape as
 * the instance cascade, plus a keyword search box driving findEndpoint(...)
 * (top 20…50, Enter-committed) and a targeted name lookup that validates a
 * deep-linked endpoint sitting outside the recent top-N. Owns its watch
 * lifecycle (auto-torn-down with the host component).
 */

import { computed, ref, watch, watchEffect, type ComputedRef, type Ref } from 'vue';
import { useLayerEndpoints } from '@/layer/useLayerEndpoints';
import { useSelectedEndpoint } from '@/layer/useSelectedEndpoint';
import { pushEvent } from '@/controls/eventLog';
import { MAX_LOCKED } from '@/state/layerSelection';

export function useEndpointCascade(
  layerKey: Ref<string>,
  scope: ComputedRef<string>,
  serviceName: ComputedRef<string | null>,
  selectedId: ComputedRef<string | null>,
  landingRows: ComputedRef<Array<{ serviceId: string }>>,
  setSelectedService: (id: string) => void,
) {
  const {
    selectedEndpoint,
    setSelectedEndpoint,
    lockedEndpointNames,
    toggleLockEndpoint,
    isEndpointLocked,
  } = useSelectedEndpoint();
  /** Live text in the input — bound via v-model. */
  const endpointSearchInput = ref('');
  /** Committed keyword that actually drives the BFF query. Updated on
   *  Enter / blur via submitEndpointSearch(). */
  const endpointQuery = ref('');
  const endpointLimit = ref(20);
  function submitEndpointSearch(): void {
    endpointQuery.value = endpointSearchInput.value.trim();
  }
  function clearEndpointSearch(): void {
    endpointSearchInput.value = '';
    endpointQuery.value = '';
  }
  // Same cascade-strict rule as instance list — endpoint list
  // waits for `serviceName` (post-landing), not the URL handle.
  const { endpoints: endpointList, isFetching: endpointsLoading } = useLayerEndpoints(
    layerKey,
    serviceName,
    endpointQuery,
    endpointLimit,
  );
  // URL-pinned endpoint validation. The list above is the recent top-N
  // (empty query); a deep-linked endpoint outside it would look "stale".
  // This re-queries by the pinned endpoint's own name to confirm it really
  // exists for this service before we discard the deep link. Inactive
  // (empty query) once the pin is null or already present in the default list.
  const pinnedEndpointQuery = computed(() => {
    const pinned = selectedEndpoint.value;
    if (!pinned) return '';
    return endpointList.value.some((e) => e.name === pinned) ? '' : pinned;
  });
  const { endpoints: pinnedEndpointMatches, isFetching: pinnedEndpointLoading } =
    useLayerEndpoints(layerKey, serviceName, pinnedEndpointQuery, endpointLimit);
  // Endpoint-scope orchestration — explicit sequence so the loading
  // flow is deterministic:
  //   1. wait for landing rows
  //   2. pick the first service when none is selected
  //   3. wait for that service's endpoint list to arrive (`endpointQuery`
  //      starts empty → BFF returns the recent top-N immediately)
  //   4. pick the first endpoint when none is selected
  // `watchEffect` re-fires on each dependency change and the early
  // `return` after step 2 ensures we don't try to pick an endpoint
  // before `serviceName` has propagated to `useLayerEndpoints` and the
  // list has refreshed for the new service.
  watchEffect(() => {
    if (scope.value !== 'endpoint') return;
    if (!selectedId.value) {
      const first = landingRows.value[0];
      if (first) setSelectedService(first.serviceId);
      return;
    }
    if (endpointsLoading.value) return;
    const list = endpointList.value;
    if (list.length === 0) return;
    // Quiet default (no URL pick) vs noted fallback (URL endpoint not
    // in the resolved list — log a debug event so the operator sees
    // the fallback).
    if (!selectedEndpoint.value) {
      setSelectedEndpoint(list[0].name);
      return;
    }
    if (!list.some((e) => e.name === selectedEndpoint.value)) {
      // Outside the default top-N — confirm via the targeted name search
      // before discarding the deep link.
      if (pinnedEndpointQuery.value && pinnedEndpointLoading.value) return; // wait for the lookup
      if (pinnedEndpointMatches.value.some((e) => e.name === selectedEndpoint.value)) return; // valid → keep
      pushEvent(
        'fallback',
        'info',
        `URL endpoint "${selectedEndpoint.value}" not found in ${serviceName.value} · falling back to "${list[0].name}"`,
      );
      setSelectedEndpoint(list[0].name);
    }
  });
  // Drop stale endpoint when service ACTUALLY changes — same rule as
  // the instance counterpart above: the `null → name` landing-resolution
  // transition must not clear the URL `?endpoint=`.
  watch(serviceName, (next, prev) => {
    if (!prev || !next) return;
    if (next !== prev && selectedEndpoint.value) {
      setSelectedEndpoint(null);
    }
  });
  // Default-selection of the first endpoint happens inside the
  // `watchEffect` above so the service → endpoint sequence is
  // deterministic; no separate watch needed here.

  const effectiveEndpoint = computed<string | null>(() => {
    const v = selectedEndpoint.value;
    if (!v) return null;
    // Valid if in the default top-N OR confirmed by the targeted name lookup
    // (a deep-linked endpoint outside the recent list) — otherwise the
    // dashboard would stay gated forever for a perfectly valid pin.
    if (endpointList.value.some((e) => e.name === v)) return v;
    if (pinnedEndpointMatches.value.some((e) => e.name === v)) return v;
    return null;
  });
  const endpointResolvable = computed<boolean>(
    () =>
      endpointsLoading.value ||
      pinnedEndpointLoading.value ||
      endpointList.value.length > 0 ||
      !!effectiveEndpoint.value,
  );
  const epAtCap = computed(() => lockedEndpointNames.value.length >= MAX_LOCKED);

  return {
    selectedEndpoint,
    setSelectedEndpoint,
    lockedEndpointNames,
    toggleLockEndpoint,
    isEndpointLocked,
    endpointSearchInput,
    endpointQuery,
    endpointLimit,
    submitEndpointSearch,
    clearEndpointSearch,
    endpointList,
    endpointsLoading,
    effectiveEndpoint,
    endpointResolvable,
    epAtCap,
  };
}
