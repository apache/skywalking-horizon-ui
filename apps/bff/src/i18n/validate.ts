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
 * Validate translation catalogs against the source templates and the
 * lexicon contract. Catches eight failure modes:
 *
 *   1. **Orphan keys.** Catalog entries whose source path no longer
 *      exists (renamed / deleted in the source template). Render-time
 *      simply ignores these, but they're dead weight and translators
 *      shouldn't be wasting effort on them.
 *   2. **Type drift.** Catalog values whose type doesn't match the
 *      source (e.g. catalog has a number, source has a string). Merge
 *      drops them, but they signal someone authored the wrong overlay
 *      structure.
 *   3. **Lexicon drift.** Keys in a non-English lexicon that don't
 *      exist in `lexicon/en.json` — the lexicon's source-of-truth gate.
 *   4. **Missing lexicon for advertised locale.** Every locale in
 *      OVERLAY_LOCALES must have a `lexicon/<code>.json`. The UI's
 *      picker lists these locales; a missing lexicon means every
 *      bundled-template lexicon prefill silently falls back to
 *      English for that locale.
 *   5. **Missing overlay file for advertised locale.** Every source
 *      template (`layers/<key>.json`, `overviews/<id>.json`) must have
 *      a sibling `<stem>.i18n.<locale>.json` for every locale in
 *      OVERLAY_LOCALES. Even `{}` is fine; the file's presence is
 *      what we gate on so a new locale doesn't silently ship with
 *      half its templates English-only.
 *   6. **Unknown / duplicate overlay ids.** An entry addressing a
 *      widget the source no longer has, or two entries claiming the
 *      same widget. The merger ignores both (first entry wins), so
 *      the translation silently disappears.
 *   7. **Mixed addressing.** One array holding both id-addressed and
 *      positional entries. The two have no shared meaning, and the
 *      merger drops the positional ones.
 *   8. **Un-migrated positional overlay.** An array whose source
 *      entries all carry a unique `id` but whose overlay entries carry
 *      none. It still renders (the merger falls back to position), but
 *      it cannot follow a widget through a reorder — the bundled
 *      catalogs must stay migrated.
 *
 * Exit code is non-zero on any failure so CI can gate.
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { OVERLAY_LOCALES, type Locale } from './types.js';
import { isOverlayFilename, parseOverlayFilename } from './store.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUNDLED_ROOT = join(__dirname, '..', 'bundled_templates');
const LEXICON_ROOT = join(__dirname, 'lexicon');

import {
  type Finding,
  overlayFindings,
  normaliseSource,
  walk,
} from './overlay-check.js';

export { overlayFindings, type Finding };

