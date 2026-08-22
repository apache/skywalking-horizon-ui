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

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AuditConfig } from '../../config/schema.js';
import { BufferedAuditService } from './service.js';
import {
  AuditStoreError,
  type AuditAggregate,
  type AuditEvent,
  type AuditStat,
  type AuditStore,
  type StoreStamp,
} from './types.js';

const T = Date.UTC(2026, 7, 22, 14, 30);

function config(over: Partial<AuditConfig> = {}): AuditConfig {
  return {
    enabled: true,
    maxRowsPerHour: 1000,
    flushIntervalSeconds: 60,
    eventBatchRows: 50,
    eventBatchSeconds: 15,
    provider: 'postgres',
    postgres: {
      url: 'postgres://x@127.0.0.1/x', caFile: '', autoMigrate: true,
      retentionDays: 90, sweepIntervalMinutes: 60, poolMax: 4,
      connectionTimeoutMs: 5000, statementTimeoutMs: 1000,
    },
    ...over,
  } as AuditConfig;
}

class FakeStore implements AuditStore {
  events: Array<AuditEvent & StoreStamp> = [];
  aggregates: Array<AuditAggregate & StoreStamp> = [];
  stats: AuditStat[] = [];
  sweeps = 0;
  opens = 0;
  failWith: AuditStoreError | null = null;

  async writeEvents(rows: ReadonlyArray<AuditEvent & StoreStamp>): Promise<void> {
    if (this.failWith) throw this.failWith;
    this.events.push(...rows);
  }
  async writeAggregates(rows: ReadonlyArray<AuditAggregate & StoreStamp>): Promise<void> {
    if (this.failWith) throw this.failWith;
    this.aggregates.push(...rows);
  }
  async writeStat(stat: AuditStat): Promise<void> {
    if (this.failWith) throw this.failWith;
    this.stats.push(stat);
  }
  async query(): Promise<never> { throw new Error('unused'); }
  async queryStat(): Promise<never> { throw new Error('unused'); }
  async sweep(): Promise<number> { this.sweeps += 1; return 0; }
  async probe(): Promise<{ available: boolean }> { return { available: !this.failWith }; }
  async open(): Promise<void> { this.opens += 1; if (this.failWith) throw this.failWith; }
  async close(): Promise<void> {}
}

let store: FakeStore;
function service(cfg: Partial<AuditConfig> = {}): BufferedAuditService {
  return new BufferedAuditService({
    store, config: config(cfg), horizonNode: 'node-1',
  });
}
function signIn(svc: BufferedAuditService, at = T): void {
  svc.recordEvent({ at, kind: 'local', outcome: 1, username: 'alice' });
}

beforeEach(() => { store = new FakeStore(); });

describe('the login path', () => {
  it('records without touching the store — recordEvent is synchronous and returns nothing', () => {
    const svc = service();
    expect(svc.recordEvent({ at: T, kind: 'local', outcome: 1, username: 'alice' })).toBeUndefined();
    expect(store.events).toHaveLength(0);
  });

  /** The property the whole buffered design exists for. */
  it('cannot be affected by a store that throws on every call', () => {
    store.failWith = new AuditStoreError('unreachable');
    const svc = service();
    for (let i = 0; i < 200; i += 1) signIn(svc);
    expect(store.events).toHaveLength(0);
  });

  it('drops a sign-in the hourly budget refuses rather than buffering it', async () => {
    const svc = service({ maxRowsPerHour: 2 });
    for (let i = 0; i < 5; i += 1) signIn(svc);
    await svc.tick();
    expect(store.events).toHaveLength(2);
    expect((await svc.health()).overBudgetThisHour).toBe(3);
  });
});

