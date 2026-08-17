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

/** Where the admin canvas reads and writes widgets, and what happens to a
 *  component's pages when the component itself goes away. */

import { describe, it, expect } from 'vitest';
import { ref } from 'vue';
import type { AdminLayerTemplate } from '@/api/client';
import { componentOwnedCount, disableEntityComponent, type EntityScope } from './componentDisable';
import { useExtPages, suggestPageId, extPageIdIssue, isPageableScope } from './useExtPages';
import { isBuiltInLayerRow } from '@skywalking-horizon-ui/api-client';

const w = (id: string) => ({ id, type: 'line' as const, title: id, expressions: ['x'] });

function setup(over: Partial<AdminLayerTemplate> = {}) {
  const template = ref<AdminLayerTemplate | null>({
    key: 'CUSTOM_MQ',
    slots: {},
    components: { service: true, instances: true },
    metrics: {},
    widgets: [],
    dashboards: { service: [w('svc-a')], instance: [w('inst-a')] },
    ...over,
  } as AdminLayerTemplate);
  const scope = ref('service');
  const page = ref<string | null>(null);
  return { template, scope, page, api: useExtPages(template, scope, page) };
}

describe('useExtPages — storage', () => {
  it('reads the default grid when no page is selected', () => {
    const { api } = setup();
    expect(api.readWidgets('service', null).map((x) => x.id)).toEqual(['svc-a']);
  });

  it('creates a page and writes widgets into it, leaving the default alone', () => {
    const { api, template } = setup();
    api.addPage('Resource usage', 'resource');
    api.writeWidgets('service', 'resource', [w('res-a')]);
    expect(api.readWidgets('service', 'resource').map((x) => x.id)).toEqual(['res-a']);
    expect(api.readWidgets('service', null).map((x) => x.id)).toEqual(['svc-a']);
    expect(template.value?.dashboardExtPages?.service?.[0].id).toBe('resource');
  });

  it('selects the new page so the canvas follows the operator', () => {
    const { api, page } = setup();
    api.addPage('Resource usage', 'resource');
    expect(page.value).toBe('resource');
  });

  it('enumerates every list for id minting, pages included', () => {
    const { api } = setup();
    api.addPage('P', 'p');
    api.writeWidgets('service', 'p', [w('page-widget')]);
    const ids = api.allWidgetLists().flat().map((x) => x.id);
    expect(ids).toContain('svc-a');
    expect(ids).toContain('inst-a');
    expect(ids).toContain('page-widget');
  });

  it('falls back to the legacy flat `widgets` for the service default', () => {
    const { api } = setup({ dashboards: undefined, widgets: [w('legacy')] } as Partial<AdminLayerTemplate>);
    expect(api.readWidgets('service', null).map((x) => x.id)).toEqual(['legacy']);
  });

  it('drops the legacy list once the service grid is written', () => {
    const { api, template } = setup({ dashboards: undefined, widgets: [w('legacy')] } as Partial<AdminLayerTemplate>);
    api.writeWidgets('service', null, [w('fresh')]);
    expect(template.value?.widgets).toBeUndefined();
    expect(api.readWidgets('service', null).map((x) => x.id)).toEqual(['fresh']);
  });
});

describe('useExtPages — lifecycle', () => {
  it('removes the scope key entirely when its last page goes', () => {
    const { api, template } = setup();
    api.addPage('A', 'a');
    api.deletePage('a');
    expect(template.value?.dashboardExtPages).toBeUndefined();
  });

  it('returns to the default page after deleting the selected one', () => {
    const { api, page } = setup();
    api.addPage('A', 'a');
    api.deletePage('a');
    expect(page.value).toBeNull();
  });

  it('clears every page of a component that is switched off', () => {
    const { api, template, scope } = setup();
    api.addPage('A', 'a');
    api.addPage('B', 'b');
    scope.value = 'instance';
    api.addPage('C', 'c');
    scope.value = 'service';
    expect(api.clearScopePages('service').map((p) => p.id)).toEqual(['a', 'b']);
    expect(template.value?.dashboardExtPages?.service).toBeUndefined();
    // The other component keeps its own.
    expect(template.value?.dashboardExtPages?.instance?.map((p) => p.id)).toEqual(['c']);
  });

  it('stops offering to add past the cap', () => {
    const { api } = setup();
    for (let i = 0; i < 12; i++) api.addPage(`P${i}`, `p${i}`);
    expect(api.canAddPage.value).toBe(false);
    api.addPage('overflow', 'overflow');
    expect(api.pages.value).toHaveLength(12);
  });

  it('treats an emptied filter box as no filter', () => {
    const { api } = setup();
    api.addPage('A', 'a');
    api.setEntityFilter('service', 'a', '/^x/');
    expect(api.pages.value[0].serviceFilter).toBe('/^x/');
    api.setEntityFilter('service', 'a', '   ');
    expect(api.pages.value[0].serviceFilter).toBeUndefined();
  });

  it('offers no pages for a component that cannot carry them', () => {
    const { api, scope } = setup();
    scope.value = 'topology';
    expect(api.canAddPage.value).toBe(false);
    api.addPage('X', 'x');
    expect(api.pages.value).toEqual([]);
  });
});

