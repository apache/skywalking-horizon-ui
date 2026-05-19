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
 * Global time-defaults — three-tier resolution mirroring the theme
 * store. Captures one knob: the default window for the topbar global
 * time picker (which feeds dashboards / overviews per CLAUDE.md;
 * triage pages keep their own per-page time).
 *
 *   browser (user pref in localStorage)
 *     ↑
 *   org default (admin set on /admin/global-defaults, on OAP as
 *                `horizon.time-defaults.global`)
 *     ↑
 *   bundled code (60 minutes)
 */

import { defineStore } from 'pinia';
import { computed, ref, watch } from 'vue';
import { useConfigBundle } from '@/controls/configBundle';
import { debug } from '@/utils/debug';

const USER_KEY = 'horizon:time-defaults:user';
const FALLBACK_MINUTES = 60;

function readUserOverride(): number | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(USER_KEY);
    if (!raw) return null;
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0 || n > 60 * 24 * 31) return null;
    return n;
  } catch {
    return null;
  }
}

function writeUserOverride(minutes: number | null): void {
  if (typeof localStorage === 'undefined') return;
  try {
    if (minutes === null) localStorage.removeItem(USER_KEY);
    else localStorage.setItem(USER_KEY, String(minutes));
  } catch {
    /* quota / disabled storage — degrade silently */
  }
}

export const useTimeDefaultsStore = defineStore('time-defaults', () => {
  const userOverride = ref<number | null>(readUserOverride());
  const orgDefault = ref<number | null>(null);

  const { bundle } = useConfigBundle();

  const defaultWindowMinutes = computed<number>(
    () => userOverride.value ?? orgDefault.value ?? FALLBACK_MINUTES,
  );
  const hasUserOverride = computed<boolean>(() => {
    if (userOverride.value === null) return false;
    return userOverride.value !== (orgDefault.value ?? FALLBACK_MINUTES);
  });

  async function loadOrgDefault(): Promise<void> {
    const { bff } = await import('@/api/client');
    try {
      const status = await bff.templateSync.syncStatus();
      const row = status.rows.find((r) => r.name === 'horizon.time-defaults.global');
      if (!row) {
        orgDefault.value = null;
        return;
      }
      const source = row.effective === 'remote' && row.remote
        ? row.remote.configuration
        : row.bundled?.configuration;
      if (!source) {
        orgDefault.value = null;
        return;
      }
      const envelope = JSON.parse(source) as {
        content?: { defaultWindowMinutes?: unknown };
      };
      const m = envelope?.content?.defaultWindowMinutes;
      if (typeof m === 'number' && Number.isInteger(m) && m > 0) {
        orgDefault.value = m;
        debug('time-defaults', `loaded org default = ${m} min`);
      } else {
        orgDefault.value = null;
      }
    } catch (err) {
      debug('time-defaults', 'failed to load org default', err);
      orgDefault.value = null;
    }
  }

  watch(
    () => bundle.value?.syncStatus.generatedAt,
    () => {
      const badge = bundle.value?.syncStatus.badges.find(
        (b) => b.name === 'horizon.time-defaults.global',
      );
      if (badge) void loadOrgDefault();
    },
    { immediate: false },
  );

  function setUserOverride(minutes: number): void {
    userOverride.value = minutes;
    writeUserOverride(minutes);
  }

  function clearUserOverride(): void {
    userOverride.value = null;
    writeUserOverride(null);
  }

  return {
    defaultWindowMinutes,
    userOverride,
    orgDefault,
    hasUserOverride,
    loadOrgDefault,
    setUserOverride,
    clearUserOverride,
  };
});
