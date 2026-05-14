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

import { computed } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import type { LayerDef } from '@skywalking-horizon-ui/api-client';
import { bffClient } from '@/api/client';

/**
 * Live OAP-driven layer + menu state. Fed by `GET /api/menu`. Refetches on
 * window focus + every 60s.
 *
 * `data.value` is `null` while loading. `oapReachable` is false when the
 * BFF returned a soft-fail body (OAP down); the UI should render a banner
 * but otherwise keep the empty layer list rendered without crashing.
 */
export function useLayers() {
  const q = useQuery({
    queryKey: ['menu'],
    queryFn: () => bffClient.menu(),
    staleTime: 30_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });

  const layers = computed<LayerDef[]>(() => q.data.value?.layers ?? []);
  /**
   * Layers known to OAP (returned by `listLayers`). May include stale
   * registry entries — receivers that ever ingested but currently have no
   * services. Use this for the Setup page; users want to see and configure
   * every layer they could enable.
   */
  const activeLayers = computed<LayerDef[]>(() => layers.value.filter((L) => L.active));
  /**
   * Layers with at least one currently-reporting service (`listServices`
   * count > 0). The sidebar uses this so the user doesn't see ghost
   * entries that no longer carry data.
   */
  const availableLayers = computed<LayerDef[]>(() =>
    layers.value.filter((L) => L.serviceCount > 0),
  );
  const oapReachable = computed<boolean>(() => q.data.value?.oap.reachable ?? false);
  const oapError = computed<string | undefined>(() => q.data.value?.oap.error);

  function findLayer(key: string | undefined): LayerDef | undefined {
    if (!key) return undefined;
    return layers.value.find((L) => L.key === key);
  }

  /**
   * `caps.serviceMap || caps.instanceTopology || caps.processTopology`.
   * Pulled out of `layers.ts` so the sidebar can stay UI-only.
   */
  function hasTopology(L: LayerDef | undefined): boolean {
    if (!L) return false;
    return Boolean(L.caps.serviceMap || L.caps.instanceTopology || L.caps.processTopology);
  }

  return {
    isLoading: q.isLoading,
    isError: q.isError,
    layers,
    activeLayers,
    availableLayers,
    oapReachable,
    oapError,
    findLayer,
    hasTopology,
    refetch: q.refetch,
  };
}

/**
 * Pick the first sub-route a layer should land on, based on its
 * declared components (slots / caps). Some layers turn off the service
 * tab entirely (`mesh_dp` instance-only, `so11y_*_agent` per-agent
 * JVM metrics) — without this helper, the sidebar + the bare-route
 * redirect both shove the operator at `/service` and they land on an
 * empty grid. Order mirrors the visible tab order in the sidebar.
 */
export function firstLayerTab(L: LayerDef | undefined): string {
  if (!L) return 'service';
  if (L.slots?.services || L.caps?.dashboards) return 'service';
  if (L.slots?.instances) return 'instance';
  if (L.slots?.endpoints) return 'endpoint';
  if (L.caps?.serviceMap || L.caps?.instanceTopology || L.caps?.processTopology) return 'topology';
  if (L.caps?.endpointDependency) return 'dependency';
  if (L.caps?.traces) return 'trace';
  if (L.caps?.logs) return 'logs';
  if (L.caps?.traceProfiling) return 'trace-profiling';
  if (L.caps?.ebpfProfiling) return 'ebpf-profiling';
  if (L.caps?.asyncProfiling) return 'async-profiling';
  return 'service';
}