describe('page ids', () => {
  it.each([
    ['Resource usage', 'resource-usage'],
    ['  CPU & Memory  ', 'cpu-memory'],
    ['???', 'page'],
  ])('derives %s → %s', (name, id) => {
    expect(suggestPageId(name, [])).toBe(id);
  });

  it('numbers a colliding id rather than rejecting the name', () => {
    expect(suggestPageId('Resource usage', ['resource-usage'])).toBe('resource-usage-2');
    expect(suggestPageId('Resource usage', ['resource-usage', 'resource-usage-2'])).toBe('resource-usage-3');
  });

  it('refuses an id that impersonates a built-in tab', () => {
    for (const id of ['service', 'topology', 'zipkin-trace', 'pprof']) {
      expect(extPageIdIssue(id, [], isBuiltInLayerRow)).toBe('reserved');
    }
  });

  it('accepts a well-formed id', () => {
    expect(extPageIdIssue('resource-usage', [], isBuiltInLayerRow)).toBeNull();
  });

  it('knows which components can carry pages', () => {
    expect(['service', 'instance', 'endpoint'].every(isPageableScope)).toBe(true);
    expect(['topology', 'trace', 'logs'].some(isPageableScope)).toBe(false);
  });
});

describe('useExtPages — adding a page under a custom menu order', () => {
  it('places the new row next to its component, not at the bottom', () => {
    const { api, template, scope } = setup();
    template.value!.menuOrder = ['logs', 'service', 'instance'];
    scope.value = 'service';
    api.addPage('Resource usage', 'resource');
    expect(template.value?.menuOrder).toEqual(['logs', 'service', 'service/resource', 'instance']);
  });

  it('places a second page after the first', () => {
    const { api, template } = setup();
    template.value!.menuOrder = ['service', 'service/one', 'instance'];
    api.addPage('Two', 'two');
    expect(template.value?.menuOrder).toEqual(['service', 'service/one', 'service/two', 'instance']);
  });

  it('appends when the order never mentions the component', () => {
    const { api, template } = setup();
    template.value!.menuOrder = ['logs', 'instance'];
    api.addPage('One', 'one');
    expect(template.value?.menuOrder).toEqual(['logs', 'instance', 'service/one']);
  });

  it('leaves the order absent when there is no custom order', () => {
    const { api, template } = setup();
    api.addPage('One', 'one');
    expect(template.value?.menuOrder).toBeUndefined();
  });

  it('removes the row again when the page is deleted', () => {
    const { api, template } = setup();
    template.value!.menuOrder = ['service', 'instance'];
    api.addPage('One', 'one');
    expect(template.value?.menuOrder).toContain('service/one');
    api.deletePage('one');
    expect(template.value?.menuOrder).toEqual(['service', 'instance']);
  });
});

/**
 * Switching a component off has to leave nothing behind that only that
 * component could reach. A dormant grid or page is config with no menu row
 * to open it and no selector to delete it from — invisible until a publish
 * rejects the template.
 */
