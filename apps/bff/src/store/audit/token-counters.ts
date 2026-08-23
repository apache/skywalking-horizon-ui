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
 * The in-memory half of token usage: counting on the request path, and
 * deciding what to write.
 *
 * Backend-agnostic by construction — it knows about hours, credentials and
 * counts, and nothing about upserts, measures or SQL.
 *
 * The map needs no size bound. A token id is only ever counted when it
 * resolves against an entry in the tokens file, so the set of distinct
 * credentials is one an operator wrote by hand — bounded by that file, never
 * by traffic and never by a caller.
 *
 * Nothing is read back before writing. This process owns its own row for the
 * hour (the node is in the key), so its own running total is the whole truth
 * it has to keep; the deployment's total is the sum of those rows, taken at
 * read time.
 */

import { hourBucketOf, hourBucketStart } from './counters.js';
import { logger } from '../../logger.js';
import type { TokenUsage, TokenUsageEntry } from './token-usage.js';

/** Hours kept in memory. An hour older than this cannot still be accruing,
 *  and holding it open only risks writing a stale total over a live one. */
export const MAX_TOKEN_HOURS = 3;

interface Cell {
  hourBucket: number;
  tokenId: string;
  username: string;
  /** Uses this process has seen and NOT yet written. */
  pending: number;
  /** What this process has already written for this hour. `pending + stored`
   *  is what gets written next. */
  stored: number;
}

export interface TokenUse {
  tokenId: string;
  username: string;
  at: number;
}

/**
 * Counts token use, and produces the rows a flush should write.
 *
 * A row is this PROCESS's running total for one credential in one hour, and
 * the node is part of the key it is written under — so a store never has to
 * read before writing, and cannot overwrite another node's share by doing so.
 * The deployment's total is the sum across those rows, taken at read time.
 * Both backends inherit that rule from here rather than re-deriving it.
 */
export class TokenCounters {
  private readonly cells = new Map<string, Cell>();

  /** On the request path. Never touches a store, never awaits. */
  count(use: TokenUse): void {
    const hourBucket = hourBucketOf(use.at);
    const key = `${hourBucket}|${use.tokenId}`;
    const existing = this.cells.get(key);
    if (existing) {
      existing.pending += 1;
      return;
    }
    this.evict(hourBucket);
    this.cells.set(key, {
      hourBucket,
      tokenId: use.tokenId,
      username: use.username,
      pending: 1,
      stored: 0,
    });
  }

  /** Uses this process has counted and not yet written. Zero once a flush has
   *  been acknowledged; non-zero at shutdown means they died with it. */
  unwritten(): number {
    let n = 0;
    for (const c of this.cells.values()) n += c.pending;
    return n;
  }

  /**
   * The unwritten DELTA as readable rows, for a page that must not wait for a
   * flush to see a use.
   *
   * `count` is `pending` alone — what the store already holds is `stored`, and
   * a reader adds these on top of what it read. Stamped like any other row, so
   * the summary merges them by credential exactly as it merges two replicas.
   */
  pendingEntries(stamp: { horizonNode: string }): TokenUsageEntry[] {
    const out: TokenUsageEntry[] = [];
    for (const c of this.cells.values()) {
      if (c.pending === 0) continue;
      out.push({
        hourBucket: c.hourBucket,
        at: hourBucketStart(c.hourBucket),
        tokenId: c.tokenId,
        username: c.username,
        count: c.pending,
        horizonNode: stamp.horizonNode,
      });
    }
    return out;
  }

  /** This process's running totals for every hour holding unwritten use. */
  pending(): TokenUsage[] {
    const out: TokenUsage[] = [];
    for (const c of this.cells.values()) {
      if (c.pending === 0) continue;
      out.push({
        hourBucket: c.hourBucket,
        tokenId: c.tokenId,
        username: c.username,
        count: c.stored + c.pending,
      });
    }
    return out;
  }

  /**
   * Move the written total into `stored`.
   *
   * Only what was SUBMITTED, not the live count: uses that arrived while the
   * write was in flight stay pending, or they would be marked stored without
   * ever having been sent.
   */
  markWritten(written: readonly TokenUsage[]): void {
    for (const row of written) {
      const cell = this.cells.get(`${row.hourBucket}|${row.tokenId}`);
      if (!cell) continue;
      const justWritten = row.count - cell.stored;
      cell.stored = row.count;
      cell.pending = Math.max(0, cell.pending - justWritten);
    }
  }

  private evict(incoming: number): void {
    const hours = [...new Set([...this.cells.values()].map((c) => c.hourBucket).concat(incoming))]
      .sort((a, b) => a - b);
    const doomed = new Set(hours.slice(0, Math.max(0, hours.length - MAX_TOKEN_HOURS)));
    doomed.delete(incoming);
    if (doomed.size === 0) return;
    let dropped = 0;
    for (const [key, c] of this.cells) {
      if (!doomed.has(c.hourBucket)) continue;
      dropped += c.pending;
      this.cells.delete(key);
    }
    // Only reachable if the store was unwritable for hours. Said out loud
    // because it is data loss, and a counter nothing reads would not be.
    if (dropped > 0) {
      logger.warn(
        { uses: dropped, hours: [...doomed] },
        'audit: token uses dropped — their hour aged out before the store accepted a write',
      );
    }
  }
}
