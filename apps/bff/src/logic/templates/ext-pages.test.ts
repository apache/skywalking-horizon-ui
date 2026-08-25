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

/** `dashboardExtPages` — the schema bars and the page-resolution rules. */

import { describe, it, expect } from 'vitest';
import { layerTemplateSchema, layerTemplatePushSchema, layerCrossRefIssues } from './bundled-schema.js';
import { MAX_EXT_PAGE_ID_LENGTH, MAX_EXT_PAGE_NAME_LENGTH } from '@skywalking-horizon-ui/api-client';
import {
  resolveExtPage,
  widgetsForScope,
  widgetsForScopePage,
  extPagesForScope,
  allWidgetsForScope,
  type LayerTemplate,
} from '../layers/loader.js';

const widget = (id: string) => ({ id, type: 'line' as const, title: id, expressions: ['x'] });

/** A minimal template that passes the bundled (complete) bar. */
function tpl(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    key: 'CUSTOM_MQ',
    slots: { services: 'Services' },
    components: { service: true, instances: true },
    dashboards: { service: [widget('svc-a')] },
    ...over,
  };
}

const page = (over: Record<string, unknown> = {}) => ({
  id: 'resource',
  name: 'Resource usage',
  widgets: [widget('res-a')],
  ...over,
});

function crossRefs(t: Record<string, unknown>): string[] {
  const parsed = layerTemplatePushSchema.safeParse(t);
  if (!parsed.success) return parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
  return layerCrossRefIssues(parsed.data, { complete: true }).map((i) => `${i.path}: ${i.message}`);
}

describe('dashboardExtPages — schema', () => {
  it('accepts a template with no extension pages at all (every bundled layer)', () => {
    expect(layerTemplateSchema.safeParse(tpl()).success).toBe(true);
  });

  it('accepts pages on all three entity components at once', () => {
    const t = tpl({
      components: { service: true, instances: true, endpoints: true },
      dashboards: { service: [widget('a')], instance: [widget('b')], endpoint: [widget('c')] },
      dashboardExtPages: {
        service: [page({ id: 'one', widgets: [widget('s1')] })],
        instance: [page({ id: 'two', widgets: [widget('i1')] })],
        endpoint: [page({ id: 'three', widgets: [widget('e1')] })],
      },
    });
    expect(layerTemplateSchema.safeParse(t).success).toBe(true);
    expect(crossRefs(t)).toEqual([]);
  });

  it('rejects a page under a scope that cannot carry pages', () => {
    const r = layerTemplateSchema.safeParse(tpl({ dashboardExtPages: { topology: [page()] } }));
    expect(r.success).toBe(false);
  });

  it.each([
    ['Uppercase', 'Resource'],
    ['a leading hyphen', '-resource'],
    ['a slash', 'a/b'],
    ['an underscore', 'a_b'],
    ['an empty string', ''],
  ])('rejects a page id with %s', (_why, id) => {
    const r = layerTemplateSchema.safeParse(tpl({ dashboardExtPages: { service: [page({ id })] } }));
    expect(r.success).toBe(false);
  });

  it.each(['service', 'instance', 'zipkin-trace', 'pprof', 'pod-logs', 'continuous-profiling'])(
    'rejects the page id %s because it collides with a built-in tab',
    (id) => {
      const r = layerTemplateSchema.safeParse(tpl({ dashboardExtPages: { service: [page({ id })] } }));
      expect(r.success).toBe(false);
      const msg = r.success ? '' : r.error.issues.map((i) => i.message).join(' ');
      expect(msg).toContain('built-in layer tab');
    },
  );

  it('rejects a blank name at BOTH bars, unlike other work-in-progress holes', () => {
    // A page's name is its sidebar row. The push bar tolerates an empty
    // MQE or an unfilled metric because those degrade to one dead widget;
    // an empty name ships a row nobody can read or click.
    const t = tpl({ dashboardExtPages: { service: [page({ name: '' })] } });
    expect(layerTemplateSchema.safeParse(t).success).toBe(false);
    expect(layerTemplatePushSchema.safeParse(t).success).toBe(false);
  });

  it('still tolerates a blank MQE in a page widget at the push bar', () => {
    // The relaxation that DOES apply to pages: "Add widget" seeds an empty
    // expression, and publishing that is ordinary work in progress.
    const t = tpl({
      dashboardExtPages: {
        service: [page({ widgets: [{ id: 'w', type: 'line', title: 'W', expressions: [''] }] })],
      },
    });
    expect(layerTemplatePushSchema.safeParse(t).success).toBe(true);
  });

  it('allows two pages to share a display name — identity is the id', () => {
    const t = tpl({
      dashboardExtPages: {
        service: [
          page({ id: 'a', name: 'Same', widgets: [widget('w1')] }),
          page({ id: 'b', name: 'Same', widgets: [widget('w2')] }),
        ],
      },
    });
    expect(layerTemplateSchema.safeParse(t).success).toBe(true);
    expect(crossRefs(t)).toEqual([]);
  });

  it('caps a component at 12 extension pages', () => {
    const many = (n: number) =>
      Array.from({ length: n }, (_, i) => page({ id: `p${i}`, widgets: [widget(`w${i}`)] }));
    expect(layerTemplateSchema.safeParse(tpl({ dashboardExtPages: { service: many(12) } })).success).toBe(true);
    expect(layerTemplateSchema.safeParse(tpl({ dashboardExtPages: { service: many(13) } })).success).toBe(false);
  });

  it('rejects an unknown field on a page', () => {
    const r = layerTemplateSchema.safeParse(tpl({ dashboardExtPages: { service: [page({ colour: 'red' })] } }));
    expect(r.success).toBe(false);
  });
});

