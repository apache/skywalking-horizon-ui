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
 * The Postgres audit store: rows, statistics, retention and health.
 *
 * It owns no timer. The service drives `sweep()` on its tick, because how data
 * expires is the backend's business but when to check is not — and a store
 * with no interval to create is one an unguarded `open()` retry cannot leak.
 */

import { readFile } from 'node:fs/promises';
import pg from 'pg';
import type { AuditPostgresConfig } from '../../../config/schema.js';
import { parsePostgresUrl, type PostgresTarget } from '../../../config/audit.js';
import { logger } from '../../../logger.js';
import { overFetchSize, takeOverFetched } from '../../../logic/paging/read-page.js';
import { hourBucketOf } from '../counters.js';
import {
  AuditStoreError,
  type AuditAggregate,
  type AuditPageResult,
  type AuditEvent,
  AUDIT_STAT_WINDOWS,
  type AuditFilter,
  type AuditStat,
  type AuditStatColumn,
  type AuditStatResult,
  type AuditStatWindow,
  type AuditStore,
  type StoreError,
  type StoreStamp,
} from '../types.js';
import { SCHEMA_LOCK_ID, SCHEMA_STATEMENTS } from './schema.js';
import { toEntry, toInet, toNumber, valuesClause, type RawAuditRow } from './rows.js';

/** Rows per statement. The protocol caps a statement at 65535 bind
 *  parameters; at the widest insert here that is a few thousand rows, and 500
 *  keeps every statement small and the arithmetic obvious. The exact ceiling
 *  is asserted from the real column lists in `rows.test.ts`, so it cannot go
 *  stale the way a number written here does. */
export const CHUNK_ROWS = 500;
/** Rows per sweep pass. A 90-day purge as one statement holds locks and
 *  bloats WAL, so it goes in bounded passes. */
/** The widest statistics window, so the grouped result has a bound that does
 *  not depend on the stat table containing only the hours it should. */
const MAX_STAT_HOURS = Math.max(...AUDIT_STAT_WINDOWS);

const SWEEP_BATCH = 5_000;
const SWEEP_MAX_PASSES = 200;
/** How long to wait behind another replica's schema lock before giving up and
 *  letting the service retry. Long enough for a real migration, short enough
 *  that a stuck one is not permanent. */
const MIGRATION_LOCK_TIMEOUT_MS = 30_000;

export const EVENT_COLUMNS = [
  'at', 'kind', 'provider', 'protocol', 'outcome', 'reason', 'username', 'mail', 'roles',
  'client_ip', 'horizon_ip', 'horizon_node',
] as const;

export const AGGREGATE_COLUMNS = [
  'at', 'kind', 'username', 'horizon_ip', 'horizon_node', 'hour_bucket', 'count', 'outcome',
] as const;

const SELECT_COLUMNS =
  'id, at, kind, provider, protocol, outcome, reason, username, mail, roles, ' +
  'host(client_ip) AS client_ip, host(horizon_ip) AS horizon_ip, ' +
  'horizon_node, hour_bucket, count';

/**
 * Map a driver failure to the fixed vocabulary.
 *
 * Nothing from `pg` crosses this boundary. A connection error can carry the
 * DSN — host, database, and depending on the failure the user — and the code
 * travels into logs, replies and the admin page. The raw error is logged at
 * debug here, where it cannot escape.
 */
function classify(err: unknown): StoreError {
  const code = (err as { code?: string } | null)?.code;
  const message = err instanceof Error ? err.message : String(err);
  logger.debug({ err: message, code }, 'audit: postgres error');
  if (code === '28P01' || code === '28000') return 'auth_failed';
  if (code === '57014' || code === 'ETIMEDOUT' || /timeout/i.test(message)) return 'timeout';
  // ANY server-side error class is a fault in the statement or the schema, not
  // a dead database. Reporting one as `unreachable` sends the operator to look
  // at the network while the real cause sits in a query — and because the next
  // probe succeeds, health flaps red-green on every tick forever instead of
  // holding one honest state. SQLSTATE classes 08 (connection) and 53
  // (insufficient resources) are the genuinely connection-shaped ones.
  if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) {
    if (code.startsWith('08') || code.startsWith('53')) return 'unreachable';
    return 'schema_error';
  }
  return 'unreachable';
}

