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
 * The login audit contracts. Two interfaces, split on one question: *would a
 * second backend have to reimplement this?*
 *
 *  - `AuditService` — one implementation, always. Owns the write budget, the
 *    event buffer, the token counting map, statistics accumulation and the
 *    single service timer. None of that is storage-specific.
 *
 * There is exactly ONE timer in the whole feature: the service tick, at
 * `eventBatchSeconds`. Every slower job is a modulus of its tick counter —
 * aggregates and statistics at `flushIntervalSeconds`, retention at
 * `sweepIntervalMinutes`, and `open()` retried while the store is down. The
 * store owns retention POLICY but no clock, so shutdown clears one handle.
 *  - `AuditStore` — one per backend. Rows, statistics, retention, health.
 *
 * The table is APPEND AND QUERY. There is no update path and no delete: rows
 * arrive from the sign-in paths and leave only when retention expires them.
 * The two mechanical exceptions are an aggregate's cumulative count being
 * upserted for its own hour, and the retention sweep.
 *
 * `store/` is a sibling of `client/` because a database is a separate I/O
 * boundary and `client/` stays the only layer that talks to OAP.
 *
 * THE RULE THAT SHAPES EVERYTHING HERE: only what a VALID credential produced
 * is recorded. Successes, plus the two refusals reachable only *after*
 * authentication succeeded. Everything an anonymous caller can trigger is an
 * application-log line, which is what keeps this table unreachable by someone
 * holding no credential — Horizon can face the internet and adds no rate
 * limit. The consequence runs through every type below: `username` is always
 * a verified principal, and there is no shape that can express an attempt.
 */

import type { PageResult } from '../../logic/paging/read-page.js';
import type { TokenUse } from './token-counters.js';
import type { TokenUsageRange, TokenUsageResult } from './token-usage.js';

export type AuditKind =
  | 'local'
  | 'ldap'
  | 'break-glass'
  | 'sso';

export const AUDIT_KINDS: readonly AuditKind[] = [
  'local',
  'ldap',
  'break-glass',
  'sso',
];

/** The only reasons that reach a ROW. Both are refusals a caller can reach
 *  ONLY by first proving a credential, which is why they are recordable while
 *  the rest of the failure vocabulary is not. The broader internal union —
 *  and the one bridge into this one — is `user/outcome.ts`, which lives with
 *  authentication because that is whose vocabulary it is. */
export type AuditReason = 'no_roles' | 'zero_group_mappings';

/** Common to both row shapes. Every field is already verified: there is no
 *  "attempt" shape, because an attempt never becomes a row. */
export interface AuditFields {
  /** epoch ms, UTC. */
  at: number;
  kind: AuditKind;
  /** The verified principal — never null, never caller-supplied text: the
   *  login name, or the verified email address on the SSO path. */
  username: string;
  /** SSO only as the code stands — local users have no email field and the
   *  LDAP path requests no mail attribute. */
  mail?: string;
  provider?: string;
  /** What the sign-in GRANTED, comma-separated. Recorded rather than
   *  re-derived: a role table changes, and the question is what this person
   *  was given at this moment. */
  roles?: string;
  /**
   * A CANONICAL identity for this principal, used only to meter the hourly
   * per-principal share — never stored.
   *
   * `username` is whatever the directory or the caller spelled, and a
   * case-insensitive backend accepts `alice`, `Alice` and `ALICE` for one
   * account. Metering on that lets a single authenticated user take a share
   * per spelling and spend the whole node's allowance, which is exactly the
   * starvation the share exists to prevent. LDAP supplies the DN; everything
   * else falls back to the lowercased username.
   */
  principalKey?: string;
  /**
   * Which SSO protocol proved this identity — verifying a signed ID token and
   * reading an address from a userinfo call are different assurances, so the
   * chart draws them as separate series and the list names them apart.
   */
  protocol?: 'oidc' | 'oauth2';
}

/** One sign-in outcome, written as it happens. */
export interface AuditEvent extends AuditFields {
  shape: 'event';
  outcome: 0 | 1;
  /** Present if and only if `outcome === 0`. */
  reason?: AuditReason;
  clientIp?: string;
}

/** What the service stamps on every row. The store never invents identity. */
export interface StoreStamp {
  /** `<hostname>:<boot-id>` — one Horizon PROCESS. Not an OAP node, not a
   *  k8s node: a restart opens a new one, which is what keeps two replicas
   *  on one host distinguishable in the statistics. */
  horizonNode: string;
  /** Best effort, and a hint rather than an identifier. */
  horizonIp?: string;
}