describe('batching', () => {
  it('writes on the row trigger without waiting for the tick', async () => {
    const svc = service({ eventBatchRows: 3 });
    await svc.tick(); // become available
    signIn(svc); signIn(svc);
    expect(store.events).toHaveLength(0);
    signIn(svc);
    await vi.waitFor(() => expect(store.events).toHaveLength(3));
  });

  /**
   * The row trigger must not advance the tick counter. If it did, a node
   * filling a batch every second would run aggregates and retention on
   * traffic volume instead of on time — sweeping every few minutes.
   */
  it('does not let the row trigger drive the slower cadences', async () => {
    const svc = service({ eventBatchRows: 1, flushIntervalSeconds: 60, eventBatchSeconds: 15 });
    await svc.tick();
    svc.countTokenUse({ kind: 'api-token', username: 'ab12cd', at: T });
    for (let i = 0; i < 100; i += 1) signIn(svc);
    await vi.waitFor(() => expect(store.events.length).toBeGreaterThan(0));
    // Rows went out, but neither slower cadence fired: those hang off the tick
    // counter, which the row trigger must never advance.
    expect(store.aggregates).toHaveLength(0);
    expect(store.sweeps).toBe(0);
  });

  it('drains a backlog over several batches in one pass', async () => {
    const svc = service({ eventBatchRows: 10 });
    store.failWith = new AuditStoreError('unreachable');
    for (let i = 0; i < 100; i += 1) signIn(svc);
    store.failWith = null;
    await svc.tick();
    expect(store.events).toHaveLength(100);
  });
});

describe('cadences hang off one tick counter', () => {
  /**
   * The starvation this separates two guards for. With one shared flag a busy
   * node nearly always has a row-triggered drain in flight, so every tick
   * would return immediately and aggregates and retention would silently
   * never run — the counters would look healthy while nothing was written.
   */
  it('still runs the slower cadences while event flushes are constantly in flight', async () => {
    const svc = service({ eventBatchRows: 1, flushIntervalSeconds: 15, eventBatchSeconds: 15 });
    await svc.tick();
    svc.countTokenUse({ kind: 'api-token', username: 'ab12cd', at: T });
    for (let i = 0; i < 50; i += 1) signIn(svc);
    await svc.tick();
    expect(store.aggregates).toHaveLength(1);
  });

  it('flushes events every tick and aggregates every fourth', async () => {
    const svc = service({ flushIntervalSeconds: 60, eventBatchSeconds: 15 });
    svc.countTokenUse({ kind: 'api-token', username: 'ab12cd', at: T });
    for (let i = 1; i <= 3; i += 1) await svc.tick();
    expect(store.aggregates).toHaveLength(0);
    await svc.tick();
    expect(store.aggregates).toHaveLength(1);
    expect(store.aggregates[0].count).toBe(1);
  });

  it('sweeps on its own much slower cadence', async () => {
    const svc = service({ eventBatchSeconds: 15 });
    for (let i = 0; i < 239; i += 1) await svc.tick();
    expect(store.sweeps).toBe(0);
    await svc.tick();
    expect(store.sweeps).toBe(1);
  });

  it('re-opens on the tick while the store is down, and needs no probe timer', async () => {
    store.failWith = new AuditStoreError('unreachable');
    const svc = service();
    await svc.tick();
    expect((await svc.health()).available).toBe(false);
    store.failWith = null;
    await svc.tick();
    expect((await svc.health()).available).toBe(true);
    expect(store.opens).toBeGreaterThan(1);
  });
});

describe('failure handling', () => {
  it('keeps a failed batch buffered and re-sends it, rather than dropping it', async () => {
    const svc = service();
    signIn(svc);
    store.failWith = new AuditStoreError('timeout');
    await svc.tick();
    expect(store.events).toHaveLength(0);

    store.failWith = null;
    await svc.tick();
    expect(store.events).toHaveLength(1);
  });

  /** Cumulative counts are what make the aggregate retry idempotent: the
   *  second attempt writes the same total, not an increment. */
  it('re-sends the same cumulative total after a failed aggregate flush', async () => {
    const svc = service({ flushIntervalSeconds: 15, eventBatchSeconds: 15 });
    svc.countTokenUse({ kind: 'api-token', username: 'ab12cd', at: T });
    svc.countTokenUse({ kind: 'api-token', username: 'ab12cd', at: T });
    store.failWith = new AuditStoreError('timeout');
    await svc.tick();
    store.failWith = null;
    await svc.tick();
    expect(store.aggregates).toHaveLength(1);
    expect(store.aggregates[0].count).toBe(2);
  });

  it('folds failed statistics back in so nothing is silently skipped', async () => {
    const svc = service({ flushIntervalSeconds: 15, eventBatchSeconds: 15 });
    signIn(svc);
    store.failWith = new AuditStoreError('timeout');
    await svc.tick();
    store.failWith = null;
    signIn(svc);
    await svc.tick();
    const local = store.stats.reduce((n, s) => n + s.login.local, 0);
    expect(local).toBe(2);
  });
});

