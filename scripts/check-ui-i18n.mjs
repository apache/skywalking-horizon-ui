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

// UI-catalog i18n gate (the BFF's `i18n:validate` covers the template
// overlays; this covers the vue-i18n chrome catalogs). Four failure modes:
//
//   1. A literal `t('...')` key that is missing from en.json — the string
//      renders (key-as-message fallback) but no translator can ever reach
//      it, and a named-param key ('{n} things') renders its braces
//      literally. This is the regression class that once stranded 12 keys.
//   2. A Cluster-status module blurb the BFF authors but en.json does not
//      carry — same defect, except the call site is `t(m.affects)` so no
//      literal scan can see it.
//   3. A key left in en.json that nothing renders — dead weight every locale
//      then carries forever (the parity check below measures the other
//      catalogs AGAINST en.json, so an orphan there is invisible to it).
//   4. A locale catalog whose key set drifts from en.json — an extra key
//      is dead weight; a missing key silently falls back to English.
//
// Only literal single/double-quoted first arguments are scanned for (1).
// Keys reached dynamically — `t(variable)`, a preset table's `label`, a
// BFF-supplied string — cannot be checked that way, so (3) deliberately
// accepts a WEAKER proof of life; see the orphan section for what that costs.

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const SRC = join(ROOT, 'apps/ui/src');
const LOCALES_DIR = join(SRC, 'i18n/locales');

function* walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (/\.(vue|ts)$/.test(e.name) && !e.name.endsWith('.test.ts')) yield p;
  }
}

const en = JSON.parse(readFileSync(join(LOCALES_DIR, 'en.json'), 'utf8'));
const enKeys = new Set(Object.keys(en));

/** Unescape a JS string literal body captured by one of the regexes below.
 *  They capture the whole `\\.` escape class, so unescaping only the quotes
 *  would leave `\n` as a literal backslash-n and silently mint a key that
 *  matches no catalog entry. */
function unescape(body) {
  return body.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)/gs, (m, esc) => {
    const simple = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', 0: '\0' };
    if (esc[0] === 'u' || esc[0] === 'x') return JSON.parse(`"\\${esc.startsWith('u{') ? `u{${esc.slice(2, -1)}}` : esc}"`);
    return esc in simple ? simple[esc] : esc;
  });
}

/** The one catalog key set authored OUTSIDE apps/ui/src: Cluster status renders
 *  each preflight module's `affects` blurb through `t(...)`, and the module
 *  table lives in the BFF. Read exactly — a substring sweep of the whole BFF
 *  would let any coincidental prose vouch for a dead key.
 *
 *  The count is asserted against the module rows themselves, not merely
 *  against zero: one label reformatted to a template literal or a
 *  concatenation would otherwise extract fine for its siblings while (a)
 *  turning the missing-key rule off for that module and (b) reporting its very
 *  much live en.json key as an orphan to delete. */
