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
 * The hour-scoped accounting behind the audit log: the write budget, the token
 * usage buckets, and the statistics deltas.
 *
 * Pure and synchronous — no timers, no store, no clock of its own (every entry
 * point takes `at`). That is deliberate: this is where all the arithmetic that
 * is easy to get quietly wrong lives, so it is the part that must be testable
 * without standing anything up.
 */

import type {
  AuditAggregate,
  AuditKind,
  AuditLoginCounts,
  AuditStat,
  TokenUse,
} from './types.js';

/** Hour buckets retained in memory. Eviction is oldest-first, so a sustained
 *  outage degrades to "recent hours are right, older ones were dropped"
 *  rather than to an OOM. */
export const MAX_HOUR_BUCKETS = 3;
/** Total token buckets. Past this, NEW keys are refused and existing ones keep
 *  counting — losing a new principal's first use beats losing everyone's. */
export const MAX_ENTRIES = 10_000;
export const MAX_ENTRY_AGE_MS = 6 * 60 * 60 * 1000;

/**
 * `yyyyMMddHH` in **UTC** — SkyWalking's own time-bucket shape, so this table
 * reads the same as OAP's beside it.
 *
 * UTC rather than the OAP server's local zone, which is what the rest of
 * Horizon's time handling uses: nothing here is an OAP query, and a bucket
 * that shifts with a remote server's offset would be unreadable across a
 * fleet.
 */
export function hourBucketOf(at: number): number {
  const d = new Date(at);
  return (
    d.getUTCFullYear() * 1_000_000 +
    (d.getUTCMonth() + 1) * 10_000 +
    d.getUTCDate() * 100 +
    d.getUTCHours()
  );
}

/** Start of the hour a bucket names, as epoch ms. */
export function hourBucketStart(bucket: number): number {
  const hour = bucket % 100;
  const day = Math.floor(bucket / 100) % 100;
  const month = Math.floor(bucket / 10_000) % 100;
  const year = Math.floor(bucket / 1_000_000);
  return Date.UTC(year, month - 1, day, hour);
}

interface Bucket {
  kind: 'api-token' | 'oauth-token';
  username: string;
  hourBucket: number;
  /** Running total since this process started counting this key. NEVER reset
   *  by a flush — that is what makes a retry idempotent. */
  count: number;
  /** `count` as of the last flush that committed. The gap between the two is
   *  what an eviction actually loses. */
  flushed: number;
  lastAt: number;
}

function emptyLogin(): AuditLoginCounts {
  return { local: 0, ldap: 0, oidc: 0, oauth: 0, token: 0 };
}

interface StatAccum {
  login: AuditLoginCounts;
  rejected: number;
  overBudget: number;
}

function emptyStat(): StatAccum {
  return { login: emptyLogin(), rejected: 0, overBudget: 0 };
}

function isEmpty(s: StatAccum): boolean {
  const l = s.login;
  return (
    l.local === 0 && l.ldap === 0 && l.oidc === 0 && l.oauth === 0 &&
    l.token === 0 && s.rejected === 0 && s.overBudget === 0
  );
}

export interface CountersOptions {
  maxRowsPerHour: number;
}

export class AuditCounters {
  private readonly buckets = new Map<string, Bucket>();
  /** Hours present in `buckets`, maintained incrementally so the hot path can
   *  ask "is this hour new?" without scanning. */
  private readonly hours = new Set<number>();
  /** The hour a cap-triggered eviction was last attempted in, so a
   *  permanently full map does not rescan on every refused key. */
  private capEvictHour = 0;
  private readonly stats = new Map<number, StatAccum>();

  /** The hour the budget below applies to. */
  private budgetHour = 0;
  private rowsThisHour = 0;
  /** Rows each principal has spent this hour. */
  private readonly perPrincipal = new Map<string, number>();
  private overBudgetThisHour = 0;
  private droppedSinceStart = 0;

  constructor(private readonly opts: CountersOptions) {}

  get bufferedEntries(): number {
    return this.buckets.size;
  }

  get dropped(): number {
    return this.droppedSinceStart;
  }

