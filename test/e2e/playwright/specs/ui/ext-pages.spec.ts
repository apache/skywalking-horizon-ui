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
 * Extension pages, authored in the admin and read back on the layer page.
 *
 * No bundled layer declares one, so this is the only place the feature is
 * exercised end to end. It authors its own throwaway configuration rather
 * than depending on a fixture template — which is also what keeps it
 * safe to run beside everything else: every edit lands in the BROWSER's
 * local draft and is previewed with `?mode=preview&source=local`. Nothing
 * is pushed, so OAP's state is untouched and the draft dies with the
 * browser context.
 *
 * It lives in the `core` project rather than `admin` because the filter's
 * match count needs a real service roster, and the admin case deliberately
 * runs no demo services.
 *
 * The unit suites cover the parts a browser cannot show: id-addressed
 * translation merging, publish validation, and the resolver's ordering
 * rules. What only a browser can show is that an operator can create these
 * pages and that the layer then renders them.
 */

import type { Page } from '@playwright/test';
import { test, expect } from '../support/diagnostics.js';

import { EXT_LAYER, EXT_LAYER_DRAFT, LAYER, LOCAL_EDITS_KEY } from '../fixture.js';

const ADMIN = `/admin/layer-dashboards?layer=${LAYER.toUpperCase()}&scope=service`;
/** Preview mode is set from the URL on every navigation, so an admin URL
 *  for the seeded layer has to carry it too — without it the layer is not
 *  injected and the picker silently falls back to the first template. */
const PREVIEW = 'mode=preview&source=local';
const extAdmin = (scope = 'service', page?: string): string =>
  `/admin/layer-dashboards?layer=${EXT_LAYER.toUpperCase()}&scope=${scope}` +
  `${page ? `&page=${page}` : ''}&${PREVIEW}`;
const READY = 45_000;

/**
 * Nothing here may reach OAP.
 *
 * Most tests author on a disposable layer that exists only in this
 * browser; the four that need a real service roster stay on the bundled
 * fixture layer. Either way every edit lives in a local draft and is
 * viewed through preview mode, so nothing reaches OAP — a property of how
 * the tests happen to be written until this made it structural.
 */
test.beforeEach(async ({ page }) => {
  await page.route('**/api/admin/templates/save*', () => {
    throw new Error('this suite must not push to OAP — every edit stays in a local draft');
  });
  // Seeded before first paint: the admin picks its layer the moment its
  // sources resolve, so a key that is not there yet is replaced by the
  // first template — and the test would edit THAT while believing
  // otherwise. This primes state the product has no door to create; every
  // assertion after it still comes from driving the real screens.
  // MERGES, and only when absent. An init script runs on every
  // navigation, so replacing the store would wipe the draft a test had
  // just saved — the tests that stay on the bundled layer lost theirs on
  // the very next `goto`.
  await page.addInitScript(
    ([key, name, draft]) => {
      const k = key as string;
      const cur = JSON.parse(window.localStorage.getItem(k) ?? '{}') as Record<string, unknown>;
      if (cur[name as string]) return;
      cur[name as string] = draft;
      window.localStorage.setItem(k, JSON.stringify(cur));
    },
    [LOCAL_EDITS_KEY, `horizon.layer.${EXT_LAYER.toUpperCase()}`, EXT_LAYER_DRAFT] as const,
  );
});

/** The admin page, loaded with its canvas up. */
async function openAdmin(page: Page, url = ADMIN): Promise<void> {
  await page.goto(url);
  await expect(page.locator('.page-bar')).toBeVisible({ timeout: READY });
}

async function addPage(page: Page, name: string): Promise<void> {
  await page.locator('.page-chip.add').click();
  await page.locator('.page-add-form .page-rename').fill(name);
  // The id seeds from the name — its arrival is the signal that the form
  // accepted it, rather than a fixed wait.
  await expect(page.locator('.page-id-input')).not.toHaveValue('', { timeout: READY });
  await page.locator('.page-add-form .sw-btn').first().click();
  // The selector switches to the new page, so it becomes the selected
  // option — that, not a chip, is what proves the add landed.
  await expect(page.locator('.page-select')).toContainText(name, { timeout: READY });
}

/** Options in the Page dropdown, in order. */
const pageOptions = (page: Page): Promise<string[]> =>
  page.locator('.page-select option').evaluateAll((els: Element[]) => els.map((e) => (e.textContent ?? '').trim()));

/** The page currently selected, by its option value (`''` is DEFAULT). */
const selectedPage = (page: Page): Promise<string> => page.locator('.page-select').inputValue();

const labels = (page: Page, sel: string): Promise<string[]> =>
  page.locator(sel).evaluateAll((els: Element[]) => els.map((e) => (e.textContent ?? '').trim()));

async function sidebarRows(page: Page): Promise<string[]> {
  const hrefs = await page
    .locator('.layer-children a')
    .evaluateAll((as: Element[]) => as.map((a) => a.getAttribute('href') ?? ''));
  const prefix = `/layer/${LAYER}/`;
  return hrefs.filter((h) => h.toLowerCase().startsWith(prefix)).map((h) => h.slice(prefix.length));
}

