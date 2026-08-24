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
 * Token usage across more than one replica.
 *
 * The counter and the summary are correct in isolation and still wrong
 * together if the row is keyed without the node: two processes each write
 * their own view of one shared row, and the hour reports whichever wrote last
 * — a number that goes DOWN as the hour proceeds. Only a test that runs two
 * counters against one store can see it, so it lives here rather than beside
 * either half.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { SCHEMA_STATEMENTS } from './postgres/schema.js';
import { PostgresTokenUsageStore } from './postgres/token-store.js';
import { TokenCounters } from './token-counters.js';
import { hourBucketStart } from './counters.js';
import { summarizeWindow, type TokenUsage, type TokenUsageEntry } from './token-usage.js';

const AT = Date.UTC(2026, 7, 23, 10, 5);
const RANGE = { from: AT - 5 * 60_000, to: AT + 5 * 60_000 };

/** The stored table, keyed as the schema keys it. */
class Rows {
  private readonly rows = new Map<string, TokenUsageEntry>();

  upsert(rows: readonly TokenUsage[], horizonNode: string): void {
    for (const r of rows) {
      this.rows.set(`${r.hourBucket}|${r.tokenId}|${horizonNode}`, {
        ...r,
        at: hourBucketStart(r.hourBucket),
        horizonNode,
      });
    }
  }

  all(): TokenUsageEntry[] {
    return [...this.rows.values()];
  }
}

/** One node's flush: write its running totals, then remember it wrote them. */
function flush(node: TokenCounters, store: Rows, horizonNode: string): void {
  const pending = node.pending();
  if (pending.length === 0) return;
  store.upsert(pending, horizonNode);
  node.markWritten(pending);
}

describe('two replicas serving the same token in the same hour', () => {
  it('reports the deployment total, not whichever node wrote last', () => {
    const store = new Rows();
    const a = new TokenCounters();
    const b = new TokenCounters();
    const use = { tokenId: 'tok', username: 'ci', at: AT };

    for (let i = 0; i < 100; i += 1) a.count(use);
    flush(a, store, 'host-a:boot1');

    for (let i = 0; i < 50; i += 1) b.count(use);
    flush(b, store, 'host-b:boot1');

    // A serves ten more. The cluster has now served 160, and A re-stating its
    // own 110 must not erase B's 50.
    for (let i = 0; i < 10; i += 1) a.count(use);
    flush(a, store, 'host-a:boot1');

    const hour = summarizeWindow(store.all(), RANGE).hours[0];
    expect(hour.total).toBe(160);
    // One credential, however many processes served it.
    expect(hour.credentials).toBe(1);
    expect(hour.top).toHaveLength(1);
    expect(hour.top[0].count).toBe(160);
  });

  it('keeps what a node counted before it restarted', () => {
    const store = new Rows();
    const before = new TokenCounters();
    const use = { tokenId: 'tok', username: 'ci', at: AT };

    for (let i = 0; i < 80; i += 1) before.count(use);
    flush(before, store, 'host-a:boot1');

    // Same host, new process: a fresh boot id, so a fresh row rather than a
    // partial total written over the real one.
    const after = new TokenCounters();
    for (let i = 0; i < 5; i += 1) after.count(use);
    flush(after, store, 'host-a:boot2');

    expect(summarizeWindow(store.all(), RANGE).hours[0].total).toBe(85);
  });

  it('replaying a write leaves the number alone', () => {
    const store = new Rows();
    const node = new TokenCounters();
    const use = { tokenId: 'tok', username: 'ci', at: AT };

    for (let i = 0; i < 7; i += 1) node.count(use);
    const submitted = node.pending();
    // Committed, then the acknowledgement was lost, so it is sent again.
    store.upsert(submitted, 'host-a:boot1');
    store.upsert(submitted, 'host-a:boot1');

    expect(summarizeWindow(store.all(), RANGE).hours[0].total).toBe(7);
  });

  it('counts a credential once even when several nodes served it', () => {
    const store = new Rows();
    for (const [i, node] of ['host-a:boot1', 'host-b:boot1', 'host-c:boot1'].entries()) {
      const c = new TokenCounters();
      c.count({ tokenId: 'shared', username: 'ci', at: AT });
      c.count({ tokenId: `own-${i}`, username: 'ci', at: AT });
      flush(c, store, node);
    }

    const hour = summarizeWindow(store.all(), RANGE).hours[0];
    // Four credentials across six rows — `credentials` counts credentials.
    expect(hour.credentials).toBe(4);
    expect(hour.total).toBe(6);
    expect(hour.top[0]).toMatchObject({ tokenId: 'shared', count: 3 });
  });
});


/**
 * The same property, through the SHIPPED store and the SHIPPED schema.
 *
 * The stub above models the key by hand, so it cannot notice the real one
 * changing — drop `horizon_node` from the PRIMARY KEY and every assertion up
 * there still passes while the deployment silently goes back to one node
 * overwriting another. This runs the real upsert against a real Postgres
 * engine, so the key and its ON CONFLICT target are what is under test.
 */
describe('two replicas, against the real schema', () => {
  let db: PGlite;
  let store: PostgresTokenUsageStore;

  beforeAll(async () => {
    db = new PGlite();
    for (const stmt of SCHEMA_STATEMENTS) await db.query(stmt);
    store = new PostgresTokenUsageStore(
      () => db as unknown as { query: PGlite['query'] } as never,
    );
  }, 120_000);

  afterAll(async () => { await db?.close(); });

  it('sums the nodes rather than letting the last writer win', async () => {
    const hourBucket = 2026082310;
    const row = (horizonNode: string, count: number) =>
      ({ hourBucket, tokenId: 'tok', username: 'ci', count, horizonNode });

    await store.writeUsage([row('host-a:boot1', 100)]);
    await store.writeUsage([row('host-b:boot1', 50)]);
    // A re-states its own total. Writing 110 must not erase B's 50.
    await store.writeUsage([row('host-a:boot1', 110)]);

    const at = hourBucketStart(hourBucket);
    const rows = await store.readWindow({ from: at, to: at + 3_600_000 });
    const { hours } = summarizeWindow(rows, { from: at, to: at + 3_600_000 });

    expect(hours[0].total).toBe(160);
    expect(hours[0].credentials).toBe(1);
  });

  it('takes the ON CONFLICT branch, which a write-once test never reaches', async () => {
    const hourBucket = 2026082311;
    const row = (count: number) =>
      ({ hourBucket, tokenId: 'repeat', username: 'ci', count, horizonNode: 'host-a:boot1' });

    await store.writeUsage([row(5)]);
    await store.writeUsage([row(9)]);   // same key: an UPDATE, not a second row
    await store.writeUsage([row(9)]);   // replayed: still the same number

    const at = hourBucketStart(hourBucket);
    const rows = await store.readWindow({ from: at, to: at + 3_600_000 });
    const { hours } = summarizeWindow(rows, { from: at, to: at + 3_600_000 });

    expect(hours[0].total).toBe(9);
    expect(hours[0].credentials).toBe(1);
  });
});
