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
 * Re-materialize the vendored `.proto` tree from its pinned upstream commits.
 *
 *     pnpm proto:sync     rewrite the tree
 *     pnpm proto:check    rewrite it, then `git diff --exit-code` (CI)
 *
 * Fetching is by FULL commit SHA, never a branch or tag: a git object id is
 * itself a content hash, so the pin is tamper-evident without a side-channel
 * digest. It is also why this does not pull `codeload/<sha>.tar.gz` — GitHub's
 * generated archives are not byte-reproducible, and pinning their checksums
 * has broken across GitHub-side changes before.
 *
 * Because the gate diffs against a PINNED commit rather than a branch, an
 * upstream release cannot turn an unrelated PR red. What it does catch is the
 * one failure mode vendoring has that a submodule does not: someone hand-
 * editing a vendored .proto to make something compile.
 */

import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cfgPath = resolve(root, 'apps/bff/src/client/banyandb/proto-sources.json');
const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
const dest = resolve(root, cfg.dest);

const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });

// Rebuilt from scratch every run, so an upstream DELETION propagates. Patching
// in place would leave a stale file behind and the gate would still pass.
rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });

for (const src of cfg.sources) {
  if (!/^[0-9a-f]{40}$/.test(src.commit)) {
    throw new Error(`${src.name}: commit must be a full 40-character SHA (an abbreviated one cannot be fetched)`);
  }
  const tmp = mkdtempSync(join(tmpdir(), 'horizon-proto-'));
  try {
    git(tmp, 'init', '-q', '.');
    git(tmp, 'remote', 'add', 'origin', src.repo);
    git(tmp, 'fetch', '--depth', '1', 'origin', src.commit);
    git(tmp, 'checkout', '-q', 'FETCH_HEAD');

    for (const rule of src.copy) {
      const from = resolve(tmp, rule.from);
      const to = resolve(dest, rule.to);
      mkdirSync(to, { recursive: true });
      const re = new RegExp(rule.match);
      const picked = readdirSync(from).filter((f) => re.test(f));
      if (picked.length === 0) throw new Error(`${src.name}: ${rule.from} matched no files`);
      for (const f of picked) cpSync(join(from, f), join(to, f));
      console.log(`  ${src.name} @ ${src.commit.slice(0, 12)} → ${rule.to}/ (${picked.length} file(s))`);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

console.log(`Vendored proto tree written to ${cfg.dest}`);
