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

// Security gate (`pnpm lint:security`). Four checks that a schema or a
// type-checker structurally cannot make, each anchored to a defect this
// project has actually reasoned about:
//
//   1. SVG payloads. An SVG imported with Vite's `?raw` suffix and
//      rendered through v-html becomes LIVE DOM and can execute script.
//      Every other image path (<img>, CSS background, three.js
//      TextureLoader) is the browser's secure static mode, where SVG
//      script never runs. Active content is a finding in EITHER case —
//      it has no business in a shipped asset — and the message says
//      which of the two you are looking at.
//   2. External references. The house rule is that every asset is
//      vendored; a remote reference in a shipped asset defeats both the
//      offline install and the CSP. This is the rule's enforcement.
//   3. URL-bearing bindings. `documentLink` reached an `<a :href>` with
//      no validation because nothing announced a new URL sink. The
//      binding set is tiny and deliberate, so it is pinned: adding one
//      is a review event, not a silent diff.
//   4. Template text structure. Duplicate JSON keys are invisible to
//      every schema — `JSON.parse` keeps the last and drops the rest
//      before zod ever sees the object — and deep nesting overflows the
//      i18n merge walker's stack (~5k levels, ~29 KB) long before any
//      size limit trips. Both are raw-text properties, so they are
//      checked here rather than in the zod validator.
//
// Runtime enforcement is a separate concern: this gate covers what the
// repo ships, not what an operator later stores on OAP.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, extname } from 'node:path';

// Overridable so `--self-test` can point the SAME code path at a fixture
// tree. A gate that only ever proves "today's repo passes" has never shown it
// can fail.
const ROOT = process.env.HORIZON_SCAN_ROOT ?? new URL('..', import.meta.url).pathname;
const UI_SRC = join(ROOT, 'apps/ui/src');
const UI_PUBLIC = join(ROOT, 'apps/ui/public');
const BUNDLED = join(ROOT, 'apps/bff/src/bundled_templates');
// Imported app-wide from the UI entry and named by CLAUDE.md as the canonical
// token stylesheet — a remote reference here ships to every page.
const DESIGN_TOKENS = join(ROOT, 'packages/design-tokens/src');

const findings = [];
const report = (where, message) => findings.push([where, message]);
const rel = (p) => relative(ROOT, p);

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
    else out.push(p);
  }
  return out;
}

// ---------------------------------------------------------------- 1. SVG

// Constructs that execute or reach off-origin. The strict set applies to
// SVGs that become live DOM; the baseline set to every SVG we ship.
/** Character references decode BEFORE the parser stores an attribute, so a
 *  scan of the raw bytes sees inert text where the browser sees a live URL
 *  (`java&#115;cript:`). Decoding here is what makes the patterns below mean
 *  what they say — matching raw text while claiming otherwise is worse than
 *  not checking, because it reads as covered. */
function decodeEntities(text) {
  return text
    .replace(/&#x([0-9a-f]+);?/gi, (_m, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);?/g, (_m, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&(amp|lt|gt|quot|apos|colon|Tab|NewLine);/gi, (_m, name) => {
      const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", colon: ':', tab: '\t', newline: '\n' };
      return named[String(name).toLowerCase()] ?? _m;
    });
}

