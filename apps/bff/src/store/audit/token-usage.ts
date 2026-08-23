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
 * Token usage — a STATISTIC, deliberately not part of the login audit.
 *
 * Presenting a token on a request is not a sign-in: nobody logs in, so there
 * is no moment to record and no principal who just proved themselves. What a token did is a question about traffic. Keeping it out of
 * `horizon_audit` is what lets that table mean one thing — every row is a
 * person getting in — and lets this one answer "how much, how fast, by which
 * credential" without the two grains fighting over one list.
 *
 * The shape is ONE ROW PER TOKEN PER HOUR PER NODE, and the node is in the KEY.
 *
 * Each process owns its own row and writes its own running total into it, so a
 * write is idempotent — replaying it after a commit that timed out leaves the
 * same number. An hour's real total is the SUM of those rows, which is the
 * only arrangement that survives more than one replica: a single cluster-wide
 * row that each node overwrote with its own view would report whichever node
 * wrote last, and would go DOWN as the hour progressed.
 *
 * The node id carries a boot id, so a restart starts a fresh row rather than
 * resuming — the pre-restart count stays where it is and still counts. Nothing
 * has to be read back before writing.
 *
 * This is the same arrangement the sign-in statistic uses, for the same
 * reason. It is backend-agnostic on purpose: Postgres implements it with an
 * upsert, BanyanDB as a Measure, where a write is an upsert natively and the
 * highest `version` wins. Neither mechanism leaks here.
 */

import { hourBucketOf, hourBucketStart } from './counters.js';
import type { StoreStamp } from './types.js';

/** One credential's use within one UTC hour, as ONE PROCESS saw it. */
export interface TokenUsage {
  /** `yyyyMMddHH`, UTC — the same shape the audit statistics use. */
  hourBucket: number;
  /**
   * The credential's id — NEVER the token itself, and never its hash: an id
   * names a credential without being one.
   */
  tokenId: string;
  /** The account the token acts as. Recorded so a reader can answer "whose
   *  token is this" without joining against a config file that may since have
   *  changed. */
  username: string;
  /** Uses in this hour BY THE WRITING PROCESS. Cumulative rather than a
   *  delta, so replaying a write leaves the same number instead of doubling
   *  it. The hour's real total is the sum across nodes. */
  count: number;
}

/** A stored row as read back — still one process's share, not the total. */
export interface TokenUsageEntry extends TokenUsage {
  /** The hour's start, epoch ms — so a reader need not parse `hourBucket`. */
  at: number;
  /** The process whose share this row is. Part of the key. */
  horizonNode: string;
}

/** One credential's hour, merged across every node that served it. Carries no
 *  node: the credential is the deployment's, not any one process's. */
export interface TokenUsageCredential {
  hourBucket: number;
  at: number;
  tokenId: string;
  username: string;
  count: number;
}

/**
 * The most hours a reader may ask for at once, and the cap is deliberate:
 * **one group per hour**. A window is read as a shape — which hours were
 * busy, and who made them busy — and a shape stops being readable long before
 * a database stops being able to answer.
 */
export const MAX_TOKEN_USAGE_HOURS = 12;
/** Default span: a working day's shift pattern without scrolling. */
export const DEFAULT_TOKEN_USAGE_HOURS = 6;

/**
 * Credentials NAMED per hour.
 *
 * The total counts every use; this bounds only how many are listed. An hour
 * with four hundred credentials is a fact about the deployment, not something
 * a reader needs four hundred rows to learn — and the ones that matter are
 * always at the top.
 */
export const TOP_TOKENS_PER_HOUR = 10;

/** A span to report on, in epoch ms. `from` inclusive, `to` exclusive — the
 *  same convention the audit filter uses. */
export interface TokenUsageRange {
  from: number;
  to: number;
}

/** One hour of the window. */
export interface TokenUsageHour {
  hourBucket: number;
  /** The hour's start, epoch ms. */
  at: number;
  /** Every use in the hour, across ALL credentials — not just the listed ones,
   *  so the total never disagrees with itself when the list is truncated. */
  total: number;
  /** How many distinct credentials were used. `credentials > top.length` is
   *  how a reader knows the list is a sample rather than the whole hour. */
  credentials: number;
  /** The busiest, at most `TOP_TOKENS_PER_HOUR`, descending. */
  top: TokenUsageCredential[];
}

/** Every hour in the window, newest first — INCLUDING quiet ones, which are
 *  returned with a zero total rather than omitted. A gap in a time series
 *  reads as missing data; a zero reads as a quiet hour. */
export interface TokenUsageResult {
  hours: TokenUsageHour[];
  /**
   * The bounds actually covered, snapped out to whole buckets.
   *
   * Returned because they are not always the bounds that were asked for: a
   * group is a whole hour, so 10:50–11:10 is answered as 10:00–12:00. A caller
   * that showed the request back to the operator instead of this would be
   * describing a window nobody read.
   */
  range: TokenUsageRange;
}