/** A row as READ BACK. One shape: every row is a single sign-in. */
export interface AuditEntry extends AuditFields, StoreStamp {
  /** Opaque and monotonic. A STRING: Postgres hands `bigint` back as text
   *  because it exceeds `Number.MAX_SAFE_INTEGER`, and narrowing it to a
   *  number here would be a silent precision bug for the sake of a type. */
  id: string;
  outcome: 0 | 1;
  reason?: AuditReason;
  clientIp?: string;
}

/** A page of audit rows. Exactly `PageResult`, which every other paged screen
 *  returns — the audit has nothing of its own to add to it. */
export type AuditPageResult = PageResult<AuditEntry>;

/**
 * Time range, how someone signed in, and who. Deliberately nothing else: a
 * filter set that mirrors every column turns a page an operator reads into a
 * query builder, and each extra predicate is an index to carry and a way to
 * ask the database something expensive.
 */
export interface AuditFilter {
  /** epoch ms; `from` inclusive, `to` exclusive. */
  from?: number;
  to?: number;
  kind?: AuditKind[];
  /**
   * EXACT match on the verified principal.
   *
   * Not a prefix and not a substring. A prefix made the result depend on how
   * much of a name was typed, and it could not be reproduced on a store whose
   * operator set has none — which would have left one control meaning two
   * different things depending on the backend behind it.
   *
   * Who a credential belongs to is NOT recorded here: that is a fact about
   * configuration, which the tokens file already holds, not a fact about a
   * sign-in.
   */
  username?: string;
  /**
   * 1-based. With `pageSize` it IS the position: a store skips
   * `pageSize * (pageNum - 1)` rows of the newest-first ordering.
   *
   * The same arrangement OAP uses for every list it serves — traces, logs,
   * alarms, events — down to the formula, so one page-shaped question is
   * asked one way across the product regardless of which backend answers it.
   */
  pageNum: number;
  pageSize: number;
}

/** Hourly buckets, so 2 | 6 | 12 columns. */
export type AuditStatWindow = 2 | 6 | 12;

export const AUDIT_STAT_WINDOWS: readonly AuditStatWindow[] = [2, 6, 12];
export const DEFAULT_AUDIT_STAT_WINDOW: AuditStatWindow = 6;

/** One counter per series the page colours by. Every `login` member counts
 *  ACCEPTED rows only; a policy-refused sign-in lands in `rejected` and not
 *  in its kind, or a column total would exceed the rows in its hour. */
export interface AuditLoginCounts {
  local: number;
  ldap: number;
  oidc: number;
  oauth: number;
}

/**
 * One process's RUNNING TOTAL for an hour, keyed on `(hourBucket,
 * horizonNode)` and replaced in place.
 *
 * Cumulative rather than a per-interval delta, and that is what makes a write
 * idempotent: sending the same hour again means the same figure grown, so a
 * flush repeated after an uncertain outcome leaves the same number instead of
 * counting twice. It also self-heals — the first write after an outage carries
 * the whole hour, so the intervals that could not be written are not lost.
 *
 * The hour's real total is the SUM across nodes. `horizonNode` carries a
 * per-process id, so a restart counts under a new identity while its
 * predecessor's figure stays where it is and still counts; two processes can
 * never collide on one row.
 */
export interface AuditStat {
  hourBucket: number;
  horizonNode: string;
  login: AuditLoginCounts;
  /** `outcome = 0`, any kind. */
  rejected: number;
  /** Refused by `maxRowsPerHour` — rows never written. */
  overBudget: number;
}

export interface AuditStatColumn {
  hourBucket: number;
  login: AuditLoginCounts;
  rejected: number;
}

export interface AuditStatResult {
  /** Oldest first, one per hour in the window. */
  columns: AuditStatColumn[];
  /** Not stacked into the columns — sign-in rows the hourly budget refused, so
   *  drawing them beside rows that WERE written would misread as volume. Token
   *  use is not budgeted and never appears here. */
  overBudget: number;
  /** Distinct hosts that contributed. An estimate: `horizonNode` carries a
   *  boot id, so counting those would count process incarnations — 40 after a
   *  crash loop of two replicas. */
  horizonNodes: number;
}

/** Sanitized, fixed vocabulary. NEVER the driver's string, which can carry
 *  the DSN — host, database, and depending on the failure the user. */
export type StoreError = 'unreachable' | 'auth_failed' | 'timeout' | 'schema_error' | 'too_large';

/**
 * What a store throws. Carries a code and nothing else — deliberately NOT the
 * driver error as `cause`, because a `pg` error can hold the connection string
 * and pino serializes a cause all the way down. The raw error is logged at
 * debug inside the store, where it cannot escape into a reply or a shipped log
 * line.
 */
export class AuditStoreError extends Error {
  constructor(readonly code: StoreError) {
    super(`audit store: ${code}`);
    this.name = 'AuditStoreError';
  }
}

