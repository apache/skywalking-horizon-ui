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
 * Translating an extension page, and what happens to that translation when
 * the page is deleted.
 *
 * The whole point of this case is that it is the one that may write to
 * OAP, and this journey needs writes: the Translations page translates the
 * PUBLISHED template, so a page that exists only in a browser draft is not
 * translatable at all. Wire case 10 publishes the template that makes this
 * reachable.
 *
 * The stranded-translation half runs against a SECOND layer, published by
 * the case's fixture with a page and two translated names. Everything
 * after that is done here, through the screens: the page is deleted in the
 * layer editor and pushed, which is what strands the translations.
 *
 * That editor step is also the regression test for a layer template that
 * exists only on OAP. This case runs no telemetry, so the layer is in no
 * roster and ships no bundled JSON — the state in which the picker used to
 * skip it, silently select another layer, and send the edit there.
 *
 * Two layers rather than one so the first keeps its page: the browser has
 * to translate a live page through the UI, and that page cannot also be
 * the one that gets removed.
 *
 * Named to sort after the read-only admin specs. The project runs serially
 * with one worker, so this file's mutations land after they have read.
 */

import type { Page } from '@playwright/test';
import { test, expect } from '../support/diagnostics.js';

const LAYER = 'HORIZON_E2E_EXT';
const PAGE_NAME = 'Agents';
/** The layer whose page was published, translated, and then removed. */
const STALE_LAYER = 'HORIZON_E2E_STALE';
/** One locale for the whole journey — the row is per (template, locale),
 *  so translating one and asserting another would prove nothing. */
const TARGET = 'zh-CN';
const TRANSLATED = '探针页';

const READY = 45_000;
/** A push waits on OAP propagation and then a visible refresh countdown. */
const PUSHED = 90_000;

/**
 * Pick from one of the page's TypeaheadSelect controls.
 *
 * Scoped by the label's own caption, not by `label:has-text(...)`: the Kind
 * control's SELECTED VALUE is the word "Layer", so a has-text match on
 * "Layer" hits the Kind label first and silently drives the wrong control.
 */
async function pick(page: Page, label: string, option: string | RegExp): Promise<void> {
  const control = page.locator('label').filter({ has: page.locator(`span:text-is("${label}")`) });
  await control.locator('.tas__trigger').click();
  await page.getByRole('option', { name: option }).first().click();
  // THIS control's panel, not "no panel anywhere": a list left open floats
  // over the preview, and the next click lands on a row instead of the
  // canvas — which reads as a click that did nothing.
  await expect(control.locator('.tas__panel')).toHaveCount(0);
}

/** The template picker is its own control — a searchable list, not a select. */
async function pickTemplate(page: Page, key: string): Promise<void> {
  await page.locator('.tp-btn').click();
  await page.locator('.tp-search').fill(key);
  await page.locator('.tp-row').filter({ has: page.locator(`code:text-is("${key}")`) }).click();
  await expect(page.locator('.tp-btn .tp-key')).toHaveText(key, { timeout: READY });
}

/** The Translations page, pointed at one layer's Service component. */
async function openTranslations(page: Page, layer = LAYER): Promise<void> {
  await page.goto('/admin/translations');
  await expect(page.locator('.tv')).toBeVisible({ timeout: READY });
  await pick(page, 'Kind', 'Layer');
  await pickTemplate(page, layer);
  await pick(page, 'Component', /Service/);
  await pick(page, 'Target', new RegExp(TARGET));
}

test.describe.configure({ mode: 'serial' });

test('an extension page is translatable once its template is published', async ({
  page,
  pageErrors,
}) => {
  await openTranslations(page);

  // The Page picker exists BECAUSE the published template declares a page.
  // Its options carry the id, so two pages sharing a display name stay
  // distinguishable.
  await pick(page, 'Page', new RegExp(`${PAGE_NAME} \\(agents\\)`));

  // The page's own header on the canvas — not the layer header, which
  // edits the layer's name and aliases.
  await page.locator('.ldc-page-head').click();
  const panel = page.locator('.fp');
  await expect(panel).toBeVisible({ timeout: READY });
  // Exactly one field: a page contributes its display name and nothing
  // else. Its widgets are reached by clicking the widgets.
  await expect(panel.locator('.fp__input')).toHaveCount(1);
  await expect(panel.locator('.fp__src')).toHaveText(PAGE_NAME);

  await panel.locator('.fp__input').fill(TRANSLATED);
  await panel.getByRole('button', { name: 'Stage' }).click();

  await page.getByRole('button', { name: /Check diff & push/ }).click();
  await page.getByRole('button', { name: /Confirm push/ }).click();
  await expect(page.locator('.tv__msg')).toContainText(/now live for everyone/, { timeout: PUSHED });

  // Published, so the preview renders the translated name rather than the
  // English source — the value an operator would then see in the sidebar.
  await expect(page.locator('.ldc-page-head')).toContainText(TRANSLATED, { timeout: READY });

  expect(pageErrors).toEqual([]);
});

