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
 * dropdown for two `datetime-local` inputs (cap is 7 days, enforced
 * server-side too). Mirrors the trace tab's Custom… escape hatch.
 *
 * Exposes the OAP-shaped query refs the log/facet composables consume:
 *   - `windowMinutesEffective` — preset minutes, or 0 in custom mode.
 *   - `startTime`/`endTime` — `YYYY-MM-DD HHmm` (OAP minute) in custom
 *     mode, else null. The BFF forwards these to the same
 *     `queryDuration.start/end` slot the trace tab uses.
 */

import { computed, ref, watch, type ComputedRef, type Ref } from 'vue';

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

/** OAP wants `YYYY-MM-DD HHmm`; the native `datetime-local` input
 *  emits `YYYY-MM-DDTHH:MM`. Convert so the BFF can forward to the
 *  same `queryDuration.start/end` slot the trace tab uses. */
function toOapMinute(local: string | null): string | null {
  if (!local) return null;
  const [d, t] = local.split('T');
  if (!d || !t) return null;
  return `${d} ${t.replace(':', '')}`;
}

export interface LogTimeRange {
  windowMinutes: Ref<number>;
  customStart: Ref<string | null>;
  customEnd: Ref<string | null>;
  isCustomRange: ComputedRef<boolean>;
  startTime: ComputedRef<string | null>;
  endTime: ComputedRef<string | null>;
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

  const startTime = computed<string | null>(() =>
    isCustomRange.value ? toOapMinute(customStart.value) : null,
  );
  const endTime = computed<string | null>(() =>
    isCustomRange.value ? toOapMinute(customEnd.value) : null,
  );
  const windowMinutesEffective = computed<number>(() =>
    isCustomRange.value ? 0 : windowMinutes.value,
  );

  return {
    windowMinutes,
    customStart,
    customEnd,
    isCustomRange,
    startTime,
    endTime,
    windowMinutesEffective,
  };
}
