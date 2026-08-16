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

/**
 * The sidebar rows under a layer, and where they lead.
 *
 * Deep-link coverage alone cannot see these: every other spec navigates by
 * URL, so a row that is missing, mislabelled, or pointing at the wrong
 * route still passes everywhere else. The BFF resolves the row list and
 * serves it on the menu, so the assertion is that what the sidebar renders
 * IS that list — a disagreement between them is the bug this file exists
 * for.
 */

import { test, expect } from '../support/diagnostics.js';

const LAYER = 'general';

/** Row paths the sidebar renders for a layer, in order. */
async function renderedRows(page: import('@playwright/test').Page, layer: string): Promise<string[]> {
  const hrefs = await page.locator('.layer-children a').evaluateAll((as) =>
    as.map((a) => a.getAttribute('href') ?? ''),
  );
  const prefix = `/layer/${layer}/`;
  return hrefs.filter((h) => h.toLowerCase().startsWith(prefix)).map((h) => h.slice(prefix.length));
}

/**
 * Row paths the BFF resolved, read through the runner rather than from
 * inside the page — a spec that fetches in `page.evaluate` is testing its
 * own JavaScript and inherits the page's CSP.
 *
 * This is the one wire read here, and it is what makes the assertion
 * meaningful: the rendered rows are checked against the list the server
 * decided, which is the invariant. Pinning an expected row list for a
 * layer instead would assert the fixture's shape, and would pass while
 * the sidebar and the BFF disagreed.
 */
async function servedRows(api: import('@playwright/test').APIRequestContext, layer: string): Promise<string[]> {
  const res = await api.get('/api/menu');
  expect(res.ok(), `GET /api/menu failed with ${res.status()}`).toBe(true);
  const body = (await res.json()) as {
    layers: Array<{ key: string; menuRows?: Array<{ path: string }> }>;
  };
  return (body.layers.find((x) => x.key === layer)?.menuRows ?? []).map((r) => r.path);
}

test('the sidebar renders exactly the rows the BFF resolved', async ({ page, request: api, pageErrors }) => {
  await page.goto(`/layer/${LAYER}/service`);
  await expect(page.locator('.layer-children a').first()).toBeVisible({ timeout: 45_000 });

  const served = await servedRows(api, LAYER);
  expect(served.length, 'the menu served no rows for this layer').toBeGreaterThan(1);
  expect(await renderedRows(page, LAYER)).toEqual(served);

  expect(pageErrors).toEqual([]);
});

test('every row leads to a route that renders', async ({ page }) => {
  await page.goto(`/layer/${LAYER}/service`);
  await expect(page.locator('.layer-children a').first()).toBeVisible({ timeout: 45_000 });
  const rows = await renderedRows(page, LAYER);

  for (const row of rows) {
    await page.goto(`/layer/${LAYER}/${row}`);
    // The shell renders for every row; a dead route leaves it empty.
    await expect(page.locator('.layer-children a').first()).toBeVisible({ timeout: 45_000 });
    // And the URL is not bounced somewhere else — a row the shell does not
    // consider supported would redirect to the layer's first row.
    expect(new URL(page.url()).pathname.toLowerCase()).toBe(`/layer/${LAYER}/${row}`.toLowerCase());
  }
});

test('exactly one row is active at a time', async ({ page }) => {
  await page.goto(`/layer/${LAYER}/instance`);
  await expect(page.locator('.layer-children a').first()).toBeVisible({ timeout: 45_000 });

  const active = await page.locator('.layer-children a.is-active').evaluateAll((as) =>
    as.map((a) => a.getAttribute('href') ?? ''),
  );
  expect(active).toHaveLength(1);
  expect(active[0].toLowerCase()).toBe(`/layer/${LAYER}/instance`);
});

test('a bare layer URL lands on the layer first row', async ({ page, request: api }) => {
  const served = await servedRows(api, LAYER);

  await page.goto(`/layer/${LAYER}`);
  await expect(page.locator('.layer-children a').first()).toBeVisible({ timeout: 45_000 });
  await expect(page).toHaveURL(new RegExp(`/layer/${LAYER}/${served[0]}$`, 'i'));
});

test('an unsupported tab falls back rather than rendering an empty page', async ({ page }) => {
  // `pprof` is a real layer route, but only for layers that enable it.
  // Whichever layer we are on, asking for a row it does not expose must
  // land on a row it does.
  await page.goto(`/layer/${LAYER}/service`);
  await expect(page.locator('.layer-children a').first()).toBeVisible({ timeout: 45_000 });
  const rows = await renderedRows(page, LAYER);
  const absent = ['pod-logs', 'deployment', 'browser-errors'].find((r) => !rows.includes(r));
  test.skip(!absent, 'this layer exposes every row this check could use');

  await page.goto(`/layer/${LAYER}/${absent}`);
  // The redirect needs the layer's rows, which arrive with the menu — and
  // the sidebar is on screen well before that. Reading the URL when the
  // sidebar appears reads it before the fallback has run.
  await expect
    .poll(() => new URL(page.url()).pathname.slice(`/layer/${LAYER}/`.length), { timeout: 45_000 })
    .not.toBe(absent);
  const landed = new URL(page.url()).pathname.slice(`/layer/${LAYER}/`.length);
  expect(rows, `fell back to ${landed}, which is not one of this layer's rows`).toContain(landed);
});
