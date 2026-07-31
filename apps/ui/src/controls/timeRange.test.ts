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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { nextTick } from 'vue';
import { useAutoRefreshStore } from './autoRefresh';
import {
  STEP_LIMITS,
  TIME_PRESETS,
  isValidRange,
  stepForMinutes,
  useTimeRangeStore,
  type TimeStep,
} from './timeRange';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Finest → coarsest. `stepForMinutes` must always land on the first entry
 *  whose limits still accept the window. */
const STEPS: TimeStep[] = ['MINUTE', 'HOUR', 'DAY'];

/** Bucket size OAP emits per step — the caps exist to bound bucket count. */
const BUCKET_MS: Record<TimeStep, number> = { MINUTE: MIN, HOUR: HOUR, DAY: DAY };

/** Window lengths in minutes spanning the whole ladder, with both sides of
 *  every threshold. */
const SAMPLE_MINUTES = [
  1, 5, 30, 59, 60, 120, 239, 240, 241, 360, 720, 1439, 1440, 4320, 10080, 20159, 20160, 20161,
  43200, 86400, 133920,
];

describe('STEP_LIMITS — OAP downsampling caps', () => {
  it('pins the exact per-step window bounds', () => {
    // These numbers are the contract with OAP's per-request bucket cap.
    // Widening one silently starts producing over-long dashboard queries.
    expect(STEP_LIMITS.MINUTE).toEqual({ minMs: 1 * MIN, maxMs: 4 * HOUR });
    expect(STEP_LIMITS.HOUR).toEqual({ minMs: 1 * HOUR, maxMs: 14 * DAY });
    expect(STEP_LIMITS.DAY).toEqual({ minMs: 1 * DAY, maxMs: 93 * DAY });
  });

  it('each cap is a whole number of buckets, and bounded well under 1440 per series', () => {
    const buckets = (s: TimeStep) => STEP_LIMITS[s].maxMs / BUCKET_MS[s];
    expect(buckets('MINUTE')).toBe(240);
    expect(buckets('HOUR')).toBe(336);
    expect(buckets('DAY')).toBe(93);
    for (const s of STEPS) {
      expect(Number.isInteger(buckets(s))).toBe(true);
      expect(buckets(s)).toBeLessThan(1440);
      // A window shorter than one bucket would render a single empty point.
      expect(STEP_LIMITS[s].minMs).toBe(BUCKET_MS[s]);
    }
  });

  it('the ladder is ordered and GAPLESS — no window falls between two steps', () => {
    expect(STEP_LIMITS.MINUTE.maxMs).toBeLessThan(STEP_LIMITS.HOUR.maxMs);
    expect(STEP_LIMITS.HOUR.maxMs).toBeLessThan(STEP_LIMITS.DAY.maxMs);
    // The next step up must start at or below where the previous one ends,
    // otherwise a custom range in the gap is rejected at every precision.
    expect(STEP_LIMITS.HOUR.minMs).toBeLessThanOrEqual(STEP_LIMITS.MINUTE.maxMs);
    expect(STEP_LIMITS.DAY.minMs).toBeLessThanOrEqual(STEP_LIMITS.HOUR.maxMs);
    for (const minutes of SAMPLE_MINUTES) {
      expect(STEPS.some((s) => isValidRange(s, minutes * MIN))).toBe(true);
    }
  });
});

