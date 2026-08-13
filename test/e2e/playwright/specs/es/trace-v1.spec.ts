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
import { DEMO_ENDPOINTS, LAYER } from '../fixture.js';

// What a NON-BANYANDB backend changes for the operator. Everything here is
// unreachable on the default stack, which is the whole justification for
// spending a second deployment (CLAUDE.md §1) — and nothing here re-proves
// what storage does not affect.
//
// Three behaviours, all consequences of Horizon classifying the backend as
// `other` rather than `banyandb`:
//
//   1. the pre-v2 trace query — v2 is BanyanDB-only
//   2. a v1 row is a SEGMENT, so opening one fetches the full trace
//   3. cold stage does not exist, so the affordance is hidden rather than
//      offered as a switch that changes nothing

test('the traces tab reports the pre-v2 query API', async ({ page, pageErrors }) => {
  await page.goto(`/layer/${LAYER}/trace`);
  await page.locator('button.tr-run-btn').click();

  const rows = page.locator('.tr-rowlist .tr-row-card');
  await expect(rows.first()).toBeVisible({ timeout: 45_000 });

  // queryBasicTraces is the v1 API. On BanyanDB this reads queryTraces, so the
  // assertion doubles as proof the storage override actually took effect.
  await expect(page.locator('.tr-api-banner code')).toHaveText('queryBasicTraces');

  const endpoint = await rows.first().locator('.tr-ep').textContent();
  expect(
    DEMO_ENDPOINTS.some((known) => endpoint?.includes(known)),
    `unexpected endpoint in the trace list: ${endpoint}`,
  ).toBe(true);

  expect(pageErrors, 'an uncaught error during mount blanks the page').toEqual([]);
});

test('a v1 row is a segment that opens to its full trace', async ({ page, pageErrors }) => {
  await page.goto(`/layer/${LAYER}/trace`);
  await page.locator('button.tr-run-btn').click();

  const rows = page.locator('.tr-rowlist .tr-row-card');
  await expect(rows.first()).toBeVisible({ timeout: 45_000 });

  // The v1 list returns SEGMENTS, not whole traces — the banner says so, and
  // it changes what a click means: the full trace is fetched on open rather
  // than already being inline as on v2. This interaction exists only on a
  // pre-v2 backend.
  await rows.first().click();

  // Scoped to the detail panel, not the page. `getByText('e2e-service-provider')`
  // matched the layer header's service selector, which is on screen BEFORE the
  // click — so the assertion passed whether or not the segment ever opened,
  // which is the one thing this test exists to prove. The sibling v2 spec uses
  // `.tr-detail` for the same reason.
  const detail = page.locator('.tr-detail');
  await expect(detail).toBeVisible({ timeout: 45_000 });
  // The fetched trace, not the row: a segment row carries no spans until the
  // full trace is loaded on open, so a waterfall row is what proves the fetch
  // happened rather than the panel merely opening on the row it already had.
  await expect(detail.locator('.tr-default-row').first()).toBeVisible({ timeout: 45_000 });

  expect(pageErrors).toEqual([]);
});

test('cold stage is not offered on a backend without it', async ({ page, pageErrors }) => {
  await page.goto(`/layer/${LAYER}/service`);
  await expect(page.locator('.sw-side')).toBeVisible({ timeout: 45_000 });

  // Cold stage is a BanyanDB capability; OAP silently ignores the flag on
  // other storage, so offering the toggle would be a switch that changes
  // nothing. The topbar hides it when the backend is not banyandb, and
  // asserting its ABSENCE is the only way to catch the affordance leaking
  // back for operators it cannot help.
  await expect(page.getByRole('button', { name: /^cold$/i })).toHaveCount(0);

  expect(pageErrors).toEqual([]);
});