describe('health', () => {
  it('separates off, unconfigured and unreachable', async () => {
    store.failWith = new AuditStoreError('auth_failed');
    const svc = service();
    await svc.tick();
    const h = await svc.health();
    expect(h.enabled).toBe(true);
    expect(h.configured).toBe(true);
    expect(h.available).toBe(false);
    expect(h.error).toBe('auth_failed');
    expect(h.horizonNode).toBe('node-1');
  });

  it('reports the hour it is actually in, not the last one recorded in', async () => {
    const svc = service();
    signIn(svc);
    const h = await svc.health();
    expect(h.rowsThisHour).toBeGreaterThan(0);
  });
});

describe('shutdown', () => {
  it('flushes what is buffered before closing', async () => {
    const svc = service();
    await svc.tick();
    signIn(svc);
    svc.countTokenUse({ kind: 'api-token', username: 'ab12cd', at: T });
    await svc.stop();
    expect(store.events).toHaveLength(1);
    expect(store.aggregates).toHaveLength(1);
    expect(store.stats.length).toBeGreaterThan(0);
  });
});

describe('regressions found by review', () => {
  /** A store whose writes park until released, so a flush can be held
   *  in-flight while something else happens. */
  class SlowStore extends FakeStore {
    release!: () => void;
    private gate = new Promise<void>((r) => { this.release = r; });
    override async writeEvents(rows: ReadonlyArray<AuditEvent & StoreStamp>): Promise<void> {
      await this.gate;
      await super.writeEvents(rows);
    }
  }

  /**
   * The shutdown bug a boolean guard creates: with a drain in flight, stop()'s
   * final flush returned immediately having written nothing, then closed the
   * store — losing the whole buffer while reporting no loss. Joining the
   * in-flight promise is what makes "flush once, then close" true.
   */
  it('joins an in-flight flush on stop instead of closing under it', async () => {
    const slow = new SlowStore();
    store = slow;
    const svc = service({ eventBatchRows: 2 });
    await svc.tick();

    signIn(svc); signIn(svc); // fills a batch, fires the drain, which parks
    const stopped = svc.stop();
    slow.release();
    await stopped;

    expect(slow.events).toHaveLength(2);
  });

  it('does not start new work behind stop()', async () => {
    const svc = service({ eventBatchRows: 1 });
    await svc.tick();
    await svc.stop();
    const written = store.events.length;
    signIn(svc);
    await new Promise((r) => setTimeout(r, 5));
    expect(store.events).toHaveLength(written);
  });

  /**
   * Rows were left in the buffer during the write and removed afterwards by
   * position — so an overflow `shift()` landing under the await moved every
   * row left, and the rows discarded were not the rows written.
   */
  it('returns a failed batch to the front of the buffer, in order', async () => {
    // Batch size above the row count, so only the tick drives the write and
    // the row trigger cannot fire before the failure is armed.
    const svc = service({ eventBatchRows: 5 });
    await svc.tick();
    svc.recordEvent({ at: T, kind: 'local', outcome: 1, username: 'first' });
    svc.recordEvent({ at: T, kind: 'local', outcome: 1, username: 'second' });
    store.failWith = new AuditStoreError('timeout');
    await svc.tick();
    expect(store.events).toHaveLength(0);

    store.failWith = null;
    await svc.tick();
    expect(store.events.map((e) => e.username)).toEqual(['first', 'second']);
  });

  /** Every other write path reports; a bare catch here left health green and
   *  the log silent while statistics quietly stopped being written. */
  it('marks the store unavailable when only the statistics write fails', async () => {
    const svc = service({ flushIntervalSeconds: 15, eventBatchSeconds: 15 });
    await svc.tick();
    signIn(svc);
    const failing = new AuditStoreError('schema_error');
    store.writeStat = async () => { throw failing; };
    await svc.tick();
    const h = await svc.health();
    expect(h.available).toBe(false);
    expect(h.error).toBe('schema_error');
  });

  /** Uses landing during the aggregate round trip must stay pending, or the
   *  stored count silently under-reports for that credential-hour. */
  it('does not mark token uses flushed that arrived during the write', async () => {
    let landDuringWrite: (() => void) | null = null;
    store.writeAggregates = async (rows) => {
      landDuringWrite?.();
      store.aggregates.push(...rows);
    };
    const svc = service({ flushIntervalSeconds: 15, eventBatchSeconds: 15 });
    await svc.tick();
    for (let i = 0; i < 5; i += 1) svc.countTokenUse({ kind: 'api-token', username: 'ab12cd', at: T });
    landDuringWrite = () => {
      for (let i = 0; i < 3; i += 1) svc.countTokenUse({ kind: 'api-token', username: 'ab12cd', at: T });
    };
    await svc.tick();
    expect(store.aggregates.at(-1)?.count).toBe(5);

    landDuringWrite = null;
    await svc.tick();
    expect(store.aggregates.at(-1)?.count).toBe(8);
  });
});

