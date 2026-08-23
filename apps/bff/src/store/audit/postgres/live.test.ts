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
 * It creates its own schema and cleans up after itself, so point it at a
 * scratch database rather than anything you care about.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pgDriver from 'pg';
import type { AuditConfig } from '../../../config/schema.js';
import { BufferedAuditService } from '../service.js';
import { PostgresAuditStore } from './store.js';

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

  afterAll(async () => { await svc?.stop(); });

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

  /** The statement that was invalid SQL for an entire phase: written as
   *  `INSERT ... SELECT ... FROM (VALUES ...)` it fails 42804 every time. */
  it('upserts a token aggregate cumulatively, leaving exactly one row', async () => {
    for (let i = 0; i < 5; i += 1) svc.countTokenUse({ kind: 'api-token', username: 'ab12cd', at: AT });
    await svc.tick();
    let agg = (await svc.query({ pageNum: 1, pageSize: 50, kind: ['api-token'] })).rows;
    expect(agg).toHaveLength(1);
    expect(agg[0].count).toBe(5);

    for (let i = 0; i < 4; i += 1) svc.countTokenUse({ kind: 'api-token', username: 'ab12cd', at: AT });
    await svc.tick();
    agg = (await svc.query({ pageNum: 1, pageSize: 50, kind: ['api-token'] })).rows;
    expect(agg, 'a second flush must overwrite, not append').toHaveLength(1);
    expect(agg[0].count).toBe(9);
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
      (n, c) => n + c.login.local + c.login.ldap + c.login.token + c.rejected, 0,
    );
    expect(counted).toBeGreaterThan(0);
    expect(stat.horizonNodes).toBe(1);
  });

  it('runs retention without error', async () => {
    await expect(store.sweep()).resolves.toBeTypeOf('number');
  });
});
