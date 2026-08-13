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

// A production dependency nobody imports is not merely clutter.
//
//   - It is listed in the binary LICENSE, so the release paperwork claims the
//     artifact bundles software it does not contain. Four such packages were
//     found by hand; two of them were in that inventory.
//   - It sits in the graph `pnpm audit --prod` watches, so a future advisory
//     against it blocks CI over something no operator runs.
//   - It is installed by everyone building from source.
//
// PRODUCTION dependencies only, on purpose. A devDependency is legitimately
// used by a package.json script, a binary on PATH, or a config this scan
// cannot see, and a gate that reports those gets switched off rather than
// obeyed. The narrow rule is the one worth enforcing: if it ships, something
// must reference it.

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;

/** Workspaces whose `dependencies` are shipped and therefore checkable. */
const WORKSPACES = ['apps/ui', 'apps/bff', 'packages/api-client', 'packages/design-tokens'];

/** Text a reference can legitimately live in. `src/` is the bulk, but a build
 *  plugin is imported by the workspace's own config — `@tresjs/core` is only
 *  ever named in `vite.config.ts`, and reporting it would be a false alarm. */
const CONFIG_FILES = [
  'vite.config.ts',
  'vitest.config.ts',
  'eslint.config.mjs',
  'index.html',
  'tsconfig.json',
  'tsconfig.app.json',
];
const SCANNED_EXT = new Set(['.ts', '.tsx', '.vue', '.js', '.mjs', '.cjs', '.css', '.scss', '.html', '.json']);

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === 'dist') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (SCANNED_EXT.has(extname(p))) out.push(p);
  }
  return out;
}

/** Everything in a workspace that could name a dependency. */
function haystack(wsDir) {
  const files = walk(join(wsDir, 'src'));
  for (const name of CONFIG_FILES) {
    const p = join(wsDir, name);
    if (existsSync(p) && statSync(p).isFile()) files.push(p);
  }
  return files.map((f) => readFileSync(f, 'utf8')).join('\n');
}

/** A module specifier: the exact name in quotes, optionally with a subpath.
 *  Catches `from 'pkg'`, `import 'pkg/style.css'`, `import('pkg')`,
 *  `require('pkg')` and CSS `@import 'pkg/x.css'` alike — and does NOT match
 *  a longer package that merely starts with the same characters. */
function isReferenced(text, pkg) {
  const escaped = pkg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`["'\`]${escaped}(/[^"'\`]*)?["'\`]`).test(text);
}

const findings = [];
let checked = 0;

for (const ws of WORKSPACES) {
  const dir = join(ROOT, ws);
  const pkgPath = join(dir, 'package.json');
  if (!existsSync(pkgPath)) continue;
  const deps = Object.keys(JSON.parse(readFileSync(pkgPath, 'utf8')).dependencies ?? {});
  if (deps.length === 0) continue;
  const text = haystack(dir);
  for (const dep of deps) {
    checked++;
    if (!isReferenced(text, dep)) findings.push([ws, dep]);
  }
}

if (findings.length > 0) {
  console.error(`✗ ${findings.length} production dependency(ies) referenced nowhere:`);
  for (const [ws, dep] of findings) console.error(`  ${ws}: ${dep}`);
  console.error(
    '\n  A shipped dependency nobody imports still enters the binary LICENSE and\n' +
      '  the audited production graph. Remove it, or reference it where it is used.',
  );
  process.exit(1);
}

console.log(`✓ unused-deps OK: all ${checked} production dependencies are referenced`);
