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

import { test as base, expect } from '@playwright/test';

/**
 * The suite's `test`, with browser-side diagnostics attached automatically.
 *
 * Verification here is a browser assertion, so a failure says "the page did
 * not show it" without saying which link broke. The diagnosis has to come from
 * evidence collected at the moment of failure (CLAUDE.md §4), and that
 * evidence has to be worth reading.
 *
 * Every page gets two recorders:
 *
 *   - **uncaught page errors** — a TDZ ReferenceError in a view's setup aborts
 *     the mount with a 200 response and valid JSON underneath, leaving a blank
 *     page and no clue anywhere else.
 *   - **console errors and warnings** — a failed fetch, a Vue warning, a
 *     rejected promise the app swallowed. None of these fail a test on their
 *     own (third-party noise would make that unusable), but they are usually
 *     the first honest sentence in a diagnosis.
 *
 * Both are attached to the report ONLY on failure, so a green run stays quiet
 * and the artifact never becomes something people learn to skip.
 *
 * `pageErrors` is exposed because a blank page IS a defect: specs assert it is
 * empty after a mount.
 *
 * It collects from TWO sources, and the second is not optional. Vue's
 * production build hands a component error to its own handler, which
 * `console.error`s it — it does NOT rethrow, so `pageerror` never fires. The
 * e2e image serves a production build, so listening to `pageerror` alone made
 * this fixture inert against the exact failure it was written for: a
 * ReferenceError in a view's `setup` blanks the page, and every
 * `expect(pageErrors).toEqual([])` in the suite still passed. Verified in
 * Chromium against Vue 3.5.40's production runtime — blank page, zero
 * `pageerror` events, one `console.error`.
 *
 * Only Vue's own component-error line is promoted to a failure. General
 * console noise (a failed third-party fetch, a deprecation warning) stays in
 * the attached log, because a fixture that fails on any console error is one
 * people learn to disable.
 */

/** Vue's production error handler prefixes component errors with this. */
const VUE_COMPONENT_ERROR = /^\[Vue warn\]|Unhandled error during execution|^ReferenceError|^TypeError/;

export const test = base.extend<{ pageErrors: string[] }>({
  pageErrors: async ({ page }, use, testInfo) => {
    const pageErrors: string[] = [];
    const consoleLines: string[] = [];

    page.on('pageerror', (e) => pageErrors.push(`${e.name}: ${e.message}`));
    page.on('console', (msg) => {
      const type = msg.type();
      if (type === 'error' || type === 'warning') {
        consoleLines.push(`[${type}] ${msg.text()}`);
      }
      // A component that threw during setup/render reaches here, not
      // `pageerror`, in a production build.
      if (type === 'error' && VUE_COMPONENT_ERROR.test(msg.text().trim())) {
        pageErrors.push(`console: ${msg.text().split('\n')[0]}`);
      }
    });

    await use(pageErrors);

    if (testInfo.status !== testInfo.expectedStatus) {
      if (pageErrors.length > 0) {
        await testInfo.attach('page-errors.txt', {
          body: pageErrors.join('\n'),
          contentType: 'text/plain',
        });
      }
      if (consoleLines.length > 0) {
        await testInfo.attach('browser-console.txt', {
          body: consoleLines.join('\n'),
          contentType: 'text/plain',
        });
      }
    }
  },
});

export { expect };
