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
 * English-only i18n, substituted for `@/i18n` in the `ui://` build.
 *
 * The app bundles all eight catalogs so the locale picker switches
 * synchronously — 1.7 MB, and worth it there. This bundle has no picker, no way
 * to learn the host's language, and renders cards that are mostly
 * OAP-supplied text nobody translates; the other seven would be 1.7 MB nobody
 * reads. English is the source of truth, and this takes it.
 *
 * Substituted by ALIAS rather than by fixing each import, because the pull is
 * transitive — the API client, the auth store and the layer views each reach
 * `@/i18n` for their own reasons, and a rule that has to be re-applied to every
 * new importer is a rule that will be missed. The alias makes it structural:
 * nothing in this build can reach the catalogs, whatever it imports.
 *
 * It exports the same surface `@/i18n` does, so the substitution is invisible
 * to every component. `setLocale` is a no-op with nothing to switch to.
 */

import { createI18n } from 'vue-i18n';
import en from '@/i18n/locales/en.json';

export type Locale = 'en' | 'zh-CN' | 'es' | 'pt' | 'ja' | 'ko' | 'fr' | 'de';

export const SUPPORTED_LOCALES: readonly Locale[] = ['en'] as const;
export const LOCALE_NATIVE_LABEL: Record<string, string> = { en: 'English' };

export const i18n = createI18n({
  legacy: false,
  locale: 'en',
  fallbackLocale: 'en',
  messages: { en } as Record<string, Record<string, string>>,
  missingWarn: false,
  fallbackWarn: false,
});

export function currentLocale(): Locale {
  return 'en';
}
export function detectInitialLocale(): Locale {
  return 'en';
}
export function persistLocale(): void {}
export async function setLocale(): Promise<Locale> {
  return 'en';
}