test('an operator can author extension pages and the layer renders them', async ({ page, pageErrors }) => {
  await openAdmin(page);

  // The grid the component already had is the DEFAULT page, and with it
  // selected there is nothing to rename or delete — every layer keeps the
  // page it has always had.
  expect((await pageOptions(page))[0]).toContain('DEFAULT');
  expect(await selectedPage(page)).toBe('');
  // Scoped to the page bar: the assertion is about the DEFAULT page
  // having nothing to delete, not about the header's own controls.
  await expect(page.locator('.page-bar').getByRole('button', { name: 'Delete', exact: true })).toHaveCount(0);
  const defaultWidgets = await page.locator('.canvas-widget').count();
  expect(defaultWidgets, 'the fixture layer has no service widgets to compare against').toBeGreaterThan(0);

  await addPage(page, 'Resource usage');
  // A new page starts empty — proof the canvas followed the selection
  // rather than continuing to edit the default grid.
  await expect(page.locator('.canvas-widget')).toHaveCount(0, { timeout: READY });
  await expect(page).toHaveURL(/[?&]page=resource-usage/);

  // Back to DEFAULT: its widgets are untouched, and `page=` leaves the URL.
  await page.locator('.page-select').selectOption('');
  await expect(page.locator('.canvas-widget')).toHaveCount(defaultWidgets, { timeout: READY });
  await expect(page).not.toHaveURL(/[?&]page=/);

  expect(pageErrors, 'an uncaught error during mount blanks the page').toEqual([]);
});

test('a page named after a built-in tab gets a safe id, not a rejection', async ({ page }) => {
  await openAdmin(page, extAdmin());
  await page.locator('.page-chip.add').click();
  await page.locator('.page-add-form .page-rename').fill('Topology');

  // A display name is not an id. Pages and tabs share a URL space, so the
  // derived id must not be `topology` — but the operator named a page,
  // they did not ask for a route, so the name itself stands.
  await expect(page.locator('.page-id-input')).toHaveValue('topology-2', { timeout: READY });
  await expect(page.locator('.page-add-form .sw-btn').first()).toBeEnabled();
  await page.locator('.page-add-form .sw-btn').first().click();
  await expect(page).toHaveURL(/[?&]page=topology-2/, { timeout: READY });
});

test('two pages sharing a display name stay distinguishable', async ({ page }) => {
  await openAdmin(page, extAdmin());
  await addPage(page, 'Detail');
  await addPage(page, 'Detail');
  // Names may legally repeat, so the id is what tells them apart. The
  // admin dropdown shows it beside the name; this asserts the stronger
  // property behind that — selecting one lands on THAT page, not on its
  // namesake.
  expect((await pageOptions(page)).filter((o) => o.startsWith('Detail'))).toHaveLength(2);
  const ids = await page
    .locator('.page-select option')
    .evaluateAll((els: Element[]) => els.map((e) => (e as HTMLOptionElement).value));
  expect(ids).toEqual(expect.arrayContaining(['detail', 'detail-2']));

  await page.locator('.page-select').selectOption('detail');
  await expect(page).toHaveURL(/[?&]page=detail(?![-\w])/, { timeout: READY });
  await page.locator('.page-select').selectOption('detail-2');
  await expect(page).toHaveURL(/[?&]page=detail-2/, { timeout: READY });
});

test('pages can be authored on Instance and Endpoint too', async ({ page }) => {
  for (const scope of ['instance', 'endpoint'] as const) {
    await openAdmin(page, extAdmin(scope));
    await addPage(page, 'Detail');
    await expect(page).toHaveURL(new RegExp(`scope=${scope}[^]*page=detail`), { timeout: READY });
    // Each component numbers its own pages — the same id under a
    // different component is a different page.
    expect(await selectedPage(page)).toBe('detail');
  }
});

