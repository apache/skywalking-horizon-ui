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
 * Folds the `ui://` build into ONE HTML file, and writes it where the BFF
 * serves it from.
 *
 * An MCP resource is a single string — a host mounts it in a sandboxed iframe
 * with no origin to resolve a second request against — so `<script src>` and
 * `<link rel=stylesheet>` become inline `<script>` and `<style>`. Vite inlines
 * fonts and images already (`assetsInlineLimit: Infinity`); this handles the
 * two it cannot.
 *
 * Written by hand rather than with a plugin because the whole job is three
 * string substitutions, and a build-time dependency that does three string
 * substitutions is a dependency to review, pin and keep on the ASF allow-list.
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = join(ROOT, 'apps/ui/dist-mcp-app');
const OUT_DIR = join(ROOT, 'apps/bff/src/ai/mcp/app');

const html = readFileSync(join(BUILD, 'mcp-app.html'), 'utf8');
const assets = join(BUILD, 'assets');
const files = Object.fromEntries(
  readdirSync(assets).map((f) => [f, readFileSync(join(assets, f), 'utf8')]),
);

const pick = (ext) => {
  const hits = Object.keys(files).filter((f) => f.endsWith(ext));
  if (hits.length !== 1) {
    // More than one means a chunk split — the sandbox cannot fetch the extra
    // file, so the page would mount blank with no error anywhere. Fail here.
    throw new Error(`expected exactly one ${ext} in the ui:// build, found ${hits.length}: ${hits.join(', ')}`);
  }
  return hits[0];
};

const js = pick('.js');
const css = Object.keys(files).some((f) => f.endsWith('.css')) ? pick('.css') : null;

/**
 * Both replacements pass a FUNCTION, never a string.
 *
 * A string replacement runs `$&`, `$'`, `` $` `` and `$1` substitution over the
 * REPLACEMENT — and minified JavaScript is full of those sequences. `$&` alone
 * re-inserts the matched text, which put the original `<script src=…>` tag back
 * into the output and left the page loading a file no sandbox can fetch. A
 * function replacement disables the whole mechanism.
 */
const inline = (text) =>
  // The HTML parser ends a script at `</script` followed by whitespace, `/` or
  // `>` — not at `</script>` alone — so the escape has to match the same set,
  // or a string literal in the bundle truncates the page.
  text.replace(/<\/script(?=[\s/>])/gi, '<\\/script');

let out = html
  .replace(new RegExp(`<script[^>]*src="[^"]*${js}"[^>]*></script>`), () =>
    `<script type="module">${inline(files[js])}</script>`,
  )
  .replace(/<link[^>]*rel="stylesheet"[^>]*>/, () => (css ? `<style>${files[css]}</style>` : ''));

// Check the HTML SKELETON, not the whole string: the bundle legitimately
// contains `/src/assets/...` as `import.meta.glob` keys, whose values are
// already data: URIs. Scanning the inlined bodies would fail on those.
const skeleton = out
  .replace(/<script[\s\S]*?<\/script>/gi, '<script/>')
  .replace(/<style[\s\S]*?<\/style>/gi, '<style/>');
const external = [
  ...[...skeleton.matchAll(/(?:src|href)="(?!data:)([^"]+)"/gi)].map((m) => m[1]),
  // Belt and braces: the skeleton scan strips script bodies non-greedily, so a
  // tag re-inserted INSIDE one is invisible to it — which is exactly what the
  // `$&` bug did. Look for the build's own asset path in the raw output too.
  ...[...out.matchAll(/(?:src|href)="\.?\/assets\/[^"]+"/gi)].map((m) => m[0]),
];
if (external.length) {
  throw new Error(
    `the ui:// bundle still references external files (${external.join(', ')}) — a sandboxed host cannot fetch them, so it would mount blank`,
  );
}

// The URI carries the content hash, so a new build is a new URI (cache-busting
// for free) and an unchanged build keeps its URI (fetched once per host). A
// conversation replayed later also renders with the renderer it was captured
// against, which is the right behaviour for frozen snapshots.
const hash = createHash('sha256').update(out).digest('hex').slice(0, 12);

mkdirSync(OUT_DIR, { recursive: true });
for (const f of readdirSync(OUT_DIR)) if (f.endsWith('.html')) rmSync(join(OUT_DIR, f));
writeFileSync(join(OUT_DIR, 'app.html'), out);
writeFileSync(join(OUT_DIR, 'hash.txt'), `${hash}\n`);

const kb = (Buffer.byteLength(out) / 1024).toFixed(0);
console.log(`ui:// bundle: ${kb} KB, one file, hash ${hash}`);
