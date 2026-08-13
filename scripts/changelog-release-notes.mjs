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
 * Emit one version's changelog as a GitHub release body, with hard-wrapped
 * paragraphs and list items UNWRAPPED.
 *
 * Usage: node scripts/changelog-release-notes.mjs <version> [file]
 *          → reflows docs/changelog/<version>.md, minus its `# <version>`
 *            page title, to stdout (exits 1 if the file is not there)
 *        node scripts/changelog-release-notes.mjs --whole-file <file>
 *          → prints the WHOLE file reflowed (one line per paragraph / item);
 *            pipe it back over the file to normalize it to the one-line
 *            house style.
 *
 * Every version keeps its own file, so there is one place to read and nothing
 * to search. Naming a file explicitly overrides the lookup —
 * scripts/release-finalize.sh passes the copy it read out of the tag, so the
 * published notes describe the bytes that were released rather than whatever
 * the working tree holds now.
 *
 * Why this exists — the two markdown contexts render newlines differently:
 *   - A `.md` file viewed in a repo renders as CommonMark, where a single
 *     newline inside a paragraph is a SOFT break → collapsed to a space, so a
 *     hard-wrapped paragraph reflows to the container width and looks fine —
 *     which is why the damage below is invisible in the repo file view.
 *   - A GitHub *Release* body (like issues/PR comments) renders with GFM
 *     hard-line-breaks ON, where every single newline becomes a literal
 *     `<br>`. Feeding a hard-wrapped section straight in produces a ragged
 *     column of short lines with a sea of right-hand whitespace.
 * The committed changelog is therefore written one physical line per paragraph
 * / list item, and this script is the backstop that joins any that were wrapped
 * anyway, while preserving the block structure that DOES depend on newlines:
 * blank lines, headings, list markers + indentation, code fences, blockquotes,
 * tables, thematic breaks, and HTML blocks.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const argv = process.argv.slice(2);
const wholeFile = argv[0] === '--whole-file';
const version = wholeFile ? null : argv[0];
const path = argv[1];
if (wholeFile ? !path : !version) {
  process.stderr.write('usage: changelog-release-notes.mjs <version> [file] | --whole-file <file>\n');
  process.exit(2);
}

/** Everything below the page title — the notes themselves. */
function body(content) {
  const lines = content.split('\n');
  const title = lines.findIndex((l) => l.startsWith('# '));
  return title === -1 ? lines : lines.slice(title + 1);
}

const isBlank = (l) => /^\s*$/.test(l);
const isHeading = (l) => /^#{1,6}\s/.test(l);
const isFence = (l) => /^\s*(```|~~~)/.test(l);
const isBlockquote = (l) => /^\s*>/.test(l);
const isTableRow = (l) => /^\s*\|/.test(l); // a line-leading pipe — inline `a | b` prose is safe
const isThematicBreak = (l) => /^\s*([-*_])(\s*\1){2,}\s*$/.test(l);
const isHtmlBlock = (l) => /^\s*<\/?[a-zA-Z]/.test(l);
const listItem = (l) => l.match(/^(\s*(?:[-*+]|\d+[.)])\s+)(.*)$/);

/**
 * Join soft-wrapped continuation lines into one physical line per paragraph /
 * list item. A "join group" is a maximal run of plain text lines; it is broken
 * by a blank line or by any block-starter, all of which pass through verbatim.
 */
function reflow(lines) {
  const out = [];
  let buf = null; // text pieces of the current join group
  let indent = ''; // leading whitespace / list marker of the group's first line
  let inFence = false;

  const flush = () => {
    if (buf) out.push((indent + buf.join(' ')).replace(/\s+$/, ''));
    buf = null;
    indent = '';
  };

  for (const raw of lines) {
    if (inFence) {
      out.push(raw);
      if (isFence(raw)) inFence = false;
      continue;
    }
    if (isFence(raw)) {
      flush();
      out.push(raw);
      inFence = true;
      continue;
    }
    if (isBlank(raw)) {
      flush();
      out.push('');
      continue;
    }
    if (isHeading(raw) || isBlockquote(raw) || isTableRow(raw) || isThematicBreak(raw) || isHtmlBlock(raw)) {
      flush();
      out.push(raw);
      continue;
    }
    const li = listItem(raw);
    if (li) {
      flush();
      indent = li[1];
      buf = [li[2].trim()];
      continue;
    }
    // plain text — start a paragraph, or continue the current group
    if (buf === null) {
      indent = raw.match(/^\s*/)[0];
      buf = [raw.trim()];
    } else {
      buf.push(raw.trim());
    }
  }
  flush();
  return out;
}

if (wholeFile) {
  const content = readFileSync(path, 'utf8');
  // split/join round-trips the trailing newline (a final '\n' yields a
  // trailing '' element that reflow preserves), so the file ends as it began.
  process.stdout.write(reflow(content.split('\n')).join('\n'));
  process.exit(0);
}

const notes = path ?? resolve(PROJECT_DIR, `docs/changelog/${version}.md`);
if (!existsSync(notes)) {
  process.stderr.write(`changelog-release-notes: ${notes} does not exist — ${version} has no changelog file.\n`);
  process.exit(1);
}
process.stdout.write(reflow(body(readFileSync(notes, 'utf8'))).join('\n') + '\n');
