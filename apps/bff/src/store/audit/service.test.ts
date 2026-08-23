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

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { isIP } from 'node:net';
import type { AuditConfig } from '../../config/schema.js';
import { BufferedAuditService } from './service.js';
import { logger } from '../../logger.js';
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
  /** Mirrors the real store, which drops its pool on close and throws
   *  `unreachable` from every later call. A fake that accepts writes after
   *  close cannot observe a shutdown that closes under one. */
  closed = false;
  /** Park ONE named phase to hold it open across `stop()`. Named, because a
   *  pass reaches `writeEvents` first and parking that would test the handle
   *  shutdown already joined. */
  park: { promise: Promise<void>; release: () => void } | null = null;
  parkAt: string | null = null;
  closedDuring: string | null = null;

  private async pass(phase: string): Promise<void> {
    if (this.closed) throw new AuditStoreError('unreachable');
    if (this.failWith) throw this.failWith;
    if (this.park && this.parkAt === phase) {
      const g = this.park;
      this.park = null;
      await g.promise;
      if (this.closed) {
        this.closedDuring = phase;
        // The real store pulled its pool out from under this call.
        throw new AuditStoreError('unreachable');
      }
    }
  }

  async writeEvents(rows: ReadonlyArray<AuditEvent & StoreStamp>): Promise<void> {
    await this.pass('writeEvents');
    this.events.push(...rows);
  }
  async writeAggregates(rows: ReadonlyArray<AuditAggregate & StoreStamp>): Promise<void> {
    await this.pass('writeAggregates');
    this.aggregates.push(...rows);
  }
  async writeStat(stat: AuditStat): Promise<void> {
    await this.pass('writeStat');
    this.stats.push(stat);
  }
  async query(): Promise<never> { throw new Error('unused'); }
  async queryStat(): Promise<never> { throw new Error('unused'); }
  async sweep(): Promise<number> { await this.pass('sweep'); this.sweeps += 1; return 0; }
  async probe(): Promise<{ available: boolean }> { return { available: !this.failWith && !this.closed }; }
  // Counted BEFORE the throw: an attempt that fails is still an attempt, and
  // the retry tests measure attempts.
  async open(): Promise<void> { this.opens += 1; await this.pass('open'); }
  async close(): Promise<void> { this.closed = true; }
}

/** A latch the fake store parks on, so a named phase can be held open across
 *  a concurrent `stop()`. */
