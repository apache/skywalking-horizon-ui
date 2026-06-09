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
import { useAutoRefreshSubscribe } from '../../controls/useAutoRefreshSubscribe';
import { useTimeRangeStore } from '../../controls/timeRange';
import { usePreviewLayerBlock } from '@/controls/previewConfig';
import { bffClient } from '@/api/client';

export function useLayerTopology(
  layerKey: Ref<string>,
  service: Ref<string | null>,
  depth: Ref<number>,
) {
  const timeRange = useTimeRangeStore();
  // In `?mode=preview` only: forward the operator's draft `topology` block
  // so the map renders the unpublished edit. Empty otherwise — a normal
  // (absent-remote) read never carries a draft, keeping the two paths
  // cleanly separate.
  const previewCfg = usePreviewLayerBlock(layerKey, 'topology');
  // Re-resolve range / step on every read so the queryKey changes on
  // picker flips. A stable triplet (step + ms-rounded bounds) prevents
  // identity-thrash on every store tick.
  const rangeKey = computed(() => ({
    step: timeRange.step,
    startMs: timeRange.range.startMs,
    endMs: timeRange.range.endMs,
  }));
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
    enabled: computed(() => layerKey.value.length > 0),
    staleTime: 30_000,
  });
  useAutoRefreshSubscribe(() => q.refetch());

  return {
    data: computed(() => q.data.value ?? null),
    nodes: computed(() => q.data.value?.nodes ?? []),
    calls: computed(() => q.data.value?.calls ?? []),
    isLoading: q.isLoading,
    isFetching: q.isFetching,
    error: q.error,
    refetch: q.refetch,
  };
}
