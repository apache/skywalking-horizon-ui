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
 * What a refresh is allowed to disturb on a graph, and what it is not.
 *
 * These are timing assertions, and timing is why they belong in a browser: the
 * failure they exist to catch is a canvas that empties for a second or two on
 * every tick, which every "does the page render" check passes straight over
 * because it looks at the settled state. So each one holds the request open and
 * asserts DURING the round.
 *
 * The identity of the SVG element is the assertion, not its contents. A canvas
 * that unmounts and remounts with the same nodes has still thrown away the
 * operator's pan, zoom and node placements — and comparing rendered output
 * would not notice.
 */

import { test, expect } from '../support/diagnostics.js';
import { LAYER } from '../fixture.js';

const READY = 40_000;

/**
 * Click Refresh, once it will actually accept a click.
 *
 * The control is disabled while a round is out, so a bare click races whatever
 * the page happened to be doing — and a click that lands on a disabled button
 * does nothing, which shows up later as an assertion about a round that never
 * started.
 */
async function clickRefresh(page: import('@playwright/test').Page): Promise<void> {
  await expect(page.locator('.refresh-now')).toBeEnabled({ timeout: 40_000 });
  await page.locator('.refresh-now').click();
}

/** Hold every graph read open until the returned function is called. */
async function holdGraphReads(page: import('@playwright/test').Page): Promise<() => void> {
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  await page.route('**/api/layer/**', async (route) => {
    await held;
    await route.continue();
  });
  return release;
}

test('the topology canvas survives a refresh instead of blanking', async ({ page, pageErrors }) => {
  await page.goto(`/layer/${LAYER}/topology`);
  const nodes = page.locator('g[data-node-id]');
  await expect(nodes.first()).toBeVisible({ timeout: READY });
  const before = await nodes.count();
  expect(before, 'no nodes to begin with — the rest would prove nothing').toBeGreaterThan(0);

  // The ELEMENT, captured now. If the canvas remounts this handle goes stale,
  // which is exactly the failure being tested — a redraw that looks identical
  // but has discarded everything the operator arranged.
  const svgHandle = await page.locator('g.zoom-layer').elementHandle();
  const framing = await page.locator('g.zoom-layer').getAttribute('transform');
  expect(framing, 'no transform at rest — the preservation check would be vacuous').toBeTruthy();

  const release = await holdGraphReads(page);
  await clickRefresh(page);
  await expect(page.locator('.refresh-now.fetching')).toBeVisible({ timeout: 10_000 });

  // MID-FLIGHT. Asserting only after the round settles would pass against a
  // canvas that emptied and came back.
  await expect(nodes).toHaveCount(before);
  await expect(page.locator('g.zoom-layer')).toHaveAttribute('transform', framing!);
  expect(
    await svgHandle?.evaluate((el) => el.isConnected),
    'the canvas was remounted during the refresh',
  ).toBe(true);

  release();
  await expect(page.locator('.refresh-now.fetching')).toBeHidden({ timeout: 25_000 });

  // AND after settlement: the BFF turns an OAP failure into a 200 with an empty
  // body, so the replacement that would erase the graph happens when the round
  // RESOLVES, not while it is out.
  await expect(nodes.first()).toBeVisible();
  expect(
    await svgHandle?.evaluate((el) => el.isConnected),
    'the canvas was remounted once the refresh landed',
  ).toBe(true);
  expect(pageErrors, `page errors: ${pageErrors.join(' | ')}`).toHaveLength(0);
});

test('a dragged node stays where the operator put it across a refresh', async ({ page }) => {
  await page.goto(`/layer/${LAYER}/topology`);
  const node = page.locator('g[data-node-id]').first();
  await expect(node).toBeVisible({ timeout: READY });

  const box = (await node.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 140, box.y + box.height / 2 + 80, { steps: 10 });
  await page.mouse.up();

  const dropped = (await node.boundingBox())!;
  expect(
    Math.abs(dropped.x - box.x),
    'the drag did not move the node — the rest of this test would be vacuous',
  ).toBeGreaterThan(60);

  await clickRefresh(page);
  await expect(page.locator('.refresh-now.fetching')).toBeHidden({ timeout: 25_000 });

  const after = (await node.boundingBox())!;
  expect(Math.abs(after.x - dropped.x), 'the node snapped back horizontally').toBeLessThanOrEqual(2);
  expect(Math.abs(after.y - dropped.y), 'the node snapped back vertically').toBeLessThanOrEqual(2);
});

