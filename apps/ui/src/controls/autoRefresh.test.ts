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
 * Whose decision is whose.
 *
 * The operator owns two things — whether auto-refresh runs at all, and how
 * often. The app owns a third: pausing while a page or an overlay needs the
 * background still. Every test here is about those three not overwriting each
 * other, because each way they can is invisible until an operator notices their
 * setting did not stick.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useAutoRefreshStore } from './autoRefresh';

beforeEach(() => setActivePinia(createPinia()));

describe('the operator’s switch', () => {
  it('remembers the cadence across off and on', () => {
    const a = useAutoRefreshStore();
    a.setInterval(300);

    a.setEnabled(false);
    a.setEnabled(true);

    expect(a.intervalSec, 'turning it off forgot the chosen cadence').toBe(300);
  });

  it('enables when a cadence is picked — choosing 5m is not a request to stay off', () => {
    const a = useAutoRefreshStore();
    a.setEnabled(false);

    a.setInterval(300);

    expect(a.enabled).toBe(true);
  });

  it('stops ticking when off, and the countdown says nothing', () => {
    const a = useAutoRefreshStore();
    a.setEnabled(false);

    expect(a.effectiveEnabled).toBe(false);
    expect(a.secondsUntilNext).toBeNull();
  });
});

describe('suspension is the app’s, and never writes the operator’s state', () => {
  it('does not refresh on release when the operator has it off', () => {
    const a = useAutoRefreshStore();
    a.setEnabled(false);
    const before = a.tickCount;

    // Enter an opt-out page and leave it again.
    a.suspend('route');
    a.resume('route');

    expect(a.tickCount, 'leaving an opt-out route refreshed with auto-refresh off').toBe(before);
    expect(a.enabled, 'suspension wrote the operator’s switch').toBe(false);
  });

  it('does refresh on release when the operator has it on', () => {
    const a = useAutoRefreshStore();
    const before = a.tickCount;

    a.suspend('route');
    a.resume('route');

    expect(a.tickCount).toBe(before + 1);
  });

  it('leaves the chosen cadence untouched across a suspend/resume', () => {
    const a = useAutoRefreshStore();
    a.setInterval(60);

    a.suspend('route');
    a.resume('route');

    expect(a.intervalSec).toBe(60);
  });
});

describe('two independent holders', () => {
  // The hierarchy overlay freezes the page so the background stays still while
  // an operator pans through it. A route change must not release that freeze.
  it('stays paused while any holder wants it', () => {
    const a = useAutoRefreshStore();
    a.suspend('hierarchy-overlay');
    a.suspend('route');

    a.resume('route');

    expect(a.suspended, 'one holder’s release unfroze another’s claim').toBe(true);
    expect(a.effectiveEnabled).toBe(false);
  });

  it('resumes only when the last holder releases', () => {
    const a = useAutoRefreshStore();
    a.suspend('hierarchy-overlay');
    a.suspend('route');
    a.resume('route');

    a.resume('hierarchy-overlay');

    expect(a.suspended).toBe(false);
    expect(a.effectiveEnabled).toBe(true);
  });

  it('ignores a release from something that never held it', () => {
    const a = useAutoRefreshStore();
    a.suspend('hierarchy-overlay');
    const before = a.tickCount;

    a.resume('route');

    expect(a.suspended).toBe(true);
    expect(a.tickCount).toBe(before);
  });

  it('is idempotent per holder — a second claim is not a second lock', () => {
    const a = useAutoRefreshStore();
    a.suspend('route');
    a.suspend('route');

    a.resume('route');

    expect(a.suspended).toBe(false);
  });
});

describe('manual refresh', () => {
  // The one thing that must keep working while auto-refresh is off: the
  // operator asked for data, explicitly.
  it('ticks even when auto-refresh is off', () => {
    const a = useAutoRefreshStore();
    a.setEnabled(false);
    const before = a.tickCount;

    a.refreshNow();

    expect(a.tickCount).toBe(before + 1);
  });
});

