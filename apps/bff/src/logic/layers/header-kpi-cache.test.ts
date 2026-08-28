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
 * Which hour the header shows, and what it does while it does not have one.
 *
 * The rule is short and every branch of it is visible to an operator: the
 * current bucket, else the previous one marked stale, else a bounded wait,
 * else a dash. What must not happen is a first visit to a large layer holding
 * the page open for the length of a full scan.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  getHeaderKpis,
  targetHourStart,
  rankFromCache,
  _kpiCacheLayers,
  _resetKpiCache,
  bucketHasValues,
  type KpiBucket,
  type ScanFn,
} from './header-kpi-cache.js';

/** Whitelist identity — constant unless a test is about a template edit. */
const SIG = 'service_cpm';

const H = 3_600_000;
/** 2026-05-17 10:00 UTC, so hour arithmetic reads plainly below. */
const TEN = Date.UTC(2026, 4, 17, 10, 0, 0);
/**
 * Fifteen minutes past the hour.
 *
 * Past BOTH thresholds that matter: the hour in progress has had time to land
 * (five minutes), and the settle delay has moved on, so `want` is H-1 rather
 * than H-2. That second one decides whether a stale fallback is inside the
 * pair — at :06 `want` is still H-2 and its predecessor is H-3, which the
 * fallback correctly refuses.
 */
const TEN_LATE = TEN + 15 * 60_000;

/** A scan that read everything it was asked for. */
type Row = Record<string, number | null>;
const complete = (byService: Map<string, Row>) => ({
  byService,
  unread: new Set<string>(),
  batches: { total: 1, failed: 0 },
});

const scanOf = (values: Record<string, number>, delayMs = 0) =>
  vi.fn(async () => {
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    return complete(new Map(Object.entries(values).map(([id, v]) => [id, { cpm: v }])));
  });

beforeEach(() => _resetKpiCache());

describe('which hour the header asks for', () => {
  it('waits ten minutes past the hour before moving on to it', () => {
    // OAP has not finished aggregating the hour that just ended, so the roll
    // trails it. At 10:09 that still means 08:00.
    expect(targetHourStart(TEN + 9 * 60_000)).toBe(TEN - 2 * H);
    expect(targetHourStart(TEN + 10 * 60_000)).toBe(TEN - H);
    expect(targetHourStart(TEN + 59 * 60_000)).toBe(TEN - H);
    expect(targetHourStart(TEN + H + 10 * 60_000)).toBe(TEN);
  });
});