describe('stepForMinutes — window length → step precision', () => {
  it('stays MINUTE up to and including 4 h, flips to HOUR one minute later', () => {
    expect(stepForMinutes(1)).toBe('MINUTE');
    expect(stepForMinutes(60)).toBe('MINUTE');
    expect(stepForMinutes(239)).toBe('MINUTE');
    expect(stepForMinutes(240)).toBe('MINUTE'); // exactly 4 h — inclusive
    expect(stepForMinutes(241)).toBe('HOUR');
  });

  it('stays HOUR up to and including 14 d, flips to DAY one minute later', () => {
    expect(stepForMinutes(360)).toBe('HOUR');
    expect(stepForMinutes(1440)).toBe('HOUR');
    expect(stepForMinutes(20159)).toBe('HOUR');
    expect(stepForMinutes(20160)).toBe('HOUR'); // exactly 14 d — inclusive
    expect(stepForMinutes(20161)).toBe('DAY');
  });

  it('flips exactly at the STEP_LIMITS caps — thresholds and limits cannot drift apart', () => {
    const minuteCap = STEP_LIMITS.MINUTE.maxMs / MIN;
    const hourCap = STEP_LIMITS.HOUR.maxMs / MIN;
    expect(stepForMinutes(minuteCap)).toBe('MINUTE');
    expect(stepForMinutes(minuteCap + 1)).toBe('HOUR');
    expect(stepForMinutes(hourCap)).toBe('HOUR');
    expect(stepForMinutes(hourCap + 1)).toBe('DAY');

    // Reading today's caps back is not enough on its own: a copy of the same
    // numbers inlined into stepForMinutes satisfies every assertion above and
    // then disagrees with STEP_LIMITS the day a cap moves — the window would
    // be validated against one boundary and queried at another. Re-point the
    // caps at runtime; the flip points have to move with them.
    const saved = { minute: STEP_LIMITS.MINUTE.maxMs, hour: STEP_LIMITS.HOUR.maxMs };
    try {
      STEP_LIMITS.MINUTE.maxMs = 6 * HOUR;
      STEP_LIMITS.HOUR.maxMs = 21 * DAY;
      expect(stepForMinutes(6 * 60)).toBe('MINUTE');
      expect(stepForMinutes(6 * 60 + 1)).toBe('HOUR');
      expect(stepForMinutes(21 * 1440)).toBe('HOUR');
      expect(stepForMinutes(21 * 1440 + 1)).toBe('DAY');
    } finally {
      STEP_LIMITS.MINUTE.maxMs = saved.minute;
      STEP_LIMITS.HOUR.maxMs = saved.hour;
    }
    expect(stepForMinutes(minuteCap + 1)).toBe('HOUR');
  });

  it('always picks a step whose own limits accept the window (1 min … 93 d)', () => {
    for (const minutes of SAMPLE_MINUTES) {
      const step = stepForMinutes(minutes);
      expect([minutes, step, isValidRange(step, minutes * MIN)]).toEqual([minutes, step, true]);
    }
  });

  it('picks the FINEST such step — never coarser than the window needs', () => {
    for (const minutes of SAMPLE_MINUTES) {
      const step = stepForMinutes(minutes);
      for (const finer of STEPS.slice(0, STEPS.indexOf(step))) {
        expect([minutes, finer, isValidRange(finer, minutes * MIN)]).toEqual([
          minutes,
          finer,
          false,
        ]);
      }
    }
  });

  it('does NOT validate: sub-bucket and beyond-cap windows still return a step', () => {
    // Callers must gate on isValidRange themselves — the embedded (chat)
    // views feed it fixed preset minutes, all of which are in range.
    expect(stepForMinutes(0)).toBe('MINUTE');
    expect(isValidRange(stepForMinutes(0), 0)).toBe(false);
    expect(stepForMinutes(94 * 1440)).toBe('DAY');
    expect(isValidRange(stepForMinutes(94 * 1440), 94 * DAY)).toBe(false);
  });
});

describe('isValidRange — what a custom range may be', () => {
  it('is inclusive at both bounds and rejects one millisecond outside', () => {
    for (const step of STEPS) {
      const { minMs, maxMs } = STEP_LIMITS[step];
      expect([step, isValidRange(step, minMs)]).toEqual([step, true]);
      expect([step, isValidRange(step, maxMs)]).toEqual([step, true]);
      expect([step, isValidRange(step, minMs - 1)]).toEqual([step, false]);
      expect([step, isValidRange(step, maxMs + 1)]).toEqual([step, false]);
    }
  });

  it('rejects zero-length and inverted (negative) durations at every step', () => {
    for (const step of STEPS) {
      expect([step, isValidRange(step, 0)]).toEqual([step, false]);
      expect([step, isValidRange(step, -1)]).toEqual([step, false]);
      expect([step, isValidRange(step, -7 * DAY)]).toEqual([step, false]);
    }
  });

  it('rejects a 24 h window at MINUTE precision (the 1440-bucket case) but takes it at HOUR', () => {
    expect(isValidRange('MINUTE', 1 * DAY)).toBe(false);
    expect(isValidRange('HOUR', 1 * DAY)).toBe(true);
  });

  it('rejects a 30 d window at HOUR precision but takes it at DAY', () => {
    expect(isValidRange('HOUR', 30 * DAY)).toBe(false);
    expect(isValidRange('DAY', 30 * DAY)).toBe(true);
  });

  it('rejects a 30 min window at HOUR/DAY precision — under one bucket', () => {
    expect(isValidRange('MINUTE', 30 * MIN)).toBe(true);
    expect(isValidRange('HOUR', 30 * MIN)).toBe(false);
    expect(isValidRange('DAY', 30 * MIN)).toBe(false);
  });

  it('rejects NaN / Infinity — an unparseable custom form must never pass', () => {
    for (const step of STEPS) {
      expect([step, isValidRange(step, Number.NaN)]).toEqual([step, false]);
      expect([step, isValidRange(step, Number.POSITIVE_INFINITY)]).toEqual([step, false]);
      expect([step, isValidRange(step, Number.NEGATIVE_INFINITY)]).toEqual([step, false]);
    }
  });
});

