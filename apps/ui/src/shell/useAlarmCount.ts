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
import { bff, type AlarmsConfig } from '@/api/client';

/**
 * Topbar alarm-badge data source. Polls `/api/alarms/count` on its own
 * 60s interval for the last `WINDOW_MS` of activity.
 *
 * Why this is independent of `useAutoRefreshSubscribe`:
 *   - The global auto-refresh ticker pauses on `/alarms` (and on the
 *     other per-page-owned routes — traces, logs, profiling). The
 *     badge must keep updating regardless of where the operator is.
 *   - The badge's window is fixed (last 20m), so it has nothing to
 *     align to the global time-range store.
 *
 * Visibility-aware: `refetchIntervalInBackground: false` (Vue Query
 * default) means polling pauses when the tab is hidden; `refetchOn
 * WindowFocus: true` fires an immediate refresh on tab return.
 *
 * `endTime` is captured once per refetch (read via `Date.now()` inside
 * `queryFn`), so the window slides forward on every poll without
 * needing the composable to own any reactive time state.
 */

/** Fallback window when the admin config isn't loaded yet — matches
 *  the BFF's `DEFAULT_CONFIG.defaultWindowMs`. */
const FALLBACK_WINDOW_MS = 20 * 60_000;
const POLL_MS = 60_000;

export function useAlarmCount() {
  /* Shares the queryKey `['alarms/config']` with the page + admin
   * view; Vue Query dedupes the network call so the topbar badge
   * doesn't issue an extra roundtrip just to learn the window size. */
  const cfgQuery = useQuery({
    queryKey: ['alarms/config'],
    queryFn: (): Promise<AlarmsConfig> => bff.alarms.config(),
    staleTime: Infinity,
  });
  const windowMs = computed<number>(
    () => cfgQuery.data.value?.defaultWindowMs ?? FALLBACK_WINDOW_MS,
  );

  const q = useQuery({
    /* Re-key on `windowMs` so an admin who changes the config sees
     * the badge re-fetch with the new window on the next poll. */
    queryKey: computed(() => ['alarms-count', windowMs.value]),
    queryFn: () => {
      const end = Date.now();
      const start = end - windowMs.value;
      return bff.alarms.count(start, end);
    },
    refetchInterval: POLL_MS,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    staleTime: POLL_MS / 2,
  });

  const total = computed<number>(() => q.data.value?.total ?? 0);
  const firing = computed<number>(() => q.data.value?.firing ?? 0);
  const activeIncidents = computed<number>(() => q.data.value?.activeIncidents ?? 0);
  const incidents = computed<number>(() => q.data.value?.incidents ?? 0);
  const truncated = computed<boolean>(() => q.data.value?.truncated ?? false);
  const isLoading = computed<boolean>(() => q.isLoading.value);
  const hasError = computed<boolean>(() => q.isError.value);
  const errorMessage = computed<string | null>(() =>
    q.error.value ? (q.error.value as Error).message : null,
  );

  /** Pretty count for the badge body. Reads `activeIncidents` — a
   *  recovered incident counts as "no alarm". `200+` when truncated. */
  const displayCount = computed<string>(() => {
    if (truncated.value) return `${activeIncidents.value}+`;
    return String(activeIncidents.value);
  });

  return {
    total,
    firing,
    incidents,
    activeIncidents,
    truncated,
    displayCount,
    isLoading,
    hasError,
    errorMessage,
    /** Reactive — reflects the current admin-configured window. */
    windowMs,
    refetch: q.refetch,
  };
}
