// Licensed to the Apache Software Foundation (ASF) under one or more
// contributor license agreements.  See the NOTICE file distributed with
// this work for additional information regarding copyright ownership.
// The ASF licenses this file to You under the Apache License, Version 2.0
// (the "License"); you may not use this file except in compliance with
// the License.  You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { computed, type ComputedRef } from 'vue';
import { useRoute } from 'vue-router';
import { useTimeRangeStore } from '@/controls/timeRange';

/**
 * Routes where the global topbar time picker + auto-refresh are disabled
 * (greyed + non-clickable). Two reasons land a route here:
 *   1. The page owns its OWN time range (traces / logs / alarms /
 *      profiling) — its local picker is the source of truth.
 *   2. The page has NO time context at all (every config/admin page and
 *      every operate page) — they never poll metrics, so a rolling window
 *      + auto-refresh make no sense. See `noTimeContext` for the wording.
 *
 * Add more per-page-picker routes here as Logs / Traces / etc. opt out.
 */
const TIME_RANGE_OPT_OUT = [
  /^\/layer\/[^/]+\/trace$/,
  // Logs carry their own time picker (the condition bar); the level /
  // keyword filters make rolling-window refresh awkward mid-investigation.
  /^\/layer\/[^/]+\/logs$/,
  // Browser Logs has its own Time range picker — auto-refresh would shift
  // the visible window mid-investigation.
  /^\/layer\/[^/]+\/browser-errors$/,
  // Pod Logs is a live tail driven by its own interval poll — the global
  // ticker would double-fire and there's no rolling window to refresh.
  /^\/layer\/[^/]+\/pod-logs$/,
  // Alarms is a triage view — auto-refresh shifts the window out from under
  // any selection/brush, and the traffic backfill is chunked with its own
  // explicit delta refresh.
  /^\/alarms$/,
  // Profiling tabs bind to a *task*; auto-refresh would yank the task list,
  // re-pick the first task, and blow away the analyze pane mid-investigation.
  // The pages expose their own "refresh tasks" affordance instead.
  /^\/layer\/[^/]+\/trace-profiling$/,
  /^\/layer\/[^/]+\/ebpf-profiling$/,
  /^\/layer\/[^/]+\/network-profiling$/,
  /^\/layer\/[^/]+\/async-profiling$/,
  /^\/layer\/[^/]+\/pprof$/,
  // Config (admin) + operate pages have no time concept — they never poll
  // metrics, so the global picker + auto-refresh are off on all of them.
  /^\/admin\//,
  /^\/operate\//,
];

/**
 * Shared route-derived time-context flags for the topbar's time-range
 * picker and auto-refresh chips. Both chips read the same opt-out rules;
 * keep them in one place so the picker disable + the ticker suspend stay
 * in lock-step.
 */
export interface TopbarTimeContext {
  /** The current page owns its own time range (page-local picker) or has
   *  no time concept — the global picker + ticker are disabled. */
  ownsTimeRange: ComputedRef<boolean>;
  /** The no-time-context subset of the opt-out (config/admin + operate),
   *  vs. pages that own a page-local picker (traces / logs / …). Only
   *  changes the tooltip wording — the disable behaviour is the same. */
  noTimeContext: ComputedRef<boolean>;
  /** Auto-refresh is paused whenever the operator has frozen the window
   *  to a custom range — polling a fixed snapshot just re-fetches the
   *  same bytes. The button still works for a one-shot manual refresh. */
  hasFrozenRange: ComputedRef<boolean>;
  /** True when the ticker should be suspended (page opt-out OR frozen). */
  autoSuspended: ComputedRef<boolean>;
}

export function useTopbarTimeContext(): TopbarTimeContext {
  const route = useRoute();
  const ownsTimeRange = computed<boolean>(() => TIME_RANGE_OPT_OUT.some((r) => r.test(route.path)));
  const noTimeContext = computed<boolean>(() => /^\/(admin|operate)\//.test(route.path));
  const hasFrozenRange = computed<boolean>(() => useTimeRangeStore().presetId === 'custom');
  const autoSuspended = computed<boolean>(() => ownsTimeRange.value || hasFrozenRange.value);
  return { ownsTimeRange, noTimeContext, hasFrozenRange, autoSuspended };
}
