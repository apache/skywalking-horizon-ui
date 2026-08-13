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

// Shipped-promise gate. A disabled affordance labelled "later release" /
// "coming soon" is a commitment the release cannot keep: it occupies UI
// real estate, it survives into every locale, and it outlives whatever
// note explained it. Ship the capability or ship nothing — never the
// promise. (This is why the runtime-rule page's "restore · later
// release" panel was deleted rather than reworded.)
//
// Two scan surfaces, chosen so an honest engineering note never trips
// the gate:
//
//   1. en.json keys AND values. Every user-visible chrome string is a
//      catalog key (check-ui-i18n.mjs enforces that for literal t()),
//      so the source catalog is the one choke point every shipped
//      string passes through. Non-English catalogs are covered by
//      proxy: they are key-parity-gated against en.json, so a promise
//      cannot enter them without its English key existing here.
//   2. The <template> block of each .vue, HTML comments stripped —
//      catching text hardcoded straight into markup, past t(). Script
//      blocks are deliberately NOT scanned: "not yet supported by OAP"
//      is a legitimate code comment, and a gate that fires on comments
//      gets disabled instead of obeyed.
//
// If a phrase below is genuinely the right thing to say about the
// BACKEND rather than about Horizon's roadmap (e.g. an OAP capability
// that does not exist), phrase it as a statement of fact about OAP
// today — not as a promise about a Horizon release.

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const SRC = join(ROOT, 'apps/ui/src');
const EN = join(SRC, 'i18n/locales/en.json');

const PROMISE_PATTERNS = [
  /\blater release\b/i,
  /\bfuture release\b/i,
  /\bcoming soon\b/i,
  /\bwill land\b/i,
  /\bnot yet (?:implemented|supported|available)\b/i,
  /\bstay tuned\b/i,
  /\bwork in progress\b/i,
];

function firstMatch(text) {
  for (const p of PROMISE_PATTERNS) {
    const m = p.exec(text);
    if (m) return m[0];
  }
  return null;
}

function* walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.name.endsWith('.vue')) yield p;
  }
}

/** The SFC root <template>, minus HTML comments. Nested `<template #slot>`
 *  tags sit inside it, so the outermost pair is the right span. */
function rootTemplate(text) {
  const open = text.indexOf('\n<template>');
  const close = text.lastIndexOf('\n</template>');
  if (open < 0 || close <= open) return '';
  return text.slice(open, close).replace(/<!--[\s\S]*?-->/g, '');
}

const violations = [];

const en = JSON.parse(readFileSync(EN, 'utf8'));
for (const [key, value] of Object.entries(en)) {
  if (key === '_comment') continue;
  const hit = firstMatch(key) ?? firstMatch(String(value));
  if (hit) violations.push([relative(ROOT, EN), hit, key]);
}

for (const file of walk(SRC)) {
  const tpl = rootTemplate(readFileSync(file, 'utf8'));
  if (!tpl) continue;
  for (const line of tpl.split('\n')) {
    const hit = firstMatch(line);
    if (hit) violations.push([relative(ROOT, file), hit, line.trim()]);
  }
}

if (violations.length > 0) {
  console.error(`✗ ${violations.length} shipped "later release" promise(s) in the UI:`);
  for (const [where, hit, context] of violations) {
    console.error(`  ${where}: ${JSON.stringify(hit)} — ${JSON.stringify(context.slice(0, 120))}`);
  }
  console.error(
    '  Ship the capability or remove the affordance. Do not restate it as future work.',
  );
  process.exit(1);
}

console.log(
  `✓ ui-promises OK: no "later release" affordance in ${Object.keys(en).length - 1} catalog keys or any .vue template`,
);