describe('a round counts from completion', () => {
  it('waits for its subscribers before arming the next interval', async () => {
    const a = useAutoRefreshStore();
    let release!: () => void;
    const slow = new Promise<void>((r) => { release = r; });
    let calls = 0;
    a.joinRound(() => { calls += 1; return slow; });

    const round = a.refreshNow();
    await Promise.resolve();
    expect(calls).toBe(1);

    // A trigger arriving mid-round does not start a second one ON TOP of it.
    // Two rounds in flight would land two windows' answers interleaved, which
    // is the state this whole design exists to prevent.
    a.refreshNow();
    await Promise.resolve();
    expect(calls, 'a trigger during a round started a second one').toBe(1);

    release();
    await round;
  });

  it('collapses however many mid-round triggers into ONE trailing round', async () => {
    // Not dropped, and not queued. Dropped was wrong for the triggers that mean
    // something CHANGED — returning to the tab, leaving a paused page — because
    // the round in flight was asking about the state before that happened.
    // Queueing them all would be worse: on a slow backend the backlog would
    // outlive the windows it was asking about.
    const a = useAutoRefreshStore();
    let release!: () => void;
    const slow = new Promise<void>((r) => { release = r; });
    let calls = 0;
    a.joinRound(() => { calls += 1; return calls === 1 ? slow : undefined; });

    const round = a.refreshNow();
    await Promise.resolve();
    a.refreshNow();
    a.refreshNow();
    a.refreshNow();

    release();
    await round;
    await Promise.resolve();
    await Promise.resolve();

    expect(calls, 'three mid-round triggers did not collapse into one').toBe(2);
  });

  it('drops a subscriber that unregisters', async () => {
    const a = useAutoRefreshStore();
    let calls = 0;
    const off = a.joinRound(() => { calls += 1; });
    await a.refreshNow();
    expect(calls).toBe(1);

    off();
    await a.refreshNow();

    expect(calls, 'an unregistered subscriber was still called').toBe(1);
  });

  it('survives a subscriber that throws, and still refreshes the others', async () => {
    const a = useAutoRefreshStore();
    let good = 0;
    a.joinRound(() => { throw new Error('boom'); });
    a.joinRound(() => { good += 1; });

    await a.refreshNow();

    expect(good).toBe(1);
  });

  it('bumps the tick before the work, so the window is re-anchored first', async () => {
    const a = useAutoRefreshStore();
    let tickAtCallTime = -1;
    a.joinRound(() => { tickAtCallTime = a.tickCount; });
    const before = a.tickCount;

    await a.refreshNow();

    expect(tickAtCallTime).toBe(before + 1);
  });
});

describe('the timer is stopped while a round is out', () => {
  it('arms nothing new until the round settles', async () => {
    const a = useAutoRefreshStore();
    let release!: () => void;
    const slow = new Promise<void>((r) => { release = r; });
    a.joinRound(() => slow);

    const round = a.refreshNow();
    await Promise.resolve();

    // NOTHING to count while a round is out: the next round starts when this
    // one ends, and that instant does not exist yet. Reporting a number would
    // state a deadline nobody can hold the page to — the chip says
    // "Refreshing" instead.
    expect(a.secondsUntilNext).toBeNull();

    release();
    await round;
    // Settled: counting again, from now.
    expect(a.secondsUntilNext).toBeLessThanOrEqual(a.intervalSec);
    expect(a.secondsUntilNext).toBeGreaterThan(a.intervalSec - 3);
  });

  it('reports nothing to count when the operator turned it off', () => {
    const a = useAutoRefreshStore();
    a.setEnabled(false);
    expect(a.secondsUntilNext).toBeNull();
  });

  it('reports nothing to count while suspended, even mid-round', async () => {
    const a = useAutoRefreshStore();
    let release!: () => void;
    a.joinRound(() => new Promise<void>((r) => { release = r; }));
    const round = a.refreshNow();
    await Promise.resolve();

    a.suspend('route');

    expect(a.secondsUntilNext).toBeNull();
    release();
    await round;
  });
});

describe('a round that has started always finishes', () => {
  it('completes even when the page suspends mid-flight, and arms no successor', async () => {
    const a = useAutoRefreshStore();
    let release!: () => void;
    let finished = false;
    a.joinRound(() => new Promise<void>((r) => { release = () => { finished = true; r(); }; }));

    const round = a.refreshNow();
    await Promise.resolve();

    // Entering an opt-out page while the readings are out.
    a.suspend('route');
    release();
    await round;

    expect(finished, 'the in-flight round was abandoned when the page suspended').toBe(true);
    expect(a.effectiveEnabled, 'a successor round was armed while suspended').toBe(false);
  });

  it('completes even when the operator switches auto-refresh off mid-flight', async () => {
    const a = useAutoRefreshStore();
    let release!: () => void;
    let finished = false;
    a.joinRound(() => new Promise<void>((r) => { release = () => { finished = true; r(); }; }));

    const round = a.refreshNow();
    await Promise.resolve();

    a.setEnabled(false);
    release();
    await round;

    expect(finished).toBe(true);
    expect(a.secondsUntilNext, 'still counting toward a round that will not come').toBeNull();
  });
});