// ── Stays on the bundled fixture layer ───────────────────────────────
// The disposable layer above is injected from a browser draft, and an
// injected layer carries no service count — so the sidebar never lists it
// and its roster is empty. These four assert exactly those two things, so
// they run against the layer the fixture actually reports services for.
test('the editor shows what a page filter selects, out of what exists', async ({ page }) => {
  await openAdmin(page);
  await addPage(page, 'Agents');

  const filter = page.locator('.pef-service-filter');
  await expect(filter).toBeVisible({ timeout: READY });
  // The match list is a popout now — a check consulted while writing the
  // filter, not a panel read continuously while editing widgets below it.
  await page.getByRole('button', { name: /Preview matches/ }).click();
  const candidates = page.locator('.pef-list li');
  await expect(candidates.first()).toBeVisible({ timeout: READY });
  const total = await candidates.count();
  await page.getByRole('button', { name: 'Close', exact: true }).click();

  // Nothing matches: every candidate is still LISTED — hiding them would
  // hide the mistake this panel exists to catch — and it says so outright.
  await filter.fill('zzz-no-such-service');
  // The "nothing matches" warning stays on the surface — it is the one
  // failure that is invisible on the rendered page.
  await expect(page.locator('.pef-check .page-issue')).toBeVisible({ timeout: READY });
  await page.getByRole('button', { name: /Preview matches/ }).click();
  await expect(page.locator('.pef-list li.hit')).toHaveCount(0, { timeout: READY });
  await expect(page.locator('.pef-list li')).toHaveCount(total);
  await page.getByRole('button', { name: 'Close', exact: true }).click();

  // Everything matches: the count moves, so it is reading the real roster.
  await filter.fill('');
  await expect(page.locator('.pef-check .pef-count')).toContainText(`${total} of ${total}`, { timeout: READY });

  // A pattern that cannot compile is flagged where it was typed. Body
  // first: the switch is a no-op on an empty box, so toggling it before
  // typing would leave a bare term that cannot be malformed.
  await filter.fill('^(unclosed');
  await page.locator('.pef-regex input').check();
  // Scoped to the FIELD: the "nothing matches" warning is a `.page-issue`
  // in the Matches row of the same grid, so `.pef-row` matches both.
  await expect(page.locator('.pef-field .page-issue')).toBeVisible({ timeout: READY });
});

test('the DEFAULT page narrows its pickers too, on every entity scope', async ({ page }) => {
  for (const scope of ['service', 'instance', 'endpoint'] as const) {
    await openAdmin(page, `/admin/layer-dashboards?layer=${LAYER.toUpperCase()}&scope=${scope}`);
    // DEFAULT is selected on arrival — no page id in the URL.
    expect(await selectedPage(page)).toBe('');
    await expect(page.locator('.filter-card')).toBeVisible({ timeout: READY });
    // Against a real roster, not an empty one: the denominator is what
    // makes the count and the "nothing matches" warning able to fire.
    const count = page.locator('.pef-field .pef-count').first();
    await expect(count).toBeVisible({ timeout: READY });
    expect(Number(/of (\d+)/.exec((await count.textContent()) ?? '')?.[1] ?? '0')).toBeGreaterThan(0);
    // The entity label belongs to extension pages; the DEFAULT page is
    // named by the layer's own Menu labels.
    await expect(page.locator('.pef-row').filter({ hasText: 'Entity label' })).toHaveCount(0);
  }
});

test('a page id is asked for once, and the admin selector keeps showing it', async ({ page }) => {
  await openAdmin(page, extAdmin('service'));
  await page.locator('.page-chip.add').click();
  const name = page.locator('.page-add-form .page-rename');
  const id = page.locator('.page-id-input');
  await name.fill('Message brokers');
  // Seeded from the name, so the common path stays one field of typing.
  await expect(id).toHaveValue('message-brokers', { timeout: READY });

  // Required: clearing it blocks the add rather than silently deriving one.
  await id.fill('');
  await expect(page.locator('.page-add-form .sw-btn').first()).toBeDisabled();
  // A built-in route is refused here, not at push.
  await id.fill('service');
  await expect(page.locator('.page-add-form .page-issue')).toBeVisible({ timeout: READY });

  await id.fill('brokers');
  await page.locator('.page-add-form .sw-btn').first().click();
  await expect(page.locator('.page-select')).toContainText('Message brokers', { timeout: READY });
  // The id is shown in the ADMIN selector — duplicate display names are
  // legal, so the name alone cannot tell two pages apart here. The runtime
  // sidebar stays name-only.
  const options = await pageOptions(page);
  expect(options.some((o) => o.includes('Message brokers') && o.includes('brokers'))).toBe(true);
});

test('an Endpoint page filters SERVICES, against a roster really there', async ({ page }) => {
  await openAdmin(page, `/admin/layer-dashboards?layer=${LAYER.toUpperCase()}&scope=endpoint`);
  await addPage(page, 'Public API');

  // An Endpoint page narrows the SERVICE list — its screen shows the
  // service picker first, and it has no endpoint filter of its own.
  await expect(page.locator('.filter-card h4')).toHaveText(/services/i, { timeout: READY });

  // The roster behind it is the real one. Asserting the DENOMINATOR is
  // the point: an empty roster renders the same field with every check
  // silently dead — no count, and a "nothing matches" warning that can
  // never fire — which is how this scope once shipped unverifiable.
  const count = page.locator('.pef-field .pef-count').first();
  await expect(count).toBeVisible({ timeout: READY });
  const total = Number(/of (\d+)/.exec((await count.textContent()) ?? '')?.[1] ?? '0');
  expect(total).toBeGreaterThan(0);

  // And it narrows, rather than merely displaying a number.
  await page.locator('.pef-service-filter').fill('zzz-no-such-service');
  await expect(page.locator('.pef-check .page-issue')).toBeVisible({ timeout: READY });
});

