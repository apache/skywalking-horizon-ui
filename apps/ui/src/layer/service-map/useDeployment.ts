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
import { useAutoRefreshSubscribe } from '../../controls/useAutoRefreshSubscribe';
import { useTimeRangeStore, stepForMinutes } from '../../controls/timeRange';
import { usePreviewLayerBlock } from '@/controls/previewConfig';
import { bffClient } from '@/api/client';

export function useDeployment(
  layerKey: Ref<string>,
  serviceId: Ref<string | null>,
  enabled: Ref<boolean>,
  /** Embedded (chat) override: when a positive minute count, the query owns its
   *  OWN frozen look-back window and does NOT follow the global topbar picker or
   *  auto-refresh ticker — the interactive route omits it. */
  windowMinutes?: Ref<number | null>,
) {
  const ownsWindow = (windowMinutes?.value ?? 0) > 0;
  const timeRange = useTimeRangeStore();
  // Preview-only: the draft top-level `deployment` block, so
  // the tab previews the operator's unpublished config.
  const previewCfg = usePreviewLayerBlock(layerKey, 'deployment');
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
  const isEnabled = computed(
    () => enabled.value && layerKey.value.length > 0 && !!serviceId.value,
  );
  const q = useQuery({
    queryKey: ['layer-deployment', layerKey, serviceId, rangeKey, previewCfg],
    queryFn: () =>
      bffClient.layer.deployment(
        layerKey.value,
        serviceId.value as string,
        rangeKey.value,
        previewCfg.value,
      ),
    enabled: isEnabled,
    staleTime: 30_000,
  });
  // Only ride the global ticker while the view is active — a forced refetch
  // on a closed/disabled query would fetch needlessly. The embedded chat map
  // owns a frozen window, so it does not subscribe at all.
  if (!ownsWindow) {
    useAutoRefreshSubscribe(() => {
      if (isEnabled.value) void q.refetch();
    });
  }

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
