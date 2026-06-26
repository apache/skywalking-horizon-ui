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
 * Inspect — pure TZ / time math shared by the board.
 *
 * Dates live as `Date` objects in browser-local wall time. The input boxes
 * display them with `formatLocal(date, step)`; when we send to OAP we shift by
 * the server TZ offset and format with `formatForServer(...)` so OAP reads the
 * same wall-clock-in-its-TZ. No reactivity here — callers own the refs.
 */
import type { InspectStep } from '@skywalking-horizon-ui/api-client';

/* OAP's `DurationUtils.MAX_TIME_RANGE` rejects any duration whose
 * bucket count exceeds 500 — see
 * `oap-server/server-core/.../query/DurationUtils.java:35`. We mirror
 * the cap client-side so widgets don't fire a query OAP will 500 on. */
export const INSPECT_MAX_BUCKETS = 500;

/** Zero-pad an integer to two digits. */
export function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

/** Format a Date in browser-local wall time for the given step. This
 *  is what the date input shows to the operator. */
export function formatLocal(d: Date, s: InspectStep): string {
  const y = d.getFullYear();
  const m = pad2(d.getMonth() + 1);
  const day = pad2(d.getDate());
  if (s === 'DAY') return `${y}-${m}-${day}`;
  const hh = pad2(d.getHours());
  if (s === 'HOUR') return `${y}-${m}-${day} ${hh}`;
  return `${y}-${m}-${day} ${hh}${pad2(d.getMinutes())}`;
}

/** Parse the input box's string back into a Date in browser-local
 *  wall time. Returns null on malformed input — the input box turns
 *  red and the toolbar disables fan-out. */
export function parseLocal(str: string, s: InspectStep): Date | null {
  if (s === 'DAY') {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str);
    if (!m) return null;
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  }
  if (s === 'HOUR') {
    const m = /^(\d{4})-(\d{2})-(\d{2})\s+(\d{2})$/.exec(str);
    if (!m) return null;
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]));
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})\s+(\d{2})(\d{2})$/.exec(str);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
}

/** Format a Date for the OAP MQE / inspect call. OAP reads dates in
 *  *its own* timezone; we shift the Date so its local wall-clock
 *  reads as the server's wall-clock, then format with the step's
 *  template. Identical to skywalking-booster-ui's `getLocalTime` +
 *  `dateFormatStep` pattern. */
export function formatForServer(d: Date, s: InspectStep, offsetMinutes: number): string {
  const utcMillis = d.getTime() + d.getTimezoneOffset() * 60_000;
  const serverWall = new Date(utcMillis + offsetMinutes * 60_000);
  return formatLocal(serverWall, s);
}

export function bucketsBetween(s: Date, e: Date, st: InspectStep): number {
  const ms = e.getTime() - s.getTime();
  if (ms <= 0) return 0;
  const per = st === 'DAY' ? 86_400_000 : st === 'HOUR' ? 3_600_000 : 60_000;
  return Math.ceil(ms / per) + 1;
}

/** Format `min` as a `+HH:MM` / `-HH:MM` string for display. */
export function signedMins(min: number): string {
  const sign = min < 0 ? '-' : '+';
  const abs = Math.abs(min);
  return `UTC${sign}${pad2(Math.trunc(abs / 60))}:${pad2(abs % 60)}`;
}
