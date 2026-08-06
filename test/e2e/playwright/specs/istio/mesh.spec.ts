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
import { MESH_LAYER, MESH_PEERS, MESH_DP_LAYER, MESH_DP_SUFFIX } from '../fixture.js';

// The MESH layer, which no compose fixture can produce: its services and
// metrics are derived from Envoy access logs, not reported by an agent.
//
// The `card` widget form is the reason this case earns its stack. Every
// bundled template the other cases reach declares only line / top / record,
// so LayerWidgetTile's card branch — a single scalar rendered as a value
// rather than a chart — ships untested until a mesh deployment exists.

test('the mesh layer lists services built from Envoy access logs', async ({ page, pageErrors }) => {
  await page.goto(`/layer/${MESH_LAYER}/service`);

  // The header auto-resolves ONE service off the roster, and which one is not
  // ours to choose — it follows OAP's ordering, so pinning a name here would
  // fail on a healthy mesh whenever traffic shifts. Assert it landed on a
  // member of the known set instead.
  const selected = page.locator('.service-row .svc-name');
  await expect(selected).toBeVisible({ timeout: 45_000 });
  await expect(selected).toHaveText(new RegExp(`^(${MESH_PEERS.join('|')})$`));

  // The roster itself is the real assertion: every one of these exists only
  // because OAP analysed Envoy access logs into mesh entities. No agent
  // reported any of them.
  await page.locator('.service-row button.switch').click();
  const picker = page.locator('.picker-table');
  await expect(picker).toBeVisible();
  for (const peer of MESH_PEERS) {
    await expect(picker.locator('tr.row', { hasText: peer }).first()).toBeVisible();
  }

  expect(pageErrors, 'an uncaught error during mount blanks the page').toEqual([]);
});

test('the mesh topology draws the bookinfo call graph', async ({ page, pageErrors }) => {
  await page.goto(`/layer/${MESH_LAYER}/topology`);

  const nodes = page.locator('.sm-node');
  await expect(nodes.first()).toBeVisible({ timeout: 60_000 });

  // bookinfo is a four-service graph on purpose: with two services a single
  // edge drawn twice is indistinguishable from a real topology. Requiring
  // more than one peer is what makes this assert a GRAPH.
  await expect
    .poll(async () => nodes.count(), { timeout: 60_000 })
    .toBeGreaterThanOrEqual(MESH_PEERS.length);
  await expect(page.locator('.sm-edge').first()).toBeVisible({ timeout: 60_000 });

  expect(pageErrors).toEqual([]);
});

test('the mesh_dp instance dashboard renders its card widgets', async ({ page, pageErrors }) => {
  // Envoy's own stats, reported through the metrics service rather than ALS —
  // a different pipeline from the topology above, which is why the readiness
  // check for this one is separate.
  //
  // MESH_DP, not MESH: the same workload appears in both, named
  // `productpage.default` here and `productpage` there. Envoy's stats hang
  // off this one only.
  await page.goto(`/layer/${MESH_DP_LAYER}/instance`);

  // MESH_DP names the same workloads `<workload>.<namespace>`, and again the
  // header picks which one — so assert the SHAPE of the resolved name rather
  // than a particular workload.
  const selected = page.locator('.service-row .svc-name');
  await expect(selected).toBeVisible({ timeout: 60_000 });
  await expect(selected).toHaveText(new RegExp(`${MESH_DP_SUFFIX}$`));

  const tiles = page.locator('.widget');
  await expect(tiles.first()).toBeVisible({ timeout: 60_000 });

  const cards = page.locator('.w-body.type-card');
  await expect(cards.first(), 'mesh_dp declares card widgets; none rendered').toBeVisible({
    timeout: 60_000,
  });

  // The card branch collapses a window to ONE number. A card that dispatched
  // correctly but bound nothing still carries the type class, so the number
  // itself is what proves the branch actually rendered.
  await expect(cards.first().locator('.card-value .num')).toBeVisible({ timeout: 60_000 });

  expect(pageErrors).toEqual([]);
});
