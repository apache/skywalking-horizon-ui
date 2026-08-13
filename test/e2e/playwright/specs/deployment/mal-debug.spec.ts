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

import type { Page } from '@playwright/test';
import { test, expect } from '../support/diagnostics.js';

// A live MAL debug RUN.
//
// MAL samples whichever rule you select, and the debugger lists `otel-rules`,
// `log-mal-rules`, `telegraf-rules` and `meter-analyzer-config`. This case is
// the only one that feeds an OTel rule set: its collector scrapes the FODC
// proxy into `otel-rules/banyandb`, so a capture here has records to catch.
// `core` covers the same debugger against a different producer — the Java
// agent's own meters through `meter-analyzer-config/java-agent` — so what
// this run adds is the collector-fed path, on the stack that has one.
//
// The rule is chosen BY NAME. Picking the first option lands on whatever
// sorts first — `log-mal-rules · miniprogram-alipay` in practice — a rule no
// fixture feeds, so the capture waits forever on data that cannot arrive.
//
// Starting a session mutates OAP, which this case already owns.

/** Pick a rule file by NAME + its first rule, then start. Both selects gate
 *  the button. */
async function startSampling(page: Page, filePattern: RegExp): Promise<void> {
  const file = page.locator('select.ctl__select').first();
  await expect(file).toBeVisible({ timeout: 45_000 });
  await expect
    .poll(async () => file.locator('option').count(), { timeout: 60_000 })
    .toBeGreaterThan(1);
  const label = (await file.locator('option').allTextContents()).find((o) => filePattern.test(o));
  expect(label, `no rule file matching ${filePattern} — the debugger lists none this fixture feeds`).toBeTruthy();
  await file.selectOption({ label: label! });

  const rule = page.locator('select.ctl__select').nth(1);
  await expect
    .poll(async () => rule.locator('option').count(), { timeout: 60_000 })
    .toBeGreaterThan(1);
  await rule.selectOption({ index: 1 });

  const start = page.getByRole('button', { name: 'start sampling' });
  await expect(start, 'sampling stayed disabled after picking a file and rule').toBeEnabled({
    timeout: 45_000,
  });
  await start.click();
  await expect(page.getByRole('button', { name: 'stop' })).toBeEnabled({ timeout: 45_000 });
}

test('the MAL debugger samples the collector metrics', async ({ page, pageErrors }) => {
  test.setTimeout(300_000);
  await page.goto('/operate/live-debug/mal');
  await startSampling(page, /banyandb/);

  // `.mal__empty` renders in the records' place when a capture catches
  // nothing, so asserting the page or the session state would pass on a
  // debugger that samples and shows nothing.
  await expect(page.locator('.mal__records').first()).toBeVisible({ timeout: 240_000 });

  // A record with STEPS in it. Asserting the card itself proved nothing: it is
  // the sole `v-for` child of a container that is already the `v-else` of the
  // empty branch, so it could not fail once the line above passed. The step
  // count is what "the debugger sampled something" actually means — a capture
  // that matched the rule but walked no transformation renders a card with
  // "0 steps".
  await expect(
    page.locator('.mal__rec').first().locator('.mal__recmeta'),
    'the first MAL record captured no transformation steps',
  ).toHaveText(/[1-9]\d* steps/, { timeout: 45_000 });

  expect(pageErrors, 'an uncaught error during mount blanks the page').toEqual([]);
});
