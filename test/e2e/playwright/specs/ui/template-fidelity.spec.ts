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

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { test, expect } from '../support/diagnostics.js';
import { LAYER } from '../fixture.js';

// Layer dashboards are DECLARED, not coded: a JSON template says which
// widgets exist, what graph form each takes, and how wide it sits. The
// renderer is generic, so nothing in the app fails loudly when the two drift
// — a widget whose type stops dispatching just renders as an empty box, and a
// span that stops applying just looks slightly wrong.
//
// This spec treats the template as the SPEC and the DOM as the RESULT: every
// widget the template declares must appear, with the right title, dispatched
// to the right graph form, at the declared width. It is the one assertion in
// the suite that scales automatically — add a widget to a bundled template
// and this covers it without a new test.
//
// The template is read from the repo rather than fetched. In `live` mode the
// rendered dashboard comes from OAP, seeded from this same bundle at boot, so
// a mismatch here is also a seed-and-read failure — which is worth catching.

const here = dirname(fileURLToPath(import.meta.url));
const TEMPLATES = resolve(here, '../../../../../apps/bff/src/bundled_templates/layers');

interface Widget {
  id: string;
  title: string;
  type: string;
  span?: number;
  rowSpan?: number;
  /** Present when the widget only shows for entities that have the metric. */
  visibleWhen?: unknown;
}

function widgetsOf(layer: string, scope: string): Widget[] {
  const raw = JSON.parse(readFileSync(resolve(TEMPLATES, `${layer}.json`), 'utf8'));
  return (raw.dashboards?.[scope] ?? []) as Widget[];
}

/**
 * Widgets that must render for THIS fixture's entities.
 *
 * `visibleWhen` is evaluated BFF-side per entity: a required widget is dropped
 * from the response entirely when the entity lacks the metric. general's
 * endpoint scope carries "MQ Avg Consuming Latency", required on
 * `endpoint_mq_consume_latency` existing — the demo app serves HTTP, so it is
 * correctly absent. Asserting it would fail on a healthy build.
 *
 * Conditional widgets are therefore excluded from the count and the per-widget
 * checks. Everything ungated must appear.
 */
function unconditional(widgets: Widget[]): Widget[] {
  return widgets.filter((w) => w.visibleWhen === undefined);
}

/**
 * What each graph form puts on screen when it HAS data.
 *
 * A tile can carry the right type class and render nothing at all, which is
 * the failure an operator reads as "no data" — so each form names the element
 * that proves the branch actually rendered.
 */
const RENDERED_AS: Record<string, string> = {
  line: '.time-chart',
  top: '.top-list',
  record: '.record-list',
  // A card renders `.card-value > .num`, or `.card-chips` when the widget
  // declares valueColors — both are the card branch, neither is `.value`.
  card: '.card-value, .card-chips',
  table: '.tw__table',
};

/**
 * Forms whose data THIS fixture guarantees, so an empty tile is a defect.
 *
 * The others may legitimately be empty: `record` on general.service is "Slow
 * Database Statements", and the demo app's H2 queries are not slow — so the
 * widget correctly renders an explicit "no data" instead. Requiring content
 * there would fail on a healthy build; requiring NOTHING would miss a widget
 * that renders neither. Hence the split.
 */
const FIXTURE_GUARANTEES_DATA = new Set(['line', 'top']);

/**
 * How a widget says "I have nothing to show" — a legitimate outcome.
 *
 * The class alone is NOT the signal. A widget body renders `.muted` for three
 * different outcomes: the query's error message, a transient `loading…`, and
 * the genuine `no data`. Accepting the class accepted all three, so a widget
 * whose query FAILED — the one outcome this assertion exists to reject —
 * counted as a legitimate empty state. The text is what separates them.
 */
const EMPTY_STATE = '.muted, .empty';
const NO_DATA = /^no data$/i;

async function assertScopeMatchesTemplate(page: Page, scope: string, path: string) {
  const declared = unconditional(widgetsOf(LAYER, scope));
  expect(declared.length, `${LAYER}.${scope} declares no widgets — wrong fixture?`).toBeGreaterThan(
    0,
  );

  await page.goto(path);
  await expect(page.locator('.widget').first()).toBeVisible({ timeout: 45_000 });
  // Settle the grid before measuring: the count is read after layout, not
  // mid-render.
  await expect
    .poll(async () => page.locator('.widget').count(), { timeout: 45_000 })
    .toBeGreaterThanOrEqual(declared.length);

  for (const w of declared) {
    // Scoped to the widget's OWN head title. Matching the text anywhere
    // inside `.widget` picks the wrong tile: a top-list widget carries tab
    // labels like "Traffic" and "Slow", which collide with other widgets'
    // titles.
    const tile = page
      .locator('.widget')
      .filter({ has: page.locator('.w-head-title').getByText(w.title, { exact: true }) })
      .first();
    await expect(tile, `widget "${w.title}" is declared but not rendered`).toBeVisible();

    // The type class is how the renderer records which branch it dispatched
    // to. A widget that fell through renders a box with the wrong class.
    await expect(
      tile.locator('.w-body'),
      `widget "${w.title}" should render as type ${w.type}`,
    ).toHaveClass(new RegExp(`\\btype-${w.type}\\b`));

    const proof = RENDERED_AS[w.type];
    if (proof) {
      if (FIXTURE_GUARANTEES_DATA.has(w.type)) {
        await expect(
          tile.locator(proof).first(),
          `widget "${w.title}" (${w.type}) carries the type class but rendered nothing`,
        ).toBeVisible();
      } else {
        // Content OR an explicit "no data" — never neither, and never an
        // error. The widget's own error text is returned rather than swallowed
        // so the failure names the OAP problem instead of just the tile.
        const body = tile.locator('.w-body');
        await expect
          .poll(
            async () => {
              if (
                await body
                  .locator(proof)
                  .first()
                  .isVisible()
                  .catch(() => false)
              ) {
                return 'content';
              }
              const text =
                (
                  await body
                    .locator(EMPTY_STATE)
                    .first()
                    .textContent()
                    .catch(() => null)
                )?.trim() ?? '';
              if (NO_DATA.test(text)) return 'no data';
              return text === '' ? 'nothing rendered' : text;
            },
            {
              timeout: 45_000,
              message: `widget "${w.title}" (${w.type}) rendered neither content nor "no data"`,
            },
          )
          .toMatch(/^(content|no data)$/);
      }
    }

    // Layout comes from the template too. `span` is grid columns; if it stops
    // applying, every tile silently collapses to the default width.
    if (w.span) {
      const gridColumn = await tile.evaluate((el) => getComputedStyle(el).gridColumn);
      expect(gridColumn, `widget "${w.title}" should span ${w.span} columns`).toContain(
        `span ${w.span}`,
      );
    }
  }
}

