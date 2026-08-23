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
 * Every audit statement, executed against a real PostgreSQL engine.
 *
 * A type-check proves nothing about SQL. This suite exists because the
 * aggregate upsert was written in a form the server rejects outright —
 * `INSERT ... SELECT ... FROM (VALUES ...)` with untyped parameters resolves
 * every column to `text` and fails with 42804 — and nothing short of running
 * it would have found that. It would have failed on 100% of flushes in
 * production while every test passed.
 *
 * PGlite is PostgreSQL compiled to WASM: the same parser, planner and executor,
 * in-process. It issues Parse with no declared parameter types, exactly as
 * `pg` does, which is the property that makes the 42804 above reproducible.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { SCHEMA_STATEMENTS } from './schema.js';
import { likePrefix, toNumber, valuesClause } from './rows.js';
import { EVENT_COLUMNS as EVENT_COLS, AGGREGATE_COLUMNS as AGG_COLS } from './store.js';

let db: PGlite;

// The SHIPPED column lists, not a copy of them. Retyping these as literals
// is how the suite came to exercise a different statement than the store
// sends: a column added to the store left this copy behind, silently.
const EVENT_COLUMNS = EVENT_COLS.join(',');
const AGGREGATE_COLUMNS = AGG_COLS.join(',');

beforeAll(async () => {
  db = new PGlite();
  await db.query('BEGIN');
  await db.query('SET LOCAL statement_timeout = 0');
  await db.query('SELECT pg_advisory_xact_lock($1)', [0x53574155]);
  for (const s of SCHEMA_STATEMENTS) await db.query(s);
  await db.query('COMMIT');
}, 120_000);

afterAll(async () => { await db?.close(); });

describe('the schema', () => {
  it('applies inside one transaction under the advisory lock', async () => {
    const r = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM information_schema.tables
        WHERE table_name IN ('horizon_audit','horizon_audit_stat')`,
    );
    expect(r.rows[0].n).toBe(2);
  });

  it('is re-appliable, so a second replica starting is not an error', async () => {
    for (const s of SCHEMA_STATEMENTS) await expect(db.query(s)).resolves.toBeDefined();
  });

  it('creates the prefix indexes that make a LIKE filter index-served', async () => {
    const r = await db.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'horizon_audit'`,
    );
    const names = r.rows.map((x) => x.indexname);
    expect(names).toContain('horizon_audit_username_prefix_idx');
    expect(names).toContain('horizon_audit_bucket_idx');
  });
});

describe('writing sign-in rows', () => {
  it('inserts a multi-row batch', async () => {
    // at, kind, provider, protocol, outcome, reason, username, mail, roles,
    // client_ip, horizon_ip, horizon_node — in EVENT_COLUMNS order.
    const rows = [
      [new Date('2026-08-22T14:30:00Z'), 'local', null, null, 1, null, 'alice', null, 'admin', '203.0.113.7', '10.42.0.17', 'pod-1:aaa'],
      [new Date('2026-08-22T14:31:00Z'), 'sso', 'github', 'oauth2', 0, 'no_roles', 'bob@x.io', 'bob@x.io', null, null, '10.42.0.17', 'pod-1:aaa'],
    ];
    // Width from the shipped list, so a new column fails the arity here
    // rather than only in production.
    expect(rows[0]).toHaveLength(EVENT_COLS.length);
    await db.query(
      `INSERT INTO horizon_audit (${EVENT_COLUMNS}) VALUES ${valuesClause(2, EVENT_COLS.length)}`,
      rows.flat(),
    );
    const r = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM horizon_audit');
    expect(r.rows[0].n).toBe(2);
  });
});

