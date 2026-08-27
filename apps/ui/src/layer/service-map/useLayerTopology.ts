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
 * vue-query wrapper around `GET /api/layer/:key/topology`. The query
 * fires whenever the selected service, BFS depth, OR the global
 * topbar time picker changes — the picker is part of the queryKey so
 * the operator sees topology metrics that line up with whatever
 * window they're looking at (including cold-stage windows when the
 * Cold pill is on; the X-Horizon-Cold-Stage header is appended by
 * the api-client interceptor).
 */

import { computed, type Ref } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import type { TopologyCall, TopologyNode, TopologyResponse } from '@skywalking-horizon-ui/api-client';
import { stepForMinutes } from '../../controls/timeRange';
import { usePreviewLayerBlock } from '@/controls/previewConfig';
import { useColdStageStore } from '@/controls/coldStage';
import { bffClient } from '@/api/client';
import type { ServiceRef } from '@/utils/serviceRef';
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

export function useLayerTopology(
  layerKey: Ref<string>,
  /** Roster rows to seed the BFS from; empty seeds the whole layer. */
  services: Ref<ServiceRef[]>,
  depth: Ref<number>,
  /** Embedded (chat) override: when a positive minute count, the query owns its
   *  OWN window (a frozen look-back snapshot) and does NOT follow the global
   *  topbar picker or auto-refresh ticker — the interactive route omits it. */
  windowMinutes?: Ref<number | null>,
  /** REPLAY mode: the captured graph to render from. When present the query
   *  starts with it and NEVER fetches — a reloaded conversation replays the exact
   *  data (nodes+edges+series) with zero OAP round-trip, so it can't slide to a
   *  fresh window and survives an offline OAP. */
  replayData?: Ref<TopologyResponse | null>,
) {
  // replay mode is on whenever captured data is supplied.
  const replay = computed(() => !!replayData?.value);
  // A COMPUTED, not a one-time read. It decides which clock the whole query
  // follows — a frozen local window or the global picker — and the caller
  // supplies it as a ref that can change (an embedded block derives it from
  // its own props). Snapshotting it at setup left the query following
  // whichever source happened to be true on the first render.
  const ownsWindow = computed(() => (windowMinutes?.value ?? 0) > 0);
  const cold = useColdStageStore();
  // In `?mode=preview` only: forward the operator's draft `topology` block
  // so the map renders the unpublished edit. Empty otherwise — a normal
  // (absent-remote) read never carries a draft, keeping the two paths
  // cleanly separate.
  const previewCfg = usePreviewLayerBlock(layerKey, 'topology');
  // The window as the REQUEST states it — re-read whenever a request is made,
  // so a rolling window advances with the round that re-anchored it. What
  // identifies the cache entry is `timeIdentity` below, not this. In embedded
  // mode the triplet comes from the fixed windowMinutes (Date.now() captured
  // once — a frozen snapshot), so it never follows the global picker.
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
  // The QUESTION, not the clock. `rangeKey` below stays the request argument;
  // what identifies the cache entry is the preset (or the frozen/custom bounds,
  // which do not move). Keying on the moving bounds made every tick a cache
  // miss — which is what emptied the canvas on every refresh.
  const timeIdentity = useTimeIdentity(ownsWindow, rangeKey);
  const predicate = computed<GraphPredicate>(() => ({
    layer: layerKey.value,
    focus: services.value.map((s) => predicateService(s)).filter((s): s is NonNullable<typeof s> => s !== null),
    depth: depth.value,
    time: timeIdentity.value,
    preview: previewCfg.value ?? null,
    cold: cold.enabled,
  }));
  const predicateKeyRef = computed(() => predicateKey(predicate.value));
  const enabled = computed(() => layerKey.value.length > 0 && !replay.value);
  // BEFORE the query below: it fetches on mount, reading the window as it
  // stands then. Anchoring afterwards would leave that first request asking
  // about whenever the window was last moved.
  anchorForMount(ownsWindow);
  const q = useQuery({
    // Keyed on the predicate itself: one value, so the key, the reset watcher
    // and the request parameters cannot describe different questions.
    queryKey: ['layer-topology', predicateKeyRef],
    // The signal is vue-query's, and the refresh round cancels through it:
    // a round that hits its cap cancels this query, which aborts the request
    // rather than leaving it running under the next round's answers.
    queryFn: ({ signal }) =>
      fetchDrawable(() =>
        bffClient.layer.topology(
          layerKey.value,
          services.value,
          depth.value,
          rangeKey.value,
          previewCfg.value,
          signal,
        ),
      ),
    // Replay is static: never fetch (data comes from replayData below).
    enabled,
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
  // The ticker is now the refresh mechanism: the key no longer moves, so
  // nothing else would fetch. Guarded, because `refetch()` bypasses `enabled` —
  // an unguarded subscription would make replay blocks and frozen captures
  // contact OAP, which is exactly what `enabled` exists to prevent.
  const triggeredRefetch = useTriggeredRefetch(() => q.refetch({ cancelRefetch: false }), ownsWindow);
  // Only what the TIMER could not read reaches the history — a first load
  // that fails already says so on the canvas.
  useRefreshErrorReport({ owner: 'Service map', action: 'reading the service map', error: q.error });
  // The component's own field: this screen takes part only when its query
  // would, and never when it owns a frozen window. The promise is RETURNED so
  // the round counts its next interval from when this settles.
  useAutoRefreshSubscribe(
    () => triggeredRefetch(),
    computed(() => enabled.value && !ownsWindow.value),
    // Named so a capped round can cancel this query rather than only stop
    // waiting on it. Resolved on demand, because the key moves with the
    // predicate and the round cancels the one that is actually out.
    () => ['layer-topology', predicateKeyRef.value],
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
    useGraphState<TopologyResponse>({
      data: q.data,
      error: q.error,
      isFetching: q.isFetching,
      // How the gate below tells a fresh answer from one the cache
      // still had for a predicate visited earlier.
      dataUpdatedAt: q.dataUpdatedAt,
      predicateKey: predicateKeyRef,
      enabled,
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
    nodes: computed<TopologyNode[]>(() => acceptedSnapshot.value?.nodes ?? []),
    calls: computed<TopologyCall[]>(() => acceptedSnapshot.value?.calls ?? []),
    initialPending: computed(() => phase.value === 'loading'),
    isLoading: q.isLoading,
    isFetching: q.isFetching,
    error: q.error,
    refetch: triggeredRefetch,
  };
}
