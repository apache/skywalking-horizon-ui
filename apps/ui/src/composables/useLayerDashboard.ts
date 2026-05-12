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
 * Two-stage dashboard fetch:
 *   1. `dashboardConfig(layerKey)` — pulls the default widget set from
 *      the BFF (no MQE execution, cheap).
 *   2. `dashboard(layerKey, { service })` — runs every widget's MQE in
 *      one batched GraphQL trip and returns scalars + series.
 *
 * Config is per-layer, results are per-(layer, service). Both queries
 * share the same vue-query cache so switching back to a previously
 * viewed service is instant.
 */

import { computed, type Ref } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { bffClient } from '@/api/client';

export function useLayerDashboardConfig(layerKey: Ref<string>, scope?: Ref<string>) {
  const q = useQuery({
    queryKey: ['dashboard-config', layerKey, scope ?? computed(() => 'service')],
    queryFn: () => bffClient.dashboardConfig(layerKey.value, scope?.value),
    enabled: computed(() => layerKey.value.length > 0),
    staleTime: 5 * 60_000,
  });
  return {
    config: computed(() => q.data.value ?? null),
    isLoading: q.isLoading,
    error: q.error,
  };
}

export function useLayerDashboard(
  layerKey: Ref<string>,
  service: Ref<string | null>,
  scope?: Ref<string>,
) {
  const q = useQuery({
    queryKey: ['dashboard', layerKey, service, scope ?? computed(() => 'service')],
    queryFn: () =>
      bffClient.dashboard(layerKey.value, {
        ...(service.value ? { service: service.value } : {}),
        ...(scope?.value ? { scope: scope.value } : {}),
      }),
    enabled: computed(() => layerKey.value.length > 0),
    staleTime: 45_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    retry: 1,
  });
  return {
    data: computed(() => q.data.value ?? null),
    isLoading: q.isLoading,
    isFetching: q.isFetching,
    error: q.error,
    refetch: q.refetch,
  };
}
