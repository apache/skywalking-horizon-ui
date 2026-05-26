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
// All six locale catalogs are bundled statically (~30 KB total). The
// gain over lazy-loading is that locale switching is synchronous and
// failure-free: no network fetch can fail between the user's click on
// "中文" and the page actually rendering in 中文. The previous
// dynamic-import scheme silently caught load failures, which made
// "the dropdown does nothing" the only visible symptom of any glitch
// in Vite's chunk resolution.
import en from './locales/en.json';
import zhCN from './locales/zh-CN.json';
import es from './locales/es.json';
import pt from './locales/pt.json';
import ja from './locales/ja.json';
import ko from './locales/ko.json';
import fr from './locales/fr.json';
import de from './locales/de.json';

export type Locale = 'en' | 'zh-CN' | 'es' | 'pt' | 'ja' | 'ko' | 'fr' | 'de';

// English on top with a separator in the picker; non-English locales
// ordered alphabetically by code so additions slot in predictably.
export const SUPPORTED_LOCALES: readonly Locale[] = ['en', 'de', 'es', 'fr', 'ja', 'ko', 'pt', 'zh-CN'] as const;

export const LOCALE_NATIVE_LABEL: Record<Locale, string> = {
  en: 'English',
  'zh-CN': '中文（简体）',
  es: 'Español',
  pt: 'Português',
  ja: '日本語',
  ko: '한국어',
  fr: 'Français',
  de: 'Deutsch',
};

const STORAGE_KEY = 'horizon:locale';

/** Resolve the operator's locale at first paint.
 *   1. localStorage (returning user on this device).
 *   2. 'en'.
 *
 *  Browser `navigator.languages` is intentionally NOT consulted —
 *  the project policy is "English by default; opt in to other
 *  locales via the picker". A user on a Chinese browser visiting
 *  for the first time sees English, picks their language, and the
 *  choice persists for them on this device. */
export function detectInitialLocale(): Locale {
  if (typeof window !== 'undefined') {
    try {
      const stored = window.localStorage?.getItem(STORAGE_KEY);
      if (stored && isSupported(stored)) return stored;
    } catch {
      /* private mode / disabled storage — fall through */
    }
  }
  return 'en';
}

function isSupported(v: string): v is Locale {
  return (SUPPORTED_LOCALES as readonly string[]).includes(v);
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
  locale: detectInitialLocale(),
  fallbackLocale: 'en',
  // Empty / missing key in the active locale falls through to English
  // silently rather than spamming the console with warnings the
  // operator can't act on.
  missingWarn: false,
  fallbackWarn: false,
  messages: {
    en,
    'zh-CN': zhCN,
    es,
    pt,
    ja,
    ko,
    fr,
    de,
  } as Record<string, Record<string, string>>,
});

/** Switch the active locale. Synchronous because every catalog is
 *  pre-bundled — no fetch, no failure mode. The async signature is
 *  kept so callers awaiting it (post-switch refetch chains) don't
 *  need restructuring. */
export async function setLocale(next: Locale): Promise<Locale> {
  if (i18n.global.locale.value === next) return next;
  i18n.global.locale.value = next;
  persistLocale(next);
  return next;
}

/** Active locale as a plain value — usable outside Vue components
 *  (e.g. the bffClient request interceptor that stamps every request
 *  with `X-Horizon-Locale`). */
export function currentLocale(): Locale {
  return i18n.global.locale.value as Locale;
}
