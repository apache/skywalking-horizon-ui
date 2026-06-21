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
 * Global time-range store.
 *
 * Drives the rolling window (and OAP `Duration.step`) used by every
 * page that doesn't carry its own time picker. Three precisions, each
 * with a hard upper bound matching OAP's downsampling boundaries:
 *
 *   MINUTE — bucket size 1m, range max **4 hours**
 *   HOUR   — bucket size 1h, range max **14 days**
 *   DAY    — bucket size 1d, range max **3 months** (we cap at 93d to
 *            cover any 31-day-heavy quarter)
 *
 * The bounds aren't decorative: pulling minute-precision data over
 * 24h returns 1440 buckets per series — OAP rate-limits past that,
 * and the UI gets unreadable. The store enforces the cap on
 * `setRange` so out-of-bounds calls (e.g. from a stale stored
 * selection) snap back to a safe default.
 */

import { defineStore } from 'pinia';
import { computed, ref } from 'vue';

export type TimeStep = 'MINUTE' | 'HOUR' | 'DAY';

export interface TimeRangePreset {
  /** Stable key — used for the dropdown's selected-state highlight. */
  id: string;
  /** Operator-facing label ("Last 30 minutes"). */
  label: string;
  step: TimeStep;
  /** Window length in milliseconds. */
  durationMs: number;
}

/** Hard ranges per precision (used to validate any time range). */
export const STEP_LIMITS: Record<TimeStep, { maxMs: number; minMs: number }> = {
  MINUTE: { minMs: 60_000, maxMs: 4 * 60 * 60_000 },           // 1 min … 4 h
  HOUR:   { minMs: 60 * 60_000, maxMs: 14 * 24 * 60 * 60_000 }, // 1 h … 14 d
  DAY:    { minMs: 24 * 60 * 60_000, maxMs: 93 * 24 * 60 * 60_000 }, // 1 d … ~3 mo
};

const m = 60_000;
const h = 60 * m;
const d = 24 * h;

/** Curated rolling presets, grouped by precision for the dropdown. */
export const TIME_PRESETS: TimeRangePreset[] = [
  // Minute precision · ≤ 4 hours
  { id: '5m',  label: 'Last 5 minutes',  step: 'MINUTE', durationMs: 5 * m },
  { id: '15m', label: 'Last 15 minutes', step: 'MINUTE', durationMs: 15 * m },
  { id: '30m', label: 'Last 30 minutes', step: 'MINUTE', durationMs: 30 * m },
  { id: '1h',  label: 'Last 1 hour',     step: 'MINUTE', durationMs: 60 * m },
  { id: '2h',  label: 'Last 2 hours',    step: 'MINUTE', durationMs: 2 * h },
  { id: '4h',  label: 'Last 4 hours',    step: 'MINUTE', durationMs: 4 * h },
  // Hour precision · ≤ 14 days
  { id: '6h',  label: 'Last 6 hours',    step: 'HOUR', durationMs: 6 * h },
  { id: '12h', label: 'Last 12 hours',   step: 'HOUR', durationMs: 12 * h },
  { id: '1d',  label: 'Last 24 hours',   step: 'HOUR', durationMs: 1 * d },
  { id: '3d',  label: 'Last 3 days',     step: 'HOUR', durationMs: 3 * d },
  { id: '7d',  label: 'Last 7 days',     step: 'HOUR', durationMs: 7 * d },
  { id: '14d', label: 'Last 14 days',    step: 'HOUR', durationMs: 14 * d },
  // Day precision · ≤ 3 months
  { id: '30d', label: 'Last 30 days',    step: 'DAY', durationMs: 30 * d },
  { id: '60d', label: 'Last 60 days',    step: 'DAY', durationMs: 60 * d },
  { id: '90d', label: 'Last 90 days',    step: 'DAY', durationMs: 90 * d },
];

const DEFAULT_PRESET = TIME_PRESETS.find((p) => p.id === '1h')!;

/** Validate (step, durationMs) against {@link STEP_LIMITS}. */
export function isValidRange(step: TimeStep, durationMs: number): boolean {
  const lim = STEP_LIMITS[step];
  return durationMs >= lim.minMs && durationMs <= lim.maxMs;
}

export const useTimeRangeStore = defineStore('time-range', () => {
  /** Selected preset id (`'1h'`, `'7d'`, …) or `'custom'` for an
   *  explicit start/end range. */
  const presetId = ref<string>(DEFAULT_PRESET.id);
  /** Custom range — only consulted when `presetId === 'custom'`. */
  const customStartMs = ref<number>(Date.now() - DEFAULT_PRESET.durationMs);
  const customEndMs = ref<number>(Date.now());
  const customStep = ref<TimeStep>(DEFAULT_PRESET.step);

  const preset = computed<TimeRangePreset | null>(() => {
    if (presetId.value === 'custom') return null;
    return TIME_PRESETS.find((p) => p.id === presetId.value) ?? null;
  });
  const step = computed<TimeStep>(() => preset.value?.step ?? customStep.value);
  const durationMs = computed<number>(() => {
    if (preset.value) return preset.value.durationMs;
    return Math.max(0, customEndMs.value - customStartMs.value);
  });
  /** Rolling preset endpoints recomputed every read so they stay
   *  current; custom ranges use the operator-typed values. */
  const range = computed<{ startMs: number; endMs: number }>(() => {
    if (preset.value) {
      const endMs = Date.now();
      return { startMs: endMs - preset.value.durationMs, endMs };
    }
    return { startMs: customStartMs.value, endMs: customEndMs.value };
  });

  const label = computed<string>(() => {
    if (preset.value) return preset.value.label;
    return 'Custom range';
  });

  function selectPreset(id: string): void {
    if (!TIME_PRESETS.some((p) => p.id === id)) return;
    presetId.value = id;
  }
  function selectCustom(startMs: number, endMs: number, requestedStep: TimeStep): void {
    if (endMs <= startMs) return;
    const dur = endMs - startMs;
    if (!isValidRange(requestedStep, dur)) return;
    customStartMs.value = startMs;
    customEndMs.value = endMs;
    customStep.value = requestedStep;
    presetId.value = 'custom';
  }

  /** Pick the preset closest to `minutes`. Used by AppShell when the
   *  three-tier time-defaults resolution lands a value that differs
   *  from the static `'1h'` default. Picks the nearest by absolute ms
   *  delta; ties broken in favor of the shorter window. */
  function selectByMinutes(minutes: number): void {
    if (!Number.isFinite(minutes) || minutes <= 0) return;
    const targetMs = minutes * 60_000;
    let best = TIME_PRESETS[0]!;
    let bestDelta = Math.abs(best.durationMs - targetMs);
    for (const p of TIME_PRESETS) {
      const d = Math.abs(p.durationMs - targetMs);
      if (d < bestDelta || (d === bestDelta && p.durationMs < best.durationMs)) {
        best = p;
        bestDelta = d;
      }
    }
    presetId.value = best.id;
  }

  return {
    presetId,
    preset,
    step,
    durationMs,
    range,
    label,
    selectPreset,
    selectCustom,
    selectByMinutes,
    customStartMs,
    customEndMs,
    customStep,
  };
});