test('the canvas DOES reset when the question changes', async ({ page }) => {
  // The other side of the rule. Keeping a graph across a refresh must not turn
  // into keeping one across a genuine predicate change, where the previous
  // layer's picture under a new heading is worse than an honest empty state.
  //
  // Driven through the CONTROLS an operator uses, not a URL. Navigating to
  // `?depth=3` remounts the whole page, which resets a canvas whatever the
  // refresh logic does — so it passed on a build where changing depth in place
  // left the old graph and the old framing sitting there.
  await page.goto(`/layer/${LAYER}/topology`);
  await expect(page.locator('g[data-node-id]').first()).toBeVisible({ timeout: READY });

  // Focus one service: the depth control only exists once a seed is picked.
  await page.locator('.focus-btn').click();
  const firstService = page.locator('.focus-row:not(.clear)').first();
  await expect(firstService).toBeVisible({ timeout: 10_000 });
  await firstService.click();
  await page.locator('.focus-btn').click();
  const depth = page.locator('.depth-pick select');
  await expect(depth, 'no depth control — the picker click did not take').toBeVisible({
    timeout: 10_000,
  });
  await expect(page.locator('g[data-node-id]').first()).toBeVisible({ timeout: READY });

  // Frame it somewhere of the operator's own, so "was it re-fitted?" is a real
  // question rather than a comparison of two identical fits.
  const svg = page.locator('.sm-graph svg').first();
  const box = (await svg.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -400);
  const framed = await page.locator('g.zoom-layer').getAttribute('transform');
  expect(framed, 'the zoom did not move the framing — the assertion would be vacuous').toBeTruthy();

  await depth.selectOption('3');

  // A different depth is a different question, so the canvas is re-fitted
  // rather than left at the framing that belonged to the old one.
  await expect
    .poll(async () => page.locator('g.zoom-layer').getAttribute('transform'), { timeout: 20_000 })
    .not.toBe(framed);
});

test('the whole page refreshes as ONE round, and the countdown waits for it', async ({ page }) => {
  // The defect this exists to catch does not show up in any single widget: each
  // one refreshes correctly, on its own clock, and the page redraws in waves
  // while the countdown describes something that finished long ago.
  await page.goto(`/layer/${LAYER}/topology`);
  await expect(page.locator('g[data-node-id]').first()).toBeVisible({ timeout: READY });

  const release = await holdGraphReads(page);
  await clickRefresh(page);
  await expect(page.locator('.refresh-now.fetching')).toBeVisible({ timeout: 10_000 });

  // While the round is out the manual control refuses, rather than looking
  // like a button that does nothing.
  await expect(page.locator('.refresh-now')).toBeDisabled();
  await expect(page.locator('.refresh-now')).toHaveAttribute('aria-busy', 'true');

  // And the countdown does not name a deadline that cannot arrive: the next
  // round starts when THIS one ends, an instant that does not exist yet.
  await expect(page.locator('.refresh-countdown')).toHaveText(/refreshing/i);

  release();
  await expect(page.locator('.refresh-now.fetching')).toBeHidden({ timeout: 25_000 });
  await expect(page.locator('.refresh-now')).toBeEnabled();
});

test('a failed refresh is reported without erasing the graph', async ({ page }) => {
  // Two halves of one rule, and each is worthless alone: a page that keeps its
  // graph but says nothing is lying by omission, and one that reports the
  // failure but blanks the canvas has thrown away the last thing the operator
  // could read.
  await page.goto(`/layer/${LAYER}/topology`);
  const nodes = page.locator('g[data-node-id]');
  await expect(nodes.first()).toBeVisible({ timeout: READY });
  const before = await nodes.count();
  expect(before, 'no graph to lose — the test would prove nothing').toBeGreaterThan(0);

  // Exactly how a real OAP outage reaches the page: the BFF does not throw, it
  // answers 200 with an empty body and `reachable: false`.
  await page.route('**/api/layer/*/topology*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        layer: 'unused',
        service: null,
        depth: 1,
        generatedAt: Date.now(),
        config: { nodeMetrics: [], linkServerMetrics: [], linkClientMetrics: [] },
        nodes: [],
        calls: [],
        reachable: false,
      }),
    });
  });
  await clickRefresh(page);
  await expect(page.locator('.refresh-now.fetching')).toBeHidden({ timeout: 25_000 });

  await expect(nodes, 'a failed round replaced the graph with its empty body').toHaveCount(before);

  // The failure waits beside the refresh control rather than interrupting —
  // nobody asked for that round.
  const panel = page.locator('.rerr-btn');
  await expect(panel, 'the failed round was never reported anywhere').toBeVisible({
    timeout: 10_000,
  });
  await expect(page.locator('.rerr-badge')).toBeVisible();
  await panel.click();
  await expect(page.locator('.rerr-panel .err-card').first()).toBeVisible();
  // Read, so the badge clears — but the record itself stays.
  await expect(page.locator('.rerr-badge')).toBeHidden();
  await expect(page.locator('.rerr-panel .err-card')).toHaveCount(1);
});
