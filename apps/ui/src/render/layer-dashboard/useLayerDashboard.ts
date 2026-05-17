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

import { computed, ref, type Ref } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { useAutoRefreshSubscribe } from '../../controls/useAutoRefreshSubscribe';
import { bffClient } from '@/api/client';
import {
  ensureConfigBundle,
  getDashboardConfig,
  useConfigBundle,
} from '@/controls/configBundle';
import type {
  DashboardConfig,
  DashboardResponse,
  DashboardWidget,
  DashboardWidgetResult,
} from '@skywalking-horizon-ui/api-client';

export function useLayerDashboardConfig(layerKey: Ref<string>, scope?: Ref<string>) {
  // Prefer the preloaded bundle. The bundle preload kicks off at app
  // mount in AppShell; if for some reason this composable runs first
  // we still trigger it here so the lookup eventually resolves.
  void ensureConfigBundle();
  const { loaded } = useConfigBundle();
  const bundled = computed<DashboardConfig | null>(() => {
    if (!loaded.value) return null;
    const s = (scope?.value ?? 'service') as 'service' | 'instance' | 'endpoint';
    const widgets = getDashboardConfig(layerKey.value, s);
    if (!widgets) return null;
    return { layer: layerKey.value, scope: s, widgets };
  });
  // Network fallback — only fires if the bundle lookup came back null
  // (e.g. a layer added since the cached bundle was written). Keeps
  // the page rendering even when localStorage is stale.
  const q = useQuery({
    queryKey: ['dashboard-config', layerKey, scope ?? computed(() => 'service')],
    queryFn: () => bffClient.layer.dashboardConfig(layerKey.value, scope?.value),
    enabled: computed(() => layerKey.value.length > 0 && loaded.value && bundled.value === null),
    staleTime: 5 * 60_000,
  });
  useAutoRefreshSubscribe(() => q.refetch());

  return {
    config: computed(() => bundled.value ?? q.data.value ?? null),
    isLoading: computed(() => !loaded.value && q.isLoading.value),
    error: q.error,
  };
}

export interface DashboardEntityRefs {
  /** Selected instance name — only consumed when scope === 'instance'. */
  instance?: Ref<string | null>;
  /** Selected endpoint name — only consumed when scope === 'endpoint'. */
  endpoint?: Ref<string | null>;
}

export interface DashboardRange {
  step: 'MINUTE' | 'HOUR' | 'DAY';
  startMs: number;
  endMs: number;
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
  /** Global time-range ref (start/end ms + step). When omitted the
   *  BFF picks a default window. Threaded into the queryKey so a
   *  time-picker change refires the widget batch the same way a
   *  service/instance pick does. */
  range?: Ref<DashboardRange | null>,
  /** Optional widget list. When supplied the SPA chunks it into
   *  groups (matching booster-ui's DashboardMaxQueryWidgets = 6)
   *  and fires N parallel BFF calls instead of one — exposes the
   *  per-chunk completion as `widgetsArrived` so the loading
   *  indicator can tick "x fired / y all". When omitted, falls
   *  back to a single BFF call that resolves widgets server-side
   *  (used by callers that don't have the config bundle handy). */
  widgetsList?: Ref<DashboardWidget[]>,
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
  const rangeRef = range ?? computed<DashboardRange | null>(() => null);
  // Bucket the range into a stable key fragment — millisecond
  // precision in the key would invalidate the cache on every paint
  // for rolling presets. Step + 60s buckets are precise enough for
  // dashboard refreshes and keep the cache useful across closely-
  // spaced operator interactions.
  const rangeKey = computed(() => {
    const r = rangeRef.value;
    if (!r) return null;
    return `${r.step}:${Math.floor(r.startMs / 60_000)}:${Math.floor(r.endMs / 60_000)}`;
  });
  // Per-chunk progress for the loading indicator. Resets to
  // {arrived: 0, total: N} at queryFn start, ticks up as each
  // parallel BFF chunk resolves. The widget-list path uses this;
  // the legacy single-call path leaves it at {0, 0}.
  const progress = ref<{ arrived: number; total: number }>({ arrived: 0, total: 0 });
  const CHUNK_SIZE = 6;