describe('dashboardExtPages — cross-reference rules', () => {
  it('reports a duplicate page id within one component', () => {
    const issues = crossRefs(
      tpl({
        dashboardExtPages: {
          service: [page({ id: 'dup', widgets: [widget('w1')] }), page({ id: 'dup', widgets: [widget('w2')] })],
        },
      }),
    );
    expect(issues.join(' ')).toContain('duplicate page id "dup"');
  });

  it('lets the same page id live under two different components', () => {
    const t = tpl({
      components: { service: true, instances: true },
      dashboards: { service: [widget('a')], instance: [widget('b')] },
      dashboardExtPages: {
        service: [page({ id: 'detail', widgets: [widget('s1')] })],
        instance: [page({ id: 'detail', widgets: [widget('i1')] })],
      },
    });
    expect(crossRefs(t)).toEqual([]);
  });

  it('reports a widget id colliding with the LEGACY flat widget list', () => {
    // `widgets` is the service grid for a template that never split, so a
    // page reusing one of those ids is the same collision.
    const issues = crossRefs(
      tpl({ dashboards: undefined, widgets: [widget('legacy')], dashboardExtPages: { service: [page({ widgets: [widget('legacy')] })] } }),
    );
    expect(issues.join(' ')).toContain('already exists in widgets');
  });

  it('names where a colliding id was FIRST seen, not its own repeat', () => {
    const issues = crossRefs(
      tpl({
        dashboards: { service: [widget('dup'), widget('dup')] },
        dashboardExtPages: { service: [page({ widgets: [widget('dup')] })] },
      }),
    );
    expect(issues.join(' ')).toContain('already exists in dashboards.service');
  });

  it('reports a widget id colliding with the component default page', () => {
    const issues = crossRefs(
      tpl({
        dashboards: { service: [widget('shared')] },
        dashboardExtPages: { service: [page({ widgets: [widget('shared')] })] },
      }),
    );
    expect(issues.join(' ')).toContain('already exists in dashboards.service');
  });

  it('reports a widget id colliding between two extension pages', () => {
    const issues = crossRefs(
      tpl({
        dashboardExtPages: {
          service: [
            page({ id: 'one', widgets: [widget('dup')] }),
            page({ id: 'two', widgets: [widget('dup')] }),
          ],
        },
      }),
    );
    expect(issues.join(' ')).toContain('already exists in dashboardExtPages.service.0');
  });

  it('finds a collision nested inside a tab panel', () => {
    const issues = crossRefs(
      tpl({
        dashboards: { service: [widget('leaf')] },
        dashboardExtPages: {
          service: [
            page({
              widgets: [
                {
                  id: 'group',
                  type: 'tab',
                  title: 'T',
                  expressions: [],
                  tabs: [{ name: 'A', widgets: [widget('leaf')] }],
                },
              ],
            }),
          ],
        },
      }),
    );
    expect(issues.join(' ')).toContain('widget id "leaf"');
  });

  it('lets Service and Instance reuse one widget id', () => {
    const t = tpl({
      components: { service: true, instances: true },
      dashboards: { service: [widget('a')], instance: [widget('b')] },
      dashboardExtPages: {
        service: [page({ id: 'one', widgets: [widget('same')] })],
        instance: [page({ id: 'two', widgets: [widget('same')] })],
      },
    });
    expect(crossRefs(t)).toEqual([]);
  });

  it('reports pages declared under a disabled component', () => {
    const issues = crossRefs(
      tpl({
        components: { service: false, instances: true },
        dashboards: { instance: [widget('b')] },
        dashboardExtPages: { service: [page()] },
      }),
    );
    expect(issues.join(' ')).toContain('service component is disabled');
  });

  it('treats an absent service flag as enabled, matching the caps rule', () => {
    const t = tpl({ components: { instances: true }, dashboardExtPages: { service: [page()] } });
    expect(crossRefs(t)).toEqual([]);
  });

  it.each([
    ['a bare substring term', 'agent'],
    ['a compilable regex', '/^agent::/'],
    ['a regex with flags-free groups', '/^(a|b)::/'],
  ])('accepts %s as a serviceFilter', (_why, serviceFilter) => {
    expect(crossRefs(tpl({ dashboardExtPages: { service: [page({ serviceFilter })] } }))).toEqual([]);
  });

  it('reports an uncompilable regex filter', () => {
    const issues = crossRefs(tpl({ dashboardExtPages: { service: [page({ serviceFilter: '/^(unclosed/' })] } }));
    expect(issues.join(' ')).toContain('not a valid regular expression');
  });

  it('accepts a serviceFilter on a non-Service page', () => {
    // Was refused when the filter was a Service-page seed. Every entity
    // page shows the service picker, so every one may narrow it.
    const issues = layerCrossRefIssues(
      layerTemplatePushSchema.parse({
        key: 'CUSTOM_MQ',
        alias: 'MQ',
        components: { service: true, instances: true },
        dashboards: { instance: [widget('b')] },
        dashboardExtPages: { instance: [page({ serviceFilter: 'agent' })] },
      }),
      { complete: false },
    ).map((i) => `${i.path}: ${i.message}`);
    expect(issues).toEqual([]);
  });
});

