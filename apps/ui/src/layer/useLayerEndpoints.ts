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
 * Reactive top-N endpoint search for a (layer, service, query). Feeds
 * the endpoint picker on the per-layer Endpoint page. Disabled until
 * a service is selected. The query is debounced upstream by the
 * picker UI; here we just thread `query` into the queryKey so a new
 * keyword refetches.
 */

import { computed, type Ref } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { bffClient } from '@/api/client';

export function useLayerEndpoints(
  layerKey: Ref<string>,
  service: Ref<string | null>,
  query: Ref<string>,
  limit: Ref<number>,
) {
  const q = useQuery({
    queryKey: ['layer-endpoints', layerKey, service, query, limit],
    queryFn: () =>
      bffClient.layer.endpoints(layerKey.value, service.value ?? '', query.value, limit.value),
    enabled: computed(() => layerKey.value.length > 0 && !!service.value),
    staleTime: 30_000,
  });
  return {
    data: computed(() => q.data.value ?? null),
    endpoints: computed(() => q.data.value?.endpoints ?? []),
    isLoading: q.isLoading,
    isFetching: q.isFetching,
    error: q.error,
  };
}