test('a layer that exists only on OAP opens in the editor, and its page can be deleted', async ({
  page,
  pageErrors,
}) => {
  // No bundled JSON, no reporting services: this layer exists only as a
  // stored row. Reaching its editor at all is the fix under test.
  await page.goto(`/admin/layer-dashboards?layer=${STALE_LAYER}&scope=service`);
  await expect(page.locator('.page-bar')).toBeVisible({ timeout: READY });
  // The link's OWN layer, not whichever the picker defaulted to — the
  // failure this replaces was silent, and an edit went to that other one.
  // Asserted on the editor's identity row rather than the picker button:
  // this is the template the canvas is bound to, which is what a wrong
  // selection actually damages.
  await expect(page.locator('.identity-row code')).toHaveText(STALE_LAYER, { timeout: READY });
  // Opened from its STORED content: the page it was published with is
  // there, so the editor is not showing a blank that a save would flatten.
  await expect(page.locator('.page-select option')).toHaveCount(2, { timeout: READY });

  await page.locator('.page-select').selectOption('doomed');
  // Scoped to the page bar: with no bundled counterpart the header bar
  // renders its own plain "Delete", which removes the whole layer template.
  await page.locator('.page-bar').getByRole('button', { name: 'Delete', exact: true }).click();
  await page.getByRole('button', { name: /Delete page/ }).click();
  await expect(page.locator('.page-select option')).toHaveCount(1, { timeout: READY });

  // The editor stages to the browser first; publishing is a second,
  // deliberate step. Without the stage there is nothing to push, and the
  // push button says so.
  await page.getByRole('button', { name: /Save \(local\)/ }).click();
  await page.getByRole('button', { name: /Check diff & push/ }).click();
  await page.getByRole('button', { name: /Confirm push/ }).click();
  await expect(page.locator('.save-msg')).toContainText(/now live for everyone/, { timeout: PUSHED });

  expect(pageErrors).toEqual([]);
});

test('a translation the template can no longer place is tagged, and blocks the language', async ({
  page,
  pageErrors,
}) => {
  // The stranded state is established by the case's fixture steps: this
  // layer had a page, its name was translated, and the page was removed.
  // The layer editor could not have done it — its picker is the disk
  // bundles plus the layers OAP reports, and this case runs none — so the
  // edit is setup and everything asserted here is what a browser shows.
  await openTranslations(page, STALE_LAYER);

  await expect(page.locator('.tv__stale-tag')).toBeVisible({ timeout: READY });
  await expect(page.locator('.tv__stale-count')).toContainText(/1/);
  await page.locator('.tv__stale-list summary').click();
  await expect(page.locator('.tv__stale-list code')).toContainText(/dashboardExtPages/);

  // Blocked: every door that writes is shut.
  await expect(page.getByRole('button', { name: 'Stage local' })).toBeDisabled();
  await expect(page.getByRole('button', { name: /Check diff & push/ })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Import' })).toBeDisabled();
  await expect(page.getByRole('button', { name: /reset to/ })).toBeDisabled();

  // …including the editor itself. The layer header opens the panel on a
  // language that is not blocked — the first test opened `.fp` that way —
  // so this absence is a real condition, not a selector that never matches.
  await page.locator('.ldc-layer-head').click();
  await expect(page.locator('.fp')).toHaveCount(0);

  expect(pageErrors).toEqual([]);
});

test('removing asks for its extent, and sweeps every language when told to', async ({
  page,
  pageErrors,
}) => {
  await openTranslations(page, STALE_LAYER);
  await expect(page.locator('.tv__stale-tag')).toBeVisible({ timeout: READY });

  // Nothing to choose about WHICH entries go — only how far. The scan
  // covers every language of the template, not just the selected one, so
  // the others cannot sit unnoticed until someone tries to edit them.
  await page.getByRole('button', { name: /Remove them/ }).click();
  await expect(page.locator('.tv__sweep-list li')).toHaveCount(2, { timeout: READY });
  await expect(page.locator('.tv__sweep-list')).toContainText('日本語');

  await page.getByRole('button', { name: /All languages \(2\)/ }).click();
  await expect(page.locator('.tv__stale-tag')).toHaveCount(0, { timeout: PUSHED });

  // The selected language is editable again.
  await expect(page.getByRole('button', { name: 'Import' })).toBeEnabled();
  await page.locator('.ldc-layer-head').click();
  await expect(page.locator('.fp')).toBeVisible({ timeout: READY });
  await page.locator('.fp').getByRole('button', { name: 'Close' }).click();

  // And so is the one that was never selected — the whole point of
  // sweeping rather than cleaning whatever happens to be on screen.
  await pick(page, 'Target', /ja/);
  await expect(page.locator('.tv__stale-tag')).toHaveCount(0, { timeout: PUSHED });
  await page.locator('.ldc-layer-head').click();
  await expect(page.locator('.fp')).toBeVisible({ timeout: READY });

  expect(pageErrors).toEqual([]);
});

test('the other layer keeps the translation it was given', async ({ page, pageErrors }) => {
  // The cleanup rewrites ONE (template, language) row. A cleanup that
  // reached further would show up here as the first test's work undone.
  await openTranslations(page);
  await pick(page, 'Page', new RegExp(`${TRANSLATED}|${PAGE_NAME}`));
  await expect(page.locator('.tv__stale-tag')).toHaveCount(0);
  await expect(page.locator('.ldc-page-head')).toContainText(TRANSLATED, { timeout: READY });

  expect(pageErrors).toEqual([]);
});