const PREFLIGHT = join(ROOT, 'apps/bff/src/logic/preflight/preflight.ts');
const preflightSrc = readFileSync(PREFLIGHT, 'utf8');
const moduleTable = /const REQUIRED_MODULES[^=]*=\s*\[([\s\S]*?)\n\];/.exec(preflightSrc);
if (!moduleTable) {
  console.error(`✗ no REQUIRED_MODULES table found in ${relative(ROOT, PREFLIGHT)} — the Cluster-status label rule cannot run; fix the extraction.`);
  process.exit(1);
}
const bffKeys = new Set(
  [...moduleTable[1].matchAll(/affects:\s*(['"])((?:[^\\]|\\.)*?)\1/gs)].map((m) => unescape(m[2])),
);
const declared = [...moduleTable[1].matchAll(/\baffects:/g)].length;
if (bffKeys.size !== declared) {
  console.error(
    `✗ extracted ${bffKeys.size} \`affects:\` label(s) from the REQUIRED_MODULES table in ${relative(ROOT, PREFLIGHT)}, but it declares ${declared} — every label must be a plain quoted string literal (no template literal, no concatenation), or this rule silently half-runs.`,
  );
  process.exit(1);
}

// t('key') / t("key") / $t('key') — first argument only, tolerant of the
// call being preceded by identifier chars (i18n.global.t, this.$t).
const CALL_RE = /[^\w$]\$?t\(\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")\s*[,)]/g;
// t(`key`) with NO interpolation — backticks used purely to avoid quote
// escaping. Interpolated template keys stay out of scope by design.
const BACKTICK_RE = /[^\w$]\$?t\(\s*`([^`$]*)`\s*[,)]/g;
// <i18n-t keypath="key"> — slot-composed messages resolve the same catalog.
const KEYPATH_RE = /keypath=(?:'([^']*)'|"([^"]*)")/g;

let failed = false;
const missing = new Map();
/** Every source file concatenated — the orphan check below tests membership
 *  against this rather than re-parsing call shapes. */
let allSource = '';
/** Keys parsed out of a t() call, UNESCAPED. The orphan check needs these
 *  separately from `allSource`: a key holding a quote is escaped at the call
 *  site (`server\'s`), so it never appears verbatim in the raw text. */
const referenced = new Set();
for (const file of walk(SRC)) {
  const text = ' ' + readFileSync(file, 'utf8');
  allSource += text;
  const record = (key) => {
    if (key.length === 0) return;
    referenced.add(key);
    if (enKeys.has(key)) return;
    if (!missing.has(key)) missing.set(key, relative(ROOT, file));
  };
  for (const m of text.matchAll(CALL_RE)) record(unescape(m[1] ?? m[2]));
  for (const m of text.matchAll(BACKTICK_RE)) record(m[1]);
  for (const m of text.matchAll(KEYPATH_RE)) record(m[1] ?? m[2]);
}
for (const key of bffKeys) {
  if (!enKeys.has(key) && !missing.has(key)) missing.set(key, relative(ROOT, PREFLIGHT));
}
if (missing.size > 0) {
  failed = true;
  console.error(`✗ ${missing.size} key(s) rendered through t() but missing from en.json:`);
  for (const [key, file] of missing) console.error(`  ${JSON.stringify(key)} — ${file}`);
}

// Orphans (failure mode 3). Three ways to vouch for a key: a parsed t()
// literal, a BFF-authored label, or — for keys reached dynamically, which no
// literal scan can see — a plain substring of the source.
//
// That last one is deliberately weak, and its cost is one-directional: it can
// only let dead weight LIVE, never fail a live key. A key that happens to be a
// substring of a longer live key ("Live preview" inside "Live preview
// ({locale}) · click any widget to translate it") passes unexamined. Tightening
// it to a delimited match would catch those, and would also start failing every
// preset-table label whose quoting it did not anticipate — a worse trade for a
// gate that blocks CI. So the residue is REPORTED instead: the count below is
// how many keys nothing but coincidental prose vouches for, and it should trend
// toward zero rather than quietly grow.
const substringOnly = [];
const orphans = [];
for (const k of enKeys) {
  if (k === '_comment' || referenced.has(k) || bffKeys.has(k)) continue;
  if (allSource.includes(k)) substringOnly.push(k);
  else orphans.push(k);
}
if (orphans.length > 0) {
  failed = true;
  console.error(`✗ ${orphans.length} key(s) in en.json that nothing renders:`);
  for (const k of orphans) console.error(`  orphan: ${JSON.stringify(k)}`);
  console.error(
    '  Delete each from all 8 catalogs — unless it is reached dynamically from outside apps/ui/src, in which case teach this script about that source instead.',
  );
}
if (substringOnly.length > 0) {
  console.warn(`⚠ ${substringOnly.length} key(s) vouched for only by a substring match, not a t() call — possible dead weight.`);
}

for (const f of readdirSync(LOCALES_DIR)) {
  if (!f.endsWith('.json') || f === 'en.json') continue;
  const keys = new Set(Object.keys(JSON.parse(readFileSync(join(LOCALES_DIR, f), 'utf8'))));
  const absent = [...enKeys].filter((k) => k !== '_comment' && !keys.has(k));
  const extra = [...keys].filter((k) => k !== '_comment' && !enKeys.has(k));
  if (absent.length > 0 || extra.length > 0) {
    failed = true;
    console.error(`✗ ${f}: ${absent.length} key(s) missing, ${extra.length} not in en.json`);
    for (const k of absent.slice(0, 10)) console.error(`  missing: ${JSON.stringify(k)}`);
    for (const k of extra.slice(0, 10)) console.error(`  extra:   ${JSON.stringify(k)}`);
  }
}

if (failed) process.exit(1);
console.log(`✓ ui-i18n OK: ${enKeys.size - 1} keys, every literal t() key cataloged, all locales in parity`);
