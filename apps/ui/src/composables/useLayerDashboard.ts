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
import { useAutoRefreshSubscribe } from './useAutoRefreshSubscribe';
import { bffClient } from '@/api/client';

export function useLayerDashboardConfig(layerKey: Ref<string>, scope?: Ref<string>) {
  const q = useQuery({
    queryKey: ['dashboard-config', layerKey, scope ?? computed(() => 'service')],
    queryFn: () => bffClient.dashboardConfig(layerKey.value, scope?.value),
    enabled: computed(() => layerKey.value.length > 0),
    staleTime: 5 * 60_000,
  });
  useAutoRefreshSubscribe(() => q.refetch());

  return {
    config: computed(() => q.data.value ?? null),
    isLoading: q.isLoading,
    error: q.error,
  };
}

export interface DashboardEntityRefs {
  /** Selected instance name — only consumed when scope === 'instance'. */
  instance?: Ref<string | null>;
  /** Selected endpoint name — only consumed when scope === 'endpoint'. */
  endpoint?: Ref<string | null>;
}

export function useLayerDashboard(
  layerKey: Ref<string>,
  service: Ref<string | null>,
  scope?: Ref<string>,
  /** Optional `?mockTop=N` passthrough — when set, every TopList in
   *  the response is padded to N synthetic rows for UI sizing tests. */
  mockTop?: Ref<number>,
  /** Optional drill refs (instance / endpoint). Each is forwarded to
   *  the BFF only when the corresponding scope is active; passing a
   *  ref keeps the query key cache-aware so switching instances on
   *  the same service re-fetches. */
  entityRefs: DashboardEntityRefs = {},
) {
  // Auto-refresh is metrics-only. Trace / log / profiling pages are
  // explore-style (operator-driven queries, log tails, etc.) and would
  // surprise the user if the page swapped state every minute. Service /
  // instance / endpoint are the "live metrics" scopes that benefit
  // from polling.
  const METRIC_SCOPES = new Set(['service', 'instance', 'endpoint']);
  const refetchIntervalRef = computed(() => {
    const s = scope?.value ?? 'service';
    return METRIC_SCOPES.has(s) ? 30_000 : false;
  });
  const q = useQuery({
    queryKey: [
      'dashboard',
      layerKey,
      service,
      scope ?? computed(() => 'service'),
      mockTop ?? computed(() => 0),
      entityRefs.instance ?? computed(() => null),
      entityRefs.endpoint ?? computed(() => null),
    ],
    queryFn: () =>
      bffClient.dashboard(
        layerKey.value,
        {
          ...(service.value ? { service: service.value } : {}),
          ...(scope?.value ? { scope: scope.value } : {}),
          ...(entityRefs.instance?.value ? { serviceInstance: entityRefs.instance.value } : {}),
          ...(entityRefs.endpoint?.value ? { endpoint: entityRefs.endpoint.value } : {}),
        },
        mockTop?.value ? { mockTop: mockTop.value } : {},
      ),
    // Gate the metric query on the entity actually being resolved.
    // Otherwise the dashboard fires twice on landing: once with
    // `service: null` (BFF then auto-picks the first service by
    // orderBy, which often differs from the URL-selected one), then
    // again once the landing rows arrive and `serviceName` resolves.
    // The first fire returns rows for the wrong service and they
    // briefly flash on screen — for instance/endpoint scopes the
    // first fire returns mostly empty widgets because the BFF has no
    // entity to scope to. Wait until both layer + service are known.
    //
    // Layer-wide scopes (`topology`, `dependency`, `logs`,
    // `trace*Profiling`, `trace`) don't need a service — keep them
    // enabled the moment `layerKey` is known.
    enabled: computed(() => {
      if (layerKey.value.length === 0) return false;
      const s = scope?.value ?? 'service';
      if (s === 'service' || s === 'instance' || s === 'endpoint') {
        return Boolean(service.value);
      }
      return true;
    }),
    staleTime: 25_000,
    refetchInterval: refetchIntervalRef,
    refetchOnWindowFocus: computed(() => METRIC_SCOPES.has(scope?.value ?? 'service')),
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
