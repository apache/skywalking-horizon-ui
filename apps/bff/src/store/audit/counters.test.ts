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

import { describe, it, expect } from 'vitest';
import {
  AuditCounters,
  hourBucketOf,
  hourBucketStart,
  MAX_ENTRIES,
  MAX_ENTRY_AGE_MS,
  MAX_HOUR_BUCKETS,
} from './counters.js';

const T = Date.UTC(2026, 7, 22, 14, 30); // 2026-08-22T14:30Z
const HOUR = 3_600_000;

function counters(maxRowsPerHour = 1000): AuditCounters {
  return new AuditCounters({ maxRowsPerHour });
}

function use(username: string, at: number): { kind: 'api-token'; username: string; at: number } {
  return { kind: 'api-token', username, at };
}

describe('hour buckets', () => {
  it('is UTC yyyyMMddHH, and round-trips to the hour start', () => {
    expect(hourBucketOf(T)).toBe(2026082214);
    expect(hourBucketStart(2026082214)).toBe(Date.UTC(2026, 7, 22, 14));
    expect(hourBucketOf(hourBucketStart(2026082214))).toBe(2026082214);
  });

  it('orders numerically the way it orders chronologically', () => {
    expect(hourBucketOf(T)).toBeLessThan(hourBucketOf(T + HOUR));
    // Across a midnight and a month end, where a naive format breaks.
    expect(hourBucketOf(Date.UTC(2026, 7, 31, 23))).toBeLessThan(hourBucketOf(Date.UTC(2026, 8, 1, 0)));
  });
});

describe('the write budget', () => {
  it('charges one row per sign-in and refuses past the cap', () => {
    const c = counters(3);
    expect(c.admitEvent('local', 1, T)).toBe(true);
    expect(c.admitEvent('local', 1, T)).toBe(true);
    expect(c.admitEvent('local', 1, T)).toBe(true);
    expect(c.admitEvent('local', 1, T)).toBe(false);
    expect(c.rowsAt(T)).toBe(3);
    expect(c.overBudgetAt(T)).toBe(1);
  });

  /**
   * The reason the budget counts ROWS and not writes. A cumulative bucket is
   * re-upserted every flush, so charging per write would spend the budget on
   * rows that already exist — at a 60s flush that is 60 writes per principal
   * per hour, and ~17 principals would exhaust the default 1000 on a system
   * doing nothing wrong.
   */
  it('charges a token key once, however many times it is used or flushed', () => {
    const c = counters(1000);
    for (let i = 0; i < 500; i += 1) c.countTokenUse(use('tok-a', T));
    for (let i = 0; i < 60; i += 1) {
      const pending = c.pendingAggregates();
      c.markFlushed(pending);
    }
    expect(c.rowsAt(T)).toBe(1);
    expect(c.overBudgetAt(T)).toBe(0);
  });

  it('resets at the hour rollover', () => {
    const c = counters(1);
    expect(c.admitEvent('local', 1, T)).toBe(true);
    expect(c.admitEvent('local', 1, T)).toBe(false);
    expect(c.admitEvent('local', 1, T + HOUR)).toBe(true);
    expect(c.overBudgetAt(T)).toBe(0);
  });

  /** A key refused on budget must never reach the map, or the same event
   *  would be counted by both `over_budget` and `token_lost`. */
  it('counts a budget refusal as over-budget only, never as a lost token use', () => {
    const c = counters(1);
    c.countTokenUse(use('tok-a', T));
    c.countTokenUse(use('tok-b', T));
    expect(c.overBudgetAt(T)).toBe(1);
    expect(c.dropped).toBe(0);
    const [stat] = c.takeStats('node-1');
    expect(stat.overBudget).toBe(1);
    
  });
});

