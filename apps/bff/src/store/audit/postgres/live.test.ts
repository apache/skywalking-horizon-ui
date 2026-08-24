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
 * The audit log against a REAL PostgreSQL server, through the real `pg`
 * driver — the service and the store together, not the SQL in isolation.
 *
 * `sql.test.ts` runs every statement against PGlite, which is the same engine
 * compiled to WASM and proves the SQL is valid. This proves the things only a
 * networked driver can: that `pg` sends and receives what the store assumes,
 * that the pool and the lifecycle behave, and that a sign-in handed to the
 * service arrives as a row.
 *
 * SKIPPED unless `HORIZON_AUDIT_TEST_PG` names a server, because it needs one:
 *
 *   HORIZON_AUDIT_TEST_PG=postgres://horizon@127.0.0.1:55432/horizon \
 *     pnpm --filter @skywalking-horizon-ui/bff test:unit -- live
 *
 * It creates its own schema if the database has none, and deletes every row
 * it wrote on the way out — its rows are stamped with a test node id, so the
 * cleanup touches nothing else. Point it at a scratch database anyway: schema
 * creation is not undone.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pgDriver from 'pg';
import type { AuditConfig } from '../../../config/schema.js';
import { BufferedAuditService } from '../service.js';
import { PostgresAuditStore } from './store.js';
import { hourBucketStart } from '../counters.js';

const URL = process.env.HORIZON_AUDIT_TEST_PG;
const NODE = 'live-test:aaa';
const AT = Date.now();

const pg = {
  url: URL ?? '', caFile: '', allowCleartext: false, autoMigrate: true, retentionDays: 90,
  sweepIntervalMinutes: 60, poolMax: 4, connectionTimeoutMs: 5000, statementTimeoutMs: 5000,
};
const config = {
  enabled: true, maxRowsPerHour: 1000, flushIntervalSeconds: 1,
  eventBatchRows: 3, eventBatchSeconds: 1, provider: 'postgres', postgres: pg,
} as unknown as AuditConfig;

let store: PostgresAuditStore;
let svc: BufferedAuditService;

