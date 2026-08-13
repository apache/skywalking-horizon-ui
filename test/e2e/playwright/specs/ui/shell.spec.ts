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

// A blank page with a console error is the failure mode this file exists for:
// a TDZ ReferenceError in a view's setup aborts the mount silently, leaving a
// 200 response, valid JSON underneath, and nothing on screen.
test('the app shell mounts without a page error', async ({ page, pageErrors }) => {

  await page.goto('/');
  await expect(page.locator('#app')).toBeVisible();
  // Signed in: the login form must be gone, not merely navigated past.
  await expect(page.locator('input[name="password"]')).toHaveCount(0);

  expect(pageErrors, 'an uncaught error during mount blanks the page').toEqual([]);
});

test('an unauthenticated visitor is sent to the login form', async ({ browser }) => {
  // Explicitly session-less — the project default would carry one in.
  const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const page = await ctx.newPage();

  await page.goto('/');
  await expect(page).toHaveURL(/\/login\b/);
  await expect(page.locator('input[name="username"]')).toBeVisible();
  await expect(page.locator('input[name="password"]')).toBeVisible();

  await ctx.close();
});

test('wrong credentials keep the operator on the login form', async ({ browser }) => {
  const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const page = await ctx.newPage();

  await page.goto('/login');
  await page.fill('input[name="username"]', 'nobody');
  await page.fill('input[name="password"]', 'wrong');
  await page.click('button.sign-in');

  await expect(page.locator('.error')).toBeVisible();
  await expect(page).toHaveURL(/\/login\b/);

  await ctx.close();
});

test('a deep link resolves to a rendered route, not a 404', async ({ page }) => {
  // Only the router concern is asserted here. That the SPA fallback serves
  // index.html for an unknown path is an HTTP fact about the packaged server,
  // and the packaged-server smoke test in CI already asserts its status code
  // — checking it again from a browser spec proves nothing a rendered route
  // does not, and a UI spec that issues its own HTTP request is doing
  // something other than driving the UI.
  await page.goto('/layer/general/trace');
  await expect(page.locator('#app')).toBeVisible();
  await expect(page.locator('input[name="password"]')).toHaveCount(0);
});
