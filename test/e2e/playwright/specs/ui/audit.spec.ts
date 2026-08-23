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

import { test, expect, request as playwrightRequest } from '@playwright/test';
import { E2E_TOKEN, E2E_TOKEN_ID, E2E_USER } from '../fixture.js';

/**
 * The login audit log, end to end: a real sign-in and a real token use become
 * rows an operator can read on the page.
 *
 * The sign-in this asserts is not staged here — it is the one `auth.setup.ts`
 * performs through the real login form before any project runs. That is the
 * whole point: unit tests can prove the service records what it is handed,
 * and only this can prove the login path hands it anything.
 *
 * The core case compresses the flush intervals (2s events, 4s aggregates)
 * from the shipped 15s/60s, so the polls below are seconds rather than
 * minutes. What is being tested is that a row ARRIVES, not the timer.
 */

const AUDIT_URL = '/admin/audit';

/**
 * A request context carrying NO credential of its own.
 *
 * `storageState` is passed explicitly empty rather than omitted: the token
 * assertions are only meaningful if the bearer is the sole credential, and a
 * context that picked up the suite's signed-in session cookie would answer 200
 * to a deliberately bogus token and 200 to a valid one without ever resolving
 * it — passing for the wrong reason in one direction and failing in the other.
 */
async function anonymousApi(baseURL: string | undefined) {
  return playwrightRequest.newContext({
    baseURL,
    storageState: { cookies: [], origins: [] },
  });
}

/**
 * Fails with the page's OWN explanation rather than "no row found".
 *
 * Off, no-backend and unreachable each render a sentence instead of the
 * table, so every assertion below would fail identically on a broken store
 * and on a missing row — two very different bugs.
 */
async function expectRecording(page: import('@playwright/test').Page): Promise<void> {
  // Wait for the page to settle first: `loading` renders the same banner
  // element, so checking immediately after a navigation reports a normal
  // in-flight read as a broken store.
  await expect(page.getByRole('heading', { name: /^sign-ins$/i })).toBeVisible({ timeout: 30_000 });
  const banner = page.locator('.audit__state');
  if (await banner.count()) {
    throw new Error(`the audit page is not recording: ${(await banner.first().innerText()).trim()}`);
  }
}

/**
 * Poll by RELOADING, not by waiting on a locator.
 *
 * The page reads the list once on mount and has no timer, so a row written
 * after that read never enters the DOM — a locator poll would wait out its
 * whole timeout against markup that cannot change. The rows here are produced
 * by a background writer on its own tick, so the poll has to re-ask the
 * server, which is what a reload does.
 */
async function reloadUntil(
  page: import('@playwright/test').Page,
  selector: string,
  what: string,
): Promise<void> {
  await expect
    .poll(async () => {
      await page.goto(AUDIT_URL);
      await expect(page.getByRole('heading', { name: /^sign-ins$/i })).toBeVisible();
      return page.locator(selector).count();
    }, { timeout: 60_000, message: `waiting for ${what} to reach the page` })
    .toBeGreaterThan(0);
}

test.describe('login audit', () => {
  test('records the sign-in that got us here', async ({ page }) => {
    await page.goto(AUDIT_URL);

    // Never the "off"/"unreachable" states: those render instead of the table,
    // so asserting the row alone could pass on a page that shows a banner.
    await expect(page.getByRole('heading', { name: /login audit/i })).toBeVisible();
    await expectRecording(page);
    await reloadUntil(page, `tbody tr:has-text("${E2E_USER}")`, 'the sign-in row');
    const row = page.locator('tbody tr', { hasText: E2E_USER }).first();
    await expect(row).toContainText(/accepted/i);
  });

  test('shows the sign-in in the hourly summary, not only the list', async ({ page }) => {
    await page.goto(AUDIT_URL);
    // The summary is a separate query against a separate table; a list that
    // works while statistics stay empty is a real and invisible failure.
    await expect(page.getByRole('heading', { name: /^sign-ins$/i })).toBeVisible();
    // Assert the BARS, not the absence of the empty-state text. While the
    // block is still loading it renders neither, so "no empty state" passes
    // against a summary that has not arrived — a check that cannot fail.
    await reloadUntil(page, '.stat__chart .stat__col', 'the hourly summary bars');
    await expect(page.locator('.stat__note')).toHaveCount(0);
    await expect(page.getByText(/no sign-ins recorded in this window/i)).toHaveCount(0);
  });

  /**
   * Token use is COUNTED, not written per request: many uses collapse into one
   * cumulative row per credential per hour. Nothing else in the suite exercises
   * that path, and it is the one the store's upsert serves — a statement that
   * was invalid SQL for an entire development phase while every unit test
   * passed.
   */
  test('counts API-token use into one aggregated row', async ({ page, baseURL }) => {
    // A context with NO storage state, so the token is the only credential
    // presented. The shared `request` fixture carries the signed-in session
    // cookie, which would satisfy the route by itself and prove nothing.
    //
    // And an AUTHENTICATED route: `/api/health` is public, so it never reaches
    // the middleware that resolves a bearer, and no use would be counted.
    const api = await anonymousApi(baseURL);
    const uses = 4;
    for (let i = 0; i < uses; i += 1) {
      const res = await api.get('/api/menu', {
        headers: { Authorization: `Bearer ${E2E_TOKEN}` },
      });
      expect(
        res.status(),
        `the fixture token must be accepted on an authenticated route; body: ${(await res.text()).slice(0, 200)}`,
      ).toBe(200);
    }
    await api.dispose();

    await page.goto(AUDIT_URL);
    await expectRecording(page);
    // The token is recorded by its ID — the credential presented — never by
    // the user it names.
    await reloadUntil(page, `tbody tr:has-text("${E2E_TOKEN_ID}")`, 'the token aggregate');
    const row = page.locator('tbody tr', { hasText: E2E_TOKEN_ID }).first();

    // The count column proves aggregation rather than one row per request:
    // `uses` requests must appear as a single row carrying a number, and the
    // list must not have grown by `uses` rows.
    await expect(row).toContainText(new RegExp(`\\b[${uses}-9]\\b`));
    await expect(page.locator('tbody tr', { hasText: E2E_TOKEN_ID })).toHaveCount(1);
  });

  test('does not record a refused credential', async ({ page, baseURL }) => {
    // An unauthenticated caller must not be able to put a row in the table —
    // the property the whole valid-credential-only rule exists for.
    const api = await anonymousApi(baseURL);
    for (let i = 0; i < 3; i += 1) {
      const res = await api.get('/api/menu', {
        headers: { Authorization: 'Bearer hzn_nope_wrong-secret-entirely' },
      });
      expect(
        res.status(),
        `an unresolvable bearer must be refused — a 200 here means something else authenticated the request; body: ${(await res.text()).slice(0, 200)}`,
      ).toBe(401);
    }
    await api.dispose();

    // Long enough for the writer to have flushed anything it was going to.
    await page.waitForTimeout(8_000);
    await page.goto(AUDIT_URL);
    await expect(page.getByRole('heading', { name: /^sign-ins$/i })).toBeVisible();

    // The refused credential left NO trace. Asserting on the credential rather
    // than on a total: the suite signs in repeatedly while this runs, so a
    // row-count delta would measure other tests' activity and fail for reasons
    // that have nothing to do with the property under test.
    await expect(page.locator('tbody tr', { hasText: 'nope' })).toHaveCount(0);

    // And nothing was refused into the table either: the only refusals this
    // log admits happen after authentication succeeds, and none can occur on
    // a local-only fixture.
    await expect(page.locator('tbody tr', { hasText: /refused/i })).toHaveCount(0);
  });
});
