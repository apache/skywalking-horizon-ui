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
 * The session TTL is the whole of the BFF's "are you still logged in?" answer,
 * and both directions of a regression are damaging: a comparison that expires
 * too eagerly logs an operator out mid-incident, one that never expires keeps a
 * stolen cookie valid forever. These cases pin the boundary, the sliding
 * window, the read-without-touch contract, and the fact that an expired session
 * is DROPPED rather than merely reported missing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionStore } from './sessions.js';

const MINUTE = 60_000;
/** Parks the background reaper beyond any window a test advances through, so
 *  the case under test exercises the lazy expiry in touch()/get() alone. */
const NO_REAP = 24 * 60 * MINUTE;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('SessionStore.create', () => {
  it('issues a session that is immediately readable and starts its clocks now', () => {
    const store = new SessionStore({ ttlMinutes: 60, reapIntervalMs: NO_REAP });
    const now = Date.now();
    const session = store.create('alice', ['admin', 'viewer']);

    expect(session.username).toBe('alice');
    expect(session.roles).toEqual(['admin', 'viewer']);
    expect(session.createdAt).toBe(now);
    expect(session.lastSeenAt).toBe(now);
    expect(store.size()).toBe(1);
    expect(store.get(session.sid)).toMatchObject({ username: 'alice', roles: ['admin', 'viewer'] });
    expect(store.touch(session.sid)).toMatchObject({ username: 'alice' });
  });

  it('issues a distinct, unguessable sid every time', () => {
    const store = new SessionStore({ ttlMinutes: 60, reapIntervalMs: NO_REAP });
    const sids = new Set<string>();
    for (let i = 0; i < 500; i++) sids.add(store.create('u', []).sid);

    // Cookie-safe alphabet, no padding, and at least the 43 characters that 32
    // random bytes encode to — an entropy FLOOR, so widening the sid stays legal
    // while narrowing it does not. A sid collision would hand one operator
    // another's session.
    expect(sids.size).toBe(500);
    for (const sid of sids) expect(sid).toMatch(/^[A-Za-z0-9_-]{43,}$/);
    expect(store.size()).toBe(500);

    // Unique and long is not the same as unguessable: a zero-padded counter or a
    // timestamp prefix satisfies both, and lets anyone with one cookie derive the
    // next. Random bytes vary at EVERY position, so each position must show many
    // distinct characters across 500 draws — a counter shows one or two.
    const distinctAt = (i: number) => new Set([...sids].map((sid) => sid[i])).size;
    expect(distinctAt(0)).toBeGreaterThan(8);
    expect(distinctAt(20)).toBeGreaterThan(8);
  });

  it('keeps sessions of the same user independent (one logout does not end the other)', () => {
    const store = new SessionStore({ ttlMinutes: 60, reapIntervalMs: NO_REAP });
    const a = store.create('alice', ['admin']);
    const b = store.create('alice', ['admin']);

    expect(a.sid).not.toBe(b.sid);
    store.destroy(a.sid);
    expect(store.get(a.sid)).toBeUndefined();
    expect(store.get(b.sid)?.sid).toBe(b.sid);
  });
});

describe('SessionStore.touch — the sliding TTL gate', () => {
  it('accepts a session inside the TTL and slides the window forward', () => {
    const store = new SessionStore({ ttlMinutes: 60, reapIntervalMs: NO_REAP });
    const { sid, lastSeenAt: at0 } = store.create('alice', ['admin']);

    vi.advanceTimersByTime(30 * MINUTE);
    const touched = store.touch(sid);

    expect(touched?.sid).toBe(sid);
    expect(touched?.lastSeenAt).toBe(at0 + 30 * MINUTE);
    expect(touched?.createdAt).toBe(at0); // createdAt never slides
  });

  it('still accepts a session at exactly the TTL boundary', () => {
    const store = new SessionStore({ ttlMinutes: 60, reapIntervalMs: NO_REAP });
    const { sid } = store.create('alice', ['admin']);

    vi.advanceTimersByTime(60 * MINUTE);

    expect(store.touch(sid)?.sid).toBe(sid);
    expect(store.size()).toBe(1);
  });

  it('past the TTL returns undefined AND drops the session', () => {
    const store = new SessionStore({ ttlMinutes: 60, reapIntervalMs: NO_REAP });
    const { sid } = store.create('alice', ['admin']);

    vi.advanceTimersByTime(60 * MINUTE + 1);

    expect(store.touch(sid)).toBeUndefined();
    // Dropped, not just reported missing — a retry with the same cookie must
    // not resurrect it, and the entry must not linger in memory.
    expect(store.size()).toBe(0);
    expect(store.touch(sid)).toBeUndefined();
    expect(store.get(sid)).toBeUndefined();
  });

  it('keeps an actively-used session alive far beyond one TTL', () => {
    const store = new SessionStore({ ttlMinutes: 10 });
    const { sid } = store.create('alice', ['admin']);

    // Half-TTL of activity, ten times over: five TTLs of wall-clock elapse and
    // the operator stays logged in.
    for (let i = 0; i < 10; i++) {
      vi.advanceTimersByTime(5 * MINUTE);
      expect(store.touch(sid)?.sid).toBe(sid);
    }
    expect(Date.now()).toBeGreaterThan(store.get(sid)!.createdAt + 10 * MINUTE);

    // ...and idling for one full TTL after that activity still ends it.
    vi.advanceTimersByTime(10 * MINUTE + 1);
    expect(store.touch(sid)).toBeUndefined();
  });

  it('returns undefined for an unknown sid without minting one', () => {
    const store = new SessionStore({ ttlMinutes: 60, reapIntervalMs: NO_REAP });

    expect(store.touch('not-a-real-sid')).toBeUndefined();
    expect(store.size()).toBe(0);
  });
});

