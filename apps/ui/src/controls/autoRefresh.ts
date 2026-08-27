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
 * One store, one timer, for the whole page. Screens REGISTER with `joinRound`
 * and the store calls them: it re-anchors the window once, runs every
 * subscriber, waits for all of them, and only then counts toward the next
 * round. Watching `tickCount` to refetch was the older arrangement and is not
 * one any more — a screen that both registers and watches fetches twice per
 * round.
 *
 * Pages that own their own time range (e.g. /layer/.../trace) call
 * `suspend()` when they mount and `resume()` when they leave. The
 * topbar wires this up via a `route` watcher with an opt-out regex
 * list, so individual pages don't need to know about the ticker.
 *
 * THREE pieces of state, deliberately separate:
 *   - `intervalSec` — the cadence the operator chose. ALWAYS a number; it
 *     survives being turned off, so switching back on returns to it.
 *   - `enabled`     — the operator's global on/off.
 *   - `suspendedBy` — a SET of reasons held by the app: an opt-out route, the
 *     hierarchy overlay. Ticking pauses while any holder wants it and resumes
 *     only when the last one releases. A boolean could not express two
 *     independent holders, and whichever released first unfroze both.
 *
 * The rule that makes the split worth having: **suspension never writes
 * operator state.** Entering an opt-out page adds a reason; leaving removes it
 * and touches nothing else, so `enabled` and `intervalSec` are preserved by
 * never having been altered.
 *
 * UI hooks:
 *   - `intervalSec`        — the chosen cadence (never null).
 *   - `enabled`            — the operator's switch.
 *   - `effectiveEnabled`   — true when ticker is running (enabled AND
 *                            nothing suspending).
 *   - `secondsUntilNext`   — live countdown (re-evaluated by the
 *                            visible-countdown ref ticking once a
 *                            second).
 *   - `tickCount`          — increments once per round, BEFORE the work, so
 *                            the time store re-anchors the rolling window
 *                            first. Not a subscription mechanism; see above.
 *   - `roundRunning`       — a round is out. The countdown reads it, and so
 *                            does anything that must not re-anchor mid-round.
 *   - `currentRound`       — what that round IS (id, trigger, start), so a
 *                            failure can be attributed to it.
 */

import { defineStore } from 'pinia';
import { computed, onScopeDispose, ref, shallowRef } from 'vue';
import { queryClient } from '@/api/queryClient';
import { useTimeRangeStore } from '@/controls/timeRange';
import { readColdStageHeader } from '@/controls/coldStage';

/**
 * What one round IS, published while it runs.
 *
 * Everything a subscriber needs to describe the round it is part of, decided
 * ONCE at the start: the same id and the same trigger for every screen in it.
 * Without it each subscriber answered "which round am I in?" for itself, and
 * two screens refreshed by the same tick could disagree.
 */
export interface RefreshRoundContext {
  roundId: number;
  trigger: RefreshTrigger;
  /** The window every participant in this round asks about. Decided once, at
   *  the top, so two screens in one round cannot describe different windows. */
  startMs: number;
  endMs: number;
  step: string;
  /** The stage the round reads from. Part of the context rather than a header
   *  read per request, so a flip mid-round cannot split it. */
  coldStage: boolean;
  startedAt: number;
}

/** Who set a round off. Kept apart from the round itself because the answer
 *  changes what a failure MEANS: a timer round nobody asked for belongs in the
 *  history, an operator's click deserves an answer on screen. */
export type RefreshTrigger =
  | 'auto'
  | 'manual'
  | 'time-change'
  | 'cold-stage'
  | 'visibility'
  | 'resume';

