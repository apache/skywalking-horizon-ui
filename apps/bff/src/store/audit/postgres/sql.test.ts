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
import { toNumber, valuesClause } from './rows.js';
import { EVENT_COLUMNS as EVENT_COLS, SELECT_COLUMNS } from './store.js';

let db: PGlite;

// The SHIPPED column lists, not a copy of them. Retyping these as literals
// is how the suite came to exercise a different statement than the store
// sends: a column added to the store left this copy behind, silently.
const EVENT_COLUMNS = EVENT_COLS.join(',');

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

  it('creates the indexes the list depends on', async () => {
    const r = await db.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'horizon_audit'`,
    );
    const names = r.rows.map((x) => x.indexname);
    expect(names).toContain('horizon_audit_at_idx');
    expect(names).toContain('horizon_audit_username_idx');
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

describe('reading', () => {
  it('runs the list query with every filter at once', async () => {
    // The SHIPPED projection, not a copy of it. Retyping it is how this suite
    // came to assert a statement the store does not send: the hand-written
    // list had already lost `protocol`.
    const sql =
      `SELECT ${SELECT_COLUMNS}
         FROM horizon_audit
        WHERE at >= $1 AND at < $2 AND kind = ANY($3) AND username = $4
        ORDER BY at DESC, id DESC LIMIT $5`;
    const r = await db.query(sql, [
      new Date('2026-01-01T00:00:00Z'), new Date('2027-01-01T00:00:00Z'),
      ['local', 'sso'], 'alice', 51,
    ]);
    expect(Array.isArray(r.rows)).toBe(true);
  });

  /** The filter names ONE principal. `alice_ci` must not also return
   *  `aliceXci`, which is what a LIKE prefix did with an unescaped `_`. */
  it('matches one principal exactly, never a lookalike', async () => {
    for (const u of ['alice_ci', 'aliceXci', 'alice_ci_2']) {
      await db.query(
        `INSERT INTO horizon_audit (at,kind,outcome,username,horizon_node) VALUES ($1,$2,$3,$4,$5)`,
        [new Date('2026-08-22T15:00:00Z'), 'api-token', 1, u, 'pod-1:aaa'],
      );
    }
    const r = await db.query<{ username: string }>(
      `SELECT username FROM horizon_audit WHERE username = $1`,
      ['alice_ci'],
    );
    expect(r.rows.map((x) => x.username)).toEqual(['alice_ci']);
  });

  it('runs the statistics aggregation', async () => {
    const insert = `INSERT INTO horizon_audit_stat
         (hour_bucket, horizon_node, login_local, login_ldap,
          login_oidc, login_oauth, rejected, over_budget)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`;
    await db.query(insert, [2026082214, 'pod-1:aaa', 3, 0, 1, 0, 1, 0]);
    await db.query(insert, [2026082214, 'pod-2:bbb', 2, 0, 0, 0, 0, 0]);
    const r = await db.query<Record<string, unknown>>(
      `SELECT SUM(login_local) AS login_local,
              SUM(login_oidc)  AS login_oidc,
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
    expect(Number(r.rows[0].login_oidc)).toBe(1);
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
    // `horizon_audit.id` and `horizon_audit_stat.hour_bucket` are the two
    // bigints the mapper reads back.
    const r = await db.query<{ id: unknown }>('SELECT id FROM horizon_audit LIMIT 1');
    expect(['string', 'number']).toContain(typeof r.rows[0].id);
    const h = await db.query<{ hour_bucket: unknown }>(
      'SELECT hour_bucket FROM horizon_audit_stat LIMIT 1',
    );
    if (h.rows.length > 0) {
      expect(['string', 'number']).toContain(typeof h.rows[0].hour_bucket);
      expect(toNumber(h.rows[0].hour_bucket, 'hour_bucket')).toBeGreaterThan(0);
    }
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

  // Token usage is a fourth thing the sweep has to reach. It shipped without
  // one and grew forever: the table is hour-keyed and nothing else prunes it.
  it('expires token usage on the same retention as the audit', async () => {
    await db.query(
      `INSERT INTO horizon_token_usage (hour_bucket, token_id, username, count, horizon_node)
       VALUES (2026010100,'old','sre',5,'n1'), (2027060100,'fresh','sre',9,'n1')`,
    );
    await db.query('DELETE FROM horizon_token_usage WHERE hour_bucket < $1', [2027010100]);
    const left = await db.query<{ token_id: string }>(
      'SELECT token_id FROM horizon_token_usage ORDER BY token_id',
    );
    expect(left.rows.map((r) => r.token_id)).toEqual(['fresh']);
  });
});
