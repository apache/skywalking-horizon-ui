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
 *                  as `horizon.theme.active`; served by the BFF only when
 *                  its template mode has a source for it)
 *     ↑ overrides
 *   in-code       (`FALLBACK`)
 *
 * Each tier is observable so the UI can render "your override differs
 * from the org default" affordances. The store keeps the resolved id
 * and reflects it via `<html data-theme="<id>">`; CSS in
 * `themes.css` swaps tokens off that attribute. Adding a theme is
 * one CSS block, one entry in the design-tokens `THEMES` list and
 * one in `AVAILABLE_THEMES`; the unit test keeps the two lists equal.
 */

import { defineStore } from 'pinia';
import { computed, ref, watch } from 'vue';
import { useConfigBundle } from '@/controls/configBundle';
import { debug } from '@/utils/debug';
import type { TemplateBadge } from '@/api/scopes/configs';
import type { ThemeId as SharedThemeId } from '@skywalking-horizon-ui/design-tokens';

/** The id list is shared with hosts outside Horizon (the renderer
 *  package's `themes.json` is generated from it). */
export type ThemeId = SharedThemeId;

/** Full per-theme metadata — lifted from the design bundle's
 *  `screens/style-setup.jsx`. The token values here are duplicated
 *  with the CSS in `packages/design-tokens/src/themes.css` BECAUSE
 *  the theme picker preview cards need inline-style access to the
 *  swatches (canvas / SVG can't read `var(--…)` synchronously).
 *  Runtime rendering still goes through the CSS — this table is for
 *  preview / preview-only consumption. */
export interface ThemeDef {
  id: ThemeId;
  label: string;
  tag: string;          // small chip text (e.g. "default", "high-contrast")
  tagline: string;      // one-line palette description
  description: string;  // operator-facing sentence
  appearance: 'dark' | 'light';  // drives logo + light-bg-specific code paths
  font: string;
  radius: number;
  density: 'Compact' | 'Spacious' | 'Comfortable';
  // Token snapshot (mirrors themes.css per id).
  bg0: string; bg1: string; bg2: string; line: string;
  fg0: string; fg1: string; fg2: string; fg3: string;
  accent: string; accentSoft: string; accentLine: string;
  info: string; purple: string; ok: string; err: string; warn: string;
  /** Hero background CSS for the preview card hero strip. Mirrors
   *  the design's `heroTint` plus the optional photo. */
  heroTint: string;
}