describe('page resolution', () => {
  const template = {
    key: 'CUSTOM_MQ',
    slots: {},
    components: { service: true },
    header: {},
    metrics: {},
    dashboards: { service: [widget('default-a')] },
    dashboardExtPages: {
      service: [
        { id: 'resource', name: 'Resource', widgets: [widget('res-a')] },
        { id: 'agents', name: 'Agents', serviceFilter: '/^agent::/', widgets: [widget('ag-a')] },
      ],
    },
  } as unknown as LayerTemplate;

  it('resolves an omitted page to the component default', () => {
    expect(resolveExtPage(template, 'service', undefined)).toEqual({ kind: 'default' });
    expect(widgetsForScopePage(template, 'service', undefined)?.map((w) => w.id)).toEqual(['default-a']);
  });

  it('resolves a known page to its own widgets', () => {
    const r = resolveExtPage(template, 'service', 'agents');
    expect(r.kind).toBe('page');
    expect(widgetsForScopePage(template, 'service', 'agents')?.map((w) => w.id)).toEqual(['ag-a']);
  });

  it('reports an unknown page rather than falling back to the default', () => {
    expect(resolveExtPage(template, 'service', 'nope')).toEqual({ kind: 'unknown' });
    expect(widgetsForScopePage(template, 'service', 'nope')).toBeNull();
  });

  it('does not inherit the legacy service fallback for an explicit page', () => {
    // `widgetsForScope('instance')` falls back to the service grid for a
    // template with no instance dashboard. An explicit page must not.
    expect(widgetsForScopePage(template, 'instance', undefined)?.map((w) => w.id)).toEqual(['default-a']);
    expect(widgetsForScopePage(template, 'instance', 'resource')).toBeNull();
  });

  it('treats an empty page id as omitted', () => {
    expect(resolveExtPage(template, 'service', '')).toEqual({ kind: 'default' });
  });

  it('returns no pages for a scope that cannot carry them', () => {
    expect(extPagesForScope(template, 'topology')).toEqual([]);
    expect(resolveExtPage(template, 'topology', 'resource')).toEqual({ kind: 'unknown' });
  });

  it('enumerates every widget of a component across all its pages', () => {
    expect(allWidgetsForScope(template, 'service').map((w) => w.id)).toEqual(['default-a', 'res-a', 'ag-a']);
  });
});

