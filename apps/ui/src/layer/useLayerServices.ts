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
 * Reactive full-service-roster lookup for a layer. Backs the layer
 * shell's URL-service validator — when a deep link or hierarchy peer
 * click arrives with `?service=<id>`, the shell checks the id against
 * this roster (the layer's REAL service list, independent of
 * landing's top-N rollup which can miss low-traffic services). A
 * missing id pops the "service not found" notice; a present id is
 * trusted regardless of landing visibility.
 */

import { computed, type Ref } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { useAutoRefreshSubscribe } from '@/controls/useAutoRefreshSubscribe';
import { useRefreshErrorReport } from '@/controls/errorCenter';
import { fetchDrawable } from '@/layer/graphQuery';
import { bffClient } from '@/api/client';

export interface LayerServiceRow {
  id: string;
  name: string;
  normal: boolean | null;
  /** OAP `Service.group` — the `<group>::` prefix, empty when the service has
   *  none. Lets a caller section a long roster instead of listing it flat. */
  group: string;
}

/**
 * Reactive, shared roster for a layer. vue-query keys it by
 * `['layer-services', layerKey]`, so every caller of this composable (and
 * anyone using that same key) reads ONE cached copy — the app-wide page
 * cache for the service list; no repeated reads within or across the
 * pages that need it. The 60s `staleTime` matches the BFF catalog's TTL.
 *
 * It also rides the global auto-refresh ticker: a manual / interval
 * refresh re-pulls the roster (cheap — the BFF returns its cached
 * catalog snapshot), so services that came online or went away show up
 * without a navigation. Pages that own their time range suspend the
 * ticker, so they don't thrash it either.
 */
export function useLayerServices(
  layerKey: Ref<string>,
  /** Embedded (chat) callers pass `{ rideTicker: false }` so the roster does not
   *  subscribe to the global auto-refresh ticker — an embedded block owns its own
   *  frozen window and must not add a ticker-driven refetch. Default rides it.
   *  `replay: true` suppresses the fetch entirely — a replay map hides the pickers
   *  this roster feeds and must fire ZERO queries. */
  opts: { rideTicker?: boolean; replay?: Ref<boolean> } = {},
) {
  const isEnabled = computed(() => !(opts.replay?.value ?? false) && layerKey.value.length > 0);
  const q = useQuery({
    queryKey: ['layer-services', layerKey],
    // Refused if the roster could not be READ. The route answers 200 with an
    // empty list when OAP is unreachable, and taken as success that emptied the
    // service picker mid-outage — a statement that the layer has no services.
    queryFn: ({ signal }) =>
      fetchDrawable(() => bffClient.layer.services(layerKey.value, signal)),
    enabled: isEnabled,
    // A roster is near-static, so a minute of cache is worth having when an
    // operator navigates away and back.
    staleTime: 60_000,
    // But the ROUND is what refreshes it, including the one fired on returning
    // to the tab — so a window-focus refetch would only add traffic no
    // countdown accounts for.
    refetchOnWindowFocus: false,
  });
  if (opts.rideTicker !== false) {
    // The promise is RETURNED so the round counts its next interval from when
    // this settles, and the roster's own gate is the component field.
  // A round that could not read this says so in the refresh history. Without
  // it a failed round on this screen was silent everywhere: the coordinator
  // swallows participant rejections by design, so a participant that does not
  // report is not reported at all.
  useRefreshErrorReport({ owner: 'Service list', action: 'reading the service list', error: q.error });
    // Named so a capped round can CANCEL this read. Without a key the cap could
    // only stop waiting: a wedged roster went on holding the page busy, which
    // kept the next timer from arming at all.
    useAutoRefreshSubscribe(() => q.refetch({ cancelRefetch: false }), isEnabled, () => [
      'layer-services',
      layerKey.value,
    ]);
  }
  return {
    data: computed(() => q.data.value ?? null),
    services: computed<LayerServiceRow[]>(() => q.data.value?.services ?? []),
    isLoading: q.isLoading,
    isFetching: q.isFetching,
    /** The roster read failed. A caller resolving an id against it treats this
     *  as settled-with-nothing: there is no further answer coming. */
    isError: q.isError,
  };
}
