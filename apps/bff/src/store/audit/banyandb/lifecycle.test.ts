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
 * What `open()` is allowed to allocate.
 *
 * The store is opened again on every service tick while the audit log is
 * unavailable, and again whenever a write channel is in fault. Constructing a
 * BanyanDB client builds a gRPC channel — with its own sockets and reconnect
 * backoff timers — in the constructor, and only the newest one was ever
 * reachable by `close()`. So an outage leaked a channel per tick, indefinitely,
 * while the contract in `types.ts` promised `open()` was idempotent.
 *
 * These assert the counts rather than the behaviour: a leak is invisible in
 * every functional test, which is exactly why it survived.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const built: Array<{ closed: number }> = [];
const UNCHANGED = { action: 'unchanged' as const, modRevision: '1', changed: [] };
let connectFails = false;

vi.mock('../../../client/banyandb/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../client/banyandb/index.js')>();
  return {
    ...actual,
    BanyanDBClient: class {
      private readonly self = { closed: 0 };
      constructor() {
        built.push(this.self);
      }
      async connect(): Promise<void> {
        if (connectFails) throw new Error('connection refused');
      }
      close(): void {
        this.self.closed += 1;
      }
      // Reached only when a connect succeeds. `open()` always applies the
      // schema, and every resource reports `unchanged` here so no barrier
      // wait is entered — these tests are about what gets ALLOCATED.
      readonly schema = {
        group: async () => UNCHANGED,
        stream: async () => UNCHANGED,
        measure: async () => UNCHANGED,
        indexRule: async () => UNCHANGED,
        indexRuleBinding: async () => UNCHANGED,
      };
    },
  };
});

const { BanyanDBAuditStore } = await import('./store.js');

function store(): InstanceType<typeof BanyanDBAuditStore> {
  return new BanyanDBAuditStore({
    namespace: '',
    retentionDays: 7,
    connection: { kind: 'banyandb', address: '127.0.0.1:17912', deadlineMs: 1000 },
  });
}

beforeEach(() => {
  built.length = 0;
  connectFails = false;
});

describe('opening the BanyanDB audit store', () => {
  it('builds ONE client however many times the service retries', async () => {
    const s = store();

    // The store opens and stays open; the service's tick calls this again on
    // every pass while a write channel is in fault.
    await s.open();
    await s.open();
    await s.open();

    expect(built).toHaveLength(1);
    await s.close();
  });

  it('builds one client when two callers open at the same time', async () => {
    const s = store();

    await Promise.all([s.open(), s.open(), s.open()]);

    expect(built).toHaveLength(1);
    await s.close();
  });

  it('closes the client it built when opening fails', async () => {
    connectFails = true;
    const s = store();

    await expect(s.open()).rejects.toThrow();

    // Built one, and disposed it: a retry starts from nothing rather than
    // orphaning the channel this attempt allocated.
    expect(built).toHaveLength(1);
    expect(built[0]?.closed).toBe(1);
  });

  it('leaves nothing behind across a run of failed retries', async () => {
    connectFails = true;
    const s = store();

    for (let i = 0; i < 5; i += 1) await expect(s.open()).rejects.toThrow();

    expect(built).toHaveLength(5);
    // Every one disposed — the count that a leak would fail.
    expect(built.every((c) => c.closed === 1)).toBe(true);
  });

  it('reopens after a close, and closes only once', async () => {
    const s = store();

    await s.open();
    await s.close();
    await s.open();

    expect(built).toHaveLength(2);
    expect(built[0]?.closed).toBe(1);
    expect(built[1]?.closed).toBe(0);
    await s.close();
  });

  it('does not publish a client that a close raced past', async () => {
    const s = store();

    // A close entered while the open is still in flight: the client the open
    // built must be disposed rather than published, or it is unreachable for
    // the life of the process and holds the event loop open at shutdown.
    const opening = s.open();
    await s.close();
    await opening;

    expect(built).toHaveLength(1);
    expect(built[0]?.closed).toBe(1);
  });
});
