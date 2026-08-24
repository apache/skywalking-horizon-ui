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
 * Validating a custom range over record-style data (traces, logs, browser errors).
 *
 * The rule these screens share with the Token usage page: a custom range either
 * resolves to bounds or REFUSES the query. Silently substituting a different
 * window is the failure this replaces — an operator who typed a reversed or
 * half-filled range got a default one back and read its results as answering
 * the question they asked.
 *
 * Returns an i18n KEY rather than a translated string, so the caller renders it
 * with its own `t()` and the four keys stay shared across every locale.
 */

/** Mirrors the BFF's one-week guard on record reads. Kept in step with
 *  `MAX_WINDOW_MIN` / `MAX_LOG_WINDOW_MIN` in the query routes: the UI refuses
 *  what the BFF would otherwise have to clamp. */
export const MAX_RECORD_RANGE_MS = 7 * 24 * 60 * 60_000;

export interface RecordRange {
  startMs: number;
  endMs: number;
}

export function resolveRecordRange(
  startInput: string | null | undefined,
  endInput: string | null | undefined,
): RecordRange | string {
  if (!startInput || !endInput) return 'Pick both a start and an end.';
  const startMs = new Date(startInput).getTime();
  const endMs = new Date(endInput).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return 'Invalid date';
  if (endMs <= startMs) return 'End must be after start';
  if (endMs - startMs > MAX_RECORD_RANGE_MS) return 'Window exceeds {d}d cap';
  return { startMs, endMs };
}

/** The `{d}` the cap message interpolates. */
export const MAX_RECORD_RANGE_DAYS = MAX_RECORD_RANGE_MS / 86_400_000;

/**
 * Beyond this the query still runs, but is worth warning about.
 *
 * Record reads scan storage rather than pre-aggregated buckets, so their cost
 * tracks the window. Six hours is comfortable on a demo and can be slow on a
 * production-sized deployment — which the operator running it is best placed
 * to judge, so this warns rather than refusing.
 */
export const SLOW_RECORD_RANGE_MS = 6 * 60 * 60_000;

/** The i18n KEY of the slow-window warning, or null when the span is modest.
 *  Applies to preset windows as much as custom ones: cost follows the span,
 *  not how it was chosen. */
export function recordRangeWarning(spanMs: number | null | undefined): string | null {
  if (typeof spanMs !== 'number' || !Number.isFinite(spanMs)) return null;
  return spanMs > SLOW_RECORD_RANGE_MS
    ? 'Ranges over {h}h can be slow on a large deployment.'
    : null;
}

/** The `{h}` the slow-window warning interpolates. */
export const SLOW_RECORD_RANGE_HOURS = SLOW_RECORD_RANGE_MS / 3_600_000;
