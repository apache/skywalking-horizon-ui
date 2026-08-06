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

  await page.locator('.ot__pv-grid .ot__cw').first().click();
  const drawer = page.locator('.ot__drawer, .ot__editor-split').first();
  await expect(drawer).toBeVisible({ timeout: 45_000 });

  // The mode radio was gated to kpi-tile / metric-composite, so a `metric`
  // could never reach the page-side path even though the renderer supports
  // it. Both options must be offered.
  const modes = page.locator('.ot__agg-opt input[type="radio"]');
  await expect
    .poll(async () => modes.count(), { timeout: 45_000 })
    .toBeGreaterThan(1);

  expect(pageErrors).toEqual([]);
});
