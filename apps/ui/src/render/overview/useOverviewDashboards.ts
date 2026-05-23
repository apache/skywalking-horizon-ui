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
import { bffClient } from '@/api/client';
import { useLayers } from '../../shell/useLayers';
import {
  ensureConfigBundle,
  getOverviews,
  useConfigBundle,
} from '@/controls/configBundle';

/**
 * Overview-dashboard list driver. Fetches the BFF's bundled list, then
 * filters to dashboards that have at least one referenced layer
 * currently reporting services. Dashboards with no `layers` array are
 * always shown (e.g. a future fleet-glance overview that pulls from
 * everything).
 *
 * The result is partitioned by visibility — `public` overviews are the
 * primary sidebar entries; `operate` overviews are gated to the admin
 * section.
 */
export function useOverviewDashboards() {
  void ensureConfigBundle();
  const { loaded: bundleLoaded } = useConfigBundle();
  // Network fallback only when the bundle is missing (or empty —
  // e.g. a fresh BFF deploy that didn't ship overview templates yet).
  const q = useQuery({
    queryKey: ['overview-dashboards'],
    queryFn: () => bffClient.overview.list(),
    enabled: computed(() => bundleLoaded.value && (getOverviews()?.length ?? 0) === 0),
    staleTime: 60_000,
    refetchOnWindowFocus: true,
  });

  const { availableLayers } = useLayers();
  const activeLayerKeys = computed<Set<string>>(() => {
    const s = new Set<string>();
    for (const L of availableLayers.value) s.add(L.key.toUpperCase());
    return s;
  });

  const all = computed(() => {
    // SetupView reads `d.widgetCount` (a precomputed convenience the
    // list endpoint adds). Bundle entries are the full OverviewDashboard
    // shape with `widgets[]` — derive `widgetCount` from that so both
    // paths produce the same shape downstream.
    const bundled = getOverviews();
    if (bundled && bundled.length > 0) {
      return bundled.map((d) => ({ ...d, widgetCount: d.widgets?.length ?? 0 }));
    }
    return q.data.value?.dashboards ?? [];
  });
  // Layers a dashboard touches = union of its explicit `layers[]` field
  // (kept for back-compat with bundled JSON that lists them by hand) AND
  // every layer referenced by its widgets. User-created dashboards from
  // "+ New" don't carry `layers[]`, so widget-derived is what gates them.
  function dashLayers(d: { layers?: string[]; widgets?: Array<{ layer?: string }> }): string[] {
    const set = new Set<string>();
    for (const k of d.layers ?? []) set.add(k.toUpperCase());
    for (const w of d.widgets ?? []) if (w.layer) set.add(w.layer.toUpperCase());
    return Array.from(set);
  }
  const visible = computed(() =>
    all.value.filter((d) => {
      const layers = dashLayers(d);
      // No layer referenced anywhere → always show (e.g. a future fleet
      // overview that pulls only from cross-layer / All scope).
      if (layers.length === 0) return true;
      return layers.some((l) => activeLayerKeys.value.has(l));
    }),
  );
  const publicOverviews = computed(() =>
    visible.value.filter((d) => (d.visibility ?? 'public') === 'public'),
  );
  const operateOverviews = computed(() =>
    visible.value.filter((d) => d.visibility === 'operate'),
  );

  return {
    isLoading: q.isLoading,
    isError: q.isError,
    all,
    visible,
    publicOverviews,
    operateOverviews,
  };
}