describe('token buckets', () => {
  it('accumulates cumulatively and never clears on flush, so a retry rewrites the same number', () => {
    const c = counters();
    c.countTokenUse(use('tok-a', T));
    c.countTokenUse(use('tok-a', T));
    const first = c.pendingAggregates();
    expect(first[0].count).toBe(2);

    // The flush "fails": nothing is marked. The same total is offered again.
    expect(c.pendingAggregates()[0].count).toBe(2);

    c.markFlushed(first);
    expect(c.pendingAggregates()).toEqual([]);

    c.countTokenUse(use('tok-a', T));
    expect(c.pendingAggregates()[0].count).toBe(3);
  });

  it('stamps an aggregate at the hour start, not the last use', () => {
    const c = counters();
    c.countTokenUse(use('tok-a', T));
    expect(c.pendingAggregates()[0].at).toBe(Date.UTC(2026, 7, 22, 14));
  });

  /** The principal is the credential that was presented. An API token is
   *  named by its id, a Horizon OAuth token by the `sub` it was issued for —
   *  never by the `jti`, which is minted per issuance and would make aggregate
   *  rows grow with request volume. */
  it('names an api-token by its id and an oauth-token by its principal', () => {
    const c = counters();
    c.countTokenUse({ kind: 'api-token', username: 'ab12cd', at: T });
    c.countTokenUse({ kind: 'oauth-token', username: 'sre', at: T });
    const byKind = Object.fromEntries(c.pendingAggregates().map((p) => [p.kind, p]));
    expect(byKind['api-token'].username).toBe('ab12cd');
    expect(byKind['oauth-token'].username).toBe('sre');
  });
});

describe('eviction accounting', () => {
  /** The distinction the whole `flushed` field exists for: routine rollover
   *  of an up-to-date bucket must not look like data loss. */
  it('loses nothing when an evicted bucket was fully flushed', () => {
    const c = counters();
    c.countTokenUse(use('tok-a', T));
    c.markFlushed(c.pendingAggregates());
    // Four distinct hours: the first is evicted.
    for (let h = 1; h <= MAX_HOUR_BUCKETS; h += 1) c.countTokenUse(use('tok-a', T + h * HOUR));
    expect(c.dropped).toBe(0);
  });

  it('loses exactly the unflushed remainder when it was not', () => {
    const c = counters();
    c.countTokenUse(use('tok-a', T));
    c.markFlushed(c.pendingAggregates());
    for (let i = 0; i < 5; i += 1) c.countTokenUse(use('tok-a', T)); // 6 total, 1 flushed
    for (let h = 1; h <= MAX_HOUR_BUCKETS; h += 1) c.countTokenUse(use('tok-a', T + h * HOUR));
    expect(c.dropped).toBe(5);
  });

  it('refuses new keys past the entry cap while existing ones keep counting', () => {
    const c = counters(Number.MAX_SAFE_INTEGER);
    for (let i = 0; i < MAX_ENTRIES; i += 1) c.countTokenUse(use(`tok-${i}`, T));
    expect(c.bufferedEntries).toBe(MAX_ENTRIES);

    c.countTokenUse(use('one-too-many', T));
    expect(c.bufferedEntries).toBe(MAX_ENTRIES);
    expect(c.dropped).toBe(1);

    c.countTokenUse(use('tok-0', T));
    expect(c.pendingAggregates().find((p) => p.username === 'tok-0')?.count).toBe(2);
  });
});