describe.skipIf(!URL)('the audit log against a real PostgreSQL', () => {
  beforeAll(async () => {
    store = new PostgresAuditStore(pg);
    svc = new BufferedAuditService({ store, config, horizonNode: NODE });
    await store.open();
    // Own only this run's rows — the suite asserts on counts, so a scratch
    // database with leftovers from a previous run would fail confusingly.
    const admin = new pgDriver.Pool({ connectionString: pg.url });
    await admin.query('TRUNCATE horizon_audit, horizon_audit_stat');
    await admin.end();
  }, 60_000);

  // Every row this suite writes is stamped with NODE, so its cleanup can be
  // exact. It was claimed in the header long before it was true: the suite
  // left its rows in whatever database it was pointed at.
  afterAll(async () => {
    await svc?.stop();
    const admin = new pgDriver.Pool({ connectionString: URL, max: 1 });
    try {
      for (const table of ['horizon_audit', 'horizon_audit_stat', 'horizon_token_usage']) {
        await admin.query(`DELETE FROM ${table} WHERE horizon_node = $1`, [NODE]);
      }
    } finally {
      await admin.end();
    }
  });

  it('creates its schema and reports itself available', async () => {
    const probe = await store.probe();
    expect(probe.available, probe.error).toBe(true);
  });

  it('turns buffered sign-ins into rows, with their reasons and addresses intact', async () => {
    svc.recordEvent({ at: AT, kind: 'local', outcome: 1, username: 'alice', clientIp: '203.0.113.7' });
    svc.recordEvent({
      at: AT, kind: 'sso', outcome: 0, reason: 'no_roles', username: 'bob@x.io', mail: 'bob@x.io',
      provider: 'github', protocol: 'oidc', clientIp: '198.51.100.5',
    });
    svc.recordEvent({ at: AT, kind: 'ldap', outcome: 1, username: 'carol' });
    await svc.tick();

    const page = await svc.query({ pageNum: 1, pageSize: 50 });
    expect(page.rows).toHaveLength(3);
    expect(page.rows.find((r) => r.username === 'alice')?.clientIp).toBe('203.0.113.7');
    const bob = page.rows.find((r) => r.username === 'bob@x.io');
    expect(bob?.outcome).toBe(0);
    expect(bob?.reason).toBe('no_roles');
    // `pg` returns bigint as a string; narrowing it for a tidier type would be
    // a silent precision bug, so the contract keeps it a string.
    expect(typeof page.rows[0].id).toBe('string');
  });

  /** The filter names ONE principal: a fragment finds nothing, and a wildcard
   *  is just a name nobody has rather than a full table read. */
  it('matches one principal exactly', async () => {
    expect((await svc.query({ pageNum: 1, pageSize: 50, username: 'alice' })).rows).toHaveLength(1);
    expect((await svc.query({ pageNum: 1, pageSize: 50, username: 'ali' })).rows).toHaveLength(0);
    expect((await svc.query({ pageNum: 1, pageSize: 50, username: '%' })).rows).toHaveLength(0);
  });

  it('filters by how someone signed in', async () => {
    const rows = (await svc.query({ pageNum: 1, pageSize: 50, kind: ['sso'] })).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].username).toBe('bob@x.io');
  });

  it('pages without a total, and resumes from a position rather than an offset', async () => {
    const first = await svc.query({ pageNum: 1, pageSize: 2 });
    expect(first.rows).toHaveLength(2);
    expect(first.hasNext).toBe(true);
    expect(first.nextCursor).toBeDefined();

    const second = await svc.query({ pageNum: 2, pageSize: 2, cursor: first.nextCursor });
    expect(second.hasNext).toBe(false);
    // The whole point: no row appears on both pages, and the walk ends.
    const seen = [...first.rows, ...second.rows].map((r) => r.id);
    expect(new Set(seen).size).toBe(seen.length);
  });

  /** An audit table is appended to at exactly the end the page reads from, so
   *  an OFFSET counts a moving target: rows written between two requests shift
   *  everything down and the reader sees a record twice. A position cannot. */
  it('does not repeat a row when writes land between two page requests', async () => {
    const first = await svc.query({ pageNum: 1, pageSize: 2 });
    svc.recordEvent({ at: Date.now(), kind: 'local', outcome: 1, username: 'arrived-later' });
    await svc.tick();
    const second = await svc.query({ pageNum: 2, pageSize: 2, cursor: first.nextCursor });
    const seen = [...first.rows, ...second.rows].map((r) => r.id);
    expect(new Set(seen).size).toBe(seen.length);
    expect(second.rows.some((r) => r.username === 'arrived-later')).toBe(false);
  });

  it('aggregates statistics over every hour in the window', async () => {
    await svc.tick();
    const stat = await svc.queryStat(2);
    // Every hour, including a quiet one — a missing column would make the
    // chart non-uniform in time.
    expect(stat.columns).toHaveLength(2);
    const counted = stat.columns.reduce(
      (n, c) => n + c.login.local + c.login.ldap + c.rejected, 0,
    );
    expect(counted).toBeGreaterThan(0);
    expect(stat.horizonNodes).toBe(1);
  });

  it('runs retention without error', async () => {
    await expect(store.sweep()).resolves.toBeTypeOf('number');
  });

  // Asserted through the real `sweep()`, not by re-running its statement:
  // token usage shipped outside retention and grew forever, and only calling
  // the method that is supposed to reach the table proves that it does.
  it('expires token usage past retention, and keeps what is inside it', async () => {
    const tokens = store.tokenUsage();
    const outside = hourBucket(AT - (pg.retentionDays + 1) * 86_400_000);
    // An hour inside retention but NOT the current one: `top` is capped at
    // TOP_TOKENS_PER_HOUR, so a busy current hour could rank this row out of
    // the list and fail the assertion for a reason retention had no part in.
    const inside = hourBucket(AT - 2 * 86_400_000);
    await tokens.writeUsage([
      { hourBucket: outside, tokenId: 'expired', username: 'sre', count: 4, horizonNode: NODE },
      { hourBucket: inside, tokenId: 'current', username: 'sre', count: 6, horizonNode: NODE },
    ]);

    await store.sweep();

    // Only this suite's own rows are asserted on. The database may be shared
    // with a running Horizon, whose real token traffic lands in `inside` too.
    const OWN = ['expired', 'current'];
    const survivors = async (at: number): Promise<string[]> => {
      const rows = await tokens.readWindow({ from: at, to: at + 3_600_000 });
      return rows.map((r) => r.tokenId).filter((id) => OWN.includes(id));
    };
    expect(await survivors(hourBucketStart(outside))).toEqual([]);
    expect(await survivors(hourBucketStart(inside))).toEqual(['current']);
  });
});

/** epoch ms → `yyyyMMddHH`, UTC — the form the table is keyed on. */
function hourBucket(ms: number): number {
  const d = new Date(ms);
  return d.getUTCFullYear() * 1_000_000
    + (d.getUTCMonth() + 1) * 10_000
    + d.getUTCDate() * 100
    + d.getUTCHours();
}