/**
 * Group a window's rows into hours: the totals, and the busiest credentials.
 *
 * Deliberately NOT expressed as a database query. The row count is bounded by
 * the tokens file — a credential is only ever counted when its id resolves to
 * an entry an operator wrote — so a twelve-hour window is that file's size
 * times twelve, and no engine-side ranking is worth the divergence risk.
 * BanyanDB has no window functions at all, so a store that ranked in SQL would
 * make the two backends answer the same question by different rules. This is
 * the rule, once, for both.
 */
export function summarizeWindow(
  rows: readonly TokenUsageEntry[],
  range: TokenUsageRange,
): TokenUsageResult {
  // A credential served by three replicas has three rows in the hour. They are
  // one credential and one number to a reader, so they are merged before
  // anything is ranked or counted — `credentials` counts credentials, not rows.
  const byHour = new Map<number, Map<string, TokenUsageCredential>>();
  for (const row of rows) {
    let hour = byHour.get(row.hourBucket);
    if (!hour) {
      hour = new Map();
      byHour.set(row.hourBucket, hour);
    }
    const merged = hour.get(row.tokenId);
    if (merged) {
      merged.count += row.count;
      continue;
    }
    hour.set(row.tokenId, {
      hourBucket: row.hourBucket,
      at: hourBucketStart(row.hourBucket),
      tokenId: row.tokenId,
      username: row.username,
      count: row.count,
    });
  }

  // Quiet hours are returned as zeroes, newest first: a gap in a time series
  // reads as missing data, a zero reads as an hour when nothing used a token.
  const hours: TokenUsageHour[] = [];
  for (const bucket of windowBuckets(range)) {
    const credentials = [...(byHour.get(bucket)?.values() ?? [])];
    // Ties broken by id so the same hour ranks the same way on every read —
    // an unstable order would reshuffle the list under an operator's cursor.
    credentials.sort((a, b) => b.count - a.count || a.tokenId.localeCompare(b.tokenId));
    hours.push({
      hourBucket: bucket,
      at: hourBucketStart(bucket),
      total: credentials.reduce((n, c) => n + c.count, 0),
      credentials: credentials.length,
      top: credentials.slice(0, TOP_TOKENS_PER_HOUR),
    });
  }
  const oldest = hours[hours.length - 1];
  const newest = hours[0];
  return {
    hours,
    range: {
      from: oldest ? oldest.at : range.from,
      to: newest ? newest.at + 3_600_000 : range.to,
    },
  };
}

/**
 * The hour buckets a window reports on, NEWEST FIRST.
 *
 * The one place that decides. A store asks for exactly these and a summary
 * renders exactly these — computed twice, they disagreed whenever `from` was
 * not hour-aligned (which a preset never is, since `to` is the current
 * instant), and the oldest bucket was fetched and then silently dropped.
 *
 * A group is a whole hour, so a window is a count of hour groups ending with
 * the one containing `to` — `to` being exclusive, that is the hour containing
 * `to - 1ms`.
 */
export function windowBuckets(range: TokenUsageRange): number[] {
  // EVERY bucket the range touches, not `span` of them anchored at the end.
  // Anchoring under-covered whenever `from` sat mid-hour: 10:50–11:10 touches
  // two buckets and was answered with one, so the first ten minutes asked for
  // were simply absent while time after `to` was counted.
  const newest = hourBucketStart(hourBucketOf(range.to - 1));
  const oldest = hourBucketStart(hourBucketOf(range.from));
  const touched = Math.max(1, Math.round((newest - oldest) / 3_600_000) + 1);
  const count = Math.min(touched, MAX_TOKEN_USAGE_HOURS);
  const out: number[] = [];
  for (let i = 0; i < count; i += 1) out.push(hourBucketOf(newest - i * 3_600_000));
  return out;
}

/**
 * What a backend must provide. Two operations: a write nobody has to read
 * before, and a read.
 */
export interface TokenUsageStore {
  /** Write each process's running totals. Idempotent for a given
   *  `(hourBucket, tokenId, horizonNode)`: writing the same total twice must
   *  leave the same row. */
  writeUsage(rows: ReadonlyArray<TokenUsage & StoreStamp>): Promise<void>;
  /**
   * The stored rows for the window's buckets — raw, one per node per
   * credential per hour, in any order.
   *
   * Rows rather than a summary, so a caller can add what it has not written
   * yet before anything is ranked. A backend that summarised here would force
   * a reader to choose between its own fresh counts and a correct top-N.
   */
  readWindow(range: TokenUsageRange): Promise<TokenUsageEntry[]>;
}