describe('statistics', () => {
  it('counts accepted sign-ins by kind and refusals only as rejected', () => {
    const c = counters();
    c.admitEvent('local', 1, T);
    c.admitEvent('ldap', 1, T);
    c.admitEvent('sso', 1, T, 'oidc');
    c.admitEvent('sso', 1, T, 'oauth2');
    c.admitEvent('break-glass', 1, T);
    // A policy refusal is what happened INSTEAD of a sign-in, so it must not
    // also appear in its kind — a column total would exceed the hour's rows.
    c.admitEvent('ldap', 0, T);

    const [s] = c.takeStats('node-1');
    // Break-glass counts as a password sign-in: it IS one, using the local
    // account a directory outage left as the only way in. The ROW still says
    // `break-glass`, which is where that distinction matters.
    expect(s.login).toEqual({ local: 2, ldap: 1, oidc: 1, oauth: 1, token: 0 });
    expect(s.rejected).toBe(1);
  });

  it('emits deltas: taking resets, so the next interval starts from zero', () => {
    const c = counters();
    c.admitEvent('local', 1, T);
    expect(c.takeStats('node-1')[0].login.local).toBe(1);
    expect(c.takeStats('node-1')).toEqual([]);

    c.admitEvent('local', 1, T);
    expect(c.takeStats('node-1')[0].login.local).toBe(1);
  });

  it('folds a failed append back in, so the next one carries both intervals', () => {
    const c = counters();
    c.admitEvent('local', 1, T);
    const failed = c.takeStats('node-1');
    c.restoreStats(failed);
    c.admitEvent('local', 1, T);
    expect(c.takeStats('node-1')[0].login.local).toBe(2);
  });

  it('keeps a bucket per hour so a rollover does not discard the previous one', () => {
    const c = counters();
    c.admitEvent('local', 1, T);
    c.admitEvent('local', 1, T + HOUR);
    const stats = c.takeStats('node-1').sort((a, b) => a.hourBucket - b.hourBucket);
    expect(stats).toHaveLength(2);
    expect(stats[0].hourBucket).toBe(hourBucketOf(T));
    expect(stats[1].hourBucket).toBe(hourBucketOf(T + HOUR));
  });

  it('names the node on every row it hands out', () => {
    const c = counters();
    c.admitEvent('local', 1, T);
    expect(c.takeStats('pod-7:abc')[0].horizonNode).toBe('pod-7:abc');
  });
});

