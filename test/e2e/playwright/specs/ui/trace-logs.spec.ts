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
import { PROVIDER_SERVICE, LAYER } from '../fixture.js';
import { selectService } from '../support/layer.js';

// Trace -> logs, on the native store. The provider's `/logs/trigger` writes a
// log4j2 line and a logback line inside its own entry span, reported with the
// trace id, segment id and span id. A whole-trace read and a one-span read
// (segment id + numeric span id) are checked for the read Horizon sends and
// that the box renders the answer as a list; the last test checks that both
// lines come back.
//
// The way in is the operator's: a log row's trace chip, then back out to the
// trace's logs. The log row is also where the spec learns which trace to open.

/** The two lines `/logs/trigger` writes; on the Logs tab, the first leads to
 *  that request's trace. */
const LINES = ['log4j2 message', 'logback message'];
const TRIGGER_LINE = LINES[0]!;

/** Open the trace a `/logs/trigger` log line belongs to, from the Logs tab. */
async function openTriggerTrace(page: Page): Promise<string> {
  await page.goto(`/layer/${LAYER}/logs`);
  await selectService(page, PROVIDER_SERVICE);
  await page.locator('button.lg-run-btn').click();
  const row = page.locator('.lg-stream .lg-row', { hasText: TRIGGER_LINE }).filter({ has: page.locator('.lg-trace') });
  await expect(row.first(), 'no /logs/trigger line carried a trace id').toBeVisible({ timeout: 45_000 });
  await row.first().locator('.lg-trace').click();
  await expect(page.locator('.tp-card .tp-row').first()).toBeVisible({ timeout: 45_000 });
  return new URL(page.url()).searchParams.get('traceId') ?? '';
}

/** Counts the trace-log reads the page sends. */
function traceLogReads(page: Page): () => number {
  let n = 0;
  page.on('request', (r) => { if (/\/api\/trace\/[^/]+\/logs\b/.test(new URL(r.url()).pathname)) n++; });
  return () => n;
}

/** The logs box over the trace, once its read has finished. */
async function logsBox(page: Page): Promise<Locator> {
  const box = page.locator('[role="dialog"]').filter({ has: page.locator('.trl') });
  await expect(box).toBeVisible({ timeout: 45_000 });
  await expect(box.locator('.trl-empty', { hasText: 'Reading logs' })).toHaveCount(0, { timeout: 45_000 });
  return box;
}

/** The next trace-log read the page sends. Wire check, because the screen does
 *  not show the trace id or the span a box was read by. */
function nextLogRead(page: Page): Promise<URL> {
  return page
    .waitForRequest((r) => /\/api\/trace\/[^/]+\/logs\b/.test(new URL(r.url()).pathname), { timeout: 45_000 })
    .then((r) => new URL(r.url()));
}

/** The read finished and the box rendered its answer as a list — rows, or the
 *  state saying none carry the id — not an error. */
async function expectAList(box: Locator): Promise<void> {
  await expect(box.locator('.trl-empty.err')).toHaveCount(0);
  await expect(box.locator('.lg-row').first().or(box.locator('.trl-empty', { hasText: 'No logs carry this' }))).toBeVisible();
  // Every line here is this trace's; a chip pointing back at it is noise.
  await expect(box.locator('.lg-trace')).toHaveCount(0);
}

/** A whole-trace read: this trace's id, and no span scope. */
function expectTraceRead(url: URL, traceId: string): void {
  expect(decodeURIComponent(url.pathname)).toBe(`/api/trace/${traceId}/logs`);
  expect(url.searchParams.get('segmentId')).toBeNull();
  expect(url.searchParams.get('spanId')).toBeNull();
  expect(Number(url.searchParams.get('startMs'))).toBeGreaterThan(0);
}

/** A native span's read: this trace's id, with its segment id and span id. */
function expectNativeSpanRead(url: URL, traceId: string): void {
  expect(decodeURIComponent(url.pathname)).toBe(`/api/trace/${traceId}/logs`);
  expect(url.searchParams.get('segmentId')).toBeTruthy();
  expect(url.searchParams.get('spanId')).toMatch(/^\d+$/);
  expect(url.searchParams.get('otlpSpanId')).toBeNull();
}

