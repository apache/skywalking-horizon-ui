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

import type { Locator } from '@playwright/test';
import { test, expect } from '../support/diagnostics.js';
import { LAYER } from '../fixture.js';

// Layout failures the content assertions are blind to: a collapsed widget
// grid, a chart drawn zero pixels tall, a panel that overflows its container.
// All of them satisfy toBeVisible(), which only asks for a non-empty box.
//
// Geometry, deliberately — NOT screenshot comparison. These pages are full of
// live values, so a pixel baseline would differ every run and get re-based
// until nobody read it. Measuring boxes says the same thing about layout and
// says it identically on every platform. Screenshots stay what they should
// be: evidence attached to a failure.

test('the dashboard widget grid tiles rather than collapsing', async ({ page, pageErrors }) => {
  await page.goto(`/layer/${LAYER}/service`);

  // `.widget`, not `.sw-card`: the service picker is also a card, so a
  // first-visible wait on the broader selector is satisfied before a single
  // widget has rendered, and the count then reads 1.
  const widgets = page.locator('.widget');
  // Waiting on the 5th settles the grid — the count is read after the
  // template has laid out, not mid-render.
  await expect(widgets.nth(4)).toBeVisible({ timeout: 45_000 });

  const count = await widgets.count();
  const boxes: NonNullable<Awaited<ReturnType<Locator['boundingBox']>>>[] = [];
  for (let i = 0; i < count; i += 1) {
    const box = await widgets.nth(i).boundingBox();
    expect(box, `widget ${i} has no box`).not.toBeNull();
    // A zero-height card is the classic symptom of a chart that failed to
    // size itself; on screen it reads as "no data".
    expect(box!.height, `widget ${i} collapsed to ${box!.height}px tall`).toBeGreaterThan(40);
    expect(box!.width, `widget ${i} collapsed to ${box!.width}px wide`).toBeGreaterThan(80);
    boxes.push(box!);
  }

  const topRow = boxes.filter((b) => Math.abs(b.y - boxes[0].y) < 8);
  expect(topRow.length, 'widgets stacked vertically instead of tiling').toBeGreaterThan(1);

  // Destructured deliberately: the diagnostics fixture is lazy, so a file that
  // imports this `test` without asking for `pageErrors` attaches no recorders
  // at all and collects nothing.
  expect(pageErrors, 'an uncaught error during mount blanks the page').toEqual([]);
});

// Each path names the element that proves the page has CONTENT to overflow
// with. An empty shell never overflows, so measuring before the content
// arrives reports 0 and passes for the wrong reason — which is what a fixed
// sleep bought here.
const RENDERED: [string, string][] = [
  [`/layer/${LAYER}/service`, '.widget'],
  [`/layer/${LAYER}/topology`, '.sm-node'],
  // `/` is the landing cascade, which resolves to whichever dashboard is
  // available — an overview on this fixture, a layer dashboard elsewhere.
  ['/', '.sw-card.tile, .widget'],
];

test('no page scrolls sideways', async ({ page, pageErrors }) => {
  for (const [path, ready] of RENDERED) {
    await page.goto(path);
    await expect(page.locator(ready).first()).toBeVisible({ timeout: 45_000 });

    // Horizontal overflow means something refuses to shrink — a table with a
    // minimum width, or a chart sized in absolute pixels.
    //
    // Polled rather than measured once: a chart is briefly wider than its
    // container between mount and the first resize, and that transient is not
    // the defect. What matters is where it SETTLES, so a run that never
    // settles fails on the last value read.
    await expect
      .poll(
        async () =>
          page.evaluate(
            () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
          ),
        { timeout: 30_000, message: `${path} still overflows horizontally` },
      )
      .toBeLessThanOrEqual(1);
  }

  expect(pageErrors, 'an uncaught error during mount blanks the page').toEqual([]);
});
