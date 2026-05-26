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
 * Locale + translation-shape primitives shared by the runtime localizer,
 * the lexicon merger, and the seed / validate CLIs.
 *
 * English is the source. The non-English locales are catalog overlays
 * keyed by the same structural path as the source — see `merge.ts` for
 * the merge semantics.
 *
 * IMPORTANT — locale identifiers are stable wire values. Don't lowercase
 * or normalize them on disk; the canonical form is what shows up in
 * filenames (`general.i18n.zh-CN.json`) and the `X-Horizon-Locale`
 * header.
 */

export type Locale = 'en' | 'zh-CN' | 'es' | 'pt' | 'ja' | 'ko' | 'fr' | 'de';

/** All supported locales in display order — English first (rendered
 *  above a separator in the UI picker), then every other locale
 *  ordered alphabetically by code so additions slot in predictably. */
export const SUPPORTED_LOCALES: readonly Locale[] = ['en', 'de', 'es', 'fr', 'ja', 'ko', 'pt', 'zh-CN'] as const;

/** Locales with a translation overlay on disk (everything except
 *  English, which IS the source). The seed / validate CLIs iterate
 *  this. Same a-z order as SUPPORTED_LOCALES minus English. */
export const OVERLAY_LOCALES: readonly Exclude<Locale, 'en'>[] = [
  'de',
  'es',
  'fr',
  'ja',
  'ko',
  'pt',
  'zh-CN',
] as const;

/** Native-form labels for each locale — used by the in-app picker so
 *  the operator always sees the language in its own script regardless
 *  of which locale is currently active. */
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

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (SUPPORTED_LOCALES as readonly string[]).includes(value);
}
