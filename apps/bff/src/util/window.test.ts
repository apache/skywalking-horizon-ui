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

import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  fmtSecond,
  fmtMinute,
  fmtHour,
  fmtDay,
  fmtForStep,
  defaultMinuteWindow,
  windowFromRange,
  getServerOffsetMinutes,
  type TimeStep,
} from './window.js';
import { parseTimezone } from './time.js';
import type { ConfigSource } from '../config/loader.js';
import type { HorizonConfig } from '../config/schema.js';
import type { FetchLike } from '@skywalking-horizon-ui/api-client';

/* The strings this module emits are consumed by OAP's
 * DurationUtils.verifyDateTimeString / convertToTimeBucket, which parse
 * with joda patterns `yyyy-MM-dd[ HH[mm[ss]]]` and then strip `-` and ` `
 * and Long.parseLong the remainder. Both halves of that contract are
 * asserted here: the joda-parseable shape AND the digit-only time bucket
 * of the exact width (a lost zero-pad silently produces a DIFFERENT,
 * valid-looking bucket rather than an error). */
const SHAPE: Record<TimeStep, { re: RegExp; len: number; bucketDigits: number }> = {
  DAY: { re: /^\d{4}-\d{2}-\d{2}$/, len: 10, bucketDigits: 8 },
  HOUR: { re: /^\d{4}-\d{2}-\d{2} \d{2}$/, len: 13, bucketDigits: 10 },
  MINUTE: { re: /^\d{4}-\d{2}-\d{2} \d{4}$/, len: 15, bucketDigits: 12 },
  SECOND: { re: /^\d{4}-\d{2}-\d{2} \d{6}$/, len: 17, bucketDigits: 14 },
};

/** OAP's `convertToTimeBucket`: drop the separators, parse as a long. */
function toTimeBucket(s: string): string {
  return s.replace(/-/g, '').replace(/ /g, '');
}

function expectShape(step: TimeStep, s: string): void {
  const { re, len, bucketDigits } = SHAPE[step];
  expect(s).toMatch(re);
  expect(s).toHaveLength(len);
  const bucket = toTimeBucket(s);
  expect(bucket).toMatch(/^\d+$/);
  expect(bucket).toHaveLength(bucketDigits);
}

/* Every `Date` reader whose answer depends on the host's zone. The
 * `getUTC*` family is deliberately absent — that is the one family these
 * formatters are allowed to read. */
const HOST_ZONE_READERS = [
  'getFullYear',
  'getMonth',
  'getDate',
  'getDay',
  'getHours',
  'getMinutes',
  'getSeconds',
  'getMilliseconds',
  'getTimezoneOffset',
  'toString',
  'toDateString',
  'toTimeString',
  'toLocaleString',
  'toLocaleDateString',
  'toLocaleTimeString',
] as const;

const HOST_ZONE_READ = 'host-zone Date read';

/** Run `fn` with every host-zone-dependent `Date` reader made fatal, so a
 *  formatter that consults the BFF's own clock throws instead of quietly
 *  emitting a shifted string.
 *
 *  Assigning `process.env.TZ` cannot prove it under a worker-thread runner
 *  (vitest `--pool=threads`): there `process.env` is a per-thread copy, so
 *  the write reads back but never reaches the process environment or the
 *  zone `Date` answers from. Four "different" zones then yield four
 *  identical runs — the invariance holds for ANY implementation, while the
 *  "the zones really differ" guard fails outright. Poisoning the readers is
 *  host- and runner-independent, and it names the leak.
 *
 *  Keep the poisoned window strictly synchronous: while it is installed any
 *  local-`Date` read throws, including from code that is not under test. */
