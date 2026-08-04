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
