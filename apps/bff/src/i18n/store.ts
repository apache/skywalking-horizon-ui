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
 * Translation-overlay store. Loads every `*.i18n.<lang>.json` sibling
 * next to the bundled layer and overview templates at boot, plus the
 * shared lexicon (`apps/bff/src/i18n/lexicon/<lang>.json`).
 *
 * Lookups are by `(scope, key, locale)` and resolve to either a
 * structural overlay (for templates) or a flat string-keyed map (for
 * the lexicon).
 *
 * The lexicon is read-only at runtime — the resolution path never
 * consults it. It exists for the `seed` CLI, which pre-fills per-template
 * overlays from common-phrase entries so translators only see the
 * template-local prose that actually needs human attention.
 *
 * Path probing matches the layer/overview loaders so dev (tsx-watched
 * source) and prod (esbuilt server.js) both locate the same files
 * without env-var ceremony.
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Locale } from './types.js';
import { OVERLAY_LOCALES } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Locate a bundled directory at runtime. Mirrors the probing in
 *  `logic/layers/loader.ts` so dev (tsx-watched source files), prod
 *  (esbuilt single bundle), and dev/prod Docker layouts all find the
 *  same content without env-var setup. */
function locateDir(...segs: string[]): string {
  const candidates = [
    // Self-contained dist (server.js + bundled_templates as siblings inside ./dist/).
    join(__dirname, ...segs),
    // Dev (tsx watch: apps/bff/src/i18n/ → up two for apps/bff/src/...).
    join(__dirname, '..', '..', ...segs),
    // Docker image (/app/dist/server.js → /app/...).
    join(__dirname, '..', ...segs),
    join(process.cwd(), ...segs),
  ];
  for (const dir of candidates) {
    if (existsSync(dir)) return dir;
  }
  return candidates[0];
}

const I18N_FILE = /\.i18n\.([A-Za-z]{2}(?:-[A-Za-z]{2})?)\.json$/;

/** Returns `{ stem, locale }` for `<stem>.i18n.<locale>.json`, or
 *  `null` when the filename isn't an overlay. The stem matches the
 *  source template's basename without `.json`. */
export function parseOverlayFilename(name: string): { stem: string; locale: Locale } | null {
  const m = name.match(I18N_FILE);
  if (!m) return null;
  const loc = m[1];
  const lower = loc.toLowerCase();
  const matched = (OVERLAY_LOCALES as readonly string[]).find((l) => l.toLowerCase() === lower);
  if (!matched) return null;
  const stem = name.slice(0, m.index);
  return { stem, locale: matched as Locale };
}

/** True for `<stem>.i18n.<lang>.json` — used by the layer / overview
 *  loaders to skip overlay files when scanning for source templates. */
export function isOverlayFilename(name: string): boolean {
  return I18N_FILE.test(name);
}

type OverlayMap = Map<string /* stem */, Map<Locale, unknown>>;

function loadOverlayDir(dir: string, keyMode: 'as-is' | 'upper'): OverlayMap {
  const out: OverlayMap = new Map();
  if (!existsSync(dir)) return out;
  for (const file of readdirSync(dir)) {
    const parsed = parseOverlayFilename(file);
    if (!parsed) continue;
    try {
      const raw = readFileSync(join(dir, file), 'utf-8');
      const data = JSON.parse(raw);
      const key = keyMode === 'upper' ? parsed.stem.toUpperCase() : parsed.stem;
      let perLocale = out.get(key);
      if (!perLocale) {
        perLocale = new Map();
        out.set(key, perLocale);
      }
      perLocale.set(parsed.locale, data);
    } catch (err) {
      // A malformed overlay should not stop the BFF from booting. Log
      // and keep serving English for that locale + template.
      console.warn(
        `i18n: failed to parse overlay ${file}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }
  return out;
}

let layerOverlays: OverlayMap | null = null;
let overviewOverlays: OverlayMap | null = null;
let lexicon: Map<Locale, Record<string, string>> | null = null;

/** Force a reload — called from the layer / overview admin write paths
 *  so the next request sees freshly-written overlay files. */
export function reloadI18nStore(): void {
  layerOverlays = null;
  overviewOverlays = null;
  lexicon = null;
}

function ensureLayerOverlays(): OverlayMap {
  if (!layerOverlays) {
    layerOverlays = loadOverlayDir(locateDir('bundled_templates', 'layers'), 'upper');
  }
  return layerOverlays;
}

function ensureOverviewOverlays(): OverlayMap {
  if (!overviewOverlays) {
    overviewOverlays = loadOverlayDir(locateDir('bundled_templates', 'overviews'), 'as-is');
  }
  return overviewOverlays;
}

function ensureLexicon(): Map<Locale, Record<string, string>> {
  if (lexicon) return lexicon;
  lexicon = new Map();
  const dir = locateDir('i18n', 'lexicon');
  for (const loc of OVERLAY_LOCALES) {
    const file = join(dir, `${loc}.json`);
    if (!existsSync(file)) continue;
    try {
      const raw = readFileSync(file, 'utf-8');
      const data = JSON.parse(raw) as Record<string, unknown>;
      const flat: Record<string, string> = {};
      for (const [k, v] of Object.entries(data)) {
        if (typeof v === 'string' && v.length > 0) flat[k] = v;
      }
      lexicon.set(loc, flat);
    } catch (err) {
      console.warn(
        `i18n: failed to parse lexicon ${loc}.json: ${err instanceof Error ? err.message : err}`,
      );
    }
  }
  return lexicon;
}

/** Layer-template overlay for the given UPPER_SNAKE layer key + locale.
 *  Returns `null` for English, missing files, or unsupported locales. */
export function getLayerOverlay(layerKey: string, locale: Locale): unknown | null {
  if (locale === 'en') return null;
  return ensureLayerOverlays().get(layerKey.toUpperCase())?.get(locale) ?? null;
}

/** Overview-dashboard overlay by dashboard id + locale. */
export function getOverviewOverlay(id: string, locale: Locale): unknown | null {
  if (locale === 'en') return null;
  return ensureOverviewOverlays().get(id)?.get(locale) ?? null;
}

/** Lexicon lookup — used by the seed CLI, NOT by the runtime path. The
 *  source-English string is the lookup key; the return is the locale's
 *  translation, or `null` when the lexicon has nothing for that string. */
export function lookupLexicon(sourceEnglish: string, locale: Locale): string | null {
  if (locale === 'en') return sourceEnglish;
  return ensureLexicon().get(locale)?.[sourceEnglish] ?? null;
}

/** Whole-lexicon access for the seed CLI — exposes the per-locale flat
 *  map so the seeder doesn't have to thrash through individual lookups. */
export function lexiconForLocale(locale: Locale): Record<string, string> {
  if (locale === 'en') return {};
  return { ...(ensureLexicon().get(locale) ?? {}) };
}
