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

// The OTLP pairing page CAPTURES, not just mounts.
//
// The case's span emitter sends one trace a second: e2e-pairing-frontend's
// CLIENT call to e2e-pairing-backend:8080, and the backend's SERVER span
// under it. Each span's `otlp-general` run sends its half of the call to the
// OAP node that owns the trace, which matches the two — so a capture started
// on the page lists the peer matched to its server, dialed by its caller, on
// the node that holds it. OAP keeps nothing once the capture stops, so what
// the page shows afterwards is the round it saved itself.
//
// Starting a capture mutates OAP: one capture per node, shared by every
// reader, and this test stops it again.

const PEER = 'e2e-pairing-backend:8080';

test('the OTLP pairing page captures a call’s pairing and keeps the round once it stops', async ({
  page,
  pageErrors,
}) => {
  test.setTimeout(300_000);
  await page.goto('/operate/otlp-pairing');

  // A page just opened shows no round: there is nothing to start from but the controls.
  const start = page.getByRole('button', { name: /start capture/ });
  await expect(start).toBeEnabled({ timeout: 60_000 });
  await expect(page.getByText('Start the capture to see how OAP pairs the calls it receives.')).toBeVisible();
  await start.click();

  // The list holds every kind; its `matched` chip narrows it to the matches.
  await page.getByRole('button', { name: /^matched\b/ }).click();

  // The matched peer, read back cell by cell: kind, peer, server, callers, count,
  // the detail of its kind (for a match, the alias it composed), and the OAP node
  // that holds the row.
  const row = page.locator('.otp__view tbody tr', { hasText: PEER });
  await expect(row, 'the emitter’s call never showed as matched').toBeVisible({ timeout: 180_000 });
  const cells = row.locator('td');
  await expect(cells.nth(0)).toHaveText('matched');
  await expect(cells.nth(1)).toHaveText(PEER);
  await expect(cells.nth(2)).toHaveText('e2e-pairing-backend');
  await expect(cells.nth(3)).toContainText('e2e-pairing-frontend');
  await expect(cells.nth(5).locator('.otp__aliasdialed'), 'the address the match aliased').toHaveText(PEER);
  await expect(cells.nth(5).locator('.otp__aliasserver'), 'the server it represents').toHaveText('e2e-pairing-backend');
  await expect(cells.nth(6), 'the row names the OAP node that holds it').toHaveText(/\S+:\d+/);
  await expect(page.locator('.otp__nodestat'), 'the one OAP node of this deployment, in the round').toContainText('OAP nodes: 1 of 1 in this round');
  await expect(page.locator('.otp__summary')).toContainText('capturing round, since');

  // Stop: the live tab keeps the round as it ended, from the page's own save.
  await page.getByRole('button', { name: /^\W*stop$/ }).click();
  await expect(page.locator('.otp__summary')).toContainText('captured round', { timeout: 45_000 });
  await expect(page.locator('.otp__view tbody tr', { hasText: PEER })).toBeVisible();

  // The round outlives the page: opened again, the live tab shows none, and
  // History has the round as the page saved it.
  await page.reload();
  // OAP has answered the reopened page: the capture reads off. Before that, an
  // empty live tab would prove nothing.
  await expect(page.locator('.otp__state')).toHaveClass(/otp__state--off/, { timeout: 60_000 });
  await expect(page.getByRole('button', { name: /start capture/ })).toBeEnabled({ timeout: 60_000 });
  await expect(page.getByText('Start the capture to see how OAP pairs the calls it receives.')).toBeVisible();
  await expect(page.locator('.otp__view')).toHaveCount(0);

  // History lists the round folded; it opens under its own row and folds again.
  await page.getByRole('tab', { name: /History/ }).click();
  const round = page.locator('.otp__roundrow').first();
  await expect(round).toBeVisible();
  await expect(page.locator('.otp__roundpanel')).toHaveCount(0);
  await round.locator('.otp__roundopen').click();
  await expect(page.locator('.otp__roundpanel tbody tr', { hasText: PEER })).toBeVisible();
  await round.locator('.otp__roundopen').click();
  await expect(page.locator('.otp__roundpanel')).toHaveCount(0);

  // A delete asks in place: the ✕ turns into delete and cancel, and cancel keeps the round.
  const rounds = await page.locator('.otp__roundrow').count();
  await round.locator('.otp__roundx').click();
  await round.getByRole('button', { name: 'cancel' }).click();
  await expect(page.locator('.otp__roundrow')).toHaveCount(rounds);
  await expect(round.locator('.otp__roundx')).toBeVisible();
  // And delete deletes it.
  await round.locator('.otp__roundx').click();
  await round.getByRole('button', { name: 'delete' }).click();
  await expect(page.locator('.otp__roundrow')).toHaveCount(rounds - 1);

  expect(pageErrors).toEqual([]);
});
