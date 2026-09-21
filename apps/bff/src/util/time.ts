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
 * Server-time discovery — proxy for OAP's GraphQL `getTimeInfo`
 * query. Returns the OAP server's UTC offset (in minutes) and current
 * timestamp. Studio's SPA caches this once and uses it to:
 *
 *   - Display dates in the browser's local timezone (operator-facing).
 *   - Convert browser-local dates to server-timezone strings when
 *     firing MQE (`yyyy-MM-dd HHmm` etc. — OAP parses these in its
 *     own TZ, not UTC).
 *
 * The booster UI uses the same path (`graphql/fragments/app.ts:17`).
 * The wire shape returns `timezone` as an integer in the +/- HHMM
 * shape — e.g. `800` for UTC+8, `-500` for UTC-5, `530` for UTC+5:30.
 * We translate to plain minutes so the SPA doesn't have to repeat the
 * parsing.
 */

import type { FetchLike } from '@skywalking-horizon-ui/api-client';
import type { HorizonConfig } from '../config/schema.js';

export interface ServerTime {
  /** OAP server's UTC offset in minutes. `+480` for UTC+8, `-300`
   *  for UTC-5, `+330` for India (UTC+5:30). */
  offsetMinutes: number;
  /** OAP-side current epoch millis (snapshot at fetch time). */
  currentTimestampMillis: number;
  /** Where the offset came from — `oap` is the real graphql call;
   *  `fallback` is the local BFF clock returned when OAP's
   *  `getTimeInfo` is unreachable. */
  source: 'oap' | 'fallback';
  /** Resolved MQE base URL the BFF queried. Diagnostic. */
  mqeBaseUrl?: string;
  /** Short error message when source === 'fallback'. */
  error?: string;
}

const GRAPHQL_QUERY =
  'query ServerTime {\n  getTimeInfo {\n    timezone\n    currentTimestamp\n  }\n}\n';

interface CacheEntry {
  value: ServerTime;
  expiresAt: number;
}

const CACHE_TTL_MS = 5 * 60_000;

export class ServerTimeCache {
  private entry: CacheEntry | null = null;

  invalidate(): void {
    this.entry = null;
  }

  async get(deps: ServerTimeDeps): Promise<ServerTime> {
    const now = Date.now();
    if (this.entry && this.entry.expiresAt > now) return this.entry.value;
    const value = await resolveServerTime(deps);
    /* Don't cache fallbacks for the full TTL — recover faster when
     * OAP comes back. */
    const ttl = value.source === 'oap' ? CACHE_TTL_MS : 15_000;
    this.entry = { value, expiresAt: now + ttl };
    return value;
  }
}

export interface ServerTimeDeps {
  config(): HorizonConfig;
  fetch: FetchLike;
}

async function resolveServerTime(deps: ServerTimeDeps): Promise<ServerTime> {
  let mqeBaseUrl: string | undefined;
  /* AbortController gives every server-time call the same upper bound
   * the other OAP-bound BFF calls already respect (`oap.timeoutMs`).
   * Without it a hung /graphql leaks the request indefinitely. */
  const timeoutMs = deps.config().oap.timeoutMs;
  const ctrl = timeoutMs > 0 ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  try {
    const queryUrl = deps.config().oap.queryUrl;
    mqeBaseUrl = queryUrl;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    const auth = deps.config().oap.auth;
    if (auth) {
      headers.authorization =
        'Basic ' + Buffer.from(`${auth.username}:${auth.password}`, 'utf8').toString('base64');
    }
    const init: RequestInit = {
      method: 'POST',
      headers,
      body: JSON.stringify({ query: GRAPHQL_QUERY }),
      ...(ctrl ? { signal: ctrl.signal } : {}),
    };
    const res = await deps.fetch(`${queryUrl.replace(/\/$/, '')}/graphql`, init);
    if (!res.ok) {
      const txt = (await res.text()).slice(0, 200);
      return fallback(`HTTP ${res.status}: ${txt}`, mqeBaseUrl);
    }
    const env = (await res.json()) as {
      data?: { getTimeInfo?: { timezone?: number | string; currentTimestamp?: number } };
      errors?: { message: string }[];
    };
    if (env.errors && env.errors.length > 0) {
      return fallback(env.errors.map((e) => e.message).join('; '), mqeBaseUrl);
    }
    const info = env.data?.getTimeInfo;
    if (
      !info ||
      info.timezone === undefined ||
      info.timezone === null ||
      typeof info.currentTimestamp !== 'number'
    ) {
      return fallback('getTimeInfo missing timezone / currentTimestamp', mqeBaseUrl);
    }
    const offsetMinutes = parseTimezone(info.timezone);
    if (offsetMinutes === null) {
      return fallback(
        `getTimeInfo timezone is not parseable: ${JSON.stringify(info.timezone)}`,
        mqeBaseUrl,
      );
    }
    return {
      offsetMinutes,
      currentTimestampMillis: info.currentTimestamp,
      source: 'oap',
      mqeBaseUrl,
    };
  } catch (err) {
    return fallback(err instanceof Error ? err.message : String(err), mqeBaseUrl);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function fallback(error: string, mqeBaseUrl?: string): ServerTime {
  return {
    offsetMinutes: -new Date().getTimezoneOffset(),
    currentTimestampMillis: Date.now(),
    source: 'fallback',
    error,
    ...(mqeBaseUrl !== undefined ? { mqeBaseUrl } : {}),
  };
}

/** OAP's `timezone` field is typed as String on the GraphQL schema
 *  and arrives in `+HHMM` / `-HHMM` form (e.g. `"+0000"`, `"-0500"`,
 *  `"+0530"`). Some older OAP builds emit a bare integer; both
 *  shapes are accepted here. Returns `null` when unparseable. */
export function parseTimezone(tz: string | number): number | null {
  if (typeof tz === 'number' && Number.isFinite(tz)) return hhmmIntegerToMinutes(tz);
  if (typeof tz !== 'string') return null;
  const trimmed = tz.trim();
  /* Accept "+HHMM", "-HHMM", "HHMM", and the colon variants
   * "+HH:MM" / "HH:MM" for forward compatibility. */
  const m = /^([+-]?)(\d{1,2}):?(\d{2})$/.exec(trimmed);
  if (!m) return null;
  const sign = m[1] === '-' ? -1 : 1;
  const hours = Number(m[2]);
  const mins = Number(m[3]);
  if (mins >= 60) return null;
  return sign * (hours * 60 + mins);
}

/** Legacy path: integer `+/- HHMM`. */
export function hhmmIntegerToMinutes(tz: number): number {
  const sign = tz < 0 ? -1 : 1;
  const abs = Math.abs(tz);
  const hours = Math.trunc(abs / 100);
  const mins = abs % 100;
  return sign * (hours * 60 + mins);
}
