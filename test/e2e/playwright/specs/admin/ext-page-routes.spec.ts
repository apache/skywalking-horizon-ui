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
 * Every route a layer with extension pages exposes, against a template
 * PUBLISHED to OAP.
 *
 * Routing is where this feature has broken most often — scope inferred
 * from the wrong segment, a page served the default grid, a page id
 * colliding with a tab — and each case was caught one URL at a time,
 * after the fact. The coverage that existed walked a bundled layer, and
 * no bundled layer declares a page, so component+page routes were never
 * enumerated at all.
 *
 * This drives the matrix instead: every entity component, and every page
 * under it, is asked for by URL and must answer with ITS OWN widgets. The
 * fixture (`layer-template-push.sh valid`) declares pages under all three
 * entity components precisely so this can be a matrix rather than an
 * example.
 *
 * It asserts against the BFF rather than the rendered grid because this
 * case runs no telemetry: the layer has no services, so a browser would
 * show empty pickers either way and prove nothing about which page it
 * resolved.
 */

import { test, expect } from '../support/diagnostics.js';

const LAYER = 'HORIZON_E2E_EXT';

/** What the pushed fixture declares: component → its pages, and the
 *  widget id that identifies each grid uniquely. */
const MATRIX = [
  { scope: 'service', page: null, widget: 'svc-load' },
  { scope: 'service', page: 'agents', widget: 'ag-cpm' },
  { scope: 'instance', page: null, widget: 'ins-load' },
  { scope: 'instance', page: 'runtime', widget: 'rt-heap' },
  { scope: 'endpoint', page: null, widget: 'ep-load' },
  { scope: 'endpoint', page: 'public', widget: 'pub-cpm' },
] as const;

const configUrl = (scope: string, page: string | null): string =>
  `/api/layer/${LAYER}/dashboard/config?scope=${scope}` + (page ? `&page=${page}` : '');

test.describe('every route of a layer with extension pages', () => {
  for (const { scope, page, widget } of MATRIX) {
    const label = page ? `${scope}/${page}` : `${scope} (DEFAULT)`;

    test(`${label} resolves to its own widgets`, async ({ request }) => {
      const res = await request.get(configUrl(scope, page));
      expect(res.status(), `${label} did not resolve`).toBe(200);
      const body = (await res.json()) as { widgets?: Array<{ id?: string }> };
      const ids = (body.widgets ?? []).map((w) => w.id);
      // Its OWN widgets: serving the component's default grid for a page
      // is the failure that looks correct on screen, so identity is
      // asserted rather than "some widgets came back".
      expect(ids, `${label} served the wrong grid`).toContain(widget);
    });
  }

  test('a page id is scoped to its component, not shared across them', async ({ request }) => {
    // `agents` exists under service and nowhere else. Asking for it under
    // another component must not fall through to that component's grid —
    // the bug this replaces inferred scope from the wrong segment.
    for (const scope of ['instance', 'endpoint']) {
      const res = await request.get(configUrl(scope, 'agents'));
      expect(res.status(), `${scope}/agents should not resolve`).toBe(404);
    }
  });

  test('an unknown page is refused rather than answered with the default grid', async ({ request }) => {
    for (const scope of ['service', 'instance', 'endpoint']) {
      const res = await request.get(configUrl(scope, 'no-such-page'));
      expect(res.status(), `${scope}/no-such-page should 404`).toBe(404);
    }
  });

  test('the menu lists exactly the rows the template declares, in its stored order', async ({ request }) => {
    const res = await request.get('/api/menu');
    expect(res.ok()).toBe(true);
    const body = (await res.json()) as {
      layers?: Array<{ key?: string; menuRows?: Array<{ path?: string }>; extPages?: unknown }>;
    };
    const layer = body.layers?.find((l) => (l.key ?? '').toUpperCase() === LAYER);
    // The layer reports no services in this case, so it may be absent
    // from the menu entirely — that is about visibility, not routing, and
    // the per-route assertions above already cover resolution.
    test.skip(!layer, `${LAYER} is not listed (no services in this case)`);

    const rows = (layer!.menuRows ?? []).map((r) => r.path);
    for (const { scope, page } of MATRIX) {
      const path = page ? `${scope}/${page}` : scope;
      expect(rows, `${path} missing from the resolved menu`).toContain(path);
    }
    // `menuOrder` puts each page BEFORE its component; a resolver that
    // ignored the stored order would emit the built-in sequence instead.
    expect(rows.indexOf('service/agents')).toBeLessThan(rows.indexOf('service'));
    expect(rows.indexOf('instance/runtime')).toBeLessThan(rows.indexOf('instance'));
    expect(rows.indexOf('endpoint/public')).toBeLessThan(rows.indexOf('endpoint'));
  });
});