test('the regex switch writes the stored form, and reads it back', async ({ page }) => {
  await openAdmin(page);
  await addPage(page, 'Agents');
  const filter = page.locator('.pef-service-filter');

  // Typed plain, the value is a bare term; the switch wraps it in the
  // slashes the template stores, and the box keeps showing the body.
  await filter.fill('agent');
  await page.locator('.pef-regex input').check();
  await expect(filter).toHaveValue('agent');
  await expect(page.locator('.pef-regex')).toHaveClass(/on/);

  // Off again unwraps it — the switch is a view onto one encoding, not a
  // second one.
  await page.locator('.pef-regex input').uncheck();
  await expect(page.locator('.pef-regex')).not.toHaveClass(/on/);
  await expect(filter).toHaveValue('agent');
});

test('pages appear as sidebar rows, render, and deep-link', async ({ page, pageErrors }) => {
  await openAdmin(page);
  await addPage(page, 'Resource usage');
  await page.locator('button:has-text("Save")').first().click();

  // Preview renders the browser-local draft — nothing was pushed to OAP.
  const preview = `?mode=preview&source=local`;
  await page.goto(`/layer/${LAYER}/service${preview}`);
  await expect(page.locator('.layer-children a').first()).toBeVisible({ timeout: READY });

  // The page is a sibling row, directly after the component it belongs to.
  await expect
    .poll(() => sidebarRows(page), { timeout: READY })
    .toEqual(expect.arrayContaining(['service', 'service/resource-usage']));
  const rows = await sidebarRows(page);
  expect(rows.indexOf('service/resource-usage')).toBe(rows.indexOf('service') + 1);

  // Deep-linking to it names the page on screen — several pages of one
  // component share the entity pickers and otherwise look alike.
  await page.goto(`/layer/${LAYER}/service/resource-usage${preview}`);
  await expect(page.locator('.page-heading')).toHaveText('Resource usage', { timeout: READY });

  expect(pageErrors).toEqual([]);
});

test('a previewed page loads metrics for its primary AND its pinned entities', async ({ page }) => {
  // Seeded rather than authored: the point is a page with a QUERYABLE
  // widget. An empty page issues no dashboard request at all, so the
  // earlier version of this test could not have caught anything.
  await page.addInitScript(
    ([key, name, draft]) => {
      const k = key as string;
      const cur = JSON.parse(window.localStorage.getItem(k) ?? '{}') as Record<string, unknown>;
      cur[name as string] = draft;
      window.localStorage.setItem(k, JSON.stringify(cur));
    },
    [
      LOCAL_EDITS_KEY,
      `horizon.layer.${LAYER.toUpperCase()}`,
      {
        key: LAYER.toUpperCase(),
        alias: 'General Service',
        components: { service: true, instances: true },
        dashboards: { service: [] },
        dashboardExtPages: {
          service: [
            {
              id: 'pinned',
              name: 'Pinned',
              widgets: [
                { id: 'prev-load', type: 'line', title: 'Load', expressions: ['service_cpm'], span: 6, rowSpan: 2 },
              ],
            },
          ],
        },
      },
    ] as const,
  );

  const refusals: string[] = [];
  page.on('response', (r) => {
    if (r.status() === 404 && /\/api\/layer\/[^/]+\/dashboard/.test(r.url())) refusals.push(r.url());
  });
  let posts = 0;
  page.on('request', (r) => {
    if (r.method() === 'POST' && /\/api\/layer\/[^/]+\/dashboard/.test(r.url())) posts += 1;
  });

  await page.goto(`/layer/${LAYER}/service/pinned?mode=preview&source=local`);
  await expect(page.locator('.page-heading')).toHaveText('Pinned', { timeout: READY });
  await expect(page.locator('.widget').first()).toBeVisible({ timeout: READY });

  // Pin a SECOND service: the comparison fan-out is a separate request per
  // pinned entity, and it qualified itself with a page OAP has never seen
  // while the primary had already stopped doing so.
  await page.locator('button.sw-btn.switch').first().click();
  const locks = page.locator('.picker .lock-btn');
  await expect(locks.first()).toBeVisible({ timeout: READY });
  const lockable = await locks.count();
  expect(lockable, 'fixture must report >= 2 services to pin one against another').toBeGreaterThan(1);
  await locks.nth(0).click();
  await locks.nth(1).click();
  await page.waitForTimeout(6000);

  expect(posts, 'no metrics were requested — the assertion below would be vacuous').toBeGreaterThan(0);
  expect(refusals, 'metrics refused for a page that exists only in the draft').toEqual([]);
});

