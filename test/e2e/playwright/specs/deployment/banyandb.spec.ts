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
import { BANYANDB_LAYER, BANYANDB_CLUSTER, BANYANDB_ROLES } from '../fixture.js';

// The BANYANDB layer, fed by BanyanDB's own self-observability: a FODC agent
// beside every node, a proxy aggregating them, an OTel collector scraping the
// proxy, and OAP's banyandb rules turning that into metrics. Nothing shorter
// produces it — which is why this deployment exists.
//
// It is also the only case that renders the `table` widget form.

test('the banyandb layer resolves the cluster', async ({ page, pageErrors }) => {
  await page.goto(`/layer/${BANYANDB_LAYER}/service`);

  // The service name IS the `cluster` label the collector injects, so this
  // failing means the scrape reached OAP under a different identity — not
  // that the page is broken.
  const selected = page.locator('.service-row .svc-name');
  await expect(selected).toBeVisible({ timeout: 60_000 });
  await expect(selected).toHaveText(BANYANDB_CLUSTER);

  expect(pageErrors, 'an uncaught error during mount blanks the page').toEqual([]);
});

test('the service dashboard renders the table widget form', async ({ page, pageErrors }) => {
  await page.goto(`/layer/${BANYANDB_LAYER}/service`);
  await expect(page.locator('.widget').first()).toBeVisible({ timeout: 60_000 });

  // `table` is declared by no template any other case reaches, so this is the
  // first time TableWidget renders in the suite at all. The type class says
  // the renderer dispatched; the table element says it actually drew.
  const tile = page
    .locator('.widget')
    .filter({ has: page.locator('.w-head-title').getByText('Containers by Role', { exact: true }) })
    .first();
  await expect(tile, 'banyandb.service declares a table widget; it did not render').toBeVisible({
    timeout: 60_000,
  });
  await expect(tile.locator('.w-body')).toHaveClass(/\btype-table\b/);

  // BODY rows, not the table element: TableWidget renders its `<thead>`
  // regardless of the row set, so `.tw__table` alone would pass on an empty
  // table — and the checks above cover the deployment nodes and edge series,
  // not this widget's own `meter_banyandb_reporting_instances`. Naming a role
  // ties the assertion to real cluster data rather than to any row at all.
  const rows = tile.locator('.tw__table tbody tr');
  await expect(rows.first()).toBeVisible({ timeout: 60_000 });
  await expect(tile.locator('.tw__table tbody')).toContainText(/liaison|data/);

  expect(pageErrors).toEqual([]);
});

test('the deployment tab draws the cluster by role', async ({ page, pageErrors }) => {
  await page.goto(`/layer/${BANYANDB_LAYER}/deployment`);

  // The tab groups instances by the `node_role` / `node_type` attributes that
  // ride on the FODC samples. A cluster install has more than one role, which
  // is the whole reason this case runs BanyanDB clustered rather than
  // standalone — a single box would prove nothing about the grouping.
  const roles = page.locator('.lg-role-name');
  await expect(roles.first()).toBeVisible({ timeout: 60_000 });
  for (const role of BANYANDB_ROLES) {
    await expect(
      roles.filter({ hasText: role }).first(),
      `the ${role} role is missing from the deployment graph`,
    ).toBeVisible({ timeout: 60_000 });
  }

  // Nodes, not just the legend: the graph is what an operator reads.
  await expect(page.locator('.node-label').first()).toBeVisible({ timeout: 60_000 });

  expect(pageErrors).toEqual([]);
});

test('clicking a deployment edge opens its client/server sparklines', async ({
  page,
  pageErrors,
}) => {
  await page.goto(`/layer/${BANYANDB_LAYER}/deployment`);
  await expect(page.locator('.lg-role-name').first()).toBeVisible({ timeout: 60_000 });

  // The edge is the whole reason this case runs BanyanDB clustered: liaison
  // and data are separate roles, so `roleToRole` has a pair to draw between.
  const edges = page.locator('g.sit-edge');
  await expect(edges.first(), 'no edge in the deployment graph — single-role cluster?').toBeVisible({
    timeout: 60_000,
  });

  // Selected through the Flows table rather than by clicking the drawn edge.
  // The graph gives an edge a 14px transparent hit path, so an operator can
  // click it — but Playwright aims at the centre of the `<g>`'s bounding box,
  // which for a curved edge is not on the path. Synthesising the event with
  // `dispatchEvent` would reach the handler while proving nothing about
  // whether anyone can actually hit it, so the test drives the other real
  // control instead: a Flows row selects the same edge and returns to the
  // topology tab, which is the operator's second route to this panel.
  await page.getByRole('button', { name: 'Flows' }).click();

  // The liaison -> data pair BY NAME, not whichever row comes first. Flows are
  // grouped per role-pair, and the pairs are not equivalent: liaison -> data
  // carries every write and query the cluster serves, so it must have data.
  // lifecycle -> data declares only migration metrics, and this fixture
  // configures no lifecycle migration — an empty panel there is CORRECT, and
  // taking the first row that rendered anything let the case settle on it and
  // conclude nothing.
  const pair = page.locator('.sit-flow-group').filter({
    has: page.locator('.fg-pair', { hasText: 'liaison → data' }),
  });
  await expect(pair, 'no liaison -> data flow group — single-role cluster?').toBeVisible({
    timeout: 60_000,
  });
  const flowRows = pair.locator('tbody tr');
  await expect(flowRows.first()).toBeVisible({ timeout: 60_000 });
  await flowRows.first().click();

  // The ROWS are the edge configuration reaching the panel: one per metric id
  // the template declares for the pair, pairing `lineClient` (measured at the
  // caller) with `lineServer` (measured at the callee).
  await expect(page.locator('.ip-edge-rows').first()).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('.ip-edge-rows .ip-edge-row').first()).toBeVisible();

  // And a DRAWN chart, not just the row. Sparkline renders `.sparkline` only
  // when the series has a non-null point and `.sparkline-empty` otherwise, so
  // asserting the rows alone passed on a panel of em dashes. The readiness
  // check ahead of this proves the same pair's `write` / `query` series
  // through the endpoint the page reads, so an empty chart here is a defect,
  // not a cold cluster.
  await expect(
    page.locator('.ip-edge-rows .sparkline').first(),
    'the liaison -> data edge rendered no sparkline — the panel drew em dashes for a pair that carries every write',
  ).toBeVisible({ timeout: 60_000 });

  expect(pageErrors, 'an uncaught error during mount blanks the page').toEqual([]);
});