describe('disabling an entity component', () => {
  /** The EDITOR's own removal, not a copy of it. The copy this replaces
   *  omitted the default-page filter and the instance-list configuration,
   *  so the tests passed while the handler did strictly more — and one of
   *  those omissions is what publish refuses. */
  const disable = (tpl: AdminLayerTemplate, key: string, scope: string): void =>
    disableEntityComponent(tpl, key, scope as EntityScope);

  it('removes the grid, the pages, and the order rows together', () => {
    const { api, template } = setup();
    template.value!.menuOrder = ['service', 'service/a', 'instance'];
    api.addPage('A', 'a');
    disable(template.value!, 'service', 'service');

    expect(template.value?.components.service).toBe(false);
    expect(template.value?.dashboards?.service).toBeUndefined();
    expect(template.value?.dashboardExtPages?.service).toBeUndefined();
    expect(template.value?.menuOrder).toEqual(['instance']);
  });

  it('leaves every other component untouched', () => {
    const { api, template, scope } = setup();
    scope.value = 'instance';
    api.addPage('C', 'c');
    scope.value = 'service';
    disable(template.value!, 'service', 'service');

    expect(template.value?.components.instances).toBe(true);
    expect(template.value?.dashboards?.instance?.map((x) => x.id)).toEqual(['inst-a']);
    expect(template.value?.dashboardExtPages?.instance?.map((p) => p.id)).toEqual(['c']);
  });

  it('takes the legacy flat widget list with the service grid', () => {
    // For a template that never split, `widgets` IS the service grid —
    // leaving it behind would resurrect the page the operator just removed.
    const { template } = setup({ dashboards: undefined, widgets: [w('legacy')] } as Partial<AdminLayerTemplate>);
    disable(template.value!, 'service', 'service');
    expect(template.value?.widgets).toBeUndefined();
  });

  it('drops the dashboards block entirely once its last scope goes', () => {
    const { template } = setup({ dashboards: { service: [w('only')] } } as Partial<AdminLayerTemplate>);
    disable(template.value!, 'service', 'service');
    expect(template.value?.dashboards).toBeUndefined();
  });
});

/**
 * The two things the old hand-copied `disable` never removed. Both are
 * reachable only through the component, and one of them makes the draft
 * unpublishable rather than merely untidy.
 */
describe('disabling a component takes its settings, not only its widgets', () => {
  it('removes the default page filter, which publish refuses under an off component', () => {
    const { template } = setup();
    template.value!.dashboardDefaultFilters = {
      service: { serviceFilter: '/^agent::/' },
      instance: { instanceFilter: '/^broker-/' },
    };
    disableEntityComponent(template.value!, 'service', 'service');

    expect(template.value?.dashboardDefaultFilters?.service).toBeUndefined();
    // Another component's filter is not collateral damage.
    expect(template.value?.dashboardDefaultFilters?.instance?.instanceFilter).toBe('/^broker-/');
  });

  it('drops the filters block once its last scope goes', () => {
    const { template } = setup();
    template.value!.dashboardDefaultFilters = { service: { serviceFilter: 'x' } };
    disableEntityComponent(template.value!, 'service', 'service');
    expect(template.value?.dashboardDefaultFilters).toBeUndefined();
  });

  it('removes the instance-list configuration with the Instance component', () => {
    const { template } = setup();
    (template.value as unknown as { instances?: unknown }).instances = { badge: 'language' };
    disableEntityComponent(template.value!, 'instances', 'instance');
    expect((template.value as unknown as { instances?: unknown }).instances).toBeUndefined();
  });

  it('leaves the instance configuration alone when another component goes off', () => {
    const { template } = setup();
    (template.value as unknown as { instances?: unknown }).instances = { badge: 'language' };
    disableEntityComponent(template.value!, 'service', 'service');
    expect((template.value as unknown as { instances?: unknown }).instances).toEqual({ badge: 'language' });
  });

  it('counts what it is about to remove, so the confirmation cannot understate it', () => {
    const { api, template, scope } = setup();
    scope.value = 'service';
    api.addPage('A', 'a');
    template.value!.dashboardDefaultFilters = { service: { serviceFilter: 'x' } };

    const owned = componentOwnedCount(template.value!, 'service');
    expect(owned.pages).toBe(1);
    // The filter is a SETTING: counted, or a component whose only
    // configuration is one takes the silent "nothing to delete" path.
    expect(owned.settings).toBe(1);
    expect(owned.grid).toBeGreaterThan(0);
  });
});
