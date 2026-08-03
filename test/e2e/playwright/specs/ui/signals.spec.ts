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

import { test, expect } from '@playwright/test';
import { LAYER } from '../fixture.js';

// The rendered half of the signals asserted on the wire in bff/signals.spec.ts.
// Both halves matter: the BFF returning a correct topology graph proves
// nothing about whether the operator can see it.

test('the topology tab draws the demo call graph', async ({ page }) => {
  const crashes: string[] = [];
  page.on('pageerror', (e) => crashes.push(e.message));

  await page.goto(`/layer/${LAYER}/topology`);

  // Nodes are real DOM elements carrying data-node-id, not painted into an
  // HTML canvas, so they can be addressed directly.
  const nodes = page.locator('.sm-node[data-node-id]');
  await expect(nodes.first()).toBeVisible({ timeout: 45_000 });

  // The demo app is consumer -> provider plus the synthetic User node, so a
  // correctly drawn graph has several nodes and at least one edge. Asserting
  // the edge matters: nodes render even when no call between them exists,
  // which is the break a service map is meant to reveal.
  expect(await nodes.count()).toBeGreaterThan(1);
  await expect(page.locator('.sm-edge').first()).toBeVisible();

  expect(crashes, 'an uncaught error during mount blanks the page').toEqual([]);
});

test('the logs tab returns log lines from the demo app', async ({ page }) => {
  const crashes: string[] = [];
  page.on('pageerror', (e) => crashes.push(e.message));

  await page.goto(`/layer/${LAYER}/logs`);

  // Same trailing-control contract as traces: the tab owns its own time range
  // and waits for an explicit Run query rather than firing on navigation.
  const run = page.locator('button.lg-run-btn');
  await expect(run).toBeEnabled();
  await run.click();

  const rows = page.locator('.lg-stream .lg-row');
  await expect(rows.first()).toBeVisible({ timeout: 45_000 });
  // Content, not just a row: an empty stream still renders its container.
  await expect(rows.first().locator('.lg-content')).not.toBeEmpty();

  expect(crashes).toEqual([]);
});
