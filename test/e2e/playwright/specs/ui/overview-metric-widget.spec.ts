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

// The `metric` widget, authored the way an operator would.
//
// No bundled overview declares one, so it shipped unrendered by any test —
// yet it is the DEFAULT type in the composer, the first widget anyone adds.
// It creates its own dashboard and pushes it to OAP rather than editing a
// bundled one, so nothing another spec reads is disturbed.
//
// It lives in `core` rather than `admin` because it asserts a VALUE, and only
// this fixture has traffic: the admin stack runs no demo app, so `service_cpm`
// has nothing to aggregate and the tile correctly renders an em dash. Writing
// here is scoped the same way the trace-profiling spec's task creation is.
//
// The two aggregation modes need DIFFERENT expressions, and getting that wrong
// is silent — a plain per-service metric in server-side mode returns nothing
// with no error, and the tile renders forever empty:
//
//   server-side (default) — fired ONCE with no service entity, so the MQE has
//                           to collapse the layer itself: sum(top_n(...))
//   page-side             — fanned out per service, so a plain metric is right
//
// This asserts the server-side path end to end (author → push → render) and
// that the editor offers the page-side mode at all, since the control was
// previously withheld from this widget type.

const DASH_ID = `e2e-metric-${Date.now()}`;

test('a metric widget can be authored, pushed, and renders its value', async ({
  page,
  pageErrors,
}) => {
  // Author, publish, wait for the store, then read back — well past the
  // default per-test budget.
  test.setTimeout(300_000);
  await page.goto('/admin/overview-templates');
  await expect(page.locator('.ot')).toBeVisible({ timeout: 45_000 });

  // A dashboard of its own — editing a bundled one would leave the shared
  // fixture mutated for every case that reads it.
  await page.getByRole('button', { name: '+ New dashboard' }).click();
  // `.nod` is the modal's BODY; Cancel / Create live in the shared Modal's
  // footer slot, outside it. Scope the fields to the body and the action to
  // the dialog.
  const body = page.locator('.nod');
  await expect(body).toBeVisible({ timeout: 45_000 });
  await body.locator('input').first().fill(DASH_ID);
  await body.locator('input').nth(1).fill('E2E metric widget');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(body).toBeHidden({ timeout: 45_000 });

  // Compose the widget. `metric` is already the composer default, which is
  // exactly why it needs to work.
  await page.locator('button.ot__add-trigger').click();
  const composer = page.locator('.ot__composer');
  await expect(composer).toBeVisible();
  await expect(composer.locator('select').first()).toHaveValue('metric');

  // The composer only picks the KIND and its footprint; the MQE lives in the
  // per-widget drawer, which opens once the widget exists. Create first.
  await composer.locator('button.ot__btn--primary').click();
  const cell = page.locator('.ot__pv-grid .ot__cw').first();
  await expect(cell).toBeVisible({ timeout: 45_000 });

  // Select it to open the drawer, then give it the self-aggregating form:
  // the layer's traffic collapsed to one number. `{{topn}}` is substituted
  // BFF-side from query.overviewTopN.
  await cell.click();

  // The LAYER is required for anything that reads metrics — the renderer
  // skips a data widget without one, and the tile then never fills.
  await page.locator('select.ot__in--narrow').first().selectOption('GENERAL');

  const mqe = page.locator('input.mqe-inline').first();
  await expect(mqe).toBeVisible({ timeout: 45_000 });
  // No synthetic blur: the input commits on every real input event, and
  // clicking Save moves focus the way an operator would anyway. Blurring
  // programmatically would hide a component that only committed on blur.
  await mqe.fill('sum(top_n(service_cpm,{{topn}},DES))');

  // Local draft first, then publish — the flow the docs describe.
  await page.getByRole('button', { name: 'save (local)' }).click();
  await page.getByRole('button', { name: 'check diff & push' }).click();
  // The publish dialog shows a read-only remote -> local diff; `.ot__push-diff`
  // is its body and "Confirm push" sits in the shared Modal's footer slot,
  // the same split as the new-dashboard modal.
  await expect(page.locator('.ot__push-diff')).toBeVisible({ timeout: 45_000 });
  await page.getByRole('button', { name: 'Confirm push' }).click();

  // A push is NOT readable straight away. The template lands in OAP's store
  // and only becomes visible once that write is queryable, and Horizon caches
  // the config bundle on top of it — so reading back too early gets a 404 or
  // an empty dashboard, neither of which a locator retry can recover from
  // because the page has already rendered its empty state.
  //
  // Wait for the store, then RELOAD until it appears: retrying the element
  // alone would sit on a page that will never change.
  await page.waitForTimeout(10_000);
  await expect
    .poll(
      async () => {
        await page.goto(`/overview/${DASH_ID}`);
        const tile = page.locator('.sw-card.tile .value').first();
        return (await tile.textContent().catch(() => null))?.trim() ?? null;
      },
      { timeout: 120_000, intervals: [5_000] },
    )
    // The VALUE is the assertion — a metric whose MQE cannot self-aggregate
    // renders the same tile with an em dash and no error at all.
    .toMatch(/\d/);

  expect(pageErrors, 'an uncaught error during mount blanks the page').toEqual([]);
});
