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
 * Seed bundled-template translation catalogs from the shared lexicon.
 *
 * Run from the BFF package root:
 *
 *     pnpm i18n:seed                     # all locales, all templates
 *     pnpm i18n:seed -- --locale zh-CN   # one locale
 *     pnpm i18n:seed -- --dry            # report changes, don't write
 *
 * Behaviour:
 *   - For each bundled layer / overview source template, and each
 *     non-English locale, build a structural overlay that contains
 *     ONLY the translatable fields whose source-English value has a
 *     match in the lexicon. Per-template prose without a lexicon hit
 *     is left as a gap (omitted from the overlay) — the runtime
 *     merger falls through to English at the leaf, and operators
 *     fill the gap via the translation editor.
 *   - Existing per-template overlay values WIN over fresh lexicon
 *     entries. Once a translator has written a template-specific
 *     phrasing, the seed will not overwrite it even if the lexicon
 *     later grows the same key.
 *   - Empty resulting overlays (no lexicon coverage at all) skip the
 *     write to keep the working directory clean.
 *
 * The seeder honors a fixed allowlist of translatable field names —
 * the same allowlist the validate CLI uses to flag drift, and the
 * one CLAUDE.md → Internationalization documents as the contract.
 */

import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OVERLAY_LOCALES, type Locale } from './types.js';
import { isOverlayFilename, lexiconForLocale } from './store.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUNDLED_ROOT = join(__dirname, '..', 'bundled_templates');

/** Field names whose value is a translatable string. */
const STRING_FIELDS = new Set([
  'alias',
  'title',
  'description',
  'tip',
  'label',
  'group',
]);

/** Field names whose value is an object of `{ key: translatableString }`.
 *  Keys are NOT translated; only values are. Matches the layer
 *  template's `aliases` and `slots` and the overview's `aliases`. */
const STRING_VALUE_OBJECTS = new Set(['aliases', 'slots']);

/** Field names whose value is an array of translatable strings. */
const STRING_ARRAYS = new Set(['expressionLabels', 'tableHeaders']);

/** Walk the source tree and emit an overlay containing every
 *  translatable string the lexicon can fill. Returns `undefined` when
 *  there's nothing to translate at this subtree (so callers can
 *  recursively prune empty branches). */
function seedNode(source: unknown, lex: Record<string, string>): unknown | undefined {
  if (Array.isArray(source)) {
    const out = source.map((entry) => seedNode(entry, lex));
    if (out.every((e) => e === undefined)) return undefined;
    // Pad sparse entries with `null` so positional alignment with the
    // source is preserved — the runtime merger reads `overlay[i]` and
    // treats `null` as "fall through to source at this index."
    return out.map((e) => (e === undefined ? null : e));
  }
  if (source !== null && typeof source === 'object') {
    const rec = source as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rec)) {
      if (STRING_FIELDS.has(k) && typeof v === 'string') {
        const hit = lex[v];
        if (hit) out[k] = hit;
        continue;
      }
      if (STRING_VALUE_OBJECTS.has(k) && v !== null && typeof v === 'object' && !Array.isArray(v)) {
        const inner: Record<string, string> = {};
        for (const [ik, iv] of Object.entries(v as Record<string, unknown>)) {
          if (typeof iv === 'string') {
            const hit = lex[iv];
            if (hit) inner[ik] = hit;
          }
        }
        if (Object.keys(inner).length > 0) out[k] = inner;
        continue;
      }
      if (STRING_ARRAYS.has(k) && Array.isArray(v)) {
        const inner = v.map((entry: unknown) => {
          if (typeof entry === 'string') return lex[entry] ?? null;
          return null;
        });
        if (inner.some((e) => e !== null)) out[k] = inner;
        continue;
      }
      if (v !== null && typeof v === 'object') {
        const r = seedNode(v, lex);
        if (r !== undefined) out[k] = r;
      }
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }
  return undefined;
}

/** Deep-merge `existing` (already on disk) with `fresh` (seed output).
 *  Existing values WIN at leaves — once a translator has written
 *  something, the seed doesn't overwrite it. Structural keys present
 *  in either input are preserved. */
function mergeKeepExisting(existing: unknown, fresh: unknown): unknown {
  if (existing === undefined || existing === null) return fresh;
  if (fresh === undefined || fresh === null) return existing;
  if (Array.isArray(existing) && Array.isArray(fresh)) {
    const len = Math.max(existing.length, fresh.length);
    const out: unknown[] = [];
    for (let i = 0; i < len; i++) {
      out.push(mergeKeepExisting(existing[i], fresh[i]));
    }
    return out;
  }
  if (
    existing !== null &&
    typeof existing === 'object' &&
    !Array.isArray(existing) &&
    fresh !== null &&
    typeof fresh === 'object' &&
    !Array.isArray(fresh)
  ) {
    const out: Record<string, unknown> = {};
    const e = existing as Record<string, unknown>;
    const f = fresh as Record<string, unknown>;
    const keys = new Set([...Object.keys(e), ...Object.keys(f)]);
    for (const k of keys) {
      out[k] = mergeKeepExisting(e[k], f[k]);
    }
    return out;
  }
  return existing;
}

interface SeedReport {
  locale: Locale;
  stem: string;
  filled: number;
  preserved: number;
  gaps: number;
}

function countLeaves(node: unknown): number {
  if (node === null || node === undefined) return 0;
  if (typeof node === 'string') return 1;
  if (Array.isArray(node)) return node.reduce<number>((n, c) => n + countLeaves(c), 0);
  if (typeof node === 'object') {
    return Object.values(node as Record<string, unknown>).reduce<number>(
      (n, c) => n + countLeaves(c),
      0,
    );
  }
  return 0;
}

