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
 * Events data feed for the per-service events popout. Wraps the BFF
 * `queryEvents` call, keyed on the window + applied filters so a change
 * cascade-clears and refires. Returns the raw newest-first rows; the popout
 * lays them out as an instance × time swimlane. `truncated` is true when the
 * raw fetch hit the page-size cap — older events beyond it aren't shown until
 * the window narrows.
 *
 * Failure handling: the BFF soft-fails an OAP error to a `reachable: false`
 * envelope (HTTP 200), but an auth (403) / 5xx makes `bff.request` THROW, which
 * lands the query in its error state with no `data`. Both paths collapse into
 * `reachable === false` + `errorMsg` here, so the popout shows an error rather
 * than a misleading "no events".
 */

import { computed, type ComputedRef, type Ref } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { bff, type EventRow, type EventType, type EventsResponse } from '@/api/client';

/** The scope the events query filters by. `''` means unset for each field.
 *  The popout supplies a fixed `layer` + `service` (the banner's selection). */
export interface EventFilterValues {
  layer: string;
  service: string;
  type: '' | EventType;
  name: string;
}

/** Raw rows requested per query — the popout's working set. Matches the BFF
 *  `maxPageSize.events` default; the BFF clamps to its configured cap. */
export const EVENTS_PAGE_SIZE = 200;

export interface UseEventsResult {
  events: ComputedRef<EventRow[]>;
  truncated: ComputedRef<boolean>;
  reachable: ComputedRef<boolean>;
  errorMsg: ComputedRef<string | null>;
  isPending: ComputedRef<boolean>;
  isFetching: ComputedRef<boolean>;
  refetch: () => void;
}

export function useEvents(
  startTime: Ref<number>,
  endTime: Ref<number>,
  applied: Ref<EventFilterValues>,
  enabled?: Ref<boolean>,
): UseEventsResult {
  const query = useQuery({
    queryKey: computed(() => [
      'events',
      startTime.value,
      endTime.value,
      applied.value.layer,
      applied.value.service,
      applied.value.type,
      applied.value.name,
    ]),
    queryFn: (): Promise<EventsResponse> =>
      bff.events.query({
        startMs: startTime.value,
        endMs: endTime.value,
        layer: applied.value.layer || undefined,
        service: applied.value.service || undefined,
        type: applied.value.type || undefined,
        name: applied.value.name || undefined,
        pageSize: EVENTS_PAGE_SIZE,
      }),
    // Mounted permanently in the shell — gate closed so it only queries open.
    enabled: computed(() => enabled?.value ?? true),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });

  const events = computed<EventRow[]>(() => query.data.value?.events ?? []);
  // True once the fetch hit the cap. Compare against the BFF's echoed pageSize
  // (not the constant), so a sub-default `maxPageSize.events` still flips it.
  const truncated = computed<boolean>(() => {
    const data = query.data.value;
    if (!data) return false;
    return data.total >= (data.pageSize ?? EVENTS_PAGE_SIZE);
  });
  // A thrown request (403 / 5xx) → error state, no data → NOT reachable.
  const reachable = computed<boolean>(() => {
    if (query.isError.value) return false;
    return query.data.value?.reachable ?? true;
  });
  const errorMsg = computed<string | null>(() => {
    if (query.isError.value) {
      const e = query.error.value;
      return e instanceof Error ? e.message : String(e ?? 'request failed');
    }
    return query.data.value?.error ?? null;
  });

  return {
    events,
    truncated,
    reachable,
    errorMsg,
    isPending: computed(() => query.isPending.value),
    isFetching: computed(() => query.isFetching.value),
    refetch: () => {
      void query.refetch();
    },
  };
}
