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
import { PROVIDER_SERVICE, LAYER } from '../fixture.js';
import { selectService } from '../support/layer.js';

// The second click. Lists are the entry point; what an operator opens FROM a
// row is a separate render path with its own fetch, so a list can be perfect
// while the thing it opens is blank.
//
// Note which gesture opens which surface — they are not the same:
//   - a trace row on the traces tab  -> an INLINE split detail, not a modal
//   - a log row's trace chip         -> the global trace popout, mounted in
//                                       AppShell and addressed by ?openTraceId
//   - a log row                      -> the log detail panel
//   - a widget's ⤢                   -> the full-list popout

test('a trace row opens its detail beside the list', async ({ page, pageErrors }) => {
  await page.goto(`/layer/${LAYER}/trace`);
  await page.locator('button.tr-run-btn').click();

  const rows = page.locator('.tr-rowlist .tr-row-card');
  await expect(rows.first()).toBeVisible({ timeout: 45_000 });
  await rows.first().click();

  // The traces tab splits rather than popping a modal: the list becomes a
  // rail and the detail takes the pane. Asserting the split is what catches
  // a detail that fetched nothing — the rail alone would still look fine.
  await expect(page.locator('.tr-detail-split')).toBeVisible({ timeout: 45_000 });
  await expect(page.getByText(PROVIDER_SERVICE).first()).toBeVisible({ timeout: 45_000 });

  expect(pageErrors, 'an uncaught error during mount blanks the page').toEqual([]);
});

test('a log row jumps to the trace popout and back', async ({ page, pageErrors }) => {
  await page.goto(`/layer/${LAYER}/logs`);
  await selectService(page, PROVIDER_SERVICE);
  await page.locator('button.lg-run-btn').click();

  const rows = page.locator('.lg-stream .lg-row');
  await expect(rows.first()).toBeVisible({ timeout: 45_000 });

  // Only logs carrying a trace id get the chip — the agent correlates them,
  // so this also proves the correlation survived the LAL pipeline.
  const chip = page.locator('.lg-trace').first();
  await expect(chip, 'no log row carried a trace id to jump from').toBeVisible({ timeout: 45_000 });
  await chip.click();

  // The popout is global (mounted in AppShell) and URL-addressable, so a
  // shared link reopens it. Both halves matter.
  //
  // The param is `traceId` — note the source comment in useTracePopout says
  // `openTraceId`, but TRACE_POPOUT_QUERY is what the code actually uses.
  await expect(page.locator('.tp-backdrop')).toBeVisible({ timeout: 45_000 });
  expect(page.url()).toContain('traceId=');
  await expect(page.locator('.tp-head')).toBeVisible();

  // Dismissing must return to the logs, not unmount the host: a popout that
  // takes its page with it leaves the operator on an empty tab.
  await page.locator('.tp-backdrop').click({ position: { x: 5, y: 5 } });
  await expect(page.locator('.tp-backdrop')).toHaveCount(0);
  await expect(rows.first()).toBeVisible();
  expect(page.url()).not.toContain('traceId=');

  expect(pageErrors).toEqual([]);
});

test('a log row opens its detail with the full content', async ({ page, pageErrors }) => {
  await page.goto(`/layer/${LAYER}/logs`);
  await selectService(page, PROVIDER_SERVICE);
  await page.locator('button.lg-run-btn').click();

  const rows = page.locator('.lg-stream .lg-row');
  await expect(rows.first()).toBeVisible({ timeout: 45_000 });
  await rows.first().click();

  // The stream truncates each line to one row; the detail is where the whole
  // record — format, service, full body — becomes readable.
  const detail = page.locator('.ld');
  await expect(detail).toBeVisible({ timeout: 45_000 });
  await expect(detail.locator('.ld-head')).toBeVisible();
  await expect(detail).toContainText(PROVIDER_SERVICE);

  expect(pageErrors).toEqual([]);
});

test('a widget pops out to its full list', async ({ page, pageErrors }) => {
  await page.goto(`/layer/${LAYER}/service`);
  await expect(page.locator('.widget').first()).toBeVisible({ timeout: 45_000 });

  // Top-list widgets cap their rows to fit the tile; ⤢ is how an operator
  // sees the rest. A different render of the same data, so it can break while
  // the tile looks healthy. The control only appears when there IS data.
  const popout = page.locator('button.w-popout').first();
  await expect(popout).toBeVisible({ timeout: 45_000 });
  await popout.click();

  await expect(page.getByText('POST:/users').first()).toBeVisible({ timeout: 45_000 });

  expect(pageErrors).toEqual([]);
});
