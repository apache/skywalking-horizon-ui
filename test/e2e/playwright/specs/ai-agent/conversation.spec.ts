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
  AI_AGENT_LAYER,
  AI_AGENT_SENDER,
  AI_AGENT_SERVICE,
  AI_CONVERSATION_BASH_COMMAND,
  AI_CONVERSATION_BASH_RESULT,
  AI_CONVERSATION_BASH_RUNS,
  AI_CONVERSATION_BASH_STEP,
  AI_CONVERSATION_LLM_CALLS,
  AI_CONVERSATION_TITLE,
} from '../fixture.js';
import type { Locator, Page } from '@playwright/test';

// One AI agent conversation, from the list to the bodies a model call exchanged with its provider.
//
// Everything here is read off the page against a real OAP holding what the Sessionizer pushed, which is
// the one thing the unit tests cannot prove: they use a landed file as a fixture and a stubbed route.
// A row opens the conversation in a browser tab of its own, outside the AppShell, so every test that
// reads the conversation works on the page that tab carries.

/** The value of one column of a row, found by the header above it rather than by position. */
async function cell(page: Page, row: Locator, header: string): Promise<string> {
  // innerText is what the reader sees, and the table's heads are uppercased by the stylesheet
  const headers = await page.getByRole('columnheader').allInnerTexts();
  const at = headers.findIndex((h) => h.trim().toLowerCase() === header.toLowerCase());
  expect(at, `the table has a ${header} column`).toBeGreaterThanOrEqual(0);
  return (await row.getByRole('cell').nth(at).innerText()).trim();
}

/** The Conversations tab, queried for the agent the case pushes. */
async function openList(page: Page): Promise<void> {
  await page.goto(`/layer/${AI_AGENT_LAYER}/conversations`);
  // The tab owns its time range and runs nothing until asked, as the Traces and Logs tabs do.
  await page.getByRole('button', { name: /run query/i }).click();
  await expect(page.getByRole('row', { name: new RegExp(AI_CONVERSATION_TITLE) })).toBeVisible({ timeout: 30_000 });
}

