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
 * Shared time-window helpers for BFF routes that forward an
 * operator-supplied time range to OAP.
 *
 * OAP's `verifyDateTimeString` parses every Duration `start` / `end`
 * string in the OAP server's own timezone — NOT UTC, NOT the browser's
 * timezone. Sending a UTC-formatted string to an OAP running in UTC+8
 * silently shifts every query by eight hours. The BFF therefore probes
 * `getTimeInfo.timezone` once (cached for 60s) and emits each Duration
 * string in OAP-local form via {@link fmtForStep}.
 *
 * The step → string-precision mapping is fixed by OAP's
 * `DurationUtils.java`:
 *   SECOND → yyyy-MM-dd HHmmss   (event/record queries — traces, logs)
 *   MINUTE → yyyy-MM-dd HHmm     (metric queries at minute granularity)
 *   HOUR   → yyyy-MM-dd HH       (metric queries on longer windows)
 *   DAY    → yyyy-MM-dd          (metric queries on very long windows)
 *
 * Mixing precision and step throws upstream. Every BFF route must pass
 * through these helpers; per-route copies drift.
 */

import type { FetchLike } from '@skywalking-horizon-ui/api-client';
import type { ConfigSource } from '../config/loader.js';
import { graphqlPost, buildOapOpts } from '../client/graphql.js';

export type TimeStep = 'SECOND' | 'MINUTE' | 'HOUR' | 'DAY';