function withHostZoneUnreadable<T>(fn: () => T): T {
  const proto = Date.prototype as unknown as Record<(typeof HOST_ZONE_READERS)[number], () => never>;
  const spies = HOST_ZONE_READERS.map((name) =>
    vi.spyOn(proto, name).mockImplementation(() => {
      throw new Error(`${HOST_ZONE_READ}: Date.${name}()`);
    }),
  );
  try {
    return fn();
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('fmt* — the four DurationUtils string precisions', () => {
  // 2026-05-17T09:04:05.678Z — single-digit month/hour/minute/second on
  // purpose, so a missing zero-pad shows up.
  const MS = Date.UTC(2026, 4, 7, 9, 4, 5, 678);

  it('emits exactly the joda pattern OAP declares for each step', () => {
    expect(fmtDay(MS, 0)).toBe('2026-05-07');
    expect(fmtHour(MS, 0)).toBe('2026-05-07 09');
    expect(fmtMinute(MS, 0)).toBe('2026-05-07 0904');
    expect(fmtSecond(MS, 0)).toBe('2026-05-07 090405');
  });

  it('zero-pads every component so the derived time bucket keeps its width', () => {
    expectShape('DAY', fmtDay(MS, 0));
    expectShape('HOUR', fmtHour(MS, 0));
    expectShape('MINUTE', fmtMinute(MS, 0));
    expectShape('SECOND', fmtSecond(MS, 0));
    expect(toTimeBucket(fmtSecond(MS, 0))).toBe('20260507090405');
  });

  it('never emits ISO punctuation, sub-second digits, or a zone suffix', () => {
    for (const s of [fmtDay(MS, 0), fmtHour(MS, 0), fmtMinute(MS, 0), fmtSecond(MS, 0)]) {
      expect(s).not.toContain('T');
      expect(s).not.toContain('Z');
      expect(s).not.toContain('.');
      expect(s).not.toContain(':');
      expect(s).not.toContain('+');
    }
  });

  it('each precision extends the coarser one (same instant, same prefix)', () => {
    const off = 330;
    expect(fmtHour(MS, off).startsWith(`${fmtDay(MS, off)} `)).toBe(true);
    expect(fmtMinute(MS, off).startsWith(fmtHour(MS, off))).toBe(true);
    expect(fmtSecond(MS, off).startsWith(fmtMinute(MS, off))).toBe(true);
  });

  it('at offset 0 matches the instant’s UTC calendar fields', () => {
    // Derived from toISOString rather than from getUTC*, so this fails if
    // the shift is applied at all when the server sits on UTC.
    const iso = new Date(MS).toISOString(); // 2026-05-07T09:04:05.678Z
    expect(fmtDay(MS, 0)).toBe(iso.slice(0, 10));
    expect(fmtHour(MS, 0)).toBe(`${iso.slice(0, 10)} ${iso.slice(11, 13)}`);
    expect(fmtMinute(MS, 0)).toBe(`${iso.slice(0, 10)} ${iso.slice(11, 13)}${iso.slice(14, 16)}`);
    expect(fmtSecond(MS, 0)).toBe(
      `${iso.slice(0, 10)} ${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}`,
    );
  });

  it('truncates toward the bucket start — never rounds the window forward', () => {
    // 59.999s past the minute must stay in THAT minute/hour/day bucket.
    const late = Date.UTC(2026, 4, 17, 23, 59, 59, 999);
    expect(fmtMinute(late, 0)).toBe('2026-05-17 2359');
    expect(fmtHour(late, 0)).toBe('2026-05-17 23');
    expect(fmtDay(late, 0)).toBe('2026-05-17');
  });
});

describe('fmt* — OAP-server offset sign (a flip here shifts every query by hours)', () => {
  it('a positive offset moves the wall clock FORWARD (UTC+8 crosses into the next day)', () => {
    const ms = Date.UTC(2026, 4, 17, 23, 30);
    expect(fmtMinute(ms, 480)).toBe('2026-05-18 0730');
    // The sign-flipped answer, spelled out so an inverted shift can't pass.
    expect(fmtMinute(ms, 480)).not.toBe('2026-05-17 1530');
  });

  it('a negative offset moves the wall clock BACKWARD (UTC-5 falls into the previous day)', () => {
    const ms = Date.UTC(2026, 4, 17, 2, 30);
    expect(fmtMinute(ms, -300)).toBe('2026-05-16 2130');
    expect(fmtMinute(ms, -300)).not.toBe('2026-05-17 0730');
  });

  it('honors half-hour and three-quarter-hour offsets (UTC+5:30, UTC-9:30, UTC+12:45)', () => {
    const ms = Date.UTC(2026, 4, 17, 10, 0);
    expect(fmtMinute(ms, 330)).toBe('2026-05-17 1530');
    expect(fmtMinute(ms, -570)).toBe('2026-05-17 0030');
    expect(fmtMinute(ms, 765)).toBe('2026-05-17 2245');
  });

  it('shifts by exactly the offset — no extra rounding between precisions', () => {
    const ms = Date.UTC(2026, 4, 17, 12, 0);
    const base = Date.parse('2026-05-17T12:00:00Z');
    for (const off of [0, 60, 480, -300, 330, -570]) {
      const local = Date.parse(`${fmtSecond(ms, off).slice(0, 10)}T00:00:00Z`);
      const hh = Number(fmtSecond(ms, off).slice(11, 13));
      const mm = Number(fmtSecond(ms, off).slice(13, 15));
      expect(local + hh * 3_600_000 + mm * 60_000 - base).toBe(off * 60_000);
    }
  });

  it('is fixed-offset arithmetic — the BFF process timezone never leaks in', () => {
    const ms = Date.UTC(2026, 2, 8, 6, 30); // inside the US DST transition hour
    // Every precision, on both sides of UTC, with the host clock unreadable:
    // these strings come from the instant and the offset argument alone.
    const out = withHostZoneUnreadable(() => ({
      day: fmtDay(ms, 480),
      hour: fmtHour(ms, 480),
      minute: fmtMinute(ms, 480),
      second: fmtSecond(ms, 480),
      west: fmtSecond(ms, -300),
    }));
    expect(out).toEqual({
      day: '2026-03-08',
      hour: '2026-03-08 14',
      minute: '2026-03-08 1430',
      second: '2026-03-08 143000',
      west: '2026-03-08 013000',
    });

    // Guard the guard: the poison must really be lethal while installed,
    // otherwise the run above would hold for any implementation.
    let leak = '';
    withHostZoneUnreadable(() => {
      try {
        new Date(ms).getHours();
      } catch (err) {
        leak = String(err);
      }
    });
    expect(leak).toContain('Date.getHours()');
  });

  it('applies only the offset it is given across a DST boundary (caller owns the switch)', () => {
    const ms = Date.UTC(2026, 2, 8, 6, 30);
    expect(fmtHour(ms, -300)).toBe('2026-03-08 01'); // OAP still on standard time
    expect(fmtHour(ms, -240)).toBe('2026-03-08 02'); // OAP already on daylight time
  });
});

describe('fmtForStep — step→precision dispatch', () => {
  const MS = Date.UTC(2026, 0, 2, 3, 4, 5);

  it('routes every step to its own precision', () => {
    // Spelled out rather than compared against fmt* — a comparison would
    // agree with itself even if the formatters were all broken.
    expect(fmtForStep('DAY', MS, 0)).toBe('2026-01-02');
    expect(fmtForStep('HOUR', MS, 0)).toBe('2026-01-02 03');
    expect(fmtForStep('MINUTE', MS, 0)).toBe('2026-01-02 0304');
    expect(fmtForStep('SECOND', MS, 0)).toBe('2026-01-02 030405');
  });

  it('returns the shape OAP verifies for every step (no undefined fall-through)', () => {
    for (const step of ['DAY', 'HOUR', 'MINUTE', 'SECOND'] as const) {
      const s = fmtForStep(step, MS, -300);
      expect(typeof s).toBe('string');
      expectShape(step, s);
    }
  });

  it('never returns one step’s precision for another step', () => {
    const seen = (['DAY', 'HOUR', 'MINUTE', 'SECOND'] as const).map((s) => fmtForStep(s, MS, 0));
    expect(new Set(seen).size).toBe(4);
  });

  it('forwards the offset to the chosen formatter', () => {
    expect(fmtForStep('DAY', Date.UTC(2026, 4, 17, 20, 0), 480)).toBe('2026-05-18');
    expect(fmtForStep('SECOND', Date.UTC(2026, 4, 17, 20, 0), 480)).toBe('2026-05-18 040000');
  });
});

describe('windowFromRange — operator-supplied range → OAP Duration', () => {
  it('formats both bounds at the requested step and echoes the step back', () => {
    const w = windowFromRange('MINUTE', Date.UTC(2026, 4, 17, 10, 0), Date.UTC(2026, 4, 17, 11, 0), 0);
    expect(w).toEqual({ start: '2026-05-17 1000', end: '2026-05-17 1100', step: 'MINUTE' });
  });

  it('keeps start/end in the SAME precision as the step for every step', () => {
    const start = Date.UTC(2026, 4, 17, 10, 0, 30);
    const end = Date.UTC(2026, 4, 18, 11, 0, 45);
    for (const step of ['DAY', 'HOUR', 'MINUTE', 'SECOND'] as const) {
      const w = windowFromRange(step, start, end, 0);
      expect(w).not.toBeNull();
      expect(w?.step).toBe(step);
      expectShape(step, w!.start);
      expectShape(step, w!.end);
    }
  });

  it('rejects an empty or inverted range so the caller can fall back', () => {
    const t = Date.UTC(2026, 4, 17, 10, 0);
    expect(windowFromRange('MINUTE', t, t, 0)).toBeNull();
    expect(windowFromRange('MINUTE', t + 60_000, t, 0)).toBeNull();
  });

  it('rejects non-finite bounds (NaN from a bad query param, Infinity)', () => {
    const t = Date.UTC(2026, 4, 17, 10, 0);
    expect(windowFromRange('MINUTE', Number.NaN, t, 0)).toBeNull();
    expect(windowFromRange('MINUTE', t, Number.NaN, 0)).toBeNull();
    expect(windowFromRange('MINUTE', -Infinity, t, 0)).toBeNull();
    expect(windowFromRange('MINUTE', t, Infinity, 0)).toBeNull();
  });

  it('accepts a sub-step range — a 1 ms drag still queries one bucket, not null', () => {
    const t = Date.UTC(2026, 4, 17, 10, 0);
    expect(windowFromRange('DAY', t, t + 1, 0)).toEqual({
      start: '2026-05-17',
      end: '2026-05-17',
      step: 'DAY',
    });
  });

  it('rolls over the day, month and year on the formatted bounds', () => {
    expect(windowFromRange('MINUTE', Date.UTC(2025, 11, 31, 23, 50), Date.UTC(2026, 0, 1, 0, 10), 0)).toEqual({
      start: '2025-12-31 2350',
      end: '2026-01-01 0010',
      step: 'MINUTE',
    });
    expect(windowFromRange('HOUR', Date.UTC(2026, 0, 31, 23, 0), Date.UTC(2026, 1, 1, 1, 0), 0)).toEqual({
      start: '2026-01-31 23',
      end: '2026-02-01 01',
      step: 'HOUR',
    });
  });

  it('handles leap and non-leap February ends', () => {
    expect(windowFromRange('HOUR', Date.UTC(2024, 1, 28, 23, 0), Date.UTC(2024, 1, 29, 1, 0), 0)?.end).toBe(
      '2024-02-29 01',
    );
    expect(windowFromRange('HOUR', Date.UTC(2026, 1, 28, 23, 0), Date.UTC(2026, 2, 1, 1, 0), 0)?.end).toBe(
      '2026-03-01 01',
    );
  });

  it('applies the server offset to BOTH bounds (a whole window can land on the next OAP day)', () => {
    const w = windowFromRange('DAY', Date.UTC(2026, 4, 17, 20, 0), Date.UTC(2026, 4, 17, 22, 0), 480);
    expect(w).toEqual({ start: '2026-05-18', end: '2026-05-18', step: 'DAY' });
  });

  it('preserves the window WIDTH under any offset (offset shifts, never stretches)', () => {
    const start = Date.UTC(2026, 4, 17, 10, 0);
    const end = start + 37 * 60_000;
    for (const off of [0, 480, -300, 330]) {
      const w = windowFromRange('MINUTE', start, end, off)!;
      const parse = (s: string) =>
        Date.parse(`${s.slice(0, 10)}T${s.slice(11, 13)}:${s.slice(13, 15)}:00Z`);
      expect(parse(w.end) - parse(w.start)).toBe(37 * 60_000);
    }
  });
});

describe('defaultMinuteWindow — the no-range fallback', () => {
  it('snaps the end DOWN to the minute and looks back 60 minutes by default', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-17T10:37:42.500Z'));
    expect(defaultMinuteWindow(0)).toEqual({
      start: '2026-05-17 0937',
      end: '2026-05-17 1037',
      step: 'MINUTE',
    });
  });

  it('never rounds the end up into a bucket OAP has not aggregated yet', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-17T10:37:59.999Z'));
    expect(defaultMinuteWindow(0).end).toBe('2026-05-17 1037');
  });

  it('honors minutesBack and keeps the two bounds exactly that far apart', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-17T10:37:42.500Z'));
    expect(defaultMinuteWindow(0, 5)).toEqual({
      start: '2026-05-17 1032',
      end: '2026-05-17 1037',
      step: 'MINUTE',
    });
  });

  it('walks back over a month boundary for a 24h lookback', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-01T00:30:00Z'));
    expect(defaultMinuteWindow(0, 1440)).toEqual({
      start: '2026-02-28 0030',
      end: '2026-03-01 0030',
      step: 'MINUTE',
    });
  });

  it('renders both bounds in OAP-local time, not UTC', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-17T22:37:00Z'));
    expect(defaultMinuteWindow(480, 60)).toEqual({
      start: '2026-05-18 0537',
      end: '2026-05-18 0637',
      step: 'MINUTE',
    });
  });

  it('always declares MINUTE step so the strings and the step agree', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-17T10:37:00Z'));
    const w = defaultMinuteWindow(-300, 15);
    expect(w.step).toBe('MINUTE');
    expectShape('MINUTE', w.start);
    expectShape('MINUTE', w.end);
  });
});

