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
 * The contract these screens rely on: an unresolvable range REFUSES, and never
 * resolves to a different window. Every refusal returns a key the caller
 * translates, so a new message cannot slip in untranslated.
 */

import { describe, it, expect } from 'vitest';
import {
  resolveRecordRange,
  recordRangeWarning,
  MAX_RECORD_RANGE_MS,
  SLOW_RECORD_RANGE_MS,
} from './recordTimeRange';

const START = '2026-08-01T00:00';
const END = '2026-08-02T00:00';

describe('resolveRecordRange', () => {
  it('resolves a well-formed range to its bounds', () => {
    const r = resolveRecordRange(START, END);

    expect(typeof r).toBe('object');
    expect((r as { endMs: number }).endMs - (r as { startMs: number }).startMs).toBe(86_400_000);
  });

  it.each<[string | null, string | null, string]>([
    ['', END, 'a missing start'],
    [START, '', 'a missing end'],
    [null, null, 'neither'],
  ])('refuses an incomplete range (%s, %s — %s)', (s, e) => {
    expect(resolveRecordRange(s, e)).toBe('Pick both a start and an end.');
  });

  it('refuses an unparseable date rather than falling back to a default window', () => {
    expect(resolveRecordRange('not-a-date', END)).toBe('Invalid date');
  });

  it('refuses a reversed range', () => {
    expect(resolveRecordRange(END, START)).toBe('End must be after start');
  });

  // Zero-width is reversed's neighbour and the one the BFF used to let through:
  // `endMs < startMs` admitted an empty window.
  it('refuses a zero-width range', () => {
    expect(resolveRecordRange(START, START)).toBe('End must be after start');
  });

  it('accepts a range exactly at the cap and refuses one past it', () => {
    const from = new Date('2026-08-01T00:00:00Z').getTime();
    const at = new Date(from + MAX_RECORD_RANGE_MS).toISOString();
    const past = new Date(from + MAX_RECORD_RANGE_MS + 60_000).toISOString();

    expect(resolveRecordRange(new Date(from).toISOString(), at)).toHaveProperty('startMs');
    expect(resolveRecordRange(new Date(from).toISOString(), past)).toBe('Window exceeds {d}d cap');
  });
});

describe('recordRangeWarning', () => {
  const H = 3_600_000;

  it('stays quiet at and below the threshold, warns above it', () => {
    expect(recordRangeWarning(SLOW_RECORD_RANGE_MS)).toBeNull();
    expect(recordRangeWarning(SLOW_RECORD_RANGE_MS + 1)).not.toBeNull();
  });

  // The views feed this in different units — one has milliseconds already
  // (zipkin's lookback), the rest multiply minutes by 60_000. A unit slip
  // shows up as a warning on a 30-minute preset or silence on a 24-hour one.
  it.each([
    [30 * 60_000, false, 'a 30-minute preset'],
    [6 * 60 * 60_000, false, 'a 6-hour preset, exactly at the line'],
    [12 * 60 * 60_000, true, 'a 12-hour preset'],
    [24 * 60 * 60_000, true, 'a 24-hour preset'],
    [18 * H, true, 'an 18-hour custom span'],
  ])('%s ms -> warns=%s (%s)', (span, warns) => {
    expect(recordRangeWarning(span) !== null).toBe(warns);
  });

  it('says nothing when there is no resolvable span', () => {
    expect(recordRangeWarning(null)).toBeNull();
    expect(recordRangeWarning(undefined)).toBeNull();
    expect(recordRangeWarning(Number.NaN)).toBeNull();
  });

  it('warns well before the hard cap refuses, so the two never contradict', () => {
    expect(SLOW_RECORD_RANGE_MS).toBeLessThan(MAX_RECORD_RANGE_MS);
    expect(recordRangeWarning(MAX_RECORD_RANGE_MS)).not.toBeNull();
  });
});