describe('what the header is served', () => {
  it('reads once for the hour, however many callers arrive together', async () => {
    const scan = scanOf({ a: 5 });
    const [x, y, z] = await Promise.all([
      getHeaderKpis('general', SIG, scan, TEN),
      getHeaderKpis('general', SIG, scan, TEN),
      getHeaderKpis('general', SIG, scan, TEN),
    ]);
    expect(scan, 'each caller ran its own scan of the whole layer').toHaveBeenCalledTimes(1);
    for (const r of [x, y, z]) expect(r?.bucket!.byService.get('a')).toEqual({ cpm: 5 });
  });

  it('serves the previous hour, marked stale, rather than making anyone wait for the new one', async () => {
    // Past the settle window on both readings, so the roll moves `want` from
    // H-2 to H-1 and the bucket left behind is H-2 — inside the pair.
    const first = scanOf({ a: 5 });
    const warm = await getHeaderKpis('general', SIG, first, TEN_LATE);
    expect(warm?.stale).toBe(false);

    // The hour rolls. The new scan is slow; the answer is immediate anyway.
    const slow = scanOf({ a: 9 }, 10_000);
    const rolled = await getHeaderKpis('general', SIG, slow, TEN_LATE + H);
    expect(rolled?.stale, 'the older hour was presented as current').toBe(true);
    expect(rolled?.bucket!.hourStartMs).toBe(targetHourStart(TEN_LATE));
    expect(slow, 'the new hour was not being read behind it').toHaveBeenCalledTimes(1);
  });

  it('gives up after five seconds when there is nothing older to show', async () => {
    vi.useFakeTimers();
    try {
      // Cold layer, and a scan longer than the wait: the page gets a dash, not
      // a hang. `null` is the dash.
      const slow = vi.fn(() => new Promise<never>(() => {}));
      const pending = getHeaderKpis('cold-layer', SIG, slow as never, TEN);
      await vi.advanceTimersByTimeAsync(5_001);
      // A scan IS running — the caller is told to wait, not that there is
      // nothing. That distinction is what stops a permanent 'still reading'.
      expect((await pending).state).toBe('warming');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the abandoned scan, so the next caller is served by it', async () => {
    vi.useFakeTimers();
    try {
      const slow = scanOf({ a: 7 }, 8_000);
      const first = getHeaderKpis('slow-layer', SIG, slow, TEN);
      await vi.advanceTimersByTimeAsync(5_001);
      expect((await first).state, 'the first caller waited past its bound').toBe('warming');

      // The scan was never cancelled — cancelling it would make every caller
      // time out, each throwing away the work that would have answered the next.
      await vi.advanceTimersByTimeAsync(3_001);
      const second = await getHeaderKpis('slow-layer', SIG, slow, TEN);
      expect(second?.bucket!.byService.get('a')).toEqual({ cpm: 7 });
      expect(slow, 'the abandoned scan was restarted').toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('when no completed hour holds anything', () => {
  it('falls through to the hour in progress rather than a page of dashes', async () => {
    // A SkyWalking installed twenty minutes ago: the hour it would read has
    // nothing in it, but the data plainly exists — it is being written right
    // now. Showing nothing would be the wrong answer about a working system.
    const empty = new Map<string, Row>([['a', { cpm: null }]]);
    const live = new Map<string, Row>([['a', { cpm: 42 }]]);
    const scan = vi.fn(async (_layer: string, hourStartMs: number) =>
      complete(hourStartMs === targetHourStart(TEN_LATE) ? empty : live),
    );

    const r = await getHeaderKpis('fresh', SIG, scan, TEN_LATE);
    expect(r?.partial, 'the in-progress hour was not marked as such').toBe(true);
    expect(r?.bucket!.byService.get('a')).toEqual({ cpm: 42 });
    expect(r?.bucket!.hourStartMs, 'not the hour in progress').toBe(Math.floor(TEN / 3_600_000) * 3_600_000);
  });

  it('does not scan the empty hour again', async () => {
    const empty = new Map<string, Row>([['a', { cpm: null }]]);
    const live = new Map<string, Row>([['a', { cpm: 42 }]]);
    const scan = vi.fn(async (_layer: string, hourStartMs: number) =>
      complete(hourStartMs === targetHourStart(TEN_LATE) ? empty : live),
    );

    await getHeaderKpis('fresh2', SIG, scan, TEN_LATE);
    await getHeaderKpis('fresh2', SIG, scan, TEN_LATE);
    await getHeaderKpis('fresh2', SIG, scan, TEN_LATE);

    // An hour with nothing in it does not fill in later. Re-reading it would
    // be the whole fan-out for an answer already known.
    const emptyHourScans = scan.mock.calls.filter((c) => c[1] === targetHourStart(TEN_LATE));
    expect(emptyHourScans, 'the known-empty hour was scanned again').toHaveLength(1);
  });

  it('returns to the completed hour once one has data', async () => {
    const live = new Map<string, Row>([['a', { cpm: 42 }]]);
    const filled = new Map<string, Row>([['a', { cpm: 99 }]]);
    const scan = vi.fn(async (_layer: string, hourStartMs: number) =>
      complete(
        hourStartMs === targetHourStart(TEN_LATE)
          ? new Map<string, Row>([['a', { cpm: null }]])
          : hourStartMs === targetHourStart(TEN_LATE + H)
            ? filled
            : live,
      ),
    );

    const cold = await getHeaderKpis('fresh3', SIG, scan, TEN_LATE);
    expect(cold?.partial).toBe(true);

    // An hour later the completed bucket has data, and the live path is done.
    const normal = await getHeaderKpis('fresh3', SIG, scan, TEN_LATE + H);
    expect(normal?.partial).toBeUndefined();
    expect(normal?.bucket!.byService.get('a')).toEqual({ cpm: 99 });
  });
});

describe('ranking', () => {
  it('ranks on the cached scalars, with no request at all', () => {
    const bucket: KpiBucket = {
      hourStartMs: TEN,
      byService: new Map([
        ['a', { cpm: 10 }],
        ['b', { cpm: 90 }],
        ['c', { cpm: null }],
      ]),
      unread: new Set<string>(),
      batches: { total: 1, failed: 0 },
      readAt: TEN,
    };
    const rows = [
      { id: 'a', name: 'alpha', normal: true, group: '' },
      { id: 'b', name: 'bravo', normal: true, group: '' },
      { id: 'c', name: 'charlie', normal: true, group: '' },
    ];
    // Busiest first; a service with no value sorts last rather than anywhere.
    expect(rankFromCache(bucket, rows, 'cpm', 2, (r) => r.name).map((r) => r.id)).toEqual(['b', 'a']);
    expect(rankFromCache(bucket, rows, 'cpm', 3, (r) => r.name).map((r) => r.id)).toEqual(['b', 'a', 'c']);
  });
});

// An admin editing the layer's header columns changes what the hour means, so
// the values read for the old whitelist must not answer the new one — nor may
// an hour found empty under the old metrics suppress the scan for the new.
it('re-scans when the template whitelist changes', async () => {
  _resetKpiCache();
  const seen: string[] = [];
  const scanFor = (expr: string): ScanFn => async () => {
    seen.push(expr);
    return complete(new Map<string, Row>([['svc-1', { [expr]: 7 }]]));
  };

  const before = await getHeaderKpis('edited', 'service_cpm', scanFor('service_cpm'), TEN);
  expect(before?.bucket!.byService.get('svc-1')).toEqual({ service_cpm: 7 });

  // Same hour, new whitelist — the held bucket cannot answer it.
  const after = await getHeaderKpis('edited', 'service_sla', scanFor('service_sla'), TEN);
  expect(after?.bucket!.byService.get('svc-1')).toEqual({ service_sla: 7 });
  expect(seen).toEqual(['service_cpm', 'service_sla']);

  // And the new whitelist is then cached like any other.
  await getHeaderKpis('edited', 'service_sla', scanFor('service_sla'), TEN);
  expect(seen).toHaveLength(2);
});

describe('a scan that lost batches', () => {
  const partialScan = (unreadId: string) =>
    vi.fn(async () => ({
      byService: new Map<string, Row>([
        ['a', { cpm: 10 }],
        [unreadId, { cpm: null }],
      ]),
      unread: new Set([unreadId]),
      batches: { total: 4, failed: 1 },
    }));

  it('carries its incompleteness with the bucket, not just the request that filled it', async () => {
    _resetKpiCache();
    const scan = partialScan('b');
    const first = await getHeaderKpis('partial', SIG, scan, TEN);
    expect(first?.bucket!.batches).toEqual({ total: 4, failed: 1 });

    // The second reader is served the HELD bucket — the retry that the
    // incompleteness triggers runs behind it — and must still be able to say
    // the hour is incomplete, or a lost batch is reported once and silently
    // thereafter. (The retry itself is covered in 'recovering an incomplete
    // hour'; here the scan keeps returning the same partial answer.)
    const second = await getHeaderKpis('partial', SIG, scan, TEN);
    expect(second?.bucket!.batches).toEqual({ total: 4, failed: 1 });
    expect(second?.bucket!.byService.get('a')).toEqual({ cpm: 10 });
  });

  it('ranks the services it could not read above the ones that reported nothing', async () => {
    _resetKpiCache();
    const read = await getHeaderKpis('partial2', SIG, partialScan('b'), TEN);
    const rows = [
      { id: 'a', value: 'alpha' },
      { id: 'b', value: 'bravo' },
      { id: 'c', value: 'charlie' },
    ];
    const ranked = rankFromCache(read!.bucket!, rows, 'cpm', 3, (r) => r.value);
    // `b` was unread; `c` answered with nothing at all. Sorting `b` last would
    // let a lost batch push a possibly-busy service out of the top-N.
    expect(ranked.map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });

  it('does not remember an all-null hour as empty when batches failed', async () => {
    _resetKpiCache();
    const scan = vi.fn(async () => ({
      byService: new Map<string, Row>([['a', { cpm: null }]]),
      unread: new Set(['a']),
      batches: { total: 2, failed: 2 },
    }));
    await getHeaderKpis('partial3', SIG, scan, TEN);
    await getHeaderKpis('partial3', SIG, scan, TEN);
    // Two scans of the TARGET hour: the failure is not evidence of absence, so
    // it must not suppress the retry the way a genuinely empty hour does.
    const target = scan.mock.calls.length;
    expect(target).toBeGreaterThan(1);
  });
});

// An hour read through a fan-out that lost batches sticks for as long as it is
// held, so without a retry a momentary backend failure decides the header for
// the rest of the hour. One re-read, bounded, is the whole remedy.
describe('recovering an incomplete hour', () => {
  it('re-reads once behind the values it already has, then stops', async () => {
    _resetKpiCache();
    let call = 0;
    const scan = vi.fn(async () => {
      call += 1;
      return call === 1
        ? {
            byService: new Map<string, Row>([['a', { cpm: 10 }], ['b', { cpm: null }]]),
            unread: new Set(['b']),
            batches: { total: 4, failed: 1 },
          }
        : {
            byService: new Map<string, Row>([['a', { cpm: 10 }], ['b', { cpm: 20 }]]),
            unread: new Set<string>(),
            batches: { total: 4, failed: 0 },
          };
    });

    const first = await getHeaderKpis('flaky', SIG, scan, TEN);
    expect(first?.bucket!.batches.failed, 'the first read lost a batch').toBe(1);

    // Second caller is served the held values immediately and triggers the
    // re-read behind them — it does not wait for it.
    const second = await getHeaderKpis('flaky', SIG, scan, TEN);
    expect(second?.bucket!.byService.get('b')).toEqual({ cpm: null });
    await new Promise((r) => setTimeout(r, 0));
    expect(scan).toHaveBeenCalledTimes(2);

    // The re-read replaced it, complete this time.
    const third = await getHeaderKpis('flaky', SIG, scan, TEN);
    expect(third?.bucket!.byService.get('b')).toEqual({ cpm: 20 });
    expect(third?.bucket!.batches.failed).toBe(0);

    // And a backend that keeps failing does not turn the cache back into a
    // per-request fan-out: the retry is one per hour, not one per reader.
    await getHeaderKpis('flaky', SIG, scan, TEN);
    await getHeaderKpis('flaky', SIG, scan, TEN);
    expect(scan).toHaveBeenCalledTimes(2);
  });

  it('does not let an empty re-read erase the values it is retrying for', async () => {
    _resetKpiCache();
    let call = 0;
    const scan = vi.fn(async () => {
      call += 1;
      return call === 1
        ? {
            byService: new Map<string, Row>([['a', { cpm: 10 }]]),
            unread: new Set(['b']),
            batches: { total: 4, failed: 1 },
          }
        : {
            byService: new Map<string, Row>([['a', { cpm: null }]]),
            unread: new Set<string>(),
            batches: { total: 4, failed: 0 },
          };
    });

    await getHeaderKpis('flaky2', SIG, scan, TEN);
    await getHeaderKpis('flaky2', SIG, scan, TEN);
    await new Promise((r) => setTimeout(r, 0));

    // The retry found nothing. That is not evidence the hour is empty — we are
    // holding values read from it — so the held bucket stands and the hour is
    // not marked empty, which would have sent every later read to the live path.
    const after = await getHeaderKpis('flaky2', SIG, scan, TEN);
    expect(after?.bucket!.byService.get('a')).toEqual({ cpm: 10 });
    expect(after?.partial, 'fell through to the in-progress hour').toBeUndefined();
  });
});

// OAP buckets on its OWN calendar, and the BFF writes the window down in that
// calendar. An hour picked on a different grid therefore does not survive being
// written: under a half-hour server offset the chosen hour formats to a start in
// one server-local hour and an end inside the next, so the scan reads two
// buckets where it meant to read one — and collapses them into a single value
// that describes ninety minutes. Whole-hour offsets hide it entirely.
describe('choosing the hour on the OAP server clock', () => {
  const fmtHour = (ms: number, offsetMinutes: number): string => {
    const d = new Date(ms + offsetMinutes * 60_000);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(
      d.getUTCDate(),
    ).padStart(2, '0')} ${String(d.getUTCHours()).padStart(2, '0')}`;
  };

  it('lands on exactly one server-local bucket, whatever the offset', () => {
    // Every offset SkyWalking can meet in the wild, including the awkward ones.
    for (const off of [0, 60, -300, 330, 345, 570, 630, -210]) {
      const start = targetHourStart(TEN, off);
      expect(fmtHour(start, off), `offset ${off} spanned two buckets`).toBe(
        fmtHour(start + 3_599_999, off),
      );
    }
  });

  it("applies the ten-minute grace to the SERVER's clock", () => {
    // The policy is unchanged — the grid it is measured on moved. Under +05:30
    // the boundary falls at server-local ten-past, which is UTC :40, so a rule
    // measured on UTC would step at the wrong moment by half an hour.
    const off = 330;
    const shift = off * 60_000;
    /** An instant whose SERVER-local clock reads `h:m`. */
    const atLocal = (h: number, m: number) => Date.UTC(2026, 4, 17, h, m) - shift;

    expect(targetHourStart(atLocal(15, 9), off)).toBe(atLocal(13, 0));
    expect(targetHourStart(atLocal(15, 10), off)).toBe(atLocal(14, 0));
    expect(targetHourStart(atLocal(15, 59), off)).toBe(atLocal(14, 0));
  });
});

// OAP flushes hour-level metrics on a longer period than minute-level ones, so
// a deployment young enough has NEITHER the completed hour nor the one in
// progress. The header cannot be filled from an hour that does not exist yet —
// and, more importantly, an empty hour must not be allowed to RANK the layer:
// every value being null sorts it alphabetically, which silently changes the
// service the page opens on.
describe('a deployment too young for the hour flush', () => {
  const nothing = () => ({
    byService: new Map<string, Row>([['a', { cpm: null }], ['b', { cpm: null }]]),
    unread: new Set<string>(),
    batches: { total: 1, failed: 0 },
  });

  it("reports nothing, so the caller reads the operator's own window instead", async () => {
    _resetKpiCache();
    const scan = vi.fn(async () => nothing());
    // Read, and there is nothing — NOT something to wait for.
    expect((await getHeaderKpis('young', SIG, scan, TEN_LATE)).state).toBe('empty');
  });

  it('does not re-read the hour in progress on every request', async () => {
    _resetKpiCache();
    const scan = vi.fn(async () => nothing());
    await getHeaderKpis('young2', SIG, scan, TEN_LATE);
    const afterFirst = scan.mock.calls.length;
    await getHeaderKpis('young2', SIG, scan, TEN_LATE);
    await getHeaderKpis('young2', SIG, scan, TEN_LATE);
    // Both hours are known empty now. Re-reading either would spend the whole
    // fan-out to learn what we already know, on every single request.
    expect(scan).toHaveBeenCalledTimes(afterFirst);
  });

  it('tries again once the hour rolls', async () => {
    _resetKpiCache();
    let call = 0;
    const scan = vi.fn(async () => {
      call += 1;
      return call <= 2
        ? nothing()
        : {
            byService: new Map<string, Row>([['a', { cpm: 5 }]]),
            unread: new Set<string>(),
            batches: { total: 1, failed: 0 },
          };
    });
    expect((await getHeaderKpis('young3', SIG, scan, TEN_LATE)).state).toBe('empty');
    // An hour later the flush has run, so the completed hour answers and the
    // header goes back to naming it.
    const later = await getHeaderKpis('young3', SIG, scan, TEN_LATE + H);
    expect(later?.bucket!.byService.get('a')).toEqual({ cpm: 5 });
    expect(later?.partial, 'a completed hour is not the hour in progress').toBeUndefined();
  });
});

describe('bucketHasValues', () => {
  it('separates an hour with nothing in it from one that was read', () => {
    const of = (rows: Array<[string, Row]>): KpiBucket => ({
      hourStartMs: TEN,
      byService: new Map(rows),
      unread: new Set<string>(),
      batches: { total: 1, failed: 0 },
      readAt: TEN,
    });
    expect(bucketHasValues(of([['a', { cpm: null }], ['b', { cpm: null }]]))).toBe(false);
    expect(bucketHasValues(of([['a', { cpm: null }], ['b', { cpm: 0 }]])), 'zero IS a value').toBe(true);
    expect(bucketHasValues(of([]))).toBe(false);
  });
});

// Hour-level metrics are flushed on a longer cycle than minute-level ones, so
// the opening minutes of an hour hold nothing at hour granularity however busy
// the deployment is. Reading it then spends the whole fan-out to be told the
// hour has not started — on a large layer, once per request.
describe('the hour in progress is not read before it can hold anything', () => {
  /** Empty for the hour `at` asks for; live for anything else (i.e. H0). */
  const emptyThenLive = (at: number) => {
    const wanted = targetHourStart(at);
    return vi.fn(async (_layer: string, hourStartMs: number) =>
      complete(
        hourStartMs === wanted
          ? new Map<string, Row>([['a', { cpm: null }]])
          : new Map<string, Row>([['a', { cpm: 42 }]]),
      ),
    );
  };

  it('skips it in the first five minutes, leaving the caller its own window', async () => {
    _resetKpiCache();
    const scan = emptyThenLive(TEN);
    // Exactly on the hour: the completed hour is read and found empty, and the
    // hour in progress is not touched at all.
    expect((await getHeaderKpis('settle', SIG, scan, TEN)).state).toBe('empty');
    const currentHourReads = scan.mock.calls.filter((c) => c[1] === TEN).length;
    expect(currentHourReads, 'read an hour that cannot have landed yet').toBe(0);
  });

  it('reads it once the hour has had time to land', async () => {
    _resetKpiCache();
    const scan = emptyThenLive(TEN_LATE);
    const r = await getHeaderKpis('settle2', SIG, scan, TEN_LATE);
    expect(r?.partial, 'the in-progress hour was not offered').toBe(true);
    expect(r?.bucket!.byService.get('a')).toEqual({ cpm: 42 });
  });

  it('shows the older hour while the wanted one is still being read', async () => {
    _resetKpiCache();
    const held = vi.fn(async () => complete(new Map<string, Row>([['a', { cpm: 7 }]])));
    await getHeaderKpis('prefer', SIG, held, TEN_LATE);
    const laterScan = vi.fn(async () => complete(new Map<string, Row>([['a', { cpm: null }]])));
    // First read after the roll: the scan is still out, so nothing is known
    // about the wanted hour yet and the one we hold stands in for it.
    const r = await getHeaderKpis('prefer', SIG, laterScan, TEN_LATE + H);
    expect(r?.stale, 'the hour we still hold was passed over').toBe(true);
    expect(r?.partial).toBeUndefined();
    expect(r?.bucket!.byService.get('a')).toEqual({ cpm: 7 });
  });

  // A completed hour is a real reading, so it is preferred to the one in
  // progress even after the wanted hour turns out to be empty. The live hour is
  // for when there is no completed one to show at all.
  it('keeps showing the hour before rather than the one in progress', async () => {
    _resetKpiCache();
    await getHeaderKpis(
      'settled',
      SIG,
      vi.fn(async () => complete(new Map<string, Row>([['a', { cpm: 7 }]]))),
      TEN_LATE,
    );

    const scan = vi.fn(async (_layer: string, hourStartMs: number) =>
      complete(
        hourStartMs === targetHourStart(TEN_LATE + H)
          ? new Map<string, Row>([['a', { cpm: null }]])
          : new Map<string, Row>([['a', { cpm: 99 }]]),
      ),
    );

    await getHeaderKpis('settled', SIG, scan, TEN_LATE + H);
    await new Promise((r) => setTimeout(r));

    // The wanted hour is now known empty, and the hour in progress has data —
    // but a finished hour we already hold is the better answer.
    const after = await getHeaderKpis('settled', SIG, scan, TEN_LATE + H);
    expect(after?.stale, 'passed over the completed hour it still holds').toBe(true);
    expect(after?.partial).toBeUndefined();
    expect(after?.bucket!.byService.get('a')).toEqual({ cpm: 7 });
    // The live hour was never read, because it was never needed.
    expect(scan.mock.calls.some((c) => c[1] === Math.floor((TEN_LATE + H) / H) * H)).toBe(false);
  });
});

// What a layer holds is proportional to its SERVICE COUNT, and a process that
// serves many layers accumulates one set per layer ever opened — including the
// ones nobody has looked at since. Without a bound that is a leak that only
// shows up on the deployments this cache exists for.
describe('layers nobody reads are released', () => {
  const scan = () => vi.fn(async () => complete(new Map<string, Row>([['a', { cpm: 1 }]])));

  it('drops a layer left idle, and keeps the ones still in use', async () => {
    _resetKpiCache();
    await getHeaderKpis('idle-layer', SIG, scan(), TEN);
    expect(_kpiCacheLayers()).toBe(1);

    // Three hours later, a different layer is read. The idle one goes with it.
    await getHeaderKpis('busy-layer', SIG, scan(), TEN + 3 * H);
    expect(_kpiCacheLayers(), 'the idle layer was still held').toBe(1);

    // And the one just read is not swept out from under itself.
    await getHeaderKpis('third-layer', SIG, scan(), TEN + 3 * H);
    expect(_kpiCacheLayers()).toBe(2);
  });

  it('keeps a layer that is still being looked at', async () => {
    _resetKpiCache();
    const s = scan();
    // Read every hour for four hours — never idle long enough to be dropped.
    for (let i = 0; i <= 4; i++) await getHeaderKpis('watched', SIG, s, TEN + i * H);
    await getHeaderKpis('other', SIG, scan(), TEN + 4 * H);
    expect(_kpiCacheLayers(), 'a layer under active use was evicted').toBe(2);
  });
});

// The older hour is a fallback for the moment the newer one is loading, not a
// second copy to keep. What a layer holds is one value per service per metric,
// so keeping both doubles it for a bucket nothing can ask for any more.
describe('the older hour is released once the newer one lands', () => {
  it('serves it while the new hour loads, then lets it go', async () => {
    _resetKpiCache();
    const first = vi.fn(async () => complete(new Map<string, Row>([['a', { cpm: 1 }]])));
    const held = await getHeaderKpis('roll', SIG, first, TEN_LATE);
    expect(held?.bucket!.byService.get('a')).toEqual({ cpm: 1 });

    // The hour rolls, and the new scan is slow. The old hour is what is shown.
    let release: (() => void) | null = null;
    const slow = vi.fn(async () => {
      await new Promise<void>((r) => {
        release = r;
      });
      return complete(new Map<string, Row>([['a', { cpm: 2 }]]));
    });
    const stale = await getHeaderKpis('roll', SIG, slow, TEN_LATE + H);
    expect(stale?.stale, 'the older hour was not offered while the new one loaded').toBe(true);
    expect(stale?.bucket!.byService.get('a')).toEqual({ cpm: 1 });

    // The new hour lands.
    release!();
    await new Promise((r) => setTimeout(r, 0));

    const fresh = await getHeaderKpis('roll', SIG, slow, TEN_LATE + H);
    expect(fresh?.stale).toBe(false);
    expect(fresh?.bucket!.byService.get('a')).toEqual({ cpm: 2 });

    // And the hour before it is gone: a second roll into a slow scan has
    // nothing older than the hour that just landed to fall back to.
    let release2: (() => void) | null = null;
    const slow2 = vi.fn(async () => {
      await new Promise<void>((r) => {
        release2 = r;
      });
      return complete(new Map<string, Row>([['a', { cpm: 3 }]]));
    });
    const next = await getHeaderKpis('roll', SIG, slow2, TEN_LATE + 2 * H);
    expect(next?.bucket!.byService.get('a'), 'fell back past the hour it should have kept').toEqual({
      cpm: 2,
    });
    release2!();
  });
});

// The bucket is keyed by service id, which is unique across the deployment, so
// ONE scan of the whole layer answers every `?group=` split of it. Filling the
// hour from a narrowed roster instead would leave every other group reading its
// own services as absent until the hour rolled.
describe('one hour serves every group of a layer', () => {
  it('answers services the first caller never asked about', async () => {
    _resetKpiCache();
    // The scan covers the layer, not the caller's slice of it.
    const scan = vi.fn(async () =>
      complete(
        new Map<string, Row>([
          ['svc-a', { cpm: 1 }],
          ['svc-b', { cpm: 2 }],
          ['svc-c', { cpm: 3 }],
        ]),
      ),
    );
    const read = await getHeaderKpis('grouped', SIG, scan, TEN_LATE);

    // A second caller looking at a different group reads its own services out
    // of the same bucket, by id, with no second scan.
    const ranked = rankFromCache(
      read!.bucket!,
      [{ id: 'svc-c', value: 'c' }],
      'cpm',
      10,
      (r) => r.value,
    );
    expect(ranked.map((r) => r.id)).toEqual(['svc-c']);
    expect(read!.bucket!.byService.get('svc-c')).toEqual({ cpm: 3 });
    expect(scan).toHaveBeenCalledTimes(1);
  });
});

// Two reads of the same hour can lose DIFFERENT batches. Replacing the held
// bucket with the retry would trade a service the first read measured for one
// the second did, leaving the hour no more complete — sometimes less.
describe('a retry folds into the hour rather than replacing it', () => {
  it('keeps a value the retry could not re-read', async () => {
    _resetKpiCache();
    let call = 0;
    const scan = vi.fn(async () => {
      call += 1;
      return call === 1
        ? {
            // Read A, missed B.
            byService: new Map<string, Row>([['a', { cpm: 10 }], ['b', { cpm: null }]]),
            unread: new Set(['b']),
            batches: { total: 4, failed: 1 },
          }
        : {
            // Read B, missed A — the mirror image.
            byService: new Map<string, Row>([['a', { cpm: null }], ['b', { cpm: 20 }]]),
            unread: new Set(['a']),
            batches: { total: 4, failed: 1 },
          };
    });

    await getHeaderKpis('merge', SIG, scan, TEN_LATE);
    await getHeaderKpis('merge', SIG, scan, TEN_LATE); // triggers the one retry
    await new Promise((r) => setTimeout(r, 0));

    const after = await getHeaderKpis('merge', SIG, scan, TEN_LATE);
    expect(after?.bucket!.byService.get('a'), 'the retry discarded a value it did not re-read').toEqual({ cpm: 10 });
    expect(after?.bucket!.byService.get('b')).toEqual({ cpm: 20 });
    // Nothing is outstanding any more, so the hour must stop reporting itself
    // as partial — the warning would be about a reading that is now whole.
    expect(after?.bucket!.unread.size).toBe(0);
    expect(after?.bucket!.batches.failed).toBe(0);
  });
});

// A scan started for one hour can finish after a newer hour is already held —
// a slow read, or a retry. Installing it then walks the header backwards.
describe('a late scan cannot replace a newer hour', () => {
  it('drops its result instead of overwriting', async () => {
    _resetKpiCache();
    let release: (() => void) | null = null;
    const slowOldHour = vi.fn(async () => {
      await new Promise<void>((r) => {
        release = r;
      });
      return complete(new Map<string, Row>([['a', { cpm: 1 }]]));
    });
    // Start the old hour's scan and walk away from it.
    void getHeaderKpis('late', SIG, slowOldHour, TEN_LATE);

    // An hour later a different scan completes and is held.
    await getHeaderKpis('late', SIG, vi.fn(async () => complete(new Map<string, Row>([['a', { cpm: 99 }]]))), TEN_LATE + H);

    // Now the old one finally lands.
    release!();
    await new Promise((r) => setTimeout(r, 0));

    const now = await getHeaderKpis('late', SIG, vi.fn(async () => complete(new Map<string, Row>([['a', { cpm: 99 }]]))), TEN_LATE + H);
    expect(now?.bucket!.hourStartMs, 'the header walked back to an older hour').toBe(targetHourStart(TEN_LATE + H));
    expect(now?.bucket!.byService.get('a')).toEqual({ cpm: 99 });
  });
});

// H-1 and H-2 are the pair. A layer reopened after a long gap still holds
// whatever it had — eviction deliberately skips the layer being asked for — so
// without an age test the header would present a four-hour-old bucket as
// merely "stale".
describe('the fallback is the hour before, and no older', () => {
  it('drops a bucket that has fallen further back than H-2', async () => {
    _resetKpiCache();
    const held = vi.fn(async () => complete(new Map<string, Row>([['a', { cpm: 7 }]])));
    await getHeaderKpis('gap', SIG, held, TEN_LATE);

    // One hour on, the held bucket IS H-2 and stands in while the new hour is
    // read. Nothing waits here: the fallback answers before the scan does.
    const nothing = vi.fn(async () => complete(new Map<string, Row>([['a', { cpm: null }]])));
    const near = await getHeaderKpis('gap', SIG, nothing, TEN_LATE + H);
    expect(near.state).toBe('hit');
    expect(near.stale).toBe(true);
    expect(near.bucket!.byService.get('a')).toEqual({ cpm: 7 });

    // Four hours on the same bucket is far outside the pair.
    const far = await getHeaderKpis('gap', SIG, nothing, TEN_LATE + 4 * H);
    expect(far.state, 'served a bucket older than the H-1/H-2 pair').not.toBe('hit');
  });

  // The bound is the CURRENT hour, not one hour before `want`. Inside the first
  // ten minutes of an hour the settle delay has already pushed `want` back to
  // H-2, so `want - 1h` is H-3 on the wall clock — measuring from `want` would
  // quietly admit it.
  it('does not admit H-3 during the settle window', async () => {
    _resetKpiCache();
    const onTheHour = Date.UTC(2026, 4, 17, 12, 5); // :05 — inside the settle
    const want = targetHourStart(onTheHour);
    const currentHour = Date.UTC(2026, 4, 17, 12, 0);
    expect(want, 'the settle has not pushed want back to H-2').toBe(currentHour - 2 * H);

    // Seed a bucket at want - 1h, which is H-3 from the current hour.
    await getHeaderKpis(
      'settle-bound',
      SIG,
      vi.fn(async () => complete(new Map<string, Row>([['a', { cpm: 1 }]]))),
      onTheHour - H,
    );
    const read = await getHeaderKpis(
      'settle-bound',
      SIG,
      vi.fn(async () => complete(new Map<string, Row>([['a', { cpm: null }]]))),
      onTheHour,
    );
    expect(read.state, 'H-3 was offered as the stale fallback').not.toBe('hit');
  });
});

// "No bucket" has three causes and only one of them is worth waiting for.
// Telling a caller to wait for an hour that was read and holds nothing, or for
// a read that failed, leaves "still reading" on screen for good.
describe('the cache says WHY there is no bucket', () => {
  // Reaching `warming` means outlasting the cold wait — there is nothing older
  // to hand over, so the caller genuinely waits its five seconds first. That is
  // the behaviour, so the test pays for it rather than mocking it away.
  it(
    'separates a scan in flight from an hour that holds nothing',
    async () => {
      _resetKpiCache();
      const never = vi.fn(() => new Promise<never>(() => {}) as never);
      const warming = await getHeaderKpis('why', SIG, never, TEN_LATE);
      expect(warming.state, 'a running scan is the one case worth waiting for').toBe('warming');
      expect(warming.bucket).toBeUndefined();

      _resetKpiCache();
      const nothing = vi.fn(async () => complete(new Map<string, Row>([['a', { cpm: null }]])));
      const empty = await getHeaderKpis('why2', SIG, nothing, TEN_LATE);
      expect(empty.state, 'an hour that holds nothing is not something to wait for').toBe('empty');
      expect(empty.bucket).toBeUndefined();
    },
    15_000,
  );
});
