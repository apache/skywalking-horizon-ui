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

// Overview dashboards, which are a SEPARATE renderer from the layer
// dashboards — different widget vocabulary, different template shape. Nothing
// asserted them, so four widget components shipped untested.
//
// The bundled `services` overview is the one this fixture can render: it is
// public and lists GENERAL among its layers, which is what the demo app
// reports into. It declares five KPI tiles, three section breaks, an alarms
// widget, a metric-composite and a topology — so one page covers the lot.

const OVERVIEW = '/overview/services';

test('the services overview renders its widget vocabulary', async ({ page, pageErrors }) => {
  await page.goto(OVERVIEW);

  // KPI tiles are the overview's headline numbers, and the template declares
  // five. Asserting more than one distinguishes "the grid rendered" from "one
  // tile rendered and the rest fell through".
  const tiles = page.locator('.sw-card.tile');
  await expect(tiles.first()).toBeVisible({ timeout: 45_000 });
  await expect.poll(async () => tiles.count(), { timeout: 45_000 }).toBeGreaterThan(1);
  // `.kpi-value`, NOT `.count`. The count row is the tile's service tally,
  // which is always numeric — it prints "0" for a layer OAP never answered for
  // — so requiring a digit there passed on exactly the build this is meant to
  // catch. The KPI rows are the MQE-bound ones (general's is
  // `sum(top_n(service_cpm, …))`, the metric the case's readiness check already
  // gates on), and they render an em dash when nothing bound.
  await expect
    .poll(
      async () =>
        (await tiles.locator('.kpi-value').allTextContents()).filter((t) => /\d/.test(t)).length,
      { timeout: 30_000, message: 'every KPI row rendered an em dash — the overview bound no values' },
    )
    .toBeGreaterThan(0);

  // Section breaks are layout, not data — they render regardless of what OAP
  // answers, so their absence means the template never reached the renderer.
  await expect(page.locator('.section-break').first()).toBeVisible();

  // The composite tile and the alarms tile are each their own renderer.
  await expect(page.locator('.sw-card.mc').first()).toBeVisible({ timeout: 45_000 });
  await expect(page.locator('.sw-card.alarms-widget').first()).toBeVisible({ timeout: 45_000 });

  expect(pageErrors, 'an uncaught error during mount blanks the page').toEqual([]);
});