describe('menuOrder — publish validation', () => {
  const base = () =>
    tpl({
      components: { service: true, instances: true, logs: true },
      dashboards: { service: [widget('a')], instance: [widget('b')] },
      dashboardExtPages: { service: [page({ id: 'agents', widgets: [widget('ag')] })] },
    });

  it('accepts an order naming exactly the rows the layer exposes', () => {
    expect(crossRefs({ ...base(), menuOrder: ['logs', 'service', 'service/agents', 'instance'] })).toEqual([]);
  });

  it('accepts a partial order — the rest keep their default placement', () => {
    expect(crossRefs({ ...base(), menuOrder: ['logs'] })).toEqual([]);
  });

  it('rejects a row this layer does not expose', () => {
    const issues = crossRefs({ ...base(), menuOrder: ['service', 'topology'] });
    expect(issues.join(' ')).toContain('"topology" is not a row this layer exposes');
  });

  it('rejects a page id that no longer exists', () => {
    const issues = crossRefs({ ...base(), menuOrder: ['service', 'service/gone'] });
    expect(issues.join(' ')).toContain('"service/gone" is not a row');
  });

  it('rejects a repeat', () => {
    const issues = crossRefs({ ...base(), menuOrder: ['service', 'logs', 'service'] });
    expect(issues.join(' ')).toContain('listed more than once');
  });

  it('accepts a template with no order at all', () => {
    expect(crossRefs(base())).toEqual([]);
  });
});

/**
 * A template that predates this feature must survive a load/publish
 * round-trip byte-identically.
 *
 * The push path parses with zod and stores what comes back, so a schema
 * that adds a default, renames a key, or drops an unknown one would
 * rewrite every layer an operator opens — silently, and for all of them at
 * once. The new fields must be absent-in, absent-out.
 */
describe('round-trip fidelity for a template with neither new field', () => {
  const legacy = {
    key: 'CUSTOM_MQ',
    alias: 'Custom MQ',
    slots: { services: 'Queues', instances: 'Brokers' },
    components: { service: true, instances: true, logs: true },
    dashboards: {
      service: [widget('svc-a'), widget('svc-b')],
      instance: [widget('inst-a')],
    },
    traces: { source: 'both' as const },
  };

  it('parses back to exactly what went in', () => {
    const parsed = layerTemplatePushSchema.safeParse(legacy);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(JSON.parse(JSON.stringify(parsed.data))).toEqual(legacy);
  });

  it('does not invent the new fields', () => {
    const parsed = layerTemplatePushSchema.safeParse(legacy);
    expect(parsed.success && 'dashboardExtPages' in parsed.data).toBe(false);
    expect(parsed.success && 'menuOrder' in parsed.data).toBe(false);
  });

  it('keeps a legacy flat `widgets` list untouched', () => {
    const flat = { ...legacy, dashboards: undefined, widgets: [widget('legacy-a')] };
    delete (flat as { dashboards?: unknown }).dashboards;
    const parsed = layerTemplatePushSchema.safeParse(flat);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(JSON.parse(JSON.stringify(parsed.data))).toEqual(flat);
  });

  it('round-trips a template that DOES declare the new fields', () => {
    const withPages = {
      ...legacy,
      dashboardExtPages: {
        service: [{ id: 'agents', name: 'Agents', serviceFilter: '/^agent::/', widgets: [widget('ag-a')] }],
      },
      menuOrder: ['service', 'service/agents', 'instance', 'logs'],
    };
    const parsed = layerTemplatePushSchema.safeParse(withPages);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(JSON.parse(JSON.stringify(parsed.data))).toEqual(withPages);
  });
});

