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
import type { TopologyResponse } from '@skywalking-horizon-ui/api-client';
import { useAutoRefreshSubscribe } from '../../controls/useAutoRefreshSubscribe';
import { useTimeRangeStore, stepForMinutes } from '../../controls/timeRange';
import { usePreviewLayerBlock } from '@/controls/previewConfig';
import { bffClient } from '@/api/client';

export function useLayerTopology(
  layerKey: Ref<string>,
  service: Ref<string | null>,
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
  const ownsWindow = (windowMinutes?.value ?? 0) > 0;
  const timeRange = useTimeRangeStore();
  // In `?mode=preview` only: forward the operator's draft `topology` block
  // so the map renders the unpublished edit. Empty otherwise — a normal
  // (absent-remote) read never carries a draft, keeping the two paths
  // cleanly separate.
  const previewCfg = usePreviewLayerBlock(layerKey, 'topology');
  // Re-resolve range / step on every read so the queryKey changes on
  // picker flips. A stable triplet (step + ms-rounded bounds) prevents
  // identity-thrash on every store tick. In embedded mode the triplet is
  // derived from the fixed windowMinutes (Date.now() captured once — a frozen
  // snapshot), so it never follows the global picker.
  const rangeKey = computed(() => {
    if (ownsWindow) {
      const min = windowMinutes!.value ?? 0;
      const endMs = Date.now();
      return { step: stepForMinutes(min), startMs: endMs - min * 60_000, endMs };
    }
    return {
      step: timeRange.step,
      startMs: timeRange.range.startMs,
      endMs: timeRange.range.endMs,
    };
  });
  const q = useQuery({
    queryKey: ['layer-topology', layerKey, service, depth, rangeKey, previewCfg],
    queryFn: () =>
      bffClient.layer.topology(
        layerKey.value,
        service.value ?? undefined,
        depth.value,
        rangeKey.value,
        previewCfg.value,
      ),
    // Replay is static: never fetch (data comes from replayData below).
    enabled: computed(() => layerKey.value.length > 0 && !replay.value),
    staleTime: 30_000,
  });
  // The embedded chat map owns its own frozen window, so it must NOT refetch on
  // the global ticker — only the interactive route subscribes. A replay map never
  // fetches either.
  if (!ownsWindow && !replay.value) useAutoRefreshSubscribe(() => q.refetch());

  // Replay renders straight from the captured payload — NOT through the shared
  // query cache. Seeding initialData under the live query key would let a chat
  // snapshot serve a live view during staleTime (and vice-versa).
  const data = computed(() => (replay.value ? (replayData?.value ?? null) : (q.data.value ?? null)));
  return {
    data,
    nodes: computed(() => data.value?.nodes ?? []),
    calls: computed(() => data.value?.calls ?? []),
    isLoading: q.isLoading,
    isFetching: q.isFetching,
    error: q.error,
    refetch: q.refetch,
  };
}