export interface Window {
  start: string;
  end: string;
  step: TimeStep;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** Shift an epoch-ms into the OAP server's local wall-clock by adding the
 *  offset, then read the UTC fields off the shifted Date — which are now
 *  the OAP-local components. Works because `Date` is an absolute instant
 *  and `getUTC*` doesn't apply the BFF process's TZ. */
function shifted(epochMs: number, offsetMinutes: number): Date {
  return new Date(epochMs + offsetMinutes * 60_000);
}

export function fmtSecond(epochMs: number, offsetMinutes: number): string {
  const d = shifted(epochMs, offsetMinutes);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
}
export function fmtMinute(epochMs: number, offsetMinutes: number): string {
  const d = shifted(epochMs, offsetMinutes);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}`;
}
export function fmtHour(epochMs: number, offsetMinutes: number): string {
  const d = shifted(epochMs, offsetMinutes);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}`;
}
export function fmtDay(epochMs: number, offsetMinutes: number): string {
  const d = shifted(epochMs, offsetMinutes);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** Format an epoch-ms for OAP per the step. */
export function fmtForStep(step: TimeStep, epochMs: number, offsetMinutes: number): string {
  switch (step) {
    case 'DAY':
      return fmtDay(epochMs, offsetMinutes);
    case 'HOUR':
      return fmtHour(epochMs, offsetMinutes);
    case 'MINUTE':
      return fmtMinute(epochMs, offsetMinutes);
    case 'SECOND':
      return fmtSecond(epochMs, offsetMinutes);
  }
}

/** Last-hour MINUTE window in OAP-local time. Used as the fallback when a
 *  route runs without an operator-supplied range (e.g. background pollers,
 *  legacy callers). */
export function defaultMinuteWindow(
  offsetMinutes: number,
  minutesBack = 60,
): { start: string; end: string; step: 'MINUTE' } {
  const endMs = Math.floor(Date.now() / 60_000) * 60_000; // snap to minute
  const startMs = endMs - minutesBack * 60_000;
  return {
    start: fmtMinute(startMs, offsetMinutes),
    end: fmtMinute(endMs, offsetMinutes),
    step: 'MINUTE',
  };
}

/** Build an OAP {@link Window} from an operator-supplied range. All three
 *  inputs must be present and `endMs > startMs`; returns null otherwise so
 *  the caller can fall back to a default window. Generic on the step so
 *  dashboard / landing routes (whose responses declare step as the metric
 *  subset `'MINUTE' | 'HOUR' | 'DAY'`) keep their narrower types. */
export function windowFromRange<S extends TimeStep>(
  step: S,
  startMs: number,
  endMs: number,
  offsetMinutes: number,
): { start: string; end: string; step: S } | null {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return null;
  return {
    start: fmtForStep(step, startMs, offsetMinutes),
    end: fmtForStep(step, endMs, offsetMinutes),
    step,
  };
}

interface TzCacheEntry {
  offsetMinutes: number;
  fetchedAt: number;
  /** OAP query URL this offset was probed from — a config hot-reload that
   *  repoints OAP misses the cache and re-probes, instead of serving a
   *  different server's offset for up to the TTL. */
}
let tzFlight: Promise<number> | null = null;
let tzCache: TzCacheEntry | null = null;
const TZ_TTL_MS = 60_000;

const TIME_INFO_QUERY = /* GraphQL */ `
  query HorizonServerTime {
    time: getTimeInfo {
      timezone
    }
  }
`;

/** Drop the cached offset and any probe in flight. Test-only — the cache is
 *  process-global, as the offset is a property of the deployment. */
export function _resetTimezoneCache(): void {
  tzCache = null;
  tzFlight = null;
}

/** Look up the OAP server's UTC offset in minutes. Cached 60s.
 *
 *  Returns 0 (UTC fallback) if the probe fails — same behavior as
 *  booster-ui. The 60s TTL bounds how long a misconfigured BFF would
 *  keep sending bad-TZ strings after the operator fixes their OAP. */
export async function getServerOffsetMinutes(
  config: ConfigSource,
  fetchImpl?: FetchLike,
  /** The caller's cancellation, on a read route. Without it this probe ran to
   *  completion against OAP for a browser that had already gone — and every
   *  read route makes it, so an abandoned page cost one of these per request. */
  signal?: AbortSignal,
): Promise<number> {
  if (tzCache && Date.now() - tzCache.fetchedAt < TZ_TTL_MS) {
    return tzCache.offsetMinutes;
  }
  // ONE probe per expiry, shared by every concurrent caller.
  //
  // A refresh round fires a dozen reads at once, so a dozen probes used to race
  // here. Behind a VIP that is a real hazard: the fast ones answer from a
  // healthy node and write the true offset, then a slow one times out against a
  // sick node and overwrites it with the UTC fallback — which then answers every
  // request for the next minute, eight hours off. Sharing the flight means the
  // late failure has nothing left to overwrite.
  //
  // The shared flight deliberately carries NO caller signal: whoever arrived
  // first must not be able to cancel a probe the others are waiting on.
  tzFlight ??= probeServerOffset(config, fetchImpl).finally(() => {
    tzFlight = null;
  });
  // A caller that was cancelled stops waiting; the flight itself continues for
  // the others, and its result is still cached.
  if (!signal) return tzFlight;
  return Promise.race([
    tzFlight,
    new Promise<number>((_, reject) => {
      if (signal.aborted) return reject(abortError());
      signal.addEventListener('abort', () => reject(abortError()), { once: true });
    }),
  ]);
}

function abortError(): Error {
  const e = new Error('This operation was aborted');
  e.name = 'AbortError';
  return e;
}

async function probeServerOffset(
  config: ConfigSource,
  fetchImpl: FetchLike | undefined,
): Promise<number> {
  const now = Date.now();
  try {
    const env = await graphqlPost<{ time?: { timezone?: string | null } | null }>(
      buildOapOpts(config.current, fetchImpl),
      TIME_INFO_QUERY,
    );
    const raw = env.time?.timezone ?? '+0000';
    const m = /^([+-])(\d{2})(\d{2})$/.exec(raw);
    if (m) {
      const sign = m[1] === '-' ? -1 : 1;
      const h = parseInt(m[2], 10);
      const mi = parseInt(m[3], 10);
      const offset = sign * (h * 60 + mi);
      tzCache = { offsetMinutes: offset, fetchedAt: now };
      return offset;
    }
  } catch {
    /* fall through to 0 */
  }
  tzCache = { offsetMinutes: 0, fetchedAt: now };
  return 0;
}
