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
 * Shared time-window helpers for any BFF route that forwards a
 * SPA-supplied time range to OAP. Originally inlined inside
 * `dashboard.ts`; broken out here so `landing.ts` / `topology.ts` /
 * future query routes don't drift their own copies.
 *
 * OAP's `verifyDateTimeString` rejects when the string precision
 * doesn't match the Duration.step — `fmtForStep` is the only place
 * that knows the mapping. All times are formatted in UTC; callers
 * are responsible for converting the operator's browser-local time
 * to UTC before calling these (the UI does this; see CLAUDE.md
 * "Time, step, and timezone").
 */

export type TimeStep = 'MINUTE' | 'HOUR' | 'DAY';

export interface Window {
  start: string;
  end: string;
  step: TimeStep;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}
export function fmtMinute(d: Date): string {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}`;
}
export function fmtHour(d: Date): string {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}`;
}
export function fmtDay(d: Date): string {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** Format a Date for OAP per the step. */
export function fmtForStep(step: TimeStep, d: Date): string {
  if (step === 'DAY') return fmtDay(d);
  if (step === 'HOUR') return fmtHour(d);
  return fmtMinute(d);
}

/** Last-hour MINUTE window. Used as the fallback when a route runs
 *  without a SPA time range (e.g. background pollers, legacy callers). */
export function defaultMinuteWindow(minutesBack = 60): Window {
  const end = new Date();
  end.setUTCSeconds(0, 0);
  const start = new Date(end.getTime() - minutesBack * 60_000);
  return { start: fmtMinute(start), end: fmtMinute(end), step: 'MINUTE' };
}

/** Build an OAP {@link Window} from the SPA-supplied range. All three
 *  inputs must be present and `endMs > startMs`; returns null otherwise
 *  so the caller can fall back to {@link defaultMinuteWindow}. */
export function windowFromRange(
  step: TimeStep,
  startMs: number,
  endMs: number,
): Window | null {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return null;
  return {
    start: fmtForStep(step, new Date(startMs)),
    end: fmtForStep(step, new Date(endMs)),
    step,
  };
}