/**
 * Sort direction on an extension page.
 *
 * The renderer reads `topNOrder` to decide which way a ranking sorts and
 * treats its absence as descending, so a page widget built on
 * `top_n(metric, 10, asc)` ranked backwards while the identical widget on
 * the default grid ranked correctly. Every path that hands widgets to the
 * UI has to resolve it, which is why this asserts the resolvers rather
 * than one of them.
 */
describe('top_n sort direction reaches an extension page', () => {
  const asc = { id: 'p-top', type: 'top', title: 'Slowest', expressions: ['top_n(service_cpm, 10, asc)'] };
  const desc = { id: 'd-top', type: 'top', title: 'Busiest', expressions: ['top_n(service_cpm, 10, des)'] };
  const tpl = {
    key: 'CUSTOM_MQ',
    dashboards: { service: [desc] },
    dashboardExtPages: {
      service: [
        { id: 'slow', name: 'Slow', widgets: [asc] },
        {
          id: 'nested',
          name: 'Nested',
          widgets: [
            { id: 'tabs', type: 'tab', title: 'T', tabs: [{ name: 'One', widgets: [{ ...asc, id: 'n-top' }] }] },
          ],
        },
      ],
    },
  } as unknown as LayerTemplate;

  it('resolves it for a page widget, as it always did for the default grid', () => {
    expect(widgetsForScope(tpl, 'service')[0]!.topNOrder).toBe('des');
    expect(widgetsForScopePage(tpl, 'service', 'slow')![0]!.topNOrder).toBe('asc');
  });

  it('reaches a widget nested in a tab on that page', () => {
    const page = widgetsForScopePage(tpl, 'service', 'nested')!;
    expect(page[0]!.tabs![0]!.widgets[0]!.topNOrder).toBe('asc');
  });

  it('resolves it in the whole-scope enumeration the catalog reads', () => {
    const all = allWidgetsForScope(tpl, 'service');
    expect(all.find((x) => x.id === 'p-top')?.topNOrder).toBe('asc');
    expect(all.find((x) => x.id === 'd-top')?.topNOrder).toBe('des');
  });
});

/**
 * Widget ids inside a tab panel share the grid's id space.
 *
 * Results come back keyed by id alone, so a nested repeat is as
 * unaddressable as a top-level one — the renderer resolves it
 * last-writer-wins while the AI catalog takes the first match, which is
 * two consumers disagreeing about which widget an id means. Only the
 * cross-PAGE half was enforced; a duplicate with both ends inside one
 * default grid published with no issue at all.
 */
