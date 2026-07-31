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
  parseTimezone,
  hhmmIntegerToMinutes,
  ServerTimeCache,
  type ServerTimeDeps,
} from './time.js';
import { fmtMinute } from './window.js';
import type { HorizonConfig } from '../config/schema.js';
import type { MqeTargetCache } from './mqe-target.js';
import type { FetchLike } from '@skywalking-horizon-ui/api-client';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('parseTimezone — the getTimeInfo wire value', () => {
  it('parses the +HHMM form OAP actually emits', () => {
    // SimpleDateFormat("ZZZZZZ") on the OAP side → RFC-822 "+0800".
    expect(parseTimezone('+0800')).toBe(480);
    expect(parseTimezone('+0000')).toBe(0);
    expect(parseTimezone('-0500')).toBe(-300);
    expect(parseTimezone('+0530')).toBe(330);
    expect(parseTimezone('-0930')).toBe(-570);
    expect(parseTimezone('+1345')).toBe(825);
  });

  it('keeps the sign attached to the WHOLE offset, minutes included', () => {
    // -0530 is 5h30m BEHIND UTC, not -5h +30m. Getting this wrong shifts
    // every Duration string by an hour for the half-hour zones.
    expect(parseTimezone('-0530')).toBe(-330);
    expect(parseTimezone('-0045')).toBe(-45);
  });

  it('accepts the unsigned, colon and short-hour variants', () => {
    expect(parseTimezone('0800')).toBe(480);
    expect(parseTimezone('+08:00')).toBe(480);
    expect(parseTimezone('8:00')).toBe(480);
    expect(parseTimezone('-8:30')).toBe(-510);
  });

  it('accepts the legacy integer form older OAP builds send', () => {
    expect(parseTimezone(800)).toBe(480);
    expect(parseTimezone(-500)).toBe(-300);
    expect(parseTimezone(530)).toBe(330);
    expect(parseTimezone(0)).toBe(0);
  });

  it('tolerates surrounding whitespace', () => {
    expect(parseTimezone('  +0800 ')).toBe(480);
  });

  it('returns null (never a silent 0) for values it cannot read', () => {
    // A wrong 0 would look exactly like a UTC server and shift the data;
    // null lets the caller flag a fallback instead.
    for (const bad of ['', 'UTC', 'Asia/Shanghai', 'GMT+8', '+08', '+080000', 'abc']) {
      expect(parseTimezone(bad)).toBeNull();
    }
    expect(parseTimezone(Number.NaN)).toBeNull();
    expect(parseTimezone(Infinity)).toBeNull();
  });

  it('rejects an out-of-range minute component', () => {
    expect(parseTimezone('+0860')).toBeNull();
    expect(parseTimezone('+0899')).toBeNull();
  });

  it('a signed-zero offset shifts nothing', () => {
    const ms = Date.UTC(2026, 4, 17, 10, 30);
    for (const tz of ['+0000', '-0000']) {
      expect(fmtMinute(ms, parseTimezone(tz) as number)).toBe('2026-05-17 1030');
    }
  });
});

describe('hhmmIntegerToMinutes — legacy integer offsets', () => {
  it('converts HHMM to plain minutes on both sides of UTC', () => {
    expect(hhmmIntegerToMinutes(0)).toBe(0);
    expect(hhmmIntegerToMinutes(800)).toBe(480);
    expect(hhmmIntegerToMinutes(-500)).toBe(-300);
    expect(hhmmIntegerToMinutes(530)).toBe(330);
    expect(hhmmIntegerToMinutes(1400)).toBe(840);
    expect(hhmmIntegerToMinutes(-1200)).toBe(-720);
  });

  it('treats a bare minute value as minutes-only, keeping the sign', () => {
    expect(hhmmIntegerToMinutes(45)).toBe(45);
    expect(hhmmIntegerToMinutes(-45)).toBe(-45);
  });
});

/* ---------------------------------------------------------------- *
 * ServerTimeCache — the /api/server-time source of truth for the SPA.
 * ---------------------------------------------------------------- */

interface Probe {
  deps: ServerTimeDeps;
  calls: () => number;
  lastInit: () => RequestInit | undefined;
  lastUrl: () => string;
}

function makeDeps(
  respond: (init?: RequestInit) => Promise<Response>,
  opts: { timeoutMs?: number; auth?: { username: string; password: string }; baseUrl?: string } = {},
): Probe {
  let calls = 0;
  let lastInit: RequestInit | undefined;
  let lastUrl = '';
  const cfg = {
    oap: {
      queryUrl: opts.baseUrl ?? 'http://oap:12800',
      timeoutMs: opts.timeoutMs ?? 5_000,
      ...(opts.auth ? { auth: opts.auth } : {}),
    },
  } as unknown as HorizonConfig;
  const fetch: FetchLike = async (input, init) => {
    calls++;
    lastUrl = String(input);
    lastInit = init;
    return respond(init);
  };
  const mqeTarget = {
    resolve: async () => ({
      baseUrl: opts.baseUrl ?? 'http://oap:12800',
      via: 'test',
      configured: {},
    }),
  } as unknown as MqeTargetCache;
  return {
    deps: { config: () => cfg, fetch, mqeTarget },
    calls: () => calls,
    lastInit: () => lastInit,
    lastUrl: () => lastUrl,
  };
}

