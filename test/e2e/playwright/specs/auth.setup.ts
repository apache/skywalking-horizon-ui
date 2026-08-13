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

import { test, expect } from '@playwright/test';
import { AUTH_STATE } from '../playwright.config.js';
import { E2E_USER, E2E_PASSWORD } from './fixture.js';

// Signs in once through the real login form and hands the session cookie to
// every other project. Driving the form rather than POSTing /api/auth/login
// means a broken login page fails here, loudly, instead of leaving every UI
// spec to fail on a redirect nobody expected.
test('sign in', async ({ page }) => {
  await page.goto('/');

  await page.fill('input[name="username"]', E2E_USER);
  await page.fill('input[name="password"]', E2E_PASSWORD);
  await page.click('button.sign-in');

  await expect(page).not.toHaveURL(/\/login\b/);
  await expect(page.locator('input[name="password"]')).toHaveCount(0);

  await page.context().storageState({ path: AUTH_STATE });
});