test('every row of a layer WITH pages resolves and renders, all three scopes', async ({ page, pageErrors }) => {
  // The existing every-row walk runs on a bundled layer, and no bundled
  // layer declares a page — so component+page routes were never walked.
  await page.addInitScript(
    ([key, name, draft]) => {
      const k = key as string;
      const cur = JSON.parse(window.localStorage.getItem(k) ?? '{}') as Record<string, unknown>;
      cur[name as string] = draft;
      window.localStorage.setItem(k, JSON.stringify(cur));
    },
    [
      LOCAL_EDITS_KEY,
      `horizon.layer.${LAYER.toUpperCase()}`,
      {
        key: LAYER.toUpperCase(),
        alias: 'General Service',
        components: { service: true, instances: true, endpoints: true },
        dashboards: { service: [], instance: [], endpoint: [] },
        dashboardExtPages: {
          service: [{ id: 'svc-extra', name: 'Svc extra', widgets: [] }],
          instance: [{ id: 'inst-extra', name: 'Inst extra', widgets: [] }],
          endpoint: [{ id: 'ep-extra', name: 'Ep extra', widgets: [] }],
        },
      },
    ] as const,
  );

  const PREV = 'mode=preview&source=local';
  await page.goto(`/layer/${LAYER}/service?${PREV}`);
  await expect(page.locator('.layer-children a').first()).toBeVisible({ timeout: READY });
  const rows = await sidebarRows(page);

  // The three pages must actually BE rows, or the walk below proves nothing.
  for (const p of ['service/svc-extra', 'instance/inst-extra', 'endpoint/ep-extra']) {
    expect(rows, `${p} is not a sidebar row`).toContain(p);
  }

  for (const row of rows) {
    await page.goto(`/layer/${LAYER}/${row}?${PREV}`);
    // A dead route leaves the shell empty; a route the shell rejects
    // bounces the URL to the layer's first row.
    await expect(page.locator('.layer-children a').first()).toBeVisible({ timeout: READY });
    expect(new URL(page.url()).pathname.toLowerCase()).toBe(`/layer/${LAYER}/${row}`.toLowerCase());
  }
  expect(pageErrors).toEqual([]);
});

test('an unknown page id is not answered with the default grid', async ({ page }) => {
  await openAdmin(page, extAdmin());
  await addPage(page, 'Resource usage');
  await page.locator('button:has-text("Save")').first().click();

  await page.goto(`/layer/${EXT_LAYER}/service/no-such-page?${PREVIEW}`);
  // The failure this guards is the opposite: real widgets under a URL that
  // promised different ones, which an operator cannot tell from the page
  // they asked for.
  await expect(page.locator('.page-missing')).toBeVisible({ timeout: READY });
  await expect(page.locator('.canvas-widget')).toHaveCount(0);
});

test('a filtered page shows the narrowed list and never mentions the filter', async ({ page }) => {
  await openAdmin(page);
  await addPage(page, 'Agents');
  // A filter that matches nothing at all — the strongest version of the
  // property: even with an empty list, the entity stays picked.
  await page.locator('.pef-service-filter').fill('zzz-matches-nothing');
  await page.locator('button:has-text("Save")').first().click();

  const preview = '?mode=preview&source=local';
  await page.goto(`/layer/${LAYER}/service${preview}`);
  await expect(page.locator('.svc-name')).toBeVisible({ timeout: READY });
  const selectedBefore = (await page.locator('.svc-name').first().innerText()).trim();
  expect(selectedBefore.length, 'no service is selected — wrong fixture?').toBeGreaterThan(0);

  await page.goto(`/layer/${LAYER}/service/agents${preview}`);
  await expect(page.locator('.page-heading')).toHaveText('Agents', { timeout: READY });

  // Nothing on the page mentions a filter. The chip is gone on purpose:
  // the pattern is template syntax, shown to someone who did not write it.
  await expect(page.locator('.svc-filter')).toHaveCount(0);

  // The picker's search box is the OPERATOR's and starts empty — it used
  // to arrive pre-filled with the page's pattern, which is what let them
  // widen the page past what its author intended.
  await page.locator('button.sw-btn.switch').first().click();
  await expect(page.locator('.picker .search')).toHaveValue('', { timeout: READY });
  // ...and the list is narrowed regardless: the filter matches nothing.
  await expect(page.locator('.picker .row')).toHaveCount(0, { timeout: READY });

  // The selected service is the same one, not cleared and not re-picked
  // from the filtered set.
  expect((await page.locator('.svc-name').first().innerText()).trim()).toBe(selectedBefore);
});

test('an Instance page renders at runtime, narrowed to what it selects', async ({ page, pageErrors }) => {
  await openAdmin(page, `/admin/layer-dashboards?layer=${LAYER.toUpperCase()}&scope=instance`);
  await addPage(page, 'Runtimes');
  // Matches the fixture's real instance, so the page has something to show.
  await page.locator('.pef-instance-filter').fill('1');
  await page.locator('button:has-text("Save")').first().click();

  const preview = '?mode=preview&source=local';
  await page.goto(`/layer/${LAYER}/instance/runtimes${preview}`);
  await expect(page.locator('.page-heading')).toHaveText('Runtimes', { timeout: READY });

  // The instance list is the page's set, and the entity the page presents
  // must be one of them — a page that queries one instance and labels it
  // with another's name is the failure this asserts against.
  const rows = page.locator('.ib-list li');
  await expect(rows.first()).toBeVisible({ timeout: READY });
  const shown = (await rows.allTextContents()).map((t) => t.trim());
  expect(shown.length).toBeGreaterThan(0);
  for (const name of shown) expect(name).toContain('1');
  expect(pageErrors).toEqual([]);
});