/** HTTP header names are case-insensitive; don't pin the casing. */
function headerOf(headers: HeadersInit | undefined, name: string): string | undefined {
  return Object.entries((headers ?? {}) as Record<string, string>).find(
    ([k]) => k.toLowerCase() === name,
  )?.[1];
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const okBody = (timezone: string | number, currentTimestamp = 1_779_000_000_000) => ({
  data: { getTimeInfo: { timezone, currentTimestamp } },
});

/** Pin what the BFF process reads as its OWN UTC offset — the value the
 *  fallback path reports.
 *
 *  Assigning `process.env.TZ` is NOT a usable pin: only the main thread of a
 *  real process re-runs `tzset()` on that write, so under a worker-thread
 *  runner (vitest `--pool=threads`) it is silently a no-op and the assertion
 *  reads the HOST zone instead — passing or failing by accident of where the
 *  suite ran. Stubbing the reader is host- and runner-independent.
 *
 *  Install BEFORE `vi.useFakeTimers()`: the spy must sit on the native
 *  `Date.prototype`, which the faked `Date` inherits from. Spying after the
 *  swap patches the fake prototype only, and the stub disappears the moment
 *  real timers come back. */
function pinProcessOffset(): (offsetMinutes: number) => void {
  const spy = vi.spyOn(Date.prototype, 'getTimezoneOffset');
  return (offsetMinutes) => {
    spy.mockReturnValue(-offsetMinutes);
  };
}

/** Resolve through the cache, insisting the answer really came from OAP.
 *  A bare offset assertion can pass for the wrong reason: a fallback reports
 *  the BFF's own offset, which on a UTC+8 host is the very 480 the fake OAP
 *  is supposed to be returning. */
async function oapOffset(cache: ServerTimeCache, deps: ServerTimeDeps): Promise<number> {
  const out = await cache.get(deps);
  expect(out.source).toBe('oap');
  return out.offsetMinutes;
}

describe('ServerTimeCache — resolving the OAP clock', () => {
  it('reports the parsed offset, OAP timestamp and the URL it probed', async () => {
    const p = makeDeps(async () => jsonResponse(okBody('+0800')));
    const out = await new ServerTimeCache().get(p.deps);
    expect(out).toEqual({
      offsetMinutes: 480,
      currentTimestampMillis: 1_779_000_000_000,
      source: 'oap',
      mqeBaseUrl: 'http://oap:12800',
    });
    expect(p.lastUrl()).toBe('http://oap:12800/graphql');
  });

  it('accepts the legacy integer timezone without falling back', async () => {
    const p = makeDeps(async () => jsonResponse(okBody(-500)));
    const out = await new ServerTimeCache().get(p.deps);
    expect(out.source).toBe('oap');
    expect(out.offsetMinutes).toBe(-300);
  });

  it('POSTs the getTimeInfo query as a JSON GraphQL body, not a bare GET', async () => {
    const p = makeDeps(async () => jsonResponse(okBody('+0800')));
    await new ServerTimeCache().get(p.deps);
    const init = p.lastInit();
    expect(String(init?.method)).toBe('POST');
    const sent = JSON.parse(String(init?.body)) as { query?: string };
    expect(sent.query).toContain('getTimeInfo');
    expect(sent.query).toContain('timezone');
    expect(sent.query).toContain('currentTimestamp');
    expect(headerOf(init?.headers, 'content-type')).toContain('json');
  });

  it('sends the configured basic-auth credentials (a 401 would look like a TZ outage)', async () => {
    const p = makeDeps(async () => jsonResponse(okBody('+0000')), {
      auth: { username: 'ops', password: 's3cret' },
    });
    await new ServerTimeCache().get(p.deps);
    expect(headerOf(p.lastInit()?.headers, 'authorization')).toBe(
      `Basic ${Buffer.from('ops:s3cret').toString('base64')}`,
    );
  });

  it('falls back — flagged, never silently — on HTTP failure', async () => {
    const p = makeDeps(async () => jsonResponse({ msg: 'nope' }, 503));
    const out = await new ServerTimeCache().get(p.deps);
    expect(out.source).toBe('fallback');
    expect(out.error).toContain('503');
  });

  it('falls back when OAP answers with a GraphQL error array', async () => {
    const p = makeDeps(async () => jsonResponse({ errors: [{ message: 'getTimeInfo undefined' }] }));
    const out = await new ServerTimeCache().get(p.deps);
    expect(out.source).toBe('fallback');
    expect(out.error).toContain('getTimeInfo undefined');
  });

  it('falls back when timezone or currentTimestamp is missing', async () => {
    for (const body of [
      { data: {} },
      { data: { getTimeInfo: { currentTimestamp: 1 } } },
      { data: { getTimeInfo: { timezone: '+0800' } } },
      { data: { getTimeInfo: { timezone: '+0800', currentTimestamp: '1779000000000' } } },
    ]) {
      const p = makeDeps(async () => jsonResponse(body));
      const out = await new ServerTimeCache().get(p.deps);
      expect(out.source).toBe('fallback');
    }
  });

  it('falls back rather than defaulting to UTC when the timezone is unparseable', async () => {
    const p = makeDeps(async () => jsonResponse(okBody('Asia/Shanghai')));
    const out = await new ServerTimeCache().get(p.deps);
    expect(out.source).toBe('fallback');
    expect(out.error).toContain('not parseable');
  });

  it('falls back when the MQE target cannot be resolved at all', async () => {
    const p = makeDeps(async () => jsonResponse(okBody('+0800')));
    const deps: ServerTimeDeps = {
      ...p.deps,
      mqeTarget: {
        resolve: async () => {
          throw new Error('admin dump unreachable');
        },
      } as unknown as MqeTargetCache,
    };
    const out = await new ServerTimeCache().get(deps);
    expect(out.source).toBe('fallback');
    expect(out.error).toContain('admin dump unreachable');
    expect(out.mqeBaseUrl).toBeUndefined();
    expect(p.calls()).toBe(0);
  });

  it('reports the BFF’s own clock on a fallback, never a silent UTC zero', async () => {
    // The fallback is documented as "the local BFF clock". Returning 0 here
    // would be indistinguishable from a genuine UTC server on the wire.
    const setLocalOffset = pinProcessOffset();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-17T00:00:00Z'));
    // Two zones, neither of them UTC and neither of them the host's, so an
    // offset that is hard-coded (or read with the sign flipped) fails.
    for (const offsetMinutes of [330, -570]) {
      setLocalOffset(offsetMinutes);
      expect(-new Date().getTimezoneOffset()).toBe(offsetMinutes); // the pin took
      const p = makeDeps(async () => jsonResponse({ msg: 'nope' }, 503));
      const out = await new ServerTimeCache().get(p.deps);
      expect(out.source).toBe('fallback');
      expect(out.offsetMinutes).toBe(offsetMinutes);
      expect(out.currentTimestampMillis).toBe(Date.parse('2026-05-17T00:00:00Z'));
    }
  });

  it('leaves no timer armed once the answer has landed', async () => {
    vi.useFakeTimers();
    const p = makeDeps(async () => jsonResponse(okBody('+0800')), { timeoutMs: 30_000 });
    await new ServerTimeCache().get(p.deps);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('aborts a hung /graphql at oap.timeoutMs instead of leaking the request', async () => {
    vi.useFakeTimers();
    const p = makeDeps(
      (init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('This operation was aborted')));
        }),
      { timeoutMs: 3_000 },
    );
    const pending = new ServerTimeCache().get(p.deps);
    await vi.advanceTimersByTimeAsync(3_000);
    const out = await pending;
    expect(out.source).toBe('fallback');
    expect(out.error).toContain('abort');
  });

  it('caches a good answer for 5 minutes, then re-probes', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-17T00:00:00Z'));
    let tz = '+0800';
    const p = makeDeps(async () => jsonResponse(okBody(tz)));
    const cache = new ServerTimeCache();
    expect(await oapOffset(cache, p.deps)).toBe(480);

    tz = '-0500';
    vi.setSystemTime(new Date('2026-05-17T00:04:59Z'));
    expect(await oapOffset(cache, p.deps)).toBe(480);
    expect(p.calls()).toBe(1);

    vi.setSystemTime(new Date('2026-05-17T00:05:01Z'));
    expect(await oapOffset(cache, p.deps)).toBe(-300);
    expect(p.calls()).toBe(2);
  });

  it('holds a fallback for only 15s so the real offset returns quickly', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-17T00:00:00Z'));
    let up = false;
    const p = makeDeps(async () => (up ? jsonResponse(okBody('+0800')) : jsonResponse({}, 503)));
    const cache = new ServerTimeCache();
    expect((await cache.get(p.deps)).source).toBe('fallback');

    up = true;
    vi.setSystemTime(new Date('2026-05-17T00:00:14Z'));
    expect((await cache.get(p.deps)).source).toBe('fallback'); // still inside the short TTL
    expect(p.calls()).toBe(1);

    vi.setSystemTime(new Date('2026-05-17T00:00:16Z'));
    const recovered = await cache.get(p.deps);
    expect(recovered.source).toBe('oap');
    expect(recovered.offsetMinutes).toBe(480);
  });

  it('invalidate() drops the cached answer immediately', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-17T00:00:00Z'));
    let tz = '+0800';
    const p = makeDeps(async () => jsonResponse(okBody(tz)));
    const cache = new ServerTimeCache();
    expect(await oapOffset(cache, p.deps)).toBe(480);
    tz = '+0530';
    cache.invalidate();
    expect(await oapOffset(cache, p.deps)).toBe(330);
    expect(p.calls()).toBe(2);
  });
});