export function validateDir(dir: string, label: string, findings: Finding[]): void {
  if (!existsSync(dir)) return;
  const sourceByStem = new Map<string, unknown>();
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.json') || isOverlayFilename(file)) continue;
    const stem = basename(file, '.json');
    try {
      sourceByStem.set(stem, normaliseSource(JSON.parse(readFileSync(join(dir, file), 'utf-8'))));
    } catch (err) {
      findings.push({
        file: `${label}/${file}`,
        path: '',
        message: `source parse error: ${err instanceof Error ? err.message : err}`,
      });
    }
  }
  for (const file of readdirSync(dir)) {
    const parsed = parseOverlayFilename(file);
    if (!parsed) continue;
    const source = sourceByStem.get(parsed.stem);
    if (!source) {
      findings.push({
        file: `${label}/${file}`,
        path: '',
        message: `no source template found (looked for ${parsed.stem}.json)`,
      });
      continue;
    }
    let overlay: unknown;
    try {
      overlay = JSON.parse(readFileSync(join(dir, file), 'utf-8'));
    } catch (err) {
      findings.push({
        file: `${label}/${file}`,
        path: '',
        message: `overlay parse error: ${err instanceof Error ? err.message : err}`,
      });
      continue;
    }
    // Empty `{}` overlays pass the structural check but render the
    // template entirely in English at runtime. Flag them so "all
    // language files provided" can't silently mean "all UI is
    // English". If a locale genuinely should fall back to English at
    // every leaf, delete the overlay file — the missing-file check
    // below reports that as a separate finding so the choice is
    // explicit.
    if (
      overlay !== null &&
      typeof overlay === 'object' &&
      !Array.isArray(overlay) &&
      Object.keys(overlay as Record<string, unknown>).length === 0
    ) {
      findings.push({
        file: `${label}/${file}`,
        path: '',
        message:
          'empty overlay — every translatable string in this template will render in English for this locale',
      });
      continue;
    }
    walk(source, overlay, [], findings, `${label}/${file}`);
  }

  // Coverage check (Finding #5): every source template must have a
  // sibling overlay file per OVERLAY_LOCALES. Missing files mean the
  // locale renders fully-English for that template.
  for (const stem of sourceByStem.keys()) {
    for (const locale of OVERLAY_LOCALES as readonly Locale[]) {
      const expected = join(dir, `${stem}.i18n.${locale}.json`);
      if (!existsSync(expected)) {
        findings.push({
          file: `${label}/${stem}.i18n.${locale}.json`,
          path: '',
          message: `missing overlay for advertised locale "${locale}"`,
        });
      }
    }
  }
}

function validateLexicon(findings: Finding[]): void {
  const enPath = join(LEXICON_ROOT, 'en.json');
  if (!existsSync(enPath)) {
    findings.push({ file: 'lexicon/en.json', path: '', message: 'missing — required as the source registry' });
    return;
  }
  let en: Record<string, unknown>;
  try {
    en = JSON.parse(readFileSync(enPath, 'utf-8')) as Record<string, unknown>;
  } catch (err) {
    findings.push({
      file: 'lexicon/en.json',
      path: '',
      message: `parse error: ${err instanceof Error ? err.message : err}`,
    });
    return;
  }
  const enKeys = new Set(Object.keys(en).filter((k) => !k.startsWith('_')));
  for (const locale of OVERLAY_LOCALES as readonly Locale[]) {
    const file = join(LEXICON_ROOT, `${locale}.json`);
    // Coverage check (Finding #4): every advertised locale must have a
    // lexicon. A missing lexicon means every bundled-template prefill
    // silently falls back to English for this locale.
    if (!existsSync(file)) {
      findings.push({
        file: `lexicon/${locale}.json`,
        path: '',
        message: `missing lexicon for advertised locale "${locale}" — bundled-template seeding will fall back to English`,
      });
      continue;
    }
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown>;
    } catch (err) {
      findings.push({
        file: `lexicon/${locale}.json`,
        path: '',
        message: `parse error: ${err instanceof Error ? err.message : err}`,
      });
      continue;
    }
    for (const k of Object.keys(data)) {
      if (k.startsWith('_')) continue;
      if (!enKeys.has(k)) {
        findings.push({
          file: `lexicon/${locale}.json`,
          path: k,
          message: 'key not present in lexicon/en.json (lexicon source-of-truth)',
        });
      } else if (typeof data[k] !== 'string') {
        findings.push({
          file: `lexicon/${locale}.json`,
          path: k,
          message: 'value must be a string',
        });
      }
    }
  }
}

function main(): void {
  const findings: Finding[] = [];
  validateDir(join(BUNDLED_ROOT, 'layers'), 'layers', findings);
  validateDir(join(BUNDLED_ROOT, 'overviews'), 'overviews', findings);
  validateLexicon(findings);
  if (findings.length === 0) {
    console.log('i18n:validate: no findings');
    return;
  }
  for (const f of findings) {
    console.error(`  ${f.file}${f.path ? ':' + f.path : ''} — ${f.message}`);
  }
  console.error(`\ni18n:validate: ${findings.length} finding(s)`);
  process.exit(1);
}

// Importing this module (the tests do) must not run the CLI.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
