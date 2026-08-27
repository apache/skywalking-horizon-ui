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
 * "Query cold stage" — a process-wide toggle that switches every
 * OAP read from hot+warm to BanyanDB's cold stage.
 *
 * IMPORTANT — read this before editing: OAP's `Duration.coldStage: true`
 * REPLACES the hot+warm read, it does not union with it (see the
 * comment on `Duration.coldStage` in OAP's common.graphqls, and the
 * BanyanDBTTLStatusQuery source). For the demo OAP with hot+warm=8d /
 * cold=30d, "ON" returns data only when the queried window falls
 * within roughly 8–38 days ago; turning it on while looking at a
 * recent dashboard makes every widget go empty. The UI surfaces this
 * trap loudly in the topbar tooltip + the TTL page; the toggle itself
 * is intentionally manual (operator discipline) rather than auto-
 * routed by time range — the latter would double wire traffic on
 * windows that span the boundary.
 *
 * Wire path: the flag travels with every BFF request via the
 * `X-Horizon-Cold-Stage` header (see {@link COLD_STAGE_HEADER}). The
 * BFF maps the header onto `req.coldStage` and splices
 * `coldStage: true` into every OAP `Duration` it constructs. OAP
 * silently ignores the field for non-BanyanDB storage, so the chrome
 * is safe to send always — the topbar hides the affordance when
 * `backend !== 'banyandb'` so other-backend operators aren't offered
 * a no-op switch.
 *
 * The setting is sticky per browser (localStorage) so an operator
 * deep in a cold investigation doesn't lose context on reload.
 *
 * Flipping it is ATOMIC and goes through a round. Two things had to be true
 * for that to be safe, and neither was:
 *
 * - The header and the cache key must flip TOGETHER. The key is built from
 *   this store while the header is read from localStorage when the request
 *   goes out, so persisting on a watcher left a window in which a Cold answer
 *   could be filed under the Hot key. The write is synchronous with the flip
 *   now, in the same tick.
 * - The refetch must be a ROUND, not a scattergun. Invalidating every cached
 *   query fired a page-wide storm outside any round: uncounted by the
 *   countdown, able to land on top of a round already out, and arriving screen
 *   by screen so the page showed Hot and Cold answers side by side while it
 *   settled. Everything is marked stale WITHOUT refetching, then one round
 *   re-reads what is on screen, together.
 */

import { defineStore } from 'pinia';
import { ref } from 'vue';
import { queryClient } from '@/api/queryClient';
import { useAutoRefreshStore } from '@/controls/autoRefresh';

export const COLD_STAGE_HEADER = 'X-Horizon-Cold-Stage';

const STORAGE_KEY = 'horizon:coldStage:v1';

/**
 * The stage, cached in memory.
 *
 * Read on every request AND on every cache-key hash, so it must not be a
 * localStorage round-trip each time. Written by `persist` in the same tick as
 * the flag, which is what keeps the header and the key describing one stage.
 */
let currentStage: boolean | null = null;

function detectInitial(): boolean {
  if (typeof localStorage !== 'undefined') {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === '1') return true;
  }
  return false;
}

export const useColdStageStore = defineStore('cold-stage', () => {
  const enabled = ref<boolean>(detectInitial());

  /** Written in the same tick as the flag — see the header. localStorage may
   *  be unavailable (private mode); fall back to in-memory and let it reset on
   *  reload. */
  function persist(on: boolean): void {
    currentStage = on;
    if (typeof localStorage === 'undefined') return;
    try {
      localStorage.setItem(STORAGE_KEY, on ? '1' : '0');
    } catch {
      /* private mode / quota — degrade silently */
    }
  }

  /**
   * Flip the stage.
   *
   * The client is the store's own, not the caller's. Passing it was a
   * requirement every call site had to remember, and the trap banner's
   * "turn it off" did not — so the banner cleared the flag while every screen
   * kept rendering the cold answers it had already cached.
   */
  function set(on: boolean): void {
    if (enabled.value === on) return;
    const flippedAt = Date.now();
    enabled.value = on;
    persist(on);
    // CANCEL what is in flight first, and this is the ONLY thing keeping a
    // read from straddling the flip.
    //
    // The stage rides on every request as a header read when the request goes
    // out, so anything already queued behind the concurrency limiter would
    // otherwise leave carrying the NEW stage while belonging to the round that
    // asked under the old one, and land its answer in the other stage's entry.
    //
    // Scoping the cache by stage was tried instead and is WRONG: a query's hash
    // is computed when it is created, and existing observers do not rebind when
    // a global flips — so a response could be stored under the old hash while
    // every lookup used the new one, which breaks isolation, deduplication and
    // exact cancellation at once. Cancelling has none of that ambiguity.
    void queryClient.cancelQueries();
    // Marked stale WITHOUT refetching, so nothing starts before the round
    // does. A query whose key already carries the stage has moved to a
    // different cache entry anyway.
    void queryClient.invalidateQueries({ refetchType: 'none' });
    const auto = useAutoRefreshStore();
    // Named for what it IS. Reported as 'manual' the failure history said the
    // operator had asked for a refresh, when what they did was change the
    // stage — two different things to be looking at when a round fails.
    void auto.refreshNow('cold-stage');
    // Whatever the round did not cover — an explore page with its own controls,
    // which subscribes to no round — is still showing the other stage's
    // answers, so it is re-read once the page has settled.
    //
    // Selected by WHEN the data was fetched, not by staleness. Round-managed
    // queries hold no freshness window, so they are stale the instant they
    // land and `stale: true` selected every one of them — turning the sweep
    // into the second storm it exists to avoid. Anything answered after the
    // flip already reflects the new stage and is left alone.
    //
    // `whenIdle`, not the round's own promise: flipping the stage while a round
    // was already out coalesces into a trailing round, and awaiting the call
    // would have resolved before that successor had even started.
    void auto.whenIdle().then(() =>
      queryClient.refetchQueries({
        type: 'active',
        predicate: (q) => q.state.dataUpdatedAt < flippedAt,
      }),
    );
  }
  function toggle(): void {
    set(!enabled.value);
  }

  return { enabled, toggle, set };
});

/** Synchronous snapshot for the API client's fetch interceptor —
 *  called per request and must not depend on a Vue component context.
 *  Reads localStorage directly so the value is fresh even when the
 *  Pinia store hasn't been instantiated yet (early bootstrap). */
export function readColdStageHeader(): boolean {
  if (currentStage !== null) return currentStage;
  if (typeof localStorage === 'undefined') return false;
  try {
    currentStage = localStorage.getItem(STORAGE_KEY) === '1';
    return currentStage;
  } catch {
    return false;
  }
}