export const AVAILABLE_THEMES: readonly ThemeDef[] = [
  {
    id: 'horizon', label: 'Horizon', tag: 'default',
    tagline: 'Dark · amber accent · canyon hero',
    description: 'The shipped SkyWalking NG look. Dense, warm, observability-first.',
    appearance: 'dark', font: 'Inter', radius: 6, density: 'Compact',
    bg0: '#0a0d12', bg1: '#0f131a', bg2: '#151a23', line: '#232a37',
    fg0: '#e8ecf3', fg1: '#b6bdcc', fg2: '#818a9c', fg3: '#5b6373',
    accent: '#f97316', accentSoft: 'rgba(249,115,22,0.14)', accentLine: 'rgba(249,115,22,0.4)',
    info: '#38bdf8', purple: '#a855f7', ok: '#22c55e', err: '#ef4444', warn: '#eab308',
    heroTint: 'linear-gradient(180deg, rgba(10,13,18,0.10) 0%, rgba(10,13,18,0.85) 100%), radial-gradient(700px 460px at 20% 30%, rgba(249,115,22,0.22), transparent 60%)',
  },
  {
    id: 'meridian', label: 'Meridian', tag: 'dense',
    tagline: 'Navy ground · indigo accent',
    description: 'Cooler navy palette with an indigo accent. Tightly packed for SREs who live in tables.',
    appearance: 'dark', font: 'Inter', radius: 4, density: 'Compact',
    bg0: '#0b0f1a', bg1: '#101421', bg2: '#171c2e', line: '#232a3c',
    fg0: '#eef0f7', fg1: '#aeb4c7', fg2: '#7c8295', fg3: '#525a73',
    accent: '#7a5af8', accentSoft: 'rgba(122,90,248,0.16)', accentLine: 'rgba(122,90,248,0.4)',
    info: '#60a5fa', purple: '#c084fc', ok: '#34d399', err: '#f87171', warn: '#fbbf24',
    heroTint: 'radial-gradient(700px 500px at 50% 35%, rgba(122,90,248,0.20), transparent 60%), linear-gradient(180deg, #11142a, #0a0d1c)',
  },
  {
    id: 'obsidian', label: 'Obsidian', tag: 'high-contrast',
    tagline: 'True-black · cyan accent · monospaced',
    description: 'True-black backdrop and a cyan punch. Pixel-precise readouts; comfortable on OLED.',
    appearance: 'dark', font: 'IBM Plex Mono', radius: 2, density: 'Compact',
    bg0: '#000000', bg1: '#0a0a0a', bg2: '#141414', line: '#222222',
    fg0: '#f4f4f5', fg1: '#c4c4c4', fg2: '#888888', fg3: '#5a5a5a',
    accent: '#22d3ee', accentSoft: 'rgba(34,211,238,0.15)', accentLine: 'rgba(34,211,238,0.45)',
    info: '#7dd3fc', purple: '#d946ef', ok: '#84cc16', err: '#f43f5e', warn: '#facc15',
    heroTint: 'linear-gradient(180deg, #000 0%, #060606 100%), radial-gradient(500px 350px at 50% 50%, rgba(34,211,238,0.12), transparent 60%)',
  },
  {
    id: 'daybreak', label: 'Daybreak', tag: 'light',
    tagline: 'Light ground · violet accent · airy',
    description: 'Daytime palette with generous spacing and soft shadows. For shared screens and printouts.',
    appearance: 'light', font: 'Inter', radius: 10, density: 'Spacious',
    bg0: '#f7f7fa', bg1: '#ffffff', bg2: '#f0f1f5', line: '#e3e4ec',
    fg0: '#0a0d12', fg1: '#3a3f4c', fg2: '#6e7382', fg3: '#9ba0af',
    accent: '#6366f1', accentSoft: 'rgba(99,102,241,0.10)', accentLine: 'rgba(99,102,241,0.32)',
    info: '#0ea5e9', purple: '#a855f7', ok: '#16a34a', err: '#dc2626', warn: '#d97706',
    heroTint: 'linear-gradient(180deg, #eef0fa 0%, #f7f7fa 100%), radial-gradient(700px 460px at 70% 30%, rgba(99,102,241,0.18), transparent 60%)',
  },
  {
    id: 'aurora', label: 'Aurora', tag: 'showcase',
    tagline: 'Glass chrome · magenta/cyan gradient',
    description: 'Glass-morphic chrome with a magenta-to-cyan gradient accent. Made for demos and product tours.',
    appearance: 'dark', font: 'Inter', radius: 12, density: 'Comfortable',
    bg0: '#0b0d18', bg1: '#11142a', bg2: '#181b35', line: '#262a48',
    fg0: '#f1f3ff', fg1: '#b9bee0', fg2: '#828abe', fg3: '#525a8a',
    accent: '#ec4899', accentSoft: 'rgba(236,72,153,0.16)', accentLine: 'rgba(236,72,153,0.4)',
    info: '#22d3ee', purple: '#a855f7', ok: '#22d3ee', err: '#f43f5e', warn: '#fbbf24',
    heroTint: 'radial-gradient(600px 420px at 25% 30%, rgba(236,72,153,0.30), transparent 60%), radial-gradient(600px 420px at 75% 70%, rgba(34,211,238,0.25), transparent 60%), linear-gradient(180deg, #0b0d18, #131534)',
  },
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

/** The `horizon.theme.active` content, narrowed to a theme this build ships.
 *  An unknown id is treated as no org default rather than a broken render. */
function themeIdFrom(content: unknown): ThemeId | null {
  if (!content || typeof content !== 'object') return null;
  const id = (content as { themeId?: unknown }).themeId;
  if (typeof id !== 'string') return null;
  return AVAILABLE_THEMES.some((t) => t.id === id) ? (id as ThemeId) : null;
}

export const useThemeStore = defineStore('theme', () => {
  const userOverride = ref<ThemeId | null>(readUserOverride());

  // The config bundle carries only the singleton's sync BADGE, not its
  // themeId, so the value is lazy-fetched from the org-settings read.
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

  /** Read the org default from the effective org settings — an auth-only
   *  read every signed-in user can make, carrying just the resolved value.
   *  No value means no org default: `FALLBACK` applies. */
  async function loadOrgDefault(): Promise<void> {
    // Lazy import to break a circular dep: api/client imports stores
    // (auth), stores would otherwise import api/client.
    const { bff } = await import('@/api/client');
    try {
      const settings = await bff.configs.settings();
      const id = themeIdFrom(settings.theme);
      orgDefault.value = id;
      if (id) debug('theme', `loaded org default = ${id}`);
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