  const q = useQuery({
    queryKey: [
      'dashboard',
      layerKey,
      service,
      scope ?? computed(() => 'service'),
      mockTop ?? computed(() => 0),
      entityRefs.instance ?? computed(() => null),
      entityRefs.endpoint ?? computed(() => null),
      rangeKey,
      // Hash of widget ids so adding/removing a widget refires.
      computed(() => widgetsList?.value.map((w) => w.id).join('|') ?? null),
    ],
    queryFn: async () => {
      const baseBody = {
        ...(service.value ? { service: service.value } : {}),
        ...(scope?.value ? { scope: scope.value } : {}),
        ...(entityRefs.instance?.value ? { serviceInstance: entityRefs.instance.value } : {}),
        ...(entityRefs.endpoint?.value ? { endpoint: entityRefs.endpoint.value } : {}),
        ...(rangeRef.value
          ? {
              step: rangeRef.value.step,
              startMs: rangeRef.value.startMs,
              endMs: rangeRef.value.endMs,
            }
          : {}),
      };
      const opts = mockTop?.value ? { mockTop: mockTop.value } : {};
      const all = widgetsList?.value ?? [];
      // No widget list → fall back to the legacy single-call path:
      // BFF resolves widgets from the layer template + auto-picks
      // entities. No per-chunk progress (no list to chunk against).
      if (all.length === 0) {
        progress.value = { arrived: 0, total: 0 };
        return bffClient.layer.dashboard(layerKey.value, baseBody, opts);
      }
      // Chunked path. Fire N parallel BFF calls (one per 6-widget
      // group) so each chunk's completion ticks the progress ref.
      // Wall-clock is roughly max(chunk_time) thanks to Promise.all;
      // each chunk is small enough to stay inside OAP's per-query
      // budget without relying on BFF-internal chunking.
      progress.value = { arrived: 0, total: all.length };
      const chunks: DashboardWidget[][] = [];
      for (let i = 0; i < all.length; i += CHUNK_SIZE) {
        chunks.push(all.slice(i, i + CHUNK_SIZE));
      }
      const merged: DashboardWidgetResult[] = [];
      let baseResp: DashboardResponse | null = null;
      await Promise.all(
        chunks.map(async (chunk) => {
          const resp = await bffClient.layer.dashboard(
            layerKey.value,
            { ...baseBody, widgets: chunk },
            opts,
          );
          // First-arrived chunk donates the response envelope
          // (`service`, `reachable`, `durationStart/End`, etc.) —
          // all chunks share the same upstream state since they
          // were resolved against the same entity.
          if (!baseResp) baseResp = resp;
          merged.push(...(resp.widgets ?? []));
          progress.value = { arrived: merged.length, total: all.length };
        }),
      );
      const finalEnvelope = baseResp ?? {
        layer: layerKey.value,
        service: service.value ?? null,
        generatedAt: Date.now(),
        step: 'MINUTE' as const,
        durationStart: '',
        durationEnd: '',
        reachable: true,
        widgets: [],
      };
      return { ...finalEnvelope, widgets: merged };
    },
    // Trailing-control principle: the widget batch is the deepest
    // control in the chain and must wait for everything upstream
    // (layer → service → instance/endpoint) to be resolved by the
    // UI before firing. The BFF can auto-pick a default instance
    // when the SPA omits one, but doing so silently means the
    // dashboard fires TWICE on landing (BFF default → then again
    // when the UI's picker auto-resolves the URL ?instance= it
    // wants), which manifested as widgets snapping to "BFF default"
    // data before re-rendering with the operator's actual pick.
    //
    // Gating rules:
    //   - layer-wide scopes (topology / dependency / logs /
    //     trace / *-profiling) only need `layerKey`.
    //   - service scope                          needs service.
    //   - instance scope needs service + instance.
    //   - endpoint scope needs service + endpoint.
    enabled: computed(() => {
      if (layerKey.value.length === 0) return false;
      const s = scope?.value ?? 'service';
      if (s === 'service') return Boolean(service.value);
      if (s === 'instance') return Boolean(service.value && entityRefs.instance?.value);
      if (s === 'endpoint') return Boolean(service.value && entityRefs.endpoint?.value);
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
    /** Per-chunk progress for the loading indicator. While a fetch
     *  is in flight, `arrived` ticks from 0 → total as each parallel
     *  chunk's BFF call resolves. `total` is 0 when the legacy
     *  no-widgetsList path is in use. */
    progress,
  };
}
