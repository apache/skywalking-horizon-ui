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

import { computed, type Ref } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { bffClient } from '@/api/client';
import type { AiConversationRow, AiConversationsResponse } from '@/api/client';

export interface LayerConversationsParams {
  /** The agent runtime — the layer's service, by NAME, as the OAP list keys on it. */
  service: Ref<string | null>;
  /** Rolling window in minutes. The tab owns its range; the global ticker is
   *  paused on it. */
  windowMinutes: Ref<number>;
  /** Manual fire: the query waits here until the operator presses Run query. */
  enabled: Ref<boolean>;
}

/** The conversations of one agent runtime, newest activity first, as the BFF
 *  folded them from the newest rounds in the window. `limit` is that round
 *  budget, which the page states beside the table because OAP gives no
 *  truncation signal to show instead. */
export function useLayerConversations(layerKey: Ref<string>, params: LayerConversationsParams) {
  const q = useQuery<AiConversationsResponse>({
    queryKey: ['layer-ai-conversations', layerKey, params.service, params.windowMinutes],
    queryFn: ({ signal }) =>
      bffClient.aiConversation.list(
        layerKey.value,
        { service: params.service.value ?? '', windowMinutes: params.windowMinutes.value },
        signal,
      ),
    enabled: computed(
      () => layerKey.value.length > 0 && !!params.service.value && params.enabled.value,
    ),
    staleTime: 15_000,
  });
  const data = computed<AiConversationsResponse | null>(() => q.data.value ?? null);
  return {
    data,
    rows: computed<AiConversationRow[]>(() => data.value?.rows ?? []),
    limit: computed<number | null>(() => data.value?.limit ?? null),
    reachable: computed<boolean>(() => data.value?.reachable ?? true),
    queryError: computed<string | null>(() => data.value?.error ?? null),
    isFetching: q.isFetching,
    error: q.error,
    refetch: q.refetch,
  };
}