test('an Instance page that selects nothing says so, without blaming the service', async ({ page }) => {
  await openAdmin(page, `/admin/layer-dashboards?layer=${LAYER.toUpperCase()}&scope=instance`);
  await addPage(page, 'Empty set');
  await page.locator('.pef-instance-filter').fill('zzz-matches-nothing');
  await page.locator('button:has-text("Save")').first().click();

  await page.goto(`/layer/${LAYER}/instance/empty-set?mode=preview&source=local`);
  await expect(page.locator('.page-heading')).toHaveText('Empty set', { timeout: READY });

  // The layer's ORDINARY empty state, with no wording of its own: the
  // reader did not write the filter, and the page's name is what tells
  // them what it holds.
  const empty = page.locator('.empty.inline');
  await expect(empty.first()).toBeVisible({ timeout: READY });
  await expect(empty.first()).toContainText('No active instances reported');
  // And nothing on the page names a filter.
  await expect(page.locator('.svc-filter')).toHaveCount(0);
});

test('an Endpoint page renders at runtime under the services it selects', async ({ page, pageErrors }) => {
  await openAdmin(page, `/admin/layer-dashboards?layer=${LAYER.toUpperCase()}&scope=endpoint`);
  await addPage(page, 'Public API');
  await page.locator('.pef-service-filter').fill('provider');
  await page.locator('button:has-text("Save")').first().click();

  await page.goto(`/layer/${LAYER}/endpoint/public-api?mode=preview&source=local`);
  await expect(page.locator('.page-heading')).toHaveText('Public API', { timeout: READY });
  // The service picker is narrowed by the page, and says so only by what
  // it lists — never by showing the filter.
  await expect(page.locator('.svc-filter')).toHaveCount(0);
  expect(pageErrors).toEqual([]);
});

test('a page can rename the entity it lists, and the layer keeps naming the default', async ({ page }) => {
  await openAdmin(page, `/admin/layer-dashboards?layer=${LAYER.toUpperCase()}&scope=instance`);
  await addPage(page, 'Brokers');
  const alias = page.locator('.pef-alias');
  await expect(alias).toBeVisible({ timeout: READY });
  // DIFFERENT from the page name on purpose: with both set to "Brokers"
  // the heading assertion below passes on the NAME and proves nothing
  // about the alias.
  await alias.fill('JVMs');
  await page.locator('button:has-text("Save")').first().click();

  await page.goto(`/layer/${LAYER}/instance/brokers?mode=preview&source=local`);
  await expect(page.locator('.page-heading')).toHaveText('Brokers', { timeout: READY });
  // The alias names the ENTITY this page lists, which the instance bar
  // prints as its kicker; the heading stays the page's NAME.
  await expect(page.locator('.instance-bar .kicker')).toHaveText(/JVMs/i, { timeout: READY });

  // The DEFAULT page has no alias of its own: the layer's Menu labels
  // name it, so the same screen one row up must not pick up "JVMs".
  await page.goto(`/layer/${LAYER}/instance?mode=preview&source=local`);
  await expect(page.locator('.page-heading')).toHaveCount(0, { timeout: READY });
  await expect(page.locator('.instance-bar .kicker')).not.toHaveText(/JVMs/i, { timeout: READY });
});

test('an arrangement survives closing the drag mode, and Reset undoes it', async ({ page }) => {
  await openAdmin(page, extAdmin());
  await addPage(page, 'Resource usage');

  const toggle = page.locator('.order-toggle input');
  await expect(toggle).toBeVisible({ timeout: READY });
  // A switch, not a checkbox: it turns a MODE on — rows stop being links
  // and become draggable — rather than ticking an option applied on save.
  await expect(toggle).toHaveAttribute('role', 'switch');
  const before = await labels(page, '.menu-item .menu-item-label');

  // Turning it ON stores nothing — an order identical to the built-in one
  // is still a pending change against OAP that says nothing.
  await toggle.check();
  await expect(page.locator('.order-reset')).toHaveCount(0);
  await expect
    .poll(() => labels(page, '.menu-item .menu-item-label'))
    .toEqual(before);

  // Drag the second row onto the first. Adjacent and near the top on
  // purpose: dragging across a list tall enough to scroll moves the drop
  // target out from under the pointer, and the drag silently no-ops.
  // HTML5 drag needs dragTo — synthetic mouse events never fire dragstart.
  const items = page.locator('.menu-item');
  await items.nth(1).dragTo(items.first());
  await expect
    .poll(() => labels(page, '.menu-item .menu-item-label'))
    .not.toEqual(before);

  const arranged = await labels(page, '.menu-item .menu-item-label');

  // Closing the mode KEEPS the arrangement — it ends dragging, it does
  // not discard what was dragged. Reading it as "done" and losing the
  // work is the whole reason this is a mode and not the setting.
  await toggle.uncheck();
  await expect
    .poll(() => labels(page, '.menu-item .menu-item-label'))
    .toEqual(arranged);

  // Reset is the only way back, and it takes nothing else with it.
  await page.locator('.order-reset').click();
  await expect
    .poll(() => labels(page, '.menu-item .menu-item-label'))
    .toEqual(before);
  await expect(page.locator('.order-reset')).toHaveCount(0);
  expect(await pageOptions(page)).toHaveLength(2);
});