describe('duplicate widget ids inside one grid', () => {
  const leaf = (id: string) => ({ id, type: 'line', title: id, expressions: ['x'] });
  const tabbed = (id: string, children: unknown[]) =>
    ({ id, type: 'tab', title: id, expressions: [], tabs: [{ name: 'One', widgets: children }] });
  const issues = (dashboards: unknown) =>
    layerCrossRefIssues(
      layerTemplatePushSchema.parse({
        key: 'CUSTOM_MQ',
        alias: 'MQ',
        components: { service: true, instances: true },
        dashboards,
      }),
      { complete: false },
    ).map((i) => `${i.path}: ${i.message}`);

  it('catches a top-level widget repeated inside a tab', () => {
    const found = issues({ service: [leaf('dupe'), tabbed('t', [leaf('dupe')])] });
    expect(found.join(' ')).toContain('duplicate widget id "dupe"');
  });

  it('catches a repeat across two tab panels of the same container', () => {
    const two = {
      id: 't',
      type: 'tab',
      title: 't',
      expressions: [],
      tabs: [{ name: 'One', widgets: [leaf('dupe')] }, { name: 'Two', widgets: [leaf('dupe')] }],
    };
    expect(issues({ service: [two] }).join(' ')).toContain('duplicate widget id "dupe"');
  });

  it('catches a repeat within one tab panel', () => {
    expect(issues({ service: [tabbed('t', [leaf('dupe'), leaf('dupe')])] }).join(' ')).toContain(
      'duplicate widget id "dupe"',
    );
  });

  it('leaves the same id in a DIFFERENT component alone', () => {
    // Service and Instance are independent id spaces, by design.
    expect(issues({ service: [leaf('same')], instance: [leaf('same')] })).toEqual([]);
  });

  it('accepts a grid whose nested ids are all distinct', () => {
    expect(issues({ service: [leaf('a'), tabbed('t', [leaf('b'), leaf('c')])] })).toEqual([]);
  });
});

/**
 * The grid an extension page is compared against is the EFFECTIVE one.
 *
 * A component with no grid of its own renders Service's, and then the
 * legacy flat list. Validation used to compare against the literal
 * `dashboards.<scope>`, so an Instance page could reuse an id that the
 * Instance page really does render — the exact collision the rule exists
 * to prevent, invisible because the two resolutions disagreed.
 */
describe('extension pages versus the grid a component actually shows', () => {
  const leaf = (id: string) => ({ id, type: 'line', title: id, expressions: ['x'] });
  const page = (id: string, widgets: unknown[]) => ({ id, name: id, widgets });
  const issues = (tpl: Record<string, unknown>) =>
    layerCrossRefIssues(
      layerTemplatePushSchema.parse({
        key: 'CUSTOM_MQ',
        alias: 'MQ',
        components: { service: true, instances: true, endpoints: true },
        ...tpl,
      }),
      { complete: false },
    ).map((i) => `${i.path}: ${i.message}`);

  it('catches an Instance page reusing an id from the Service grid it falls back to', () => {
    const found = issues({
      dashboards: { service: [leaf('shared')] },
      dashboardExtPages: { instance: [page('extra', [leaf('shared')])] },
    });
    expect(found.join(' ')).toContain('already exists in dashboards.service');
  });

  it('catches an Endpoint page reusing an id from the legacy flat list', () => {
    const found = issues({
      widgets: [leaf('shared')],
      dashboardExtPages: { endpoint: [page('extra', [leaf('shared')])] },
    });
    expect(found.join(' ')).toContain('already exists in widgets');
  });

  it('still compares against the component’s OWN grid when it has one', () => {
    const found = issues({
      dashboards: { service: [leaf('svc-only')], instance: [leaf('ins-only')] },
      dashboardExtPages: { instance: [page('extra', [leaf('ins-only')])] },
    });
    expect(found.join(' ')).toContain('already exists in dashboards.instance');
  });

  it('leaves a page alone when the id lives in a grid that component does NOT show', () => {
    // Instance has its own grid, so Service's ids are not on screen for
    // it — that is a different id space and always was.
    expect(
      issues({
        dashboards: { service: [leaf('svc-only')], instance: [leaf('ins-only')] },
        dashboardExtPages: { instance: [page('extra', [leaf('svc-only')])] },
      }),
    ).toEqual([]);
  });
})

/**
 * Instance-page filters.
 *
 * The name filter is the Instance twin of `serviceFilter` — same
 * grammar, different picker. The attribute conditions borrow the
 * widget-level entity gate's vocabulary so an operator learns one set of
 * words, and they AND with the name filter and with each other.
 *
 * Placement is the rule worth enforcing hardest: a filter on the wrong
 * scope is carried to the client and silently ignored, which reads as a
 * filter that does not work rather than one that was misplaced.
 */
