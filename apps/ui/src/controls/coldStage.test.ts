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
 * Flipping the stage has to be ONE event.
 *
 * Cold REPLACES the hot+warm read rather than widening it, so a page showing
 * both at once is not a partial answer — it is two different questions'
 * answers on one screen, with nothing on it saying which is which. Every
 * assertion here is about the flip being indivisible: the header cannot lag
 * the key, and nothing may refetch before the round that re-reads the page.
 */

import { describe, expect, it, beforeEach, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

const cancelQueries = vi.fn(() => Promise.resolve());
const invalidateQueries = vi.fn(() => Promise.resolve());
const refetchQueries = vi.fn((_opts?: unknown) => Promise.resolve());
// The auto-refresh store watches the cache to know when the page is busy, so
// the double has to carry that surface too — a partial double fails as a crash
// inside the store rather than as a missing assertion.
vi.mock('@/api/queryClient', () => ({
  queryClient: {
    cancelQueries,
    invalidateQueries,
    refetchQueries,
    isFetching: () => 0,
    getQueryCache: () => ({ subscribe: () => () => {}, getAll: () => [] }),
  },
}));

const { useColdStageStore, readColdStageHeader } = await import('./coldStage');
const { useAutoRefreshStore } = await import('./autoRefresh');

beforeEach(() => {
  setActivePinia(createPinia());
  localStorage.clear();
  invalidateQueries.mockClear();
  cancelQueries.mockClear();
  refetchQueries.mockClear();
});

describe('the flip is atomic', () => {
  // The defect this replaced: the flag was persisted by a watcher, so between
  // the store flipping and localStorage being written there was a window in
  // which a request carried the OLD header while its answer was filed under
  // the NEW key. A Cold answer under a Hot key is undetectable afterwards.
  it('writes the header in the same tick as the flag, with no await between', () => {
    const cold = useColdStageStore();

    cold.set(true);

    expect(cold.enabled).toBe(true);
    expect(readColdStageHeader(), 'the request header lagged the cache key').toBe(true);
  });

  it('flips back the same way', () => {
    const cold = useColdStageStore();
    cold.set(true);

    cold.set(false);

    expect(readColdStageHeader()).toBe(false);
  });

  it('does nothing at all when set to the value it already has', () => {
    const cold = useColdStageStore();
    cold.set(false);

    expect(invalidateQueries, 'a no-op flip refetched the page').not.toHaveBeenCalled();
  });
});

describe('the refetch is a round, not a storm', () => {
  it('cancels what is in flight, so nothing straddles the flip', () => {
    // The stage is a header read when a request GOES OUT, so a request queued
    // behind the concurrency limiter would leave under the new stage while
    // belonging to the old round — landing a cold answer in a hot entry.
    useColdStageStore().set(true);

    expect(cancelQueries, 'an in-flight read could span both stages').toHaveBeenCalled();
  });

  it('marks everything stale WITHOUT refetching it', () => {
    const cold = useColdStageStore();

    cold.set(true);

    expect(invalidateQueries).toHaveBeenCalledWith({ refetchType: 'none' });
  });

  it('runs one round, so the page is re-read together', () => {
    const auto = useAutoRefreshStore();
    const before = auto.tickCount;

    useColdStageStore().set(true);

    expect(auto.tickCount, 'the flip did not go through a round').toBe(before + 1);
  });

  it('re-reads what the round did not cover, and only that', async () => {
    const cold = useColdStageStore();

    cold.set(true);
    await new Promise((r) => setTimeout(r, 0));

    // Selected by WHEN the data was fetched, not by staleness. Round-managed
    // queries carry no freshness window, so `stale: true` would have selected
    // every one of them and turned this into the second storm it exists to
    // avoid.
    const arg = refetchQueries.mock.calls.at(-1)?.[0] as
      | { type?: string; predicate?: (q: unknown) => boolean }
      | undefined;
    expect(arg?.type).toBe('active');
    expect(typeof arg?.predicate, 'the sweep selected by staleness again').toBe('function');
    // Answered after the flip ⇒ already the new stage ⇒ left alone.
    expect(arg?.predicate?.({ state: { dataUpdatedAt: Date.now() + 5_000 } })).toBe(false);
    // Answered before it ⇒ still the old stage ⇒ re-read.
    expect(arg?.predicate?.({ state: { dataUpdatedAt: 0 } })).toBe(true);
  });

  it('waits for the TRAILING round when the flip lands mid-round', async () => {
    // The coalescing case. A flip while a round is out does not start a round
    // of its own — it queues one — so awaiting the call would have resolved
    // before the successor had even begun, and the leftovers would have been
    // re-read against the stage that was on the way out.
    const auto = useAutoRefreshStore();
    let release!: () => void;
    let rounds = 0;
    auto.joinRound(() => {
      rounds += 1;
      return rounds === 1 ? new Promise<void>((r) => { release = r; }) : undefined;
    });
    void auto.refreshNow();
    await Promise.resolve();

    useColdStageStore().set(true);
    // A full flush, not one microtask: awaiting the flip's own call would
    // resolve within a few ticks, and a shorter wait could not tell that apart
    // from correctly waiting for the successor.
    await new Promise((r) => setTimeout(r, 0));
    expect(refetchQueries, 'the leftovers were re-read against the outgoing stage').not.toHaveBeenCalled();

    release();
    await new Promise((r) => setTimeout(r, 0));

    expect(rounds, 'the flip did not queue a round of its own').toBe(2);
    expect(refetchQueries).toHaveBeenCalled();
  });

  it('does not re-read the leftovers until the round has finished', async () => {
    const auto = useAutoRefreshStore();
    let release!: () => void;
    auto.joinRound(() => new Promise<void>((r) => { release = r; }));

    useColdStageStore().set(true);
    await Promise.resolve();

    expect(
      refetchQueries,
      'the leftovers were re-read while the round was still out',
    ).not.toHaveBeenCalled();

    release();
  });
});