  /** Both take `now` and roll the window first: the reset lives in the write
   *  path, so a node that has recorded nothing since the hour turned would
   *  otherwise report the PREVIOUS hour's totals as the current ones — and an
   *  operator would read a spent budget that has in fact been empty for
   *  fifty minutes. */
  rowsAt(now: number): number {
    this.rollTo(hourBucketOf(now));
    return this.rowsThisHour;
  }

  overBudgetAt(now: number): number {
    this.rollTo(hourBucketOf(now));
    return this.overBudgetThisHour;
  }

  /**
   * Reserve one row against this hour's budget.
   *
   * The budget counts ROWS THIS NODE ADDS TO THE TABLE, because that is the
   * only thing it protects. An event row costs 1; a token key first seen this
   * hour costs 1 (the row it will create); re-flushing a key already counted
   * costs 0, since the upsert updates a row that is already paid for.
   *
   * Charging per write instead would spend the budget on rows that already
   * exist — at a 60s flush that is 60 writes per principal per hour, and ~17
   * active principals would exhaust the default 1000 on a healthy system.
   */
  private reserveRow(at: number, principal: string): boolean {
    // FORWARD only. A bare inequality would let one late-arriving row from a
    // previous hour re-arm the whole budget, which turns the cap into a
    // suggestion: alternate two hours and it never fills. A row for an older
    // hour still costs a row, so it is charged against the current window.
    const hour = hourBucketOf(at);
    this.rollTo(hour);

    // A PER-PRINCIPAL share first, so one account cannot spend the whole
    // hour's allowance and blind everyone else. The budget is a single
    // process-wide counter, and without this a valid low-privilege user
    // repeating their own login enough times exhausts it — after which the
    // admin and SSO sign-ins that an audit log exists to capture are the ones
    // dropped, and `over_budget` records only that something was lost, never
    // whose. Refusing the noisy principal costs that principal repetition
    // nobody needed; refusing everyone costs the record its purpose.
    const share = this.principalShare;
    // The key is taken AS GIVEN. Case-folding here looked like a cheap defence
    // against spelling variants, but it is wrong in the other direction:
    // `auth.local.users` is a case-SENSITIVE list, so `Alice` and `alice` are
    // two accounts and folding them made one able to spend the other's share.
    // Canonicalisation belongs to the backend that knows what canonical means
    // — the emit site supplies `principalKey`.
    const used = this.perPrincipal.get(principal) ?? 0;
    if (used >= share) {
      this.overBudgetThisHour += 1;
      this.stat(hour).overBudget += 1;
      return false;
    }

    if (this.rowsThisHour >= this.opts.maxRowsPerHour) {
      this.overBudgetThisHour += 1;
      this.stat(hour).overBudget += 1;
      return false;
    }
    this.perPrincipal.set(principal, used + 1);
    this.rowsThisHour += 1;
    return true;
  }

  /** A tenth of the hour's rows, and never less than 20 — enough that a real
   *  person signing in repeatedly is never refused, small enough that ten
   *  noisy principals cannot between them spend the whole allowance. */
  private get principalShare(): number {
    return Math.max(20, Math.floor(this.opts.maxRowsPerHour / 10));
  }

  /**
   * The accumulator for one hour, creating it if needed.
   *
   * Eviction runs BEFORE the insert and never considers the key being
   * created. Evicting afterwards could delete the very entry just added — for
   * an hour older than the three retained — and hand the caller a detached
   * object, so every `+=` against it would land on garbage and never be
   * persisted. That is precisely how eviction's own `tokenLost` went missing.
   */
  /** Advance the budget window if `hour` is newer. Idempotent, and safe to
   *  call from a read — which is what keeps `health()` honest between writes. */
  rollTo(hour: number): void {
    if (hour <= this.budgetHour) return;
    this.budgetHour = hour;
    this.rowsThisHour = 0;
    this.overBudgetThisHour = 0;
    // Bounded by the real user count, because only verified principals reach
    // here — and cleared every hour regardless.
    this.perPrincipal.clear();
  }

  private stat(hourBucket: number): StatAccum {
    const existing = this.stats.get(hourBucket);
    if (existing) return existing;
    this.evictStats(hourBucket);
    const fresh = emptyStat();
    this.stats.set(hourBucket, fresh);
    return fresh;
  }

