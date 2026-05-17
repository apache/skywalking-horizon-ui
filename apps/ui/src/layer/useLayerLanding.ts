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
import { useAutoRefreshSubscribe } from '../controls/useAutoRefreshSubscribe';
import type { LandingConfig, LandingResponse, LayerDef } from '@skywalking-horizon-ui/api-client';
import { bffClient } from '@/api/client';

/**
 * Live top-N service rollup for one Overview landing card. Polls every
 * 60s (sufficient for a MINUTE-step window) and falls back gracefully
 * when OAP is unreachable — the BFF surfaces `reachable: false` and the
 * card keeps the placeholder rows.
 *
 * The query key includes the resolved column set so changing a layer's
 * setup (in Stage 2.3+) re-fetches automatically.
 */
export function useLayerLanding(
  layer: Ref<LayerDef>,
  cfg: Ref<LandingConfig>,
) {
  const layerKey = computed(() => layer.value.key);
  // Cache key reflects every field that changes the server response —
  // when an operator edits aggregation / MQE override / scale via setup,
  // vue-query re-fetches.
  const cfgHash = computed(() => JSON.stringify({
    topN: cfg.value.topN,
    orderBy: cfg.value.orderBy,
    columns: cfg.value.columns,
    spark: cfg.value.spark,
    throughput: cfg.value.throughput,
  }));

  const q = useQuery({
    queryKey: ['layer-landing', layerKey, cfgHash],
    queryFn: () => bffClient.layer.landing(layerKey.value, cfg.value),
    staleTime: 45_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    retry: 1,
  });

  useAutoRefreshSubscribe(() => q.refetch());

  const data = computed<LandingResponse | null>(() => q.data.value ?? null);
  const rows = computed(() => data.value?.rows ?? []);
  const reachable = computed(() => data.value?.reachable ?? false);
  const error = computed(() => data.value?.error ?? (q.error.value ? String(q.error.value) : undefined));

  return {
    isLoading: q.isLoading,
    isFetching: q.isFetching,
    data,
    rows,
    reachable,
    error,
    refetch: q.refetch,
  };
}