/** The conversation page, in the tab its row opens. */
async function openConversation(page: Page): Promise<Page> {
  await openList(page);
  const [opened] = await Promise.all([
    page.context().waitForEvent('page'),
    page.getByRole('row', { name: new RegExp(AI_CONVERSATION_TITLE) }).click(),
  ]);
  await expect(opened).toHaveURL(/\/ai-conversation\//);
  // the whole document is read before a byte is drawn, and a conversation is megabytes
  await expect(opened.locator('.acv-transcript-list')).toBeVisible({ timeout: 120_000 });
  return opened;
}

test.describe('AI agent conversations', () => {
  test('lists a conversation with what it did, and opens it', async ({ page }) => {
    await openList(page);
    const row = page.getByRole('row', { name: new RegExp(AI_CONVERSATION_TITLE) });
    // the counts come from the newest round as the Sessionizer wrote them, each in its own column:
    // asserted anywhere in the row, two columns holding the same number would prove nothing
    await expect(row).toContainText(AI_AGENT_SENDER);
    expect(await cell(page, row, 'Model calls')).toBe(String(AI_CONVERSATION_LLM_CALLS));
    expect(await cell(page, row, 'Bash runs')).toBe(String(AI_CONVERSATION_BASH_RUNS));

    const view = await openConversation(page);
    // the page names the conversation, its agent and the sender that pushed it
    await expect(view.locator('body')).toContainText(AI_CONVERSATION_TITLE);
    await expect(view.locator('body')).toContainText(AI_AGENT_SERVICE);
    await expect(view.locator('body')).toContainText(AI_AGENT_SENDER);
    // and states what it made of the chain
    await expect(view.locator('.acv-integrity')).toContainText(/verified/i);
  });

  test('draws the talk: what came in, what the agent answered', async ({ page }) => {
    const view = await openConversation(page);
    const transcript = view.locator('.acv-transcript-list');
    // the scenario's own words, both directions, as the runtime recorded them
    await expect(transcript).toContainText('read the configuration and summarise it');
    await expect(transcript).toContainText('The timeout is 30 seconds, with 3 retries.');
    // the agent's work is folded under the reply until a reader opens it
    await expect(transcript.getByText(/show what the agent did/i).first()).toBeVisible();
  });

  test('shows a shell command as the lines that were run, and what it returned', async ({ page }) => {
    const view = await openConversation(page);
    // The one shell command of this conversation was run by the child agent it started, so it is not in
    // the main stream's transcript. The address carries the position, which is what a reader shares, and
    // the page keeps it current as the reader moves - so the step is set on the address, never appended.
    const at = new URL(view.url());
    at.searchParams.set('step', AI_CONVERSATION_BASH_STEP);
    at.searchParams.delete('talk');
    at.searchParams.delete('stream');
    await view.goto(at.toString());
    await expect(view.locator('.acv-inspector-title')).toContainText('Bash', { timeout: 60_000 });

    // the input is drawn as the lines that were run, not as one escaped JSON string
    const inspector = view.locator('.acv-inspector-body');
    await expect(inspector).toContainText(AI_CONVERSATION_BASH_COMMAND);
    await expect(inspector).not.toContainText('{"command"');
    // and the result beside it
    await expect(inspector).toContainText(AI_CONVERSATION_BASH_RESULT);
  });

  test('rebuilds the prompt a model call sent, and the answer it got', async ({ page }) => {
    const view = await openConversation(page);
    // a model call carries the bodies; the flow timeline is where every one of them is reachable
    await view.locator('[data-node^="call/"]').first().click();
    const prompt = view.locator('[data-tab="prompt"]');
    await expect(prompt, 'a call whose bodies landed offers the tab').toBeVisible();
    await prompt.click();

    // nothing is read until the reader asks, and the offer says what it costs
    const body = view.locator('.acv-inspector-body');
    await expect(body).toContainText(/file\(s\) of this session/i);
    await body.getByRole('button', { name: /load the prompt/i }).click();

    // the request as it was sent: the system prompt, the tools, and the messages in their boxes
    await expect(body).toContainText('System prompt', { timeout: 30_000 });
    await expect(body).toContainText('Tools (');
    await expect(body).toContainText('Messages (');
    await expect(body.locator('.acv-prompt-message').first()).toBeVisible();
    // the text the runtime injected is marked as injected, beside the text a person wrote
    await expect(body).toContainText(/injected by the runtime/i);
    await expect(body).toContainText('read the configuration and summarise it');

    // and the response on its own, with what stopped it
    await body.getByRole('button', { name: /^response$/i }).click();
    await expect(body).toContainText(/stopped:/i);
  });

  test('reads the files once for a session, however many calls are opened', async ({ page }) => {
    const reads: string[] = [];
    page.context().on('request', (r) => {
      if (r.url().includes('/files?')) {
        reads.push(r.url());
      }
    });
    const view = await openConversation(page);
    await view.locator('[data-node^="call/"]').first().click();
    await view.locator('[data-tab="prompt"]').click();
    await view.locator('.acv-inspector-body').getByRole('button', { name: /load the prompt/i }).click();
    await expect(view.locator('.acv-inspector-body')).toContainText('Messages (', { timeout: 30_000 });

    // every other call of the same session is drawn from what that read already brought back
    for (const call of await view.locator('[data-node^="call/"]').all()) {
      await call.click();
      await expect(view.locator('[data-tab="prompt"]')).toHaveAttribute('aria-selected', 'true');
      await expect(view.locator('.acv-inspector-body').getByRole('button', { name: /load the prompt/i })).toHaveCount(0);
      // and the body is drawn from what that read brought back: an empty panel, or one saying it could
      // not rebuild, would satisfy the two assertions above on its own
      await expect(view.locator('.acv-inspector-body')).toContainText('Messages (');
      await expect(view.locator('.acv-inspector-body .acv-prompt-message').first()).toBeVisible();
    }
    expect(reads, 'one read of the session, not one per call').toHaveLength(1);
  });
});
