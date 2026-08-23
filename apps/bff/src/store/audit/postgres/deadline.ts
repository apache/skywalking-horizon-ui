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
 * A client-side deadline on every database operation.
 *
 * `statement_timeout` is enforced by the SERVER, which means it does nothing
 * for the failures that matter most here: a peer that accepted the connection
 * and then stopped answering, a network that black-holes the response, a
 * failover that leaves the socket open to nothing. In all three the query
 * never returns and never errors, so a caller that only awaits it waits
 * forever — and because the audit service awaits its flush inside a single
 * timer tick, one such query stalls every later write behind it.
 *
 * The deadline also has to DESTROY the connection rather than release it. A
 * client whose query is still outstanding is not idle: returning it to the
 * pool hands the next caller a socket that will deliver someone else's result
 * set. `release(err)` is what removes it — the pool opens a fresh one on the
 * next acquire, and closing the socket is what tells the server to abandon the
 * query it is still running.
 */

import type pg from 'pg';
import { AuditStoreError } from '../types.js';

/** What the stores use in place of a pool: the same two calls, deadlined. */
export interface TimedDb {
  query: pg.Pool['query'];
  connect: pg.Pool['connect'];
}

/**
 * Run a borrowed-client block under the same deadline.
 *
 * `connect()` cannot be bounded the way `query` is — its caller owns the
 * client across several statements — so the block AS A WHOLE gets the clock
 * instead. This is the path migration and the probe take, and migration
 * disables `statement_timeout` outright, so without this a black-holed
 * connection leaves startup pending forever: `open()` never returns, and the
 * retry timer that would have recovered it is installed after `open()`.
 *
 * The client is destroyed on expiry for the same reason a timed-out query's
 * is: statements are still outstanding on that socket.
 */
export async function withClient<T>(
  pool: pg.Pool,
  deadlineMs: number,
  run: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let timer: NodeJS.Timeout | undefined;
  let expired = false;
  try {
    return await Promise.race([
      run(client),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          expired = true;
          reject(new AuditStoreError('timeout'));
        }, deadlineMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    client.release(expired ? new Error('audit: operation deadline exceeded') : undefined);
  }
}

/**
 * Wrap a pool so every `query` is bounded by `deadlineMs`.
 *
 * `connect` is passed through for callers that own a client across several
 * statements; those bound the whole block with `withClient` instead.
 */
export function timed(pool: pg.Pool, deadlineMs: number): TimedDb {
  const query = (async (...args: unknown[]) => {
    const client = await pool.connect();
    let timer: NodeJS.Timeout | undefined;
    let expired = false;
    try {
      return await Promise.race([
        (client.query as (...a: unknown[]) => Promise<unknown>)(...args),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            expired = true;
            reject(new AuditStoreError('timeout'));
          }, deadlineMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      // An expired query is still in flight on this socket. Destroy it: the
      // result would otherwise arrive for whoever acquires the client next.
      client.release(expired ? new Error('audit: operation deadline exceeded') : undefined);
    }
  }) as pg.Pool['query'];

  return { query, connect: pool.connect.bind(pool) };
}
