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
import {
  GENAI_LAYER,
  GENAI_MODEL,
  GENAI_PROVIDER,
  GENAI_TASKS,
  NATIVE_GENAI_CALLER,
  OTLP_GENAI_CALLER,
} from '../fixture.js';
import type { Locator, Page } from '@playwright/test';

// The Evaluation records tab, on the one stack where OAP's LLM-as-Judge has
// scored calls from BOTH trace sources. Everything is asserted on screen: the
// provider the tab opens on, the judged rows, and the trace behind a row —
// which is the native waterfall for a SkyWalking-agent trace and the Zipkin
// renderer for an OTLP one. Provider, model, caller and task names are OAP
// data, rendered verbatim in every locale, so they are matched literally.

/** Run the tab's query and hand back the row stream once it has rows. */
async function openRecords(page: Page): Promise<Locator> {
  await page.goto(`/layer/${GENAI_LAYER}/evaluation-record`);

  // The page owns its provider picker and opens on the provider OAP
  // resolved; the picked name is OAP data, so it is matched literally.
  await expect(page.locator('.cf-provider .tas__label')).toHaveText(GENAI_PROVIDER, { timeout: 45_000 });

  // Same trailing-control contract as traces and logs: the query waits for an
  // explicit Run query rather than firing on navigation.
  await page.getByRole('button', { name: /run query/i }).click();
  const rows = page.locator('.lg-stream .lg-row');
  await expect(rows.first()).toBeVisible({ timeout: 45_000 });
  return rows;
}

/** A row judged from the given caller — which decides its trace source. The
 *  newest by default; `oldest` takes the last on the page, whose trace has
 *  long since landed. */
function rowFrom(page: Page, rows: Locator, caller: string, oldest = false): Locator {
  const matching = rows.filter({ has: page.locator('.lg-svc', { hasText: caller }) });
  return oldest ? matching.last() : matching.first();
}

test('the tab lists judged calls from both trace sources under the provider', async ({ page, pageErrors }) => {
  const rows = await openRecords(page);

  for (const caller of [NATIVE_GENAI_CALLER, OTLP_GENAI_CALLER]) {
    const row = rowFrom(page, rows, caller);
    await expect(row, `a record judged from ${caller}`).toBeVisible();
    // What makes a row readable: who was called, what was judged, how it scored.
    await expect(row.locator('.lg-provider-model')).toContainText(GENAI_PROVIDER);
    await expect(row.locator('.lg-provider-model')).toContainText(GENAI_MODEL);
    // Either task the judge is configured with, never one pinned: the fixture
    // produces both per call, and the sort decides which lands first.
    expect(GENAI_TASKS).toContain((await row.locator('.lg-task').innerText()).trim());
    await expect(row.locator('.lg-lvl')).not.toBeEmpty();
  }

  expect(pageErrors, 'an uncaught error during mount blanks the page').toEqual([]);
});

test('a record judged from a native trace opens that trace on the native popout', async ({ page, pageErrors }) => {
  const rows = await openRecords(page);
  await rowFrom(page, rows, NATIVE_GENAI_CALLER).locator('.lg-trace').click();

  const popout = page.locator('.tp-card');
  await expect(popout).toBeVisible();
  expect((await popout.locator('.trace-id-text').innerText()).trim(), 'the popout names the trace it opened').toBeTruthy();
  // Spans drawn, not merely a shell: the by-id lookup went through.
  await expect(popout.locator('.tp-row').first()).toBeVisible({ timeout: 45_000 });
  // The record's time travels with the id, so the lookup is bounded to where
  // the trace is rather than to OAP's default day.
  await expect(page).toHaveURL(/[?&]traceId=/);
  await expect(page).toHaveURL(/[?&]traceAt=\d+/);

  expect(pageErrors).toEqual([]);
});