function latch(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
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
afterEach(() => { vi.useRealTimers(); });

/** Freeze the clock at `T`.
 *
 *  `health()` reports the hour the PROCESS IS IN, read from the real clock,
 *  while the fixtures record at the fixed `T`. Left on the wall clock those
 *  two agree only while real time happens to sit inside T's hour — so these
 *  tests passed on the day they were written and turn red for good once it
 *  passes, which is a test that reports the calendar rather than the code. */
function freezeAtT(): void {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(T);
}

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
    freezeAtT();
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
    freezeAtT();
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

/**
 * `stop()` joined the event and aggregate writes, and nothing else. A tick
 * that had already reached its statistics or sweep phase had cleared both of
 * those handles, so shutdown sailed straight past it and closed the pool
 * underneath a live write — losing the drained statistics interval and
 * logging "store unreachable" in the middle of an orderly shutdown.
 */
describe('shutdown must join the TICK, not only the two write handles', () => {
  /** Let the parked tick actually reach the store call. A microtask is not
   *  enough — `runTick` awaits several times before it gets there. */
  const settle = (): Promise<void> => new Promise((r) => { setImmediate(r); });

  it('does not close the store under an in-flight statistics write, and still writes the row', async () => {
    // flushIntervalSeconds === eventBatchSeconds, so every tick reaches the
    // statistics phase and the parked call is reached on the next one.
    const svc = service({ flushIntervalSeconds: 15 });
    await svc.tick();
    signIn(svc);
    store.park = latch();
    store.parkAt = 'writeStat';
    const held = store.park;
    const parked = svc.tick();
    await settle();
    const stopping = svc.stop();
    await settle();
    held.release();
    await Promise.allSettled([parked, stopping]);

    expect(store.closedDuring).toBeNull();
    expect(store.stats.length).toBeGreaterThan(0);
  });

  it('does not close the store under an in-flight sweep', async () => {
    // Aggregates far out of the way, so tick 4 is a sweep and nothing else.
    const svc = service({
      flushIntervalSeconds: 3600,
      postgres: { ...config().postgres, sweepIntervalMinutes: 1 },
    });
    await svc.tick();
    store.park = latch();
    store.parkAt = 'sweep';
    const held = store.park;
    const parked = (async () => {
      for (let i = 0; i < 3; i += 1) await svc.tick();
    })();
    await settle();
    const stopping = svc.stop();
    await settle();
    held.release();
    await Promise.allSettled([parked, stopping]);

    expect(store.closedDuring).toBeNull();
  });

  /* The timer is fire-and-forget, so a tick can be queued behind `stop()`.
   * It must not reopen the pool shutdown is about to close. */
  it('a tick queued behind stop() does not reopen the pool shutdown just closed', async () => {
    const svc = service();
    await svc.tick();
    await svc.stop();
    store.opens = 0;
    // The timer is fire-and-forget, so a tick can still be queued when the
    // process is on its way out. Reopening here rebuilds a pool nothing will
    // ever close, and writes into a store shutdown already accounted for.
    await svc.tick();
    expect(store.opens).toBe(0);
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

/**
 * The `horizon_ip` column was fully plumbed — DDL, insert, row mapper, and a
 * `v-if` in the list — while nothing ever produced a value, so it was NULL on
 * every row ever written. These pin the producer that fixes it.
 */
describe('the node stamp', () => {
  const POD_IP = process.env.POD_IP;
  afterEach(() => {
    if (POD_IP === undefined) delete process.env.POD_IP;
    else process.env.POD_IP = POD_IP;
  });

  async function stampOf(svc: BufferedAuditService): Promise<StoreStamp> {
    await svc.tick();
    signIn(svc);
    await svc.tick();
    const row = store.events[0];
    if (!row) throw new Error('no row written');
    return row;
  }

  it('stamps the Kubernetes pod address when the downward API supplies one', async () => {
    process.env.POD_IP = '10.42.0.17';
    expect((await stampOf(service())).horizonIp).toBe('10.42.0.17');
  });

  it('ignores a POD_IP that is not an address rather than storing the garbage', async () => {
    process.env.POD_IP = 'not-an-address';
    // Falls through to interface detection, which on a machine with no
    // external interface legitimately yields nothing — the point is only that
    // the unusable value never reaches the row.
    const ip = (await stampOf(service())).horizonIp;
    expect(ip).not.toBe('not-an-address');
    if (ip !== undefined) expect(isIP(ip)).not.toBe(0);
  });

  it('lets an explicitly supplied address win over detection', async () => {
    process.env.POD_IP = '10.42.0.17';
    const svc = new BufferedAuditService({
      store, config: config(), horizonNode: 'node-1', horizonIp: '192.0.2.9',
    });
    expect((await stampOf(svc)).horizonIp).toBe('192.0.2.9');
  });

  it('stamps aggregate rows with the same address as sign-in rows', async () => {
    process.env.POD_IP = '10.42.0.17';
    const svc = service();
    await svc.tick();
    svc.countTokenUse({ kind: 'api-token', username: 'ab12cd', at: T });
    // Aggregates ride the every-fourth tick (flushIntervalSeconds /
    // eventBatchSeconds), so drive the timer rather than reaching inside.
    for (let i = 0; i < 4; i += 1) await svc.tick();
    expect(store.aggregates[0]?.horizonIp).toBe('10.42.0.17');
  });
});

/** Cadences are whole ticks, so one that does not divide by
 *  `eventBatchSeconds` is rounded up. Rounding is right; doing it silently
 *  leaves an operator reading a period from their config that the process is
 *  not running. */
describe('a cadence that is not a whole number of ticks', () => {
  it('says so at construction, naming the configured and the effective value', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    new BufferedAuditService({
      store, config: config({ eventBatchSeconds: 45, flushIntervalSeconds: 60 }), horizonNode: 'node-1',
    });
    const call = warn.mock.calls.find((c) => String(c[1]).includes('rounded up'));
    expect(call).toBeDefined();
    expect(call?.[0]).toMatchObject({ flushIntervalSeconds: 60, effectiveFlushSeconds: 90 });
    warn.mockRestore();
  });

  it('stays quiet when every cadence divides evenly', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    new BufferedAuditService({
      store, config: config({ eventBatchSeconds: 15, flushIntervalSeconds: 60 }), horizonNode: 'node-1',
    });
    expect(warn.mock.calls.find((c) => String(c[1]).includes('rounded up'))).toBeUndefined();
    warn.mockRestore();
  });
});

/**
 * Boot fires `start()` and does not await it, so a SIGTERM landing during the
 * first open used to run shutdown alongside startup — two opens, one close,
 * and a timer installed after the process had been told to leave.
 */
describe('startup and shutdown must not overlap', () => {
  it('opens once when stop() arrives during start()', async () => {
    store.park = latch();
    store.parkAt = 'open';
    const held = store.park;
    const svc = service();
    const starting = svc.start();
    await new Promise((r) => { setImmediate(r); });
    const stopping = svc.stop();
    await new Promise((r) => { setImmediate(r); });
    held.release();
    await Promise.allSettled([starting, stopping]);
    expect(store.opens).toBe(1);
    expect(store.closed).toBe(true);
  });

  it('installs no timer when shutdown was entered first', async () => {
    const svc = service();
    await svc.stop();
    await svc.start();
    expect((svc as unknown as { timer: unknown }).timer).toBeNull();
  });
});

/** `statement_timeout` is a SERVER-side rule and cannot bound a socket whose
 *  peer vanished. Only a clock on this side can, or an orderly exit hangs. */
describe('shutdown is bounded by a clock', () => {
  it('closes the store even when a write never returns', async () => {
    const svc = service();
    await svc.tick();
    signIn(svc);
    // A store call that never settles at all.
    store.writeEvents = () => new Promise<void>(() => {});
    const stopped = svc.stop();
    await vi.waitFor(() => expect(store.closed).toBe(true), { timeout: 20_000 });
    await stopped;
  }, 30_000);
});

/** `available` gates the row-threshold flush, so marking it on a read fault
 *  let anyone holding `audit:read` stop sign-ins being recorded. */
describe('a reader must not take down the writer', () => {
  it('keeps recording when a query times out', async () => {
    const svc = service();
    await svc.tick();
    expect((await svc.health()).available).toBe(true);
    store.query = async () => { throw new AuditStoreError('timeout'); };
    await expect(svc.query({ pageNum: 1, pageSize: 50 })).rejects.toThrow();
    expect((await svc.health()).available).toBe(true);
  });

  it('still reports a read fault that IS evidence about the store', async () => {
    const svc = service();
    await svc.tick();
    store.query = async () => { throw new AuditStoreError('schema_error'); };
    await expect(svc.query({ pageNum: 1, pageSize: 50 })).rejects.toThrow();
    const h = await svc.health();
    expect(h.available).toBe(false);
    expect(h.error).toBe('schema_error');
  });
});

/** The cap is enforced on admission only, so a failed flush returning its
 *  detached batch on top of a buffer that refilled during the write could
 *  exceed it — the reviewer reproduced 10 500 entries against a 10 000 cap. */
describe('the buffer ceiling survives a failed flush', () => {
  it('never exceeds the cap when a batch is returned to a refilled buffer', async () => {
    const svc = service({ maxRowsPerHour: 1_000_000 });
    const buffer = (svc as unknown as { buffer: unknown[] }).buffer;

    // Fill to the cap with the store DOWN, so the row trigger never drains.
    store.failWith = new AuditStoreError('unreachable');
    await svc.tick();
    for (let i = 0; i < 10_000; i += 1) signIn(svc, T + i);
    expect(buffer.length).toBe(10_000);

    // Now the store answers, the flush detaches a batch — and more sign-ins
    // land while that batch is on the wire, before it fails.
    store.failWith = null;
    // Refill by pushing DIRECTLY onto the buffer. Calling `recordEvent` here
    // re-entered the row trigger from inside the write it was mocking, which
    // recursed until the stack blew — the assertion still passed, so the test
    // was green while printing stack overflows.
    store.writeEvents = async () => {
      for (let i = 0; i < 500; i += 1) {
        buffer.push({ at: T + 50_000 + i, kind: 'local', outcome: 1, username: 'late', shape: 'event', horizonNode: 'node-1' } as never);
      }
      throw new AuditStoreError('unreachable');
    };
    await svc.tick();

    expect(buffer.length).toBeLessThanOrEqual(10_000);
  });

  /** The ceiling counts rows on the wire too: excluding the detached batch let
   *  real occupancy reach the cap plus one batch. */
  it('counts the batch in flight against the ceiling', async () => {
    const svc = service({ maxRowsPerHour: 1_000_000 });
    const buffer = (svc as unknown as { buffer: unknown[] }).buffer;
    await svc.tick();
    store.park = latch();
    store.parkAt = 'writeEvents';
    const held = store.park;
    for (let i = 0; i < 10_000; i += 1) signIn(svc, T + i);
    const detached = (svc as unknown as { detached: number }).detached;
    expect(detached).toBeGreaterThan(0);
    expect(buffer.length + detached).toBeLessThanOrEqual(10_000);
    held.release();
  });
});

/** Two signals, or a signal beside an explicit stop, otherwise ran the whole
 *  sequence twice — one closing the store while the other was still flushing. */
describe('stop() is single-flight', () => {
  it('runs the sequence once for concurrent callers', async () => {
    const svc = service();
    await svc.tick();
    signIn(svc);
    const closes: number[] = [];
    const realClose = store.close.bind(store);
    store.close = async () => { closes.push(1); await realClose(); };
    await Promise.all([svc.stop(), svc.stop(), svc.stop()]);
    expect(closes).toHaveLength(1);
    expect(store.events.length).toBe(1);
  });

  /* `stop()` is `async`, so it always hands back a fresh promise — identity
   * is not the contract. Running the sequence once is. */
  it('does not re-run the sequence when called again after it finished', async () => {
    const svc = service();
    await svc.tick();
    await svc.stop();
    const closesAfter: number[] = [];
    store.close = async () => { closesAfter.push(1); };
    await svc.stop();
    expect(closesAfter).toHaveLength(0);
  });
});
