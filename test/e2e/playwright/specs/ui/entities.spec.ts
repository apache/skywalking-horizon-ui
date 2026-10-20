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
import { DEMO_ENDPOINT_PATTERN, LAYER } from '../fixture.js';
import { selectEndpoint } from '../support/layer.js';

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
  // `.ib-row.on` is the PICKED row. Matching the name anywhere on the page
  // matched the picker's list, which renders every instance before one is
  // selected — so the assertion passed whether or not an entity resolved,
  // which is the thing it exists to prove.
  await expect(page.locator('.ib-row.on')).toContainText('provider1', { timeout: 45_000 });
  // And the grid drew DATA, not merely tiles. A `.time-chart` renders for an
  // all-null series too, so it cannot tell a resolved scope from an empty one
  // — the very symptom described above. The widget COUNT can: this scope
  // declares 74 widgets of which 71 are gated on an `exists` MQE, and a gated
  // widget whose metric came back with no non-null value is dropped before the
  // page ever sees it. Anything above the 3 ungated ones therefore proves
  // instance-scope metrics arrived.
  await expect
    .poll(async () => widgets.count(), {
      timeout: 45_000,
      message: 'only the ungated widgets rendered — instance-scope metrics came back empty',
    })
    .toBeGreaterThan(3);

  expect(pageErrors).toEqual([]);
});

test('the endpoint tab renders a dashboard for a real endpoint', async ({ page, pageErrors }) => {

  await page.goto(`/layer/${LAYER}/endpoint`);

  const widgets = page.locator('.widget');
  await expect(widgets.first()).toBeVisible({ timeout: 45_000 });
  // The tab opens on whichever endpoint OAP lists first, which can be one
  // known only from logs; a dashboard for a REAL endpoint needs one the
  // fixture drives.
  await selectEndpoint(page, DEMO_ENDPOINT_PATTERN);
  // A render check only, deliberately. The chart element appears even for an
  // all-null series, so it proves the widget dispatched, not that data arrived
  // — and the count trick used on the instance tab does not transfer: this
  // scope declares 5 widgets with a single gated one ("MQ Avg Consuming
  // Latency"), which the demo app correctly never reports. Proving endpoint
  // data would need a readiness check on an endpoint metric, not a stricter
  // assertion here.
  await expect(page.locator('.widget .time-chart').first()).toBeVisible({ timeout: 45_000 });

  expect(pageErrors).toEqual([]);
});

test('the API dependency tab mounts and resolves an endpoint', async ({ page, pageErrors }) => {

  await page.goto(`/layer/${LAYER}/dependency`);
  await expect(page.locator('#app')).toBeVisible();
  // An endpoint being SELECTED here proves the endpoint scope resolved; the
  // dependency graph itself needs a second endpoint to be interesting, which
  // this fixture does not produce. Which endpoint follows OAP's listing, and
  // that includes endpoints known only from logs or cross-thread spans, so the
  // check is that one is picked, not which. `.ep-row.on` is this view's picked
  // row — the list renders before anything is picked.
  await expect(page.locator('.ep-row.on .ep-pick')).not.toBeEmpty({ timeout: 45_000 });

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

  // The timeline above the list is its own ECharts renderer over the same
  // alarms. It can draw nothing while the rows below are perfect, and an
  // operator reads it first — it is how a burst is told from a trickle.
  // Asserting the CANVAS rather than the host: `.alarms-timeline` is an
  // unconditional container and is present even if the chart never mounted.
  await expect(page.locator('.alarms-timeline canvas').first()).toBeVisible({
    timeout: 45_000,
  });

  expect(pageErrors).toEqual([]);
});
