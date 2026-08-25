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

import { describe, it, expect, vi } from 'vitest';
import type pg from 'pg';
import { timed, withClient } from './deadline.js';
import { AuditStoreError } from '../types.js';

/** A pool whose client answers when told to, and not before. */
function pool(behaviour: 'resolves' | 'hangs') {
  const released: Array<Error | undefined> = [];
  const client = {
    query: vi.fn(() =>
      behaviour === 'resolves' ? Promise.resolve({ rows: [] }) : new Promise(() => {})),
    release: vi.fn((err?: Error) => released.push(err)),
  };
  const connect = vi.fn(() => Promise.resolve(client));
  return { pool: { connect } as unknown as pg.Pool, client, released };
}

describe('the client-side operation deadline', () => {
  it('passes a normal query through and returns the client to the pool', async () => {
    const { pool: p, released } = pool('resolves');

    await expect(timed(p, 50).query('SELECT 1')).resolves.toEqual({ rows: [] });

    expect(released).toEqual([undefined]);
  });

  /**
   * The failure `statement_timeout` cannot reach: the server accepted the
   * connection and then stopped answering, so there is nothing to receive and
   * no error to receive it as. Without this the flush never returns and every
   * later write queues behind it.
   */
  it('gives up on a query that never answers', async () => {
    vi.useFakeTimers();
    try {
      const { pool: p } = pool('hangs');
      const inFlight = timed(p, 50).query('SELECT pg_sleep(600)');
      const assertion = expect(inFlight).rejects.toBeInstanceOf(AuditStoreError);
      await vi.advanceTimersByTimeAsync(60);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * And DESTROYS the connection. The query is still outstanding on that
   * socket, so returning it to the pool hands the next caller a client that
   * will deliver someone else's result set.
   */
  it('destroys the connection it gave up on rather than reusing it', async () => {
    vi.useFakeTimers();
    try {
      const { pool: p, released } = pool('hangs');
      const inFlight = timed(p, 50).query('SELECT pg_sleep(600)');
      const assertion = expect(inFlight).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(60);
      await assertion;

      expect(released).toHaveLength(1);
      expect(released[0]).toBeInstanceOf(Error);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports the give-up as a timeout, which health already knows how to read', async () => {
    vi.useFakeTimers();
    try {
      const { pool: p } = pool('hangs');
      const inFlight = timed(p, 50).query('SELECT 1');
      const assertion = expect(inFlight).rejects.toMatchObject({ code: 'timeout' });
      await vi.advanceTimersByTimeAsync(60);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('a borrowed-client block', () => {
  /**
   * Migration and the probe hold a client across several statements, and
   * migration turns `statement_timeout` off outright. `open()` is awaited
   * before the retry timer exists, so an unbounded hang here strands startup
   * with nothing to recover it.
   */
  it('gives up on a block that never finishes, and destroys the client', async () => {
    vi.useFakeTimers();
    try {
      const { pool: p, released } = pool('hangs');
      const inFlight = withClient(p, 50, async (c) => {
        await (c as unknown as { query: () => Promise<unknown> }).query();
      });
      const assertion = expect(inFlight).rejects.toMatchObject({ code: 'timeout' });
      await vi.advanceTimersByTimeAsync(60);
      await assertion;

      expect(released).toHaveLength(1);
      expect(released[0], 'the client was returned to the pool mid-statement').toBeInstanceOf(Error);
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns the block result and releases cleanly when it finishes in time', async () => {
    const { pool: p, released } = pool('resolves');

    await expect(withClient(p, 50, async () => 'done')).resolves.toBe('done');

    expect(released).toEqual([undefined]);
  });
});
