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

// Browser telemetry. Records arrive on OAP's browser receiver rather than
// from a SkyWalking agent, and land in the BROWSER layer — which no other
// case populates.
//
// Asserted entirely on screen. The fields an operator needs — category, page
// path, error URL, stack — are all rendered, so checking them on the wire as
// well would cost runtime and tell us nothing the rendered row does not
// (CLAUDE.md §3.2).

test('the Browser Errors tab renders the seeded errors', async ({ page, pageErrors }) => {
  await page.goto('/layer/browser/browser-errors');

  // Same trailing-control contract as traces and logs: the query waits for an
  // explicit Run query rather than firing on navigation.
  const run = page.getByRole('button', { name: /run query/i });
  await expect(run).toBeEnabled({ timeout: 45_000 });
  await run.click();

  const rows = page.locator('.lg-stream .lg-row');
  await expect(rows.first()).toBeVisible({ timeout: 45_000 });

  // The seeded message, straight off the wire onto the page — proves these
  // are the fixture's records rather than an empty shell that happened to
  // render.
  await expect(page.getByText('e2e synthetic failure').first()).toBeVisible();

  const first = rows.first();
  // Page path and category are what make a row actionable: WHERE it broke and
  // WHAT kind of failure it was. A record that renders without them is noise.
  await expect(first.locator('.lg-svc')).toContainText('/e2e/checkout');
  await expect(first.locator('.lg-lvl')).not.toBeEmpty();

  // The stack lives behind the row expander, which is where an operator
  // actually reads it.
  await first.click();
  await expect(page.locator('.be-pre').first()).toContainText('TypeError');

  expect(pageErrors, 'an uncaught error during mount blanks the page').toEqual([]);
});
