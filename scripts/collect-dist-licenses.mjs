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
 * Generate the BINARY distribution's LICENSE / NOTICE (+ per-dependency
 * license texts) by enumerating the full PRODUCTION dependency tree the
 * binary bundles:
 *
 *   - the BFF runtime deps (shipped verbatim as dist/node_modules), AND
 *   - the UI's production deps (compiled into dist/static by Vite).
 *
 * Both are redistributed in the binary tarball, so ASF distribution policy
 * requires every one of their licenses to be reproduced. We read the tree
 * via `pnpm list --prod` filtered to the bff + ui workspace packages — so
 * this runs after a plain `pnpm install`, with NO `pnpm package` step. That
 * lets CI regenerate and diff cheaply.
 *
 * Output is deterministic: the NOTICE copyright year is read from the
 * repo-root NOTICE (not the wall clock) and the dependency report carries no
 * timestamp, so the committed reference is byte-stable across runs/years.
 *
 * Modes:
 *   (default)            Write dist/LICENSE, dist/NOTICE, dist/licenses/<pkg>/,
 *                        and dist/.dependency-report.json (consumed by
 *                        check-dist-licenses.mjs and the release packager).
 *   --update-reference   Also copy the generated LICENSE + NOTICE into
 *                        dist-material/release-docs/ — the committed
 *                        reference. Run after any production-dependency
 *                        change, then commit the diff.
 *   --check              Compare the freshly generated LICENSE + NOTICE
 *                        against the committed reference and exit non-zero on
 *                        any drift (the CI guard).
 */

import { execSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const distDir = resolve(repoRoot, 'dist');
const licensesOutDir = resolve(distDir, 'licenses');
const templatesDir = resolve(repoRoot, 'dist-material/release-docs');
// The committed binary LICENSE / NOTICE live next to their .tpl sources.
const referenceDir = templatesDir;

const args = new Set(process.argv.slice(2));
const CHECK = args.has('--check');
const UPDATE_REFERENCE = args.has('--update-reference');

// Workspace packages whose PRODUCTION dependencies end up in the binary
// (bff → node_modules at runtime; ui → compiled into the static bundle).
const BUNDLED_WORKSPACE_PACKAGES = [
  '@skywalking-horizon-ui/bff',
  '@skywalking-horizon-ui/ui',
];

const LICENSE_FILE_PATTERNS = [
  /^LICENSE$/i,
  /^LICENCE$/i,
  /^LICENSE\.(md|txt|rst)$/i,
  /^LICENCE\.(md|txt|rst)$/i,
  /^COPYING$/i,
  /^COPYING\.(md|txt|rst)$/i,
  /^COPYRIGHT$/i,
  /^COPYRIGHT\.(md|txt|rst)$/i,
];
const NOTICE_FILE_PATTERNS = [/^NOTICE$/i, /^NOTICE\.(md|txt|rst)$/i];

function pickFile(dir, patterns) {
  if (!existsSync(dir)) return null;
  for (const entry of readdirSync(dir)) {
    if (patterns.some((p) => p.test(entry))) return join(dir, entry);
  }
  return null;
}

// Enumerate every third-party production package reachable from the bundled
// workspace packages. `pnpm list --prod --depth Infinity` resolves each
// entry to its real path in the pnpm store, so license files are readable
// straight from there — no dist/node_modules required.
function collectPackages() {
  const filters = BUNDLED_WORKSPACE_PACKAGES.flatMap((p) => ['--filter', p]);
  const raw = execSync(
    ['pnpm', 'list', '--prod', '--depth', 'Infinity', '--json', ...filters].join(' '),
    {
      cwd: repoRoot,
      maxBuffer: 128 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'inherit'],
    },
  ).toString();
  const json = JSON.parse(raw);
  const roots = Array.isArray(json) ? json : [json];

  const seen = new Map(); // key: name@version → { name, version, path }
  function walk(deps) {
    if (!deps) return;
    for (const [name, info] of Object.entries(deps)) {
      // First-party workspace packages are our own code — recurse past
      // them so their third-party deps are still captured.
      if (name.startsWith('@skywalking-horizon-ui/')) {
        walk(info.dependencies);
        continue;
      }
      const version = info.version;
      const key = `${name}@${version}`;
      if (!seen.has(key)) {
        const pkgPath = info.path;
        if (!pkgPath || !existsSync(pkgPath)) {
          console.warn(`WARN: package path missing for ${key}: ${pkgPath}`);
        } else {
          seen.set(key, { name, version, path: pkgPath });
        }
      }
      walk(info.dependencies);
    }
  }
  for (const root of roots) walk(root.dependencies);

  return Array.from(seen.values()).sort((a, b) =>
    a.name === b.name ? a.version.localeCompare(b.version) : a.name.localeCompare(b.name),
  );
}

