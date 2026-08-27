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
 * Which traffic is allowed to hold the refresh timer.
 *
 * Loading time is not charged against the interval — that is the operator's
 * rule, and it means the timer holds while the page is busy. But the shell's
 * own pollers run on independent clocks by design, and letting them count made
 * the coordinated timer restart every time one ticked: a thirty-second poller
 * against a thirty-second cadence postponed every round for ever, so
 * auto-refresh silently never happened at all. Nothing in the suite caught it,
 * because nothing simulated a poller.
 */

import { describe, expect, it, beforeEach, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

interface FakeQuery { state: { fetchStatus: string }; meta?: { independentPoll?: boolean } }
const queries: FakeQuery[] = [];
let notify: () => void = () => {};
vi.mock('@/api/queryClient', () => ({
  queryClient: {
    invalidateQueries: vi.fn(() => Promise.resolve()),
    refetchQueries: vi.fn(() => Promise.resolve()),
    isFetching: () => queries.filter((q) => q.state.fetchStatus === 'fetching').length,
    getQueryCache: () => ({
      subscribe: (fn: () => void) => { notify = fn; return () => { notify = () => {}; }; },
      getAll: () => queries,
    }),
  },
}));

const { useAutoRefreshStore } = await import('./autoRefresh');

/** Put a query into the cache and tell the store the cache moved. */
function fetching(meta?: { independentPoll?: boolean }): () => void {
  const q: FakeQuery = { state: { fetchStatus: 'fetching' }, ...(meta ? { meta } : {}) };
  queries.push(q);
  notify();
  return () => {
    q.state.fetchStatus = 'idle';
    notify();
  };
}

beforeEach(() => {
  setActivePinia(createPinia());
  queries.length = 0;
});

describe('independent pollers must not hold the timer', () => {
  it('keeps counting down while a shell poller is in flight', () => {
    const a = useAutoRefreshStore();
    const before = a.secondsUntilNext;
    expect(before, 'nothing was armed — the rest would prove nothing').not.toBeNull();

    const settle = fetching({ independentPoll: true });

    expect(
      a.secondsUntilNext,
      'a shell poller stopped the countdown, so its clock would postpone every round',
    ).not.toBeNull();
    settle();
  });

  it('holds while the PAGE is loading, and starts a full interval once it lands', () => {
    const a = useAutoRefreshStore();
    a.setInterval(30);

    const settle = fetching();
    expect(a.secondsUntilNext, 'the countdown ran while the page was loading').toBeNull();

    settle();
    expect(a.secondsUntilNext).toBeLessThanOrEqual(30);
    expect(a.secondsUntilNext, 'the interval did not start afresh once loading finished').toBeGreaterThan(27);
  });

  it('a poller alongside page traffic does not extend the hold past the page', () => {
    const a = useAutoRefreshStore();
    const poller = fetching({ independentPoll: true });
    const page = fetching();
    expect(a.secondsUntilNext).toBeNull();

    page();

    expect(a.secondsUntilNext, 'the poller kept the timer held after the page had landed').not.toBeNull();
    poller();
  });
});
