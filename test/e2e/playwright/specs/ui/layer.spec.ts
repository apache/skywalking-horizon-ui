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

import { test, expect, type Page } from '@playwright/test';
import { PROVIDER_SERVICE, CONSUMER_SERVICE, DEMO_ENDPOINTS, LAYER } from '../fixture.js';

// These assert on OAP-supplied names (service and endpoint names), which are
// rendered verbatim in every locale. UI chrome is i18n-resolved, so it is
// matched structurally instead — an English string here would fail the moment
// the fixture ran under another locale.

/** The roster lives behind the header's service switch, not inline. */
async function openPicker(page: Page) {
  await page.locator('.service-row button.switch').click();
  const picker = page.locator('.picker-table');
  await expect(picker).toBeVisible();
  return picker;
}

test('the layer header resolves a service from the live roster', async ({ page }) => {
  await page.goto(`/layer/${LAYER}/service`);

  // Auto-selected from OAP's roster; an empty or placeholder name here means
  // the landing never resolved an entity and every widget below is querying
  // nothing.
  await expect(page.locator('.service-row .svc-name')).toHaveText(PROVIDER_SERVICE);
});

test('the service picker lists both demo services', async ({ page }) => {
  await page.goto(`/layer/${LAYER}/service`);
  const picker = await openPicker(page);

  await expect(picker.getByText(PROVIDER_SERVICE, { exact: true })).toBeVisible();
  await expect(picker.getByText(CONSUMER_SERVICE, { exact: true })).toBeVisible();
});

test('filtering the picker narrows the roster', async ({ page }) => {
  await page.goto(`/layer/${LAYER}/service`);
  const picker = await openPicker(page);
  await expect(picker.getByText(CONSUMER_SERVICE, { exact: true })).toBeVisible();

  await page.locator('input.search').fill('provider');

  await expect(picker.getByText(PROVIDER_SERVICE, { exact: true })).toBeVisible();
  await expect(picker.getByText(CONSUMER_SERVICE, { exact: true })).toHaveCount(0);
});

test('picking a service switches the header to it', async ({ page }) => {
  await page.goto(`/layer/${LAYER}/service`);
  await expect(page.locator('.service-row .svc-name')).toHaveText(PROVIDER_SERVICE);

  const picker = await openPicker(page);
  await picker.locator('tr.row', { hasText: CONSUMER_SERVICE }).click();

  // Selection is the upstream control every widget on the tab keys on. If it
  // does not stick, the page renders the previous service's data under the
  // new name — the failure operators cannot see.
  await expect(page.locator('.service-row .svc-name')).toHaveText(CONSUMER_SERVICE);
});

test('the service dashboard renders widgets driven by live metrics', async ({ page }) => {
  const crashes: string[] = [];
  page.on('pageerror', (e) => crashes.push(e.message));

  await page.goto(`/layer/${LAYER}/service`);

  // Scoped to the table widget's own cells, for the same reason the traces
  // assertion is: an unscoped text query also matches the chart tooltips'
  // SVG <title>, so it would pass on a dashboard whose Top-N table came back
  // empty. The endpoint name is OAP data reaching a widget through a bundled
  // template's MQE — the whole render path in one assertion.
  const topN = page.locator('.top-list .rows .row span.name');
  await expect(topN.first()).toBeVisible({ timeout: 45_000 });
  // Any demo endpoint, not one specific one: the widget ranks by traffic and
  // the fixture drives two endpoints, so pinning one turns a correct render
  // into a failure whenever the mix shifts.
  const listed = await topN.allTextContents();
  expect(
    listed.some((name) => DEMO_ENDPOINTS.some((known) => name.includes(known))),
    `Top-N showed none of the demo endpoints: ${listed.join(', ')}`,
  ).toBe(true);

  expect(crashes, 'an uncaught error during mount blanks the page').toEqual([]);
});

test('the traces tab returns traces produced by the demo app', async ({ page }) => {
  const crashes: string[] = [];
  page.on('pageerror', (e) => crashes.push(e.message));

  await page.goto(`/layer/${LAYER}/trace`);

  // Traces do not auto-fire: the tab owns its own time range and waits for an
  // explicit Run query, because a trace query is expensive enough that firing
  // it on navigation would hammer OAP. Drive the real control.
  const run = page.locator('button.tr-run-btn');
  await expect(run).toBeEnabled();
  await run.click();

  // Assert on a LIST ROW, not on the text anywhere: the scatter chart carries
  // the same endpoint name inside an SVG <title>, which matches a text query
  // but is never visible. A bare getByText here passes on a page whose trace
  // list is empty.
  const rows = page.locator('.tr-rowlist .tr-row-card');
  await expect(rows.first()).toBeVisible({ timeout: 45_000 });
  // Which endpoint owns the newest trace depends on traffic mix — see
  // DEMO_ENDPOINTS. Assert provenance, not a particular endpoint.
  const endpoint = await rows.first().locator('.tr-ep').textContent();
  expect(
    DEMO_ENDPOINTS.some((known) => endpoint?.includes(known)),
    `unexpected endpoint in the trace list: ${endpoint}`,
  ).toBe(true);

  expect(crashes).toEqual([]);
});
