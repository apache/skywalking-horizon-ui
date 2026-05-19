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
 * Theme selection — three-tier resolution.
 *
 *   browser (this user's localStorage)
 *     ↑ overrides
 *   org default   (admin set on /admin/global-defaults, stored on OAP
 *                  as `horizon.theme.active`)
 *     ↑ overrides
 *   bundled code  (`bundled_templates/theme/active.json`)
 *
 * Each tier is observable so the UI can render "your override differs
 * from the org default" affordances. The store keeps the resolved id
 * and reflects it via `<html data-theme="<id>">`; CSS in
 * `themes.css` swaps tokens off that attribute. Adding a theme is
 * one CSS block + one entry in `AVAILABLE_THEMES`.
 */

import { defineStore } from 'pinia';
import { computed, ref, watch } from 'vue';
import { useConfigBundle } from '@/controls/configBundle';
import { debug } from '@/utils/debug';
import type { TemplateBadge } from '@/api/scopes/configs';

export type ThemeId = 'horizon' | 'obsidian' | 'aurora' | 'meridian' | 'daybreak';

/** The five bundled themes (design-specified names). Matches the
 *  `[data-theme="..."]` selectors in
 *  `packages/design-tokens/src/themes.css`. The first three are dark;
 *  the last two are light. */
export const AVAILABLE_THEMES: ReadonlyArray<{
  id: ThemeId;
  label: string;
  description: string;
  /** `dark` themes use the white SkyWalking logo; `light` themes use
   *  the blue (`#1368B3`) variant. Read by the brand-logo CSS to know
   *  which inline SVG to show. */
  appearance: 'dark' | 'light';
}> = [
  { id: 'horizon',  label: 'Horizon',  description: 'Flagship dark — canyon orange accent on deep blue-grey. Default.', appearance: 'dark' },
  { id: 'obsidian', label: 'Obsidian', description: 'Dark, blue accent.',  appearance: 'dark' },
  { id: 'aurora',   label: 'Aurora',   description: 'Dark, pink accent.',  appearance: 'dark' },
  { id: 'meridian', label: 'Meridian', description: 'Dark, purple accent.', appearance: 'dark' },
  { id: 'daybreak', label: 'Daybreak', description: 'White light theme.',   appearance: 'light' },
];

const USER_KEY = 'horizon:theme:user';
const FALLBACK: ThemeId = 'horizon';

function readUserOverride(): ThemeId | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(USER_KEY);
    if (!raw) return null;
    if (AVAILABLE_THEMES.some((t) => t.id === raw)) return raw as ThemeId;
    return null;
  } catch {
    return null;
  }
}

function writeUserOverride(id: ThemeId | null): void {
  if (typeof localStorage === 'undefined') return;
  try {
    if (id === null) localStorage.removeItem(USER_KEY);
    else localStorage.setItem(USER_KEY, id);
  } catch {
    /* quota / disabled storage — degrade silently */
  }
}

function isThemeBadge(b: TemplateBadge): boolean {
  return b.name === 'horizon.theme.active';
}

export const useThemeStore = defineStore('theme', () => {
  const userOverride = ref<ThemeId | null>(readUserOverride());

  // Org default is read directly from the bundle's syncStatus — the
  // bundle endpoint already overlays remote-wins on bundled per template.
  // For the singleton it doesn't carry the full content; we lazy-fetch
  // it on first need from /api/admin/templates/sync-status.
  const orgDefault = ref<ThemeId | null>(null);

  const { bundle } = useConfigBundle();

  // Resolved active id — what the renderer should display.
  const active = computed<ThemeId>(() => userOverride.value ?? orgDefault.value ?? FALLBACK);

  // Whether the user has explicitly chosen a theme that differs from the
  // org default. Drives the topbar chip's "dot" + the reset affordance.
  const hasUserOverride = computed<boolean>(() => {
    if (userOverride.value === null) return false;
    return userOverride.value !== (orgDefault.value ?? FALLBACK);
  });

  // Apply the active id to <html data-theme> AND <html data-appearance>
  // ('dark' / 'light') immediately AND on every change. The
  // `data-appearance` attribute drives appearance-dependent CSS the
  // theme palette alone can't express — e.g. the SkyWalking logo SVG
  // swap (white on dark, blue on light). Pinia stores can be created
  // before the DOM is ready in SSR setups; guard for that here.
  watch(
    active,
    (next) => {
      if (typeof document === 'undefined') return;
      document.documentElement.setAttribute('data-theme', next);
      const appearance =
        AVAILABLE_THEMES.find((t) => t.id === next)?.appearance ?? 'dark';
      document.documentElement.setAttribute('data-appearance', appearance);
      debug('theme', `applied data-theme="${next}" data-appearance="${appearance}"`);
    },
    { immediate: true },
  );

  /** Fetch the org default from the syncStatus admin endpoint. The
   *  badge in `configBundle.syncStatus` only carries status (not the
   *  themeId), so the store hits sync-status once at boot to read the
   *  actual value. */
  async function loadOrgDefault(): Promise<void> {
    // Lazy import to break a circular dep: api/client imports stores
    // (auth), stores would otherwise import api/client.
    const { bff } = await import('@/api/client');
    try {
      const status = await bff.templateSync.syncStatus();
      const row = status.rows.find((r) => r.name === 'horizon.theme.active');
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
      const envelope = JSON.parse(source) as { content?: { themeId?: unknown } };
      const id = envelope?.content?.themeId;
      if (typeof id === 'string' && AVAILABLE_THEMES.some((t) => t.id === id)) {
        orgDefault.value = id as ThemeId;
        debug('theme', `loaded org default = ${id}`);
      } else {
        orgDefault.value = null;
      }
    } catch (err) {
      debug('theme', 'failed to load org default', err);
      orgDefault.value = null;
    }
  }

  // When the bundle's syncStatus changes (refresh, resync, OAP came
  // back up), re-read the org default so the renderer follows.
  watch(
    () => bundle.value?.syncStatus.generatedAt,
    () => {
      const badge = bundle.value?.syncStatus.badges.find(isThemeBadge);
      if (badge) void loadOrgDefault();
    },
    { immediate: false },
  );

  function setUserOverride(id: ThemeId): void {
    userOverride.value = id;
    writeUserOverride(id);
  }

  function clearUserOverride(): void {
    userOverride.value = null;
    writeUserOverride(null);
  }

  return {
    active,
    userOverride,
    orgDefault,
    hasUserOverride,
    loadOrgDefault,
    setUserOverride,
    clearUserOverride,
  };
});
