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
import type { EndpointDependencyResponse } from '@skywalking-horizon-ui/api-client';
import { useTimeRangeStore, stepForMinutes } from '../../controls/timeRange';
import { usePreviewLayerBlock } from '@/controls/previewConfig';
import { bffClient } from '@/api/client';

export function useLayerEndpointDependency(
  layerKey: Ref<string>,
  service: Ref<string | null>,
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
  const ownsWindow = (windowMinutes?.value ?? 0) > 0;
  // Preview-only: forward the draft `endpointDependency` block.
  const previewCfg = usePreviewLayerBlock(layerKey, 'endpointDependency');
  const timeRange = useTimeRangeStore();
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
      () => layerKey.value.length > 0 && !!service.value && !!endpoint.value && !replay.value,
    ),
    staleTime: 30_000,
  });
  // No ticker subscription: this query is keyed on `rangeKey`, and a rolling
  // preset's window advances with the ticker, so each tick already re-keys the
  // query and vue-query fetches the new window. Subscribing as well would fire
  // two requests per tick for the same data. A frozen window (embedded/replay,
  // or a pinned custom range) does not re-key — and must not refetch anyway.

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