describe('SessionStore.get — read without sliding the window', () => {
  it('returns the session without moving lastSeenAt', () => {
    const store = new SessionStore({ ttlMinutes: 60, reapIntervalMs: NO_REAP });
    const { sid, lastSeenAt: at0 } = store.create('alice', ['admin']);

    vi.advanceTimersByTime(50 * MINUTE);
    expect(store.get(sid)?.lastSeenAt).toBe(at0);

    // Because the read did not slide the window, the session still expires on
    // the original clock: 11 more minutes is past the 60-minute TTL.
    vi.advanceTimersByTime(11 * MINUTE);
    expect(store.get(sid)).toBeUndefined();
    expect(store.touch(sid)).toBeUndefined();
  });

  it('expires and drops on read, exactly as touch does', () => {
    const store = new SessionStore({ ttlMinutes: 60, reapIntervalMs: NO_REAP });
    const { sid } = store.create('alice', ['admin']);

    vi.advanceTimersByTime(60 * MINUTE);
    expect(store.get(sid)?.sid).toBe(sid); // boundary is still valid

    vi.advanceTimersByTime(1);
    expect(store.get(sid)).toBeUndefined();
    expect(store.size()).toBe(0);
  });
});

describe('SessionStore.destroy', () => {
  it('ends the session immediately (logout is not deferred to the reaper)', () => {
    const store = new SessionStore({ ttlMinutes: 60, reapIntervalMs: NO_REAP });
    const { sid } = store.create('alice', ['admin']);

    store.destroy(sid);

    expect(store.size()).toBe(0);
    expect(store.get(sid)).toBeUndefined();
    expect(store.touch(sid)).toBeUndefined();
  });

  it('is a no-op for an sid that is already gone', () => {
    const store = new SessionStore({ ttlMinutes: 60, reapIntervalMs: NO_REAP });
    const { sid } = store.create('alice', ['admin']);

    store.destroy(sid);
    expect(() => store.destroy(sid)).not.toThrow();
    expect(store.size()).toBe(0);
  });
});

describe('SessionStore background reaper', () => {
  it('sweeps only the idle sessions, leaving active ones untouched', () => {
    const store = new SessionStore({ ttlMinutes: 10, reapIntervalMs: MINUTE });
    const idle = store.create('idle', ['viewer']).sid;
    const active = store.create('active', ['admin']).sid;

    vi.advanceTimersByTime(9 * MINUTE);
    expect(store.size()).toBe(2); // neither is stale yet

    store.touch(active); // activity slides only `active`
    vi.advanceTimersByTime(2 * MINUTE);

    // size() alone proves the sweep happened: nothing read `idle`, so lazy
    // expiry in get()/touch() cannot account for its removal.
    expect(store.size()).toBe(1);
    expect(store.get(active)?.username).toBe('active');
    expect(store.get(idle)).toBeUndefined();
  });

  it('sweeps without being configured with an interval', () => {
    const store = new SessionStore({ ttlMinutes: 10 });
    store.create('idle', ['viewer']);

    vi.advanceTimersByTime(25 * MINUTE);

    // The caller passed no reapIntervalMs and nothing ever read this session, so
    // only the store's own default cadence can have dropped it. A default that
    // regressed to hours would sit on dead sessions for the whole of that window.
    expect(store.size()).toBe(0);
  });

  it('leaves every session in place while all of them are inside the TTL', () => {
    const store = new SessionStore({ ttlMinutes: 10, reapIntervalMs: MINUTE });
    store.create('a', []);
    store.create('b', []);

    vi.advanceTimersByTime(10 * MINUTE);

    expect(store.size()).toBe(2);
  });
});

describe('SessionStore.close', () => {
  it('stops the reaper and forgets every session', async () => {
    const store = new SessionStore({ ttlMinutes: 60, reapIntervalMs: MINUTE });
    const { sid } = store.create('alice', ['admin']);
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    await store.close();

    expect(store.size()).toBe(0);
    expect(store.get(sid)).toBeUndefined();
    // The interval is cleared, so a closed store cannot keep the process (or a
    // test run) alive by ticking forever.
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(10 * MINUTE);
    expect(vi.getTimerCount()).toBe(0);
  });
});
