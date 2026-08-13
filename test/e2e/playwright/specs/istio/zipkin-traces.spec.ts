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


// The MESH layer sources its traces from Zipkin rather than from
// SkyWalking's own trace query — `mesh.json` says so — so this tab is a
// SEPARATE view from the native one and reachable no other way.
//
// It lives with the mesh case because Envoy reports the spans: a mesh
// deployment feeds OAP's Zipkin receiver from the same traffic that produces
// the topology, which is closer to how the receiver is really used than a
// standalone Brave app reporting into an otherwise empty layer.

test('the Zipkin trace tab lists traces from the Zipkin receiver', async ({ page, pageErrors }) => {

  await page.goto('/layer/mesh/zipkin-trace');
  await expect(page.locator('.ztr-tab')).toBeVisible({ timeout: 45_000 });

  // Same trailing-control contract as the native traces tab: the query fires
  // on an explicit Run query, never on navigation.
  const run = page.locator('button.ztr-run-btn');
  await expect(run).toBeEnabled();
  await run.click();

  // Rows, not "the page rendered". An empty list is exactly what the broken
  // build produced, and it looks identical to a healthy page with no data —
  // which is why only this assertion separates them.
  const rows = page.locator('.tr-rowlist .tr-row-card');
  await expect(rows.first()).toBeVisible({ timeout: 45_000 });
  await expect(rows.first().locator('.tr-ep')).not.toBeEmpty();

  expect(pageErrors, 'an uncaught error during mount blanks the page').toEqual([]);
});

test('a zipkin trace opens its own detail card', async ({ page, pageErrors }) => {
  await page.goto('/layer/mesh/zipkin-trace');
  await page.locator('button.ztr-run-btn').click();

  const rows = page.locator('.tr-rowlist .tr-row-card');
  await expect(rows.first()).toBeVisible({ timeout: 45_000 });
  await rows.first().click();

  // A DIFFERENT detail renderer from the native one: Zipkin spans carry their
  // own shape (annotations rather than SkyWalking's span kinds), so the two
  // cards share a look and almost no code. The native card being right says
  // nothing about this one.
  const detail = page.locator('.ztr-detail');
  await expect(detail).toBeVisible({ timeout: 45_000 });
  // Span rows, not the header: `.ztr-tid` renders from the row that was
  // clicked, so it is populated even when the detail fetch came back empty.
  await expect(detail.locator('.ztr-waterfall .tp-row').first()).toBeVisible({
    timeout: 45_000,
  });

  expect(pageErrors, 'an uncaught error during mount blanks the page').toEqual([]);
});

test('a shared zipkin trace link opens the trace in a new page', async ({
  page,
  context,
  pageErrors,
}) => {
  await page.goto('/layer/mesh/zipkin-trace');
  await page.locator('button.ztr-run-btn').click();
  const rows = page.locator('.tr-rowlist .tr-row-card');
  await expect(rows.first()).toBeVisible({ timeout: 45_000 });

  // The id is read off the row rather than the URL: a row click on this tab
  // commits to LOCAL state and shows the detail inline, so — unlike the
  // native tab — it does not put anything in the query string. `?traceId=`
  // is the paste-an-id / share-a-link path, which is exactly why it needs
  // its own assertion.
  await rows.first().click();
  const detail = page.locator('.ztr-detail');
  await expect(detail).toBeVisible({ timeout: 45_000 });
  const traceId = (await detail.locator('.ztr-tid').innerText()).trim();
  expect(traceId, 'the detail should name the trace it opened').toBeTruthy();

  const shared = await context.newPage();
  try {
    await shared.goto(`/layer/mesh/zipkin-trace?traceId=${traceId}`);

    // A SEPARATE global popout from the native one — AppShell mounts both,
    // and `useTracePopout` deliberately declines Zipkin-sourced routes so the
    // two never fight over the same `?traceId=`. Asserting the native
    // backdrop here would fail against a perfectly working link.
    await expect(shared.locator('.zk-popout')).toBeVisible({ timeout: 45_000 });
    // The id echoes back from the URL, so it proves routing, not fetching.
    // The spans are what the link had to go and get.
    await expect(shared.locator('.zk-waterfall .tp-row').first()).toBeVisible({
      timeout: 45_000,
    });
  } finally {
    await shared.close();
  }

  expect(pageErrors, 'an uncaught error during mount blanks the page').toEqual([]);
});
