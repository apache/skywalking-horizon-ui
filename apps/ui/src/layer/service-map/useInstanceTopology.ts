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
 * vue-query wrapper around `GET /api/layer/:key/instance-topology`.
 *
 * Drives the per-layer Instance map view. The query is gated by `enabled`
 * (a client + server service are both picked, and the view is active) so
 * it only fires while the operator is actually looking at the drill-down.
 * Same time-picker queryKey wiring as the service map so the instance
 * metrics line up with the window the operator is on.
 */

import { computed, type Ref } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { useAutoRefreshSubscribe } from '../../controls/useAutoRefreshSubscribe';
import { useTimeRangeStore } from '../../controls/timeRange';
import { usePreviewLayerBlock } from '@/controls/previewConfig';
import { bffClient } from '@/api/client';

export function useInstanceTopology(
  layerKey: Ref<string>,
  clientServiceId: Ref<string | null>,
  serverServiceId: Ref<string | null>,
  enabled: Ref<boolean>,
) {
  const timeRange = useTimeRangeStore();
  // Preview-only: the draft `topology` block (the BFF reads its nested
  // `instanceTopology`), so the instance map previews the draft too.
  const previewCfg = usePreviewLayerBlock(layerKey, 'topology');
  const rangeKey = computed(() => ({
    step: timeRange.step,
    startMs: timeRange.range.startMs,
    endMs: timeRange.range.endMs,
  }));
  const isEnabled = computed(
    () =>
      enabled.value &&
      layerKey.value.length > 0 &&
      !!clientServiceId.value &&
      !!serverServiceId.value,
  );
  const q = useQuery({
    queryKey: ['layer-instance-topology', layerKey, clientServiceId, serverServiceId, rangeKey, previewCfg],
    queryFn: () =>
      bffClient.layer.instanceTopology(
        layerKey.value,
        clientServiceId.value as string,
        serverServiceId.value as string,
        rangeKey.value,
        previewCfg.value,
      ),
    enabled: isEnabled,
    staleTime: 30_000,
  });
  // Only ride the global ticker while the view is active — a forced
  // refetch on a closed/disabled query would fetch needlessly.
  useAutoRefreshSubscribe(() => {
    if (isEnabled.value) void q.refetch();
  });

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
