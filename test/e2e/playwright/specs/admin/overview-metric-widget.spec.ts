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

// The `metric` widget's aggregation modes — editor behaviour, no data needed.
//
// The mode control was gated to kpi-tile / metric-composite, so a `metric`
// could never reach the page-side path even though the renderer has always
// honoured it. Authoring-and-rendering lives in `core`, which has traffic;
// this half belongs here because it asserts the FORM, not a value.

test('the metric widget offers both aggregation modes', async ({ page, pageErrors }) => {
  await page.goto('/admin/overview-templates');
  await expect(page.locator('.ot')).toBeVisible({ timeout: 45_000 });

  // ADD a metric widget rather than opening whichever cell happens to be
  // first. The bundled dashboard leads with a kpi-tile, which always had the
  // mode control — selecting it asserts nothing about `metric` and passes
  // against the unfixed build, which is exactly what this spec exists to
  // catch. `metric` is the composer's default type.
  await page.locator('button.ot__add-trigger').click();
  const composer = page.locator('.ot__composer');
  await expect(composer).toBeVisible();
  await expect(composer.locator('select').first()).toHaveValue('metric');
  await composer.locator('button.ot__btn--primary').click();

  // Open the one just created — it is appended, so it is last.
  const cells = page.locator('.ot__pv-grid .ot__cw');
  await expect(cells.last()).toBeVisible({ timeout: 45_000 });
  await cells.last().click();

  // The editor panel carries a per-type modifier, so the assertion is scoped
  // to a METRIC widget's own form rather than to whatever else is on screen.
  const panel = page.locator('.ot__widget--metric');
  await expect(panel, 'the drawer is not showing a metric widget').toBeVisible({
    timeout: 45_000,
  });

  // Both modes must be offered here: server-side (the MQE self-aggregates)
  // and page-side (fan out per service, then roll up). The control used to be
  // withheld from this widget type even though the renderer honoured it.
  const modes = panel.locator('.ot__agg-opt input[type="radio"]');
  await expect.poll(async () => modes.count(), { timeout: 45_000 }).toBe(2);

  // And the aggregation choice appears only in the mode that reads it.
  await expect(panel.locator('select').filter({ hasText: 'avg' })).toHaveCount(0);
  await modes.last().check();
  await expect(panel.locator('select').filter({ hasText: 'avg' })).toHaveCount(1);

  expect(pageErrors, 'an uncaught error during mount blanks the page').toEqual([]);
});
