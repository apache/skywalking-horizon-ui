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
 * Reactive list of instances for a (layer, service). Backs the
 * instance selector on the per-layer Instance page. Disabled until
 * both inputs are non-empty so the SPA doesn't fire a request the
 * BFF would reject as `missing_service`.
 */

import { computed, type Ref } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { bffClient } from '@/api/client';

export function useLayerInstances(layerKey: Ref<string>, service: Ref<string | null>) {
  const q = useQuery({
    queryKey: ['layer-instances', layerKey, service],
    queryFn: () => bffClient.layer.instances(layerKey.value, service.value ?? ''),
    enabled: computed(() => layerKey.value.length > 0 && !!service.value),
    staleTime: 30_000,
  });
  return {
    data: computed(() => q.data.value ?? null),
    // Sort by name so the selector is scannable. OAP/BFF return instances in
    // registration order, which reads as random (data-hot-1, liaison-1,
    // data-warm-1, …). `numeric` keeps `liaison-1 < liaison-10`.
    instances: computed(() =>
      [...(q.data.value?.instances ?? [])].sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { numeric: true }),
      ),
    ),
    isLoading: q.isLoading,
    isFetching: q.isFetching,
    error: q.error,
  };
}
