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
import type { LandingConfig, LandingResponse, LayerDef } from '@skywalking-horizon-ui/api-client';
import { bffClient } from '@/api/client';
import { fetchDrawable, GraphUnavailableError, useTimeIdentity } from '@/layer/graphQuery';
import { useAutoRefreshSubscribe } from '@/controls/useAutoRefreshSubscribe';
import { useRefreshErrorReport } from '@/controls/errorCenter';

/**
 * Live top-N service rollup for one Overview landing card. Polls every
 * 60s (sufficient for a MINUTE-step window) and falls back gracefully
 * when OAP is unreachable — the BFF surfaces `reachable: false` and the
 * card keeps the placeholder rows.
 *
 * The query key includes the resolved column set so changing a layer's
 * setup (in Stage 2.3+) re-fetches automatically.
 */
export interface LandingRange {
  step: 'MINUTE' | 'HOUR' | 'DAY';
  startMs: number;
  endMs: number;
}

export function useLayerLanding(
  layer: Ref<LayerDef>,
  cfg: Ref<LandingConfig>,
  /** Optional global time-range ref. Threaded into the BFF body
   *  + queryKey so a time-picker change refires the landing
   *  rollup the same way a layer change does. */
  range?: Ref<LandingRange | null>,
  /** REPLAY mode gate: a replay (captured) map hides the service picker this
   *  rollup feeds and must fire ZERO queries, so it passes a true ref to suppress
   *  the fetch. Defaults off (live) for the interactive route. */
  replay?: Ref<boolean>,
) {
  const layerKey = computed(() => layer.value.key);
  // Cache key reflects every field that changes the server response —
  // when an operator edits aggregation / MQE override / scale via setup,
  // vue-query re-fetches.
  const cfgHash = computed(() => JSON.stringify({
    topN: cfg.value.topN,
    orderBy: cfg.value.orderBy,
    columns: cfg.value.columns,
  }));
  const rangeRef = range ?? computed<LandingRange | null>(() => null);
  // The IDENTITY of the window, not its bounds. Minute-bucketing them made the
  // clock re-key the query, which is a refresh by accident: it fired outside
  // any round, was uncounted by the countdown, and emptied the roster while the
  // replacement was out. The bounds still travel as the request argument.
  const timeIdentity = useTimeIdentity();
  const rangeKey = computed(() => (rangeRef.value ? timeIdentity.value : null));

  // Service list is the layer's in-memory snapshot — cache it
  // aggressively (staleTime: Infinity, no window-focus refetch).
  // Two ways to refresh:
  //   1. The global auto-refresh ticker (`useAutoRefreshSubscribe`
  //      below) — operator pace, controlled from the topbar.
  //   2. The manual refresh button in LayerShell — `q.refetch()`.
  // No silent vue-query-driven refetch under the operator, so the
  // service list never moves on its own between operator actions.
  const isEnabled = computed(() => !(replay?.value ?? false));
  const q = useQuery({
    queryKey: ['layer-landing', layerKey, cfgHash, rangeKey],
    // Wrapped for the same reason the graphs are: the route answers HTTP 200
    // with `reachable: false` and an EMPTY roster when it could not read OAP.
    // Taken as success, that empties the service list and reports a service
    // count of zero — a statement about the operator's system, made from a
    // failure to read it. Thrown, the previous roster survives in the cache and
    // the failure reaches the refresh history.
    queryFn: ({ signal }) =>
      fetchDrawable(() =>
        bffClient.layer.landing(layerKey.value, cfg.value, rangeRef.value ?? undefined, signal),
      ),
    enabled: isEnabled,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });

  // The ROUND refreshes this, now that the key no longer moves with the clock.
  // `refetch` bypasses `staleTime: Infinity` above, which is what keeps the
  // roster still between operator actions while still letting a round refresh
  // it. A replay block is gated out: it must fire no queries at all.
  // A round that could not read this says so in the refresh history. Without
  // it a failed round on this screen was silent everywhere: the coordinator
  // swallows participant rejections by design, so a participant that does not
  // report is not reported at all.
  useRefreshErrorReport({ owner: 'Layer landing', action: 'reading the layer landing metrics', error: q.error });
  useAutoRefreshSubscribe(() => q.refetch({ cancelRefetch: false }), isEnabled, () => [
    'layer-landing',
    layerKey.value,
    cfgHash.value,
    rangeKey.value,
  ]);

  // `data` is the last roster worth showing — an unreadable answer never
  // becomes it, so a failed read leaves the previous services on screen.
  const data = computed<LandingResponse | null>(() => q.data.value ?? null);
  const rows = computed(() => data.value?.rows ?? []);
  /**
   * Reachable describes the LATEST ATTEMPT, not the rows above.
   *
   * They are deliberately different sources: the rows are the last good answer,
   * this is whether the most recent read got one. A page that took both from
   * the same object either claimed a stale roster was current, or threw the
   * roster away to report the failure.
   */
  const failed = computed(() =>
    q.error.value instanceof GraphUnavailableError ? (q.error.value.response as LandingResponse) : null,
  );
  const reachable = computed(() => (failed.value ? false : (data.value?.reachable ?? false)));
  const error = computed(
    () => failed.value?.error ?? data.value?.error ?? (q.error.value ? String(q.error.value) : undefined),
  );

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
