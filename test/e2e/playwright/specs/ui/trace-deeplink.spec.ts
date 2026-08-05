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

import { test, expect } from '../support/diagnostics.js';
import { LAYER } from '../fixture.js';

// The shareable trace link, opened COLD in a fresh page.
//
// This is a different code path from clicking a row, and the difference is
// the point: clicking has the trace already in memory from the list, while a
// pasted link has nothing but an id in the URL and must fetch the trace on
// mount. A build where the popout only ever renders from list state passes
// every click-driven assertion and dead-ends on every shared link.
//
// `?traceId=` is consumed during setup by a watch with `{ immediate: true }`,
// which is the shape that produces a silent TDZ ReferenceError and a blank
// page when a ref is declared below its consumer — so this also guards the
// parameter-on-mount flow the project's failure-modes list calls out.

test('a shared native trace link opens the trace in a new page', async ({
  page,
  context,
  pageErrors,
}) => {
  await page.goto(`/layer/${LAYER}/trace`);
  await page.locator('button.tr-run-btn').click();
  const rows = page.locator('.tr-rowlist .tr-row-card');
  await expect(rows.first()).toBeVisible({ timeout: 45_000 });

  // Read the id off the DETAIL, not the URL. A row click on this tab commits
  // to local state and shows the inline split — it deliberately does not
  // navigate, so there is no query string to copy. The header's "⧉ url"
  // button is what builds the shareable link, and `?traceId=` is that link's
  // shape.
  await rows.first().click();
  const detail = page.locator('.tr-detail');
  await expect(detail).toBeVisible({ timeout: 45_000 });
  const traceId = (
    await detail.locator('.trace-id-text, .trace-id-select').first().innerText()
  ).trim();
  expect(traceId, 'the detail header should name the trace it opened').toBeTruthy();

  // A genuinely fresh page — same session, no list, no prior state.
  const shared = await context.newPage();
  try {
    await shared.goto(`/layer/${LAYER}/trace?traceId=${traceId}`);

    // The global popout, mounted in AppShell and opened purely by the URL.
    await expect(shared.locator('.tp-backdrop')).toBeVisible({ timeout: 45_000 });

    // SPAN ROWS are the assertion. The card carries the trace id and its
    // static labels whether or not the detail request returned anything, so
    // asserting text on the card passes against an empty fetch — which is
    // exactly the failure a cold deep link is here to catch.
    await expect(shared.locator('.tp-waterfall .tp-row').first()).toBeVisible({
      timeout: 45_000,
    });
  } finally {
    await shared.close();
  }

  expect(pageErrors, 'an uncaught error during mount blanks the page').toEqual([]);
});