describe('TIME_PRESETS — the picker table agrees with the caps', () => {
  it('every preset is a valid range at its own declared step', () => {
    for (const p of TIME_PRESETS) {
      expect([p.id, isValidRange(p.step, p.durationMs)]).toEqual([p.id, true]);
    }
  });

  it('every preset declares the step stepForMinutes would derive for it', () => {
    for (const p of TIME_PRESETS) {
      expect([p.id, stepForMinutes(p.durationMs / MIN)]).toEqual([p.id, p.step]);
    }
  });

  it('ids are unique and durations strictly ascending (selectByMinutes ties depend on it)', () => {
    const ids = TIME_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    // 'custom' is the store's sentinel for an operator-typed range. A preset
    // claiming it would be selectable yet resolve to no preset at all.
    expect(ids).not.toContain('custom');
    for (let i = 1; i < TIME_PRESETS.length; i += 1) {
      expect(TIME_PRESETS[i]!.durationMs).toBeGreaterThan(TIME_PRESETS[i - 1]!.durationMs);
    }
  });

  it('offers all three precisions and keeps the 1h default present', () => {
    expect(new Set(TIME_PRESETS.map((p) => p.step))).toEqual(new Set(STEPS));
    expect(TIME_PRESETS.find((p) => p.id === '1h')).toBeTruthy();
  });
});

describe('useTimeRangeStore', () => {
  // Pinned wall clock — the rolling presets are read against it.
  const NOW = Date.UTC(2026, 6, 31, 12, 0, 0);

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    setActivePinia(createPinia());
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('defaults to the last hour at MINUTE precision', () => {
    const s = useTimeRangeStore();
    expect(s.presetId).toBe('1h');
    expect(s.step).toBe('MINUTE');
    expect(s.durationMs).toBe(1 * HOUR);
    expect(s.range).toEqual({ startMs: NOW - 1 * HOUR, endMs: NOW });
    expect(s.label).toBe('Last 1 hour');
  });

  it('selectPreset switches step + width together', () => {
    const s = useTimeRangeStore();
    s.selectPreset('7d');
    expect(s.step).toBe('HOUR');
    expect(s.durationMs).toBe(7 * DAY);
    expect(s.range.endMs - s.range.startMs).toBe(7 * DAY);
    expect(s.label).toBe('Last 7 days');
  });

  it('every preset the picker can select yields a window valid at its step', () => {
    const s = useTimeRangeStore();
    for (const p of TIME_PRESETS) {
      s.selectPreset(p.id);
      expect([p.id, isValidRange(s.step, s.range.endMs - s.range.startMs)]).toEqual([p.id, true]);
    }
  });

  it('ignores an unknown preset id instead of blanking the window', () => {
    const s = useTimeRangeStore();
    s.selectPreset('42y');
    expect(s.presetId).toBe('1h');
    expect(s.durationMs).toBe(1 * HOUR);
  });

  it('a preset window is exactly durationMs wide and anchored at the clock it was evaluated on', () => {
    const s = useTimeRangeStore();
    vi.setSystemTime(NOW + 3 * HOUR);
    s.selectPreset('30m'); // re-anchors: the preset id actually changed
    expect(s.range).toEqual({ startMs: NOW + 3 * HOUR - 30 * MIN, endMs: NOW + 3 * HOUR });
  });

  /* `Date.now()` is not reactive, so a computed calling it directly would
   * cache the first window forever — every later read, including every
   * auto-refresh tick, would replay the original window. The anchor ref is
   * what makes a rolling preset actually roll. */
  it('rolling preset window follows the clock when re-anchored', () => {
    const s = useTimeRangeStore();
    expect(s.range.endMs).toBe(NOW);
    vi.setSystemTime(NOW + 10 * MIN);
    s.reanchor();
    expect(s.range.endMs).toBe(NOW + 10 * MIN);
    expect(s.range.startMs).toBe(NOW + 10 * MIN - 1 * HOUR);
  });

  it('an auto-refresh tick re-anchors the rolling window', async () => {
    const s = useTimeRangeStore();
    const auto = useAutoRefreshStore();
    expect(s.range.endMs).toBe(NOW);
    vi.setSystemTime(NOW + 10 * MIN);
    auto.refreshNow();
    await nextTick();
    expect(s.range.endMs).toBe(NOW + 10 * MIN);
  });

  it('a custom range is pinned — a tick never moves it', async () => {
    const s = useTimeRangeStore();
    const auto = useAutoRefreshStore();
    s.selectCustom(NOW - 2 * HOUR, NOW - 1 * HOUR, 'MINUTE');
    vi.setSystemTime(NOW + 10 * MIN);
    auto.refreshNow();
    await nextTick();
    expect(s.range).toEqual({ startMs: NOW - 2 * HOUR, endMs: NOW - 1 * HOUR });
  });

  /* Same root cause from the operator's side: re-picking the currently
   * selected preset is the natural "give me the latest hour" gesture and
   * today it does not move the window. */
  it('re-selecting the SAME preset re-anchors the window on today’s clock', () => {
    const s = useTimeRangeStore();
    expect(s.range.endMs).toBe(NOW);
    vi.setSystemTime(NOW + 10 * MIN);
    s.selectPreset('1h');
    expect(s.range.endMs).toBe(NOW + 10 * MIN);
  });
});