test('deleting a page asks first, then removes it', async ({ page }) => {
  await openAdmin(page, extAdmin());
  await addPage(page, 'Resource usage');
  expect(await pageOptions(page)).toHaveLength(2); // DEFAULT + the page

  // Scoped to the page bar: a layer with no bundled counterpart renders
  // its own plain "Delete" in the header, which removes the whole draft.
  await page.locator('.page-bar').getByRole('button', { name: 'Delete', exact: true }).click();
  // Its widgets are not recoverable from the editor once the draft saves,
  // so it confirms rather than deleting on a stray click.
  await expect(page.locator('.confirm-msg')).toBeVisible({ timeout: READY });
  await page.getByRole('button', { name: 'Delete page' }).click();

  await expect.poll(() => pageOptions(page), { timeout: READY }).toHaveLength(1);
});

test('deleting the last page in preview does not resurrect it', async ({ page }) => {
  await openAdmin(page, extAdmin());
  await addPage(page, 'Resource usage');
  await page.locator('button:has-text("Save")').first().click();
  await page.goto(`/layer/${EXT_LAYER}/service/resource-usage?${PREVIEW}`);
  await expect(page.locator('.page-heading')).toHaveText('Resource usage', { timeout: READY });

  // Delete it — the LAST page, which removes the whole block from the
  // draft. Preview must still say not-found rather than falling back to
  // whatever is published.
  await openAdmin(page, extAdmin('service', 'resource-usage'));
  // Scoped to the page bar: a layer with no bundled counterpart renders
  // its own plain "Delete" in the header, which removes the whole draft.
  await page.locator('.page-bar').getByRole('button', { name: 'Delete', exact: true }).click();
  await page.getByRole('button', { name: 'Delete page' }).click();
  await expect.poll(() => pageOptions(page), { timeout: READY }).toHaveLength(1);
  await page.locator('button:has-text("Save")').first().click();

  await page.goto(`/layer/${EXT_LAYER}/service/resource-usage?${PREVIEW}`);
  await expect(page.locator('.page-missing')).toBeVisible({ timeout: READY });
});

test('turning a component off warns, then removes every trace of it from the draft', async ({ page }) => {
  await openAdmin(page, extAdmin());
  await addPage(page, 'Resource usage');

  // The Service toggle in the Components list.
  await page.getByRole('checkbox', { name: 'Service', exact: true }).uncheck();

  const msg = page.locator('.confirm-msg');
  await expect(msg).toBeVisible({ timeout: READY });
  // It names what goes, because none of it is visible again once the
  // component is off.
  await expect(msg).toContainText(/widget/i);
  await expect(msg).toContainText(/page/i);

  // Carry it THROUGH: warning about a deletion proves nothing about what
  // the deletion leaves behind, and what it leaves behind is the part
  // publish refuses.
  await page.getByRole('button', { name: 'Turn off and delete', exact: true }).click();
  await expect(msg).toBeHidden({ timeout: READY });
  await page.locator('button:has-text("Save")').first().click();
  await expect(page.locator('.sync-msg, .save-msg').first()).toBeVisible({ timeout: READY }).catch(() => {});

  // Inspect the SAVED draft, not the screen: dormant configuration is
  // invisible by definition — a grid with no row to open it and no
  // selector to delete it from.
  const draft = await page.evaluate(
    ([key, name]) => {
      const all = JSON.parse(window.localStorage.getItem(key as string) ?? '{}') as Record<string, unknown>;
      return all[name as string] ?? null;
    },
    [LOCAL_EDITS_KEY, `horizon.layer.${EXT_LAYER.toUpperCase()}`] as const,
  );
  expect(draft, 'no local draft was saved').toBeTruthy();

  const t = draft as {
    components?: Record<string, boolean>;
    dashboards?: Record<string, unknown>;
    dashboardExtPages?: Record<string, unknown>;
    dashboardDefaultFilters?: Record<string, unknown>;
    menuOrder?: string[];
    widgets?: unknown;
  };
  expect(t.components?.service).toBe(false);
  expect(t.dashboards?.service, 'the service grid survived').toBeUndefined();
  expect(t.dashboardExtPages?.service, 'the service pages survived').toBeUndefined();
  expect(t.dashboardDefaultFilters?.service, 'the default-page filter survived').toBeUndefined();
  expect(t.widgets, 'the legacy flat grid survived').toBeUndefined();
  expect(
    (t.menuOrder ?? []).filter((p) => p === 'service' || p.startsWith('service/')),
    'menu-order entries for the removed component survived',
  ).toEqual([]);

  // Another component is untouched — the removal is scoped, not a purge.
  expect(t.components?.instances).toBe(true);
});

