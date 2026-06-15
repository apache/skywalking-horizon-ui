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
import { useQueries, useQuery } from '@tanstack/vue-query';
import { useAutoRefreshSubscribe } from '../../controls/useAutoRefreshSubscribe';
import { bffClient } from '@/api/client';
import {
  ensureConfigBundle,
  getDashboardConfig,
  useConfigBundle,
} from '@/controls/configBundle';
import {
  ENTITY_FANOUT_CONCURRENCY,
  type FanoutScope,
  createLimiter,
  entityDashboardBody,
  entityDashboardKey,
  fanoutEntities,
} from './entityFanout';
import { compoundKey, splitCompound } from '@/state/layerSelection';
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
  /** Optional config-bundle readiness gate. When supplied, the metrics
   *  query waits until it is true, so the dashboard fires ONCE with the
   *  resolved widget list instead of firing first with an empty list
   *  (which makes the BFF substitute defaults) and refetching when the
   *  bundle lands. Callers without a config bundle omit it (treated as
   *  ready) and keep the server-resolves-widgets behaviour. */
  configReady?: Ref<boolean>,
  /** Locked comparison set for this scope (Option B multi-entity
   *  cross-check). When it holds >=2 entities (counting the primary)
   *  the composable fans out one single-entity dashboard query per
   *  locked-but-non-primary entity (concurrency-bounded) and assembles
   *  `resultByEntity`. Empty/absent ⇒ the single-query path is
   *  byte-identical. */
  activeSet?: Ref<string[]>,
  /** Canonical key of the PRIMARY entity in the SAME representation the
   *  `activeSet` uses (service id at service scope; `compoundKey(serviceId,
   *  name)` at instance/endpoint scope). Supplied so the fan-out can dedupe
   *  the primary out of the comparison set instead of fetching it twice —
   *  the dashboard query itself still goes out by service NAME (`service`
   *  arg above), which the BFF resolves to the same entity. When absent the
   *  composable falls back to reconstructing the key from `service` +
   *  `entityRefs` (name-based — only correct when the caller keys locks by
   *  name too). */
  primaryKey?: Ref<string | null>,
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
  // Total widget count for the loading indicator — only used to
  // surface "N metrics loading" while the BFF batch is in flight.
  // We don't chunk on the SPA side (each BFF call would re-run
  // `listServices` to resolve the entity, doubling the latency for
  // no real win — the BFF already chunks the OAP GraphQL trips
  // internally via Promise.all, see http/query/dashboard.ts step 2).
  // Single BFF call → one entity resolution + chunked MQE batches
  // server-side → one merged response.
  const progress = ref<{ arrived: number; total: number }>({ arrived: 0, total: 0 });

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
      // Key on the FULL widget config, not just ids: a remote sync or
      // preview edit that keeps a widget's id but changes its MQE
      // expressions / type must refire — an id-only key would serve the
      // stale (wrong-expression) data from cache.
      computed(() => (widgetsList?.value ? JSON.stringify(widgetsList.value) : null)),
    ],
    queryFn: async () => {
      const total = widgetsList?.value.length ?? 0;
      progress.value = { arrived: 0, total };
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
        ...(widgetsList?.value.length ? { widgets: widgetsList.value } : {}),
      };
      const opts = mockTop?.value ? { mockTop: mockTop.value } : {};
      const resp = await bffClient.layer.dashboard(layerKey.value, baseBody, opts);
      progress.value = { arrived: resp.widgets?.length ?? total, total };
      return resp;
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
      // Wait for the config bundle so widgets are resolved before the
      // metrics fire (no empty-list → BFF-default → refetch round-trip).
      if (configReady && !configReady.value) return false;
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

  // --- Multi-entity fan-out (Option B) -------------------------------
  // `q` above always serves the PRIMARY entity (and is the whole story
  // when nothing is locked). When >=2 entities are in the comparison set
  // we additionally fan out one single-entity query per LOCKED-but-non-
  // primary entity (concurrency-bounded), then merge primary + others
  // into `resultByEntity`. N<=1 leaves all of this inert.
  const widgetsJson = computed(() => (widgetsList?.value ? JSON.stringify(widgetsList.value) : null));
  // Instance/endpoint entity keys are CROSS-SERVICE compounds, so the
  // primary's key carries the current service too (matches the locked
  // compound keys when the current selection is itself pinned).
  const primaryEntity = computed<string | null>(() => {
    // Prefer the caller-supplied canonical key — it matches the locked-set
    // representation (service id), so the primary dedupes out of the fan-out
    // instead of being fetched twice. The reconstruction below is the
    // name-based fallback for callers that key locks by name.
    if (primaryKey) return primaryKey.value;
    const s = scope?.value ?? 'service';
    if (s === 'instance') {
      const n = entityRefs.instance?.value;
      return n ? compoundKey(service.value ?? '', n) : null;
    }
    if (s === 'endpoint') {
      const n = entityRefs.endpoint?.value;
      return n ? compoundKey(service.value ?? '', n) : null;
    }
    return service.value;
  });
  // The comparison set = the BANNER (primary) entity ALWAYS first, then each
  // pinned entity (de-duped, empties dropped). The banner is what the top
  // selector points at — it drives the header KPIs and renders as the
  // "current" member (reserved accent hue); the pins add to it. So viewing
  // one entity + a single pin already compares two. No hue collision: the
  // primary owns the accent, leaving the 6-hue palette for up to six pins.
  // The banner is served by `q`; the pins by the fan-out.
  const compareOrder = computed<string[]>(() => {
    const p = primaryEntity.value;
    const pins = (activeSet?.value ?? []).filter((e) => e && e !== p);
    return p ? [p, ...pins] : pins;
  });
  const compareActive = computed<boolean>(() => compareOrder.value.length >= 2);
  // Fan out the non-primary locked entities; the primary (when it is in
  // the locked set) is served by `q`, the rest by `useQueries`.
  const fanoutList = computed<string[]>(() =>
    fanoutEntities(primaryEntity.value, activeSet?.value ?? []),
  );

  const limit = createLimiter(ENTITY_FANOUT_CONCURRENCY);
  const entityQueries = useQueries({
    queries: () => {
      // Only fan out once there's an actual comparison (>=2 in the set);
      // a single lock shows in the cohort bar but doesn't fetch.
      if (!compareActive.value) return [];
      if (configReady && !configReady.value) return [];
      const raw = scope?.value ?? 'service';
      if (raw !== 'service' && raw !== 'instance' && raw !== 'endpoint') return [];
      const s: FanoutScope = raw;
      const opts = mockTop?.value ? { mockTop: mockTop.value } : {};
      return fanoutList.value.map((entity) => {
        // Decode the cross-service compound key (instance/endpoint) into
        // its own service + name; at service scope the entity IS the svc.
        const { service: svc, name } =
          s === 'service' ? { service: entity, name: '' } : splitCompound(entity);
        return {
          queryKey: entityDashboardKey(
            layerKey.value,
            s,
            svc,
            name,
            mockTop?.value ?? 0,
            rangeKey.value,
            widgetsJson.value,
          ),
          queryFn: (): Promise<DashboardResponse> =>
            limit(() =>
              bffClient.layer.dashboard(
                layerKey.value,
                entityDashboardBody(s, svc, name, rangeRef.value, widgetsList?.value ?? null),
                opts,
              ),
            ),
          staleTime: 25_000,
          refetchInterval: refetchIntervalRef,
          refetchOnWindowFocus: false,
          retry: 1,
        };
      });
    },
  });

  function indexById(widgets: DashboardWidgetResult[]): Map<string, DashboardWidgetResult> {
    const m = new Map<string, DashboardWidgetResult>();
    for (const w of widgets) m.set(w.id, w);
    return m;
  }

  /** Map<entityName, Map<widgetId, result>> — primary from `q`, the
   *  other locked entities from the fan-out. Assembles progressively as
   *  each independent query lands. */
  const resultByEntity = computed<Map<string, Map<string, DashboardWidgetResult>>>(() => {
    const out = new Map<string, Map<string, DashboardWidgetResult>>();
    const p = primaryEntity.value;
    const pData = q.data.value;
    if (p && pData?.widgets) out.set(p, indexById(pData.widgets));
    const results = entityQueries.value;
    fanoutList.value.forEach((entity, i) => {
      const data = results[i]?.data as DashboardResponse | undefined;
      if (data?.widgets) out.set(entity, indexById(data.widgets));
    });
    return out;
  });

  /** Entities resolved (success OR error) / total — progressive hint.
   *  Counts over the compare set: the primary (if in it) via `q`, the
   *  rest via their fan-out query. */
  const entityProgress = computed<{ arrived: number; total: number }>(() => {
    const order = compareOrder.value;
    const fan = fanoutList.value;
    let arrived = 0;
    for (const e of order) {
      if (e === primaryEntity.value) {
        if (q.data.value || q.isError.value) arrived += 1;
      } else {
        const i = fan.indexOf(e);
        const r = i >= 0 ? entityQueries.value[i] : undefined;
        if (r && (r.data !== undefined || r.isError)) arrived += 1;
      }
    }
    return { arrived, total: order.length };
  });

  /** Loading state for one entity's row in the compare grid. */
  function entityState(entity: string): 'loading' | 'ready' | 'error' {
    if (entity === primaryEntity.value) {
      if (q.isError.value) return 'error';
      return q.data.value ? 'ready' : 'loading';
    }
    const i = fanoutList.value.indexOf(entity);
    const r = i >= 0 ? entityQueries.value[i] : undefined;
    if (!r) return 'loading';
    if (r.isError) return 'error';
    return r.data !== undefined ? 'ready' : 'loading';
  }

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
    // --- Multi-entity compare (Option B). Inert (single-entity) until a
    // cohort is locked; consumed by the compare grid in a later phase.
    /** Comparison-set entity order, primary first. */
    compareEntities: compareOrder,
    /** True once >=2 entities are in the comparison set. */
    compareActive,
    /** Map<entityName, Map<widgetId, result>>, assembled progressively. */
    resultByEntity,
    /** Entities resolved / total, for the progressive loading hint. */
    entityProgress,
    /** 'loading' | 'ready' | 'error' for a single entity row. */
    entityState,
  };
}
