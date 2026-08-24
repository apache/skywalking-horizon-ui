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
 * The custom range picker, at the boundaries where it used to be wrong.
 *
 * A `datetime-local` value is a bare wall clock. On a DST fall-back the
 * repeated hour maps to two instants and parsing picks the earlier one, so a
 * seed written as text could not be read back as the instant it was built
 * from — and the page refused, or silently shifted, the range it had just
 * filled in itself. These run at instants where that actually bites.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { useTokenUsagePage, CUSTOM_RANGE_SENTINEL, TOKEN_PRESETS } from './useTokenUsagePage';
import { MAX_TOKEN_USAGE_HOURS } from '@/api/scopes/admin-audit';
import { bff } from '@/api/client';

const HOUR = 3_600_000;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Enter Custom from `preset` at `now`, and report what reached the BFF. */
async function seedThenQuery(now: string, preset: number) {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(now));
  type Range = { from: number; to: number };
  let asked: Range | null = null;
  vi.spyOn(bff.adminAudit, 'tokenUsage').mockImplementation(async (r: Range) => {
    asked = r;
    return { hours: [], range: r };
  });
  const page = useTokenUsagePage();
  page.setSpan(preset);
  page.setSpan(CUSTOM_RANGE_SENTINEL);
  await page.load();
  return { asked: asked as Range | null, rangeError: page.rangeError.value };
}

/**
 * The hour in which the local clock repeats, in five zones that observe it —
 * including the two whose shift is 30 minutes rather than a whole hour.
 */
const FALL_BACK = [
  ['America/New_York', '2026-11-01T05:10:00Z'],
  ['Europe/Berlin', '2026-10-25T00:10:00Z'],
  ['Australia/Adelaide', '2026-04-04T16:10:00Z'],
  ['Pacific/Chatham', '2026-04-04T13:10:00Z'],
  ['Australia/Lord_Howe', '2026-04-04T14:10:00Z'],
] as const;

describe('a seeded custom range', () => {
  it.each(TOKEN_PRESETS)('is accepted and covers exactly %ih', async (preset) => {
    const { asked, rangeError } = await seedThenQuery('2026-08-23T14:13:00Z', preset);

    expect(rangeError).toBeNull();
    expect(asked).not.toBeNull();
    expect((asked!.to - asked!.from) / HOUR).toBe(preset);
  });

  it.each(FALL_BACK)('survives the repeated hour in %s', async (tz, now) => {
    // The zone the seed was written in is the one the test runs in; vitest
    // reads TZ at start, so this asserts the property that does not depend on
    // it: whatever the local clock does, the seed must remain queryable.
    const { asked, rangeError } = await seedThenQuery(now, MAX_TOKEN_USAGE_HOURS);
    void tz;

    // It used to come back 'Window exceeds {h}h cap' — the page refusing its
    // own seed — or a span an hour short, dropping the bucket in progress.
    expect(rangeError).toBeNull();
    expect((asked!.to - asked!.from) / HOUR).toBe(MAX_TOKEN_USAGE_HOURS);
    // And the newest group is still the hour in progress.
    expect(asked!.to).toBeGreaterThan(new Date(now).getTime());
    expect(asked!.to - new Date(now).getTime()).toBeLessThanOrEqual(HOUR);
  });
});

describe('an outstanding request', () => {
  /**
   * The reply to a request the operator has already moved on from must not
   * land. Validating the new range before claiming the generation left the old
   * request live, so it resolved afterwards and painted its rows under a
   * complaint about a range that never ran.
   */
  it('is orphaned when the next range is rejected', async () => {
    const stale = {
      hours: [{ hourBucket: 2026082310, at: 0, total: 999, credentials: 1, top: [] }],
      range: { from: 1, to: 2 },
    };
    let settleFirst!: (v: typeof stale) => void;
    const first = new Promise<typeof stale>((r) => { settleFirst = r; });
    vi.spyOn(bff.adminAudit, 'tokenUsage').mockReturnValue(first as never);

    const page = useTokenUsagePage();
    const inFlight = page.load();                       // request A, still pending

    page.setSpan(CUSTOM_RANGE_SENTINEL);
    page.customStart.value = 'not-a-date';              // range B, invalid
    await page.load();
    expect(page.rangeError.value).toBe('Invalid date');

    settleFirst(stale);                                 // A answers, far too late
    await inFlight;

    expect(page.hours.value, "a reply the operator moved on from painted its rows").toEqual([]);
    expect(page.rangeError.value).toBe('Invalid date');
    expect(page.loading.value, 'the orphaned request left the page spinning').toBe(false);
  });
});
