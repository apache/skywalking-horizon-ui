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
import { expect } from './diagnostics.js';

/**
 * Put the layer header on `name`, through the control an operator uses.
 *
 * For a spec that NEEDS a particular service's data rather than testing the
 * picker itself. Which service a layer opens on is ranked from metrics, and the
 * basis for that ranking changes as the hour rolls — so a spec that reads one
 * service's logs and relies on it happening to be selected is asserting
 * something that is only usually true. Say which one you need.
 *
 * A no-op when the header already shows `name`, so it costs nothing to call.
 */
export async function selectService(page: Page, name: string): Promise<void> {
  const shown = page.locator('.service-row .svc-name');
  await expect(shown).not.toBeEmpty({ timeout: 45_000 });
  if ((await shown.innerText()).trim() === name) return;

  await page.locator('.service-row button.switch').click();
  const picker = page.locator('.picker-table');
  await expect(picker).toBeVisible();
  await picker.locator('tr.row', { hasText: name }).click();
  await expect(shown).toHaveText(name);
}

/**
 * Pick an endpoint matching `name` on the endpoint tab, through its list.
 *
 * For a spec that needs an endpoint's DATA. The tab opens on the first
 * endpoint OAP lists, and OAP lists every endpoint it saw in the window —
 * ones known only from logs or cross-thread spans too, which carry no
 * endpoint metrics — so say which one you need.
 */
export async function selectEndpoint(page: Page, name: RegExp): Promise<void> {
  const row = page.locator('.ib-row').filter({ has: page.locator('.ib-name', { hasText: name }) }).first();
  await expect(row).toBeVisible({ timeout: 45_000 });
  await row.locator('.ib-pick-btn').click();
  await expect(page.locator('.ib-row.on .ib-name')).toHaveText(name);
}
