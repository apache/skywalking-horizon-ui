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
 * Time-range state for the Logs conditions bar. Logs blocks the global
 * topbar picker (see `TIME_RANGE_OPT_OUT` in AppTopbar), so this is the
 * source of truth for which rolling window the log + facet queries scan.
 * Presets cover the common ranges; the `Custom…` sentinel swaps the
 * dropdown for two `datetime-local` inputs. A range that does not resolve —
 * half-filled, reversed, or past the 7-day cap — REFUSES the query via
 * `rangeError` rather than falling back to another window; the BFF clamps the
 * same 7 days for direct callers. Mirrors the trace tab's Custom… escape hatch.
 *
 * Exposes the query refs the log/facet composables consume:
 *   - `windowMinutesEffective` — preset minutes, or 0 in custom mode.
 *   - `startMs`/`endMs` — absolute epoch ms in custom mode, else null.
 *     The BFF applies the OAP offset (same as the trace tab).
 */

import { computed, ref, watch, type ComputedRef, type Ref } from 'vue';
import { resolveRecordRange, recordRangeWarning, type RecordRange } from '@/utils/recordTimeRange';

export const TIME_RANGE_PRESETS: Array<{ label: string; minutes: number }> = [
  { label: 'Last 15 min', minutes: 15 },
  { label: 'Last 30 min', minutes: 30 },
  { label: 'Last 1 hour', minutes: 60 },
  { label: 'Last 3 hours', minutes: 180 },
  { label: 'Last 6 hours', minutes: 360 },
  { label: 'Last 12 hours', minutes: 720 },
  { label: 'Last 24 hours', minutes: 1440 },
];
export const CUSTOM_RANGE_SENTINEL = -1;

function fmtDateTimeLocal(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export interface LogTimeRange {
  windowMinutes: Ref<number>;
  customStart: Ref<string | null>;
  customEnd: Ref<string | null>;
  isCustomRange: ComputedRef<boolean>;
  /** Null unless the custom pair VALIDATES — never a half-resolved bound. */
  startMs: ComputedRef<number | null>;
  endMs: ComputedRef<number | null>;
  /** i18n key of the complaint that stops the query, or null. */
  rangeError: ComputedRef<string | null>;
  /** i18n key of a non-blocking caution about the window's size, or null. */
  rangeWarning: ComputedRef<string | null>;
  windowMinutesEffective: ComputedRef<number>;
}

export function useLogTimeRange(initialMinutes = 30): LogTimeRange {
  const windowMinutes = ref<number>(initialMinutes);
  const customStart = ref<string | null>(null);
  const customEnd = ref<string | null>(null);
  const isCustomRange = computed(() => windowMinutes.value === CUSTOM_RANGE_SENTINEL);

  watch(isCustomRange, (custom) => {
    if (custom) {
      if (!customStart.value || !customEnd.value) {
        const end = new Date();
        const start = new Date(end.getTime() - 30 * 60_000);
        customStart.value = fmtDateTimeLocal(start);
        customEnd.value = fmtDateTimeLocal(end);
      }
    } else {
      customStart.value = null;
      customEnd.value = null;
    }
  });

  /** The complaint that stops the query, as an i18n KEY, or null when the
   *  range resolves. Only meaningful in custom mode. */
  const rangeError = computed<string | null>(() => {
    if (!isCustomRange.value) return null;
    const resolved = resolveRecordRange(customStart.value, customEnd.value);
    return typeof resolved === 'string' ? resolved : null;
  });
  // Null unless the pair VALIDATES: a half-filled or reversed range used to
  // yield a bound the caller then queried with, which is how an unusable range
  // came back as some other window's results.
  const resolved = computed<RecordRange | null>(() => {
    if (!isCustomRange.value) return null;
    const r = resolveRecordRange(customStart.value, customEnd.value);
    return typeof r === 'string' ? null : r;
  });
  const startMs = computed<number | null>(() => resolved.value?.startMs ?? null);
  const endMs = computed<number | null>(() => resolved.value?.endMs ?? null);
  // Presets are warned about too — cost follows the span, not how it was picked.
  const rangeWarning = computed<string | null>(() =>
    recordRangeWarning(
      isCustomRange.value
        ? (resolved.value ? resolved.value.endMs - resolved.value.startMs : null)
        : windowMinutes.value * 60_000,
    ),
  );
  const windowMinutesEffective = computed<number>(() =>
    isCustomRange.value ? 0 : windowMinutes.value,
  );

  return {
    windowMinutes,
    customStart,
    customEnd,
    isCustomRange,
    startMs,
    endMs,
    rangeError,
    rangeWarning,
    windowMinutesEffective,
  };
}
