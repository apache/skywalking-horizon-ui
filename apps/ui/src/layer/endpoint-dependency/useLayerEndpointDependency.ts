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
 * vue-query wrapper around `GET /api/layer/:key/endpoint-dependency`.
 * The query is disabled until both a service AND an endpoint name
 * have been picked.
 */

import { computed, type Ref } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import type { EndpointDependencyCall, EndpointDependencyNode, EndpointDependencyResponse } from '@skywalking-horizon-ui/api-client';
import { useAutoRefreshSubscribe } from '@/controls/useAutoRefreshSubscribe';
import { useRefreshErrorReport } from '@/controls/errorCenter';
import {
  windowOf,
  useRoundWindow,
  anchorForMount,
  predicateKey,
  predicateService,
  fetchDrawable,
  useGraphState,
  useTimeIdentity,
  useTriggeredRefetch,
  type GraphPredicate,
} from '@/layer/graphQuery';
import { useColdStageStore } from '@/controls/coldStage';
import { stepForMinutes } from '../../controls/timeRange';
import { usePreviewLayerBlock } from '@/controls/previewConfig';
import { bffClient } from '@/api/client';
import type { ServiceRef } from '@/utils/serviceRef';

export function useLayerEndpointDependency(
  layerKey: Ref<string>,
  service: Ref<ServiceRef | null>,
  endpoint: Ref<string | null>,
  /** Embedded (chat) override: when a positive minute count, the query owns its
   *  OWN frozen look-back window and does NOT follow the global topbar picker or
   *  auto-refresh ticker — the interactive route omits it. */
  windowMinutes?: Ref<number | null>,
  /** REPLAY mode: the captured chain to render from. Present ⇒ start with it and
   *  NEVER fetch, so a reload replays the SAME pinned endpoint chain offline. */
  replayData?: Ref<EndpointDependencyResponse | null>,
) {
  const replay = computed(() => !!replayData?.value);
  // A COMPUTED, not a one-time read. It decides which clock the whole query
  // follows — a frozen local window or the global picker — and the caller
  // supplies it as a ref that can change (an embedded block derives it from
  // its own props). Snapshotting it at setup left the query following
  // whichever source happened to be true on the first render.
  const ownsWindow = computed(() => (windowMinutes?.value ?? 0) > 0);
  // Preview-only: forward the draft `endpointDependency` block.
  const previewCfg = usePreviewLayerBlock(layerKey, 'endpointDependency');
  const cold = useColdStageStore();
  const roundWindow = useRoundWindow();
  const rangeKey = computed(() => {
    if (ownsWindow.value) {
      const min = windowMinutes!.value ?? 0;
      const endMs = Date.now();
      return { step: stepForMinutes(min), startMs: endMs - min * 60_000, endMs };
    }
    // The ROUND's window while a round is out, so every screen in one round
    // asks about the same one; the topbar's own otherwise.
    return roundWindow.value;
  });
  /**
   * Lifted out of the query so the ticker guard uses the SAME gate. A manual
   * `refetch()` bypasses `enabled`, so a subscription that re-derived the
   * condition could drift from it and fetch where the query would not.
   */
  const queryEnabled = computed(
    () =>
      layerKey.value.length > 0 &&
      !!service.value &&
      service.value.normal !== null &&
      service.value.normal !== undefined &&
      !!endpoint.value &&
      !replay.value,
  );
  const timeIdentity = useTimeIdentity(ownsWindow, rangeKey);
  const predicate = computed<GraphPredicate>(() => ({
    layer: layerKey.value,
    service: predicateService(service.value),
    endpoint: endpoint.value ?? null,
    time: timeIdentity.value,
    preview: previewCfg.value ?? null,
    cold: cold.enabled,
  }));
  const predicateKeyRef = computed(() => predicateKey(predicate.value));
  // BEFORE the query below: it fetches on mount, reading the window as it
  // stands then. Anchoring afterwards would leave that first request asking
  // about whenever the window was last moved.
  anchorForMount(ownsWindow);
  const q = useQuery({
    queryKey: ['layer-endpoint-dependency', predicateKeyRef],
    queryFn: ({ signal }) =>
      fetchDrawable(
        () =>
          bffClient.layer.endpointDependency(
            layerKey.value,
            service.value!,
            endpoint.value ?? '',
            rangeKey.value,
            previewCfg.value,
            signal,
          ),
        rangeKey.value,
      ),
    // The focus endpoint's own metrics are name-scoped MQE, so this read needs
    // the roster row's normal flag as well as the pair — it waits for the row
    // rather than sending a request the BFF must refuse.
    enabled: queryEnabled,
    staleTime: 0,
    // The ROUND decides when this fetches. Refetching on window focus as well
    // would fire outside any round: unattributed, uncounted by the countdown,
    // and capable of landing on top of a round already out.
    refetchOnWindowFocus: false,
    // Stated rather than inherited: a remount must ask again, whatever the
    // freshness rule above happens to be. The window it asks about is the one
    // `triggeredRefetch` re-anchors on the way in, not the one this cache
    // entry was built with.
    refetchOnMount: 'always',
  });
  // The ticker is now the refresh mechanism: the key no longer moves. Guarded,
  // because `refetch()` bypasses `enabled` — an unguarded subscription would
  // make replay blocks and frozen captures contact OAP.
  const triggeredRefetch = useTriggeredRefetch(() => q.refetch({ cancelRefetch: false }), ownsWindow);
  // Only what the TIMER could not read reaches the history — a first load
  // that fails already says so on the canvas.
  useRefreshErrorReport({ owner: 'Endpoint dependency', action: 'reading the endpoint dependency graph', error: q.error });
  // The component's own field: this screen takes part only when its query
  // would, and never when it owns a frozen window. The promise is RETURNED so
  // the round counts its next interval from when this settles.
  useAutoRefreshSubscribe(
    () => triggeredRefetch(),
    computed(() => queryEnabled.value && !ownsWindow.value),
    // Named so a capped round can cancel this query rather than only stop
    // waiting on it. Resolved on demand, because the key moves with the
    // predicate and the round cancels the one that is actually out.
    () => ['layer-endpoint-dependency', predicateKeyRef.value],
  );

  // Replay renders straight from the captured payload — NOT through the shared
  // query cache. Seeding initialData under the live query key would put a
  // frozen capture into the entry a live view reads from, so the two would
  // answer for each other — a snapshot shown as current, or a capture quietly
  // replaced by data taken after it.
  // The last GOOD response comes from the query cache, so it survives both a
  // failed round and a remount; `latestAttempt` is whatever came back last and
  // drives the banners. `phase` is derived from both so a view cannot read half
  // its picture from one and half from the other.
  const { acceptedSnapshot, latestAttempt, phase, predicateGeneration } =
    useGraphState<EndpointDependencyResponse>({
      data: q.data,
      error: q.error,
      isFetching: q.isFetching,
      // How the gate below tells a fresh answer from one the cache
      // still had for a predicate visited earlier.
      dataUpdatedAt: q.dataUpdatedAt,
      predicateKey: predicateKeyRef,
      enabled: queryEnabled,
      replay,
      ...(replayData ? { replayData } : {}),
    });
  /**
   * The window the graph ON SCREEN was read with, taken from the response
   * itself.
   *
   * Not tracked in a ref: on a remount the accepted snapshot comes from the
   * cache and can be minutes old, while a ref would have just been initialised
   * from the freshly anchored window — so an expansion started before the
   * refetch landed asked about the new window and merged it into the old
   * graph. Reading it off the response cannot drift, because it IS the
   * response's own. Falls back to the live window only when nothing was
   * recorded, which is the first paint before any read has landed.
   */
  const acceptedWindow = computed(() => {
    const remembered = windowOf(acceptedSnapshot.value);
    return (remembered ?? rangeKey.value) as {
      step: 'MINUTE' | 'HOUR' | 'DAY';
      startMs: number;
      endMs: number;
    };
  });

  return {
    data: latestAttempt,
    latestAttempt,
    phase,
    drawable: acceptedSnapshot,
    previewConfig: previewCfg,
    // The window the graph ON SCREEN was read with — not the live one.
    //
    // `rangeKey` is what the NEXT request will ask about, and the two part
    // company the moment a refresh fails: the accepted snapshot stays at W1
    // while the clock has moved to W2. An expansion is merged INTO that
    // snapshot, so taking the live window put a W2 branch inside a W1 graph —
    // silently, permanently, and with nothing on screen to say the picture was
    // assembled from two different windows.
    baseWindow: acceptedWindow,
    acceptedSnapshot,
    predicateGeneration,
    predicate,
    predicateKey: predicateKeyRef,
    nodes: computed<EndpointDependencyNode[]>(() => acceptedSnapshot.value?.nodes ?? []),
    calls: computed<EndpointDependencyCall[]>(() => acceptedSnapshot.value?.calls ?? []),
    initialPending: computed(() => phase.value === 'loading'),
    isLoading: q.isLoading,
    isFetching: q.isFetching,
    error: q.error,
    refetch: triggeredRefetch,
  };
}