export const useAutoRefreshStore = defineStore('auto-refresh', () => {
  const intervalSec = ref<number>(30);
  const enabled = ref(true);
  const tickCount = ref(0);
  const lastTickAt = ref(Date.now());
  /** Reason keys, not a flag — see the header. */
  const suspendedBy = ref<Set<string>>(new Set());
  const suspended = computed(() => suspendedBy.value.size > 0);
  const nowMs = ref(Date.now());
  // Track the document's visibility separately from `suspended`. Both
  // gate the main timer; we keep them distinct so resuming via route
  // change doesn't accidentally start ticking on a hidden tab, and
  // returning to the tab doesn't override a route-driven suspend.
  const tabVisible = ref(
    typeof document === 'undefined' || document.visibilityState !== 'hidden',
  );

  /**
   * Subscribers that make up a ROUND. The ticker awaits them, so the next
   * interval is counted from when the work finished rather than from when it
   * started — on a slow backend a fixed rate simply overlaps rounds, and the
   * displayed countdown describes wall-clock rather than anything an operator
   * can act on.
   */
  const subscribers = new Set<(signal: AbortSignal) => Promise<unknown> | unknown>();
  function joinRound(fn: (signal: AbortSignal) => Promise<unknown> | unknown): () => void {
    subscribers.add(fn);
    return () => { subscribers.delete(fn); };
  }
  /**
   * How long a round may hold the scheduler before it is CANCELLED.
   *
   * The cap aborts the round's signal rather than walking away from it. The
   * difference matters: releasing the scheduler while requests are still out
   * lets the next round start on top of them, so two windows' answers land
   * interleaved — which is the chaos this whole design exists to prevent.
   */
  const ROUND_CAP_MS = 60_000;
  /**
   * How long after the abort the round still waits before releasing anyway.
   *
   * A subscriber that cannot honour a signal would otherwise hold the
   * scheduler for ever, and one wedged screen must not stop every other one
   * refreshing. Releasing here is a decision to move on, not a claim that the
   * request stopped.
   */
  const ABORT_GRACE_MS = 5_000;
  /** True while a round is out. Reactive because the countdown reads it: while
   *  the work is in flight there is no next-tick instant to count toward. */
  const roundRunning = ref(false);
  /** The round now out, or null. Subscribers read it to attribute a failure to
   *  the round that caused it. */
  const currentRound = shallowRef<RefreshRoundContext | null>(null);
  let roundSeq = 0;
  /**
   * A trigger that arrived while a round was out.
   *
   * COALESCED, not queued: however many arrive, exactly one more round runs
   * when this one settles. Dropping them outright was wrong for the triggers
   * that mean something changed — coming back to the tab, leaving a paused
   * page — because the round in flight was asking about the state BEFORE that
   * happened. Queueing them all would be worse: a slow backend would build a
   * backlog of rounds each asking about a window already gone.
   */
  let trailing: RefreshTrigger | null = null;
  /** The round now out, as a promise, so a caller arriving mid-round can await
   *  the real thing. */
  let activeRound: Promise<void> | null = null;
  /**
   * Waiters for "the page has stopped refreshing".
   *
   * Distinct from awaiting a round, and the difference is exactly the
   * coalescing case: a trigger arriving mid-round resolves its caller
   * immediately, because the round it asked for has not started yet. Anything
   * that must act AFTER the page has settled — re-reading what a round did not
   * cover, say — has to wait for the trailing round too.
   */
  /**
   * Told when a round gave up at its cap.
   *
   * A callback rather than a direct call into the error centre: this store is
   * imported by the time store, and reaching the other way would close a cycle
   * through Pinia at module-evaluation time. The shell wires it once.
   */
  let onCapped: ((round: RefreshRoundContext) => void) | null = null;
  function onRoundCapped(fn: (round: RefreshRoundContext) => void): void {
    onCapped = fn;
  }
  let idleWaiters: Array<() => void> = [];
  function notifyIdle(): void {
    const waiting = idleWaiters;
    idleWaiters = [];
    for (const resolve of waiting) resolve();
  }
  function whenIdle(): Promise<void> {
    if (!roundRunning.value && trailing === null) return Promise.resolve();
    return new Promise<void>((resolve) => idleWaiters.push(resolve));
  }
  /** When the last round SETTLED. Kept for `tickCount` consumers and tests. */
  const lastRoundEndAt = ref(Date.now());
  /**
   * When the armed timeout will actually fire, or null when nothing is armed.
   *
   * The countdown reads THIS rather than deriving a deadline, so the number on
   * screen is the timer's own.
   */
  const nextRunAt = ref<number | null>(null);
  /**
   * Anything at all is loading.
   *
   * Not just a round: a page's first read, a picker's cascade, a widget batch.
   * The operator's rule is that loading time is not counted against the
   * interval — a countdown that keeps draining while the page is visibly busy
   * describes a schedule the page is not keeping. So the timer holds while this
   * is true and starts a FULL interval once it clears.
   */
  const busy = ref(false);

  /**
   * Track in-flight query traffic, so the timer can hold while the page loads.
   *
   * Read from the query cache rather than `useIsFetching`, which needs a
   * component context this store does not have. The subscription is torn down
   * with the store.
   */
  const stopWatchingTraffic = queryClient.getQueryCache().subscribe(() => {
    // Only PAGE traffic counts. The shell's own pollers (OAP info, layers,
    // admin features, the alarm badge) run on independent clocks by design, and
    // counting them made the coordinated timer restart every time one of them
    // ticked — a 30-second poller against a 30-second cadence postponed every
    // round indefinitely, so auto-refresh silently never happened.
    const now = queryClient
      .getQueryCache()
      .getAll()
      .some((q) => q.state.fetchStatus === 'fetching' && q.meta?.independentPoll !== true);
    if (now === busy.value) return;
    busy.value = now;
    // Settling starts a FULL interval — "全部轮次完成后才开始完整的新周期". Going
    // busy disarms, so nothing fires while the page is still filling in.
    if (!now) startMainTimer();
    else clearMainTimer();
  });

  let timerId: ReturnType<typeof setTimeout> | null = null;
  let countdownId: ReturnType<typeof setInterval> | null = null;

  function clearMainTimer(): void {
    if (timerId) {
      clearTimeout(timerId);
      timerId = null;
    }
  }
  /** Arm the NEXT round, counted from now — i.e. from the moment the previous
   *  one settled, since this is called when it does. */
  function startMainTimer(): void {
    clearMainTimer();
    nextRunAt.value = null;
    if (!enabled.value || suspended.value || !tabVisible.value) return;
    // While anything is loading there is no deadline to hold the page to. The
    // timer is re-armed, for a FULL interval, when the traffic settles.
    if (busy.value) return;
    const delay = intervalSec.value * 1000;
    // Stamped HERE, where the timeout is actually armed, so the countdown and
    // the timer cannot disagree. Deriving it from the last round's end instead
    // was wrong at three of this function's four call sites — they re-arm the
    // timeout without ending a round, so the countdown kept running against an
    // older stamp and the next round fired while it still read several seconds.
    nextRunAt.value = Date.now() + delay;
    timerId = setTimeout(() => { void runRound('auto'); }, delay);
  }

  /**
   * One refresh round: tell every subscriber to refetch, wait for them, then
   * arm the next interval.
   *
   * Coalesced rather than queued: a trigger arriving while a round is out is
   * dropped, because it would ask for exactly what is already being fetched.
   * The four triggers — timer, manual refresh, resume, visibility-return — all
   * come through here, so they cannot interleave differently.
   */
  function runRound(trigger: RefreshTrigger = 'auto'): Promise<void> {
    if (roundRunning.value) {
      // The TIMER never queues. Its own timeout is cleared for the duration of
      // a round, so one arriving here is a stale fire from before the round
      // began — asking for a repeat of what is already being fetched.
      if (trigger !== 'auto') trailing = trigger;
      // The caller gets the round that is actually out, not an empty promise.
      // Returning immediately made "await a refresh" mean "await nothing" for
      // every caller that arrived a moment late.
      return activeRound ?? Promise.resolve();
    }
    const round = runRoundInner(trigger);
    activeRound = round;
    return round;
  }

  async function runRoundInner(trigger: RefreshTrigger): Promise<void> {
    roundRunning.value = true;
    roundSeq += 1;
    // The timer is STOPPED for the duration, explicitly. A timeout armed
    // before this round began is still pending and would fire mid-round —
    // coalesced by the guard above, but only by accident. Clearing it makes
    // "one round at a time" a property of the scheduler rather than a
    // consequence of a check somewhere else.
    clearMainTimer();
    lastTickAt.value = Date.now();
    // Bumped BEFORE the work: the time store re-anchors the rolling window on
    // this, synchronously, so the requests below ask about the window as of
    // now rather than the one the previous round used. Once, for the whole
    // round — every screen in it therefore asks about the SAME window, which
    // per-subscriber re-anchoring could not promise.
    tickCount.value++;
    // Read AFTER the re-anchor, so the context describes the window this round
    // will actually ask about rather than the previous one's.
    const timeRange = useTimeRangeStore();
    currentRound.value = {
      roundId: roundSeq,
      trigger,
      startMs: timeRange.range.startMs,
      endMs: timeRange.range.endMs,
      step: timeRange.step,
      coldStage: readColdStageHeader(),
      startedAt: Date.now(),
    };
    const controller = new AbortController();
    // Whether THIS round hit its cap. Reported after the round settles, because
    // a cap that leaves no trace is indistinguishable from a round that simply
    // took a while — and the operator is looking at a page whose data may be
    // from before it.
    let capped_ = false;
    try {
      const work = [...subscribers].map((fn) => {
        try {
          return Promise.resolve(fn(controller.signal));
        } catch {
          // A subscriber that throws synchronously must not take the round
          // down with it; the others still deserve their refresh.
          return Promise.resolve();
        }
      });
      const settled = Promise.allSettled(work);
      let capId: ReturnType<typeof setTimeout> | undefined;
      const capped = new Promise<void>((resolve) => {
        capId = setTimeout(() => {
          capped_ = true;
          controller.abort();
          // Cancelled, then given a moment to actually stop. Resolving the
          // instant we abort would be the same premature release the cap was
          // supposed to replace.
          setTimeout(resolve, ABORT_GRACE_MS);
        }, ROUND_CAP_MS);
      });
      await Promise.race([settled, capped]);
      if (capId) clearTimeout(capId);
    } finally {
      roundRunning.value = false;
      const finished = currentRound.value;
      currentRound.value = null;
      activeRound = null;
      if (capped_ && finished) onCapped?.(finished);
      lastRoundEndAt.value = Date.now();
      const pending = trailing;
      trailing = null;
      // A trailing round runs only if it is still wanted. The operator may have
      // switched off, or the page suspended, while the round it was queued
      // behind was out — a manual click is the exception, because asking for
      // data explicitly works whether or not the timer does.
      // An operator ACTION is always still wanted, whatever the timer is doing:
      // a manual click, a time-range change, a cold-stage flip. Only `manual`
      // used to qualify, so a range picked while a round was out — which
      // suspends auto-refresh when it is a custom range — had its corrective
      // round silently dropped, leaving the page on the previous window.
      // Not into a hidden tab, though: nobody is looking, and the visibility
      // handler has already stood the schedule down.
      const operatorAsked =
        pending === 'manual' || pending === 'time-change' || pending === 'cold-stage';
      const stillWanted =
        tabVisible.value && (operatorAsked || (enabled.value && !suspended.value));
      if (pending !== null && stillWanted) {
        // Not idle yet — the successor notifies when IT settles.
        void runRound(pending);
      } else {
        // Declines to arm if the operator switched off, or something suspended,
        // while this round was out — the round finishes, the next one does not
        // begin.
        startMainTimer();
        notifyIdle();
      }
    }
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
      if (!suspended.value && enabled.value) void runRound('visibility');
    } else {
      clearMainTimer();
    }
  }
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibilityChange);
  }

  /**
   * Operator picks a cadence. Picking one also ENABLES: choosing "every
   * minute" is not a request to stay off.
   */
  function setInterval_(sec: number): void {
    intervalSec.value = sec;
    enabled.value = true;
    startMainTimer();
  }

  /**
   * The operator's global switch. `intervalSec` is untouched, so off → on
   * returns to the cadence last chosen rather than to a default.
   */
  function setEnabled(on: boolean): void {
    if (enabled.value === on) return;
    enabled.value = on;
    if (on) void enableRefresh();
    else clearMainTimer();
  }
  function toggleEnabled(): void {
    setEnabled(!enabled.value);
  }

  /**
   * Run a round now (manual refresh). The next auto-fire is `intervalSec` from
   * when this one SETTLES, not from when it started.
   *
   * Returns the round so a caller — or a test — can wait for it. Callers that
   * only want it started may ignore the promise.
   */
  function refreshNow(trigger: RefreshTrigger = 'manual'): Promise<void> {
    return runRound(trigger);
  }

  /**
   * Switching auto-refresh ON.
   *
   * Saves the preference, and refreshes only if a round could actually run. On
   * a hidden tab or a paused page it used to fire one immediately — which is
   * the opposite of what those states mean, and put a round's worth of queries
   * on a backend for a page nobody was looking at.
   */
  function enableRefresh(): void {
    if (suspended.value || !tabVisible.value) {
      startMainTimer();
      return;
    }
    void runRound('resume');
  }

  /**
   * Hold ticking for a NAMED reason (an opt-out route, the hierarchy overlay).
   * Idempotent per reason, and holders do not interfere: two can hold at once.
   */
  function suspend(reason = 'route'): void {
    if (suspendedBy.value.has(reason)) return;
    const next = new Set(suspendedBy.value);
    next.add(reason);
    suspendedBy.value = next;
    // Stops the NEXT round, never the one in flight. A round CAN be cancelled
    // now — its cap does exactly that — but cancelling one halfway on a pause
    // would leave the page holding whatever fraction had landed, beside values
    // from the round before, with nothing on screen to say so. A round that has
    // started always finishes; `startMainTimer` in its `finally` then declines
    // to arm another while this holds.
    clearMainTimer();
  }

  /**
   * Release one reason. Ticking resumes only when the LAST holder lets go —
   * releasing another's claim is what let the hierarchy overlay's freeze be
   * broken by an unrelated route change.
   *
   * The immediate tick exists because leaving a frozen page should show
   * current data at once. It is NOT fired when the operator has auto-refresh
   * off: their switch decides, and honouring it is the whole point of keeping
   * `enabled` separate from suspension.
   */
  function resume(reason = 'route'): void {
    if (!suspendedBy.value.has(reason)) return;
    const next = new Set(suspendedBy.value);
    next.delete(reason);
    suspendedBy.value = next;
    if (next.size > 0) return;
    if (enabled.value) void runRound('resume');
  }

  // Three independent conditions, all of which must hold. `tabVisible` was
  // missing, so a backgrounded tab reported itself as refreshing and the
  // countdown drained toward a round the visibility handler had already
  // stopped from being armed.
  const effectiveEnabled = computed(
    () => enabled.value && suspendedBy.value.size === 0 && tabVisible.value,
  );
  // From the END of the last round, which is what "counts down after the last
  // round completed" means: during a slow round the countdown is not describing
  // a deadline that has already passed.
  const nextTickAt = computed(() => nextRunAt.value);
  const secondsUntilNext = computed(() => {
    // Nothing to count while a round is out: the next one starts when THIS one
    // ends, and that instant does not exist yet. Reporting a number here — the
    // interval, or a countdown from the previous round's end — states a
    // deadline nobody can hold the page to. The chip says "Refreshing" instead.
    if (roundRunning.value || busy.value) return null;
    const next = nextTickAt.value;
    if (next === null || !effectiveEnabled.value) return null;
    return Math.max(0, Math.round((next - nowMs.value) / 1000));
  });

  onScopeDispose(() => {
    stopWatchingTraffic();
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
    enabled,
    tickCount,
    suspended,
    roundRunning,
    currentRound,
    whenIdle,
    onRoundCapped,
    effectiveEnabled,
    secondsUntilNext,
    setInterval: setInterval_,
    setEnabled,
    toggleEnabled,
    refreshNow,
    joinRound,
    suspend,
    resume,
  };
});
