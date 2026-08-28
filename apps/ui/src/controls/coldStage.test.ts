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

describe('flipping the stage reads nothing', () => {
  // The flip used to fire a round of its own. Cold reads are slow, so that
  // round routinely hit the sixty-second cap — and the sweep that followed
  // re-queued exactly the queries the cap had just cancelled, because it
  // selected on `dataUpdatedAt` and a cancelled query never updates it. The cap
  // was therefore at its most useless during the outage it exists for.
  //
  // And `coldStage: true` REPLACES the hot read rather than widening it, so an
  // operator who has not yet moved the time range into the cold window would
  // watch the whole page empty the instant they clicked. The stage is a
  // parameter for the NEXT read, not an action.
  it('starts no round', () => {
    const auto = useAutoRefreshStore();
    const before = auto.tickCount;

    useColdStageStore().set(true);

    expect(auto.tickCount, 'the flip triggered a page-wide read').toBe(before);
  });

  it('cancels what is already out, so no batch straddles the flip', () => {
    // Cancelling is not reading. The stage is sampled when a request
    // DISPATCHES, so a call queued behind the concurrency limiter would go out
    // under the new stage while belonging to the batch that asked under the old
    // one — a compare grid half hot and half cold, with nothing to show it.
    useColdStageStore().set(true);

    expect(cancelQueries).toHaveBeenCalled();
  });

  it('marks everything stale WITHOUT refetching it', () => {
    // The whole mechanism: what is on screen is now known to be the other
    // stage's answer, and the next read of each query picks the new stage up
    // through the request header.
    useColdStageStore().set(true);

    expect(invalidateQueries).toHaveBeenCalledWith({ refetchType: 'none' });
  });

  it('refetches nothing, now or after the page settles', async () => {
    useColdStageStore().set(true);
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));

    expect(refetchQueries, 'a sweep re-read the page behind the operator').not.toHaveBeenCalled();
  });

  it('still sends the new stage on the very next request', () => {
    const cold = useColdStageStore();

    cold.set(true);

    expect(readColdStageHeader(), 'the next request would carry the old stage').toBe(true);
  });
});