// `[\s/]` after the tag name: the tokenizer reaches before-attribute-name
// state through `/` as well, so `<iframe/src=…>` is the same element as
// `<iframe src=…>`.
const SVG_ACTIVE = [
  [/<script[\s/>]/i, '<script> element'],
  // `/` also reaches before-attribute-name state, so `<animate/onbegin=…>`
  // parses to the same handler as the space-separated form.
  [/[\s/]on[a-z]+\s*=/i, 'inline event handler attribute'],
  [/javascript\s*:/i, 'javascript: URL'],
  [/<foreignObject[\s/>]/i, '<foreignObject> (can host HTML + script)'],
  [/<!ENTITY/i, 'DTD entity (XXE / billion-laughs vector)'],
  [/<!DOCTYPE/i, 'DOCTYPE declaration'],
  [/<(iframe|embed|object)[\s/>]/i, 'embedded browsing context'],
];
const EXTERNAL_REF = [
  [/(?:xlink:)?href\s*=\s*["']https?:\/\//i, 'external href'],
  [/url\(\s*["']?https?:\/\//i, 'external url() reference'],
  [/<use[^>]+href\s*=\s*["'](?!#)/i, '<use> pointing outside this document'],
];

/** SVGs pulled in with `?raw` — the only ones that reach v-html. */
function rawImportedSvgs(uiFiles) {
  const names = new Set();
  for (const f of uiFiles) {
    if (!/\.(vue|ts)$/.test(f)) continue;
    for (const m of readFileSync(f, 'utf8').matchAll(/['"][^'"]*\/([\w.-]+\.svg)\?raw['"]/g)) {
      names.add(m[1]);
    }
  }
  return names;
}

function checkSvgAssets(uiFiles) {
  // Case-insensitive: `logo.SVG` is loadable by Vite's `?raw` exactly like
  // `logo.svg`, and a case-sensitive filter let it escape BOTH this family
  // and the image check (whose lookup lowercases), i.e. every content check.
  const svgs = uiFiles.filter((f) => extname(f).toLowerCase() === '.svg');
  const raw = rawImportedSvgs(uiFiles);
  for (const f of svgs) {
    // Both the raw bytes and the decoded form: an entity hides a construct
    // from the first, and a decoded `&lt;script&gt;` is inert text that the
    // second must not report.
    const source = readFileSync(f, 'utf8');
    const text = `${source}\n${decodeEntities(source)}`;
    const base = f.split('/').pop();
    const strict = raw.has(base);
    for (const [re, what] of SVG_ACTIVE) {
      if (!re.test(text)) continue;
      // Active content only EXECUTES from the ?raw set (v-html). Elsewhere the
      // browser's static image mode neutralises it, so it is reported as a
      // finding there too but named for what it is — the two tiers differ in
      // wording only because both are defects in a shipped asset.
      report(
        rel(f),
        strict
          ? `${what} — this SVG is ?raw-imported into v-html, so it EXECUTES`
          : `${what} — inert in an <img> context, but not something we ship`,
      );
    }
    for (const [re, what] of EXTERNAL_REF) {
      if (re.test(text)) report(rel(f), `${what} — assets must be vendored`);
    }
  }
  return { scanned: svgs.length, strict: raw.size };
}

// Image policy: png, jpg and svg only, and the bytes must be what the name
// claims. Two properties, one check — a file whose content disagrees with its
// extension is served under the wrong Content-Type and is the shape a polyglot
// takes, and a format outside the set is one nothing here is prepared to
// handle. gif and webp are NOT supported: `useTopologyIcons` globs
// `*.{png,jpg}` and filters on the same two, so such a file silently drops out
// of the icon registry rather than failing — convert it, do not rename it.
const IMAGE_MAGIC = {
  '.png': [0x89, 0x50, 0x4e, 0x47],
  '.jpg': [0xff, 0xd8, 0xff],
  '.jpeg': [0xff, 0xd8, 0xff],
};
// Anything shipped under these trees that is not source, config or an
// allowed image is a finding — an ALLOW-list, because a deny-list of formats
// silently waved through .jfif, .apng, .svgz, an extensionless file, and even
// a stray .html dropped into public/.
const NON_ASSET_EXT = new Set([
  '.ts', '.vue', '.js', '.mjs', '.cjs', '.json', '.css', '.scss', '.md',
  '.woff', '.woff2', '.ttf', '.otf', '.d.ts', '.map', '.txt', '.yaml', '.yml',
]);

function checkImages(uiFiles) {
  let scanned = 0;
  for (const f of uiFiles) {
    const ext = extname(f).toLowerCase();
    if (ext === '.svg') continue; // its own family
    if (NON_ASSET_EXT.has(ext)) continue;
    const want = IMAGE_MAGIC[ext];
    if (!want) {
      report(
        rel(f),
        `${ext || '(no extension)'} is not an allowed asset type — images must be .png, .jpg or .svg`,
      );
      scanned++;
      continue;
    }
    scanned++;
    const head = readFileSync(f).subarray(0, 8);
    if (!want.every((b, i) => head[i] === b)) {
      report(
        rel(f),
        `bytes are not ${ext} — convert the asset rather than renaming it, or the topology-icon glob drops it`,
      );
    }
  }
  return scanned;
}

// --------------------------------------------------- 2. external references

function checkNoExternalRefs(uiFiles) {
  const indexHtml = join(ROOT, 'apps/ui/index.html');
  const html = readFileSync(indexHtml, 'utf8');
  for (const m of html.matchAll(/<(?:link|script)[^>]+(?:href|src)\s*=\s*["']https?:\/\/[^"']+/gi)) {
    report(rel(indexHtml), `remote asset reference — ${m[0].slice(0, 70)}`);
  }

  for (const f of uiFiles) {
    if (!/\.(vue|css|scss)$/.test(f)) continue;
    const text = readFileSync(f, 'utf8');
    // `@import url(...)` AND the bare-string form `@import "https://…";`,
    // which browsers fetch identically.
    for (const m of text.matchAll(/@import\s+(?:url\(\s*)?["']?(?:https?:)?\/\//gi)) {
      report(rel(f), `remote @import — ${m[0].slice(0, 60)}`);
    }
    for (const m of text.matchAll(/@font-face[^}]*src\s*:[^}]*url\(\s*["']?https?:\/\//gi)) {
      report(rel(f), 'remote webfont — fonts must be vendored');
    }
    // Any ordinary remote `url()` — a background-image, a mask, a cursor,
    // a list-style. `data:` and relative references are the normal case and
    // are left alone; only a reference that leaves the origin is a finding.
    for (const m of text.matchAll(/url\(\s*["']?((?:https?:)?\/\/[^"')\s]+)/gi)) {
      report(rel(f), `remote CSS asset — ${m[1].slice(0, 70)}`);
    }
  }
}

/** `documentLink` is the product's one operator-supplied outbound link;
 *  its destination is a runtime policy question, not a build-time one. */
const TEMPLATE_URL_ALLOWED_KEYS = new Set(['documentLink']);

// Walks the PARSED value, so `https:\/\/…` (a legal JSON escape decoding to
// the same string), a URL inside an array, and a non-word key are all seen —
// the loader reads JSON.parse output, so the check must too.
function checkTemplateExternalRefs(file, parsed) {
  const walkValue = (node, key) => {
    if (typeof node === 'string') {
      if (/^\s*(?:https?:)?\/\//i.test(node) && !TEMPLATE_URL_ALLOWED_KEYS.has(key)) {
        report(
          rel(file),
          `external URL under "${key ?? '(root)'}" — templates may not reference remote resources`,
        );
      }
      return;
    }
    if (Array.isArray(node)) {
      for (const v of node) walkValue(v, key);
      return;
    }
    if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) walkValue(v, k);
    }
  };
  walkValue(parsed, undefined);
}

// ------------------------------------------------- 3. URL-bearing bindings

// Every dynamic `:href` / `:src` in the UI, with the reason it is safe.
// A binding missing from this map fails the gate: adding a URL sink must
// be a deliberate, reviewed act.
const URL_BINDINGS = new Map([
  ['apps/ui/src/features/infra-3d/Infra3DScene.vue:openDashboardHref', 'internal router path'],
  [
    'apps/ui/src/layer/LayerShell.vue:layer.documentLink',
    'operator-supplied; scheme refused unless http(s)/same-origin and host checked against security.trustedLinkDomains, on both the publish and the read path',
  ],
  ['apps/ui/src/layer/service-map/LayerServiceMapView.vue:nodeIconUrl(n)!', 'bundled icon registry'],
  ["apps/ui/src/render/widgets/TraceStatsView.vue:componentIconOrNull(c.name) ?? ''", 'bundled icon registry'],
  ["apps/ui/src/render/widgets/TraceTreeView.vue:componentIconOrNull(n.span.component) ?? ''", 'bundled icon registry'],
  ["apps/ui/src/render/widgets/TraceWaterfallView.vue:componentIconOrNull(row.span.component) ?? ''", 'bundled icon registry'],
  ["apps/ui/src/layer/traces/TracePopout.vue:componentIconOrNull(row.span.component) ?? ''", 'bundled icon registry'],
  ["apps/ui/src/layer/traces/NativeTraceWaterfall.vue:componentIconOrNull(row.span.component ?? '') ?? ''", 'bundled icon registry'],
  [
    'apps/ui/src/features/auth/LoginView.vue:ssoProviders[0].icon',
    'operator-configured `data:` URI for a sign-in button; the schema refuses anything that is not `data:image/<type>;base64,<b64>` (apps/bff/src/config/schema.ts), and it renders through <img src> rather than v-html, so an SVG cannot execute — the CSP permits data: images and no remote origin at all. Horizon ships no vendor marks; see that field\'s comment for why',
  ],
  [
    'apps/ui/src/features/auth/LoginView.vue:chosenIcon',
    'the same operator-configured data: URI, selected by the provider picker',
  ],
  [
    'apps/ui/src/features/auth/LoginView.vue:p.icon',
    'the same operator-configured data: URI, drawn once per row in the provider list',
  ],
  [
    'apps/ui/src/features/auth/LoginView.vue:ssoHref(ssoProviders[0].id)',
    'ssoHref builds a same-origin PATH literal, so the origin and scheme are fixed by the code and no argument can move the navigation off this site; the provider id comes from this deployment\'s own config and both interpolations are encodeURIComponent-ed',
  ],
  [
    'apps/ui/src/features/auth/LoginView.vue:ssoHref(ssoChoice)',
    'same builder as above; ssoChoice is one of the ids the server listed, and the `next` it carries IS attacker-influenceable (from ?redirect=) so it is encoded here and independently re-checked server-side by safeNext(), which discards a scheme, an authority, a backslash or any control character',
  ],
]);

// All the spellings Vue compiles to the SAME href/src binding: `:href="x"`,
// `:href='x'`, `:href=x` (unquoted is valid HTML), `:HREF=` (attribute names
// are case-insensitive), `v-bind:href=`, `.href=` (the .prop shorthand) and
// modifier forms like `:href.attr=`. Each was verified to produce byte-
// identical DOM. No lint rule normalizes any of this — `flat/essential`
// carries neither `vue/v-bind-style` nor `vue/html-quotes` — so the table
// has to recognise every spelling itself or it is bypassable by syntax alone.
const URL_BINDING_RE =
  /(?:^|[\s<])(?::|v-bind:|\.)(href|src)(?:\.[\w.]+)?\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"'`]+))/gi;

// Forms that can carry an href/src the table cannot see: a dynamic attribute
// name, or a spread object literal that names one. A plain `v-bind="expr"` is
// NOT flagged — the only one in the tree binds a router-link `to`, and failing
// on every object spread would make this gate red over ordinary Vue.
//
// Residual gap, stated rather than papered over: an opaque `v-bind="expr"`
// whose object happens to contain `href` is invisible here. Closing it needs a
// template AST, not a regex.
const OPAQUE_BINDING_RE = /(?:^|[\s<]):\[|v-bind\s*=\s*["']\s*\{[^}]*\b(?:href|src)\b/g;

function checkUrlBindings(uiFiles) {
  const seen = new Set();
  for (const f of uiFiles) {
    if (extname(f) !== '.vue') continue;
    const text = readFileSync(f, 'utf8');
    for (const m of text.matchAll(URL_BINDING_RE)) {
      const value = m[2] ?? m[3] ?? m[4] ?? '';
      const id = `${rel(f)}:${value}`;
      seen.add(id);
      if (!URL_BINDINGS.has(id)) {
        report(rel(f), `unregistered :${m[1]} binding — ${JSON.stringify(value)}`);
      }
    }
    for (const _m of text.matchAll(OPAQUE_BINDING_RE)) {
      void _m;
      report(
        rel(f),
        'dynamic or spread attribute binding — its target cannot be checked statically; bind href/src explicitly',
      );
    }
  }
  // Staleness is a claim about THIS repository's inventory, so it is skipped
  // when a fixture root is being scanned — there the table legitimately names
  // files the tree does not have.
  if (!process.env.HORIZON_SCAN_ROOT) {
    for (const id of URL_BINDINGS.keys()) {
      if (!seen.has(id)) {
        report(id.split(':')[0], 'registered URL binding no longer exists — drop it from URL_BINDINGS');
      }
    }
  }
  return seen.size;
}

/** Hosts a hardcoded NAVIGATION link (`<a href>`) in shipped markup may point
 *  at. Mirrors the DEFAULT of `security.trustedLinkDomains`; an operator's own
 *  allow-list governs template-supplied links at runtime, not this build-time
 *  check.
 *
 *  It does NOT apply to resources. A remote `<img src>`, stylesheet, script or
 *  iframe fails whatever its host: the rule is that assets are vendored, and
 *  "we happen to trust that domain" is not vendoring — it still means the page
 *  fetches from the network at render time and breaks an air-gapped install. */
const STATIC_LINK_HOSTS = ['skywalking.apache.org'];

/** Remote URLs written literally into a template — `<img src="https://…">`,
 *  `<iframe src>`, `<a href>`. None of the other families looked at these:
 *  the SVG patterns apply only to `.svg` files and the CSS ones only to
 *  `@import` / `@font-face`. A remote asset defeats both the offline install
 *  and the CSP; a remote link leaves the console without passing the policy. */
function checkStaticRemoteRefs(uiFiles) {
  // index.html is the app's entry document and lives outside both scanned
  // trees, so it is appended explicitly — a remote <script> there is the most
  // direct supply-chain insert available.
  for (const f of [...uiFiles, join(ROOT, 'apps/ui/index.html')]) {
    if (!/\.(vue|html)$/i.test(f)) continue;
    const text = readFileSync(f, 'utf8');
    // Quoted, unquoted, and protocol-relative (`//host/x` loads over the page
    // scheme and is just as remote).
    for (const m of text.matchAll(
      /(<a\s[^>]*?)?\b(src|href|xlink:href)\s*=\s*(?:["']((?:https?:)?\/\/[^"']+)["']|((?:https?:)?\/\/[^\s>"'`]+))/gi,
    )) {
      const raw = m[3] ?? m[4] ?? '';
      // Only a navigation link earns the host exemption; `src` never does,
      // and neither does an `href` that is not on an anchor.
      const isNavigation = Boolean(m[1]) && m[2].toLowerCase() === 'href';
      let host = '';
      try {
        host = new URL(raw.startsWith('//') ? `https:${raw}` : raw).hostname.toLowerCase();
      } catch {
        host = '';
      }
      if (isNavigation && STATIC_LINK_HOSTS.includes(host)) continue;
      report(
        rel(f),
        isNavigation
          ? `remote link in markup — ${raw.slice(0, 70)}`
          : `remote resource in markup — ${raw.slice(0, 70)} (assets must be vendored)`,
      );
    }
  }
}

// --------------------------------------------- 4. bundled template structure

/** The i18n merge walker recurses without a depth guard, so a pathological
 *  tree overflows its stack. Deepest shipped template is 7. */
const MAX_TEMPLATE_DEPTH = 32;

// Iterative, and it stops as soon as the cap is exceeded. The recursive
// version died two ways of its own: `Math.max(0, ...arr.map(...))` spread
// every element as a call argument, so a FLAT 125k array (depth 1) threw
// RangeError, and the recursion itself threw past ~3000 levels — killing the
// gate mid-run, which left every later template unchecked behind a stack
// trace. A depth checker must not share the failure mode it exists to catch.
function exceedsDepth(value, limit) {
  const stack = [[value, 1]];
  let deepest = 0;
  while (stack.length > 0) {
    const [node, depth] = stack.pop();
    if (node === null || typeof node !== 'object') continue;
    if (depth > deepest) deepest = depth;
    if (depth > limit) return { exceeded: true, depth };
    for (const child of Array.isArray(node) ? node : Object.values(node)) {
      if (child !== null && typeof child === 'object') stack.push([child, depth + 1]);
    }
  }
  return { exceeded: false, depth: deepest };
}

function checkTemplates() {
  const files = walk(BUNDLED).filter((f) => extname(f) === '.json');
  for (const f of files) {
    const raw = readFileSync(f, 'utf8');


    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      report(rel(f), `invalid JSON — ${e.message}`);
      continue;
    }
    checkTemplateExternalRefs(f, parsed);

    // Duplicate keys survive only in the text: JSON.parse keeps the last
    // occurrence, so no schema can ever observe the loss.
    const dupes = new Set(duplicateKeys(raw));
    if (dupes.size > 0) {
      report(rel(f), `duplicate JSON key(s) ${[...dupes].map((k) => `"${k}"`).join(', ')} — JSON.parse silently keeps the last; no schema can catch this`);
    }

    const depth = exceedsDepth(parsed, MAX_TEMPLATE_DEPTH);
    if (depth.exceeded) {
      report(
        rel(f),
        `nesting depth exceeds ${MAX_TEMPLATE_DEPTH} — the i18n merge walker recurses per level`,
      );
    }

    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      if ('layer-header' in parsed && 'metrics' in parsed) {
        report(rel(f), 'both "layer-header" and the legacy "metrics" alias are present — which one applies is implicit');
      }
    }
  }
  return files.length;
}

/** Duplicate keys within the SAME object, found by tracking the object
 *  nesting the tokenizer is in. String and escape aware. */
function duplicateKeys(raw) {
  const dupes = [];
  const stack = [];
  let i = 0;
  while (i < raw.length) {
    const c = raw[i];
    if (c === '"') {
      let j = i + 1;
      let token = '';
      while (j < raw.length && raw[j] !== '"') {
        if (raw[j] === '\\') {
          token += raw[j] + raw[j + 1];
          j += 2;
          continue;
        }
        token += raw[j];
        j++;
      }
      // Compare DECODED names: `"a"` and `"a"` are one key to JSON.parse,
      // so comparing the raw source text would miss the duplicate entirely.
      let str;
      try {
        str = JSON.parse(`"${token}"`);
      } catch {
        str = token;
      }
      // A string is a KEY when the next non-space character is a colon.
      let k = j + 1;
      while (k < raw.length && /\s/.test(raw[k])) k++;
      if (raw[k] === ':' && stack.length > 0) {
        const top = stack[stack.length - 1];
        if (top) {
          if (top.has(str)) dupes.push(str);
          else top.add(str);
        }
      }
      i = j + 1;
      continue;
    }
    if (c === '{') stack.push(new Set());
    else if (c === '[') stack.push(null);
    else if (c === '}' || c === ']') stack.pop();
    i++;
  }
  return dupes;
}

// ---------------------------------------------------------------- run

// `public/` is served verbatim by @fastify/static and never passes through the
// bundler, so an asset dropped there reaches the browser without any of the
// build's checks — it belongs in the scan more than `src/` does, not less.
const uiFiles = [...walk(UI_SRC), ...walk(UI_PUBLIC), ...walk(DESIGN_TOKENS)];
const svg = checkSvgAssets(uiFiles);
const images = checkImages(uiFiles);
checkNoExternalRefs(uiFiles);
checkStaticRemoteRefs(uiFiles);
const bindings = checkUrlBindings(uiFiles);
const templates = checkTemplates();

if (findings.length > 0) {
  console.error(`✗ ${findings.length} security finding(s):`);
  for (const [where, message] of findings) console.error(`  ${where}: ${message}`);
  console.error(
    '\n  These gates encode decisions, not style. If one is genuinely wrong,\n' +
      '  change the rule deliberately — do not work around it.',
  );
  process.exit(1);
}

console.log(
  `✓ security OK: ${svg.scanned} SVG (${svg.strict} live-DOM), ${images} images, ` +
    `${bindings} URL bindings, ${templates} bundled templates`,
);
