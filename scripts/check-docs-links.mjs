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

// `docs/` is published wholesale to the Apache SkyWalking website, so a link
// that resolves on nobody's disk becomes a 404 on skywalking.apache.org. The
// failure is silent in review — a deleted page leaves its inbound links behind,
// looking exactly like working ones in the diff — which is how three links to a
// removed page survived the change that removed it.
//
// Three classes, all deterministic and all offline:
//
//   1. A relative link to a page that does not exist.
//   2. A `#anchor` naming no heading on the target page. Renaming a heading
//      breaks every deep link to it and nothing else notices.
//   3. A page missing from `docs/menu.yml`, or a menu entry naming no page.
//      An unlisted page is unreachable on the site even though it renders.
//
// External `http(s)` links are deliberately NOT fetched: a gate that depends on
// somebody else's uptime fails for reasons the author cannot fix, and a gate
// people learn to re-run until it passes is not a gate.

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const DOCS = join(ROOT, 'docs');

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.md')) out.push(p);
  }
  return out;
}

/**
 * GitHub's heading-slug rule, which is also what Hugo uses for these pages:
 * lowercase, drop everything that is not alphanumeric / space / hyphen (so
 * backticks, dots and parentheses vanish), then spaces to hyphens. A repeated
 * heading gets `-1`, `-2`, … exactly as GitHub numbers them.
 */
function slug(heading) {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N} -]/gu, '')
    .replace(/ /g, '-');
}

function anchorsOf(text) {
  const seen = new Map();
  const out = new Set();
  let inFence = false;
  for (const line of text.split('\n')) {
    // A `#` inside a fenced block is shell or YAML, not a heading.
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    const m = /^(#{1,6})\s+(.*?)\s*$/.exec(line);
    if (!m) continue;
    const base = slug(m[2]);
    if (!base) continue;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.add(n === 0 ? base : `${base}-${n}`);
  }
  return out;
}

/** Markdown links, minus fenced code — a path in a shell example is not a link.
 *  Fences are blanked rather than deleted so the reported line number still
 *  matches the file the author will open. */
function linksOf(text) {
  const blank = (m) => m.replace(/[^\n]/g, ' ');
  const stripped = text.replace(/```[\s\S]*?```/g, blank).replace(/~~~[\s\S]*?~~~/g, blank);
  const out = [];
  const re = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  let m;
  while ((m = re.exec(stripped)) !== null) {
    const before = stripped.slice(0, m.index);
    out.push({ target: m[1], line: before.split('\n').length });
  }
  return out;
}

const files = walk(DOCS).sort();
const anchors = new Map(files.map((f) => [f, anchorsOf(readFileSync(f, 'utf8'))]));
const errors = [];
const rel = (f) => relative(ROOT, f);

for (const file of files) {
  for (const { target, line } of linksOf(readFileSync(file, 'utf8'))) {
    if (/^(https?:|mailto:|tel:)/i.test(target)) continue;

    const [path, anchor] = target.split('#');
    const where = `${rel(file)}:${line}`;

    // A bare `#anchor` points at this same page.
    if (!path) {
      if (anchor && !anchors.get(file).has(anchor)) {
        errors.push(`${where}  →  #${anchor}  (no such heading on this page)`);
      }
      continue;
    }

    if (path.startsWith('/')) {
      errors.push(`${where}  →  ${target}  (site-absolute path; use a relative one so it resolves in the repo too)`);
      continue;
    }

    const resolved = resolve(dirname(file), path);
    if (!existsSync(resolved) || !statSync(resolved).isFile()) {
      errors.push(`${where}  →  ${target}  (no such file)`);
      continue;
    }
    if (anchor && resolved.endsWith('.md') && !anchors.get(resolved)?.has(anchor)) {
      errors.push(`${where}  →  ${target}  (${rel(resolved)} has no heading "#${anchor}")`);
    }
  }
}

// ── menu.yml: every page listed, every listing a page ──
// Deliberately regex rather than a YAML parser: the file is a flat list of
// `path: "/a/b"` entries, and this check must not need a dependency to run.
const menuFile = join(DOCS, 'menu.yml');
const menuPaths = [...readFileSync(menuFile, 'utf8').matchAll(/^\s*path:\s*"?([^"\s]+)"?\s*$/gm)].map((m) => m[1]);

// A menu path is a site URL, and the site lower-cases them — `/readme` serves
// `README.md`. So a menu entry is matched against the real filenames rather
// than assumed to be one: `existsSync` answers YES to `docs/readme.md` on a
// case-insensitive filesystem (macOS) and NO on Linux, which is how this check
// passed locally and failed in CI.
const byLower = new Map(files.map((f) => [f.toLowerCase(), f]));

const listed = new Set();
for (const p of menuPaths) {
  if (/^https?:/i.test(p)) continue;
  const want = join(DOCS, `${p.replace(/^\//, '')}.md`);
  const found = files.includes(want) ? want : byLower.get(want.toLowerCase());
  if (!found) {
    errors.push(`docs/menu.yml  →  ${p}  (no such page: ${rel(want)})`);
    continue;
  }
  listed.add(found);
}

for (const f of files) {
  if (f === menuFile || listed.has(f)) continue;
  errors.push(`${rel(f)}  is not listed in docs/menu.yml, so it is unreachable on the website`);
}

if (errors.length) {
  console.error(`\ndocs link check: ${errors.length} problem(s)\n`);
  for (const e of errors) console.error(`  ${e}`);
  console.error('');
  process.exit(1);
}
console.log(`docs link check: ${files.length} pages, all links and menu entries resolve`);
