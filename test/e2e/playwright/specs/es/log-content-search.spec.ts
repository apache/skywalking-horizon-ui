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

// Searching stored logs by CONTENT, which only this deployment can do.
//
// OAP answers `supportQueryLogsByKeywords` from its storage — ElasticSearch
// yes, BanyanDB no — and a backend that says no accepts the filter and
// ignores it. So Horizon offers the box only here, and the `core` case's
// Logs tab legitimately has no Content field at all.

test('a content search narrows the stored-log stream', async ({ page, pageErrors }) => {
  test.setTimeout(180_000);
  await page.goto(`/layer/${LAYER}/logs`);

  const content = page.locator('input[name="log-content"]');
  await expect(content, 'ElasticSearch reports keyword support, so the box belongs here').toBeVisible(
    { timeout: 45_000 },
  );

  // Baseline: the unfiltered page.
  await page.locator('button.lg-run-btn').click();
  const rows = page.locator('.lg-stream .lg-row');
  await expect(rows.first()).toBeVisible({ timeout: 60_000 });
  const before = await rows.count();
  expect(before, 'no logs to search').toBeGreaterThan(0);

  // A needle no log line carries must empty the stream — the assertion is
  // that OAP FILTERED, which a backend ignoring the condition cannot do:
  // there the same page comes back and the count is unchanged.
  await content.fill('zzz-no-such-log-content-zzz');
  await page.locator('button.lg-run-btn').click();
  await expect
    .poll(async () => rows.count(), { timeout: 60_000, intervals: [2_000] })
    .toBe(0);
  await expect(page.locator('.lg-empty')).toBeVisible();

  // Clearing brings them back, so the empty state above was the filter and
  // not a stream that had simply stopped.
  await content.fill('');
  await page.locator('button.lg-run-btn').click();
  await expect
    .poll(async () => rows.count(), { timeout: 60_000, intervals: [2_000] })
    .toBeGreaterThan(0);

  expect(pageErrors, 'an uncaught error during mount blanks the page').toEqual([]);
});