describe('instance filters on an extension page', () => {
  const page = (extra: Record<string, unknown>) => ({ id: 'p', name: 'P', widgets: [], ...extra });
  const issues = (dashboardExtPages: Record<string, unknown>) =>
    layerCrossRefIssues(
      layerTemplatePushSchema.parse({
        key: 'CUSTOM_MQ',
        alias: 'MQ',
        components: { service: true, instances: true, endpoints: true },
        dashboardExtPages,
      }),
      { complete: false },
    ).map((i) => `${i.path}: ${i.message}`);

  it('accepts a name filter and attribute conditions on an Instance page', () => {
    expect(
      issues({
        instance: [
          page({
            instanceFilter: '/^broker-/',
            instanceAttributes: [
              { attribute: 'language', op: 'eq', value: 'java' },
              { attribute: 'namespace', op: 'exists' },
            ],
          }),
        ],
      }),
    ).toEqual([]);
  });

  it('accepts a service filter on an Instance page — it shows the picker too', () => {
    // An Instance page has you pick a service first, so narrowing that
    // list is as meaningful there as on a Service page.
    expect(issues({ instance: [page({ serviceFilter: '/^agent::/', instanceFilter: 'broker' })] })).toEqual([]);
  });

  it('refuses an instance filter on a Service or Endpoint page', () => {
    expect(issues({ service: [page({ instanceFilter: 'broker' })] }).join(' ')).toContain(
      'only an Instance page can filter the instance list',
    );
    expect(issues({ endpoint: [page({ instanceAttributes: [{ attribute: 'x', op: 'exists' }] })] }).join(' ')).toContain(
      'only an Instance page can filter by instance attributes',
    );
  });

  it('refuses a regex that cannot compile, as it does for services', () => {
    expect(issues({ instance: [page({ instanceFilter: '/(unclosed/' })] }).join(' ')).toContain(
      'not a valid regular expression',
    );
  });

  it('treats a bare term as a literal, so it can never be malformed', () => {
    expect(issues({ instance: [page({ instanceFilter: '(unclosed' })] })).toEqual([]);
  });

  it('reports a repeated condition — ANDed, it can only be redundant', () => {
    expect(
      issues({
        instance: [
          page({
            instanceAttributes: [
              { attribute: 'Language', op: 'eq', value: 'Java' },
              { attribute: 'language', op: 'eq', value: 'java' },
            ],
          }),
        ],
      }).join(' '),
    ).toContain('duplicate condition');
  });

  it('refuses an "eq" with no value — it would match nothing', () => {
    const bad = () =>
      layerTemplatePushSchema.parse({
        key: 'CUSTOM_MQ',
        alias: 'MQ',
        components: { service: true, instances: true },
        dashboardExtPages: { instance: [page({ instanceAttributes: [{ attribute: 'x', op: 'eq' }] })] },
      });
    expect(bad).toThrow(/needs a value/);
  });

  it('caps how many conditions one page may carry', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ attribute: `a${i}`, op: 'exists' as const }));
    expect(() =>
      layerTemplatePushSchema.parse({
        key: 'CUSTOM_MQ',
        alias: 'MQ',
        components: { service: true, instances: true },
        dashboardExtPages: { instance: [page({ instanceAttributes: many })] },
      }),
    ).toThrow();
  });
});

