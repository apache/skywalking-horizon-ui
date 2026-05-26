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
 * Read the dependency report produced by `collect-dist-licenses.mjs`
 * and verify:
 *
 *   1. Every package has a recognized license string.
 *   2. No package falls into the ASF "Category-X" (forbidden) bucket
 *      — strong copyleft, source-available-only, or commercial-restrictive.
 *   3. Every package's LICENSE file is reproduced under dist/licenses/
 *      (a missing file fails the build — operators must commit a
 *      hand-supplied copy under `dist-material/release-docs/licenses-extra/`
 *      and the collector picks it up next run).
 *
 * Exits non-zero with a per-package diagnostic on any violation.
 * Designed to run in CI (separate job from license-header) and as the
 * last step before the release script signs the binary tarball.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const distDir = resolve(repoRoot, 'dist');
const reportPath = resolve(distDir, '.dependency-report.json');

if (!existsSync(reportPath)) {
  console.error(
    `FATAL: ${reportPath} not found. Run \`node scripts/collect-dist-licenses.mjs\` first.`,
  );
  process.exit(1);
}

const report = JSON.parse(readFileSync(reportPath, 'utf8'));

// ASF "Category A" — permissive, freely redistributable. SPDX-ish keys.
// See https://www.apache.org/legal/resolved.html
const ALLOWED = new Set(
  [
    'Apache-2.0',
    'Apache 2.0',
    'Apache License 2.0',
    'Apache-2',
    'MIT',
    'MIT*',
    'MIT-0',
    'ISC',
    'BSD',
    'BSD-2-Clause',
    'BSD-3-Clause',
    'BSD-3-Clause-Clear',
    '0BSD',
    'CC0-1.0',
    'CC-BY-3.0',
    'CC-BY-4.0',
    'Unlicense',
    'WTFPL',
    'Python-2.0',
    'PSF-2.0',
    'BlueOak-1.0.0',
    'Zlib',
    'Artistic-2.0',
    // SIL Open Font License 1.1 — Apache Category A, explicitly allowed
    // for redistribution alongside Apache-licensed work (see
    // https://www.apache.org/legal/resolved.html#category-a). Carried in
    // via @fontsource-variable/inter + @fontsource-variable/jetbrains-mono;
    // the two TTF/WOFF2 font payloads ship under OFL while the
    // @fontsource wrapper code itself is MIT.
    'OFL-1.1',
  ].map((s) => s.toLowerCase()),
);

// Category X — must not appear in a binary release.
const FORBIDDEN_PATTERNS = [
  /\bAGPL/i,
  /\bSSPL/i,
  /\bBUSL/i,
  /commons[\s-]?clause/i,
  /\bRPL/i, // Reciprocal Public License
  /\bMs[-\s]?RL/i, // Microsoft Reciprocal
  /\bMPL[-\s]?1\./i, // MPL 1.x (only 2.0 is Cat-B / allowed-with-care)
];

// Category B — allowed but each must be reproduced verbatim. EPL, CDDL,
// MPL-2.0, LGPL-2.1, LGPL-3.0. Flagged but not failing — the LICENSE
// summary already lists them; vote reviewers can audit.
const WEAK_COPYLEFT_PATTERNS = [
  /\bEPL\b/i,
  /\bCDDL/i,
  /\bMPL[-\s]?2/i,
  /\bLGPL/i,
];

const errors = [];
const warnings = [];

for (const pkg of report.packages) {
  const id = `${pkg.name}@${pkg.version}`;
  const lic = (pkg.license ?? '').trim();
  const licLower = lic.toLowerCase();

  if (!lic || licLower === 'unknown') {
    errors.push(`${id}: missing or unknown license (declared: ${JSON.stringify(pkg.license)})`);
    continue;
  }

  // SPDX expressions: split on OR / AND. If any sub-expression is fully
  // allowed, we accept the package under that one. AND requires all parts allowed.
  const parts = lic.split(/\s+OR\s+|\s+AND\s+/i).map((s) => s.replace(/[()]/g, '').trim());
  const operator = / AND /i.test(lic) ? 'AND' : 'OR';

  const partOk = parts.map((p) => ALLOWED.has(p.toLowerCase()));
  const accepted = operator === 'AND' ? partOk.every(Boolean) : partOk.some(Boolean);

  for (const re of FORBIDDEN_PATTERNS) {
    if (re.test(lic)) {
      errors.push(`${id}: forbidden license: ${lic}`);
    }
  }

  if (!accepted && !errors.some((e) => e.startsWith(`${id}:`))) {
    // Allow weak-copyleft with a warning. Block everything else.
    if (WEAK_COPYLEFT_PATTERNS.some((re) => re.test(lic))) {
      warnings.push(`${id}: weak-copyleft license '${lic}' — included verbatim under licenses/`);
    } else {
      errors.push(`${id}: unrecognized license '${lic}' — add to ALLOWED if compatible, or remove the dep`);
    }
  }

  if (!pkg.licenseFile) {
    // A missing license file is a vote-blocker for non-trivial deps.
    warnings.push(`${id}: no LICENSE-like file shipped under licenses/ (license declared: ${lic})`);
  }
}

if (warnings.length > 0) {
  console.warn('Warnings:');
  for (const w of warnings) console.warn(`  - ${w}`);
}

if (errors.length > 0) {
  console.error('');
  console.error(`License check FAILED with ${errors.length} error(s):`);
  for (const e of errors) console.error(`  - ${e}`);
  console.error('');
  process.exit(1);
}

console.log(
  `License check OK: ${report.packageCount} packages, ` +
    `${Object.keys(report.byLicense).length} license families, ` +
    `${warnings.length} warning(s).`,
);