// Human-asserted SPDX licenses for deps whose package.json omits or
// mis-declares `license`. Verified against each package's own LICENSE file.
const licenseOverrides = (() => {
  const p = join(templatesDir, 'license-overrides.json');
  if (!existsSync(p)) return {};
  try {
    const { _comment, ...rest } = JSON.parse(readFileSync(p, 'utf8'));
    void _comment;
    return rest;
  } catch (e) {
    console.warn(`WARN: cannot parse ${p}: ${e.message}`);
    return {};
  }
})();

function normalizeLicense(pkgJson) {
  const lic = pkgJson.license;
  if (typeof lic === 'string') return lic;
  if (lic && typeof lic === 'object' && typeof lic.type === 'string') {
    return lic.type;
  }
  if (Array.isArray(pkgJson.licenses)) {
    return pkgJson.licenses.map((l) => l.type || l).filter(Boolean).join(' OR ');
  }
  return 'UNKNOWN';
}

function readPkgJson(pkgPath) {
  const p = join(pkgPath, 'package.json');
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch (e) {
    console.warn(`WARN: cannot parse ${p}: ${e.message}`);
    return null;
  }
}

// Read the copyright year from the committed root NOTICE so the generated
// binary NOTICE is reproducible (a wall-clock year would drift every Jan 1
// and break the CI diff).
function noticeYear() {
  try {
    const txt = readFileSync(resolve(repoRoot, 'NOTICE'), 'utf8');
    const m = txt.match(/Copyright\s+(\d{4})/);
    if (m) return m[1];
  } catch {
    /* fall through */
  }
  return String(new Date().getUTCFullYear());
}

const packages = collectPackages();

mkdirSync(distDir, { recursive: true });
rmSync(licensesOutDir, { recursive: true, force: true });
mkdirSync(licensesOutDir, { recursive: true });

const report = [];
const byLicense = new Map();
const noticePieces = [];

for (const pkg of packages) {
  const pj = readPkgJson(pkg.path);
  if (!pj) continue;
  const license = licenseOverrides[`${pkg.name}@${pkg.version}`] ?? normalizeLicense(pj);
  const homepage = pj.homepage || pj.repository?.url || pj.repository || '';
  const entry = {
    name: pkg.name,
    version: pkg.version,
    license,
    homepage: typeof homepage === 'string' ? homepage : '',
    licenseFile: null,
    noticeFile: null,
  };

  const slug = `${pkg.name.replace(/\//g, '__')}-${pkg.version}`;
  const outDir = join(licensesOutDir, slug);

  const licFile = pickFile(pkg.path, LICENSE_FILE_PATTERNS);
  if (licFile) {
    if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
    const dest = join(outDir, relative(pkg.path, licFile));
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(licFile, dest);
    entry.licenseFile = relative(distDir, dest);
  }
  const noticeFile = pickFile(pkg.path, NOTICE_FILE_PATTERNS);
  if (noticeFile) {
    if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
    const dest = join(outDir, relative(pkg.path, noticeFile));
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(noticeFile, dest);
    entry.noticeFile = relative(distDir, dest);
    noticePieces.push(
      `------ ${pkg.name}@${pkg.version} ------\n${readFileSync(noticeFile, 'utf8').trim()}\n`,
    );
  }

  report.push(entry);
  const bucket = byLicense.get(license) ?? [];
  bucket.push(entry);
  byLicense.set(license, bucket);
}

