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
 * State for the Token usage tab: one group per hour over a chosen span.
 *
 * The span is a real time range, not a fixed set of buttons — the presets are
 * the common answers, and Custom is there because "what happened between 02:00
 * and 05:00 last night" is the question an operator actually arrives with. It
 * is capped at twelve hours because the answer is one group per hour and a
 * longer list stops being a shape.
 */

import { ref } from 'vue';
import { bff } from '@/api/client';
import {
  DEFAULT_TOKEN_USAGE_HOURS,
  MAX_TOKEN_USAGE_HOURS,
  type TokenUsageHour,
} from '@/api/scopes/admin-audit';
import { toLocalInput } from './useAuditPage';

/** Presets, in hours. `-1` is the trace conditions' custom sentinel. */
export const TOKEN_PRESETS = [2, 6, 12] as const;
export const CUSTOM_RANGE_SENTINEL = -1;

const HOUR_MS = 3_600_000;

/**
 * The start of the hour BUCKET an instant falls in.
 *
 * Floored in UTC, because that is what a bucket is — flooring on the local
 * clock is only equivalent where the offset is a whole number of hours. On
 * +05:30 a local :00 lands in the middle of a bucket, so the picker would snap
 * to the one place a group never begins. Flooring here produces a local time
 * that IS a group edge: 11:47 IST becomes 11:30 IST, the first group shown.
 */
function floorHour(ms: number): number {
  return Math.floor(ms / HOUR_MS) * HOUR_MS;
}

export function useTokenUsagePage() {
  const hours = ref<TokenUsageHour[]>([]);
  const spanHours = ref<number>(DEFAULT_TOKEN_USAGE_HOURS);
  const customStart = ref<string | null>(null);
  const customEnd = ref<string | null>(null);
  const rangeError = ref<string | null>(null);
  const loading = ref(false);
  const error = ref<string | null>(null);
  /** Only the newest request may write — the controls answer faster than the
   *  server, and an overtaken reply belongs to a span nobody is showing. */
  let generation = 0;


  /**
   * What `setSpan` last wrote into an input, and the instant it meant.
   *
   * A `datetime-local` value is a bare wall clock with no offset, and on a DST
   * fall-back the repeated hour maps to two instants — `new Date(str)` picks
   * the earlier one. So the exact bucket edge a seed was built from cannot
   * always be read back out of its own text, and the page ends up refusing or
   * shifting the range it filled in itself.
   *
   * Keeping the instant beside the text removes the round-trip. An operator
   * edit changes the text and falls back to parsing: a hand-typed time inside
   * a repeated hour is ambiguous whatever we do, which is the control's
   * nature rather than ours to fix.
   */
  const seededFrom = { text: '', ms: NaN };
  const seededTo = { text: '', ms: NaN };

  function instantOf(value: string, seeded: { text: string; ms: number }): number {
    return value === seeded.text && Number.isFinite(seeded.ms)
      ? seeded.ms
      : new Date(value).getTime();
  }

  /** The span to ask for, or the complaint that stops the query. */
  function resolve(): { from: number; to: number } | string {
    if (spanHours.value !== CUSTOM_RANGE_SENTINEL) {
      // Bucket-aligned, like a seeded custom range: `span` whole groups ending
      // with the one in progress. An unaligned `now - span` touches span + 1
      // buckets, which would show seven groups for "Last 6 hours".
      const to = floorHour(Date.now()) + HOUR_MS;
      return { from: to - spanHours.value * HOUR_MS, to };
    }
    const picked = {
      from: customStart.value ? instantOf(customStart.value, seededFrom) : NaN,
      to: customEnd.value ? instantOf(customEnd.value, seededTo) : NaN,
    };
    if (!Number.isFinite(picked.from) || !Number.isFinite(picked.to)) return 'Invalid date';
    if (picked.to <= picked.from) return 'End must be after start';
    // Snapped to whole hours because the answer IS whole hours: a group is an
    // hour, so 06:30–12:30 could only ever be reported as some six of them.
    // Rounding here rather than in the reply means the range the operator sees
    // is the range they get — outward to cover everything they asked for.
    const from = floorHour(picked.from);
    const to = picked.to === floorHour(picked.to) ? picked.to : floorHour(picked.to) + HOUR_MS;
    if (to - from > MAX_TOKEN_USAGE_HOURS * HOUR_MS) {
      return 'Window exceeds {h}h cap';
    }
    return { from, to };
  }

  async function load(): Promise<void> {
    const range = resolve();
    if (typeof range === 'string') {
      rangeError.value = range;
      return;
    }
    rangeError.value = null;
    const mine = (generation += 1);
    // Cascade-clear: the previous span's hours must not sit under the spinner.
    hours.value = [];
    error.value = null;
    loading.value = true;
    try {
      const result = await bff.adminAudit.tokenUsage(range);
      if (mine !== generation) return;
      hours.value = result.hours;
      // Show back the bounds that were READ, not the ones that were typed. A
      // group is a whole hour, so 02:30–05:30 is answered as 02:00–06:00, and
      // leaving the inputs on the request would describe a window nobody read.
      if (spanHours.value === CUSTOM_RANGE_SENTINEL) {
        seededFrom.ms = result.range.from;
        seededFrom.text = toLocalInput(new Date(result.range.from));
        seededTo.ms = result.range.to;
        seededTo.text = toLocalInput(new Date(result.range.to));
        customStart.value = seededFrom.text;
        customEnd.value = seededTo.text;
      }
    } catch (err) {
      if (mine !== generation) return;
      error.value = err instanceof Error ? err.message : String(err);
    } finally {
      if (mine === generation) loading.value = false;
    }
  }

  /**
   * Entering custom mode seeds both ends from the span that was showing, so
   * the inputs are never empty — an empty `datetime-local` paints the
   * browser's own locale placeholder.
   *
   * Seeded ON BUCKET BOUNDARIES, which is what keeps the seed legal. `resolve`
   * widens a range outward to whole buckets, so seeding "twelve hours ending
   * now" at an arbitrary minute would widen to thirteen and the page would
   * refuse the very range it had just filled in.
   */
  function setSpan(next: number): void {
    const previous = spanHours.value;
    spanHours.value = next;
    if (next !== CUSTOM_RANGE_SENTINEL) {
      customStart.value = null;
      customEnd.value = null;
      void load();
      return;
    }
    if (customStart.value && customEnd.value) return;
    const span = previous > 0 ? previous : DEFAULT_TOKEN_USAGE_HOURS;
    // The end of the bucket in progress, so the newest group is the one the
    // presets also end on.
    const end = floorHour(Date.now()) + HOUR_MS;
    const start = end - span * HOUR_MS;
    seededFrom.ms = start;
    seededFrom.text = toLocalInput(new Date(start));
    seededTo.ms = end;
    seededTo.text = toLocalInput(new Date(end));
    customStart.value = seededFrom.text;
    customEnd.value = seededTo.text;
  }

  return {
    hours, spanHours, customStart, customEnd, rangeError, loading, error, load, setSpan,
  };
}
