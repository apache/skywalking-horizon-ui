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

export type AuditKind =
  | 'local'
  | 'ldap'
  | 'break-glass'
  | 'sso'
  | 'api-token'
  | 'oauth-token';

export const AUDIT_KINDS: readonly AuditKind[] = [
  'local',
  'ldap',
  'break-glass',
  'sso',
  'api-token',
  'oauth-token',
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
  /** The verified principal — never null, never caller-supplied text.
   *  Login kinds hold the login name or verified email; `api-token` holds the
   *  token id; `oauth-token` holds the `sub`. */
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

/**
 * One flushed token bucket. No outcome: a refused token produces no
 * aggregate, so this shape is accepted by construction.
 *
 * `username` is the token id for `api-token` and the **`sub`** for
 * `oauth-token` — never the `jti`. A `jti` names one issuance and is minted
 * fresh on every access-token call, so keying on it would make aggregate rows
 * grow with request volume rather than with the user count.
 */
export interface AuditAggregate extends AuditFields {
  shape: 'aggregate';
  kind: 'api-token' | 'oauth-token';
  /** yyyyMMddHH, UTC. */
  hourBucket: number;
  /** CUMULATIVE since this process started — never a delta. A flush writes
   *  the running total and does not clear it, so a retry after a
   *  commit-then-timeout overwrites with the same number. */
  count: number;
}

export type NewAuditEntry = AuditEvent | AuditAggregate;

/** What the service stamps on every row. The store never invents identity. */
export interface StoreStamp {
  /** `<hostname>:<boot-id>` — one Horizon PROCESS. Not an OAP node, not a
   *  k8s node: a restart opens a new one, so replicas never collide on a
   *  cumulative count. */
  horizonNode: string;
  /** Best effort, and a hint rather than an identifier. */
  horizonIp?: string;
}

/**
 * A row as READ BACK — flat rather than discriminated, because a reader is
 * looking at storage, where both shapes share one table and `hourBucket` is
 * what tells them apart.
 */
export interface AuditEntry extends AuditFields, StoreStamp {
  /** Opaque and monotonic. A STRING: Postgres hands `bigint` back as text
   *  because it exceeds `Number.MAX_SAFE_INTEGER`, and narrowing it to a
   *  number here would be a silent precision bug for the sake of a type. */
  id: string;
  outcome: 0 | 1;
  reason?: AuditReason;
  clientIp?: string;
  /** Present if and only if this is an aggregate row. */
  hourBucket?: number;
  /** 1 on an event row. */
  count: number;
}

/** One accepted token use, counted in memory. Refused tokens never reach here. */
export interface TokenUse {
  kind: 'api-token' | 'oauth-token';
  /** The token id, or the `sub`. */
  username: string;
  at: number;
}

/**
 * Time range, how someone signed in, and who. Deliberately nothing else: a
 * filter set that mirrors every column turns a page an operator reads into a
 * query builder, and each extra predicate is an index to carry and a way to
 * ask the database something expensive.
 */
/** A position in the `(at DESC, id DESC)` ordering. `id` is a bigint, carried
 *  as a string because it does not fit a JS number. */
export interface AuditCursor {
  at: number;
  id: string;
}

/** A page of audit rows, plus where to resume. `PageResult` is shared with
 *  every other paged screen, so the cursor rides alongside rather than in it. */
export interface AuditPageResult extends PageResult<AuditEntry> {
  /** The position to pass as the next request's `cursor`. Absent on the last
   *  page — its presence IS `hasNext`. */
  nextCursor?: AuditCursor;
}

export interface AuditFilter {
  /** epoch ms; `from` inclusive, `to` exclusive. */
  from?: number;
  to?: number;
  kind?: AuditKind[];
  /** PREFIX match. Not a substring: a leading wildcard is an unindexed scan
   *  and a fishing tool, while a prefix is index-served and is what makes the
   *  token kinds reachable — nobody types an opaque token id from memory.
   *
   *  Who a credential belongs to is NOT recorded here: that is a fact about
   *  configuration, which the tokens file already holds, not a fact about a
   *  sign-in. */
  username?: string;
  /**
   * Where the previous page stopped: `(at, id)` of its last row.
   *
   * Keyset, not OFFSET. An audit table is append-heavy at exactly the end the
   * page reads from, so an offset counts a moving target: rows written between
   * two page requests shift everything down, and the reader sees a record
   * twice or never. `(at, id)` names a POSITION, so what arrives after it
   * changes nothing about where page two begins.
   */
  cursor?: AuditCursor;
  /** 1-based, and display-only now that paging is keyset — it labels the page
   *  and no longer computes an offset. */
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
  /** Token USES — the sum of aggregate counts, not a row count. One row can
   *  represent ten thousand uses. */
  token: number;
}

/**
 * One interval's DELTA, appended rather than upserted.
 *
 * Deliberately not keyed on `(hourBucket, horizonNode)`: `horizonNode` is
 * best-effort attribution, and when it degrades to a shared value — every pod
 * reporting the same host — a composite key makes two nodes collide and
 * silently overwrite each other's counts. Appending instead means a duplicate
 * node name costs attribution and never a count. The trade is that a retried
 * insert may double-count, which is acceptable: statistics here are
 * best-effort per node, and the sign-in table holds the rows themselves —
 * a stored record rather than a counter, aside from the duplicate a
 * commit-then-timeout retry can leave behind.
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
  /** Not stacked into the columns — these count rows and uses that were never
   *  written, so drawing them beside rows that were would misread as volume. */
  overBudget: number;
  /** Distinct hosts that contributed. An estimate: `horizonNode` carries a
   *  boot id, so counting those would count process incarnations — 40 after a
   *  crash loop of two replicas. */
  horizonNodes: number;
}

/** Sanitized, fixed vocabulary. NEVER the driver's string, which can carry
 *  the DSN — host, database, and depending on the failure the user. */
export type StoreError = 'unreachable' | 'auth_failed' | 'timeout' | 'schema_error';

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
   * comes first, so a crash costs one batch window while the store is
   * reachable. While it is NOT, the buffer is what grows — to its own
   * ceiling — and that whole backlog is what a crash loses. The batch
   * settings bound the happy path, not the outage.
   */
  recordEvent(event: Omit<AuditEvent, 'shape'>): void;

  /** Count one ACCEPTED token use. In-memory and synchronous; the service
   *  tick writes it per hour. Refused tokens are not passed here at all. */
  countTokenUse(use: TokenUse): void;

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
  /** One batch of buffered sign-in rows, as a single multi-row statement.
   *  Nothing is waiting on it — it runs on the writer's tick, never on a
   *  request. No upsert: event rows have no natural key, so a retry after a
   *  commit-then-timeout may duplicate. That is the accepted direction to be
   *  wrong for an audit record — a duplicated sign-in is visible and
   *  harmless, a missing one is neither. */
  writeEvents(rows: ReadonlyArray<AuditEvent & StoreStamp>): Promise<void>;
  /** Cumulative counts, upserted, so this retry IS idempotent. */
  writeAggregates(rows: ReadonlyArray<AuditAggregate & StoreStamp>): Promise<void>;
  /** Appends one interval's delta. */
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

  probe(): Promise<{ available: boolean; error?: StoreError }>;

  /** Idempotent — returns immediately if already open, because the service
   *  tick retries it while the store is unavailable. Owning no timer is what
   *  keeps that safe: a re-entered `open()` can only rebuild a pool. */
  open(): Promise<void>;
  /** Safe to call after a failed `open()`. */
  close(): Promise<void>;
}
