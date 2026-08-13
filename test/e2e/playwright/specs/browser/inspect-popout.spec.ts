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

// Log inspect, and the browser-error popout that only it renders.
//
// The Browser Errors TAB has its own inline expander; this popout is a
// different component reached from a different page, so the tab passing says
// nothing about it. Both read the same seeded errors, which is why this case
// is where it belongs.
//
// It also gives the Explore/inspect page its first coverage of any kind.

test('log inspect opens a browser error in its popout', async ({ page, pageErrors }) => {
  await page.goto('/operate/log-inspect');

  // Three sources share this page; Browser swaps the entity picker to a
  // browser-service one, so the source has to be chosen before anything can
  // resolve.
  await page.getByRole('button', { name: 'Browser', exact: true }).click();

  const run = page.getByRole('button', { name: 'Run query' });
  await expect(run).toBeEnabled({ timeout: 60_000 });
  await run.click();

  // Explore renders browser errors through its OWN list component, not the
  // layer tab's log stream — `.be-row`, not `.lg-row`. Same records, a
  // different renderer, which is the reason this page needs its own spec.
  const rows = page.locator('.be-stream .be-row');
  await expect(rows.first()).toBeVisible({ timeout: 60_000 });
  await rows.first().click();

  // The popout carries the whole record — the stack is what an operator came
  // for, and it is the part the row itself never shows.
  const popout = page.locator('.be');
  await expect(popout).toBeVisible({ timeout: 45_000 });
  await expect(popout.locator('.be-head')).toBeVisible();
  // The SEEDED stack. `.be-pre` falls back to "(no stack)" when the record
  // carries none, so any-text would pass on an error whose stack was lost in
  // transit — which is the half of the record this popout exists to show.
  await expect(popout.locator('.be-pre')).toContainText('TypeError');

  expect(pageErrors, 'an uncaught error during mount blanks the page').toEqual([]);
});
