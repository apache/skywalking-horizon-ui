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
 * vue-query wrapper around `GET /api/layer/:key/service-hierarchy`.
 *
 * Lazy-probed on node-select in the service map: one round-trip per
 * selected service answers both "should the expand chip show?" and
 * "what populates the overlay?" — `relations === 0` means the focused
 * service has no cross-layer projections, so the chip stays hidden.
 *
 * Not subscribed to the global auto-refresh ticker. The hierarchy
 * table doesn't drift on the OAP minute boundary; the only thing that
 * invalidates it is a layer/service switch, which is part of the
 * queryKey. Topology pages own enough refetch noise already.
 */

import { computed, type Ref } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import type { ServiceHierarchyResponse } from '@skywalking-horizon-ui/api-client';
import { bffClient } from '@/api/client';

export function useServiceHierarchy(
  layerKey: Ref<string>,
  serviceId: Ref<string | null>,
) {
  const q = useQuery({
    queryKey: ['layer-service-hierarchy', layerKey, serviceId],
    queryFn: (): Promise<ServiceHierarchyResponse> =>
      bffClient.layer.serviceHierarchy(layerKey.value, serviceId.value!),
    enabled: computed(() => layerKey.value.length > 0 && !!serviceId.value),
    staleTime: 60_000,
  });

  return {
    data: computed<ServiceHierarchyResponse | null>(() => q.data.value ?? null),
    /** `true` once a probe lands AND the focused service has at least
     *  one cross-layer peer. The expand chip on the selected hex reads
     *  from this — it stays hidden until the probe confirms peers. */
    hasPeers: computed<boolean>(() => (q.data.value?.relations ?? 0) > 0),
    isLoading: q.isLoading,
    isFetching: q.isFetching,
    error: q.error,
    refetch: q.refetch,
  };
}
