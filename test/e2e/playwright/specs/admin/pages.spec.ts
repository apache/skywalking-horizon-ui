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
  // The catalog chips BY NAME, in order. `.dh button` counted the four chips
  // plus the conditional "clear all", so the number it produced could not say
  // WHICH buttons had rendered — naming them can.
  await expect(page.locator('.dh__filterchip')).toHaveText([
    /^all\b/,
    /^mal\b/,
    /^lal\b/,
    /^oal\b/,
  ]);

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

  // This editor's roster is the BUNDLED list, by design: the disk bundle
  // reaches the runtime through initialization and read-only mode, plus this
  // page's bundled-preview source, which is what the editor diffs against.
  // So the rows prove the page mounted and the bundle loaded — they say
  // nothing about OAP, and cannot: they render identically with the template
  // store unreachable. The OAP half is asserted from the sync badge below.
  //
  // The roster is behind a click. The page mounts with its layer list
  // COLLAPSED and opens on whichever template sorts first, so on load the only
  // layer key in the DOM is that one — a locator over the page at large finds
  // one row and says nothing about the roster. Opening the switcher is the
  // operator's own path to it.
  const switcher = page.locator('.layer-dd-btn');
  await expect(switcher).toBeVisible({ timeout: 45_000 });
  await switcher.click();

  const rows = page.locator('.layer-dd-list .layer-row');
  await expect(rows.first()).toBeVisible({ timeout: 45_000 });
  // Several, not an exact count: pinning the number would make an unrelated
  // layer being added or removed fail this test. The fixture's OWN layer is
  // named, though — that is the row whose absence means the round trip broke.
  // Layer keys are enum values rendered verbatim in every locale, which is
  // what makes them safe to match on.
  expect(await rows.count()).toBeGreaterThan(2);
  const layerRow = rows.filter({
    has: page.locator('.key-tag', { hasText: new RegExp(`^${LAYER}$`, 'i') }),
  });
  await expect(layerRow, `the ${LAYER} template is missing from the bundled roster`).toHaveCount(1);

  // THIS is the seed-and-read round trip. The badge compares the bundled copy
  // against the OAP-stored one, so `synced` (byte-identical) and `diverged`
  // (OAP holds a different copy, and OAP wins at render) both prove OAP
  // answered. `bundled-fallback` — or no badge at all — is the break: it means
  // the template store had nothing for this layer.
  await expect(
    layerRow.locator('.tsb--synced, .tsb--diverged'),
    `${LAYER} has no OAP-stored copy — boot seeding into the template store did not land`,
  ).toHaveCount(1);

  expect(pageErrors).toEqual([]);
});
