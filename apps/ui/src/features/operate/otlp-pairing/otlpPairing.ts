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
 * Pure helpers for the OTLP pairing page: what OAP's pairing capture returns, read for display.
 */
import type { PairingCaptureStatus, PairingsResponse } from '@skywalking-horizon-ui/api-client';

/** A count as it reads at a glance while a capture grows: `987`, `12.3k`, `456k`, `7.8m`. */
export function compactCount(n: number): string {
  const scaled = (value: number, unit: string): string => {
    const text = value < 10 ? value.toFixed(1).replace(/\.0$/, '') : String(Math.floor(value));
    return `${text}${unit}`;
  };
  if (!Number.isFinite(n) || n < 1000) return String(n);
  if (n < 1_000_000) return scaled(Math.floor(n / 100) / 10, 'k');
  if (n < 1_000_000_000) return scaled(Math.floor(n / 100_000) / 10, 'm');
  return scaled(Math.floor(n / 100_000_000) / 10, 'b');
}

/** Counts by name, the most frequent first, each compact, `expired 12k · replaced 4`, or `exact`. */
export function countsText(counts: Partial<Record<string, number>>, exact = false): string {
  return Object.entries(counts)
    .filter((entry): entry is [string, number] => typeof entry[1] === 'number' && entry[1] > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([name, n]) => `${name} ${exact ? n : compactCount(n)}`)
    .join(' · ');
}

/** Halves that left the buffer unmatched, by cause, both roles summed. */
export function unmatchedByCause(found: PairingsResponse): Record<string, number> {
  const out: Record<string, number> = {};
  for (const byCause of [found.unmatched.caller, found.unmatched.callee]) {
    for (const [cause, n] of Object.entries(byCause ?? {})) out[cause] = (out[cause] ?? 0) + n;
  }
  return out;
}

/** The entries any of whose fields holds the text, ignoring case. */
export function filterBy<T>(entries: readonly T[], text: string, fields: (entry: T) => readonly string[]): T[] {
  const needle = text.trim().toLowerCase();
  if (needle === '') return [...entries];
  return entries.filter((entry) => fields(entry).some((field) => field.toLowerCase().includes(needle)));
}

/** An epoch in milliseconds as the browser's local `YYYY-MM-DD HH:mm:ss.SSS`; empty for none. */
export function localTime(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const d = new Date(ms);
  const two = (n: number): string => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ` +
    `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`
  );
}

/** The round a set of captures runs, by OAP's own rule for a read: the one most capturing nodes hold, the earliest
 *  started of those as many hold, then the id; null when none captures. */
export function roundOfCaptures(captures: readonly (PairingCaptureStatus | undefined)[]): PairingCaptureStatus | null {
  const byRound = new Map<string, { count: number; first: PairingCaptureStatus }>();
  for (const c of captures) {
    if (!c || c.state !== 'capturing' || !c.roundId) continue;
    const held = byRound.get(c.roundId);
    if (held) {
      held.count += 1;
      if (c.startTime < held.first.startTime) held.first = c;
    } else {
      byRound.set(c.roundId, { count: 1, first: c });
    }
  }
  let best: { count: number; first: PairingCaptureStatus } | null = null;
  for (const r of byRound.values()) {
    if (
      best === null ||
      r.count > best.count ||
      (r.count === best.count && (r.first.startTime < best.first.startTime ||
        (r.first.startTime === best.first.startTime && r.first.roundId < best.first.roundId)))
    ) {
      best = r;
    }
  }
  return best ? best.first : null;
}
