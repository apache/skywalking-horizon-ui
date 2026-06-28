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

// Source-budget guardrail. ESLint's max-lines covers code size in-editor;
// this gate adds the comment-VOLUME cap ESLint cannot express, and is the
// CI-runnable enforcer of both. A file is over budget when it carries more
// than CODE_MAX lines of code OR more than COMMENT_MAX lines of comment.
// SKIP is an explicit exemption list for files still mid-decomposition;
// empty now that every source file is within budget.

import { readFileSync, readdirSync } from 'node:fs';
import { execSync } from 'node:child_process';

const CODE_MAX = 2000;
const COMMENT_MAX = 500;
const SKIP = new Set([]);

const ROOTS = ['apps', 'packages', 'scripts'];
const PRUNE = new Set(['node_modules', 'dist', 'coverage']);

// File discovery prefers `git ls-files` (honours .gitignore for free), but falls
// back to a filesystem walk so the gate still runs in a git-less tree — a source
// release tarball / zip has no .git, and a raw execSync failure there would break
// `pnpm lint` with an opaque ENOENT instead of naming this gate. The walk skips
// dot-dirs and build/dep folders to approximate .gitignore (a clean source
// archive has none of these anyway, so the two paths agree there).
function sourceFiles() {
  let listing;
  try {
    listing = execSync('git ls-files', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\n');
  } catch {
    listing = [];
    const walk = (dir) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) { if (!PRUNE.has(e.name) && !e.name.startsWith('.')) walk(`${dir}/${e.name}`); }
        else listing.push(`${dir}/${e.name}`);
      }
    };
    for (const r of ROOTS) { try { walk(r); } catch { /* root absent — skip */ } }
  }
  return listing
    .filter((f) => /\.(ts|vue|js|mjs)$/.test(f) && !f.endsWith('.d.ts'))
    .filter((f) => ROOTS.some((r) => f.startsWith(`${r}/`)))
    .filter((f) => !/\.(test|spec)\.ts$/.test(f) && !SKIP.has(f));
}

const files = sourceFiles();

// Line-level classification: a line is comment if it sits inside a block
// comment (/* */ or <!-- -->) or opens with // or /* or <!--. Inline trailing
// comments count as code (the line carries code). Approximate by design — a
// guardrail flags comment-heavy files, it isn't a forensic tokenizer.
function classify(src, isVue) {
  let comment = 0;
  let blank = 0;
  let inBlock = false;
  let close = '';
  const lines = src.split('\n');
  for (const raw of lines) {
    const line = raw.trim();
    if (inBlock) {
      comment++;
      if (line.includes(close)) inBlock = false;
      continue;
    }
    if (line === '') { blank++; continue; }
    if (line.startsWith('//')) { comment++; continue; }
    if (line.startsWith('/*')) {
      comment++;
      if (!line.includes('*/')) { inBlock = true; close = '*/'; }
      continue;
    }
    if (isVue && line.startsWith('<!--')) {
      comment++;
      if (!line.includes('-->')) { inBlock = true; close = '-->'; }
      continue;
    }
  }
  return { code: lines.length - comment - blank, comment };
}

const over = [];
for (const f of files) {
  const { code, comment } = classify(readFileSync(f, 'utf8'), f.endsWith('.vue'));
  const probs = [];
  if (code > CODE_MAX) probs.push(`code ${code} > ${CODE_MAX}`);
  if (comment > COMMENT_MAX) probs.push(`comments ${comment} > ${COMMENT_MAX}`);
  if (probs.length) over.push(`  ${f} — ${probs.join('; ')}`);
}

if (over.length) {
  console.error(`✗ source-budget: ${over.length} file(s) over budget (code ≤ ${CODE_MAX}, comments ≤ ${COMMENT_MAX}):`);
  console.error(over.join('\n'));
  process.exit(1);
}
console.log(`✓ source-budget OK: ${files.length} files within ${CODE_MAX} code / ${COMMENT_MAX} comment lines`);
