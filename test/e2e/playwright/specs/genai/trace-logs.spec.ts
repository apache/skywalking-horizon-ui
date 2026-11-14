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
import { GENAI_LAYER, GENAI_PROVIDER, NATIVE_GENAI_CALLER, OTLP_GENAI_CALLER, ZIPKIN_GENAI_CALLER } from '../fixture.js';

// Trace -> logs on the OTLP and Zipkin stores. Each Python caller logs one line
// per LLM call from inside the LLM span and exports it over OTLP; OAP stores the
// record's own trace id and span id with it (from 11.2.0). A trace's Logs and
// its LLM span's Related logs are checked for what Horizon owns: the read it
// sends — the trace id, and the span's hex id — and that the box renders the
// answer as a list. That the line comes back is checked by the `fixme` tests
// at the end, skipped until BanyanDB stops missing stored lines when filtering
// by trace id (apache/skywalking#14215). A native span is found by segment id
// and numeric span id, on any OAP.


async function openRecordTrace(page: Page, caller: string): Promise<void> {
  await page.goto(`/layer/${GENAI_LAYER}/evaluation-record`);
  await expect(page.locator('.cf-provider .tas__label')).toHaveText(GENAI_PROVIDER, { timeout: 45_000 });
  await page.getByRole('button', { name: /run query/i }).click();
  const rows = page.locator('.lg-stream .lg-row').filter({ has: page.locator('.lg-svc', { hasText: caller }) });
  await expect(rows.first()).toBeVisible({ timeout: 45_000 });
  // An older row: its trace, and the line logged inside it, have long since landed.
  await rows.last().locator('.lg-trace').click();
}

/** The next trace-log read the page sends. Wire check, because the screen does
 *  not show the trace id a box was read by. */
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
}

/** The logs box over the trace, once its read has finished. */
async function logsBox(page: Page): Promise<Locator> {
  const box = page.locator('[role="dialog"]').filter({ has: page.locator('.trl') });
  await expect(box).toBeVisible({ timeout: 45_000 });
  await expect(box.locator('.trl-empty', { hasText: 'Reading logs' })).toHaveCount(0, { timeout: 45_000 });
  return box;
}

test('a native trace\'s span offers its own logs', async ({ page, pageErrors }) => {
  await openRecordTrace(page, NATIVE_GENAI_CALLER);
  const span = page.locator('.tp-card .tp-span-panel');
  await expect(span).toBeVisible({ timeout: 45_000 });
  await expect(span.getByRole('button', { name: 'Related logs' })).toBeEnabled();

  expect(pageErrors).toEqual([]);
});

/** The line each Python caller logs inside its LLM span. */
const LINE = 'calling the LLM';

const STORES = [
  { store: 'OTLP', caller: OTLP_GENAI_CALLER, card: '.tqp-overlay .tqc', span: '.tqw-row', dialog: '.tqm' },
  { store: 'ZIPKIN', caller: ZIPKIN_GENAI_CALLER, card: '.zk-popout', span: '.tp-row', dialog: '.zk-popout .span-modal' },
] as const;

for (const s of STORES) {
  test(`a trace in the ${s.store} store reads the logs carrying its id, and its LLM span reads its own`, async ({ page, pageErrors }) => {
    await openRecordTrace(page, s.caller);
    const card = page.locator(s.card);
    await expect(card.locator(s.span).first()).toBeVisible({ timeout: 45_000 });
    const traceId = new URL(page.url()).searchParams.get('traceId');
    expect(traceId, 'the popout names the trace it opened').toBeTruthy();

    // The record opens its judged span: the LLM call, which wrote the line.
    const dialog = page.locator(s.dialog);
    await expect(dialog).toBeVisible({ timeout: 45_000 });
    const related = dialog.getByRole('button', { name: 'Related logs' });
    await expect(related).toBeEnabled();
    await expect(dialog).not.toContainText('Requires SkyWalking 11.2');
    let read = nextLogRead(page);
    await related.click();
    // The span's own read: this trace's id and the span's hex id, which the
    // box names in its scope line.
    const spanRead = await read;
    expect(decodeURIComponent(spanRead.pathname)).toBe(`/api/trace/${traceId}/logs`);
    const otlpSpanId = spanRead.searchParams.get('otlpSpanId') ?? '';
    expect(otlpSpanId).toMatch(/^[0-9a-f]{16}$/);
    expect(spanRead.searchParams.get('segmentId')).toBeNull();
    const spanBox = await logsBox(page);
    await expect(spanBox.locator('.trl-scope')).toContainText(`Logs of this span`);
    await expect(spanBox.locator('.trl-scope')).toContainText(otlpSpanId);
    await expectAList(spanBox);
    await page.keyboard.press('Escape');
    await expect(spanBox).toBeHidden();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();

    read = nextLogRead(page);
    await card.getByRole('button', { name: 'Logs', exact: true }).click();
    const traceRead = await read;
    expect(decodeURIComponent(traceRead.pathname)).toBe(`/api/trace/${traceId}/logs`);
    expect(traceRead.searchParams.get('otlpSpanId')).toBeNull();
    const box = await logsBox(page);
    await expect(box.locator('.trl-scope')).toContainText('Logs carrying this trace id');
    await expectAList(box);

    expect(pageErrors).toEqual([]);
  });
}

// Skipped, not dropped: BanyanDB can miss a stored line when a log query filters
// by trace id (apache/skywalking#14215), so whether the line comes back is the
// storage's answer for now. Re-enable once BanyanDB is fixed.
for (const s of STORES) {
  test.fixme(`a trace in the ${s.store} store, and its LLM span, list the line that span wrote`, async ({ page, pageErrors }) => {
    await openRecordTrace(page, s.caller);
    const card = page.locator(s.card);
    await expect(card.locator(s.span).first()).toBeVisible({ timeout: 45_000 });
    const traceId = new URL(page.url()).searchParams.get('traceId');
    const dialog = page.locator(s.dialog);
    await expect(dialog).toBeVisible({ timeout: 45_000 });
    await dialog.getByRole('button', { name: 'Related logs' }).click();
    const spanBox = await logsBox(page);
    // The line is this trace's own: it names the id the popout opened.
    await expect(spanBox.locator('.lg-row', { hasText: LINE }).first()).toContainText(`trace_id=${traceId}`);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await card.getByRole('button', { name: 'Logs', exact: true }).click();
    const line = (await logsBox(page)).locator('.lg-row', { hasText: LINE }).first();
    await expect(line).toContainText(`trace_id=${traceId}`);
    await expect(line.locator('.lg-svc')).toContainText(s.caller);
    expect(pageErrors).toEqual([]);
  });
}