/* ---------------------------------------------------------------- *
 * getServerOffsetMinutes — the getTimeInfo probe + its 60s cache.
 * The tz cache is module-global and keyed by oap.queryUrl, so every
 * test that must start cold uses its own URL.
 * ---------------------------------------------------------------- */

function configFor(
  queryUrl: string,
  opts: { auth?: { username: string; password: string }; timeoutMs?: number } = {},
): ConfigSource {
  const current = {
    oap: {
      queryUrl,
      timeoutMs: opts.timeoutMs ?? 5_000,
      ...(opts.auth ? { auth: opts.auth } : {}),
    },
  } as unknown as HorizonConfig;
  return {
    current,
    path: '/tmp/horizon.test.yaml',
    current_: () => current,
    onChange: () => () => undefined,
    close: async () => undefined,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

interface SeenRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  query: string;
}

/** HTTP header names are case-insensitive; don't pin the casing. */
function headerOf(headers: Record<string, string>, name: string): string | undefined {
  return Object.entries(headers).find(([k]) => k.toLowerCase() === name)?.[1];
}

/**
 * A fake OAP that answers `getTimeInfo` the way a GraphQL server does:
 * only for a POST that actually selects that field, and keyed under the
 * ALIAS the query asked for. Answering blindly would hide the worst
 * regression in this path — a renamed field or a dropped `time:` alias
 * leaves `data.time` undefined, and the probe then reports a confident
 * UTC+0 for a server that is nowhere near UTC.
 */
function fakeOap(timezone: () => unknown): {
  fetch: FetchLike;
  calls: () => number;
  last: () => SeenRequest;
} {
  let calls = 0;
  let last: SeenRequest = { url: '', method: '', headers: {}, query: '' };
  return {
    fetch: async (input, init) => {
      calls++;
      const query = String(
        (JSON.parse(String(init?.body ?? '{}')) as { query?: string }).query ?? '',
      );
      last = {
        url: String(input),
        method: String(init?.method ?? 'GET').toUpperCase(),
        headers: (init?.headers ?? {}) as Record<string, string>,
        query,
      };
      if (last.method !== 'POST') {
        return jsonResponse({ errors: [{ message: 'GraphQL requires POST' }] });
      }
      const sel = /(?:(\w+)\s*:\s*)?\bgetTimeInfo\b\s*\{([^}]*)\}/.exec(query);
      if (!sel || !/\btimezone\b/.test(sel[2])) {
        return jsonResponse({ errors: [{ message: `no such field in: ${query}` }] });
      }
      return jsonResponse({ data: { [sel[1] ?? 'getTimeInfo']: { timezone: timezone() } } });
    },
    calls: () => calls,
    last: () => last,
  };
}

