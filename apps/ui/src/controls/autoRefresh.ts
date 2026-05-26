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
 * Global auto-refresh ticker.
 *
 * One pinia store schedules a tick every `intervalSec` seconds.
 * Components subscribe via `watch(autoRefresh.tickCount, refetch)`.
 *
 * Pages that own their own time range (e.g. /layer/.../trace) call
 * `suspend()` when they mount and `resume()` when they leave. The
 * topbar wires this up via a `route` watcher with an opt-out regex
 * list, so individual pages don't need to know about the ticker.
 *
 * UI hooks:
 *   - `intervalSec`        — current interval (null = off).
 *   - `effectiveEnabled`   — true when ticker is running (interval
 *                            set AND not suspended).
 *   - `secondsUntilNext`   — live countdown (re-evaluated by the
 *                            visible-countdown ref ticking once a
 *                            second).
 *   - `tickCount`          — increments on every fire; subscribers
 *                            watch this to refetch.
 */

import { defineStore } from 'pinia';
import { computed, onScopeDispose, ref } from 'vue';

export const useAutoRefreshStore = defineStore('auto-refresh', () => {
  const intervalSec = ref<number | null>(30);
  const tickCount = ref(0);
  const lastTickAt = ref(Date.now());
  const suspended = ref(false);
  const nowMs = ref(Date.now());
  // Track the document's visibility separately from `suspended`. Both
  // gate the main timer; we keep them distinct so resuming via route
  // change doesn't accidentally start ticking on a hidden tab, and
  // returning to the tab doesn't override a route-driven suspend.
  const tabVisible = ref(
    typeof document === 'undefined' || document.visibilityState !== 'hidden',
  );

  let timerId: ReturnType<typeof setInterval> | null = null;
  let countdownId: ReturnType<typeof setInterval> | null = null;

  function clearMainTimer(): void {
    if (timerId) {
      clearInterval(timerId);
      timerId = null;
    }
  }
  function startMainTimer(): void {
    clearMainTimer();
    if (intervalSec.value === null || suspended.value || !tabVisible.value) return;
    const ms = intervalSec.value * 1000;
    timerId = setInterval(() => {
      lastTickAt.value = Date.now();
      tickCount.value++;
    }, ms);
  }
  function ensureCountdown(): void {
    if (countdownId) return;
    countdownId = setInterval(() => {
      nowMs.value = Date.now();
    }, 500);
  }
  ensureCountdown();
  startMainTimer();

  // Pause the ticker when the tab is backgrounded. Every dashboard
  // widget + alarm badge poller + topology + layer landing subscribes
  // to `tickCount`, so an unattended tab quietly burns OAP queries at
  // 30s × N subscribers. On visibility-return we fire one immediate
  // tick so the operator sees fresh data right away, then resume the
  // normal cadence. Stays in sync with route-driven `suspended`
  // (opt-out pages remain paused regardless of visibility).
  function onVisibilityChange(): void {
    const visibleNow = document.visibilityState !== 'hidden';
    if (visibleNow === tabVisible.value) return;
    tabVisible.value = visibleNow;
    if (visibleNow) {
      if (!suspended.value && intervalSec.value !== null) refreshNow();
    } else {
      clearMainTimer();
    }
  }
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibilityChange);
  }

  /** Operator picks a new interval (or `null` to disable). */
  function setInterval_(sec: number | null): void {
    intervalSec.value = sec;
    startMainTimer();
  }

  /** Fire one tick now (manual refresh). Resets the timer so the
   *  next auto-fire is `intervalSec` from now, not from the previous
   *  tick. */
  function refreshNow(): void {
    lastTickAt.value = Date.now();
    tickCount.value++;
    startMainTimer();
  }

  /** Suspend ticking (e.g. when entering an opt-out route). */
  function suspend(): void {
    if (suspended.value) return;
    suspended.value = true;
    clearMainTimer();
  }

  /** Resume ticking AND fire one immediate tick — operators leaving
   *  an opt-out route expect the visible data to refresh right
   *  away, then continue ticking. */
  function resume(): void {
    if (!suspended.value) return;
    suspended.value = false;
    refreshNow();
  }

  const effectiveEnabled = computed(
    () => intervalSec.value !== null && !suspended.value,
  );
  const nextTickAt = computed(() =>
    intervalSec.value === null ? null : lastTickAt.value + intervalSec.value * 1000,
  );
  const secondsUntilNext = computed(() => {
    const next = nextTickAt.value;
    if (next === null || suspended.value) return null;
    return Math.max(0, Math.round((next - nowMs.value) / 1000));
  });

  onScopeDispose(() => {
    clearMainTimer();
    if (countdownId) {
      clearInterval(countdownId);
      countdownId = null;
    }
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisibilityChange);
    }
  });

  return {
    intervalSec,
    tickCount,
    suspended,
    effectiveEnabled,
    secondsUntilNext,
    setInterval: setInterval_,
    refreshNow,
    suspend,
    resume,
  };
});
