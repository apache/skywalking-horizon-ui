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
import type { DeploymentResponse } from '@skywalking-horizon-ui/api-client';
import { useTimeRangeStore, stepForMinutes } from '../../controls/timeRange';
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
    () => enabled.value && layerKey.value.length > 0 && !!service.value && !replay.value,
  );
  const q = useQuery({
    queryKey: ['layer-deployment', layerKey, service, rangeKey, previewCfg],
    queryFn: () =>
      bffClient.layer.deployment(
        layerKey.value,
        service.value!,
        rangeKey.value,
        previewCfg.value,
      ),
    enabled: isEnabled,
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
