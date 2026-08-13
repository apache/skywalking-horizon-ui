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

// Adversarial fixtures for `check-security.mjs`.
//
// A gate that has only ever been run against a clean repository has proved one
// thing: that it passes. Every case below is a payload that ONCE slipped past
// it — entity-encoded schemes, `/`-delimited tags, `.SVG`, unquoted and
// `.prop` bindings, JSON-escaped URLs, a duplicate key written through a
// unicode escape. They are kept as fixtures because each one was found by
// someone attacking the gate, and a regex is exactly the kind of code that
// silently stops matching.
//
// There is no test runner at the repo root, so this is a script in the same
// shape as its subject, run beside it from `pnpm lint:security`.

import { mkdtempSync, mkdirSync, writeFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = new URL('..', import.meta.url).pathname;
const GATE = join(ROOT, 'scripts/check-security.mjs');

/** A minimal tree with the layout the gate expects, plus `files`. */
function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), 'sec-fx-'));
  const seed = {
    'apps/ui/index.html': '<!doctype html><html><head></head><body></body></html>',
    'apps/ui/src/app.vue': '<template><div /></template>',
    'apps/bff/src/bundled_templates/layers/general.json': '{"key":"GENERAL"}',
    ...files,
  };
  for (const [rel, body] of Object.entries(seed)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
  return root;
}

/** Run the real gate over a fixture root; return its findings as text. */
function scan(root) {
  try {
    execFileSync('node', [GATE], {
      env: { ...process.env, HORIZON_SCAN_ROOT: root },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return '';
  } catch (err) {
    return `${err.stdout ?? ''}${err.stderr ?? ''}`;
  }
}

const SVG_IMPORTER = `<script setup>import s from '@/assets/icons/logo.svg?raw';</script>
<template><span v-html="s" /></template>`;

/** `[name, files, expected]` — expected '' means the fixture must PASS. */
const CASES = [
  [
    'clean tree passes',
    { 'apps/ui/src/assets/icons/logo.svg': '<svg xmlns="http://www.w3.org/2000/svg"></svg>' },
    '',
  ],
  [
    'entity-encoded javascript: in a ?raw SVG',
    {
      'apps/ui/src/app.vue': SVG_IMPORTER,
      'apps/ui/src/assets/icons/logo.svg': '<svg><a href="java&#115;cript:alert(1)">x</a></svg>',
    },
    'javascript:',
  ],
  [
    'slash-delimited tag evades element detection',
    {
      'apps/ui/src/app.vue': SVG_IMPORTER,
      'apps/ui/src/assets/icons/logo.svg': '<svg><iframe/src="https://evil.example/"></iframe></svg>',
    },
    'embedded browsing context',
  ],
  [
    'uppercase .SVG escapes both the SVG and image families',
    { 'apps/ui/src/assets/icons/logo.SVG': '<svg><script>alert(1)</script></svg>' },
    '<script> element',
  ],
  [
    'unquoted :href binding',
    { 'apps/ui/src/app.vue': '<template><a :href=evilUrl>x</a></template>' },
    'unregistered',
  ],
  [
    '.prop shorthand binding',
    { 'apps/ui/src/app.vue': '<template><a .href="evilUrl">x</a></template>' },
    'unregistered',
  ],
  [
    'remote resource keeps no host exemption',
    {
      'apps/ui/src/app.vue':
        '<template><img src="https://skywalking.apache.org/x.png" /></template>',
    },
    'remote resource',
  ],
  [
    'bare-string @import',
    { 'apps/ui/src/a.css': '@import "https://evil.example/x.css";' },
    'remote @import',
  ],
  [
    'ordinary remote url() in CSS',
    { 'apps/ui/src/a.css': '.x{background:url(https://evil.example/bg.png)}' },
    'remote CSS asset',
  ],
  [
    'JSON-escaped remote URL in a template',
    {
      'apps/bff/src/bundled_templates/layers/general.json':
        '{"key":"GENERAL","icon":"https:\\/\\/evil.example\\/x.png"}',
    },
    'external URL',
  ],
  [
    'duplicate key written through a unicode escape',
    {
      'apps/bff/src/bundled_templates/layers/general.json':
        '{"key":"GENERAL","alias":"a","\\u0061lias":"b"}',
    },
    'duplicate JSON key',
  ],
  [
    'asset type outside the allow-list',
    { 'apps/ui/public/icon.gif': 'GIF89a' },
    'not an allowed asset type',
  ],
  [
    'bytes disagree with the extension',
    { 'apps/ui/public/x.png': '<html><script>alert(1)</script></html>' },
    'bytes are not .png',
  ],
  [
    'a wide array must not crash the depth check',
    {
      'apps/bff/src/bundled_templates/layers/general.json': `{"key":"GENERAL","a":[${'1,'.repeat(199999)}1]}`,
    },
    '',
  ],
];

let failed = 0;
for (const [name, files, expected] of CASES) {
  const out = scan(fixture(files));
  const ok = expected === '' ? out === '' : out.includes(expected);
  if (!ok) {
    failed++;
    console.error(`✗ ${name}`);
    console.error(expected === '' ? '    expected NO findings, got:' : `    expected a finding containing ${JSON.stringify(expected)}, got:`);
    console.error(`    ${out.trim().split('\n').join('\n    ') || '(nothing)'}`);
  }
}

if (failed > 0) {
  console.error(`\n✗ security self-test: ${failed}/${CASES.length} case(s) failed`);
  console.error('  The gate stopped detecting something it used to. Fix the check, not the fixture.');
  process.exit(1);
}
console.log(`✓ security self-test OK: ${CASES.length} adversarial fixtures still detected`);