describe('useTimeRangeStore — custom ranges', () => {
  const NOW = Date.UTC(2026, 6, 31, 12, 0, 0);

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    setActivePinia(createPinia());
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('accepts an in-cap window and reports it verbatim', () => {
    const s = useTimeRangeStore();
    const start = NOW - 3 * HOUR;
    const end = NOW - 1 * HOUR;
    s.selectCustom(start, end, 'MINUTE');
    expect(s.presetId).toBe('custom');
    expect(s.step).toBe('MINUTE');
    expect(s.range).toEqual({ startMs: start, endMs: end });
    expect(s.durationMs).toBe(2 * HOUR);
    expect(s.label).toBe('Custom range');
  });

  it('a custom window is absolute — it does not slide with the clock', () => {
    const s = useTimeRangeStore();
    const start = NOW - 3 * HOUR;
    s.selectCustom(start, NOW, 'MINUTE');
    vi.setSystemTime(NOW + 6 * HOUR);
    expect(s.range).toEqual({ startMs: start, endMs: NOW });
  });

  it.each([
    ['inverted', NOW, NOW - 1 * HOUR, 'MINUTE' as TimeStep],
    ['zero-length', NOW, NOW, 'MINUTE' as TimeStep],
    ['over the MINUTE cap', NOW - 5 * HOUR, NOW, 'MINUTE' as TimeStep],
    ['over the HOUR cap', NOW - 20 * DAY, NOW, 'HOUR' as TimeStep],
    ['over the DAY cap', NOW - 120 * DAY, NOW, 'DAY' as TimeStep],
    ['under the HOUR bucket', NOW - 30 * MIN, NOW, 'HOUR' as TimeStep],
    ['unparseable (NaN)', Number.NaN, Number.NaN, 'MINUTE' as TimeStep],
    ['unbounded (Infinity)', 0, Number.POSITIVE_INFINITY, 'DAY' as TimeStep],
  ])('rejects a %s range and leaves the previous selection intact', (_why, start, end, step) => {
    const s = useTimeRangeStore();
    s.selectPreset('2h');
    s.selectCustom(start, end, step);
    // A rejected range must never half-apply: the page keeps querying the
    // window the operator can still see in the chip.
    expect(s.presetId).toBe('2h');
    expect(s.step).toBe('MINUTE');
    expect(s.durationMs).toBe(2 * HOUR);
    expect(s.range).toEqual({ startMs: NOW - 2 * HOUR, endMs: NOW });
  });

  it('a rejected range never disturbs an already-applied CUSTOM window', () => {
    const s = useTimeRangeStore();
    const start = NOW - 3 * HOUR;
    const end = NOW - 1 * HOUR;
    s.selectCustom(start, end, 'MINUTE');
    // Same rejects as above, but from a custom baseline. Here presetId is
    // already 'custom', so a half-applied write is invisible to the chip and
    // silently re-points the window the operator is still looking at.
    s.selectCustom(NOW - 5 * HOUR, NOW, 'MINUTE'); // over the MINUTE cap
    s.selectCustom(NOW, NOW - 1 * HOUR, 'MINUTE'); // inverted
    s.selectCustom(NOW - 30 * MIN, NOW, 'HOUR'); // under the HOUR bucket
    s.selectCustom(Number.NaN, Number.NaN, 'HOUR'); // unparseable
    expect(s.presetId).toBe('custom');
    expect(s.step).toBe('MINUTE');
    expect(s.range).toEqual({ startMs: start, endMs: end });
    expect(s.durationMs).toBe(2 * HOUR);
  });

  it('the same 5 h window is rejected at MINUTE precision and accepted at HOUR', () => {
    const s = useTimeRangeStore();
    const start = NOW - 5 * HOUR;
    s.selectCustom(start, NOW, 'MINUTE');
    expect(s.presetId).toBe('1h');
    s.selectCustom(start, NOW, 'HOUR');
    expect(s.presetId).toBe('custom');
    expect(s.step).toBe('HOUR');
    expect(s.range).toEqual({ startMs: start, endMs: NOW });
  });

  it('switching back to a preset drops the custom window entirely', () => {
    const s = useTimeRangeStore();
    s.selectCustom(NOW - 6 * DAY, NOW, 'HOUR');
    s.selectPreset('15m');
    expect(s.presetId).toBe('15m');
    expect(s.step).toBe('MINUTE');
    expect(s.durationMs).toBe(15 * MIN);
    expect(s.label).toBe('Last 15 minutes');
  });
});

