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
 * Extract one version's section from CHANGELOG.md and emit it as a GitHub
 * release body, with hard-wrapped paragraphs and list items UNWRAPPED.
 *
 * Usage: node scripts/changelog-release-notes.mjs <version> [changelog-path]
 *          → prints the reflowed section to stdout (exits 1 if not found)
 *        node scripts/changelog-release-notes.mjs --whole-file [changelog-path]
 *          → prints the WHOLE file reflowed (one line per paragraph / item);
 *            pipe back over CHANGELOG.md to normalize the source to the
 *            one-line house style.
 *
 * Why this exists — the two markdown contexts render newlines differently:
 *   - A `.md` file viewed in a repo renders as CommonMark, where a single
 *     newline inside a paragraph is a SOFT break → collapsed to a space, so
 *     the hard-wrapped CHANGELOG reflows to the container width and looks fine.
 *   - A GitHub *Release* body (like issues/PR comments) renders with GFM
 *     hard-line-breaks ON, where every single newline becomes a literal
 *     `<br>`. Feeding the ~80-col hard-wrapped CHANGELOG straight in produces
 *     a ragged column of short lines with a sea of right-hand whitespace.
 * So the committed CHANGELOG stays hard-wrapped (clean diffs, easy editing)
 * and this script joins each paragraph / list item onto a single physical
 * line for the release body, while preserving the block structure that DOES
 * depend on newlines: blank lines, headings, list markers + indentation,
 * code fences, blockquotes, tables, thematic breaks, and HTML blocks.
 */

import { readFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const wholeFile = argv[0] === '--whole-file';
const version = wholeFile ? null : argv[0];
const changelogPath = (wholeFile ? argv[1] : argv[1]) ?? 'CHANGELOG.md';
if (!wholeFile && !version) {
  process.stderr.write('usage: changelog-release-notes.mjs <version>|--whole-file [changelog-path]\n');
  process.exit(2);
}

/** Pull the lines strictly between `## <version>` and the next `## ` heading. */
function extractSection(content, v) {
  const lines = content.split('\n');
  const start = lines.findIndex((l) => l === `## ${v}`);
  if (start === -1) return null;
  let end = start + 1;
  while (end < lines.length && !/^## /.test(lines[end])) end++;
  return lines.slice(start + 1, end);
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

const content = readFileSync(changelogPath, 'utf8');

if (wholeFile) {
  // split/join round-trips the trailing newline (a final '\n' yields a
  // trailing '' element that reflow preserves), so the file ends as it began.
  process.stdout.write(reflow(content.split('\n')).join('\n'));
  process.exit(0);
}

const section = extractSection(content, version);
if (section === null) {
  process.stderr.write(`changelog-release-notes: no "## ${version}" section in ${changelogPath}\n`);
  process.exit(1);
}
process.stdout.write(reflow(section).join('\n') + '\n');
