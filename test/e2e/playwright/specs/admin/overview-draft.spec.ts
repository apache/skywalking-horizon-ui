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

// An unsaved widget must not follow the operator to another dashboard.
//
// The editor's seed watch fires for two different reasons — a background
// detail re-fetch, and the operator picking a different dashboard — and its
// dirty guard exists for the first: a refetch must not clobber edits in
// progress. Applied to the second it leaves the PREVIOUS dashboard's draft in
// the editor, where it reads as (and would be saved as) the newly selected
// one.
//
// This is the `admin` case rather than `core` because it edits, and it is a
// browser test rather than a wire one because the leak lives entirely in
// editor state — nothing reaches OAP until a push, so no request could show
// it.

test('an unsaved widget does not follow a dashboard switch', async ({ page, pageErrors }) => {
  await page.goto('/admin/overview-templates');
  await expect(page.locator('.ot')).toBeVisible({ timeout: 45_000 });

  const widgets = page.locator('.ot__pv-grid .ot__cw');
  const picker = page.locator('.tp button.tp-btn').first();

  async function pick(index: number): Promise<string> {
    await picker.click();
    const rows = page.locator('.tp-pop .tp-row');
    await expect(rows.first()).toBeVisible({ timeout: 45_000 });
    const row = rows.nth(index);
    await expect(row, 'this fixture needs two dashboards to switch between').toBeVisible();
    const label = (await row.locator('.tp-name').innerText()).trim();
    await row.click();
    await expect(picker).toContainText(label);
    return label;
  }

  // Record the TARGET's own shape first, so the assertion after the switch is
  // an equality against a known dashboard rather than "not the leaked
  // number" — a blank editor or the wrong dashboard would satisfy that.
  const target = await pick(1);
  await expect(widgets.first()).toBeVisible({ timeout: 45_000 });
  const targetCount = await widgets.count();

  const origin = await pick(0);
  await expect(widgets.first()).toBeVisible({ timeout: 45_000 });
  const originCount = await widgets.count();

  // Add a widget and leave it UNSAVED — no "Save to browser", no push.
  await page.locator('button.ot__add-trigger').click();
  await expect(page.locator('.ot__composer')).toBeVisible();
  await page.locator('.ot__composer button.ot__btn--primary').click();
  await expect.poll(async () => widgets.count(), { timeout: 45_000 }).toBe(originCount + 1);

  // Switch to the other dashboard. The editor must reseed from IT.
  await pick(1);

  await expect(picker, `the picker should now read ${target}, not ${origin}`).toContainText(target);
  await expect(widgets.first(), 'the editor went blank instead of reseeding').toBeVisible({
    timeout: 45_000,
  });
  await expect
    .poll(async () => widgets.count(), { timeout: 45_000 })
    .toBe(targetCount);

  expect(pageErrors, 'an uncaught error during mount blanks the page').toEqual([]);
});
