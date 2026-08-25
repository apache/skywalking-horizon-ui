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
 * How a dashboard URL resolves to (scope, page).
 *
 * The rule this replaces inferred scope by testing whether the path ENDED
 * WITH a known segment. A page id defeats that — `/layer/K/instance/runtime`
 * ends with neither `instance` nor anything else known — so the view fell
 * through to `service` and would have queried Service-scope metrics on an
 * Instance page. That renders a full, plausible, wrong grid, which is why
 * the resolution is asserted here rather than left to the e2e suite.
 */

import { describe, it, expect } from 'vitest';
import router from '@/shell/router/index';
import { resolveLayerMenuRows } from '@skywalking-horizon-ui/api-client';

function resolve(path: string): { scope: unknown; pageId: unknown } {
  const r = router.resolve(path);
  return { scope: r.meta.dashboardScope, pageId: r.params.pageId };
}

describe('entity dashboard routes', () => {
  it.each([
    ['/layer/general/service', 'service'],
    ['/layer/general/instance', 'instance'],
    ['/layer/general/endpoint', 'endpoint'],
  ])('%s resolves scope %s with no page', (path, scope) => {
    const r = resolve(path);
    expect(r.scope).toBe(scope);
    expect(r.pageId).toBeUndefined();
  });

  it.each([
    ['/layer/general/service/resource', 'service', 'resource'],
    ['/layer/general/instance/runtime', 'instance', 'runtime'],
    ['/layer/general/endpoint/detail', 'endpoint', 'detail'],
  ])('%s resolves scope %s and page %s', (path, scope, pageId) => {
    const r = resolve(path);
    expect(r.scope).toBe(scope);
    expect(r.pageId).toBe(pageId);
  });

  it('carries scope on the record, so a page id cannot change it', () => {
    // The exact shape the old endsWith rule got wrong: a second segment
    // named after another scope must not re-point the page.
    expect(resolve('/layer/general/instance/service').scope).toBe('instance');
    expect(resolve('/layer/general/service/instance').scope).toBe('service');
  });

  it('does not swallow a component tab that has its own view', () => {
    // `/topology` is a sibling route, not a Service page called "topology".
    const r = resolve('/layer/general/topology');
    expect(r.scope).toBeUndefined();
    expect(r.pageId).toBeUndefined();
  });

  it('keeps the bare layer path free of a scope', () => {
    expect(resolve('/layer/general').scope).toBeUndefined();
  });
});

/**
 * The redirects and fallbacks around those records.
 *
 * Route-record parsing alone says nothing about what an operator lands on:
 * the bare-layer redirect, the unsupported-route fallback and the
 * not-found presentation are all decided after the record matches.
 */
describe('bare and unsupported layer routes', () => {
  it('leaves the bare layer path with no scope, for the shell to resolve', () => {
    // Deliberately NOT a static redirect to /service: which row a layer
    // opens on depends on its resolved rows, which the router cannot see.
    const r = router.resolve('/layer/general');
    expect(r.meta.dashboardScope).toBeUndefined();
    expect(r.matched.length).toBeGreaterThan(0);
  });

  it('matches a page route case-insensitively on the layer key', () => {
    // Menu keys are lower-case; a hand-typed URL may not be.
    const upper = router.resolve('/layer/GENERAL/service/resource');
    expect(upper.meta.dashboardScope).toBe('service');
    expect(upper.params.pageId).toBe('resource');
  });

  it('keeps every built-in tab reachable as its own record', () => {
    for (const tab of ['topology', 'trace', 'logs', 'pprof', 'pod-logs', 'zipkin-trace']) {
      const r = router.resolve(`/layer/general/${tab}`);
      expect(r.matched.length, `${tab} has no route`).toBeGreaterThan(0);
      // And none of them is mistaken for a Service page.
      expect(r.params.pageId).toBeUndefined();
    }
  });

  it('does not treat a second segment under a non-entity tab as a page', () => {
    // `/topology/anything` is not a topology page — only the three entity
    // components carry pages.
    expect(router.resolve('/layer/general/topology/x').params.pageId).toBeUndefined();
  });
});

/**
 * Only the three ENTITY components have pages, because only they have a
 * widget grid. A stray segment under any other tab is not a page — it is
 * an unknown URL, and must reach the app's not-found route rather than
 * rendering an empty layer body.
 */
describe('stray segments under non-entity tabs', () => {
  it.each(['topology', 'trace', 'logs', 'pprof', 'deployment', 'dependency'])(
    '/%s/anything is not a page route',
    (tab) => {
      const r = router.resolve(`/layer/general/${tab}/anything`);
      expect(r.params.pageId).toBeUndefined();
      expect(r.meta.dashboardScope).toBeUndefined();
    },
  );

  it.each(['topology', 'trace', 'logs'])('/%s/anything falls through to the catch-all', (tab) => {
    // Not the layer shell with an empty outlet: that renders the layer
    // chrome around nothing, which reads as a broken page rather than a
    // wrong address.
    const r = router.resolve(`/layer/general/${tab}/anything`);
    expect(r.matched.map((m) => m.path)).toContain('/:catchAll(.*)*');
  });
});