/**
 * The TLS settings for a target, derived from the mode the URL actually
 * resolved to.
 *
 * `verify-full` and `verify-ca` both authenticate the server; `require` and
 * `prefer` encrypt without checking who answered, which is why the config
 * refuses them away from loopback. `rejectUnauthorized` is what makes
 * verification real — `ssl: true` alone does not.
 */
function sslFor(target: PostgresTarget, ca: string | undefined): pg.PoolConfig['ssl'] {
  switch (target.sslmode) {
    case 'verify-full':
      return { rejectUnauthorized: true, ...(ca ? { ca } : {}) };
    case 'verify-ca':
      // The certificate chain is checked; the hostname deliberately is not.
      return { rejectUnauthorized: true, checkServerIdentity: () => undefined, ...(ca ? { ca } : {}) };
    case 'require':
    case 'prefer':
      return { rejectUnauthorized: false, ...(ca ? { ca } : {}) };
    default:
      return false;
  }
}

function fail(err: unknown): never {
  throw err instanceof AuditStoreError ? err : new AuditStoreError(classify(err));
}

export class PostgresAuditStore implements AuditStore {
  private pool: pg.Pool | null = null;
  private schemaReady = false;

  constructor(private readonly cfg: AuditPostgresConfig) {}

  /**
   * Idempotent: returns immediately once a pool exists, because the service
   * tick retries this while the store is unavailable. Owning no timer is what
   * keeps that cheap — a re-entered `open()` can only rebuild a pool.
   */
  async open(): Promise<void> {
    if (this.pool) return;
    // `this.pool` is published only after migration, so the guard above
    // cannot stop a second caller entering while the first is still building.
    // Two opens meant two migrations racing for the advisory lock and a pool
    // nothing would ever close.
    if (this.opening) return this.opening;
    this.opening = this.runOpen().finally(() => {
      this.opening = null;
    });
    return this.opening;
  }

  private async runOpen(): Promise<void> {
    this.closed = false;
    let pool: pg.Pool | null = null;
    try {
      // Read before the pool is built, so an unreadable CA fails with its own
      // cause instead of surfacing as a connection problem.
      let ca: string | undefined;
      if (this.cfg.caFile) {
        try {
          ca = await readFile(this.cfg.caFile, 'utf8');
        } catch {
          throw new AuditStoreError('schema_error');
        }
      }
      // EXPLICIT fields, never `connectionString`. Passing the string makes
      // `pg` reparse it and rebuild `ssl` from `sslmode`, discarding a sibling
      // `ssl` option — which is why `caFile` silently never loaded on exactly
      // the deployments that need it. It also means the string is interpreted
      // twice, by two parsers that can disagree; here the same parse that
      // validated the configuration is the one that connects.
      const target = parsePostgresUrl(this.cfg.url);
      // A hostless URL would let `pg` fall back to `PGHOST`, connecting
      // somewhere the configuration never named — and the TLS decision was
      // made against the URL, not against wherever the environment points.
      // `port: null` means the URL named something that is not a port. The
      // config check refuses that at boot; refuse it here too rather than let
      // `pg` fall back to PGPORT and connect somewhere else entirely.
      if (!target || target.host === '' || target.port === null) {
        throw new AuditStoreError('schema_error');
      }
      pool = new pg.Pool({
        host: target.host,
        port: target.port,
        user: target.user,
        password: target.password,
        database: target.database,
        max: this.cfg.poolMax,
        connectionTimeoutMillis: this.cfg.connectionTimeoutMs,
        statement_timeout: this.cfg.statementTimeoutMs,
        // `statement_timeout` is enforced by the SERVER, so it does nothing
        // for a socket whose peer has gone without sending anything — the
        // query simply never returns. TCP keepalive is what turns that into a
        // socket error the driver can report.
        keepAlive: true,
        keepAliveInitialDelayMillis: this.cfg.connectionTimeoutMs,
        // Options the URL carried that `pg` understands and this parser does
        // not need to interpret. Building the config from explicit fields is
        // what makes the TLS decision trustworthy, but it would otherwise
        // discard settings an operator deliberately wrote.
        ...(target.options ? { options: target.options } : {}),
        ...(target.applicationName ? { application_name: target.applicationName } : {}),
        ssl: sslFor(target, ca),
      });
      // Not optional: in `pg` an unhandled idle-client error takes the process
      // down, which would turn an optional feature into a crash source for the
      // whole UI.
      pool.on('error', (err) => {
        logger.warn({ cause: classify(err) }, 'audit: idle postgres client failed');
      });
      if (this.cfg.autoMigrate) await this.migrate(pool);
      if (this.closed) {
        await pool.end().catch(() => undefined);
        return;
      }
      this.pool = pool;
    } catch (err) {
      // Dispose whatever was half-built, or a failed open leaks a pool per
      // retry for the life of the process.
      if (pool) await pool.end().catch(() => undefined);
      fail(err);
    }
  }