describe('shutdown regressions found by review', () => {
  /**
   * The final pass used the same 20-batch cap a normal tick uses. At the
   * shipped batch size that writes 1 000 rows of a 10 000-row outage backlog
   * and closes the store on the rest — while reporting a graceful shutdown.
   */
  it('drains the whole buffer, not one capped pass', async () => {
    const svc = service({ eventBatchRows: 10 });
    store.failWith = new AuditStoreError('unreachable');
    // DISTINCT principals: identical ones would hit the per-principal share of
    // the hourly budget long before the buffer filled, and this is a test
    // about draining, not about the budget.
    for (let i = 0; i < 500; i += 1) {
      svc.recordEvent({ at: T, kind: 'local', outcome: 1, username: `user-${i}` });
    }
    store.failWith = null;

    await svc.stop();
    expect(store.events.length).toBe(500);
  });

  /**
   * `stop()` waited for the event flush but not the aggregate one. An older
   * cumulative count landing after the newer shutdown write leaves the store
   * BEHIND what this process believes it flushed, and nothing revisits the
   * bucket — so the loss is permanent.
   */
  it('joins an in-flight aggregate write instead of racing it', async () => {
    let release = (): void => {};
    const gate = new Promise<void>((r) => { release = r; });
    let firstCall = true;
    const seen: number[] = [];
    store.writeAggregates = async (rows) => {
      const counts = rows.map((r) => r.count);
      if (firstCall) {
        firstCall = false;
        await gate; // the OLD write parks mid-flight
      }
      seen.push(...counts);
      store.aggregates.push(...rows);
    };

    const svc = service({ flushIntervalSeconds: 15, eventBatchSeconds: 15 });
    await svc.tick();
    for (let i = 0; i < 5; i += 1) svc.countTokenUse({ kind: 'api-token', username: 'ab12cd', at: T });
    const parked = svc.tick();            // writes 5, parks
    for (let i = 0; i < 3; i += 1) svc.countTokenUse({ kind: 'api-token', username: 'ab12cd', at: T });

    const stopped = svc.stop();
    release();
    await Promise.all([parked, stopped]);

    // Whatever order the writes were issued in, the LAST count the store saw
    // must not be smaller than an earlier one.
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[seen.length - 1]).toBeGreaterThanOrEqual(Math.max(...seen));
  });
});

describe('canonical metering', () => {
  /**
   * A case-insensitive directory accepts `alice`, `Alice` and an alias for one
   * account. The emit site supplies the directory's own identity as
   * `principalKey`, so all of them draw on ONE share — and that key is
   * metering only: what the row records is the spelling the row is about.
   */
  it('meters every spelling of one directory account as one principal', async () => {
    const svc = service({ maxRowsPerHour: 100 }); // share = 20
    await svc.tick();
    for (const spelling of ['alice', 'Alice', 'ALICE', 'alice@corp.example']) {
      for (let i = 0; i < 10; i += 1) {
        svc.recordEvent({
          at: T, kind: 'ldap', outcome: 1, username: spelling,
          principalKey: 'uid=alice,ou=people,dc=corp',
        });
      }
    }
    await svc.tick();
    expect(store.events).toHaveLength(20);
  });

  it('never stores the metering key', async () => {
    const svc = service();
    await svc.tick();
    svc.recordEvent({
      at: T, kind: 'ldap', outcome: 1, username: 'alice',
      principalKey: 'uid=alice,ou=people,dc=corp',
    });
    await svc.tick();
    expect(JSON.stringify(store.events)).not.toContain('ou=people');
  });
});