test('an extension-page row shows active in the live menu preview', async ({ page }) => {
  await openAdmin(page, extAdmin());
  await addPage(page, 'Resource usage');

  // The row for the page being edited must highlight. A row that can never
  // light up reads as inert even when clicking it works.
  const active = page.locator('.menu-item.on');
  await expect(active).toHaveCount(1, { timeout: READY });
  await expect(active).toContainText('Resource usage');

  // And a row with no editable configuration is disabled rather than a
  // live button that does nothing.
  const inert = page.locator('.menu-item.is-inert').first();
  if (await inert.count()) await expect(inert).toBeDisabled();
});

test('the RUNTIME sidebar row for a page shows active on it', async ({ page }) => {
  // The admin preview asserts the editor's own jump-list. This asserts the
  // sidebar an operator actually navigates — a different component with
  // its own active rule, and the one that decides whether a page reads as
  // the current location.
  await openAdmin(page);
  await addPage(page, 'Resource usage');
  await page.locator('button:has-text("Save")').first().click();
  await page.goto(`/layer/${LAYER}/service/resource-usage?mode=preview&source=local`);
  await expect(page.locator('.layer-children a').first()).toBeVisible({ timeout: READY });

  const active = page.locator('.layer-children a.is-active');
  // Exactly one row, and it is the page's. Flat siblings must match the
  // route EXACTLY or `/service/resource-usage` also lights up the Service
  // row it sits beside — the two would then both read as current.
  await expect(active).toHaveCount(1, { timeout: READY });
  await expect(active).toHaveAttribute('href', `/layer/${LAYER}/service/resource-usage`);
});

test('a page renders its own widgets, not the default grid', async ({ page }) => {
  await openAdmin(page, extAdmin());
  await addPage(page, 'Resource usage');
  // Give the page one real widget through the canvas, so the assertion is
  // about rendered metrics rather than an empty grid.
  await page.getByRole('button', { name: /Add widget/i }).first().click();
  // The picker opens a grouped menu; take the Line kind by its own row.
  await page.locator('.add-menu').getByText('Line', { exact: false }).first().click();
  await expect(page.locator('.canvas-widget')).toHaveCount(1, { timeout: READY });
  await page.locator('button:has-text("Save")').first().click();

  await page.goto(`/layer/${EXT_LAYER}/service/resource-usage?${PREVIEW}`);
  await expect(page.locator('.page-heading')).toHaveText('Resource usage', { timeout: READY });
  // One widget here, against the default grid's many — proof the page's
  // own set is what rendered.
  await expect(page.locator('.widget')).toHaveCount(1, { timeout: READY });
});

/**
 * The Translations page is conditional on the PUBLISHED template, not on a
 * local draft — it reads what OAP serves, so a page that exists only in
 * this browser's draft correctly has no Page picker.
 *
 * Translating a page end to end therefore needs a pushed template, which
 * this suite deliberately never does: it stays draft-local so it cannot
 * race the cases that own OAP's state. The path addressing that carries
 * the risk — writing a page's text to the wrong prefix — is covered by
 * unit tests instead.
 */
test('the translations page has no Page picker for a layer with no published pages', async ({
  page,
  pageErrors,
}) => {
  await page.goto('/admin/translations');
  await expect(page.locator('.tv')).toBeVisible({ timeout: READY });

  // The Component and Page pickers are Layer-only, so switch Kind first —
  // asserting on them under the default Overview kind would pass for the
  // wrong reason.
  await page.locator('label:has-text("Kind") .tas__trigger').click();
  await page.getByRole('option', { name: 'Layer' }).click();
  await expect(page.locator('label:has-text("Component") .tas__trigger')).toBeVisible({
    timeout: READY,
  });

  // Component is there and Page is not: the absence is a real condition,
  // not a selector that never matches.
  await expect(page.locator('label:has-text("Page") .tas__trigger')).toHaveCount(0);

  expect(pageErrors).toEqual([]);
});

/**
 * The compatibility gate this suite is held to, asserted rather than
 * assumed.
 *
 * Cases needing a live roster author on the fixture layer, because a
 * disposable layer is injected browser-side and OAP reports no services
 * for it. Two things keep that safe, and only the second is visible: the
 * `beforeEach` above fails the run if anything reaches the push route,
 * and the stored template is still what OAP shipped.
 */
test('the suite leaves the bundled template on OAP untouched', async ({ request }) => {
  const status = await request.get('/api/admin/templates/sync-status');
  expect(status.ok(), 'sync-status unreachable — cannot prove the template is intact').toBe(true);
  const body = (await status.json()) as {
    rows: Array<{ name: string; status: string; effective?: string }>;
  };
  const row = body.rows.find((r) => r.name === `horizon.layer.${LAYER.toUpperCase()}`);
  expect(row, `no stored row for ${LAYER}`).toBeTruthy();
  // `diverged` is the state that would mean this suite wrote to it.
  expect(row!.status).not.toBe('diverged');
});
