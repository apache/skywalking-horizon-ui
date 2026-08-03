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
// overlays; this covers the vue-i18n chrome catalogs). Two failure modes:
//
//   1. A literal `t('...')` key that is missing from en.json — the string
//      renders (key-as-message fallback) but no translator can ever reach
//      it, and a named-param key ('{n} things') renders its braces
//      literally. This is the regression class that once stranded 12 keys.
//   2. A locale catalog whose key set drifts from en.json — an extra key
//      is dead weight; a missing key silently falls back to English.
//
// Only literal single/double-quoted first arguments are checked; dynamic
// keys (t(variable), t(`tpl${x}`)) are out of scope by design.

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
for (const file of walk(SRC)) {
  const text = ' ' + readFileSync(file, 'utf8');
  allSource += text;
  for (const m of text.matchAll(CALL_RE)) {
    const key = (m[1] ?? m[2]).replace(/\\'/g, "'").replace(/\\"/g, '"');
    if (key.length === 0 || enKeys.has(key)) continue;
    if (!missing.has(key)) missing.set(key, relative(ROOT, file));
  }
  for (const m of text.matchAll(BACKTICK_RE)) {
    const key = m[1];
    if (key.length === 0 || enKeys.has(key)) continue;
    if (!missing.has(key)) missing.set(key, relative(ROOT, file));
  }
  for (const m of text.matchAll(KEYPATH_RE)) {
    const key = m[1] ?? m[2];
    if (key.length === 0 || enKeys.has(key)) continue;
    if (!missing.has(key)) missing.set(key, relative(ROOT, file));
  }
}
if (missing.size > 0) {
  failed = true;
  console.error(`✗ ${missing.size} literal t() key(s) missing from en.json:`);
  for (const [key, file] of missing) console.error(`  ${JSON.stringify(key)} — ${file}`);
}

// 3. A key left in en.json that no source file mentions. The parity check
//    below measures every other catalog AGAINST en.json, so an orphan in
//    en.json itself is invisible to it — it simply propagates: the key looks
//    "present everywhere" while nothing renders it. Membership is a plain
//    substring test over the source, not the t() patterns above, because a key
//    may be reached dynamically or split across lines; that keeps this a
//    dead-weight check and not a second, stricter usage rule.
//    REPORTS, does not fail: there is a standing backlog of ~80 such keys and
//    a substring test cannot see a key reached only from outside apps/ui/src
//    (a BFF-supplied label, a preset table). Blocking on it would stop CI on
//    work that did not cause it. Triage the list, then make this fail.
const orphans = [...enKeys].filter((k) => k !== '_comment' && !allSource.includes(k));
if (orphans.length > 0) {
  console.warn(`⚠ ${orphans.length} key(s) in en.json that no file under apps/ui/src mentions (not failing):`);
  for (const k of orphans.slice(0, 5)) console.warn(`  orphan: ${JSON.stringify(k)}`);
  if (orphans.length > 5) console.warn(`  … and ${orphans.length - 5} more`);
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
