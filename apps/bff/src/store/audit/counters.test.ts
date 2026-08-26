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
  MAX_HOUR_BUCKETS,
} from './counters.js';

const T = Date.UTC(2026, 7, 22, 14, 30); // 2026-08-22T14:30Z
const HOUR = 3_600_000;

function counters(maxRowsPerHour = 1000): AuditCounters {
  return new AuditCounters({ maxRowsPerHour });
}

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

  it('resets at the hour rollover', () => {
    const c = counters(1);
    expect(c.admitEvent('local', 1, T)).toBe(true);
    expect(c.admitEvent('local', 1, T)).toBe(false);
    expect(c.admitEvent('local', 1, T + HOUR)).toBe(true);
    expect(c.overBudgetAt(T)).toBe(0);
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
    expect(s.login).toEqual({ local: 2, ldap: 1, oidc: 1, oauth: 1 });
    expect(s.rejected).toBe(1);
  });

  it('reports a running total, so taking twice reports the same figure', () => {
    const c = counters();
    c.admitEvent('local', 1, T);
    expect(c.takeStats('node-1')[0].login.local).toBe(1);
    // Taking does not consume. A write replaces the hour rather than adding to
    // it, so a flush repeated after an uncertain outcome must leave the same
    // number instead of counting twice.
    expect(c.takeStats('node-1')[0].login.local).toBe(1);

    c.admitEvent('local', 1, T);
    expect(c.takeStats('node-1')[0].login.local).toBe(2);
  });

  it('starts a restarted process at zero, which is what a fresh identity means', () => {
    // Nothing is read back at boot and nothing needs to be: `horizonNode`
    // carries a per-process id, so this counter's figures are only ever its
    // own, and its predecessor's stay where they are and still count.
    const c = counters();
    c.admitEvent('local', 1, T);
    expect(c.takeStats('node-1')[0].login.local).toBe(1);
    expect(counters().takeStats('node-2')).toEqual([]);
  });

  it('will not resurrect an hour it has already let go of', () => {
    // A write replaces the hour rather than adding to it, so counting a late
    // event into a closed hour would report a handful over a stored total and
    // the hour would visibly collapse.
    const c = counters();
    const hour = (n: number): number => hourBucketOf(T + n * 3_600_000);
    c.admitEvent('local', 1, T);
    for (let i = 1; i <= MAX_HOUR_BUCKETS; i += 1) c.admitEvent('local', 1, T + i * 3_600_000);
    c.takeStats('node-1');

    // The first hour is gone. An event arriving for it now is admitted as a
    // sign-in but must not reopen the statistic.
    expect(c.admitEvent('local', 1, T)).toBe(true);
    expect(c.takeStats('node-1').some((s) => s.hourBucket === hour(0))).toBe(false);
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