function countTranslatableLeaves(source: unknown): number {
  if (Array.isArray(source)) {
    return source.reduce<number>((n, c) => n + countTranslatableLeaves(c), 0);
  }
  if (source !== null && typeof source === 'object') {
    const rec = source as Record<string, unknown>;
    let n = 0;
    for (const [k, v] of Object.entries(rec)) {
      if (STRING_FIELDS.has(k) && typeof v === 'string') {
        n += 1;
        continue;
      }
      if (STRING_VALUE_OBJECTS.has(k) && v !== null && typeof v === 'object' && !Array.isArray(v)) {
        for (const iv of Object.values(v as Record<string, unknown>)) {
          if (typeof iv === 'string') n += 1;
        }
        continue;
      }
      if (STRING_ARRAYS.has(k) && Array.isArray(v)) {
        for (const entry of v) if (typeof entry === 'string') n += 1;
        continue;
      }
      if (v !== null && typeof v === 'object') n += countTranslatableLeaves(v);
    }
    return n;
  }
  return 0;
}

/** Apply the loader-side key migrations so the overlay's structural
 *  mirror matches what the runtime merger sees, not what the editor
 *  typed into the source file. Today's migration: `aliases` in the
 *  source JSON is normalised to `slots` on the LayerTemplate, so the
 *  overlay must mirror `slots`. Mirror-source-file behaviour would
 *  silently produce overlays whose top-level keys don't exist in the
 *  in-memory template — they'd parse, validate, and render nothing.
 *  Keep this in sync with `apps/bff/src/logic/layers/loader.ts:load()`. */
function normaliseSource(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const rec = raw as Record<string, unknown>;
  if (rec.aliases && !rec.slots) {
    const { aliases, ...rest } = rec;
    return { ...rest, slots: aliases };
  }
  return rec;
}

function seedDir(
  dir: string,
  locale: Locale,
  dry: boolean,
): SeedReport[] {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    return [];
  }
  const lex = lexiconForLocale(locale);
  const out: SeedReport[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.json') || isOverlayFilename(file)) continue;
    const stem = basename(file, '.json');
    const sourcePath = join(dir, file);
    const overlayPath = join(dir, `${stem}.i18n.${locale}.json`);
    let source: unknown;
    try {
      source = normaliseSource(JSON.parse(readFileSync(sourcePath, 'utf-8')));
    } catch (err) {
      console.error(`seed: failed to parse ${sourcePath}: ${err instanceof Error ? err.message : err}`);
      continue;
    }
    const fresh = seedNode(source, lex) ?? {};
    let existing: unknown = {};
    if (existsSync(overlayPath)) {
      try {
        existing = JSON.parse(readFileSync(overlayPath, 'utf-8'));
      } catch (err) {
        console.error(
          `seed: failed to parse existing overlay ${overlayPath}: ${err instanceof Error ? err.message : err}`,
        );
        continue;
      }
    }
    const merged = mergeKeepExisting(existing, fresh);
    const filled = countLeaves(merged);
    const preserved = countLeaves(existing);
    const total = countTranslatableLeaves(source);
    out.push({ locale, stem, filled, preserved, gaps: total - filled });
    if (!dry) {
      writeFileSync(overlayPath, JSON.stringify(merged, null, 2) + '\n', 'utf-8');
    }
  }
  return out;
}

interface Args {
  locale: Locale | null;
  dry: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  const out: Args = { locale: null, dry: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry') {
      out.dry = true;
      continue;
    }
    if (a === '--locale') {
      const v = argv[i + 1];
      if (!v) {
        console.error('seed: --locale requires a value');
        process.exit(2);
      }
      const match = (OVERLAY_LOCALES as readonly string[]).find(
        (l) => l.toLowerCase() === v.toLowerCase(),
      );
      if (!match) {
        console.error(`seed: unknown locale "${v}" (supported: ${OVERLAY_LOCALES.join(', ')})`);
        process.exit(2);
      }
      out.locale = match as Locale;
      i += 1;
      continue;
    }
    if (a === '-h' || a === '--help') {
      console.log(
        'Usage: pnpm i18n:seed [-- --locale <code>] [--dry]\n' +
          `  --locale <code>   one of: ${OVERLAY_LOCALES.join(', ')}\n` +
          '  --dry             report changes, do not write files',
      );
      process.exit(0);
    }
  }
  return out;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const locales: Locale[] = args.locale ? [args.locale] : [...OVERLAY_LOCALES];
  const reports: SeedReport[] = [];
  for (const locale of locales) {
    reports.push(...seedDir(join(BUNDLED_ROOT, 'layers'), locale, args.dry));
    reports.push(...seedDir(join(BUNDLED_ROOT, 'overviews'), locale, args.dry));
  }
  if (reports.length === 0) {
    console.log('seed: no templates found');
    return;
  }
  // Summary: per-locale aggregate, then per-template breakdown of gaps.
  const byLocale = new Map<Locale, { filled: number; gaps: number; templates: number }>();
  for (const r of reports) {
    const cur = byLocale.get(r.locale) ?? { filled: 0, gaps: 0, templates: 0 };
    cur.filled += r.filled;
    cur.gaps += r.gaps;
    cur.templates += 1;
    byLocale.set(r.locale, cur);
  }
  console.log(args.dry ? 'seed (dry-run):' : 'seed:');
  for (const [locale, agg] of byLocale) {
    const total = agg.filled + agg.gaps;
    const pct = total === 0 ? 100 : Math.round((agg.filled / total) * 100);
    console.log(
      `  ${locale}: ${agg.templates} templates, ${agg.filled}/${total} strings (${pct}%), ${agg.gaps} gaps`,
    );
  }
}

main();
