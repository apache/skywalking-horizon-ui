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
 * vue-query wrapper around `GET /api/layer/:key/deployment`.
 *
 * Drives the Deployment tab — the instance-to-instance call
 * graph within ONE service. Gated by `enabled` (a service is picked and the
 * view is active) so it only fires while the operator is looking at it.
 * Same topbar-picker queryKey + auto-refresh wiring as the service map.
 */

import { computed, type Ref } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import type { DeploymentCall, DeploymentNode, DeploymentResponse } from '@skywalking-horizon-ui/api-client';
import { useAutoRefreshSubscribe } from '@/controls/useAutoRefreshSubscribe';
import { useRefreshErrorReport } from '@/controls/errorCenter';
import {
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

export function useDeployment(
  layerKey: Ref<string>,
  service: Ref<ServiceRef | null>,
  enabled: Ref<boolean>,
  /** Embedded (chat) override: when a positive minute count, the query owns its
   *  OWN frozen look-back window and does NOT follow the global topbar picker or
   *  auto-refresh ticker — the interactive route omits it. */
  windowMinutes?: Ref<number | null>,
  /** REPLAY mode: the captured graph to render from. Present ⇒ start with it and
   *  NEVER fetch, so a reload replays the exact graph + edge series offline. */
  replayData?: Ref<DeploymentResponse | null>,
) {
  const replay = computed(() => !!replayData?.value);
  // A COMPUTED, not a one-time read. It decides which clock the whole query
  // follows — a frozen local window or the global picker — and the caller
  // supplies it as a ref that can change (an embedded block derives it from
  // its own props). Snapshotting it at setup left the query following
  // whichever source happened to be true on the first render.
  const ownsWindow = computed(() => (windowMinutes?.value ?? 0) > 0);
  const cold = useColdStageStore();
  // Preview-only: the draft top-level `deployment` block, so
  // the tab previews the operator's unpublished config.
  const previewCfg = usePreviewLayerBlock(layerKey, 'deployment');
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
  const isEnabled = computed(
    () => enabled.value && layerKey.value.length > 0 && !!service.value && !replay.value,
  );
  /** One name for the gate, so the query and the ticker guard cannot drift. */
  const queryEnabled = isEnabled;
  const timeIdentity = useTimeIdentity(ownsWindow, rangeKey);
  const predicate = computed<GraphPredicate>(() => ({
    layer: layerKey.value,
    service: predicateService(service.value),
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
    queryKey: ['layer-deployment', predicateKeyRef],
    queryFn: ({ signal }) =>
      fetchDrawable(() =>
        bffClient.layer.deployment(
          layerKey.value,
          service.value!,
          rangeKey.value,
          previewCfg.value,
          signal,
        ),
      ),
    enabled: isEnabled,
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
  useRefreshErrorReport({ owner: 'Deployment', action: 'reading the deployment graph', error: q.error });
  // The component's own field: this screen takes part only when its query
  // would, and never when it owns a frozen window. The promise is RETURNED so
  // the round counts its next interval from when this settles.
  useAutoRefreshSubscribe(
    () => triggeredRefetch(),
    computed(() => queryEnabled.value && !ownsWindow.value),
    // Named so a capped round can cancel this query rather than only stop
    // waiting on it. Resolved on demand, because the key moves with the
    // predicate and the round cancels the one that is actually out.
    () => ['layer-deployment', predicateKeyRef.value],
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
    useGraphState<DeploymentResponse>({
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
  return {
    data: latestAttempt,
    latestAttempt,
    phase,
    drawable: acceptedSnapshot,
    acceptedSnapshot,
    predicateGeneration,
    predicate,
    predicateKey: predicateKeyRef,
    nodes: computed<DeploymentNode[]>(() => acceptedSnapshot.value?.nodes ?? []),
    calls: computed<DeploymentCall[]>(() => acceptedSnapshot.value?.calls ?? []),
    initialPending: computed(() => phase.value === 'loading'),
    isLoading: q.isLoading,
    isFetching: q.isFetching,
    error: q.error,
    refetch: triggeredRefetch,
  };
}