describe('useTimeRangeStore — selectByMinutes (OAP-supplied default window)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 6, 31, 12, 0, 0));
    setActivePinia(createPinia());
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('snaps an exact preset width to that preset', () => {
    const s = useTimeRangeStore();
    s.selectByMinutes(1440);
    expect(s.presetId).toBe('1d');
    expect(s.step).toBe('HOUR');
  });

  it('snaps a non-preset width to the nearest preset', () => {
    const s = useTimeRangeStore();
    s.selectByMinutes(50);
    expect(s.presetId).toBe('1h');
    s.selectByMinutes(25);
    expect(s.presetId).toBe('30m');
    s.selectByMinutes(36000); // 25 d — closer to 30 d than to 14 d
    expect(s.presetId).toBe('30d');
    expect(s.step).toBe('DAY');
  });

  it('breaks a tie toward the SHORTER window', () => {
    const s = useTimeRangeStore();
    s.selectByMinutes(45); // 30m vs 1h — both 15 min away
    expect(s.presetId).toBe('30m');
    s.selectByMinutes(10); // 5m vs 15m — both 5 min away
    expect(s.presetId).toBe('5m');
  });

  it('clamps an absurd window to the longest preset instead of exceeding the DAY cap', () => {
    const s = useTimeRangeStore();
    s.selectByMinutes(365 * 1440);
    expect(s.presetId).toBe('90d');
    expect(isValidRange(s.step, s.durationMs)).toBe(true);
  });

  it.each([0, -5, Number.NaN, Number.POSITIVE_INFINITY])(
    'ignores a non-positive / non-finite default (%s)',
    (minutes) => {
      const s = useTimeRangeStore();
      s.selectByMinutes(minutes);
      expect(s.presetId).toBe('1h');
    },
  );

  it('always lands on a window valid at the step it selected', () => {
    const s = useTimeRangeStore();
    for (const minutes of [...SAMPLE_MINUTES, 7, 999, 100_000, 500_000]) {
      s.selectByMinutes(minutes);
      expect([minutes, isValidRange(s.step, s.durationMs)]).toEqual([minutes, true]);
    }
  });
});
