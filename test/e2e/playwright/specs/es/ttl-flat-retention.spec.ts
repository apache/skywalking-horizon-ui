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

// Retention is the one page whose SHAPE is decided by the storage backend, so
// it can only be checked where the backend is not BanyanDB.
//
// The per-class cards stay here — an operator asks how long traces are kept,
// not which config key governs them. What must NOT appear is the stage
// vocabulary: BanyanDB is the only storage plugin implementing OAP's TTL query,
// so hot / warm / cold, the lifecycle bar and the cold pane all describe a
// model this wire response never carried. The note naming the two settings is
// what keeps nine identical figures from reading as nine independent knobs.
test('Retention lists the classes an operator asks about, without the stage model', async ({ page }) => {
  await page.goto('/operate/ttl');
  await expect(page.getByRole('heading', { name: 'Time To Live' })).toBeVisible();

  const cards = page.locator('.sub-pane .sw-card.kpi');
  await expect(cards.first()).toBeVisible();

  // The catalogue an operator reads the page for, in retention order, and NOT
  // the wire's shape: no Records / Metrics split, no Minute / Hour / Day trio
  // that cannot differ here, and `records` named for its contents rather than
  // for the wire field.
  const labels = await page.locator('.sub-pane .sw-card.kpi h4').allInnerTexts();
  expect(labels.map((l) => l.trim())).toEqual(['Metadata', 'Metrics', 'Logs', 'Traces', 'Others']);

  // Real day counts, not the em-dash placeholder.
  await expect(page.locator('.sub-pane .kpi-value').first()).not.toHaveText('—');

  // Each card names the setting that governs it, and the split is the one the
  // backend actually has: the two metric classes come from `core.metricsDataTTL`
  // and the three record classes from `core.recordDataTTL`. Asserting the COUNT
  // rather than mere presence is what would catch a card wired to the wrong one.
  const sources = (await page.locator('.sub-pane .kpi-source').allInnerTexts()).map((s) => s.trim());
  expect(sources.filter((s) => s.endsWith('core.metricsDataTTL'))).toHaveLength(2);
  expect(sources.filter((s) => s.endsWith('core.recordDataTTL'))).toHaveLength(3);

  // Stage vocabulary belongs to BanyanDB alone: no lifecycle bar, no cold pane.
  await expect(page.locator('.lc-row')).toHaveCount(0);
  await expect(page.getByText('Hot + Warm')).toHaveCount(0);
});