describe('regressions found by review', () => {
  /**
   * `markFlushed` re-reading the live count instead of the written one. The
   * store round trip yields, `countTokenUse` keeps incrementing, and marking
   * the CURRENT total flushed tells the bucket that uses it never sent are
   * safely stored. At an hour boundary the key is never revisited, so the loss
   * is permanent — and it recurs on the last flush of every hour.
   */
  it('marks only the count that was written, leaving later uses pending', () => {
    const c = counters();
    for (let i = 0; i < 5; i += 1) c.countTokenUse(use('tok-a', T));
    const written = c.pendingAggregates();
    expect(written[0].count).toBe(5);

    // Three more land while the write is in flight.
    for (let i = 0; i < 3; i += 1) c.countTokenUse(use('tok-a', T));
    c.markFlushed(written);

    expect(c.pendingAggregates()[0].count).toBe(8);
  });

  it('never moves flushed backwards when an out-of-order retry lands', () => {
    const c = counters();
    for (let i = 0; i < 5; i += 1) c.countTokenUse(use('tok-a', T));
    const early = c.pendingAggregates();
    for (let i = 0; i < 3; i += 1) c.countTokenUse(use('tok-a', T));
    c.markFlushed(c.pendingAggregates()); // 8
    c.markFlushed(early);                 // a stale 5 arriving late
    expect(c.pendingAggregates()).toEqual([]);
  });

  /** Eviction only ran after a successful insert, so at the cap the insert
   *  never happened and the eviction that would free space never ran — the
   *  node stopped counting any new credential for the life of the process. */
  it('recovers from a full map instead of wedging at the cap', () => {
    const c = counters(Number.MAX_SAFE_INTEGER);
    for (let i = 0; i < MAX_ENTRIES; i += 1) c.countTokenUse(use(`tok-${i}`, T));
    expect(c.bufferedEntries).toBe(MAX_ENTRIES);

    // Refusing new keys at the cap is the designed behaviour; being unable to
    // ever reclaim is not. Eviction used to run only after a successful
    // insert, so at the cap it could never run again and the node stopped
    // counting new credentials for the life of the process.
    const past = T + MAX_ENTRY_AGE_MS + HOUR;
    c.countTokenUse(use('fresh', past));
    expect(c.bufferedEntries).toBe(1);
    expect(c.pendingAggregates().map((p) => p.username)).toEqual(['fresh']);
  });

  /**
   * `countTokenUse` runs on EVERY authenticated request, so it must not scan
   * the map. Reclaiming before the cap check (which is what stops the map
   * wedging) made it O(map) — filling the cap became ~50M comparisons, and CI
   * found it as a five-second timeout on a test that takes milliseconds here.
   *
   * The bound is deliberately loose: it is there to catch a return to
   * quadratic, not to police milliseconds on a shared runner.
   */
  it('stays constant-time per use, including against a full map', () => {
    const c = counters(Number.MAX_SAFE_INTEGER);
    const started = Date.now();
    for (let i = 0; i < MAX_ENTRIES; i += 1) c.countTokenUse(use(`tok-${i}`, T));
    // Every one of these is refused, which is the path that rescanned.
    for (let i = 0; i < 5_000; i += 1) c.countTokenUse(use(`overflow-${i}`, T));
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(c.bufferedEntries).toBe(MAX_ENTRIES);
  });

  /** A key refused for MEMORY must not also spend a row of the budget: the
   *  row it would have created will never exist, so charging for it lets
   *  token churn starve real sign-ins. */
  it('charges no budget for a key the entry cap refuses', () => {
    const c = counters(MAX_ENTRIES + 100);
    for (let i = 0; i < MAX_ENTRIES; i += 1) c.countTokenUse(use(`tok-${i}`, T));
    const spent = c.rowsAt(T);
    c.countTokenUse(use('refused', T));
    expect(c.rowsAt(T)).toBe(spent);
    expect(c.overBudgetAt(T)).toBe(0);
  });

  /** A bare inequality re-armed the budget on ANY hour change, so one
   *  late-arriving row from a previous hour refunded the cap — alternate two
   *  hours and it never fills. */
  it('does not let a row for an older hour refund the current budget', () => {
    const c = counters(2);
    expect(c.admitEvent('local', 1, T)).toBe(true);
    expect(c.admitEvent('local', 1, T)).toBe(true);
    expect(c.admitEvent('local', 1, T)).toBe(false);
    // A straggler stamped an hour earlier must not reopen the window.
    c.admitEvent('local', 1, T - HOUR);
    expect(c.admitEvent('local', 1, T)).toBe(false);
  });

  /** The reset lived only in the write path, so a node that recorded nothing
   *  since the hour turned reported the PREVIOUS hour's spend as current — an
   *  operator would read a full budget that had been empty for fifty minutes. */
  it('reports the current hour even when nothing has been recorded in it', () => {
    const c = counters(10);
    c.admitEvent('local', 1, T);
    expect(c.rowsAt(T)).toBe(1);
    expect(c.rowsAt(T + HOUR)).toBe(0);
  });

  /**
   * `stat()` inserted and then evicted, so an accumulator for an hour older
   * than the retained three could be deleted immediately and handed back
   * detached — every `+=` against it landed on garbage. That is how
   * eviction's own `tokenLost` went missing.
   */
  it('never hands back a stat accumulator that eviction has already dropped', () => {
    const c = counters();
    for (let h = 0; h < MAX_HOUR_BUCKETS + 2; h += 1) c.admitEvent('local', 1, T + h * HOUR);
    const stats = c.takeStats('node-1');
    // Whatever survived eviction must be real rows carrying real counts.
    expect(stats.length).toBe(MAX_HOUR_BUCKETS);
    for (const s of stats) expect(s.login.local).toBe(1);
  });
});

describe('the per-principal share is metered by the key it is given', () => {
  /**
   * One key, one share — however many times it is presented. Whether two
   * spellings ARE one principal is the backend's question, not this layer's:
   * `auth.local.users` is case-sensitive, so folding case here would let one
   * local account spend another's share.
   */
  it('meters one key as one principal', () => {
    const c = counters(100); // share = 20
    let accepted = 0;
    for (let i = 0; i < 80; i += 1) if (c.admitEvent('ldap', 1, T, undefined, 'uid=alice,dc=x')) accepted += 1;
    expect(accepted).toBe(20);
  });

  it('keeps distinct keys distinct, because case-sensitive backends exist', () => {
    const c = counters(100);
    for (let i = 0; i < 40; i += 1) c.admitEvent('local', 1, T, undefined, 'Alice');
    // A different local account, not a spelling of the same one.
    expect(c.admitEvent('local', 1, T, undefined, 'alice')).toBe(true);
  });

  it('still gives a genuinely different principal its own share', () => {
    const c = counters(100);
    for (let i = 0; i < 40; i += 1) c.admitEvent('ldap', 1, T, undefined, 'alice');
    expect(c.admitEvent('ldap', 1, T, undefined, 'bob')).toBe(true);
  });
});