describe('dashboardDefaultFilters — the default page narrows too', () => {
  it('accepts a service filter under any entity scope', () => {
    expect(
      crossRefs(
        tpl({
          components: { service: true, instances: true, endpoints: true },
          dashboardDefaultFilters: {
            service: { serviceFilter: '/^agent::/' },
            instance: { serviceFilter: 'broker' },
            endpoint: { serviceFilter: 'gateway' },
          },
        }),
      ),
    ).toEqual([]);
  });

  it('accepts the instance fields under the instance scope', () => {
    expect(
      crossRefs(
        tpl({
          dashboardDefaultFilters: {
            instance: {
              instanceFilter: '/^broker-/',
              instanceAttributes: [{ attribute: 'language', op: 'exists' }],
            },
          },
        }),
      ),
    ).toEqual([]);
  });

  it('refuses the instance fields under service or endpoint', () => {
    const issues = crossRefs(
      tpl({
        components: { service: true, endpoints: true },
        dashboardDefaultFilters: {
          service: { instanceFilter: 'x' },
          endpoint: { instanceAttributes: [{ attribute: 'language', op: 'exists' }] },
        },
      }),
    );
    expect(issues).toContain(
      'dashboardDefaultFilters.service.instanceFilter: only an Instance page can filter the instance list',
    );
    expect(issues).toContain(
      'dashboardDefaultFilters.endpoint.instanceAttributes: only an Instance page can filter by instance attributes',
    );
  });

  it('refuses a filter under a component that is off', () => {
    expect(
      crossRefs(
        tpl({
          components: { service: true, instances: false },
          dashboardDefaultFilters: { instance: { serviceFilter: 'x' } },
        }),
      ),
    ).toContain(
      'dashboardDefaultFilters.instance: the instance component is off — its default page has no picker to narrow',
    );
  });

  it('refuses a pattern that cannot compile, rather than widening the page', () => {
    const issues = crossRefs(tpl({ dashboardDefaultFilters: { service: { serviceFilter: '/^(unclosed/' } } }));
    expect(issues.some((i) => i.startsWith('dashboardDefaultFilters.service.serviceFilter:'))).toBe(true);
  });

  it('refuses an unknown field, like the page schema does', () => {
    const parsed = layerTemplatePushSchema.safeParse(
      tpl({ dashboardDefaultFilters: { service: { serviceFilter: 'a', nope: 1 } } }),
    );
    expect(parsed.success).toBe(false);
  });

  it('is absent from a template that declares none, byte for byte', () => {
    const parsed = layerTemplateSchema.safeParse(tpl());
    expect(parsed.success).toBe(true);
    expect(parsed.success && 'dashboardDefaultFilters' in parsed.data).toBe(false);
  });
});

describe('an extension page names the entity it lists', () => {
  it('carries an alias through both bars', () => {
    for (const schema of [layerTemplateSchema, layerTemplatePushSchema]) {
      const parsed = schema.safeParse(
        tpl({ dashboardExtPages: { service: [page({ alias: 'Providers' })] } }),
      );
      expect(parsed.success).toBe(true);
      expect(parsed.success && parsed.data.dashboardExtPages?.service?.[0]?.alias).toBe('Providers');
    }
  });

  it('is optional — a page without one falls back to the layer alias', () => {
    expect(crossRefs(tpl({ dashboardExtPages: { service: [page()] } }))).toEqual([]);
  });
});

describe('page id and name have a maximum length', () => {
  it('refuses an id longer than the shared limit', () => {
    const long = 'a'.repeat(MAX_EXT_PAGE_ID_LENGTH + 1);
    const parsed = layerTemplatePushSchema.safeParse(
      tpl({ dashboardExtPages: { service: [page({ id: long })] } }),
    );
    expect(parsed.success).toBe(false);
  });

  it('accepts one exactly at the limit', () => {
    const at = 'a'.repeat(MAX_EXT_PAGE_ID_LENGTH);
    expect(
      layerTemplatePushSchema.safeParse(tpl({ dashboardExtPages: { service: [page({ id: at })] } })).success,
    ).toBe(true);
  });

  it('refuses a name longer than the shared limit, after trimming', () => {
    const long = `${' '.repeat(4)}${'n'.repeat(MAX_EXT_PAGE_NAME_LENGTH + 1)}`;
    expect(
      layerTemplatePushSchema.safeParse(tpl({ dashboardExtPages: { service: [page({ name: long })] } })).success,
    ).toBe(false);
    // Trimmed to the limit, the same text is fine — the bound is on the
    // stored value, not on what was typed around it.
    const padded = `  ${'n'.repeat(MAX_EXT_PAGE_NAME_LENGTH)}  `;
    expect(
      layerTemplatePushSchema.safeParse(tpl({ dashboardExtPages: { service: [page({ name: padded })] } })).success,
    ).toBe(true);
  });
});
