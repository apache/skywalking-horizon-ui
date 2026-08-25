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
 * The Postgres half of token usage — the FIRST implementation of
 * `TokenUsageStore`, not the only one. Everything backend-specific stops
 * here: what a row means lives in `TokenCounters`, and how a window is
 * grouped lives in `summarizeWindow`, so a second backend inherits both
 * rather than re-deriving them. All this file owes is an idempotent upsert
 * keyed on `(hour_bucket, token_id, horizon_node)` and a range read.
 */

import { hourBucketStart } from '../counters.js';
import { toNumber } from './rows.js';
import { fail } from './errors.js';
import type { TimedDb } from './deadline.js';
import { USAGE_COLUMNS } from './schema.js';
import {
  windowBuckets,
  type TokenUsage,
  type TokenUsageEntry,
  type TokenUsageStore,
  type TokenUsageRange,
} from '../token-usage.js';
import type { StoreStamp } from '../types.js';

/** Rows per statement, matching the audit writer's chunking. */
const CHUNK_ROWS = 500;

interface RawRow {
  hour_bucket: unknown;
  token_id: string;
  username: string;
  count: unknown;
  horizon_node: string;
}

function toEntry(row: RawRow): TokenUsageEntry {
  const hourBucket = toNumber(row.hour_bucket, 'hour_bucket');
  return {
    hourBucket,
    at: hourBucketStart(hourBucket),
    tokenId: row.token_id,
    username: row.username,
    count: toNumber(row.count, 'count'),
    horizonNode: row.horizon_node,
  };
}

const COLUMNS = USAGE_COLUMNS.join(', ');

/** `($1,$2,…),($7,$8,…)` for a multi-row insert. */
function valuesClause(rows: number, cols: number): string {
  const out: string[] = [];
  for (let r = 0; r < rows; r += 1) {
    const ps: string[] = [];
    for (let c = 1; c <= cols; c += 1) ps.push(`$${r * cols + c}`);
    out.push(`(${ps.join(',')})`);
  }
  return out.join(',');
}

export class PostgresTokenUsageStore implements TokenUsageStore {
  /**
   * A GETTER, not a pool.
   *
   * The pool does not exist until `open()` builds it, and this store is
   * constructed alongside the audit store at boot — resolving it eagerly
   * threw `unreachable` before the process had finished starting.
   */
  constructor(private readonly pool: () => Pick<TimedDb, 'query'>) {}

  private get db(): Pick<TimedDb, 'query'> {
    return this.pool();
  }

  async writeUsage(rows: ReadonlyArray<TokenUsage & StoreStamp>): Promise<void> {
    try {
      await this.upsert(rows);
    } catch (err) {
      fail(err);
    }
  }

  private async upsert(rows: ReadonlyArray<TokenUsage & StoreStamp>): Promise<void> {
    for (let i = 0; i < rows.length; i += CHUNK_ROWS) {
      const chunk = rows.slice(i, i + CHUNK_ROWS);
      const params = chunk.flatMap((r) => [
        r.hourBucket, r.tokenId, r.username, r.count, r.horizonNode,
      ]);
      // The count is this node's running total, so the update overwrites
      // rather than adds: writing the same total twice leaves the same row,
      // which is what makes a retry after a commit-then-timeout safe. Other
      // nodes have their own rows and are never touched.
      await this.db.query(
        `INSERT INTO horizon_token_usage (${COLUMNS}) VALUES ${valuesClause(chunk.length, USAGE_COLUMNS.length)} ` +
          `ON CONFLICT (hour_bucket, token_id, horizon_node) ` +
          `DO UPDATE SET count = EXCLUDED.count, username = EXCLUDED.username`,
        params,
      );
    }
  }

  async readWindow(range: TokenUsageRange): Promise<TokenUsageEntry[]> {
    try {
      return await this.rowsFor(range);
    } catch (err) {
      return fail(err);
    }
  }

  private async rowsFor(range: TokenUsageRange): Promise<TokenUsageEntry[]> {
    // Exactly the buckets the summary will render — see `windowBuckets`.
    const buckets = windowBuckets(range);
    const res = await this.db.query<RawRow>(
      `SELECT ${COLUMNS} FROM horizon_token_usage WHERE hour_bucket >= $1 AND hour_bucket <= $2`,
      [buckets[buckets.length - 1], buckets[0]],
    );
    return res.rows.map(toEntry);
  }
}
