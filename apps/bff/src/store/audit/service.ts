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
 * The backend-independent half of the audit log: the event buffer, the token
 * counting map, statistics, and the one timer that drives all of it.
 *
 * ONE `setInterval` runs the whole feature, at `eventBatchSeconds`. Every
 * slower job is a modulus of its tick counter — aggregates and statistics at
 * `flushIntervalSeconds`, retention at `sweepIntervalMinutes`, and `open()`
 * retried on each pass while the store is down. Separate intervals would drift
 * into each other and fire together anyway; a counter makes that scheduling
 * explicit and leaves exactly one handle to clear. At the default cadences
 * the sweep tick is a multiple of the aggregate tick and the two land on the
 * same pass — nothing forces that, and nothing needs to: the pass is
 * serialized and non-reentrant, and the row-count trigger drains events
 * independently, so a combined pass delays nothing observable either way.
 */

import { hostname, networkInterfaces } from 'node:os';
import { randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import type { AuditConfig } from '../../config/schema.js';
import { logger } from '../../logger.js';
import { AuditCounters, hourBucketOf } from './counters.js';
import {
  AuditStoreError,
  type AuditEvent,
  type AuditFilter,
  type AuditPageResult,
  type AuditHealth,
  type AuditService,
  type AuditStat,
  type AuditStatResult,
  type AuditStatWindow,
  type AuditStore,
  type StoreError,
  type StoreStamp,
  type TokenUse,
} from './types.js';

/** Buffered sign-in rows. Matches the token map's cap so one outage cannot
 *  grow memory through whichever path happens to be busier. */
const MAX_BUFFERED_EVENTS = 10_000;

/** Batches written per pass. Bounds how long one tick can run while still
 *  letting a backlog drain far faster than it accumulated. */
const MAX_BATCHES_PER_PASS = 20;

/** Passes shutdown will make to empty the buffer. Bounded only so a store
 *  that accepts writes without ever shrinking the buffer cannot hang the
 *  process; the loop also stops as soon as a pass makes no progress. */
const SHUTDOWN_MAX_PASSES = 1_000;

/**
 * Total wall-clock budget for a graceful stop.
 *
 * `statement_timeout` is enforced by the SERVER, so it cannot rescue a socket
 * whose peer has vanished without an RST: the query never returns and nothing
 * on this side is counting. Passes and progress checks bound how much WORK
 * shutdown does; only a clock bounds how long it takes. Past this the process
 * stops draining and closes, because an orderly exit that never finishes is
 * indistinguishable from a hang to whatever is waiting to kill it.
 */
const SHUTDOWN_DEADLINE_MS = 10_000;

/** Resolve `work`, or give up at the deadline. The underlying operation is
 *  not cancelled — `pg` offers no way to — but the caller stops waiting. */
async function withDeadline<T>(work: Promise<T>, ms: number, onExpiry: () => void): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => { onExpiry(); resolve(undefined); }, ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([work.catch(() => undefined), expiry]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** `<hostname>:<boot-id>` — one Horizon PROCESS, not a host and not a pod.
 *  A restart opens a new identity, which is what lets replicas hold cumulative
 *  counts without ever colliding on one. */
function horizonNodeId(): string {
  return `${hostname()}:${randomBytes(4).toString('hex')}`;
}

/**
 * The routable address of THIS Horizon, for the `horizon_ip` column.
 *
 * `horizon_node` names the process; this names where it can be reached, which
 * is the half an operator can correlate with a load balancer or a network
 * log. In a pod the hostname is a generated name and the address is the only
 * durable handle.
 *
 * `POD_IP` (the Kubernetes downward API) wins when it is set, because a host
 * with several interfaces makes enumeration a guess. Loopback and link-local
 * are skipped: neither says where this process can be reached from anywhere
 * else, and an audit row that claims 127.0.0.1 wrote it is worse than one
 * that admits it does not know.
 */
function horizonNodeIp(): string | undefined {
  const declared = process.env.POD_IP?.trim();
  if (declared && isIP(declared) !== 0) return declared;
  let fallback: string | undefined;
  for (const addresses of Object.values(networkInterfaces())) {
    for (const a of addresses ?? []) {
      if (a.internal) continue;
      if (a.family === 'IPv4') return a.address;
      // `fe80::/10` is scoped to one link, so it identifies nothing outside it.
      if (!fallback && !a.address.toLowerCase().startsWith('fe80:')) fallback = a.address;
    }
  }
  return fallback;
}

export interface AuditServiceOptions {
  store: AuditStore;
  config: AuditConfig;
  horizonNode?: string;
  horizonIp?: string;
}

export class BufferedAuditService implements AuditService {
  private readonly store: AuditStore;
  private readonly cfg: AuditConfig;
  private readonly counters: AuditCounters;
  private readonly stamp: StoreStamp;

  private readonly buffer: Array<AuditEvent & StoreStamp> = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticks = 0;
  /**
   * The in-flight tick, if any — a promise for the same reason `flushing` is.
   *
   * A pass slower than the interval must not start a second one alongside
   * itself, which a boolean also achieves. What a boolean cannot do is let
   * `stop()` WAIT for it: a tick reaching `flushStats`/`runSweep` has already
   * cleared the two handles those phases would have been joined by, so
   * shutdown sailed past and closed the store underneath a live statistics
   * write — losing the drained interval and logging "store unreachable"
   * during an orderly shutdown.
   */
  private tickInFlight: Promise<void> | null = null;
  /**
   * The in-flight event flush, if any — a PROMISE rather than a boolean.
   *
   * A boolean guard has to choose between two wrong behaviours: shared with
   * `ticking` it lets a busy node's constant drains starve the tick, so
   * aggregates and retention silently never fire; separate, it makes a
   * concurrent caller a silent no-op, and `stop()` then "flushes" nothing and
   * closes the store under an in-flight write, losing the whole buffer while
   * reporting no loss. Joining the existing promise is neither: a second
   * caller waits for the real result.
   */
  private flushing: Promise<void> | null = null;
  /** The in-flight aggregate write, for the same reason `flushing` is a
   *  promise: shutdown has to JOIN it, not race it. */
  private aggregating: Promise<void> | null = null;
  /** The in-flight statistics append. `takeStats` DETACHES the accumulator
   *  before the write, so a shutdown that races it finds nothing to write,
   *  exits reporting success, and drops the interval the parked write is
   *  about to hand back on failure. */
  private statting: Promise<void> | null = null;
  /** Set by `stop()`, so nothing new starts behind it. */
  private stopping = false;
  /** Rows currently detached from the buffer and on the wire. They are still
   *  LIVE — held in this process and not yet stored — so the ceiling and the
   *  shutdown accounting must both count them. Excluding them let the real
   *  occupancy reach `MAX_BUFFERED_EVENTS + eventBatchRows`. */
  private detached = 0;
  /** Memoized `stop()`. Two signals, or a signal beside an explicit stop,
   *  otherwise run the sequence twice — and one of them closes the store
   *  while the other is still doing its final flush. */
  private stopped: Promise<void> | null = null;
  /** The in-flight `start()`. Boot fires it and does not await it, so a
   *  SIGTERM arriving during the first `open()` would otherwise run shutdown
   *  alongside startup: two opens, two migrations, one close, and a timer
   *  installed after the process had already been told to leave. */
  private starting: Promise<void> | null = null;

  private available = false;
  private lastError: StoreError | undefined;
  private unavailableSince = 0;
  private unconfirmedWhileDown = 0;

  private readonly aggregateEvery: number;
  private readonly sweepEvery: number;

  constructor(opts: AuditServiceOptions) {
    this.store = opts.store;
    this.cfg = opts.config;
    this.counters = new AuditCounters({ maxRowsPerHour: this.cfg.maxRowsPerHour });
    this.stamp = {
      horizonNode: opts.horizonNode ?? horizonNodeId(),
      horizonIp: opts.horizonIp ?? horizonNodeIp(),
    };
    const tick = this.cfg.eventBatchSeconds;
    this.aggregateEvery = Math.max(1, Math.ceil(this.cfg.flushIntervalSeconds / tick));
    this.sweepEvery = Math.max(1, Math.ceil((this.cfg.postgres.sweepIntervalMinutes * 60) / tick));
    // Cadences are whole ticks, so anything that does not divide by
    // `eventBatchSeconds` is rounded UP. Rounding is the right behaviour —
    // one timer is worth more than exact periods — but doing it silently
    // leaves an operator reading a number from their own config that the
    // process is not using. Say what was configured and what will happen.
    const effective = (everyTicks: number): number => everyTicks * tick;
    const aggregateSeconds = effective(this.aggregateEvery);
    const sweepSeconds = effective(this.sweepEvery);
    if (aggregateSeconds !== this.cfg.flushIntervalSeconds
      || sweepSeconds !== this.cfg.postgres.sweepIntervalMinutes * 60) {
      logger.warn(
        {
          eventBatchSeconds: tick,
          flushIntervalSeconds: this.cfg.flushIntervalSeconds,
          effectiveFlushSeconds: aggregateSeconds,
          sweepIntervalMinutes: this.cfg.postgres.sweepIntervalMinutes,
          effectiveSweepSeconds: sweepSeconds,
        },
        'audit: a cadence is not a whole multiple of eventBatchSeconds and was rounded up — ' +
          'set them to multiples to get the periods you configured',
      );
    }
  }

  /**
   * Synchronous by contract: it appends to memory and returns.
   *
   * That is what makes "a database cannot delay a login" structural rather
   * than something a deadline has to keep achieving — the request path
   * performs no I/O at all.
   */
  recordEvent(event: Omit<AuditEvent, 'shape'>): void {
    // The canonical key when the emit site has one, the username otherwise.
    const principal = event.principalKey ?? event.username;
    if (!this.counters.admitEvent(event.kind, event.outcome, event.at, event.protocol, principal)) return;
    if (this.buffer.length + this.detached >= MAX_BUFFERED_EVENTS) {
      // Oldest first: during an outage the recent sign-ins are the ones an
      // operator is about to look for.
      this.buffer.shift();
      this.counters.countWriteUncertain(1, event.at);
    }
    // `principalKey` meters; it is never stored.
    const { principalKey: _key, ...row } = event;
    void _key;
    this.buffer.push({ ...row, shape: 'event', ...this.stamp });
    // Drain, but do NOT advance the tick counter: the row trigger is about
    // this buffer, and letting it move the counter would make aggregates and
    // retention fire on traffic volume rather than on time — a busy node
    // filling 50 rows a second would sweep every four minutes.
    if (this.buffer.length >= this.cfg.eventBatchRows && this.available && !this.stopping) {
      void this.drain().catch(() => undefined);
    }
  }

  countTokenUse(use: TokenUse): void {
    this.counters.countTokenUse(use);
  }

  async start(): Promise<void> {
    if (this.starting) return this.starting;
    this.starting = this.runStart().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async runStart(): Promise<void> {
    if (this.stopping) return;
    await this.tryOpen();
    // Re-checked after the await: shutdown may have been entered while the
    // store was opening, and a timer installed now would never be cleared.
    if (this.stopping) return;
    this.timer = setInterval(() => void this.tick(), this.cfg.eventBatchSeconds * 1000);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.stopped) return this.stopped;
    this.stopped = this.runStop();
    return this.stopped;
  }

  private async runStop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;

    // ONE clock over the WHOLE sequence — the joins, the drain and the close.
    // Bounding only the drain left three ways to hang past the deadline: the
    // join at the top, `pool.end()` at the bottom, and a startup still in
    // progress. A deadline that does not cover every await is not a deadline.
    let timedOut = false;
    await withDeadline(this.drainAndClose(), SHUTDOWN_DEADLINE_MS, () => { timedOut = true; });
    if (timedOut) {
      logger.warn(
        { deadlineMs: SHUTDOWN_DEADLINE_MS, buffered: this.buffer.length + this.detached },
        'audit: shutdown deadline reached — leaving records unwritten',
      );
      this.counters.countWriteUncertain(this.buffer.length + this.detached, Date.now());
      // The close is inside the deadline, so it did not run. Attempt it
      // without waiting: releasing the pool is worth trying, and `pool.end()`
      // on a hung socket is exactly the thing the deadline exists to escape.
      void this.store.close().catch(() => undefined);
    }
    this.available = false;
  }

  private async drainAndClose(): Promise<void> {
    // Boot fires `start()` without awaiting it, so shutdown can arrive while
    // the first open is still running. Join it before doing anything else, or
    // this runs concurrently with startup rather than after it.
    if (this.starting) await this.starting.catch(() => undefined);
    // Join whatever is already on the wire BEFORE starting the final pass.
    // Both handles, not just the event flush: an aggregate write still in
    // flight carries an OLDER cumulative count, and the store overwrites
    // blindly — so a shutdown write of 8 followed by a late write of 5 leaves
    // 5 stored while this process believes 8 was flushed, and the difference
    // is lost for good because nothing revisits the bucket.
    // The tick too, and not only the two write handles: a tick already inside
    // its statistics or sweep phase has released those, so joining them alone
    // let shutdown close the pool while the store was still being written.
    await Promise.allSettled([this.tickInFlight, this.flushing, this.aggregating, this.statting].filter(Boolean));

    await Promise.allSettled([this.tickInFlight, this.flushing, this.aggregating, this.statting].filter(Boolean));

    // A store that never opened is not a reason to discard the buffer — the
    // failure may have been transient and this is the last chance to write.
    if (!this.available) await this.tryOpen();

    // Drain to EMPTY rather than one bounded pass. The per-pass cap exists so
    // a tick cannot run forever; at shutdown there is no next tick, and
    // stopping after 20 batches would write 1 000 rows of a 10 000-row outage
    // backlog and drop the rest while reporting a graceful shutdown.
    for (let pass = 0; pass < SHUTDOWN_MAX_PASSES && this.buffer.length > 0; pass += 1) {
      const before = this.buffer.length;
      await this.flushEvents();
      if (this.buffer.length >= before) break; // making no progress; stop trying
    }
    await this.flushAggregates();
    await this.flushStats();
    await this.store.close();
  }

  async query(filter: AuditFilter): Promise<AuditPageResult> {
    return this.tracked(() => this.store.query(filter));
  }

  async queryStat(window: AuditStatWindow): Promise<AuditStatResult> {
    return this.tracked(() => this.store.queryStat(window));
  }

  /**
   * Read paths update health like write paths do.
   *
   * A read that fails is evidence about the store, and leaving `available`
   * cached from the last successful probe let the page report green while
   * every query threw — and, worse, flap back to green on the next probe if
   * the fault was one a shallow probe could not see.
   */
  private async tracked<T>(run: () => Promise<T>): Promise<T> {
    try {
      const out = await run();
      this.markAvailable();
      return out;
    } catch (err) {
      const code = codeOf(err);
      // A read that TIMED OUT says something about the query, not about the
      // store: a deep page or a wide range can exceed `statementTimeoutMs`
      // against a database that is answering everything else perfectly.
      // Marking the shared service unavailable on it let a reader stop
      // sign-ins being recorded — `available` also gates the row-threshold
      // flush — which is a reader taking down the writer. Reads still report
      // every other fault, because those ARE evidence about the store.
      if (code === 'timeout') throw err;
      this.markUnavailable(code);
      throw err;
    }
  }

  async health(): Promise<AuditHealth> {
    return {
      horizonNode: this.stamp.horizonNode,
      enabled: this.cfg.enabled,
      configured: this.cfg.provider !== 'none',
      available: this.available,
      error: this.lastError,
      rowsThisHour: this.counters.rowsAt(Date.now()),
      overBudgetThisHour: this.counters.overBudgetAt(Date.now()),
    };
  }


  /** Exposed for the tick-driven tests; the timer is the only caller in
   *  production. Non-overlapping, and never throws. */
  async tick(): Promise<void> {
    if (this.tickInFlight) return this.tickInFlight;
    this.tickInFlight = this.runTick().finally(() => {
      this.tickInFlight = null;
    });
    return this.tickInFlight;
  }

  private async runTick(): Promise<void> {
    // A tick that was merely SCHEDULED before `stop()` must not reopen a pool
    // shutdown is about to close.
    if (this.stopping) return;
    this.ticks += 1;
    if (!this.available) await this.tryOpen();
    if (!this.available) return;
    await this.flushEvents();
    if (this.ticks % this.aggregateEvery === 0) {
      await this.flushAggregates();
      await this.flushStats();
    }
    // Re-checked rather than hoisted: the sweep is the longest store call in
    // the feature, and `stop()` may have been entered during the phases above.
    if (this.ticks % this.sweepEvery === 0 && !this.stopping) await this.runSweep();
  }

  private async tryOpen(): Promise<void> {
    try {
      await this.store.open();
      const probe = await this.store.probe();
      if (probe.available) this.markAvailable();
      else this.markUnavailable(probe.error ?? 'unreachable');
    } catch (err) {
      this.markUnavailable(codeOf(err));
    }
  }

  /**
   * A failed batch stays buffered and goes again next tick, which can
   * DUPLICATE after a commit-then-timeout: event rows have no natural key to
   * upsert on. For an audit record that is the right direction to be wrong — a
   * duplicated sign-in is visible and harmless, a missing one is neither.
   */
  private async flushEvents(): Promise<void> {
    // Join rather than skip — see `flushing`.
    if (this.flushing) return this.flushing;
    this.flushing = this.writeBatches().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  private async writeBatches(): Promise<void> {
    // Several batches per pass, so a backlog left by an outage drains in
    // minutes rather than at one batch per tick — 50 rows every 15s would
    // take half an hour to clear 5 000. Bounded so a huge backlog cannot hold
    // the tick open indefinitely; the rest goes next pass.
    for (let i = 0; i < MAX_BATCHES_PER_PASS && this.buffer.length > 0; i += 1) {
      // Detach the batch BEFORE the await. Leaving it in place and splicing by
      // length afterwards discards by position, and the overflow `shift()` can
      // move every row left under the await — so the rows removed would not be
      // the rows written.
      const batch = this.buffer.splice(0, this.cfg.eventBatchRows);
      this.detached = batch.length;
      try {
        await this.store.writeEvents(batch);
        this.detached = 0;
        this.markAvailable();
      } catch (err) {
        this.detached = 0;
        // Put them back at the front so ordering survives the retry — but the
        // buffer may have refilled while this batch was detached, and the cap
        // is only enforced on the way IN. Returning the whole batch on top of
        // a full buffer put it over the bound; trim from the oldest end, the
        // same direction admission drops, so the ceiling holds.
        this.buffer.unshift(...batch);
        const over = this.buffer.length - MAX_BUFFERED_EVENTS;
        if (over > 0) {
          this.buffer.splice(0, over);
          this.counters.countWriteUncertain(over, Date.now());
        }
        this.markUnavailable(codeOf(err));
        return;
      }
    }
  }

  /** The row-count trigger. Event flush only: it must not touch the cadences
   *  the tick counter drives. */
  private async drain(): Promise<void> {
    await this.flushEvents();
  }

  private async flushAggregates(): Promise<void> {
    if (this.aggregating) return this.aggregating;
    this.aggregating = this.writeAggregates().finally(() => {
      this.aggregating = null;
    });
    return this.aggregating;
  }

  private async writeAggregates(): Promise<void> {
    const pending = this.counters.pendingAggregates();
    if (pending.length === 0) return;
    try {
      await this.store.writeAggregates(
        pending.map(({ key, ...row }) => {
          void key;
          return { ...row, shape: 'aggregate' as const, ...this.stamp };
        }),
      );
      // Only after the write commits, and at the counts that were WRITTEN —
      // uses that landed during the round trip must stay pending.
      this.counters.markFlushed(pending.map((p) => ({ key: p.key, count: p.count })));
      this.markAvailable();
    } catch (err) {
      this.markUnavailable(codeOf(err));
    }
  }

  private async flushStats(): Promise<void> {
    if (this.statting) return this.statting;
    this.statting = this.writeStats().finally(() => {
      this.statting = null;
    });
    return this.statting;
  }

  private async writeStats(): Promise<void> {
    const stats = this.counters.takeStats(this.stamp.horizonNode);
    if (stats.length === 0) return;
    const failed: AuditStat[] = [];
    for (const stat of stats) {
      try {
        await this.store.writeStat(stat);
      } catch (err) {
        // Every other write path reports; a bare catch here would leave health
        // green and the log silent while statistics stopped being written.
        this.markUnavailable(codeOf(err));
        failed.push(stat);
      }
    }
    // Fold failures back in so the next successful append carries both
    // intervals rather than losing the first.
    if (failed.length > 0) this.counters.restoreStats(failed);
  }

  private async runSweep(): Promise<void> {
    try {
      await this.store.sweep();
    } catch (err) {
      this.markUnavailable(codeOf(err));
    }
  }

  /**
   * Logged on STATE TRANSITION, not per failed write: a sustained outage would
   * otherwise emit one error per sign-in and bury the cause it is trying to
   * surface. One outage produces two lines and a number, whatever its length.
   */
  private markUnavailable(code: StoreError): void {
    this.lastError = code;
    this.available = false;
    // `unavailableSince`, not `available`, is the "already logged" flag. The
    // service starts unavailable, so keying off `available` would swallow the
    // first failure — and a store that never opened at boot is exactly the
    // case an operator must not have to discover from an admin page.
    if (this.unavailableSince !== 0) return;
    this.unavailableSince = Date.now();
    this.unconfirmedWhileDown = this.counters.unconfirmed;
    logger.error(
      { cause: code, provider: this.cfg.provider },
      'audit: store unreachable — sign-ins are not being recorded',
    );
  }

  private markAvailable(): void {
    this.lastError = undefined;
    if (this.available) return;
    this.available = true;
    if (this.unavailableSince !== 0) {
      logger.info(
        {
          downForMs: Date.now() - this.unavailableSince,
          rowsUnconfirmed: this.counters.unconfirmed - this.unconfirmedWhileDown,
          provider: this.cfg.provider,
        },
        'audit: store reachable again',
      );
      this.unavailableSince = 0;
    }
  }
}

/** Never the driver's message: an unclassified failure is `unreachable`. */
function codeOf(err: unknown): StoreError {
  return err instanceof AuditStoreError ? err.code : 'unreachable';
}

/** A service for a deployment that has the feature off. Every entry point is
 *  a no-op, so no call site needs to know whether auditing is configured. */
/**
 * The service a deployment gets when the feature is off — or when its
 * configuration was refused at boot.
 *
 * `problem` distinguishes those: without it a refused config reported
 * `configured: true, available: false`, which the page renders as "the store
 * cannot be reached" — sending an operator to check the network when the
 * actual fault is in their own YAML and is named in the boot log.
 */
export class DisabledAuditService implements AuditService {
  constructor(
    private readonly cfg: Pick<AuditConfig, 'enabled' | 'provider'>,
    private readonly problem?: string,
  ) {}
  recordEvent(): void {}
  countTokenUse(): void {}
  async query(): Promise<AuditPageResult> {
    return { rows: [], pageNum: 1, pageSize: 0, hasNext: false };
  }
  async queryStat(): Promise<AuditStatResult> {
    return { columns: [], overBudget: 0, horizonNodes: 0 };
  }
  async health(): Promise<AuditHealth> {
    return {
      horizonNode: '',
      enabled: this.cfg.enabled,
      // A refused configuration is NOT a configured one, whatever `provider`
      // says — nothing was ever wired up.
      configured: this.problem === undefined && this.cfg.provider !== 'none',
      available: false,
      configProblem: this.problem,
      rowsThisHour: 0,
      overBudgetThisHour: 0,
    };
  }
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
}

export { hourBucketOf };
