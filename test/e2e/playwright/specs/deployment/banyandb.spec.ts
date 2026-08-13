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
  // The fixture runs two liaisons and two data nodes, so the pair can hold
  // four edges and the one carrying writes may be last. Opening each costs a
  // panel load plus the wait below, which does not fit the 60s default — and
  // overrunning it reports a bare timeout instead of the assertion's own
  // diagnosis, so a healthy-but-unlucky ordering would look like a product
  // failure. Stated as a number with its arithmetic rather than `test.slow()`,
  // which silently means "×3".
  test.setTimeout(150_000);

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

  // The edge that HAS the traffic, read off the table rather than assumed. The
  // group holds one row per liaison×data pairing, and which of them carried the
  // writes depends on how the cluster hashed the data — so row one is a coin
  // flip. The table already prints every edge's Write/s and Query/s (`primary`
  // in the pair's config, `td.fl-primary` on screen) and renders an em dash for
  // a null, so the page's own answer names the row worth opening.
  const withTraffic = flowRows.filter({ has: page.locator('td.fl-primary', { hasText: /\d/ }) });
  await expect(
    withTraffic.first(),
    'no liaison -> data edge reported a Write/s or Query/s value — the pair that carries every write is idle',
  ).toBeVisible({ timeout: 30_000 });
  // The DRAWN chart on a primary row. Sparkline needs two finite points and
  // renders `.sparkline-empty` below that, so asserting rows alone passed on a
  // panel of em dashes — which is why the readiness check ahead of this waits
  // for two points rather than one. Scoping matters as much: an unscoped
  // `.sparkline` was satisfied by the pair's `bytes` or `err` rows, the
  // loophole that same filter was narrowed to `write` / `query` to close.
  const primaryChart = page
    .locator('.ip-edge-rows .ip-edge-row')
    .filter({ has: page.locator('.ip-edge-row-label', { hasText: /^(Write\/s|Query\/s)\b/ }) })
    .locator('.sparkline');

  // Each reporting edge in turn, because a cell and a chart do not need the
  // same amount of data: the cell prints from ONE non-null bucket while the
  // line needs two, so an edge can report traffic and still legitimately draw
  // nothing. The readiness check proves only that SOME call in the pair has a
  // drawable series, and this finds it. Bounded to the edges that reported a
  // value — usually one — rather than sweeping every pairing in the group.
  const candidates = await withTraffic.count();
  let drawn = false;
  for (let i = 0; i < candidates && !drawn; i += 1) {
    await page.getByRole('button', { name: 'Flows' }).click();
    await withTraffic.nth(i).click();
    // The ROWS are the edge configuration reaching the panel: one per metric
    // id the template declares for the pair, pairing `lineClient` (measured at
    // the caller) with `lineServer` (measured at the callee).
    await expect(page.locator('.ip-edge-rows').first()).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.ip-edge-rows .ip-edge-row').first()).toBeVisible();
    // The panel's rows render from config and fill from the edge's own fetch,
    // so this has to outlast that query — but it is a NEGATIVE wait paid once
    // per candidate, so it stays as short as that allows.
    drawn = await primaryChart
      .first()
      .waitFor({ state: 'visible', timeout: 10_000 })
      .then(() => true)
      .catch(() => false);
  }
  expect(
    drawn,
    `none of the ${candidates} liaison -> data edge(s) reporting a value drew a Write/s or Query/s sparkline`,
  ).toBe(true);

  expect(pageErrors, 'an uncaught error during mount blanks the page').toEqual([]);
});
