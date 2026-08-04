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

// The admin screens, in a real browser. Everything the `admin` case asserts
// over the wire says nothing about whether an operator can see it: these are
// among the heaviest pages in the app — Monaco editors, diff views, async
// phase polling — and a view that throws on mount answers 200 with perfect
// JSON underneath and shows a blank page.
//
// Runs in the `admin` case ONLY, and only against state that case has already
// established. Deliberately read-only: the wire cases own the mutations, and
// a browser clicking through the same transitions would race them.

test('the DSL catalog page lists rules for a catalog', async ({ page, pageErrors }) => {

  await page.goto('/operate/dsl/lal');
  await expect(page.locator('.catalog')).toBeVisible({ timeout: 45_000 });
  // The LAL rule base-compose mounts. Its presence proves the page is reading
  // the live catalog rather than rendering an empty shell.
  await expect(page.getByText('horizon-e2e').first()).toBeVisible({ timeout: 45_000 });

  expect(pageErrors, 'an uncaught error during mount blanks the page').toEqual([]);
});

test('the capture history page mounts with its per-catalog filters', async ({ page, pageErrors }) => {

  await page.goto('/operate/live-debug/history');
  await expect(page.locator('.dh')).toBeVisible({ timeout: 45_000 });

  // Capture history is stored in THIS BROWSER, not on the server — the page
  // says so itself. A session started over the API therefore never appears
  // here, so this asserts the page's own furniture (the mal/lal/oal filters)
  // rather than content the wire cases created. Populating it would mean
  // driving a capture through the debugger UI, which would race the wire
  // cases' mutations.
  const filters = page.locator('.dh button');
  expect(await filters.count()).toBeGreaterThan(2);

  expect(pageErrors).toEqual([]);
});

test('the live debugger offers the live rule catalog', async ({ page, pageErrors }) => {

  await page.goto('/operate/live-debug/lal');
  await expect(page.locator('#app')).toBeVisible();

  // The page opens as a configuration form, not an editor — Monaco appears
  // only once a capture has data. What matters at this stage is that the rule
  // list came from OAP: horizon-e2e is the LAL rule base-compose mounts, so
  // seeing it selectable proves the catalog reached the UI.
  const ruleFile = page.locator('select').first();
  await expect(ruleFile).toBeVisible({ timeout: 45_000 });
  await expect(ruleFile.locator('option', { hasText: 'horizon-e2e' })).toHaveCount(1);

  expect(pageErrors).toEqual([]);
});

test('the overview template admin mounts', async ({ page, pageErrors }) => {

  await page.goto('/admin/overview-templates');
  await expect(page.locator('.ot')).toBeVisible({ timeout: 45_000 });

  expect(pageErrors).toEqual([]);
});

test('the layer dashboard admin mounts', async ({ page, pageErrors }) => {

  await page.goto('/admin/layer-dashboards');
  await expect(page.locator('#app')).toBeVisible();

  // templates.mode is live, so this page renders what OAP holds. Layer keys
  // are enum values rendered verbatim in every locale, which makes them safe
  // to match; an empty rail would mean the seed-and-read round trip failed,
  // the same break the wire assertions catch from the other side.
  // Several, not an exact count: the rail is paged, so pinning the number
  // would make an unrelated layer being added or removed fail this test.
  const layerKeys = page.locator('code');
  await expect(layerKeys.first()).toBeVisible({ timeout: 45_000 });
  expect(await layerKeys.count()).toBeGreaterThan(2);

  expect(pageErrors).toEqual([]);
});
