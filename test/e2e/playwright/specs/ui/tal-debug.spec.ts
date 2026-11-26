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

import type { Locator, Page } from '@playwright/test';
import { test, expect } from '../support/diagnostics.js';

// The TAL debugger RUNS on both of OAP's trace inputs.
//
// Native: the demo services' agents report segments, which OAP's shipped
// `native-segment` rule runs on span by span. The operator's path in is the
// TAL rules page: pick the file, hit the ▶ on the rule's line, which
// deep-links into the debugger with both pickers filled.
//
// OTLP: the case's span emitter sends one trace a second across two
// OTLP_GENERAL services, so OAP's shipped `otlp-general` rule runs on each
// span, and the CLIENT span's run sends the caller half of a network alias.
//
// The point of the TAL view is that each step of a run sits on its line of the
// rule FILE, so a record that rendered with its steps on the wrong lines would
// be as broken as one that never rendered. Both tests select one span and read
// back the output its run sent ON THE STATEMENT THAT SENT IT: the native span's
// `source Segment`, the OTLP CLIENT call's caller half on `prepareNetworkAlias`.
// A step one line off would put the value on a neighbour, and fail. The lines
// are found by their text, so upstream edits to the rule files move nothing.
//
// Starting a session mutates OAP — the same scoped write the other debugger
// specs make.

/** The file line a pane line is, from the number the pane renders. */
async function lineNumber(line: Locator): Promise<number> {
  return Number((await line.locator('.tsp__num').textContent())?.trim());
}

async function start(page: Page): Promise<void> {
  const start = page.getByRole('button', { name: 'start sampling' });
  await expect(start, 'sampling stayed disabled with a file and rule picked').toBeEnabled({ timeout: 45_000 });
  await start.click();
  await expect(page.getByRole('button', { name: 'stop', exact: true })).toBeEnabled({ timeout: 45_000 });
}

test('the TAL rules page debugs a native rule, its steps on the rule’s own file lines', async ({
  page,
  pageErrors,
}) => {
  test.setTimeout(300_000);
  await page.goto('/operate/tal');

  const file = page.locator('button.tal__file', { hasText: 'native-segment' });
  await expect(file).toBeVisible({ timeout: 60_000 });
  await file.click();
  // The ▶ sits on the line that declares the rule; finding it by that text
  // keeps the test off upstream's line numbers, which move with every edit.
  const ruleLine = page.locator('.tal__line', { hasText: /- name: native-segment\s*$/ });
  await expect(ruleLine, 'native-segment.yaml no longer declares native-segment').toHaveCount(1);
  await ruleLine.locator('button.tal__dbg').click();

  await expect(page).toHaveURL(/\/operate\/live-debug\/tal\?/);
  const [filePicker, rulePicker] = [page.locator('select.ctl__select').first(), page.locator('select.ctl__select').nth(1)];
  await expect(filePicker).toHaveValue('native-segment', { timeout: 45_000 });
  await expect(rulePicker).toHaveValue('native-segment');
  await start(page);

  // A segment record lists its spans in wire order. native-segment queues the
  // Segment source from the run on the segment's FIRST span, so that span's
  // run carries it, and no other's. A segment of two spans or more is picked,
  // and another of its spans selected first, so it is the click on the first
  // span that puts that span's run on screen.
  await expect(page.locator('.tal__badge')).toHaveText('native · segment → spans', { timeout: 240_000 });
  const records = page.locator('.tfl__rec', { has: page.locator('button.tfl__frame--nested') });
  await expect(records.first(), 'no segment was captured').toBeVisible({ timeout: 240_000 });
  let spans = records.first().locator('button.tfl__frame--nested');
  await expect
    .poll(async () => {
      for (const rec of await records.all()) {
        const each = rec.locator('button.tfl__frame--nested');
        if ((await each.count()) > 1) {
          spans = each;
          return true;
        }
      }
      return false;
    }, { timeout: 240_000, message: 'no captured segment has two spans' })
    .toBe(true);
  await spans.nth(1).click();
  await expect(spans.nth(1)).toHaveClass(/tfl__frame--selected/);
  // The other span's run sent no Segment source: its pane shows none.
  await expect(page.locator('.tsp__line.tsp__line--ran', { hasText: /source Segment \{/ })).toHaveCount(0);
  const sender = spans.first();
  await sender.click();
  await expect(sender).toHaveClass(/tfl__frame--selected/);

  // The pane shows the rule's file, the source on the statement that sent it.
  await expect(page.locator('.tsp__file')).toContainText('native-segment');
  const sourceLine = page.locator('.tsp__line.tsp__line--ran', { hasText: /source Segment \{/ });
  await expect(sourceLine, 'the run’s Segment source is not on its statement').toHaveCount(1, { timeout: 45_000 });
  await expect(sourceLine.locator('.tsp__inline')).toHaveText(/^→ source Segment/);

  // And every line the run reached is inside the rule, after the line naming it.
  const nameLine = page.locator('.tsp__line', { hasText: /- name: native-segment\s*$/ });
  await expect(nameLine).toHaveCount(1);
  const ruleStart = await lineNumber(nameLine);
  const ranLines = page.locator('.tsp__line.tsp__line--ran');
  await expect.poll(async () => ranLines.count(), { timeout: 45_000 }).toBeGreaterThan(0);
  for (const line of await ranLines.all()) {
    expect(await lineNumber(line), 'a step sits above the rule it ran in').toBeGreaterThan(ruleStart);
  }

  expect(pageErrors).toEqual([]);
});

test('the TAL debugger runs the OTLP rule on the emitter’s spans and shows the pairing it sent', async ({
  page,
  pageErrors,
}) => {
  test.setTimeout(300_000);
  await page.goto('/operate/live-debug/tal');

  const file = page.locator('select.ctl__select').first();
  await expect(file.locator('option', { hasText: /^otlp-general$/ })).toBeAttached({ timeout: 60_000 });
  await file.selectOption({ label: 'otlp-general' });
  await page.locator('select.ctl__select').nth(1).selectOption({ label: 'otlp-general' });
  await start(page);

  await expect(page.locator('.tal__badge')).toHaveText('OTLP · span by span', { timeout: 240_000 });
  await expect(page.locator('.tal__chip', { hasText: /^pairing \d+$/ })).toBeVisible({ timeout: 240_000 });

  // The frontend's CLIENT call to the backend: its run sends the caller half,
  // which the root SERVER span (a callee half, not sent) cannot stand in for.
  const call = page.locator('button.tfl__frame:not([disabled])', { hasText: /client GET.*e2e-pairing-frontend/ }).first();
  await expect(call, 'no CLIENT span of the emitter’s frontend was captured').toBeVisible({ timeout: 60_000 });
  await call.click();
  await expect(call).toHaveClass(/tfl__frame--selected/);
  const prepare = page.locator('.tsp__line.tsp__line--ran', { hasText: /prepareNetworkAlias/ });
  await expect(prepare, 'the call’s caller half is not on its statement').toHaveCount(1, { timeout: 45_000 });
  await expect(prepare.locator('.tsp__inline')).toHaveText('→ pairing caller sent');

  expect(pageErrors).toEqual([]);
});
