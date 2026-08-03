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
  // Output goes to stderr (see script/prepare/playwright.sh) — stdout is the
  // infra-e2e contract. The HTML report is for the CI failure artifact.
  reporter: [
    ['line'],
    ['html', { open: 'never', outputFolder: resolve(here, 'playwright-report') }],
  ],
  // Same anchoring as AUTH_STATE — the CI failure artifact collects these two
  // paths by name, so they must not follow the caller's cwd.
  outputDir: resolve(here, 'test-results'),
  timeout: 60_000,
  expect: { timeout: 20_000 },
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'auth', testMatch: /auth\.setup\.ts/ },
    {
      name: 'bff',
      testMatch: /bff\/.*\.spec\.ts/,
      dependencies: ['auth'],
      use: { storageState: AUTH_STATE },
    },
    {
      name: 'ui',
      testMatch: /ui\/.*\.spec\.ts/,
      dependencies: ['auth'],
      use: { ...devices['Desktop Chrome'], storageState: AUTH_STATE },
    },
  ],
});