// Render LICENSE.tpl → dist/LICENSE
const groupLines = [];
const sortedLicenses = Array.from(byLicense.keys()).sort();
for (const lic of sortedLicenses) {
  groupLines.push(`\n--- ${lic} ---\n`);
  for (const e of byLicense.get(lic)) {
    const ref = e.licenseFile ? ` (${e.licenseFile})` : '';
    groupLines.push(`  * ${e.name}@${e.version}${ref}`);
  }
}
const licenseTpl = readFileSync(join(templatesDir, 'LICENSE.tpl'), 'utf8');
const licenseOut = licenseTpl.replace('{{ .Groups }}', groupLines.join('\n'));
writeFileSync(join(distDir, 'LICENSE'), licenseOut);

// Render NOTICE.tpl → dist/NOTICE
const noticeTpl = readFileSync(join(templatesDir, 'NOTICE.tpl'), 'utf8');
const noticeOut = noticeTpl
  .replace('{{ .Year }}', noticeYear())
  .replace(
    '{{ .Notices }}',
    noticePieces.length > 0
      ? noticePieces.join('\n')
      : '(No third-party NOTICE files present in bundled dependencies.)\n',
  );
writeFileSync(join(distDir, 'NOTICE'), noticeOut);

// Machine-readable report for check-dist-licenses.mjs. No timestamp — the
// file is an input to a deterministic diff, not an audit log.
writeFileSync(
  join(distDir, '.dependency-report.json'),
  JSON.stringify(
    {
      packageCount: report.length,
      packages: report,
      byLicense: Object.fromEntries(
        sortedLicenses.map((l) => [l, byLicense.get(l).length]),
      ),
    },
    null,
    2,
  ) + '\n',
);

console.log(
  `Wrote dist/LICENSE, dist/NOTICE, dist/licenses/ (${report.length} packages, ` +
    `${sortedLicenses.length} license families).`,
);

// ── Reference sync / drift check ────────────────────────────────────────
const refLicense = join(referenceDir, 'LICENSE');
const refNotice = join(referenceDir, 'NOTICE');

if (UPDATE_REFERENCE) {
  cpSync(join(distDir, 'LICENSE'), refLicense);
  cpSync(join(distDir, 'NOTICE'), refNotice);
  console.log(
    `Updated committed reference: ${relative(repoRoot, refLicense)}, ${relative(repoRoot, refNotice)}.`,
  );
}

if (CHECK) {
  const drift = [];
  for (const [label, generated, reference] of [
    ['LICENSE', join(distDir, 'LICENSE'), refLicense],
    ['NOTICE', join(distDir, 'NOTICE'), refNotice],
  ]) {
    if (!existsSync(reference)) {
      drift.push(`${label}: committed reference ${relative(repoRoot, reference)} is missing.`);
      continue;
    }
    if (readFileSync(generated, 'utf8') !== readFileSync(reference, 'utf8')) {
      drift.push(`${label}: differs from ${relative(repoRoot, reference)}.`);
    }
  }
  if (drift.length > 0) {
    console.error('');
    console.error('Binary LICENSE / NOTICE drift detected:');
    for (const d of drift) console.error(`  - ${d}`);
    console.error('');
    console.error(
      'Production dependencies changed without regenerating the committed reference.',
    );
    console.error('Run:  pnpm licenses:bin:update   then commit dist-material/release-docs/.');
    process.exit(1);
  }
  console.log('Binary LICENSE / NOTICE match the committed reference.');
}