  /** Ask whether one sign-in row may be written, and record it in statistics.
   *  Returns false when the budget refused it, in which case the caller drops
   *  the row rather than buffering it. */
  admitEvent(
    kind: AuditKind,
    outcome: 0 | 1,
    at: number,
    protocol?: 'oidc' | 'oauth2',
    principal = '',
  ): boolean {
    if (!this.reserveRow(at, principal)) return false;
    const s = this.stat(hourBucketOf(at));
    if (outcome === 0) {
      s.rejected += 1;
      return true;
    }
    // `login_*` counts ACCEPTED rows only. A policy-refused sign-in lands in
    // `rejected` and NOT in its kind — it is what happened instead of a
    // sign-in, and counting it twice would let a column total exceed the rows
    // in its hour.
    switch (kind) {
      case 'local': s.login.local += 1; break;
      case 'ldap': s.login.ldap += 1; break;
      // Break-glass IS a password sign-in, with the local account the
      // directory outage left as the only way in. The row records
      // `break-glass`; the chart counts it where it belongs.
      case 'break-glass': s.login.local += 1; break;
      case 'api-token': case 'oauth-token': s.login.token += 1; break;
      // One `kind`, two series: verifying a signed ID token and reading an
      // address from a userinfo call are different assurances, so the caller
      // passes the protocol rather than leaving `sso` uncounted.
      case 'sso': if (protocol === 'oauth2') s.login.oauth += 1; else s.login.oidc += 1; break;
    }
    return true;
  }

  /** Count one accepted token use. Refused tokens never reach here. */
  countTokenUse(use: TokenUse): void {
    const hourBucket = hourBucketOf(use.at);
    const key = `${hourBucket}|${use.kind}|${use.username}`;
    const existing = this.buckets.get(key);
    if (existing) {
      existing.count += 1;
      existing.lastAt = use.at;
      this.stat(hourBucket).login.token += 1;
      return;
    }
    // Reclaim BEFORE testing the cap — evicting only after a successful
    // insert wedges the map permanently, because at the cap the insert never
    // happens and the eviction that would free space never runs.
    //
    // But NOT on every use. `countTokenUse` runs on every authenticated
    // request, and a scan of the whole map here makes that O(map): filling
    // 10 000 keys becomes 50M comparisons, which is a real cost on a busy
    // node and not merely a slow test. Eviction can only ever free something
    // when a new HOUR appears or when the map is actually full, so those are
    // the only two triggers — and the second is attempted once per hour, or a
    // permanently full map would scan on every refused key.
    const newHour = !this.hours.has(hourBucket);
    const atCap = this.buckets.size >= MAX_ENTRIES;
    if (newHour || (atCap && this.capEvictHour !== hourBucket)) {
      if (atCap) this.capEvictHour = hourBucket;
      this.evictBuckets(use.at, hourBucket);
    }
    if (this.buckets.size >= MAX_ENTRIES) {
      // Refused for MEMORY, so it costs no budget — the row it would have
      // created will never exist. Reserving first would let token churn eat
      // the sign-in budget while producing nothing.
      this.droppedSinceStart += 1;
      return;
    }
    // A new key is a new row, so it spends one. A key rejected on budget never
    // reaches the map, so `over_budget` and `token_lost` cannot both count it.
    if (!this.reserveRow(use.at, use.username)) return;
    this.buckets.set(key, {
      kind: use.kind,
      username: use.username,
      hourBucket,
      count: 1,
      flushed: 0,
      lastAt: use.at,
    });
    this.hours.add(hourBucket);
    this.stat(hourBucket).login.token += 1;
  }

  /** Buckets with uses not yet written. A bucket whose `count` equals its
   *  `flushed` has nothing to say and is skipped rather than re-upserted. */
  pendingAggregates(): Array<Omit<AuditAggregate, 'shape'> & { key: string }> {
    const out: Array<Omit<AuditAggregate, 'shape'> & { key: string }> = [];
    for (const [key, b] of this.buckets) {
      if (b.count === b.flushed) continue;
      out.push({
        key,
        kind: b.kind,
        username: b.username,
        hourBucket: b.hourBucket,
        // The bucket start, not the last use: an aggregate names an hour.
        at: hourBucketStart(b.hourBucket),
        count: b.count,
      });
    }
    return out;
  }

