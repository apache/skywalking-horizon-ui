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

import type { Page } from '@playwright/test';
import { test, expect } from '../support/diagnostics.js';
import { LAYER } from '../fixture.js';

// What a trace opens INTO. Five components hang off one click and none of
// them were asserted: the popouts spec proved the detail pane appears, which
// says nothing about whether the waterfall drew a single bar.
//
// Each view is a distinct renderer over the same spans — a waterfall, a d3
// tree, a per-span-name roll-up — so one being right implies nothing about
// the others. The span modal is a sixth, reached from inside the waterfall.

async function openFirstTrace(page: Page) {
  await page.goto(`/layer/${LAYER}/trace`);
  await page.locator('button.tr-run-btn').click();

  const rows = page.locator('.tr-rowlist .tr-row-card');
  await expect(rows.first()).toBeVisible({ timeout: 45_000 });
  await rows.first().click();

  const detail = page.locator('.tr-detail');
  await expect(detail).toBeVisible({ timeout: 45_000 });
  return detail;
}

test('the duration scatter renders over the trace results', async ({ page, pageErrors }) => {
  await page.goto(`/layer/${LAYER}/trace`);
  await page.locator('button.tr-run-btn').click();
  await expect(page.locator('.tr-rowlist .tr-row-card').first()).toBeVisible({ timeout: 45_000 });

  // The scatter is drawn from the SAME result set as the list, but by its own
  // SVG renderer — an empty plot beside a populated list is a real defect and
  // looks like nothing at all on screen.
  const scatter = page.locator('.scatter-wrap');
  await expect(scatter).toBeVisible({ timeout: 45_000 });
  await expect(scatter.locator('.scatter-dot').first()).toBeVisible({ timeout: 45_000 });

  expect(pageErrors, 'an uncaught error during mount blanks the page').toEqual([]);
});

test('a trace opens to a waterfall of its spans', async ({ page, pageErrors }) => {
  const detail = await openFirstTrace(page);

  // Default view. Rows carry a service stripe, which is what makes a
  // multi-service trace readable — and is drawn per span, so it also proves
  // spans arrived rather than an empty shell.
  await expect(detail.locator('.tr-default-list')).toBeVisible({ timeout: 45_000 });
  await expect(detail.locator('.tr-default-row').first()).toBeVisible();
  await expect(detail.locator('.svc-stripe').first()).toBeVisible();

  expect(pageErrors).toEqual([]);
});

test('the tree and statistics views render the same trace', async ({ page, pageErrors }) => {
  const detail = await openFirstTrace(page);

  // d3 owns this canvas, and a d3 view that throws leaves the previous one on
  // screen — so assert the canvas itself, not merely that the button toggled.
  await detail.getByRole('button', { name: 'Tree' }).click();
  await expect(detail.locator('.tr-tree-canvas')).toBeVisible({ timeout: 45_000 });

  // The roll-up is a table keyed by span name, a different shape again.
  await detail.getByRole('button', { name: 'Statistics' }).click();
  await expect(detail.locator('.tr-table')).toBeVisible({ timeout: 45_000 });

  expect(pageErrors).toEqual([]);
});

test('a span opens its detail modal', async ({ page, pageErrors }) => {
  const detail = await openFirstTrace(page);

  await expect(detail.locator('.tr-default-row').first()).toBeVisible({ timeout: 45_000 });
  await detail.locator('.tr-default-row').first().click();

  // The modal is where tags, logs and timings live — the deepest point of the
  // trace drill-down, and the last thing in the chain nothing asserted.
  const modal = page.locator('.span-modal');
  await expect(modal).toBeVisible({ timeout: 45_000 });
  await expect(modal.locator('.span-modal-head')).toBeVisible();

  // Dismissing returns to the waterfall rather than unmounting the detail.
  await page.locator('.span-modal-backdrop').click({ position: { x: 5, y: 5 } });
  await expect(modal).toHaveCount(0);
  await expect(detail.locator('.tr-default-list')).toBeVisible();

  expect(pageErrors).toEqual([]);
});
