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
 * UI-side i18n: vue-i18n bootstrap + message-as-default-key catalogs.
 *
 * Three concerns this module owns:
 *
 *   1. **Locale identity.** `Locale` is the same union as the BFF's —
 *      the wire is the contract. New locales are added in both places.
 *   2. **Bootstrap order.** localStorage first (the operator's
 *      remembered pick), then `navigator.languages`, then `'en'`. The
 *      pre-auth login page resolves through the same path so the very
 *      first paint lands in the right language.
 *   3. **Lazy loading.** English ships in the main bundle (no network
 *      fetch needed even on a clean install); other locales lazy-load
 *      on switch via `import('./locales/<lang>.json')`. Vite handles
 *      the chunk split.
 *
 * Source strings ARE the keys (Lingui-style). `t('Save')` works
 * without a key catalog because vue-i18n's `fallbackLocale: 'en'` and
 * `missingWarn: false` make a missing key resolve to the key itself.
 * The English catalog still ships explicitly so every visible string
 * is centrally inventoried for translators.
 */

import { createI18n } from 'vue-i18n';
import en from './locales/en.json';

export type Locale = 'en' | 'zh-CN' | 'es' | 'pt' | 'ja' | 'ko';

export const SUPPORTED_LOCALES: readonly Locale[] = ['en', 'zh-CN', 'es', 'pt', 'ja', 'ko'] as const;

export const LOCALE_NATIVE_LABEL: Record<Locale, string> = {
  en: 'English',
  'zh-CN': '中文（简体）',
  es: 'Español',
  pt: 'Português',
  ja: '日本語',
  ko: '한국어',
};

const STORAGE_KEY = 'horizon:locale';

/** Resolve the operator's locale at first paint.
 *   1. localStorage (returning user on this device).
 *   2. navigator.languages (browser preference, q-ordered).
 *   3. 'en'.
 *
 *  Run synchronously so the very first render — even the pre-auth
 *  login page — lands in the right language. */
export function detectInitialLocale(): Locale {
  if (typeof window !== 'undefined') {
    try {
      const stored = window.localStorage?.getItem(STORAGE_KEY);
      if (stored && isSupported(stored)) return stored;
    } catch {
      /* private mode / disabled storage — fall through */
    }
  }
  const nav = typeof navigator !== 'undefined' ? navigator : null;
  if (nav && Array.isArray(nav.languages)) {
    for (const tag of nav.languages) {
      const match = matchSupported(tag);
      if (match) return match;
    }
  }
  if (nav && typeof nav.language === 'string') {
    const match = matchSupported(nav.language);
    if (match) return match;
  }
  return 'en';
}

function isSupported(v: string): v is Locale {
  return (SUPPORTED_LOCALES as readonly string[]).includes(v);
}

function matchSupported(tag: string): Locale | null {
  const lower = tag.toLowerCase();
  const exact = SUPPORTED_LOCALES.find((l) => l.toLowerCase() === lower);
  if (exact) return exact;
  const base = lower.split('-')[0];
  // Prefer a non-English variant that shares the base — `zh` should
  // match `zh-CN` rather than fall through to `en`.
  const variant = SUPPORTED_LOCALES.find(
    (l) => l !== 'en' && l.toLowerCase().split('-')[0] === base,
  );
  return variant ?? null;
}

/** Persist the operator's pick — survives logout / browser restart on
 *  this device. localStorage is the storage layer per the architecture
 *  decision (per-device, matches theme + time-defaults). */
export function persistLocale(locale: Locale): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage?.setItem(STORAGE_KEY, locale);
  } catch {
    /* swallow — private mode */
  }
}

export const i18n = createI18n({
  legacy: false,
  // English source ships in the main bundle (sync import above);
  // other locales are loaded on demand by `loadLocale()` below.
  locale: detectInitialLocale(),
  fallbackLocale: 'en',
  // Empty / missing key in the active locale falls through to English
  // silently rather than spamming the console with warnings the
  // operator can't act on.
  missingWarn: false,
  fallbackWarn: false,
  messages: { en } as Record<string, Record<string, string>>,
});

const loaded = new Set<string>(['en']);

/** Switch the active locale, fetching its catalog on demand. Returns
 *  the locale that ended up active (may differ from `next` if the
 *  catalog fetch fails — in which case we stay on the previous locale
 *  rather than render with a half-loaded message map). */
export async function setLocale(next: Locale): Promise<Locale> {
  if (i18n.global.locale.value === next) return next;
  if (!loaded.has(next)) {
    try {
      const mod = await loadLocale(next);
      i18n.global.setLocaleMessage(next, mod);
      loaded.add(next);
    } catch (err) {
      console.warn(`i18n: failed to load locale "${next}"`, err);
      return i18n.global.locale.value as Locale;
    }
  }
  i18n.global.locale.value = next;
  persistLocale(next);
  return next;
}

async function loadLocale(locale: Locale): Promise<Record<string, string>> {
  switch (locale) {
    case 'zh-CN':
      return (await import('./locales/zh-CN.json')).default as Record<string, string>;
    case 'es':
      return (await import('./locales/es.json')).default as Record<string, string>;
    case 'pt':
      return (await import('./locales/pt.json')).default as Record<string, string>;
    case 'ja':
      return (await import('./locales/ja.json')).default as Record<string, string>;
    case 'ko':
      return (await import('./locales/ko.json')).default as Record<string, string>;
    case 'en':
      return en as Record<string, string>;
  }
}

/** Active locale as a plain value — usable outside Vue components
 *  (e.g. the bffClient request interceptor that stamps every request
 *  with `X-Horizon-Locale`). */
export function currentLocale(): Locale {
  return i18n.global.locale.value as Locale;
}
