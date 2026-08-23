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

import { describe, it, expect } from 'vitest';
import { hourBucketOf, hourBucketStart } from './counters.js';
import {
  summarizeWindow,
  windowBuckets,
  MAX_TOKEN_USAGE_HOURS,
  TOP_TOKENS_PER_HOUR,
  type TokenUsageEntry,
} from './token-usage.js';

const HOUR_MS = 3_600_000;
/** A window ending exactly on an hour boundary, so the arithmetic is legible. */
const TO = Date.UTC(2026, 7, 23, 12, 0, 0);

function entry(hourAt: number, tokenId: string, count: number): TokenUsageEntry {
  const hourBucket = hourBucketOf(hourAt);
  return {
    hourBucket,
    at: hourBucketStart(hourBucket),
    tokenId,
    username: 'sre',
    count,
    horizonNode: 'n1',
  };
}

describe('summarizing a token usage window', () => {
  it('totals every credential in the hour, not just the listed ones', () => {
    const rows = Array.from({ length: 25 }, (_, i) =>
      entry(TO - HOUR_MS, `tok${String(i).padStart(2, '0')}`, 100 - i));

    const { hours } = summarizeWindow(rows, { from: TO - HOUR_MS, to: TO });
    const hour = hours[0];

    // The whole point of the shape: what is shown is a sample, what is
    // counted is everything. A truncated list must never make the header lie.
    expect(hour.top).toHaveLength(TOP_TOKENS_PER_HOUR);
    expect(hour.credentials).toBe(25);
    expect(hour.total).toBe(rows.reduce((n, r) => n + r.count, 0));
    expect(hour.total).toBeGreaterThan(hour.top.reduce((n, r) => n + r.count, 0));
  });

  it('lists the busiest, and breaks ties by id so a reread does not reshuffle', () => {
    const rows = [
      entry(TO - HOUR_MS, 'quiet', 1),
      entry(TO - HOUR_MS, 'zeta', 50),
      entry(TO - HOUR_MS, 'alpha', 50),
      entry(TO - HOUR_MS, 'busiest', 900),
    ];

    const { hours } = summarizeWindow(rows, { from: TO - HOUR_MS, to: TO });

    expect(hours[0].top.map((r) => r.tokenId)).toEqual(['busiest', 'alpha', 'zeta', 'quiet']);
  });

  it('says so when nothing was dropped', () => {
    const rows = [entry(TO - HOUR_MS, 'only', 3)];

    const { hours } = summarizeWindow(rows, { from: TO - HOUR_MS, to: TO });

    // `credentials === top.length` is what the page reads to decide between
    // "every credential" and "top N of M". It has to hold exactly.
    expect(hours[0].credentials).toBe(hours[0].top.length);
  });

  it('returns a quiet hour as a zero rather than omitting it', () => {
    const rows = [entry(TO - HOUR_MS, 'recent', 5)];

    const { hours } = summarizeWindow(rows, { from: TO - 3 * HOUR_MS, to: TO });

    expect(hours).toHaveLength(3);
    expect(hours.map((h) => h.total)).toEqual([5, 0, 0]);
    expect(hours[1].top).toEqual([]);
  });

  it('orders hours newest first', () => {
    const rows = [
      entry(TO - 3 * HOUR_MS, 'old', 1),
      entry(TO - HOUR_MS, 'new', 2),
    ];

    const { hours } = summarizeWindow(rows, { from: TO - 3 * HOUR_MS, to: TO });

    expect(hours.map((h) => h.hourBucket)).toEqual([...hours.map((h) => h.hourBucket)].sort((a, b) => b - a));
  });

  it('never returns more hours than the readable cap', () => {
    const { hours } = summarizeWindow([], { from: TO - 48 * HOUR_MS, to: TO });

    expect(hours).toHaveLength(MAX_TOKEN_USAGE_HOURS);
  });

  it('reports the hour containing `to`, and not the one starting at it', () => {
    // `to` is exclusive. A window ending exactly on the hour must not open a
    // group for an hour it does not cover — that group would always be empty.
    const { hours } = summarizeWindow([], { from: TO - HOUR_MS, to: TO });

    expect(hours).toHaveLength(1);
    expect(hours[0].hourBucket).toBe(hourBucketOf(TO - 1));
  });
});

describe('the buckets a store is asked for, and the ones a page renders', () => {
  /**
   * A preset span is never hour-aligned — `to` is the current instant — and
   * these two used to be computed apart. Whenever they disagreed the extra
   * bucket was read from the database and then dropped on the floor.
   */
  it('renders exactly the buckets it names, aligned or not', () => {
    for (const to of [Date.UTC(2026, 7, 23, 12, 0), Date.UTC(2026, 7, 23, 12, 30)]) {
      const range = { from: to - 6 * HOUR_MS, to };
      const named = windowBuckets(range);
      const rendered = summarizeWindow([], range).hours.map((h) => h.hourBucket);
      expect(rendered).toEqual(named);
    }
  });

  it('renders one group per hour when the range is on bucket boundaries', () => {
    const to = Date.UTC(2026, 7, 23, 12, 0);
    expect(windowBuckets({ from: to - 6 * HOUR_MS, to })).toHaveLength(6);
    expect(windowBuckets({ from: to - 12 * HOUR_MS, to })).toHaveLength(12);
  });

  /**
   * A range that starts mid-hour touches one more bucket than its length in
   * hours, and every one of them has to be reported: answering 10:50–11:10
   * with the 11:00 group alone drops the ten minutes actually asked for while
   * counting fifty that were not.
   */
  it('covers every bucket an unaligned range touches', () => {
    const from = Date.UTC(2026, 7, 23, 10, 50);
    const to = Date.UTC(2026, 7, 23, 11, 10);

    const buckets = windowBuckets({ from, to });

    expect(buckets).toEqual([hourBucketOf(to - 1), hourBucketOf(from)]);
    expect(buckets).toHaveLength(2);
  });

  it('never exceeds the cap, however many buckets a range touches', () => {
    const to = Date.UTC(2026, 7, 23, 12, 30);

    expect(windowBuckets({ from: to - 100 * HOUR_MS, to })).toHaveLength(MAX_TOKEN_USAGE_HOURS);
  });

  it('counts every row it was handed, so nothing read is silently discarded', () => {
    const to = Date.UTC(2026, 7, 23, 12, 30);
    const range = { from: to - 6 * HOUR_MS, to };
    // One row in each bucket the store would be asked for.
    const rows = windowBuckets(range).map((b, i) =>
      entry(hourBucketStart(b), `tok${i}`, 10));

    const { hours } = summarizeWindow(rows, range);

    expect(hours.reduce((n, h) => n + h.total, 0)).toBe(rows.length * 10);
  });
});