test('the service dashboard renders exactly what its template declares', async ({
  page,
  pageErrors,
}) => {
  // general.service is the richest scope this fixture populates: line, top
  // and record forms together.
  await assertScopeMatchesTemplate(page, 'service', `/layer/${LAYER}/service`);
  expect(pageErrors).toEqual([]);
});

test('the endpoint dashboard renders exactly what its template declares', async ({
  page,
  pageErrors,
}) => {
  await assertScopeMatchesTemplate(page, 'endpoint', `/layer/${LAYER}/endpoint`);
  expect(pageErrors).toEqual([]);
});

test('the instance dashboard renders exactly what its template declares', async ({
  page,
  pageErrors,
}) => {
  // The biggest scope by far — general.instance declares 68 widgets, mostly
  // JVM. Worth the runtime because it is the only scope where the grid is
  // large enough for a layout regression to show up as something other than
  // a rounding difference, and because instance metrics are a DIFFERENT OAP
  // scope: querying the wrong one returns empty rather than erroring, so a
  // scope mix-up renders 68 correctly-shaped empty tiles.
  test.slow();
  await assertScopeMatchesTemplate(page, 'instance', `/layer/${LAYER}/instance`);

  // `unconditional()` excludes every `visibleWhen` widget from the checks
  // above, which on this scope is 71 of 74 — so without the next assertion the
  // richest scope in the product proves three tiles, and the runtime gating
  // itself is verified nowhere.
  //
  // The gate is asserted DIRECTIONALLY rather than by pinning a metric: the
  // fixture's instance runs a Java agent, so widgets gated on a `jvm_*` metric
  // belong on this page and widgets gated on a `nodejs_*` one do not. That
  // catches a gate stuck open (every runtime's widgets render) and a gate
  // stuck shut (none do), without depending on which JVM metric has landed by
  // the time the page loads — which §7 warns is timing, not correctness.
  const gated = widgetsOf(LAYER, 'instance').filter((w) => w.visibleWhen !== undefined);
  const titlesFor = (family: RegExp): string[] =>
    gated
      .filter((w) => family.test(JSON.stringify(w.visibleWhen)))
      .map((w) => w.title)
      .filter((t): t is string => typeof t === 'string' && t.length > 0);

  const jvmTitles = titlesFor(/jvm/i);
  const nodeTitles = titlesFor(/nodejs/i);
  expect(jvmTitles.length, 'the instance template no longer declares JVM-gated widgets').toBeGreaterThan(0);
  expect(nodeTitles.length, 'the instance template no longer declares Node.js-gated widgets').toBeGreaterThan(0);

  const shown = async (titles: string[]): Promise<number> => {
    let n = 0;
    for (const t of titles) if (await page.getByText(t, { exact: true }).count()) n += 1;
    return n;
  };
  expect(
    await shown(jvmTitles),
    'no JVM-gated widget rendered for a Java instance — the visibleWhen gate is stuck shut',
  ).toBeGreaterThan(0);
  expect(
    await shown(nodeTitles),
    'a Node.js-gated widget rendered for a Java instance — the visibleWhen gate is stuck open',
  ).toBe(0);

  expect(pageErrors).toEqual([]);
});

// A guard on the SPEC, not the product — so it is NOT a test. Every case here
// costs a browser and a full OAP + BanyanDB stack, and this needs neither: it
// reads two JSON files. It runs at module load, so an uncovered widget form
// fails the whole file immediately rather than posing as a passing e2e case.
//
// What it protects: if a bundled template starts using a form the fixture
// never renders, the assertions above quietly stop covering it. This turns
// that into a decision rather than an accident.
{
  const covered = new Set(
    ['service', 'endpoint', 'instance']
      .flatMap((scope) => unconditional(widgetsOf(LAYER, scope)))
      .map((w) => w.type),
  );
  for (const type of covered) {
    if (!RENDERED_AS[type]) {
      throw new Error(
        `template-fidelity: no rendered-proof defined for widget type "${type}" — add one to RENDERED_AS or the assertions silently stop covering it`,
      );
    }
  }
  // `card` and `table` are not reachable from this fixture: general declares
  // neither. They live in the Kubernetes layers — k8s.service carries 8 card
  // and 6 table widgets, k8s_service 2 more tables — so coverage arrives with
  // the planned k8s monitoring case, which shares its cluster fixture with
  // the istio / rover work. Until then this keeps the omission visible rather
  // than letting it pass as covered.
  for (const form of ['line', 'top']) {
    if (!covered.has(form)) {
      throw new Error(`template-fidelity: the fixture no longer renders any "${form}" widget`);
    }
  }
}
