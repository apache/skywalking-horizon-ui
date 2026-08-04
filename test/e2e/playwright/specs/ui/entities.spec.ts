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

// The tabs below the service dashboard, and the alarms page. Each is a
// separate render path over data the core fixture already produces.

test('the instance tab renders a dashboard for a real instance', async ({ page, pageErrors }) => {

  await page.goto(`/layer/${LAYER}/instance`);

  // Same template renderer as the service tab, driven by the instance scope.
  // An empty widget grid here means the scope never resolved an entity —
  // instance metrics are a different OAP scope, and querying the wrong one
  // returns empty rather than erroring.
  const widgets = page.locator('.widget');
  await expect(widgets.first()).toBeVisible({ timeout: 45_000 });
  await expect(page.getByText('provider1').first()).toBeVisible({ timeout: 45_000 });

  expect(pageErrors).toEqual([]);
});

test('the endpoint tab renders a dashboard for a real endpoint', async ({ page, pageErrors }) => {

  await page.goto(`/layer/${LAYER}/endpoint`);

  const widgets = page.locator('.widget');
  await expect(widgets.first()).toBeVisible({ timeout: 45_000 });
  await expect(page.getByText('POST:/users').first()).toBeVisible({ timeout: 45_000 });

  expect(pageErrors).toEqual([]);
});

test('the API dependency tab mounts and resolves an endpoint', async ({ page, pageErrors }) => {

  await page.goto(`/layer/${LAYER}/dependency`);
  await expect(page.locator('#app')).toBeVisible();
  // The demo app's endpoint reaching this view proves the endpoint scope
  // resolved; the dependency graph itself needs a second endpoint to be
  // interesting, which this fixture does not produce.
  await expect(page.getByText('POST:/users').first()).toBeVisible({ timeout: 45_000 });

  expect(pageErrors).toEqual([]);
});

test('the alarms page lists what OAP is firing', async ({ page, pageErrors }) => {

  await page.goto('/alarms');

  // OAP's bundled rules fire against the demo traffic without the fixture
  // installing any rule, so rows are expected rather than optional.
  const rows = page.locator('.ax__rows .ax__row');
  await expect(rows.first()).toBeVisible({ timeout: 45_000 });
  // The entity an alarm fired on is the operator's first question; a row that
  // renders without it is unactionable.
  await expect(rows.first().locator('.ax__row-entity-name')).not.toBeEmpty();

  expect(pageErrors).toEqual([]);
});
