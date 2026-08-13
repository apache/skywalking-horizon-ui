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

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

// infra-e2e maps container ports to ephemeral host ports and exports them to
// the verify case, which passes the resolved URL in. There is no default:
// guessing one would let the suite run green against a stale stack from a
// previous case, which is worse than failing to start.
const baseURL = process.env.HORIZON_BASE_URL;
if (!baseURL) {
  throw new Error(
    'HORIZON_BASE_URL is not set. Run through an infra-e2e case ' +
      '(`e2e run -c test/e2e/cases/core/e2e.yaml`), or export it by hand when ' +
      'iterating against a stack you started yourself.',
  );
}

// Anchored to this file, not to the cwd: the verify case invokes Playwright
// through `pnpm --dir`, which resolves the package but leaves the process cwd
// wherever infra-e2e started it, so a relative path lands outside the package.
const here = dirname(fileURLToPath(import.meta.url));

export const AUTH_STATE = resolve(here, '.auth/state.json');

// Report and results are written per PROJECT, not per run.
//
// A case runs more than one project in sequence (core: bff then ui; istio:
// istio then istio-profiling), and infra-e2e keeps going after a verify case
// fails — so a later project sharing these directories would overwrite the
// report of the failure that actually mattered. `playwright.sh` exports the
// project it is running; the fallback keeps a bare `npx playwright test`
// working while iterating.
const project = process.env.HORIZON_E2E_PROJECT ?? 'all';

export default defineConfig({
  testDir: './specs',
  // The fixture is a shared, stateful stack — parallel workers would race on
  // the same OAP and on template writes. Serial also makes a failure
  // reproducible from the log order.
  workers: 1,
  fullyParallel: false,
  // A retry masks exactly the flake class this suite exists to catch, so the
  // answer to an intermittent failure is a better wait, not a rerun.
  retries: 0,
  // Playwright's default is false and is NOT implied by CI, so a committed
  // `test.only` would run one test, report the project green, and hand
  // infra-e2e `passed: true` — a whole case silently reduced to nothing.
  forbidOnly: true,
  // Output goes to stderr (see script/prepare/playwright.sh) — stdout is the
  // infra-e2e contract. The HTML report is for the CI failure artifact.
  reporter: [
    ['line'],
    ['html', { open: 'never', outputFolder: resolve(here, `playwright-report/${project}`) }],
  ],
  // Same anchoring as AUTH_STATE — the CI failure artifact collects these two
  // paths by name, so they must not follow the caller's cwd.
  outputDir: resolve(here, `test-results/${project}`),
  timeout: 60_000,
  expect: { timeout: 20_000 },
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    // Globs anchored at `specs/`, never bare regexes: testMatch runs against
    // the ABSOLUTE path, and a pattern like /ui\/.*\.spec\.ts/ also matches a
    // checkout living under .../skywalking-horizon-ui/... — which silently
    // collects every spec in the repo into one project.
    { name: 'auth', testMatch: '**/specs/auth.setup.ts' },
    {
      name: 'bff',
      testMatch: '**/specs/bff/*.spec.ts',
      dependencies: ['auth'],
      use: { storageState: AUTH_STATE },
    },
    {
      // Admin screens, run only by the `admin` case — they assert against
      // rules and templates that case establishes, so they mean nothing
      // against a stack that has not been through it.
      name: 'admin',
      testMatch: '**/specs/admin/*.spec.ts',
      dependencies: ['auth'],
      use: { ...devices['Desktop Chrome'], storageState: AUTH_STATE },
    },
    {
      // Browser telemetry — its own project because the BROWSER layer only
      // exists in the case that seeds OAP's browser receiver.
      name: 'browser',
      testMatch: '**/specs/browser/*.spec.ts',
      dependencies: ['auth'],
      use: { ...devices['Desktop Chrome'], storageState: AUTH_STATE },
    },
    {
      // ElasticSearch's browser half — one spec, the pre-v2 trace path, which
      // is the only thing that deployment proves.
      name: 'es',
      testMatch: '**/specs/es/*.spec.ts',
      dependencies: ['auth'],
      use: { ...devices['Desktop Chrome'], storageState: AUTH_STATE },
    },
    {
      // The mesh half of the istio case. Its own project because MESH
      // entities come from Envoy access logs, which only a real mesh
      // deployment produces.
      name: 'istio',
      testMatch: '**/specs/istio/*.spec.ts',
      dependencies: ['auth'],
      use: { ...devices['Desktop Chrome'], storageState: AUTH_STATE },
    },
    {
      // Profiling, split out so the without-profiling variant of the istio
      // case can omit it by not running the project. A skip inside the mesh
      // project would report passes for pages that were never opened.
      name: 'istio-profiling',
      testMatch: '**/specs/istio-profiling/*.spec.ts',
      dependencies: ['auth'],
      use: { ...devices['Desktop Chrome'], storageState: AUTH_STATE },
    },
    {
      // BanyanDB's own deployment — its own project because the BANYANDB
      // layer only exists where a FODC-reporting cluster is running.
      name: 'deployment',
      testMatch: '**/specs/deployment/*.spec.ts',
      dependencies: ['auth'],
      use: { ...devices['Desktop Chrome'], storageState: AUTH_STATE },
    },
    {
      name: 'ui',
      testMatch: '**/specs/ui/*.spec.ts',
      dependencies: ['auth'],
      use: { ...devices['Desktop Chrome'], storageState: AUTH_STATE },
    },
  ],
});