  /**
   * Record that a flush committed, at the counts that were ACTUALLY WRITTEN.
   *
   * Re-reading `b.count` here instead would silently lose every use that
   * arrived during the write: `pendingAggregates` freezes the count by value,
   * the store round trip yields the event loop, and `countTokenUse` keeps
   * incrementing. Marking the live total flushed would tell the bucket that
   * uses it never sent are safely stored — and at an hour boundary the key is
   * never revisited, so the loss is permanent and recurs on the last flush of
   * every hour.
   *
   * `Math.max` because an out-of-order retry must never move `flushed` back.
   */
  markFlushed(written: ReadonlyArray<{ key: string; count: number }>): void {
    for (const { key, count } of written) {
      const b = this.buckets.get(key);
      if (b) b.flushed = Math.max(b.flushed, count);
    }
  }

  /** Statistics deltas ready to append, and the accumulators are reset — stat
   *  rows are per-interval deltas, not running totals (they are summed on
   *  read, and a node's identity is not part of their key). */
  takeStats(horizonNode: string): AuditStat[] {
    const out: AuditStat[] = [];
    for (const [hourBucket, s] of this.stats) {
      if (isEmpty(s)) continue;
      out.push({
        hourBucket,
        horizonNode,
        login: { ...s.login },
        rejected: s.rejected,
        overBudget: s.overBudget,
      });
      this.stats.set(hourBucket, emptyStat());
    }
    return out;
  }

  /** Put deltas back after a failed append, so the next successful one carries
   *  both intervals rather than losing the first. */
  restoreStats(stats: readonly AuditStat[]): void {
    for (const st of stats) {
      const s = this.stat(st.hourBucket);
      s.login.local += st.login.local;
      s.login.ldap += st.login.ldap;
      s.login.oidc += st.login.oidc;
      s.login.oauth += st.login.oauth;
      s.login.token += st.login.token;
      s.rejected += st.rejected;
      s.overBudget += st.overBudget;
    }
  }

  /** Records that some rows were not written. Kept as a process counter
   *  rather than a stat column: the table carries the counters that were
   *  asked for, and this one is diagnostic. */
  countWriteUncertain(rows: number, _at: number): void {
    this.droppedSinceStart += rows;
  }

  /**
   * Age and count bounds.
   *
   * EVICTION IS NOT LOSS. Counts are cumulative and a flush does not clear
   * them, so a bucket whose running total was last written at 412 and is
   * evicted at 412 lost nothing. Reporting every routine hour-rollover as a
   * drop would put a permanently climbing number in front of an operator
   * whose system is working perfectly. Only `count - flushed` is lost.
   */
  private evictBuckets(now: number, incoming: number): void {
    // `incoming` is about to be inserted, so it counts toward the retained
    // hours and is never itself a candidate — eviction runs BEFORE the insert
    // (so a full map can recover), which would otherwise let the map hold one
    // hour more than the bound.
    const hours = [...new Set([...this.buckets.values()].map((b) => b.hourBucket).concat(incoming))]
      .sort((a, b) => a - b);
    const doomed = new Set(hours.slice(0, Math.max(0, hours.length - MAX_HOUR_BUCKETS)));
    doomed.delete(incoming);
    for (const [key, b] of this.buckets) {
      const tooOld = now - b.lastAt > MAX_ENTRY_AGE_MS;
      if (!doomed.has(b.hourBucket) && !tooOld) continue;
      const lost = b.count - b.flushed;
      if (lost > 0) {
        this.droppedSinceStart += lost;
      }
      this.buckets.delete(key);
    }
    this.hours.clear();
    for (const b of this.buckets.values()) this.hours.add(b.hourBucket);
  }

  /** `incoming` is about to be added and is never a candidate. */
  private evictStats(incoming: number): void {
    const hours = [...this.stats.keys(), incoming].sort((a, b) => a - b);
    for (const h of hours.slice(0, Math.max(0, hours.length - MAX_HOUR_BUCKETS))) {
      if (h !== incoming) this.stats.delete(h);
    }
  }
}
