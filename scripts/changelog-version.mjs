#!/usr/bin/env node
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
 * The per-version changelog files: docs/changelog/<version>.md, one per release,
 * kept forever. Contributors write into the file whose version matches
 * package.json; a release reads it and never moves it.
 *
 * Commands:
 *   check <version>
 *       The release gate. Fails unless docs/changelog/<version>.md exists and
 *       has been filled in — a missing file, or one that still carries the stub
 *       line `seed` writes, stops the release before the tag exists.
 *   seed <version>
 *       Open the next cycle: write docs/changelog/<version>.md (title + stub)
 *       and add its docs/menu.yml entry. Both halves are idempotent, so a
 *       resumed release re-runs cleanly. Run it by hand when starting a patch
 *       line, where there is no preceding release to seed the file.
 *
 * `--repo-root <dir>` points either command at a tree other than this checkout
 * — scripts/release.sh runs them against the release clone, which is what gets
 * tagged and shipped.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Written by `seed`, rejected by `check` — one definition, so they cannot drift. */
const STUB = '(In development — fill in highlights here before cutting the release.)';

const DOC_DIR = 'docs/changelog';
const MENU_FILE = 'docs/menu.yml';
const MENU_GROUP = 'Release Notes';

const VERSION_RE = /^\d+\.\d+\.\d+$/;

function fail(message) {
  process.stderr.write(`changelog-version: ${message}\n`);
  process.exit(1);
}

function cmpVersion(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

const docPath = (version) => `${DOC_DIR}/${version}.md`;

// ========================== check ==========================

function cmdCheck(version, root) {
  const relative = docPath(version);
  const absolute = join(root, relative);
  if (!existsSync(absolute)) {
    fail(
      `${relative} does not exist. Every release reads its notes from that file — ` +
        `write it (or run: node scripts/changelog-version.mjs seed ${version}) and land it on the branch being released.`,
    );
  }
  const lines = readFileSync(absolute, 'utf8').split('\n');
  // Whole-line, not a substring: a changelog entry may legitimately quote the
  // stub while describing this gate, and a substring match would read that
  // prose as an unfilled release and abort.
  if (lines.some((line) => line === STUB)) {
    fail(`${relative} still carries the stub line — fill in the ${version} highlights before cutting the release.`);
  }
  // The title must BE the version AND lead the file. The release-notes
  // extractor drops the first H1 and publishes what follows, so anything above
  // it is silently discarded — and a file titled for another version would
  // publish under this one, a copy-paste from the previous release being the
  // obvious way in.
  const firstIndex = lines.findIndex((line) => line.trim() !== '');
  const title = firstIndex === -1 ? undefined : lines[firstIndex];
  if (title !== `# ${version}`) {
    fail(
      `${relative} is titled ${JSON.stringify(title ?? '(no # heading)')} — it must be exactly "# ${version}", ` +
        `since the release notes are published from this file under that version, ` +
        `and anything above the title is discarded by the extractor.`,
    );
  }
  // Headings alone are not notes. `## Highlights` under the title would satisfy
  // a "has a non-title line" test while publishing an empty release.
  const body = lines
    .slice(firstIndex + 1)
    .filter((line) => line.trim() !== '' && !line.trimStart().startsWith('#'));
  if (body.length === 0) {
    fail(
      `${relative} has headings and nothing under them — write the ${version} highlights before cutting the release.`,
    );
  }
  process.stdout.write(`changelog-version: ${relative} is present and filled in.\n`);
}

// ========================== seed ==========================

/**
 * Add the version's entry to the `Release Notes` group, positioned so the list
 * stays newest-first even when a patch on an older line is added after a newer
 * minor. Edited as text, not through a YAML round-trip, so the file keeps its
 * license header, comments and formatting.
 */
function ensureMenuEntry(root, version) {
  const menuPath = join(root, MENU_FILE);
  const content = readFileSync(menuPath, 'utf8');
  const sitePath = `/changelog/${version}`;
  if (content.includes(`path: "${sitePath}"`)) return false;

  const entry = [`      - name: "${version}"`, `        path: "${sitePath}"`];
  const lines = content.split('\n');
  const groupAt = lines.findIndex((l) => l === `  - name: "${MENU_GROUP}"`);
  if (groupAt === -1) {
    const tail = ['', `  - name: "${MENU_GROUP}"`, '    catalog:', ...entry, ''];
    writeFileSync(menuPath, `${content.replace(/\n*$/, '\n')}${tail.join('\n')}`);
    return true;
  }

  const catalogAt = lines.findIndex((l, i) => i > groupAt && l === '    catalog:');
  if (catalogAt === -1) fail(`${MENU_FILE}: the "${MENU_GROUP}" group has no catalog: list.`);
  let groupEnd = catalogAt + 1;
  while (groupEnd < lines.length && (lines[groupEnd].startsWith('      ') || lines[groupEnd].trim() === '')) groupEnd++;
  while (groupEnd > catalogAt + 1 && lines[groupEnd - 1].trim() === '') groupEnd--;

  // Sibling entries are `- name:` / `path:` pairs; each one's version is in its
  // path, so the newer version goes above the first entry it outranks.
  let insertAt = groupEnd;
  for (let i = catalogAt + 1; i < groupEnd; i++) {
    const match = lines[i].match(/^ {8}path: "\/changelog\/(\d+\.\d+\.\d+)"$/);
    if (match && cmpVersion(version, match[1]) > 0) {
      insertAt = i - 1;
      break;
    }
  }
  lines.splice(insertAt, 0, ...entry);
  writeFileSync(menuPath, lines.join('\n'));
  return true;
}

function cmdSeed(version, root) {
  const relative = docPath(version);
  const absolute = join(root, relative);
  if (existsSync(absolute)) {
    process.stdout.write(`changelog-version: ${relative} already exists — left as it is.\n`);
  } else {
    mkdirSync(join(root, DOC_DIR), { recursive: true });
    writeFileSync(absolute, `# ${version}\n\n${STUB}\n`);
    process.stdout.write(`changelog-version: wrote ${relative}\n`);
  }
  if (ensureMenuEntry(root, version)) {
    process.stdout.write(`changelog-version: added the "${version}" entry to ${MENU_FILE}\n`);
  }
}

// ========================== entry point ==========================

const argv = process.argv.slice(2);
const command = argv[0];
const positional = [];
let repoRoot = DEFAULT_ROOT;
for (let i = 1; i < argv.length; i++) {
  if (argv[i] === '--repo-root') {
    const value = argv[++i];
    if (value === undefined) fail('--repo-root needs a value.');
    repoRoot = resolve(value);
  } else if (argv[i].startsWith('--')) {
    fail(`unknown option ${argv[i]}`);
  } else {
    positional.push(argv[i]);
  }
}
if ((command === 'check' || command === 'seed') && !VERSION_RE.test(positional[0] ?? '')) {
  fail(`usage: changelog-version.mjs ${command} <X.Y.Z> [--repo-root <dir>]`);
}

switch (command) {
  case 'check':
    cmdCheck(positional[0], repoRoot);
    break;
  case 'seed':
    cmdSeed(positional[0], repoRoot);
    break;
  default:
    process.stderr.write(
      'usage: changelog-version.mjs check <X.Y.Z> [--repo-root <dir>]\n' +
        '       changelog-version.mjs seed  <X.Y.Z> [--repo-root <dir>]\n',
    );
    process.exit(2);
}