  async close(): Promise<void> {
    // `closed` before the await: `open()` checks it after its own awaits and
    // disposes rather than publishing. Without that, a close landing while
    // `open()` is between `new pg.Pool` and `this.pool = pool` leaves a live
    // pool nothing holds a reference to — unclosable for the life of the
    // process, and it keeps the event loop alive at shutdown.
    this.closed = true;
    const pool = this.pool;
    this.pool = null;
    this.schemaReady = false;
    if (pool) await pool.end().catch(() => undefined);
  }

  /** Reopening after a close is legitimate — the service retries `open()` on
   *  its tick — so this only guards the window inside one `open()` call. */
  private closed = false;
  /** The in-flight `open()`; see the note there. */
  private opening: Promise<void> | null = null;

  /** The one transaction in the feature: DDL must be all-or-nothing, and an
   *  advisory lock makes replicas starting together queue rather than race. */
  private async migrate(pool: pg.Pool): Promise<void> {
    if (this.schemaReady) return;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // The pool's `statement_timeout` is a session default and applies to
      // every statement on this connection — including the advisory-lock WAIT.
      // A second replica queueing behind the first would be cancelled after a
      // second and report a schema error, so the migration is exempt from it.
      await client.query('SET LOCAL statement_timeout = 0');
      // But NOT unbounded. `open()` is awaited before the service timer is
      // created, so a migration that blocks forever behind another replica's
      // lock leaves the writer permanently unstarted — no retry, no failure
      // transition, and nothing in the log. A lock timeout turns that into an
      // ordinary error the retry can handle.
      await client.query(`SET LOCAL lock_timeout = ${MIGRATION_LOCK_TIMEOUT_MS}`);
      await client.query('SELECT pg_advisory_xact_lock($1)', [SCHEMA_LOCK_ID]);
      for (const statement of SCHEMA_STATEMENTS) await client.query(statement);
      await client.query('COMMIT');
      this.schemaReady = true;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  private get db(): pg.Pool {
    if (!this.pool) throw new AuditStoreError('unreachable');
    return this.pool;
  }

  /**
   * Reads the audit table, not `SELECT 1`.
   *
   * With `autoMigrate: false` the tables may be absent or drifted while the
   * server answers perfectly, so a liveness ping reports the feature healthy
   * when every write is failing. Asking for the thing the writes need is the
   * only probe that can tell those apart.
   */
  async probe(): Promise<{ available: boolean; error?: StoreError }> {
    try {
      // Every column a write names, not just `id`: a table that exists with
      // the wrong shape answers `SELECT id` perfectly while every insert
      // fails, which is the drift `autoMigrate: false` makes possible.
      await this.db.query(`SELECT ${SELECT_COLUMNS} FROM horizon_audit LIMIT 0`);
      await this.db.query(
        `SELECT hour_bucket, horizon_node, login_local, login_ldap,
                login_oidc, login_oauth, login_token, rejected, over_budget
           FROM horizon_audit_stat LIMIT 0`,
      );
      // The aggregate upsert infers its conflict target from a PARTIAL UNIQUE
      // index, and no amount of introspection proves inference will succeed:
      // the name can match, the index can be unique and partial, and the KEY
      // COLUMNS or the predicate can still differ — whereupon every flush
      // fails with 42P10 and `CREATE INDEX IF NOT EXISTS` never repairs it,
      // because the name is taken.
      //
      // So the probe runs the STATEMENT instead of describing the index. This
      // cannot drift from what the writer sends, because it is what the writer
      // sends; a rollback leaves nothing behind. Checking properties one by
      // one was the previous attempt and it kept being incomplete.
      const client = await this.db.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `INSERT INTO horizon_audit (${AGGREGATE_COLUMNS.join(',')}) VALUES ` +
            valuesClause(1, AGGREGATE_COLUMNS.length) +
            ` ON CONFLICT (hour_bucket, kind, username, horizon_node) ` +
            `WHERE hour_bucket IS NOT NULL ` +
            `DO UPDATE SET count = EXCLUDED.count, at = EXCLUDED.at`,
          [new Date(0), 'api-token', '__horizon_probe__', null, '__probe__', 0, 0, 1],
        );
      } finally {
        // Always, including on the failure path — the probe must leave the
        // table exactly as it found it.
        await client.query('ROLLBACK').catch(() => undefined);
        client.release();
      }
      return { available: true };
    } catch (err) {
      return { available: false, error: err instanceof AuditStoreError ? err.code : classify(err) };
    }
  }

  async writeEvents(rows: ReadonlyArray<AuditEvent & StoreStamp>): Promise<void> {
    // No `ON CONFLICT`: event rows have no natural key. A retry after a
    // commit-then-timeout may therefore duplicate, which for an audit record
    // is the right direction to be wrong.
    // A chunk that throws aborts the rest, because the caller retries the
    // WHOLE batch — so a failure in a later chunk would re-send the earlier
    // ones that already committed. `eventBatchRows` is clamped to CHUNK_ROWS
    // in configuration so a batch is normally a single chunk and the window
    // does not arise; this loop is the backstop for a caller that passes more.
    for (let i = 0; i < rows.length; i += CHUNK_ROWS) {
      const chunk = rows.slice(i, i + CHUNK_ROWS);
      const params = chunk.flatMap((r) => [
        new Date(r.at), r.kind, r.provider ?? null, r.protocol ?? null, r.outcome, r.reason ?? null,
        r.username, r.mail ?? null, r.roles ?? null,
        toInet(r.clientIp), toInet(r.horizonIp), r.horizonNode,
      ]);
      try {
        await this.db.query(
          `INSERT INTO horizon_audit (${EVENT_COLUMNS.join(',')}) VALUES ` +
            valuesClause(chunk.length, EVENT_COLUMNS.length),
          params,
        );
      } catch (err) {
        fail(err);
      }
    }
  }

  async writeAggregates(rows: ReadonlyArray<AuditAggregate & StoreStamp>): Promise<void> {
    for (let i = 0; i < rows.length; i += CHUNK_ROWS) {
      const chunk = rows.slice(i, i + CHUNK_ROWS);
      const params = chunk.flatMap((r) => [
        new Date(r.at), r.kind, r.username, toInet(r.horizonIp),
        r.horizonNode, r.hourBucket, r.count, 1,
      ]);
      try {
        // A plain multi-row VALUES, NOT `INSERT ... SELECT ... FROM (VALUES ...)`.
        // The difference is load-bearing rather than stylistic: `pg` sends Parse
        // with no declared parameter types, and inside a VALUES used as a FROM
        // item every all-unknown column resolves to `text` — the target
        // column's type is not visible through the sub-SELECT. Postgres then
        // refuses the assignment (42804, "column at is of type timestamptz but
        // expression is of type text") and the statement fails every time. In
        // this form each sublist is coerced to the target columns first, so the
        // parameters are inferred from the table and no casts are needed.
        //
        // Cumulative counts, so overwrite rather than add: a retry after a
        // commit-then-timeout writes the same number instead of doubling it.
        // The `WHERE` on the conflict target is required — it is what makes the
        // partial unique index inferrable.
        await this.db.query(
          `INSERT INTO horizon_audit (${AGGREGATE_COLUMNS.join(',')}) VALUES ` +
            valuesClause(chunk.length, AGGREGATE_COLUMNS.length) +
            ` ON CONFLICT (hour_bucket, kind, username, horizon_node) ` +
            `WHERE hour_bucket IS NOT NULL ` +
            `DO UPDATE SET count = EXCLUDED.count, at = EXCLUDED.at`,
          params,
        );
      } catch (err) {
        fail(err);
      }
    }
  }

  async writeStat(stat: AuditStat): Promise<void> {
    try {
      await this.db.query(
        `INSERT INTO horizon_audit_stat
           (hour_bucket, horizon_node, login_local, login_ldap,
            login_oidc, login_oauth, login_token, rejected, over_budget)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          stat.hourBucket, stat.horizonNode, stat.login.local, stat.login.ldap,
          stat.login.oidc, stat.login.oauth, stat.login.token,
          stat.rejected, stat.overBudget,
        ],
      );
    } catch (err) {
      fail(err);
    }
  }

  async query(filter: AuditFilter): Promise<AuditPageResult> {
    const where: string[] = [];
    const params: unknown[] = [];
    const bind = (v: unknown): string => `$${params.push(v)}`;

    if (filter.from !== undefined) where.push(`at >= ${bind(new Date(filter.from))}`);
    if (filter.to !== undefined) where.push(`at < ${bind(new Date(filter.to))}`);
    if (filter.kind?.length) where.push(`kind = ANY(${bind(filter.kind)})`);
    // EXACT, not a prefix. A prefix was a LIKE-shaped answer to a question
    // nobody asked: the filter names one principal, and matching a fragment
    // makes the result depend on how much of a name was typed. It also could
    // not be reproduced on a backend whose operator set has no prefix, which
    // would have made the same control mean two different things.
    if (filter.username) where.push(`username = ${bind(filter.username)}`);

    // Keyset: resume strictly AFTER the previous page's last row in the
    // `(at DESC, id DESC)` ordering. A row-value comparison is what makes the
    // composite index usable; comparing the two columns separately would not.
    if (filter.cursor) {
      where.push(
        `(at, id) < (${bind(new Date(filter.cursor.at))}::timestamptz, ${bind(filter.cursor.id)}::bigint)`,
      );
    }

    const size = Math.max(1, filter.pageSize);
    const limit = overFetchSize(size);

    try {
      // `(at DESC, id DESC)`, never `id` alone: identity values are handed out
      // monotonically but COMMIT out of order, so `id` is a tiebreaker rather
      // than a clock.
      const res = await this.db.query<RawAuditRow>(
        `SELECT ${SELECT_COLUMNS} FROM horizon_audit
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY at DESC, id DESC LIMIT ${bind(limit)}`,
        params,
      );
      const { rows, hasNext } = takeOverFetched(res.rows.map(toEntry), size);
      const last = rows[rows.length - 1];
      return {
        rows,
        pageNum: filter.pageNum,
        pageSize: size,
        hasNext,
        ...(hasNext && last ? { nextCursor: { at: last.at, id: last.id } } : {}),
      };
    } catch (err) {
      return fail(err);
    }
  }

  async queryStat(window: AuditStatWindow): Promise<AuditStatResult> {
    const from = hourBucketOf(Date.now() - (window - 1) * 3_600_000);
    // Every statement this store sends carries its own bound. The grouping
    // already caps this one at the window's hours, but a query whose size
    // depends on the data being well-formed is a query that gets surprising
    // when it is not.
    const params: unknown[] = [from];
    const bindStat = (v: unknown): string => `$${params.push(v)}`;
    try {
      const res = await this.db.query<Record<string, unknown>>(
        `SELECT hour_bucket,
                SUM(login_local)       AS login_local,
                SUM(login_ldap)        AS login_ldap,
                SUM(login_oidc)        AS login_oidc,
                SUM(login_oauth)       AS login_oauth,
                SUM(login_token)       AS login_token,
                SUM(rejected)          AS rejected,
                SUM(over_budget)       AS over_budget,
                -- The distinct writers this hour, as one comma-joined value.
                -- horizon_node is host:boot-id, so counting those counts
                -- process INCARNATIONS: 40 after a crash loop of two replicas.
                -- The host half is what an operator means by a node, and a
                -- per-hour COUNT cannot be summed across hours without
                -- double-counting a node present in several. A hostname
                -- cannot contain a comma, so joining is unambiguous.
                string_agg(DISTINCT split_part(horizon_node, ':', 1), ',') AS nodes
           FROM horizon_audit_stat
          WHERE hour_bucket >= $1
          GROUP BY hour_bucket
          ORDER BY hour_bucket
          LIMIT ${bindStat(MAX_STAT_HOURS)}`,
        params,
      );

      const byHour = new Map<number, AuditStatColumn>();
      let overBudget = 0;
      const nodes = new Set<string>();
      for (const r of res.rows) {
        byHour.set(toNumber(r.hour_bucket, 'hour_bucket'), {
          hourBucket: toNumber(r.hour_bucket, 'hour_bucket'),
          login: {
            local: toNumber(r.login_local, 'login_local'),
            ldap: toNumber(r.login_ldap, 'login_ldap'),
            oidc: toNumber(r.login_oidc, 'login_oidc'),
            oauth: toNumber(r.login_oauth, 'login_oauth'),
            token: toNumber(r.login_token, 'login_token'),
          },
          rejected: toNumber(r.rejected, 'rejected'),
        });
        overBudget += toNumber(r.over_budget, 'over_budget');
        for (const n of String(r.nodes ?? '').split(',')) if (n) nodes.add(n);
      }

      // Every hour in the window, present or not. A quiet hour that simply
      // vanishes makes the chart's columns non-uniform in time, so a gap in
      // activity reads as a narrower window rather than as quiet.
      const columns: AuditStatColumn[] = [];
      const nowHour = Date.now();
      for (let i = window - 1; i >= 0; i -= 1) {
        const bucket = hourBucketOf(nowHour - i * 3_600_000);
        columns.push(
          byHour.get(bucket) ?? {
            hourBucket: bucket,
            login: { local: 0, ldap: 0, oidc: 0, oauth: 0, token: 0 },
            rejected: 0,
          },
        );
      }
      return { columns, overBudget, horizonNodes: nodes.size };
    } catch (err) {
      return fail(err);
    }
  }

  /** Bounded passes rather than one statement, so a large purge never holds
   *  locks or bloats WAL. `ctid` is the cheapest way to delete a bounded slice
   *  without an ordered scan of the whole predicate. */
  async sweep(): Promise<number> {
    const cutoff = new Date(Date.now() - this.cfg.retentionDays * 86_400_000);
    let removed = 0;
    try {
      for (let pass = 0; pass < SWEEP_MAX_PASSES; pass += 1) {
        const res = await this.db.query(
          `DELETE FROM horizon_audit WHERE ctid IN (
             SELECT ctid FROM horizon_audit WHERE at < $1 LIMIT ${SWEEP_BATCH})`,
          [cutoff],
        );
        removed += res.rowCount ?? 0;
        if ((res.rowCount ?? 0) < SWEEP_BATCH) break;
      }
      // Statistics expire on the same retention, by their own time column.
      await this.db.query('DELETE FROM horizon_audit_stat WHERE hour_bucket < $1', [
        hourBucketOf(cutoff.getTime()),
      ]);
      return removed;
    } catch (err) {
      return fail(err);
    }
  }
}
