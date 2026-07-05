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
 * Produce a self-contained, network-free `./dist/` artifact at the repo
 * root. After this script finishes, the operator can:
 *
 *     HORIZON_CONFIG=./horizon.yaml node dist/server.js
 *
 * — without `pnpm install`, without network access, without any other
 * checkout state. The folder contains everything the BFF needs:
 *
 *     dist/
 *       server.js              — esbuild-bundled BFF (single ESM file)
 *       package.json           — Node ESM marker + module type
 *       node_modules/          — production deps (npm + workspace dists)
 *       bundled_templates/     — layer + overview JSON templates
 *       static/                — built UI (Vite dist)
 *       horizon.yaml           — env-driven config (override fields via HORIZON_… env vars)
 *
 * The build:
 *   1. Builds each workspace package under `packages/*` (tsc → dist/).
 *   2. Builds the BFF (esbuild → apps/bff/dist/server.js).
 *   3. Builds the UI (vite → apps/ui/dist/).
 *   4. Runs `pnpm deploy --legacy --prod` to materialize a production
 *      install tree under `./_deploy_tmp/` (with workspace deps already
 *      resolved as the `dist/` we built in step 1).
 *   5. Re-layouts the deploy output into the flat `./dist/` shape above
 *      and cleans up `_deploy_tmp`.
 *
 * The BFF's `locateConfigDir()` probes (in the layers + overview
 * loaders) include `__dirname/bundled_templates`, so the flat sibling
 * layout resolves without any env-var override.
 */

import { execSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const dist = resolve(root, 'dist');
const tmp = resolve(root, '_deploy_tmp');

function step(name) {
  process.stdout.write(`\n[1m▸ ${name}[0m\n`);
}
function run(cmd) {
  execSync(cmd, { cwd: root, stdio: 'inherit' });
}

step('Cleaning ./dist and ./_deploy_tmp');
rmSync(dist, { recursive: true, force: true });
rmSync(tmp, { recursive: true, force: true });

step('Building workspace packages (api-client / design-tokens / templates)');
run("pnpm -r --filter './packages/*' run build");

step('Building BFF (esbuild bundle)');
run('pnpm --filter @skywalking-horizon-ui/bff build');

step('Building UI (vite production build)');
run('pnpm --filter @skywalking-horizon-ui/ui build');

step('Materializing production install tree (pnpm deploy)');
// `--legacy` is required under pnpm 10+ for non-injected workspaces.
// We deploy directly into ./dist
// (renaming through an intermediate) rather than copying out, because
// the produced node_modules contains pnpm-style symlinks into an
// in-tree `.pnpm/` store — copying would either preserve broken
// symlinks (cpSync default) or explode the size 5-10x (dereference).
run(`pnpm deploy --legacy --filter @skywalking-horizon-ui/bff --prod ${tmp}`);

step('Re-layouting into flat ./dist/');
// Move the deploy output wholesale to ./dist. Internal `.pnpm/`
// symlinks stay valid because they're all relative within the tree.
renameSync(tmp, dist);
// pnpm deploy preserved the BFF's original layout, so server.js is at
// dist/dist/server.js. Lift it up one level and drop the empty wrapper.
renameSync(resolve(dist, 'dist', 'server.js'), resolve(dist, 'server.js'));
rmSync(resolve(dist, 'dist'), { recursive: true, force: true });
// Copy the operator-facing assets in: writable bundled_templates (per-
// key admin saves write here), built UI, copy-and-edit yaml.
cpSync(
  resolve(root, 'apps/bff/src/bundled_templates'),
  resolve(dist, 'bundled_templates'),
  { recursive: true },
);
// AI prose resources (system prompt, RCA playbooks) — the bundled server reads
// them from <dist>/resources at runtime (see ai/resources/loader.ts).
cpSync(
  resolve(root, 'apps/bff/src/ai/resources'),
  resolve(dist, 'resources'),
  { recursive: true },
);
cpSync(resolve(root, 'apps/ui/dist'), resolve(dist, 'static'), { recursive: true });
cpSync(resolve(root, 'horizon.yaml'), resolve(dist, 'horizon.yaml'));

step('Done');
console.log(`
Target binary: ${resolve(dist, 'server.js')}

Boot it:

    HORIZON_CONFIG=./horizon.yaml \\             # every field is a \${HORIZON_…} env var
      HORIZON_OAP_QUERY_URL=http://oap:12800 \\  # override only what you need
      HORIZON_STATIC_DIR=./dist/static \\
      node dist/server.js

Or from inside dist/ (cwd-relative fallback resolves bundled_templates):

    cd dist
    HORIZON_CONFIG=../horizon.yaml HORIZON_STATIC_DIR=./static node server.js

The folder is fully self-contained — copy it anywhere, no \`pnpm install\`
required, no network access at boot.
`);

if (!existsSync(resolve(dist, 'server.js'))) {
  console.error('FATAL: dist/server.js missing after package');
  process.exit(1);
}
