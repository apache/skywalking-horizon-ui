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

// Live debug RUNS, not just the pages.
//
// The debugger's job is to sample real records through a rule and show what
// each statement did with them. The suite already proved the page mounts and
// that a session starts ON THE WIRE — neither says the matrix ever renders a
// record.
//
// LAL samples the service's shipped LOGS. The fixture emits those as a
// one-off burst during setup, so a capture started later sees nothing
// (`ok 0 bytes · no LAL records from this node`) — the test has to drive
// traffic while the session is live.
//
// MAL samples the agent's own meter stream. `meter-analyzer-config/java-agent`
// analyses the self-observability meters every Java agent reports — the tracing
// contexts it creates and finishes — and the demo services report them because
// the fixture leaves the agent's meter sender on. No traffic has to be driven
// while the session is live the way LAL needs it: the agent ships its meters on
// a 20-second timer whether or not a request arrives.
//
// OAL is here, and it enters from the CATALOG page rather than the debugger's
// own controls. The OAL tab has no rule list to pick from — the metric is a
// free-text box, because a metric is any LHS in any loaded `.oal` file — so
// the operator's path is `/operate/oal`: pick the file, find the statement,
// hit the green ▶ in its gutter, which deep-links into the debugger with the
// picker filled in. `service_cpm` samples `Service.*`, which the fixture's
// continuous `/users` traffic dispatches every few seconds.
//
// Starting a session mutates OAP — the same scoped write the trace-profiling
// spec makes.

/** Pick a rule file + rule, then start. Both selects gate the button.
 *  `ruleLabel` names the rule when position won't do: LAL's second select
 *  holds one entry per file, MAL's holds every metric the rule YAML declares,
 *  and picking a metric the fixture never increments waits forever. */
async function startSampling(page: Page, filePattern: RegExp, ruleLabel?: string): Promise<void> {
  const file = page.locator('select.ctl__select').first();
  await expect(file).toBeVisible({ timeout: 45_000 });
  await expect
    .poll(async () => file.locator('option').count(), { timeout: 60_000 })
    .toBeGreaterThan(1);
  const label = (await file.locator('option').allTextContents()).find((o) => filePattern.test(o));
  expect(label, `no rule file matching ${filePattern}`).toBeTruthy();
  await file.selectOption({ label: label! });

  const rule = page.locator('select.ctl__select').nth(1);
  await expect
    .poll(async () => rule.locator('option').count(), { timeout: 60_000 })
    .toBeGreaterThan(1);
  if (ruleLabel === undefined) await rule.selectOption({ index: 1 });
  else await rule.selectOption({ label: ruleLabel });

  const start = page.getByRole('button', { name: 'start sampling' });
  await expect(start, 'sampling stayed disabled after picking a file and rule').toBeEnabled({
    timeout: 45_000,
  });
  await start.click();
  await expect(page.getByRole('button', { name: 'stop' })).toBeEnabled({ timeout: 45_000 });
}

test('the LAL debugger samples logs driven while it is live', async ({ page, pageErrors }) => {
  test.setTimeout(300_000);
  await page.goto('/operate/live-debug/lal');
  await startSampling(page, /horizon-e2e/);

  // Logs only exist while something emits them. The demo provider is on the
  // same compose network as this browser, so the page can drive its
  // log-emitting endpoint from inside the session — which is also the honest
  // shape of the test: records must flow THROUGH the rule while sampling.
  const drive = page.evaluate(async () => {
    for (let i = 0; i < 40; i += 1) {
      try {
        await fetch('http://provider:9090/logs/trigger', { mode: 'no-cors' });
      } catch {
        /* the page is cross-origin to the provider; the request still lands */
      }
      await new Promise((r) => setTimeout(r, 1_500));
    }
  });

  await expect(page.locator('.lal__matrixblock').first()).toBeVisible({ timeout: 240_000 });
  await drive.catch(() => undefined);

  // The panel's search filters the captured records by their CONTENT — the
  // log body and the builder's output tags — which is how an operator finds
  // the one record they care about in a busy capture. A nonsense needle must
  // empty the matrix, and clearing it must bring the records back; asserting
  // only the first half would pass on a search that broke the view outright.
  // Filtering narrows the records WITHIN the matrix; the block itself stays,
  // and a needle that matches nothing surfaces `.lal__nomatch` — which is a
  // different message from "no records on this node", so it also proves the
  // empty state knows why it is empty.
  const search = page.locator('input.lal__searchinput');
  await expect(search).toBeVisible();
  await search.fill('zzz-no-such-log-zzz');
  await expect(page.locator('.lal__nomatch').first()).toBeVisible({ timeout: 45_000 });

  // Clearing brings them back — asserting only the empty half would pass on a
  // search that broke the view outright.
  await search.fill('');
  await expect(page.locator('.lal__matrixblock').first()).toBeVisible({ timeout: 45_000 });

  expect(pageErrors).toEqual([]);
});

