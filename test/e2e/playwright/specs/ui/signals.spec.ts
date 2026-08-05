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
import { PROVIDER_SERVICE, CONSUMER_SERVICE, DEMO_ENDPOINTS, LAYER } from '../fixture.js';

// Signals beyond trace and metric, asserted where the operator sees them.
// The values checked here are the ones the BFF returned — read off the page
// rather than off the wire, so a pass proves the whole chain (CLAUDE.md §3.1).

test('the topology tab draws the demo call graph', async ({ page, pageErrors }) => {

  await page.goto(`/layer/${LAYER}/topology`);

  const nodes = page.locator('.sm-node[data-node-id]');
  await expect(nodes.first()).toBeVisible({ timeout: 45_000 });
  // Both demo services on the graph, by name — the same data a wire assertion
  // would have read from /topology, taken off the rendered node instead.
  await expect(page.getByText(PROVIDER_SERVICE, { exact: true }).first()).toBeVisible();
  await expect(page.getByText(CONSUMER_SERVICE, { exact: true }).first()).toBeVisible();
  // The EDGE is the point: nodes render whether or not the two ever talked,
  // which is the break a service map exists to reveal.
  await expect(page.locator('.sm-edge').first()).toBeVisible();

  expect(pageErrors, 'an uncaught error during mount blanks the page').toEqual([]);
});

test('a topology node opens its detail panel', async ({ page, pageErrors }) => {
  await page.goto(`/layer/${LAYER}/topology`);

  const nodes = page.locator('.sm-node[data-node-id]');
  await expect(nodes.first()).toBeVisible({ timeout: 45_000 });

  // The map is the entry point; the per-node panel is where an operator reads
  // that node's metrics. A separate render path over a separate fetch, so the
  // graph can draw perfectly while the panel comes back empty.
  const provider = page
    .locator('.sm-node[data-node-id]')
    .filter({ hasText: PROVIDER_SERVICE })
    .first();
  await provider.click();

  const panel = page.locator('.sm-panels .sm-panel').first();
  await expect(panel).toBeVisible({ timeout: 45_000 });
  await expect(panel).toContainText(PROVIDER_SERVICE);

  expect(pageErrors).toEqual([]);
});

test('a topology edge drills into the instance map', async ({ page, pageErrors, context }) => {
  await page.goto(`/layer/${LAYER}/topology`);
  await expect(page.locator('.sm-node[data-node-id]').first()).toBeVisible({ timeout: 45_000 });

  // Instance topology is reached SERVICE-TO-SERVICE: select the call between
  // two real services, and the drill-down queries instance-to-instance for
  // that pair. There is deliberately no standalone entrance — the view needs
  // both endpoints of an edge to have anything to ask for.
  //
  // The cap follows the template's `topology.instanceTopology` block, not the
  // components flag, so the button only appears where the drill-down is
  // actually configured.
  // Only an edge between two REAL services can drill: this map also carries
  // the synthetic `User` entry point and a virtual H2 database, and an
  // instance-to-instance query needs real instances at both ends. Edges carry
  // no source/target attribute, so find the qualifying one by asking.
  const drill = page.getByRole('button', { name: /instance map/i });
  const edges = page.locator('.sm-edge');
  const edgeCount = await edges.count();
  expect(edgeCount, 'the demo topology must have edges').toBeGreaterThan(0);

  let found = false;
  for (let i = 0; i < edgeCount; i += 1) {
    await edges.nth(i).click();
    if (await drill.isVisible().catch(() => false)) {
      found = true;
      break;
    }
  }
  expect(
    found,
    'no edge offered the instance-map drill-down — the consumer -> provider call should',
  ).toBe(true);

  // It opens in a NEW TAB, carrying client + server in the URL so the pair is
  // shareable.
  const [instancePage] = await Promise.all([context.waitForEvent('page'), drill.click()]);
  await instancePage.waitForLoadState();
  expect(instancePage.url()).toContain('view=instance');
  expect(instancePage.url()).toContain('client=');
  expect(instancePage.url()).toContain('server=');

  // Instance-level nodes, not the service map again — provider1 and consumer1
  // are what the agents registered.
  await expect(instancePage.locator('.imv-canvas')).toBeVisible({ timeout: 45_000 });
  await expect(instancePage.locator('.imv-node').first()).toBeVisible({ timeout: 45_000 });
  await expect(instancePage.getByText('provider1').first()).toBeVisible({ timeout: 45_000 });
  await instancePage.close();

  expect(pageErrors).toEqual([]);
});

test('the logs tab shows log lines with their content', async ({ page, pageErrors }) => {

  await page.goto(`/layer/${LAYER}/logs`);
  const run = page.locator('button.lg-run-btn');
  await expect(run).toBeEnabled();
  await run.click();

  const rows = page.locator('.lg-stream .lg-row');
  await expect(rows.first()).toBeVisible({ timeout: 45_000 });
  await expect(rows.first().locator('.lg-content')).not.toBeEmpty();
  // Service attribution, rendered. A LAL rule that drops the service would
  // leave rows that no operator could act on.
  await expect(rows.first().locator('.lg-svc')).toContainText(PROVIDER_SERVICE);

  expect(pageErrors).toEqual([]);
});

test('a trace opens to spans naming the demo services', async ({ page, pageErrors }) => {

  await page.goto(`/layer/${LAYER}/trace`);
  await page.locator('button.tr-run-btn').click();

  const rows = page.locator('.tr-rowlist .tr-row-card');
  await expect(rows.first()).toBeVisible({ timeout: 45_000 });
  const endpoint = await rows.first().locator('.tr-ep').textContent();
  expect(
    DEMO_ENDPOINTS.some((known) => endpoint?.includes(known)),
    `unexpected endpoint in the trace list: ${endpoint}`,
  ).toBe(true);

  // Open it. The detail is where span-level data lands, and it is the half a
  // trace-list assertion never reaches.
  await rows.first().click();
  await expect(page.getByText(PROVIDER_SERVICE).first()).toBeVisible({ timeout: 45_000 });

  expect(pageErrors).toEqual([]);
});