test('a record judged from an OTLP trace opens that trace on the Zipkin popout', async ({ page, pageErrors }) => {
  const rows = await openRecords(page);
  await rowFrom(page, rows, OTLP_GENAI_CALLER).locator('.lg-trace').click();

  // The OTLP renderer, chosen by the record's trace type — not by the layer,
  // whose template sources no traces at all.
  const popout = page.locator('.zk-popout-backdrop');
  await expect(popout).toBeVisible();
  expect((await popout.locator('.zk-tid').innerText()).trim()).toBeTruthy();
  await expect(popout.locator('.tp-row').first()).toBeVisible({ timeout: 45_000 });
  await expect(page).toHaveURL(/[?&]traceType=OTLP/);
  // The same time bound as the native path. Without it the OTLP lookup ran
  // over OAP's default day, and a record older than that opened to nothing.
  await expect(page).toHaveURL(/[?&]traceAt=\d+/);

  expect(pageErrors).toEqual([]);
});

test('the trace-id condition narrows to one LLM span picked from the trace', async ({ page, pageErrors }) => {
  const rows = await openRecords(page);

  // The trace id the way an operator gets one: off the popout a row opens —
  // once it has drawn its spans. An older row: the newest record's trace can
  // still be landing (the record is written when the judge answers, the
  // segment on its own cycle), and the picker is about a trace already seen.
  await rowFrom(page, rows, NATIVE_GENAI_CALLER, true).locator('.lg-trace').click();
  const popout = page.locator('.tp-card');
  await expect(popout).toBeVisible();
  await expect(popout.locator('.tp-row').first()).toBeVisible({ timeout: 45_000 });
  const traceId = (await popout.locator('.trace-id-text').innerText()).trim();
  expect(traceId).toBeTruthy();
  await popout.locator('.tp-head button', { hasText: '×' }).click();
  await expect(popout).toBeHidden();

  await page.locator('.cf-trace-id').fill(traceId);
  await page.locator('.cf-pick-span').click();
  const picker = page.locator('[role="dialog"] .sp');
  await expect(picker).toBeVisible();
  // The judged span is marked and listed first; the filter defaults to it.
  const llm = picker.locator('tr.llm');
  await expect(llm.first()).toBeVisible({ timeout: 45_000 });
  await expect(llm.first().locator('.sp-llm')).toHaveText('LLM');
  await llm.first().locator('.sp-use').click();
  await expect(picker).toBeHidden();

  // The pick landed in the condition — both halves of a native address.
  await expect(page.locator('.cf-segment-id')).not.toHaveValue('');
  await expect(page.locator('.cf-span-index')).not.toHaveValue('');

  // And the query it narrows still finds the record judged from that span, and
  // nothing from any other trace: the rows left open on the same trace id.
  await page.getByRole('button', { name: /run query/i }).click();
  await expect(rows.first()).toBeVisible({ timeout: 45_000 });
  expect(await rows.count()).toBeLessThanOrEqual(GENAI_TASKS.length);
  await rows.first().locator('.lg-trace').click();
  await expect(page.locator('.tp-card .trace-id-text')).toHaveText(traceId);

  expect(pageErrors).toEqual([]);
});

test('the VIRTUAL_GENAI service dashboard renders the provider\'s card widgets', async ({ page, pageErrors }) => {
  await page.goto(`/layer/${GENAI_LAYER}/service`);

  // Resolved from OAP's roster: the only provider the fixture has.
  await expect(page.locator('.service-row .svc-name')).toHaveText(GENAI_PROVIDER, { timeout: 45_000 });

  const cards = page.locator('.w-body.type-card');
  await expect(cards.first(), 'the template declares card widgets; none rendered').toBeVisible({ timeout: 45_000 });
  // A card collapses its window to ONE number, and renders an em dash for a
  // null — so visibility alone accepted an empty set. The trigger keeps the
  // provider's token counters moving, so some card must carry a digit.
  await expect
    .poll(async () => (await cards.locator('.card-value .num').allTextContents()).some((text) => /\d/.test(text)), {
      timeout: 60_000,
      message: 'every card rendered an em dash — no provider metric bound a value',
    })
    .toBe(true);

  expect(pageErrors).toEqual([]);
});