/**
 * The route matrix, driven from the resolver rather than from a list a
 * reader maintains by hand.
 *
 * Routing has broken here more than anywhere else in this feature, and
 * always the same way: a path that LOOKS handled resolving to the wrong
 * scope or the wrong page. Every row the resolver emits for a layer that
 * declares pages under all three entity components is asserted to reach a
 * route with exactly that (scope, pageId) — so a new row cannot be added
 * without a route that answers it.
 */
describe('every resolved menu row maps to a route with the right scope and page', () => {
  const LAYER_WITH_PAGES = {
    // `dashboards` is the service row's flag — `components.service` maps
    // to it. Naming it `service` here silently produced a layer with no
    // service row, and with it no service PAGES.
    caps: { dashboards: true, instances: true, endpoints: true },
    slots: {},
    extPages: {
      service: [{ id: 'agents', name: 'Agents' }],
      instance: [{ id: 'runtime', name: 'Runtime' }],
      endpoint: [{ id: 'public', name: 'Public API' }],
    },
  };

  const rows = resolveLayerMenuRows(LAYER_WITH_PAGES).map((r) => r.path);

  it('emits a row for each component AND each of its pages', () => {
    for (const p of ['service', 'service/agents', 'instance', 'instance/runtime', 'endpoint', 'endpoint/public']) {
      expect(rows, `${p} is not a resolved row`).toContain(p);
    }
  });

  it.each(['service', 'instance', 'endpoint'])('%s resolves to itself with no page', (scope) => {
    const r = resolve(`/layer/k/${scope}`);
    expect(r.scope).toBe(scope);
    expect(r.pageId).toBeFalsy();
  });

  it.each([
    ['service', 'agents'],
    ['instance', 'runtime'],
    ['endpoint', 'public'],
  ])('%s/%s keeps its component scope and carries its page id', (scope, page) => {
    const r = resolve(`/layer/k/${scope}/${page}`);
    // Both halves matter: the scope decides which metrics are queried and
    // the page decides which widgets — getting either wrong renders a
    // full, plausible, wrong grid.
    expect(r.scope).toBe(scope);
    expect(r.pageId).toBe(page);
  });

  it('routes every row the resolver emits, with nothing left unhandled', () => {
    for (const row of rows) {
      const [scope, pageId] = row.split('/');
      const r = resolve(`/layer/k/${row}`);
      if (['service', 'instance', 'endpoint'].includes(scope!)) {
        expect(r.scope, `${row} resolved to the wrong scope`).toBe(scope);
        expect(r.pageId ?? undefined, `${row} lost its page id`).toBe(pageId);
      } else {
        // A non-entity row carries no dashboard scope, but must still be
        // a route rather than falling through to the layer shell.
        expect(router.resolve(`/layer/k/${row}`).matched.length, `${row} matched no route`).toBeGreaterThan(0);
      }
    }
  });
});

/**
 * `/zipkin-trace` is reachable on a layer that exposes no row for it.
 *
 * The row exists only when a layer carries BOTH trace formats and needs
 * two tabs. A pure-zipkin layer (mesh, k8s) shows one Traces row that
 * embeds the same explorer — but the standalone URL still opens it in
 * full, which is how the istio suite drives it. The predicate this
 * feature replaced had no entry for the path, so it never redirected;
 * resolving reachability from rows alone silently took that away, and the
 * URL landed on the embedded view, which has no toolbar of its own.
 */
describe('a route the layer exposes no row for', () => {
  const pureZipkin = {
    key: 'MESH',
    caps: { dashboards: true, traces: true },
    slots: {},
    traces: { source: 'zipkin' as const },
  };

  it('gives a pure-zipkin layer one Traces row, not two', () => {
    const rows = resolveLayerMenuRows(pureZipkin).map((r) => r.path);
    expect(rows).toContain('trace');
    expect(rows).not.toContain('zipkin-trace');
  });

  it('emits the second row only when the layer carries both formats', () => {
    const both = { ...pureZipkin, traces: { source: 'both' as const } };
    expect(resolveLayerMenuRows(both).map((r) => r.path)).toContain('zipkin-trace');
  });

  it('still routes /zipkin-trace, so the standalone explorer has a URL', () => {
    // The route record must exist regardless of the row — this is what the
    // shell's fallback has to leave alone.
    expect(router.resolve('/layer/mesh/zipkin-trace').matched.length).toBeGreaterThan(0);
  });
});