describe('a slow backend cannot stack rounds', () => {
  // Acceptance: a 5-second cadence meeting an 8-second round. At most one round
  // is ever out, and the next full interval starts only once it lands — the
  // failure this rules out is a page whose requests overlap until the backend
  // gives way entirely.
  it('never has two rounds out, and counts the interval from the landing', async () => {
    const a = useAutoRefreshStore();
    a.setInterval(5);
    let out = 0;
    let peak = 0;
    let rounds = 0;
    let release!: () => void;
    a.joinRound(() => {
      rounds += 1;
      out += 1;
      peak = Math.max(peak, out);
      // Only the FIRST round is slow. The trailing one the mid-round triggers
      // queue must be allowed to finish, or the page never goes idle and the
      // countdown assertion below has nothing to measure.
      if (rounds > 1) { out -= 1; return undefined; }
      return new Promise<void>((r) => {
        release = () => { out -= 1; r(); };
      });
    });

    const round = a.refreshNow();
    await Promise.resolve();
    // Everything that could start a second one while the first is out.
    a.refreshNow();
    a.refreshNow();
    await Promise.resolve();

    expect(peak, 'two rounds were in flight at once').toBe(1);
    // And nothing to count toward while it is out.
    expect(a.secondsUntilNext).toBeNull();

    release();
    await round;
    await a.whenIdle();
    await new Promise((r) => setTimeout(r, 0));

    expect(peak, 'the trailing round overlapped its predecessor').toBe(1);
    expect(a.secondsUntilNext, 'the interval did not start from the landing').toBeLessThanOrEqual(5);
    expect(a.secondsUntilNext).toBeGreaterThan(2);
  });

  it('hands a caller arriving mid-round the round that is actually out', async () => {
    const a = useAutoRefreshStore();
    let release!: () => void;
    let settled = false;
    a.joinRound(() => new Promise<void>((r) => { release = () => { settled = true; r(); }; }));

    const first = a.refreshNow();
    await Promise.resolve();
    // Awaiting this used to mean awaiting nothing: it resolved immediately
    // while the round it was asking about was still out.
    const joined = a.refreshNow();
    let joinedResolved = false;
    void joined.then(() => { joinedResolved = true; });
    await Promise.resolve();

    expect(joinedResolved, 'a mid-round call resolved before the round did').toBe(false);

    release();
    await first;
    await joined;
    expect(settled).toBe(true);
  });
});

describe('the operator’s switch respects where they are', () => {
  // Switching auto-refresh on while a page is paused or the tab is hidden used
  // to fire a round immediately — the opposite of what both states mean, and a
  // round's worth of queries for a page nobody is looking at.
  it('saves the preference without refreshing while suspended', () => {
    const a = useAutoRefreshStore();
    a.setEnabled(false);
    a.suspend('route');
    const before = a.tickCount;

    a.setEnabled(true);

    expect(a.enabled, 'the preference was not saved').toBe(true);
    expect(a.tickCount, 'a paused page was refreshed anyway').toBe(before);
  });

  it('reports itself as not running when the tab is hidden', () => {
    const a = useAutoRefreshStore();
    expect(a.effectiveEnabled).toBe(true);

    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));

    expect(a.effectiveEnabled, 'a backgrounded tab still claimed to be refreshing').toBe(false);
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
});

describe('the round says what it is', () => {
  it('gives every participant one context — id, trigger, window and stage', async () => {
    const a = useAutoRefreshStore();
    const seen: Array<NonNullable<typeof a.currentRound>> = [];
    a.joinRound(() => { if (a.currentRound) seen.push({ ...a.currentRound }); });
    a.joinRound(() => { if (a.currentRound) seen.push({ ...a.currentRound }); });

    await a.refreshNow();

    expect(seen).toHaveLength(2);
    expect(seen[0]?.trigger).toBe('manual');
    expect(seen[0]?.roundId).toBe(seen[1]?.roundId);
    // The window is decided once, at the top, so two screens in one round
    // cannot describe different windows.
    expect(seen[0]?.startMs).toBe(seen[1]?.startMs);
    expect(seen[0]?.endMs).toBe(seen[1]?.endMs);
    expect(seen[0]?.step).toBe(seen[1]?.step);
    expect(seen[0]?.coldStage).toBe(seen[1]?.coldStage);
  });

  it('is cleared once the round is over, so nothing can attribute to it late', async () => {
    const a = useAutoRefreshStore();
    await a.refreshNow();
    expect(a.currentRound).toBeNull();
  });
});
