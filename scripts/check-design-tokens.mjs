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
 * Every `var(--sw-*)` names a token that exists.
 *
 * A name nobody defines is not a missing colour — it is a SILENT one. With a
 * fallback the hardcoded value always wins, so a dark hex survives every
 * theme and the element is unreadable on a light one; without a fallback the
 * property is dropped and the element inherits whatever is around it. Either
 * way the theme system is bypassed and nothing says so. Twenty such names had
 * accumulated, among them the read-only banner's `--sw-text-strong`, which
 * rendered near-white text on Daybreak's white.
 */

import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const TOKEN_FILES = [
  'packages/design-tokens/src/tokens.css',
  'packages/design-tokens/src/themes.css',
  'apps/ui/src/assets/styles/global.css',
];

const defined = new Set();
for (const f of TOKEN_FILES) {
  for (const m of readFileSync(f, 'utf8').matchAll(/--(sw-[a-z0-9-]+)\s*:/g)) defined.add(m[1]);
}

const files = execSync('git ls-files apps/ui/src packages/conversation-view/src', { encoding: 'utf8' })
  .split('\n')
  .filter((f) => /\.(vue|ts|css)$/.test(f));

const bad = [];
for (const f of files) {
  const text = readFileSync(f, 'utf8');
  // A file may define its own, in CSS or through a `:style` binding —
  // `{ '--sw-side-w': width + 'px' }` is a definition too.
  const local = new Set([
    ...[...text.matchAll(/--(sw-[a-z0-9-]+)\s*:/g)].map((m) => m[1]),
    ...[...text.matchAll(/['"]--(sw-[a-z0-9-]+)['"]\s*:/g)].map((m) => m[1]),
  ]);
  for (const m of text.matchAll(/var\(\s*--(sw-[a-z0-9-]+)/g)) {
    if (!defined.has(m[1]) && !local.has(m[1])) {
      const line = text.slice(0, m.index).split('\n').length;
      bad.push(`${f}:${line} — var(--${m[1]}) names no token`);
    }
  }
}

if (bad.length > 0) {
  console.error(`✗ ${bad.length} reference(s) to a token that does not exist:`);
  for (const b of bad.slice(0, 40)) console.error(`  ${b}`);
  if (bad.length > 40) console.error(`  …and ${bad.length - 40} more`);
  console.error('  Use a token from packages/design-tokens, or define the custom property.');
  process.exit(1);
}
console.log(`✓ design-tokens OK: every var(--sw-*) in ${files.length} files names a defined token`);