/**
 * Health for ONE process. A multi-replica deployment has as many answers as
 * replicas, so the page says which one it is showing rather than presenting
 * it as cluster state.
 *
 * Every counter here is best-effort and resets with the process.
 */
export interface AuditHealth {
  horizonNode: string;
  /** `audit.enabled`. */
  enabled: boolean;
  /** A provider other than `none` is selected AND its configuration was
   *  usable. Distinct from `enabled` because the UI writes a different
   *  sentence for each. */
  configured: boolean;
  available: boolean;
  /** Why the store could not be reached. Sanitized vocabulary — never the
   *  driver's string, which can carry the DSN. */
  error?: StoreError;
  /** Set when the configuration itself was refused at boot: a different
   *  problem from an unreachable store, and a different thing to go and fix. */
  configProblem?: string;
  /** This hour, on THIS process, counting ROWS rather than logins:
   *  `rowsThisHour + overBudgetThisHour` is everything it would have written. */
  rowsThisHour: number;
  overBudgetThisHour: number;
}


/**
 * What the rest of the BFF talks to.
 */
export interface AuditService {
  /**
   * Buffer one sign-in outcome. SYNCHRONOUS, and it never throws: it appends
   * to memory and returns.
   *
   * That is the whole reason a database cannot delay a login — the request
   * path performs no I/O at all, rather than performing I/O under a deadline.
   * A writer flushes at `eventBatchRows` or `eventBatchSeconds`, whichever
   * comes first, so a crash costs one batch window. A batch the store refuses
   * is DROPPED rather than re-queued, so nothing accumulates while it is
   * unreachable and there is no outage backlog to lose — those sign-ins are
   * counted as unconfirmed instead. The batch settings bound both cases.
   */
  recordEvent(event: Omit<AuditEvent, 'shape'>): void;

  /**
   * One token use, for the SEPARATE statistic — not an audit row.
   *
   * Presenting a token is not a login, so it records no sign-in. Synchronous
   * and non-throwing like `recordEvent`, for the same reason: the request
   * path performs no I/O.
   */
  countTokenUse(use: TokenUse): void;

  queryTokenUsage(range: TokenUsageRange): Promise<TokenUsageResult>;

  query(filter: AuditFilter): Promise<AuditPageResult>;
  queryStat(window: AuditStatWindow): Promise<AuditStatResult>;
  health(): Promise<AuditHealth>;

  start(): Promise<void>;
  /** Flush once, then close — after the HTTP server stops accepting. */
  stop(): Promise<void>;
}

/**
 * What a backend implements. Storage only — no timers, no budget, no map.
 */
export interface AuditStore {
  /** One batch of collected sign-in rows, as a single multi-row statement.
   *  Nothing is waiting on it — it runs on the writer's tick, never on a
   *  request. A batch that throws is not re-sent, so a commit-then-timeout
   *  leaves the rows stored and counted as unconfirmed rather than duplicated
   *  by a retry. */
  writeEvents(rows: ReadonlyArray<AuditEvent & StoreStamp>): Promise<void>;
  /** Stores one process's running total for an hour, replacing whatever it
   *  had for `(hourBucket, horizonNode)`. Idempotent: writing the same figure
   *  twice must leave the same row. */
  writeStat(stat: AuditStat): Promise<void>;

  query(filter: AuditFilter): Promise<AuditPageResult>;
  queryStat(window: AuditStatWindow): Promise<AuditStatResult>;

  /**
   * Expire whatever is past the configured retention; returns rows removed.
   *
   * Driven by the service tick: the backend owns what expiry MEANS — a
   * `DELETE` here, a native TTL elsewhere — but not a clock of its own. A
   * store with engine-side expiry declares it at schema setup and returns 0
   * rather than starting a timer to do nothing.
   */
  sweep(): Promise<number>;

  /**
   * Is the store usable — and, separately, does this probe PROVE a write
   * would land?
   *
   * The two are not the same and the difference is load-bearing. Postgres can
   * run the writer's own statement inside a transaction and roll it back, so
   * a pass there genuinely vouches for the write path (`writable: true`).
   * BanyanDB has no rollback, so the strongest thing it can check without
   * recording a sign-in nobody made is that the schema a write needs is
   * present and correct — reachability, not writability (`writable: false`).
   *
   * A caller must not clear a WRITE fault on a probe that does not claim
   * `writable`: doing so reports a healthy store on the evidence that its
   * registry answered, while the writes that actually failed are still
   * failing.
   */
  probe(): Promise<{ available: boolean; writable: boolean; error?: StoreError }>;

  /** Idempotent — returns immediately if already open, because the service
   *  tick retries it while the store is unavailable. Owning no timer is what
   *  keeps that safe: a re-entered `open()` can only rebuild a pool. */
  open(): Promise<void>;
  /** Safe to call after a failed `open()`. */
  close(): Promise<void>;
}
