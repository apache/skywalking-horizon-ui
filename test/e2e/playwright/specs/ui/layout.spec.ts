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

import { test, expect, type Locator } from '@playwright/test';
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

test('the dashboard widget grid tiles rather than collapsing', async ({ page }) => {
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
});

test('no page scrolls sideways', async ({ page }) => {
  for (const path of [`/layer/${LAYER}/service`, `/layer/${LAYER}/topology`, '/']) {
    await page.goto(path);
    await page.waitForTimeout(2500);
    // Horizontal overflow means something refuses to shrink — a table with a
    // minimum width, or a chart sized in absolute pixels.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `${path} overflows horizontally by ${overflow}px`).toBeLessThanOrEqual(1);
  }
});
