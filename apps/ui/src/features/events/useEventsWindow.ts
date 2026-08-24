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
 * Events time-window picker — a small, events-agnostic state machine, the
 * day-scale sibling of `useAlarmWindow`.
 *
 * Events are lifecycle records (restarts, deploys, k8s events). The popout
 * shows a recent window — 6h / 1d / 2d presets + custom up to 7d. The BFF
 * caps rolling windows at the same 7d; data beyond the record TTL simply
 * comes back empty. Owns the preset/custom mode + the custom-range draft
 * inputs + their validation; exposes `startTime` / `endTime` (epoch ms) the
 * events query reads.
 */

import { computed, ref, type ComputedRef, type Ref } from 'vue';
import { useI18n } from 'vue-i18n';

export type PresetKey = '6h' | '1d' | '2d';
const PRESET_MS: Record<PresetKey, number> = {
  '6h': 6 * 60 * 60_000,
  '1d': 24 * 60 * 60_000,
  '2d': 2 * 24 * 60 * 60_000,
};
export const PRESETS: readonly PresetKey[] = ['6h', '1d', '2d'] as const;
export const MAX_CUSTOM_MS = 7 * 24 * 60 * 60_000;

export type WindowMode = PresetKey | 'custom';

export interface EventsWindow {
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
  formatWindowLabel: () => string;
}

export function useEventsWindow(): EventsWindow {
  const { t } = useI18n();

  const windowMode = ref<WindowMode>('1d');
  const windowEndAt = ref<number>(Date.now());
  /** Custom range — only consulted when `windowMode === 'custom'`. */
  const customStart = ref<number>(Date.now() - PRESET_MS['1d']);
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

  /* Format `epochMs → 'YYYY-MM-DDTHH:mm'` (datetime-local). Browser TZ —
   * display is browser-local; the BFF converts to OAP TZ on send. */
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

  /** Opens the editor WITHOUT switching the query — the mode moves on Apply,
   *  so Cancel has something to restore. Same contract as the alarms picker. */
  function openCustom(): void {
    customOpen.value = true;
    const seedStart = windowMode.value === 'custom' ? customStart.value : startTime.value;
    const seedEnd = windowMode.value === 'custom' ? customEnd.value : endTime.value;
    customStartInput.value = toLocalInput(seedStart);
    customEndInput.value = toLocalInput(seedEnd);
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
      customError.value = t('Window exceeds {d}d cap', { d: MAX_CUSTOM_MS / 60_000 / 60 / 24 });
      return;
    }
    // After every validation return, so an invalid draft never switches the
    // applied window.
    windowMode.value = 'custom';
    customStart.value = s;
    customEnd.value = e;
    customError.value = null;
    customOpen.value = false;
  }
  function closeCustom(): void {
    customOpen.value = false;
  }

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
    formatWindowLabel,
  };
}