describe('writing token aggregates', () => {
  /**
   * The statement this whole file exists for. Written as
   * `INSERT ... SELECT ... FROM (VALUES ...)` it fails with 42804 on every
   * call, because untyped parameters in a VALUES used as a FROM item resolve
   * to `text` and the target column types are not visible through the
   * sub-SELECT. A plain multi-row VALUES infers them from the table.
   */
  const upsert =
    `INSERT INTO horizon_audit (${AGGREGATE_COLUMNS}) VALUES ${valuesClause(1, AGG_COLS.length)}` +
    ` ON CONFLICT (hour_bucket, kind, username, horizon_node)` +
    ` WHERE hour_bucket IS NOT NULL` +
    ` DO UPDATE SET count = EXCLUDED.count, at = EXCLUDED.at`;

  it('inserts an aggregate row', async () => {
    await db.query(upsert, [
      new Date('2026-08-22T14:00:00Z'), 'api-token', 'ab12cd', null, 'pod-1:aaa', 2026082214, 5, 1,
    ]);
    const r = await db.query<{ count: string }>(
      `SELECT count FROM horizon_audit WHERE username = 'ab12cd'`,
    );
    expect(Number(r.rows[0].count)).toBe(5);
  });

  /** Cumulative counts overwrite, so a retry after a commit-then-timeout
   *  writes the same number rather than doubling it. */
  it('overwrites the same credential-hour rather than adding a row', async () => {
    await db.query(upsert, [
      new Date('2026-08-22T14:00:00Z'), 'api-token', 'ab12cd', null, 'pod-1:aaa', 2026082214, 9, 1,
    ]);
    const r = await db.query<{ n: number; count: string }>(
      `SELECT count(*)::int AS n, max(count) AS count FROM horizon_audit WHERE username = 'ab12cd'`,
    );
    expect(r.rows[0].n).toBe(1);
    expect(Number(r.rows[0].count)).toBe(9);
  });

  /** A different process is a different row: replicas each hold their own
   *  cumulative count and must never collide on one. */
  it('keeps a second node separate', async () => {
    await db.query(upsert, [
      new Date('2026-08-22T14:00:00Z'), 'api-token', 'ab12cd', null, 'pod-2:bbb', 2026082214, 3, 1,
    ]);
    const r = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM horizon_audit WHERE username = 'ab12cd'`,
    );
    expect(r.rows[0].n).toBe(2);
  });
});

describe('reading', () => {
  it('runs the list query with every filter at once', async () => {
    const sql =
      `SELECT id, at, kind, provider, outcome, reason, username, mail, roles, host(client_ip) AS client_ip, host(horizon_ip) AS horizon_ip,
              horizon_node, hour_bucket, count
         FROM horizon_audit
        WHERE at >= $1 AND at < $2 AND kind = ANY($3) AND username LIKE $4
        ORDER BY at DESC, id DESC LIMIT $5 OFFSET $6`;
    const r = await db.query(sql, [
      new Date('2026-01-01T00:00:00Z'), new Date('2027-01-01T00:00:00Z'),
      ['local', 'sso'], likePrefix('al'), 51, 0,
    ]);
    expect(Array.isArray(r.rows)).toBe(true);
  });

  /** An unescaped `_` would match any character, and a lone `%` would turn a
   *  filter into a full table read. */
  it('treats an underscore in a prefix as a literal', async () => {
    await db.query(
      `INSERT INTO horizon_audit (at,kind,outcome,username,horizon_node) VALUES ($1,$2,$3,$4,$5)`,
      [new Date('2026-08-22T15:00:00Z'), 'api-token', 1, 'alice_ci', 'pod-1:aaa'],
    );
    await db.query(
      `INSERT INTO horizon_audit (at,kind,outcome,username,horizon_node) VALUES ($1,$2,$3,$4,$5)`,
      [new Date('2026-08-22T15:00:00Z'), 'api-token', 1, 'aliceXci', 'pod-1:aaa'],
    );
    const r = await db.query<{ username: string }>(
      `SELECT username FROM horizon_audit WHERE username LIKE $1`,
      [likePrefix('alice_ci')],
    );
    expect(r.rows.map((x) => x.username)).toEqual(['alice_ci']);
  });

  it('runs the statistics aggregation', async () => {
    await db.query(
      `INSERT INTO horizon_audit_stat
         (hour_bucket, horizon_node, login_local, login_ldap,
          login_oidc, login_oauth, login_token, rejected, over_budget)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [2026082214, 'pod-1:aaa', 3, 0, 1, 0, 12, 1, 0],
    );
    await db.query(
      `INSERT INTO horizon_audit_stat
         (hour_bucket, horizon_node, login_local, login_ldap,
          login_oidc, login_oauth, login_token, rejected, over_budget)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [2026082214, 'pod-2:bbb', 2, 0, 0, 0, 0, 0, 0],
    );
    const r = await db.query<Record<string, unknown>>(
      `SELECT hour_bucket,
              SUM(login_local) AS login_local,
              SUM(login_token) AS login_token,
              SUM(rejected)    AS rejected,
              string_agg(DISTINCT split_part(horizon_node, ':', 1), ',') AS nodes
         FROM horizon_audit_stat
        WHERE hour_bucket >= $1
        GROUP BY hour_bucket
        ORDER BY hour_bucket`,
      [2026082200],
    );
    // Delta rows SUM rather than overwrite, and two pods that share a host
    // name would still each contribute a row.
    expect(Number(r.rows[0].login_local)).toBe(5);
    expect(Number(r.rows[0].login_token)).toBe(12);
    expect(String(r.rows[0].nodes).split(',').sort()).toEqual(['pod-1', 'pod-2']);
  });

  /**
   * Two drivers, two answers for the same column — which is exactly why the
   * conversion is defensive rather than a cast.
   *
   * `pg` returns `int8` as a STRING, because the range exceeds
   * `Number.MAX_SAFE_INTEGER`. PGlite parses it to a number. Code that assumed
   * either one would be wrong against the other, and wrong SILENTLY: a string
   * comparison of two hour buckets happens to order correctly, and `SUM`
   * totals concatenate instead of adding. `toNumber` accepts both and throws
   * on anything else.
   */
  it('hands back bigint columns in a form the row mapper accepts either way', async () => {
    const r = await db.query<{ hour_bucket: unknown; id: unknown }>(
      `SELECT id, hour_bucket FROM horizon_audit WHERE hour_bucket IS NOT NULL LIMIT 1`,
    );
    for (const v of [r.rows[0].hour_bucket, r.rows[0].id]) {
      expect(['string', 'number']).toContain(typeof v);
    }
    expect(toNumber(r.rows[0].hour_bucket, 'hour_bucket')).toBe(2026082214);
  });
});

describe('retention', () => {
  it('deletes in bounded passes by ctid', async () => {
    const cutoff = new Date('2027-01-01T00:00:00Z');
    const r = await db.query(
      `DELETE FROM horizon_audit WHERE ctid IN (
         SELECT ctid FROM horizon_audit WHERE at < $1 LIMIT 5000)`,
      [cutoff],
    );
    expect(r.affectedRows).toBeGreaterThan(0);
    await db.query('DELETE FROM horizon_audit_stat WHERE hour_bucket < $1', [2027010100]);
    const left = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM horizon_audit');
    expect(left.rows[0].n).toBe(0);
  });
});

/**
 * The probe used to match on an index NAME alone. `ON CONFLICT` infers its
 * target from the index's properties, so a plain or full index carrying the
 * right name passes a name check and then fails every upsert with 42P10 —
 * and `CREATE INDEX IF NOT EXISTS` will not replace it.
 */
describe('the aggregate conflict index', () => {
  const probeSql = `SELECT count(*)::int AS n
       FROM pg_index i
       JOIN pg_class c ON c.oid = i.indexrelid
      WHERE i.indrelid = to_regclass($1)
        AND c.relname = $2
        AND i.indisunique
        AND i.indpred IS NOT NULL`;

  it('recognises the shipped index', async () => {
    const r = await db.query<{ n: number }>(probeSql, ['horizon_audit', 'horizon_audit_bucket_idx']);
    expect(r.rows[0].n).toBe(1);
  });

  it('rejects a same-named index that is not unique and not partial', async () => {
    await db.exec(`
      CREATE TABLE decoy (hour_bucket bigint, kind text, username text, horizon_node text);
      CREATE INDEX horizon_audit_bucket_idx_decoy ON decoy (hour_bucket);
    `);
    const r = await db.query<{ n: number }>(probeSql, ['decoy', 'horizon_audit_bucket_idx_decoy']);
    // Right name, wrong properties — the upsert would fail 42P10.
    expect(r.rows[0].n).toBe(0);
  });

  it('rejects a unique index that is not partial', async () => {
    await db.exec(`CREATE UNIQUE INDEX decoy_full_idx ON decoy (hour_bucket, kind, username, horizon_node)`);
    const r = await db.query<{ n: number }>(probeSql, ['decoy', 'decoy_full_idx']);
    expect(r.rows[0].n).toBe(0);
  });
});
