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
import { keepPreviousData, useQueries, useQuery } from '@tanstack/vue-query';
import { useAutoRefreshSubscribe } from '../../controls/useAutoRefreshSubscribe';
import { fetchDrawable, useTimeIdentity } from '@/layer/graphQuery';
import { useRefreshErrorReport } from '@/controls/errorCenter';
import { bffClient } from '@/api/client';
import {
  ensureConfigBundle,
  getDashboardConfig,
  isMissingPage,
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
import { usePreviewMode } from '@/controls/previewMode';
import type {
  DashboardConfig,
  DashboardResponse,
  DashboardWidget,
  DashboardWidgetResult,
} from '@skywalking-horizon-ui/api-client';

/**
 * The widget set for one page of one scope.
 *
 * `page` selects an extension page; omitted means the component's default
 * grid. A page the layer doesn't declare resolves to `notFound`, never to
 * the default grid — rendering the default under a page URL would show
 * real widgets that are not the ones the URL promised.
 */
export function useLayerDashboardConfig(layerKey: Ref<string>, scope?: Ref<string>, page?: Ref<string | undefined>) {
  // Prefer the preloaded bundle. The bundle preload kicks off at app
  // mount in AppShell; if for some reason this composable runs first
  // we still trigger it here so the lookup eventually resolves.
  void ensureConfigBundle();
  const { loaded } = useConfigBundle();
  const pageId = computed<string | undefined>(() => page?.value);
  /** Set when the PREVIEWED draft says this page does not exist — the
   *  preview equivalent of the BFF's 404, decided without a request. */
  const previewMissing = computed<boolean>(() => {
    if (!loaded.value || !pageId.value) return false;
    const s = (scope?.value ?? 'service') as 'service' | 'instance' | 'endpoint';
    return isMissingPage(getDashboardConfig(layerKey.value, s, pageId.value));
  });
  const bundled = computed<DashboardConfig | null>(() => {
    if (!loaded.value || previewMissing.value) return null;
    const s = (scope?.value ?? 'service') as 'service' | 'instance' | 'endpoint';
    const widgets = getDashboardConfig(layerKey.value, s, pageId.value);
    if (!widgets) return null;
    return { layer: layerKey.value, scope: s, page: pageId.value, widgets };
  });
  // Network fallback — only fires if the bundle lookup came back null
  // (e.g. a layer added since the cached bundle was written, or a page
  // the cached bundle predates). Keeps the page rendering even when
  // localStorage is stale.
  /** Lifted so the query and its round membership share one gate — a page the
   *  preview already knows is gone needs no request to confirm it. */
  const configEnabled = computed(
    () => layerKey.value.length > 0 && loaded.value && bundled.value === null && !previewMissing.value,
  );
  const q = useQuery({
    queryKey: ['dashboard-config', layerKey, scope ?? computed(() => 'service'), pageId],
    queryFn: () => bffClient.layer.dashboardConfig(layerKey.value, scope?.value, pageId.value),
    // A page the preview already knows is gone needs no request to
    // confirm it — asking would fetch the PUBLISHED copy.
    enabled: configEnabled,
    staleTime: 5 * 60_000,
    // A 404 is the answer, not a failure to reach one.
    retry: false,
  });
  // Deliberately NOT in the refresh round. This is the template — what the
  // widgets ARE, not what they say — and it changes only when an admin pushes
  // one. Refetching it every cycle spent a request per page per round to
  // re-read an unchanged document, and put a config failure in the refresh
  // history where it read as a data problem.

  return {
    config: computed(() => bundled.value ?? q.data.value ?? null),
    // Loading until the page lookup has ANSWERED — config or 404. The old
    // rule (`!loaded && q.isLoading`) went false the moment the bundle
    // landed, so a page the bundle predates showed "No widgets defined"
    // while its network lookup was still in flight: an empty page and a
    // missing one look identical, and the operator sees the wrong one
    // first.
    isLoading: computed(() => !loaded.value || (bundled.value === null && !previewMissing.value && q.isFetching.value)),
    /** The layer resolved, but the requested page is not one of its
     *  pages. Only ever true for an explicit page: with none asked for,
     *  the BFF always has a default grid to answer with. */
    notFound: computed(() => Boolean(pageId.value) && (previewMissing.value || isNotFound(q.error.value))),
    error: q.error,
  };
}

function isNotFound(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const status = (err as { status?: unknown }).status;
  return status === 404;
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
  /** Which page of `scope` is rendered; absent on the default grid. Part
   *  of the request AND the cache key: two pages of one component are
   *  different widget sets against the same entity, and the BFF cannot
   *  check a page it was never told about. */
  page?: Ref<string | undefined>,
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
  /** Optional widget list, sent as the BFF batch (`LayerApi.dashboard` splits a
   *  >cap set into parallel requests + merges). When omitted the BFF resolves
   *  widgets server-side — for callers without the config bundle. */
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
  const previewMode = usePreviewMode();
  /**
   * The page as the SERVER may be told it.
   *
   * `page` is the BFF's "does this route resolve" check, and a preview
   * renders a draft OAP has never seen — so naming it there refuses every
   * request for an unpublished page. One value for the primary request
   * AND the comparison fan-out: they are the same page against different
   * entities, and the first fix omitted it in only one of them, which
   * left every pinned entity 404ing while the primary rendered.
   *
   * The query KEY still carries the real page id — two pages are
   * different widget sets and must not share a cache entry.
   */
  const requestPage = computed<string | undefined>(() => (previewMode.value ? undefined : page?.value));
  /**
   * Lifted out of the query so the refresh round uses the SAME gate. A manual
   * `refetch()` bypasses `enabled`, so a guard that re-derived this condition
   * could drift from it and fetch where the query itself would not.
   *
   * Gating rules:
   *   - layer-wide scopes (topology / dependency / logs / trace / *-profiling)
   *     only need `layerKey`.
   *   - service scope needs service; instance needs service + instance;
   *     endpoint needs service + endpoint.
   */
  const metricsEnabled = computed(() => {
    if (layerKey.value.length === 0) return false;
    // Wait for the config bundle so widgets are resolved before the metrics
    // fire (no empty-list → BFF-default → refetch round-trip).
    if (configReady && !configReady.value) return false;
    const s = scope?.value ?? 'service';
    if (s === 'service') return Boolean(service.value);
    if (s === 'instance') return Boolean(service.value && entityRefs.instance?.value);
    if (s === 'endpoint') return Boolean(service.value && entityRefs.endpoint?.value);
    return true;
  });
  const rangeRef = range ?? computed<DashboardRange | null>(() => null);
  // The IDENTITY of the window, not its bounds. Minute-bucketing them was a
  // half-measure: it slowed the re-keying from every tick to every minute, so
  // the widget grid emptied every other refresh instead of every one. What
  // belongs in a key is the question — "the last hour" — while the bounds
  // travel as the request argument and are re-read when the request is made.
  const timeIdentity = useTimeIdentity();
  const rangeKey = computed(() => (rangeRef.value ? timeIdentity.value : null));
  // Widget count for the "N metrics loading" hint. Chunking is NOT done here:
  // `LayerApi.dashboard` splits an oversized widget set into parallel requests,
  // and the BFF bulk-chunks the OAP trips per batch (http/query/dashboard.ts).
  const progress = ref<{ arrived: number; total: number }>({ arrived: 0, total: 0 });

  const q = useQuery({
    queryKey: [
      'dashboard',
      layerKey,
      service,
      scope ?? computed(() => 'service'),
      page ?? computed(() => undefined),
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
    queryFn: async ({ signal }) => {
      // Snapshotted BEFORE the request goes out. Read after the await it would
      // be whatever the clock says when the answer LANDS, so a slow W1 response
      // arriving into a re-anchored W2 would be stamped W2 — the very mislabel
      // the stamp exists to prevent.
      const askedFor = rangeRef.value ?? null;
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
        // Named only when the server can know it. `page` exists so the BFF
        // can refuse a route that does not resolve — but a PREVIEW renders
        // a draft OAP has never seen, whose page is unknown by definition,
        // and the widgets travel in this same body. Sending it there turned
        // "check this page exists" into "refuse every unpublished page",
        // so Preview → Local rendered a grid with no metrics in it.
        ...(requestPage.value ? { page: requestPage.value } : {}),
        ...(widgetsList?.value.length ? { widgets: widgetsList.value } : {}),
      };
      const opts = mockTop?.value ? { mockTop: mockTop.value } : {};
      // Refused if it could not be read. The route answers 200 with
      // `reachable: false` when OAP is unreachable, and taken as success that
      // replaced every widget's value with nothing — the same "a failure is not
      // an answer" rule the maps and the roster follow. Thrown, the previous
      // widgets stay and the failure reaches the refresh history.
      const resp = await fetchDrawable(() =>
        bffClient.layer.dashboard(layerKey.value, baseBody, opts, signal),
      );
      progress.value = { arrived: resp.widgets?.length ?? total, total };
      // The window travels WITH the response. A retained last-good answer
      // outlives the window that produced it — that is the point of keeping it
      // — so anything drawing it has to ask what it was read with rather than
      // what the clock says now. Captured at firing time, where it is exact.
      return { response: resp, requestWindow: askedFor };
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
    enabled: metricsEnabled,
    // The round owns when this fetches. A 25-second freshness window let a
    // predicate the operator had just visited come back with no request at
    // all, and a window-focus refetch fired outside every round — neither is
    // counted by the countdown, and both can land on top of a round already
    // out.
    staleTime: 0,
    refetchOnWindowFocus: false,
    // A tab switch changes the queryKey (only the active tab's widgets are in
    // the batch — lazy), which would otherwise drop `data` to undefined while
    // the new panel fetches and blank EVERY sibling widget on the page. Keep
    // the prior response so siblings hold their values; the newly-activated
    // tab's own cells fall through to their per-cell "loading…" state (the
    // cascade-clear indicator lives inside the tab, not over the whole grid).
    placeholderData: keepPreviousData,
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
  /**
   * The fan-out's keys, derived from the same inputs the queries are.
   *
   * A capped round cancels by key, and the cohort is one participant holding
   * many queries — so the round needs all of them, not just the primary batch.
   * Built from the same list and helper the queries use, so the two cannot
   * describe different sets.
   */
  const entityQueryKeys = computed<Array<Array<string | number | null>>>(() => {
    if (!compareActive.value) return [];
    const raw = scope?.value ?? 'service';
    if (raw !== 'service' && raw !== 'instance' && raw !== 'endpoint') return [];
    const s: FanoutScope = raw;
    return fanoutList.value.map((entity) => {
      const { service: svc, name } =
        s === 'service' ? { service: entity, name: '' } : splitCompound(entity);
      return entityDashboardKey(
        layerKey.value,
        s,
        svc,
        name,
        mockTop?.value ?? 0,
        rangeKey.value,
        widgetsJson.value,
        page?.value,
      );
    });
  });

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
      // The window this ROUND of the fan-out asks about, captured once for the
      // whole list. The limiter queues these, so a callback reading the live
      // window later could ask about a window the key does not name — and file
      // one entity's newer answer beside its siblings' older ones.
      const askWindow = rangeRef.value;
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
            page?.value,
          ),
          // Refused if it could not be read, like the primary batch — without
          // this one compared entity lost its last-good widgets to a soft OAP
          // failure while its siblings kept theirs.
          // `askWindow` is read before the fan-out is built, so it is already
          // the dispatch-time window; naming it here keeps that visible next to
          // the primary query, which had to capture its own.
          queryFn: async ({ signal }: { signal: AbortSignal }) => ({
            response: await limit(() =>
              fetchDrawable(() =>
                bffClient.layer.dashboard(
                  layerKey.value,
                  entityDashboardBody(s, svc, name, askWindow, widgetsList?.value ?? null, requestPage.value),
                  opts,
                  signal,
                ),
              ),
            ),
            requestWindow: askWindow ?? null,
          }),
          // Zero, like the primary read it fans out beside. A freshness
          // window here would have half a compare cohort re-read while the
          // other half answered from cache — the entities would then be
          // showing different windows in the same row.
          staleTime: 0,
          refetchOnWindowFocus: false,
          // A tab switch changes this entity's queryKey (widgetsJson) too — keep
          // the prior response so compare siblings hold their values, same as the
          // primary query above. Without it, switching a tab blanks every locked
          // entity's cells until the fan-out re-resolves.
          placeholderData: keepPreviousData,
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
    const pData = q.data.value?.response;
    if (p && pData?.widgets) out.set(p, indexById(pData.widgets));
    const results = entityQueries.value;
    fanoutList.value.forEach((entity, i) => {
      const env = results[i]?.data as
        | { response: DashboardResponse; requestWindow: DashboardRange | null }
        | undefined;
      if (env?.response?.widgets) out.set(entity, indexById(env.response.widgets));
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

  /**
   * ONE timer for the whole page.
   *
   * The metric reads used to own a second `refetchInterval` of their own, so a
   * layer dashboard ran two 30s clocks that drifted apart: the header and the
   * roster refreshed on the round while the widgets refreshed on their own
   * phase, and the page redrew in waves. Worse, the countdown described only
   * the round — it could restart while every widget was still loading.
   *
   * They join the round instead. The bulked primary read and the per-entity
   * fan-out are refetched together and awaited together, so the next interval
   * starts when the LAST widget has landed and the page moves as one.
   *
   * The concurrency limiter is untouched and stays where it is: it decides how
   * many of these may be in flight, which is a different question from when
   * they start.
   */
  // Silent otherwise: the coordinator swallows participant rejections by
  // design, so a participant that does not report is not reported at all.
  useRefreshErrorReport({ owner: 'Dashboard', action: 'reading the dashboard metrics', error: q.error });
  // The compare cohort too. Its entities are separate queries, so a failure
  // that hit only one of them was reported nowhere — the tile showed no data
  // and the history stayed empty, which reads as "this entity has none".
  useRefreshErrorReport({
    owner: 'Dashboard',
    action: 'reading a compared entity’s metrics',
    error: computed(() => entityQueries.value.find((eq) => eq.error)?.error ?? null),
  });
  useAutoRefreshSubscribe(
    () =>
      Promise.all([
        q.refetch({ cancelRefetch: false }),
        ...entityQueries.value.map((eq) => eq.refetch({ cancelRefetch: false })),
      ]),

    // Metric scopes only. The rule used to live on `refetchOnWindowFocus`,
    // which is now off for every round-managed query — so it says here what it
    // has always meant: an explore-style page (trace, log, profiling) answers
    // a question the operator asked, and swapping its results out from under
    // them on a timer is not a refresh, it is a loss of their place.
    computed(() => metricsEnabled.value && METRIC_SCOPES.has(scope?.value ?? 'service')),
    // Named so a capped round can CANCEL this page rather than only stop
    // waiting on it — the primary batch and every compare entity, because the
    // fan-out is one participant holding many queries and cancelling the first
    // would leave the rest running past the cap.
    () => [
      [
        'dashboard',
        layerKey.value,
        service.value,
        scope?.value ?? 'service',
        page?.value,
        mockTop?.value ?? 0,
        entityRefs.instance?.value ?? null,
        entityRefs.endpoint?.value ?? null,
        rangeKey.value,
        widgetsList?.value ? JSON.stringify(widgetsList.value) : null,
      ],
      ...entityQueryKeys.value,
    ],
  );

  return {
    data: computed(() => q.data.value?.response ?? null),
    /**
     * The window each entity's widgets were actually READ with.
     *
     * A member whose round failed keeps its previous answer — that is the
     * design — so the cohort can legitimately hold widgets from two windows at
     * once. Anything plotting them needs to know which, or the older series
     * gets drawn against the newer axis and reads as current.
     */
    windowByEntity: computed(() => {
      const out = new Map<string, DashboardRange | null>();
      const p = primaryEntity.value;
      if (p && q.data.value) out.set(p, q.data.value.requestWindow);
      const results = entityQueries.value;
      fanoutList.value.forEach((entity, i) => {
        const env = results[i]?.data as
          | { response: DashboardResponse; requestWindow: DashboardRange | null }
          | undefined;
        if (env) out.set(entity, env.requestWindow);
      });
      return out;
    }),
    isLoading: q.isLoading,
    isFetching: q.isFetching,
    error: q.error,
    refetch: q.refetch,
    /** Widget-count progress for the loading hint: `arrived` is 0 while the
     *  (single, internally-chunked) BFF call is in flight, then total on
     *  resolve. `total` is 0 on the legacy no-widgetsList path. */
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
