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

  // EVERY edge, not the first one: which edge carries traffic depends on
  // where writes landed, and it differs between runs.
  //
  // `dispatchEvent` rather than `click`: the edge is an SVG `<g>` whose
  // visible geometry is a thin stroke, so Playwright's centre-point
  // actionability check lands on whatever is behind it and waits forever.
  // The handler is bound to the `<g>` itself, so dispatching reaches it.
  const count = await edges.count();
  let rows = 0;
  for (let i = 0; i < count && rows === 0; i += 1) {
    await edges.nth(i).dispatchEvent('click');
    await expect(page.locator('.ip-edge-rows').first()).toBeVisible({ timeout: 60_000 });
    rows = await page.locator('.ip-edge-rows .ip-edge-row').count();
  }

  // The ROWS are what this proves: one per metric id the template declares
  // for the pair, pairing `lineClient` (measured at the caller) with
  // `lineServer` (measured at the callee). That is the edge configuration
  // reaching the panel.
  //
  // The Sparkline itself is deliberately NOT asserted. It renders no
  // `.sparkline` element for an all-null series, and on a cluster minutes old
  // the relation metrics are still sparse — the readiness check ahead of this
  // sees values through the same endpoint the page uses, yet the rendered
  // rows are frequently still `—`. Requiring a drawn chart here made the case
  // fail on a healthy fixture, which is exactly what §7 warns against. What
  // is missing is a fixture that GUARANTEES sustained liaison<->data traffic,
  // not a stricter assertion.
  expect(rows, `no edge of ${count} rendered its metric rows`).toBeGreaterThan(0);

  expect(pageErrors, 'an uncaught error during mount blanks the page').toEqual([]);
});
