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
 * Pods live-tail engine for the Log inspect tool. Owns its own setInterval:
 * Start polls `runOnce` every interval (re-fetching the rolling Window),
 * Pause stops it, manual Refresh fetches now. The timer is torn down on
 * unmount, on switching away from pods, and on any entity / window /
 * interval / filter change (so a stale loop never keeps hitting OAP or
 * stacks fetches). The sibling useLayerPodLogs proves the pattern; here the
 * composable owns only the lifecycle, while the actual fetch (`runOnce`) and
 * the pane state it writes stay with the view so the one-shot Run path can
 * reuse them verbatim.
 *
 * `runOnce` is the view's `runPodQuery` — the reentrancy-guarded tick wraps
 * it (so overlapping ticks never stack when a slow OAP response outlasts the
 * interval), marks the pane queried + clears the prior soft-error before
 * fetching, and stops the loop on a hard error so it doesn't spin on
 * failures.
 */

import { onUnmounted, ref, watch, type Ref } from 'vue';

export interface PodLogTailDeps {
  /** Active log source — the tail only arms while this is `pods`. */
  logSource: Ref<string>;
  /** Whether a pod + container are both selected (run is allowed). */
  canRun: Ref<boolean>;
  /** Poll cadence (seconds). */
  intervalSeconds: Ref<number>;
  /** Re-targeting inputs — any change tears the tail down. */
  retargetWatch: Array<Ref<unknown>>;
  /** Window / interval / filter inputs — changes restart while tailing. */
  windowWatch: Array<Ref<unknown>>;
  /** Deep-watched filter inputs (chip arrays) — restart while tailing. */
  filterWatch: Array<Ref<unknown>>;
  /** Marks the pane as queried before a tick fetches. */
  hasQueried: Ref<boolean>;
  /** Hard error — set by `runOnce`; a non-null value stops the loop. */
  errorMsg: Ref<string | null>;
  /** OAP soft-error reason — cleared before each tick. */
  podErrorReason: Ref<string | null>;
  /** The actual fetch (the view's `runPodQuery`). */
  runOnce: () => Promise<void>;
}

export function usePodLogTail(deps: PodLogTailDeps) {
  const tailing = ref(false);
  let timer: ReturnType<typeof setInterval> | null = null;

  function stopTail(): void {
    tailing.value = false;
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  }
  function startTail(): void {
    if (deps.logSource.value !== 'pods' || !deps.canRun.value) return;
    stopTail();
    tailing.value = true;
    void tick();
    timer = setInterval(() => void tick(), deps.intervalSeconds.value * 1000);
  }
  function toggleTail(): void {
    if (tailing.value) stopTail();
    else startTail();
  }

  // One poll tick: a reentrancy-guarded `runOnce` so overlapping ticks
  // never stack (a slow OAP response can outlast the interval). Marks the
  // pane as queried + clears the prior soft-error before fetching, then
  // resolves; a hard error stops the loop so it doesn't spin on failures.
  let tickInFlight = false;
  async function tick(): Promise<void> {
    if (tickInFlight) return;
    tickInFlight = true;
    deps.hasQueried.value = true;
    deps.errorMsg.value = null;
    deps.podErrorReason.value = null;
    try {
      await deps.runOnce();
      if (deps.errorMsg.value) stopTail();
    } finally {
      tickInFlight = false;
    }
  }

  // Re-targeting the pod (pod / container / layer / service change) tears the
  // tail down — a loop must never bleed across pods. Window / interval / filter
  // changes while tailing restart the loop so OAP re-runs with the new
  // condition (mirrors the per-layer Pod Logs tab); paused, they just take
  // effect on the next Start.
  watch(deps.retargetWatch, stopTail);
  watch(deps.windowWatch, () => {
    if (tailing.value) startTail();
  });
  watch(deps.filterWatch, () => {
    if (tailing.value) startTail();
  }, { deep: true });
  onUnmounted(stopTail);

  return { tailing, startTail, stopTail, toggleTail };
}