test('the OAL catalog runs the statement its green arrow points at', async ({
  page,
  pageErrors,
}) => {
  test.setTimeout(300_000);
  await page.goto('/operate/oal');

  // Pick the file BY NAME. The catalog auto-selects the first one, which is
  // whichever OALDefine the OAP build happens to load first — clicking a
  // position instead would follow that order rather than this test's intent.
  const coreFile = page.locator('button.oal__fileitem', { hasText: 'core.oal' });
  await expect(coreFile).toBeVisible({ timeout: 60_000 });
  await coreFile.click();
  // OAP names a file by its classpath entry (`oal/core.oal` today, bare
  // `core.oal` on older builds), so the name is READ off the list rather
  // than spelled here — the picker has to receive whatever OAP reported.
  const fileName = ((await coreFile.textContent()) ?? '').trim();

  // Lock onto the statement by its CONTENT. `core.oal` is upstream's file and
  // its line numbers move whenever a metric is added above this one, so a
  // gutter position — or an nth() — would break on an OAP bump that changed
  // nothing about the feature. There is no search box on this page to narrow
  // with; the statement text is the only stable handle.
  const statement = page.locator('.oal__line--debuggable', {
    hasText: /service_cpm\s*=\s*from\(/,
  });
  await expect(statement, 'core.oal no longer declares service_cpm').toHaveCount(1);
  await statement.locator('button.oal__dbgbtn').click();

  // The ▶ is a deep link, and the picker it fills is the whole contract
  // between the two pages: the debugger has no rule list, so a jump that
  // landed with an empty metric box would leave the operator retyping it.
  await expect(page).toHaveURL(/\/operate\/live-debug\/oal\?/);
  await expect(page.locator('select.ctl__select')).toHaveValue(fileName);
  await expect(page.locator('input.ctl__input--flex')).toHaveValue('service_cpm');

  const start = page.getByRole('button', { name: 'start sampling' });
  await expect(start, 'the deep-linked picker left sampling disabled').toBeEnabled({
    timeout: 45_000,
  });
  await start.click();
  await expect(page.getByRole('button', { name: 'stop' })).toBeEnabled({ timeout: 45_000 });

  // The capture is keyed to the metric the arrow named — `.oal__empty` renders
  // in the groups' place when a session catches nothing, so asserting the node
  // or the session state would pass on a debugger that samples and shows
  // nothing.
  await expect(page.locator('code.oal__rulename').first()).toHaveText('service_cpm', {
    timeout: 240_000,
  });

  // …and the row it captured is the fixture's own traffic. The payload is the
  // assertion: a waterfall that renders its steps with empty payloads looks
  // identical to a working one until you read a value out of it. Matched
  // against the service SET — which of the two dispatches first is traffic
  // timing, not correctness.
  await expect(
    page.locator('.oal__kvline').filter({ hasText: /e2e-service-(provider|consumer)/ }).first(),
    'no captured source row carried a fixture service name',
  ).toBeVisible({ timeout: 240_000 });

  expect(pageErrors, 'an uncaught error during mount blanks the page').toEqual([]);
});

test('the MAL debugger samples the agent meter stream the fixture reports', async ({
  page,
  pageErrors,
}) => {
  test.setTimeout(300_000);
  await page.goto('/operate/live-debug/mal');
  // Both halves of the picker are named, never taken by position. The file
  // list is every rule OAP loaded across four catalogs in OAP's own order, so
  // a positional pick follows that order rather than this test's intent. The
  // metric matters more: sorted, the first entry is
  // `created_ignored_context_count`, and the demo app ignores no path, so that
  // counter is never created and the capture would wait on data that cannot
  // arrive.
  await startSampling(
    page,
    /meter-analyzer-config\s+·\s+java-agent\b/,
    'meter_java_agent_created_tracing_context_count',
  );

  // `.mal__empty` renders in the records' place when a capture catches
  // nothing, so the container is the floor, not the assertion.
  await expect(page.locator('.mal__records').first()).toBeVisible({ timeout: 240_000 });

  // The VALUE: the metric the pipeline MATERIALISED, read off the output
  // step. A record whose expression stopped early still renders its input and
  // function rows — only the output carries the metric the rule is named for,
  // and it is the prefixed form OAP composes (`metricPrefix` + rule name),
  // which is also the name a session has to be installed under.
  await expect
    .poll(
      async () => {
        const vals = await page.locator('.mal__meter .mal__mval').allTextContents();
        return vals.map((v) => v.trim());
      },
      { timeout: 240_000, intervals: [5_000] },
    )
    .toContain('meter_java_agent_created_tracing_context_count');

  // The sample's own labels prove the record came from THIS fixture rather
  // than from an empty pipeline that still names its metric. Groups render
  // folded, so the head has to be opened first; a group holding more than one
  // series opens in diff mode, which moves the shared labels into
  // `.mal__diffcommon` — hence the two-class union.
  await page.locator('.mal__grouphead').first().click();
  await expect
    .poll(
      async () => {
        const labels = await page
          .locator('.mal__rtlabel, .mal__diffcommon')
          .allTextContents();
        return labels.join(' ');
      },
      { timeout: 60_000, intervals: [2_000] },
    )
    // Both demo services report meters, and which one's record lands first is
    // traffic timing — match the SET, as the OAL test does.
    .toMatch(/service=e2e-service-(provider|consumer)/);

  expect(pageErrors, 'an uncaught error during mount blanks the page').toEqual([]);
});
