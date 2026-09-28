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
 * The sidebar lists every named alarm page the reader is served as its own
 * row right after Alarms, and a session that cannot read alarms asks for
 * neither the pages nor the count.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { computed, ref } from 'vue';
import { createMemoryHistory, createRouter, type Router } from 'vue-router';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import { createPinia } from 'pinia';
import type { AlarmPagesResponse } from '@skywalking-horizon-ui/api-client';

const session = vi.hoisted(() => ({ alarms: true }));
vi.mock('@/state/auth', () => ({
  useAuthStore: () => ({
    user: { username: 'op', roles: ['viewer'] },
    isAuthenticated: true,
    hasVerb: () => false,
    hasVerbOnSomeLayer: (v: string) => v === 'alarms:read' && session.alarms,
    logout: async () => {},
  }),
}));
vi.mock('@/shell/useLayers', () => ({
  useLayers: () => ({ availableLayers: computed(() => []), oapReachable: ref(true), oapError: ref(undefined) }),
  isSingleFeatureLayer: () => false,
}));
vi.mock('@/render/overview/useOverviewDashboards', () => ({
  useOverviewDashboards: () => ({ publicOverviews: ref([]) }),
}));
vi.mock('@/controls/configBundle', () => ({ useConfigBundle: () => ({ bundle: ref(null) }) }));
vi.mock('@/shell/useSidebarMenu', () => ({
  useSidebarMenu: () => ({ platformSection: ref(null), menuSections: ref([]), isNavL1Open: () => false, toggleNavL1: () => {} }),
}));

const { i18n } = await import('@/i18n');
const { default: AppSidebar } = await import('./AppSidebar.vue');

const PAGES: AlarmPagesResponse = {
  unreachable: false,
  default: { id: 'default', title: null, pinnedLayers: ['GENERAL'], hiddenPins: 0, defaultWindowMs: 1_200_000 },
  pages: [
    { id: 'payments', title: 'Payments on-call', pinnedLayers: ['GENERAL[payments]'], hiddenPins: 0, defaultWindowMs: 1_200_000 },
    { id: 'risk', title: 'Risk', pinnedLayers: ['GENERAL[risk]'], hiddenPins: 1, defaultWindowMs: 7_200_000 },
  ],
};

let asked: string[];
let pages: AlarmPagesResponse;
let router: Router;

beforeEach(async () => {
  // jsdom has no layout; the sidebar scrolls its active row into view.
  Element.prototype.scrollIntoView = () => {};
  session.alarms = true;
  asked = [];
  pages = PAGES;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const path = new URL(String(input), 'http://ui').pathname;
      asked.push(path);
      const body =
        path === '/api/alarms/pages'
          ? pages
          : path === '/api/alarms/count'
            ? { total: 3, firing: 3, incidents: 3, activeIncidents: 3, truncated: false, startTime: 0, endTime: 0, generatedAt: 0 }
            : {};
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }),
  );
  router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:p(.*)*', component: { template: '<div />' } }] });
});

async function mountSidebar(path: string): Promise<VueWrapper> {
  await router.push(path);
  await router.isReady();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const w = mount(AppSidebar, { global: { plugins: [router, i18n, createPinia(), [VueQueryPlugin, { queryClient }]] } });
  await flushPromises();
  return w;
}

/** The rows from Alarms down to the next section, as [label, href, active]. */
function alarmRows(w: VueWrapper): Array<[string, string, boolean]> {
  return w
    .findAll('a.sw-nav-item')
    .filter((a) => (a.attributes('href') ?? '').startsWith('/alarms'))
    .map((a) => [a.find('span').text(), a.attributes('href')!, a.classes().includes('is-active')]);
}

describe('AppSidebar — alarm pages', () => {
  it('adds one row per named page right after Alarms, in the order served', async () => {
    const w = await mountSidebar('/');
    expect(alarmRows(w)).toEqual([
      ['Alarms', '/alarms', false],
      ['Payments on-call', '/alarms/payments', false],
      ['Risk', '/alarms/risk', false],
    ]);
    // Siblings, not children: the three rows are adjacent links of one list.
    const links = w.findAll('nav > a.sw-nav-item').map((a) => a.attributes('href'));
    expect(links.slice(links.indexOf('/alarms'), links.indexOf('/alarms') + 3)).toEqual([
      '/alarms',
      '/alarms/payments',
      '/alarms/risk',
    ]);
  });

  it('keeps the badge on Alarms alone', async () => {
    const w = await mountSidebar('/');
    const rows = w.findAll('a.sw-nav-item').filter((a) => (a.attributes('href') ?? '').startsWith('/alarms'));
    expect(rows[0]!.find('.sw-badge').text()).toBe('3');
    expect(rows.slice(1).every((r) => !r.find('.sw-badge').exists())).toBe(true);
  });

  it('lights only the page being read', async () => {
    const onNamed = await mountSidebar('/alarms/risk');
    expect(alarmRows(onNamed).map(([, href, active]) => [href, active])).toEqual([
      ['/alarms', false],
      ['/alarms/payments', false],
      ['/alarms/risk', true],
    ]);
    const onDefault = await mountSidebar('/alarms');
    expect(alarmRows(onDefault).filter(([, , active]) => active).map(([, href]) => href)).toEqual(['/alarms']);
  });

  it('is today\'s sidebar when there are no named pages', async () => {
    pages = { ...PAGES, pages: [] };
    const w = await mountSidebar('/');
    expect(alarmRows(w)).toEqual([['Alarms', '/alarms', false]]);
  });

  it('asks for neither pages nor a count without alarms:read', async () => {
    session.alarms = false;
    const w = await mountSidebar('/');
    expect(alarmRows(w)).toEqual([]);
    expect(asked.filter((p) => p.startsWith('/api/alarms'))).toEqual([]);
  });
});