test('the trace popout opens its logs in a box, and one span\'s', async ({ page, pageErrors }) => {
  const reads = traceLogReads(page);
  const traceId = await openTriggerTrace(page);
  const popout = page.locator('.tp-card');

  // Wire check, because the screen cannot show it: opening a trace must not
  // cost a log read — it waits for the operator to ask.
  expect(reads(), 'a trace read its logs before anyone asked').toBe(0);

  let read = nextLogRead(page);
  await popout.getByRole('button', { name: 'Logs', exact: true }).click();
  expectTraceRead(await read, traceId);
  const box = await logsBox(page);
  await expectAList(box);
  await expect(box.locator('.trl-window')).toContainText('searched');
  // One Escape closes the box, not the trace under it.
  await page.keyboard.press('Escape');
  await expect(box).toBeHidden();
  await expect(popout).toBeVisible();

  // One span: the entry span of `/logs/trigger`, which wrote both lines. This
  // read carries the segment id and the span id, and returns only what that
  // span wrote.
  await popout.locator('.tp-row', { hasText: '/logs/trigger' }).first().click();
  read = nextLogRead(page);
  await popout.locator('.tp-span-panel').getByRole('button', { name: 'Related logs' }).click();
  expectNativeSpanRead(await read, traceId);
  const spanBox = await logsBox(page);
  await expect(spanBox.locator('.trl-scope')).toContainText('segment');
  await expectAList(spanBox);

  expect(pageErrors).toEqual([]);
});

test('the in-page trace detail opens its logs in a box, and the span dialog one span\'s', async ({ page, pageErrors }) => {
  const traceId = await openTriggerTrace(page);
  expect(traceId).toBeTruthy();

  await page.goto(`/layer/${LAYER}/trace`);
  await page.locator('.tr-toolbar-head .seg button', { hasText: 'Trace ID' }).click();
  await page.locator('.tr-conditions input[placeholder="paste trace id…"]').fill(traceId);
  await page.locator('button.tr-run-btn').click();
  await page.locator('.tr-rowlist .tr-row-card').first().click({ timeout: 45_000 });
  const detail = page.locator('.tr-detail');
  await expect(detail).toBeVisible({ timeout: 45_000 });

  let read = nextLogRead(page);
  await detail.getByRole('button', { name: 'Logs', exact: true }).click();
  expectTraceRead(await read, traceId);
  await expectAList(await logsBox(page));
  await page.keyboard.press('Escape');

  await detail.locator('.tr-default-row', { hasText: '/logs/trigger' }).first().click();
  const modal = page.locator('.span-modal');
  read = nextLogRead(page);
  await modal.getByRole('button', { name: 'Related logs' }).click();
  expectNativeSpanRead(await read, traceId);
  const spanBox = await logsBox(page);
  await expectAList(spanBox);
  await page.keyboard.press('Escape');
  await expect(spanBox).toBeHidden();
  await expect(modal).toBeVisible();

  expect(pageErrors).toEqual([]);
});

test('the trace\'s logs, and its span\'s, list the two lines /logs/trigger wrote', async ({ page, pageErrors }) => {
  await openTriggerTrace(page);
  const popout = page.locator('.tp-card');
  await popout.getByRole('button', { name: 'Logs', exact: true }).click();
  const box = await logsBox(page);
  for (const line of LINES) await expect(box.locator('.lg-row', { hasText: line }).first(), line).toBeVisible();
  await page.keyboard.press('Escape');
  await popout.locator('.tp-row', { hasText: '/logs/trigger' }).first().click();
  await popout.locator('.tp-span-panel').getByRole('button', { name: 'Related logs' }).click();
  const spanBox = await logsBox(page);
  for (const line of LINES) await expect(spanBox.locator('.lg-row', { hasText: line }).first(), line).toBeVisible();
  expect(pageErrors).toEqual([]);
});
