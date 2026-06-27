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
 * Alarms time-window picker — a small, alarm-agnostic state machine.
 *
 * Per the alerting redesign: 20m / 2h / 4h presets + custom up to 4h.
 * Alarms are second-precision events; longer windows pull thousands of
 * rows and starve the page on some storage backends. The BFF enforces
 * the same 4h cap server-side.
 *
 * Owns the preset/custom mode, the custom-range draft inputs + their
 * validation, and exposes `startTime` / `endTime` computeds that drive
 * the alarms query. The picker UI (`AlarmWindowPicker.vue`) binds this
 * return object; the page reads `startTime` / `endTime` and calls
 * `resetEndToNow()` on manual refresh.
 */

import { computed, ref, type ComputedRef, type Ref } from 'vue';
import { useI18n } from 'vue-i18n';

export type PresetKey = '20m' | '2h' | '4h';
const PRESET_MS: Record<PresetKey, number> = {
  '20m': 20 * 60_000,
  '2h': 2 * 60 * 60_000,
  '4h': 4 * 60 * 60_000,
};
export const PRESETS: readonly PresetKey[] = ['20m', '2h', '4h'] as const;
export const MAX_CUSTOM_MS = 4 * 60 * 60_000;

export type WindowMode = PresetKey | 'custom';

/** Reverse-lookup: configured ms → preset key. Returns `'20m'` for
 *  any value that doesn't match a preset (defensive — the BFF rejects
 *  non-preset values, but the page should still render with a sane
 *  default if it ever sees one). */
export function presetFromMs(ms: number | undefined): PresetKey {
  if (ms === PRESET_MS['4h']) return '4h';
  if (ms === PRESET_MS['2h']) return '2h';
  return '20m';
}

export interface AlarmWindow {
  windowMode: Ref<WindowMode>;
  customStartInput: Ref<string>;
  customEndInput: Ref<string>;
  customError: Ref<string | null>;
  customOpen: Ref<boolean>;
  startTime: ComputedRef<number>;
  endTime: ComputedRef<number>;
  pickPreset: (p: PresetKey) => void;
  openCustom: () => void;
  applyCustom: () => void;
  closeCustom: () => void;
  /** On manual refresh, slide a preset window forward to now. No-op in
   *  custom mode (the operator pinned an absolute range). */
  resetEndToNow: () => void;
  formatWindowLabel: () => string;
}

export function useAlarmWindow(): AlarmWindow {
  const { t } = useI18n();

  const windowMode = ref<WindowMode>('20m');
  const windowEndAt = ref<number>(Date.now());
  /** Custom range — only consulted when `windowMode === 'custom'`. */
  const customStart = ref<number>(Date.now() - PRESET_MS['4h']);
  const customEnd = ref<number>(Date.now());
  const customError = ref<string | null>(null);
  const customOpen = ref<boolean>(false);

  const startTime = computed<number>(() => {
    if (windowMode.value === 'custom') return customStart.value;
    return windowEndAt.value - PRESET_MS[windowMode.value];
  });
  const endTime = computed<number>(() => {
    if (windowMode.value === 'custom') return customEnd.value;
    return windowEndAt.value;
  });

  function pickPreset(p: PresetKey): void {
    windowMode.value = p;
    windowEndAt.value = Date.now();
    customOpen.value = false;
    customError.value = null;
  }

  /* Format `epochMs → 'YYYY-MM-DDTHH:mm'` (datetime-local). Uses browser
   * TZ — display is browser-local; the BFF converts to OAP TZ on send. */
  function toLocalInput(ms: number): string {
    const d = new Date(ms);
    const y = d.getFullYear();
    const mo = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const h = String(d.getHours()).padStart(2, '0');
    const mi = String(d.getMinutes()).padStart(2, '0');
    return `${y}-${mo}-${dd}T${h}:${mi}`;
  }
  const customStartInput = ref<string>(toLocalInput(customStart.value));
  const customEndInput = ref<string>(toLocalInput(customEnd.value));

  function openCustom(): void {
    windowMode.value = 'custom';
    customOpen.value = true;
    customStartInput.value = toLocalInput(customStart.value);
    customEndInput.value = toLocalInput(customEnd.value);
    customError.value = null;
  }
  function applyCustom(): void {
    const s = new Date(customStartInput.value).getTime();
    const e = new Date(customEndInput.value).getTime();
    if (!Number.isFinite(s) || !Number.isFinite(e)) {
      customError.value = t('Invalid date');
      return;
    }
    if (e <= s) {
      customError.value = t('End must be after start');
      return;
    }
    if (e - s > MAX_CUSTOM_MS) {
      customError.value = t('Window exceeds {h}h cap', { h: MAX_CUSTOM_MS / 60_000 / 60 });
      return;
    }
    customStart.value = s;
    customEnd.value = e;
    customError.value = null;
    customOpen.value = false;
  }
  function closeCustom(): void {
    customOpen.value = false;
  }

  function resetEndToNow(): void {
    if (windowMode.value !== 'custom') windowEndAt.value = Date.now();
  }

  /** Compact, locale-independent stamp for the custom window. Same
   *  `MM-DD HH:mm` shape as the topbar time chip — keeps the dense UI
   *  consistent and avoids `toLocaleString` picking up zh-CN / locale-
   *  specific formats (the bug fixed earlier on log timestamps). */
  function fmtStamp(ms: number): string {
    const d = new Date(ms);
    const p = (n: number) => String(n).padStart(2, '0');
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  function formatWindowLabel(): string {
    if (windowMode.value === 'custom') {
      return `${fmtStamp(customStart.value)} → ${fmtStamp(customEnd.value)}`;
    }
    return t('last {window}', { window: windowMode.value });
  }

  return {
    windowMode,
    customStartInput,
    customEndInput,
    customError,
    customOpen,
    startTime,
    endTime,
    pickPreset,
    openCustom,
    applyCustom,
    closeCustom,
    resetEndToNow,
    formatWindowLabel,
  };
}
