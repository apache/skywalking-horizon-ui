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
import { useAutoRefreshSubscribe } from '../../controls/useAutoRefreshSubscribe';
import { useTimeRangeStore } from '../../controls/timeRange';
import { usePreviewLayerBlock } from '@/controls/previewConfig';
import { bffClient } from '@/api/client';

export function useLayerEndpointDependency(
  layerKey: Ref<string>,
  service: Ref<string | null>,
  endpoint: Ref<string | null>,
) {
  // Preview-only: forward the draft `endpointDependency` block.
  const previewCfg = usePreviewLayerBlock(layerKey, 'endpointDependency');
  const timeRange = useTimeRangeStore();
  const rangeKey = computed(() => ({
    step: timeRange.step,
    startMs: timeRange.range.startMs,
    endMs: timeRange.range.endMs,
  }));
  const q = useQuery({
    queryKey: ['layer-endpoint-dependency', layerKey, service, endpoint, rangeKey, previewCfg],
    queryFn: () =>
      bffClient.layer.endpointDependency(
        layerKey.value,
        service.value ?? '',
        endpoint.value ?? '',
        rangeKey.value,
        previewCfg.value,
      ),
    enabled: computed(
      () => layerKey.value.length > 0 && !!service.value && !!endpoint.value,
    ),
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
