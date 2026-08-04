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
import { LAYER, DEMO_ENDPOINTS } from '../fixture.js';

// Trace profiling, which the Java agent provides — so unlike eBPF profiling
// it needs no rover and belongs here rather than in the mesh case.
//
// This is the one place `core` WRITES: creating a task registers it on OAP.
// It is scoped to the demo service and touches nothing the other specs read,
// which is why it does not need the isolated stack the `admin` case has.
//
// What it does NOT assert is a collected segment. The agent samples a trace
// only when a request outlives the dump threshold, and whether that happens
// inside the window depends on traffic timing — a real assertion for a case
// that owns its own traffic, a coin flip here.

test('a trace profile task can be created and appears in the list', async ({ page, pageErrors }) => {
  await page.goto(`/layer/${LAYER}/trace-profiling`);

  // Disabled until the header resolves a service — clicking earlier would
  // open a modal that cannot submit.
  const newTask = page.locator('button.btn-new');
  await expect(newTask).toBeEnabled({ timeout: 45_000 });
  await newTask.click();

  const dialog = page.locator('.dlg');
  await expect(dialog).toBeVisible();

  // An endpoint is REQUIRED — submitting without one is refused with
  // "endpoint name cannot be empty", so the combo has to be driven even
  // though its placeholder reads "(any)". The list is fetched from OAP's
  // endpoint roster, which is also why typing has to be followed by picking:
  // the value comes from the fetched item, not from the input text.
  const combo = dialog.locator('.cf-combo');
  await combo.locator('input.cf-input').click();
  const item = combo
    .locator('li.cf-combo-item')
    .filter({ hasText: new RegExp(DEMO_ENDPOINTS.map((e) => e.replace('/', '\\/')).join('|')) })
    .first();
  await expect(item, 'no demo endpoint offered — is the roster empty?').toBeVisible({
    timeout: 45_000,
  });
  await item.click();

  await dialog.locator('button.btn-primary').click();

  // The task list is served back from OAP, not from local state: the view
  // re-fetches after submitting, so a row here means OAP accepted and stored
  // it. `.side-empty` is what shows when it did not.
  await expect(dialog).toBeHidden({ timeout: 45_000 });
  await expect(page.locator('.side-list li').first()).toBeVisible({ timeout: 45_000 });

  expect(pageErrors, 'an uncaught error during mount blanks the page').toEqual([]);
});