describe('getServerOffsetMinutes — probing the OAP timezone', () => {
  it('parses the +HHMM shape OAP emits, including negative and half-hour zones', async () => {
    const cases: [string, number][] = [
      ['+0000', 0],
      ['+0800', 480],
      ['-0500', -300],
      ['+0530', 330],
      ['-0930', -570],
      ['+1345', 825],
    ];
    for (const [tz, expected] of cases) {
      const url = `http://oap-parse-${tz.replace(/[+:]/g, 'p').replace('-', 'm')}:12800`;
      expect(await getServerOffsetMinutes(configFor(url), fakeOap(() => tz).fetch)).toBe(expected);
    }
  });

  it('agrees with time.ts parseTimezone on every shape OAP emits', async () => {
    for (const tz of ['+0000', '+0800', '-0500', '+0530', '-0930']) {
      const url = `http://oap-agree-${tz.replace(/[+-]/g, '')}:12800`;
      const probed = await getServerOffsetMinutes(configFor(url), fakeOap(() => tz).fetch);
      expect(probed).toBe(parseTimezone(tz));
    }
  });

  it('feeds the offset that renders OAP-local Duration strings end to end', async () => {
    const url = 'http://oap-e2e:12800';
    const offset = await getServerOffsetMinutes(configFor(url), fakeOap(() => '+0800').fetch);
    // 23:00–23:59 UTC on the 17th is 07:00–07:59 on the 18th for a UTC+8 OAP.
    expect(windowFromRange('MINUTE', Date.UTC(2026, 4, 17, 23, 0), Date.UTC(2026, 4, 17, 23, 59), offset)).toEqual({
      start: '2026-05-18 0700',
      end: '2026-05-18 0759',
      step: 'MINUTE',
    });
  });

  it('caches for 60s — a second call inside the window does not re-probe OAP', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-17T00:00:00Z'));
    const url = 'http://oap-ttl:12800';
    let tz = '+0800';
    const srv = fakeOap(() => tz);
    expect(await getServerOffsetMinutes(configFor(url), srv.fetch)).toBe(480);
    expect(srv.calls()).toBe(1);

    tz = '-0500'; // server would answer differently now
    vi.advanceTimersByTime(59_000);
    expect(await getServerOffsetMinutes(configFor(url), srv.fetch)).toBe(480);
    expect(srv.calls()).toBe(1);
  });

  it('re-probes once the 60s TTL lapses and picks up the new offset', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-17T00:00:00Z'));
    const url = 'http://oap-ttl-expiry:12800';
    let tz = '+0800';
    const srv = fakeOap(() => tz);
    expect(await getServerOffsetMinutes(configFor(url), srv.fetch)).toBe(480);

    tz = '-0500';
    vi.advanceTimersByTime(60_001);
    expect(await getServerOffsetMinutes(configFor(url), srv.fetch)).toBe(-300);
    expect(srv.calls()).toBe(2);
  });

  it('is keyed by queryUrl — repointing OAP re-probes instead of serving the old server’s offset', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-17T00:00:00Z'));
    const a = fakeOap(() => '+0800');
    const b = fakeOap(() => '-0500');
    expect(await getServerOffsetMinutes(configFor('http://oap-a:12800'), a.fetch)).toBe(480);
    // Hot reload repoints at a different OAP well inside the TTL.
    expect(await getServerOffsetMinutes(configFor('http://oap-b:12800'), b.fetch)).toBe(-300);
    expect(b.calls()).toBe(1);
    // ...and back again: the cache holds only one entry, so A is re-probed.
    expect(await getServerOffsetMinutes(configFor('http://oap-a:12800'), a.fetch)).toBe(480);
    expect(a.calls()).toBe(2);
  });

  it('falls back to UTC (0) without throwing when the probe fails', async () => {
    const transport: FetchLike = async () => {
      throw new Error('ECONNREFUSED');
    };
    expect(await getServerOffsetMinutes(configFor('http://oap-down:12800'), transport)).toBe(0);

    const http500: FetchLike = async () => jsonResponse({ error: 'boom' }, 500);
    expect(await getServerOffsetMinutes(configFor('http://oap-500:12800'), http500)).toBe(0);

    const gqlErrors: FetchLike = async () =>
      jsonResponse({ errors: [{ message: 'field getTimeInfo is undefined' }] });
    expect(await getServerOffsetMinutes(configFor('http://oap-gqlerr:12800'), gqlErrors)).toBe(0);
  });

  it('falls back to UTC (0) for a missing or unreadable timezone field', async () => {
    const cases: [string, unknown][] = [
      ['missing', undefined],
      ['null', null],
      ['named', 'Asia/Shanghai'],
      ['empty', ''],
    ];
    for (const [label, value] of cases) {
      const url = `http://oap-bad-${label}:12800`;
      expect(await getServerOffsetMinutes(configFor(url), fakeOap(() => value).fetch)).toBe(0);
    }
  });

  /* Current behavior, pinned so the divergence is visible rather than
   * discovered in the field: this probe only accepts the signed `+HHMM`
   * form that MetadataQueryV2 (`SimpleDateFormat("ZZZZZZ")`) emits, while
   * time.ts `parseTimezone` also reads the unsigned / colon / legacy-integer
   * shapes. Against an OAP emitting one of those, /api/server-time would
   * report +08:00 while every Duration string here silently says UTC. */
  it('does NOT read the wider shapes parseTimezone accepts — flagged divergence, not a blessing', async () => {
    for (const value of ['0800', '+08:00', 800]) {
      const url = `http://oap-wide-${String(value).replace(/\W/g, '')}:12800`;
      expect(await getServerOffsetMinutes(configFor(url), fakeOap(() => value).fetch)).toBe(0);
      expect(parseTimezone(value as string | number)).toBe(480); // the other parser reads it
    }
  });

  it('caches the failure too, so a down OAP is probed once per TTL, not per request', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-17T00:00:00Z'));
    let calls = 0;
    const down: FetchLike = async () => {
      calls++;
      throw new Error('ECONNREFUSED');
    };
    const cfg = configFor('http://oap-down-cached:12800');
    expect(await getServerOffsetMinutes(cfg, down)).toBe(0);
    vi.advanceTimersByTime(30_000);
    expect(await getServerOffsetMinutes(cfg, down)).toBe(0);
    expect(calls).toBe(1);
    vi.advanceTimersByTime(31_000);
    expect(await getServerOffsetMinutes(cfg, down)).toBe(0);
    expect(calls).toBe(2);
  });

  it('POSTs the getTimeInfo query to the configured queryUrl’s /graphql', async () => {
    const srv = fakeOap(() => '+0530');
    // The fake only answers a POST that really selects getTimeInfo { timezone },
    // so a non-zero result is itself proof the request was well formed.
    expect(await getServerOffsetMinutes(configFor('http://oap-url:12800/'), srv.fetch)).toBe(330);
    expect(srv.last().url).toBe('http://oap-url:12800/graphql');
    expect(srv.last().method).toBe('POST');
    expect(headerOf(srv.last().headers, 'content-type')).toContain('json');
  });

  it('sends the configured OAP basic-auth credentials — a 401 here would read as UTC', async () => {
    const srv = fakeOap(() => '+0800');
    const cfg = configFor('http://oap-auth:12800', {
      auth: { username: 'ops', password: 's3cret' },
    });
    expect(await getServerOffsetMinutes(cfg, srv.fetch)).toBe(480);
    expect(headerOf(srv.last().headers, 'authorization')).toBe(
      `Basic ${Buffer.from('ops:s3cret').toString('base64')}`,
    );
  });

  it('bounds a hung OAP at oap.timeoutMs and answers 0 instead of blocking the route', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-17T00:00:00Z'));
    const hung: FetchLike = (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    let settled = false;
    const pending = getServerOffsetMinutes(
      configFor('http://oap-hung:12800', { timeoutMs: 3_000 }),
      hung,
    ).then((v) => {
      settled = true;
      return v;
    });
    await vi.advanceTimersByTimeAsync(2_900);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    expect(await pending).toBe(0);
  });
});
