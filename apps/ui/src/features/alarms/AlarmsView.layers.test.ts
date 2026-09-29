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
 * The tiles, tabs and rows of the Alarms page read the layers each alarm
 * belongs to. A service in two layers, a relation across two, and an alarm no
 * known service owns all have to land where an operator looks for them, and
 * "Other" has to be something they can click.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createMemoryHistory, createRouter, type Router } from 'vue-router';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import { alarmPinMatches, type AlarmPageView, type AlarmPagesResponse } from '@skywalking-horizon-ui/api-client';
import { i18n } from '@/i18n';
import type { AlarmMessage } from '@/api/client';
import AlarmsView from './AlarmsView.vue';
import { canonicalPin } from './useAlarmPins';

const session = vi.hoisted(() => ({ limited: false, setup: true }));
vi.mock('@/state/auth', () => ({
  useAuthStore: () => ({
    hasVerb: (v: string) => (v === 'alarm-setup:read' ? session.setup : !session.limited),
    hasVerbOnSomeLayer: () => true,
    layerLimited: () => session.limited,
    layersFor: () => (session.limited ? ['GENERAL'] : null),
  }),
}));

const NOW = Date.now();
const CHECKOUT = 'cGF5bWVudHM6OmNoZWNrb3V0.1';
const USER_EP = 'VXNlcg==.0_VXNlcg==';

type Row = Partial<AlarmMessage> & Pick<AlarmMessage, 'id' | 'scope' | 'name' | 'layerKeys' | 'ownerKeys'>;
function alarm(p: Row, expression = 'rule-a'): AlarmMessage {
  return {
    startTime: NOW - 60_000,
    recoveryTime: null,
    message: `${p.name} fired`,
    tags: [],
    snapshot: { expression, metrics: [] },
    layerKey: p.layerKeys[0] ?? null,
    ...p,
  };
}

const MSGS: AlarmMessage[] = [
  // One service, two rules, in two layers.
  alarm({ id: CHECKOUT, scope: 'Service', name: 'payments::checkout', layerKeys: ['SO11Y_JAVA_AGENT', 'GENERAL'], ownerKeys: ['SO11Y_JAVA_AGENT~payments', 'GENERAL~payments'] }, 'rule-a'),
  alarm({ id: CHECKOUT, scope: 'Service', name: 'payments::checkout', layerKeys: ['SO11Y_JAVA_AGENT', 'GENERAL'], ownerKeys: ['SO11Y_JAVA_AGENT~payments', 'GENERAL~payments'] }, 'rule-b'),
  // Two relations from one source: same id, different destination.
  alarm({ id: USER_EP, scope: 'EndpointRelation', name: 'User in User to POST:/users in payments::checkout', layerKeys: ['GENERAL'], ownerKeys: ['GENERAL~payments'] }),
  alarm({ id: USER_EP, scope: 'EndpointRelation', name: 'User in User to POST:/users in mesh::edge', layerKeys: ['MESH'], ownerKeys: ['MESH~mesh'] }),
  // No known service owns it.
  alarm({ id: 'Z2hvc3Q=.1_Zy0x', scope: 'ServiceInstance', name: 'g-1 of ghost', layerKeys: [], ownerKeys: [] }),
];

/** One layer, three groups: payments, risk, and the services with none. */
const GROUPED: AlarmMessage[] = [
  alarm({ id: 'cGF5.1', scope: 'Service', name: 'payments::checkout', layerKeys: ['GENERAL'], ownerKeys: ['GENERAL~payments'] }),
  alarm({ id: 'cmlzaw==.1', scope: 'Service', name: 'risk::scorer', layerKeys: ['GENERAL'], ownerKeys: ['GENERAL~risk'] }),
  alarm({ id: 'cGxhaW4=.1', scope: 'Service', name: 'plain', layerKeys: ['GENERAL'], ownerKeys: ['GENERAL~'] }),
  // Between two groups: counts under each.
  alarm({ id: 'cmlzaw==.1', scope: 'ServiceRelation', name: 'risk::scorer to payments::checkout', layerKeys: ['GENERAL'], ownerKeys: ['GENERAL~risk', 'GENERAL~payments'] }),
];

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
}

function listed(msgs: AlarmMessage[], pinnedLayers?: string[]): Response {
  return json({ returned: msgs.length, pageNum: 1, pageSize: 500, truncated: false, generatedAt: NOW, msgs, ...(pinnedLayers ? { pinnedLayers } : {}) });
}

/** The list route as it answers a named page: the rows its pins cover, and a
 *  404 for a page it does not serve. `pins` is each served page's pins. */
function servePages(msgs: AlarmMessage[], pins: Record<string, string[]>) {
  return (q: URLSearchParams): Response => {
    const page = q.get('page');
    if (page === null) return listed(msgs);
    const served = pins[page];
    if (!served) return json({ error: 'alarm_page_not_found', message: 'alarm page not found' }, 404);
    return listed(msgs.filter((m) => served.some((p) => alarmPinMatches(canonicalPin(p)!, m))), served);
  };
}

function view(p: Partial<AlarmPageView> & Pick<AlarmPageView, 'id' | 'pinnedLayers'>): AlarmPageView {
  return { title: null, hiddenPins: 0, defaultWindowMs: 1_200_000, ...p };
}

let router: Router;
let alarmsReply: (q: URLSearchParams) => Response | Promise<Response>;
let pagesReply: () => Response;
let alarmReads: URLSearchParams[];
let serviceReads: URLSearchParams[];
let pagesReads: number;

beforeEach(async () => {
  session.limited = false;
  session.setup = true;
  alarmReads = [];
  serviceReads = [];
  pagesReads = 0;
  alarmsReply = () => json({ returned: MSGS.length, pageNum: 1, pageSize: 500, truncated: false, generatedAt: NOW, msgs: MSGS });
  pagesReply = () => json({ unreachable: false, default: view({ id: 'default', pinnedLayers: ['GENERAL'] }), pages: [] } satisfies AlarmPagesResponse);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input), 'http://ui');
      const path = url.pathname;
      // The default page's config still says what it said before the pages
      // were narrowed to this reader: the page must not draw it once the
      // pages route has answered.
      if (path === '/api/configs/settings') {
        return json({ alert: { pinnedLayers: ['GENERAL', 'MESH'], defaultWindowMs: 1_200_000, overviewAlarmsLimit: 200 } });
      }
      if (path === '/api/alarms/pages') {
        pagesReads += 1;
        return pagesReply();
      }
      if (path === '/api/menu') {
        return json({ layers: [], alarmLayers: [{ key: 'GENERAL', name: 'General' }, { key: 'MESH', name: 'Mesh' }], oap: { reachable: true } });
      }
      if (path === '/api/alarms/services') {
        serviceReads.push(url.searchParams);
        return json({ layer: 'GENERAL', services: [{ id: CHECKOUT, name: 'payments::checkout', normal: true }] });
      }
      if (path === '/api/oap/info') return json({ reachable: true, capabilities: { queryAlarms: true } });
      if (path === '/api/alarms') {
        alarmReads.push(url.searchParams);
        return alarmsReply(url.searchParams);
      }
      return json({});
    }),
  );
  router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div />' } }] });
  await router.push('/alarms');
  await router.isReady();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** `keepCache` holds every read, as the app's client does for minutes, so a
 *  page visited again could be served from it. */
let queryClient: QueryClient;
async function mountAlarms(pageId?: string, keepCache = false): Promise<VueWrapper> {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: keepCache ? Infinity : 0 } } });
  const w = mount(AlarmsView, {
    props: pageId ? { pageId } : {},
    global: {
      plugins: [router, i18n, [VueQueryPlugin, { queryClient }]],
      stubs: { AlarmsTimeline: true, AlarmDetailPanel: true },
    },
  });
  await flushPromises();
  return w;
}

const tiles = (w: VueWrapper) =>
  Object.fromEntries(w.findAll('.ax__kpi').map((b) => [b.get('.ax__kpi-label').text(), Number(b.get('.ax__kpi-val').text())]));
const tabs = (w: VueWrapper) =>
  w.findAll('.ax__tab').map((c) => [c.get('.ax__tab-label').text(), Number(c.get('.ax__tab-count').text())]);
const rowNames = (w: VueWrapper) => w.findAll('.ax__row').map((r) => r.get('.ax__row-msg').text());

describe('Alarms page — layers of each alarm', () => {
  it('counts every rule and every relation, and each alarm under each of its layers', async () => {
    const w = await mountAlarms();
    expect(alarmReads.at(-1)!.get('page')).toBeNull();
    expect(tiles(w)).toEqual({ Active: 5, General: 3, Other: 2 });
    // Unpinned layers are tabs above the list; there is no chip row beside the tiles.
    expect(w.find('.ax__chips').exists()).toBe(false);
    expect(tabs(w)).toEqual([
      ['All', 5],
      ['General', 3],
      ['So11y Java Agent', 2],
      ['Mesh', 1],
      ['Other', 2],
    ]);
  });

  it('lets "Other" be picked, and lists the alarms no rendered pin matches', async () => {
    const w = await mountAlarms();
    const other = w.findAll('.ax__kpi').find((b) => b.text().startsWith('Other'))!;
    expect(other.attributes('disabled')).toBeUndefined();
    await other.trigger('click');
    await flushPromises();
    expect(router.currentRoute.value.query.layer).toBe('OTHER');
    const rows = rowNames(w);
    expect(rows).toHaveLength(2);
    expect(rows.join(' ')).toContain('mesh::edge');
    expect(rows.join(' ')).toContain('g-1 of ghost');
  });

  it('opens the row that was clicked, even when another alarm shares its id and time', async () => {
    const w = await mountAlarms();
    const rows = w.findAll('.ax__row');
    const msgOf = (r: (typeof rows)[number]) => r.get('.ax__row-msg').text();
    const target = rows.find((r) => msgOf(r).includes('POST:/users in payments::checkout'))!;
    await target.trigger('click');
    await flushPromises();
    const active = w.findAll('.ax__row.active');
    expect(active).toHaveLength(1);
    expect(msgOf(active[0]!)).toContain('POST:/users in payments::checkout');
  });

  it('says the read failed instead of showing a window with no alarms', async () => {
    alarmsReply = () => json({ error: 'catalog_unavailable', message: 'The service catalog could not be read' }, 503);
    const w = await mountAlarms();
    expect(w.get('.ax__empty--err').text()).toContain('The service catalog could not be read');
    expect(w.text()).not.toContain('No alarms in the current window.');
    expect(w.findAll('.ax__kpi-val').map((v) => v.text())).toEqual(['—', '—', '—']);
    const tabCounts = w.findAll('.ax__tab-count').map((c) => c.text());
    expect(tabCounts.length).toBeGreaterThan(0);
    expect(tabCounts.every((c) => c === '—')).toBe(true);
  });
});

describe('Alarms page — pins with service groups', () => {
  beforeEach(() => {
    alarmsReply = () => json({ returned: GROUPED.length, pageNum: 1, pageSize: 500, truncated: false, generatedAt: NOW, msgs: GROUPED });
    pagesReply = () =>
      json({ unreachable: false, default: view({ id: 'default', pinnedLayers: ['GENERAL[payments]', 'GENERAL[-]'] }), pages: [] });
  });

  it('counts under a group pin only the alarms whose services are in that group', async () => {
    const w = await mountAlarms();
    expect(tiles(w)).toEqual({ Active: 4, 'payments · General': 2, 'no group · General': 1, Other: 1 });
    // A layer a pin names gets no whole-layer tab of its own, grouped or not:
    // its other alarms count under Other, as on a page that pins it whole.
    expect(tabs(w)).toEqual([
      ['All', 4],
      ['payments · General', 2],
      ['no group · General', 1],
      ['Other', 1],
    ]);
  });

  it('draws one tile for the same groups pinned in another order', async () => {
    pagesReply = () =>
      json({ unreachable: false, default: view({ id: 'default', pinnedLayers: ['GENERAL[payments, -]', 'GENERAL[-, payments]'] }), pages: [] });
    const w = await mountAlarms();
    expect(Object.keys(tiles(w))).toEqual(['Active', 'payments, no group · General', 'Other']);
  });

  it('narrows to a group pin, keeping the group as written in the URL', async () => {
    const w = await mountAlarms();
    const payments = w.findAll('.ax__kpi').find((b) => b.text().startsWith('payments'))!;
    await payments.trigger('click');
    await flushPromises();
    expect(router.currentRoute.value.query.layer).toBe('GENERAL[payments]');
    expect(payments.classes()).toContain('active');
    expect(rowNames(w).sort()).toEqual(['payments::checkout fired', 'risk::scorer to payments::checkout fired']);
  });

  it('reads a group pin back from the URL without upper-casing the group', async () => {
    await router.replace('/alarms?layer=general[payments]');
    const w = await mountAlarms();
    expect(w.findAll('.ax__kpi.active').map((b) => b.get('.ax__kpi-label').text())).toEqual(['payments · General']);
    expect(rowNames(w)).toHaveLength(2);
  });
});

describe('Alarms page — the pages a reader is served', () => {
  it('draws the pins the pages route narrowed, not the configured ones', async () => {
    pagesReply = () => json({ unreachable: false, default: view({ id: 'default', pinnedLayers: ['GENERAL'], hiddenPins: 2 }), pages: [] });
    const w = await mountAlarms();
    expect(Object.keys(tiles(w))).toEqual(['Active', 'General', 'Other']);
    expect(w.get('.ax__note').text()).toContain('pinned layers are outside your access.');
  });

  it('says nothing about hidden pins when there are none', async () => {
    const w = await mountAlarms();
    expect(w.find('.ax__note').exists()).toBe(false);
  });

  it('draws no pinned tile, and says why, when the default page cannot be read', async () => {
    pagesReply = () => json({ unreachable: true, default: null, pages: [] });
    const w = await mountAlarms();
    expect(tiles(w)).toEqual({ Active: 5, Other: 5 });
    expect(w.get('.ax__note').text()).toBe('The default alarm page could not be read, so no layers are pinned.');
  });

  it('shows a named page with its own title, pins and starting window', async () => {
    pagesReply = () =>
      json({
        unreachable: false,
        default: view({ id: 'default', pinnedLayers: ['GENERAL'] }),
        pages: [view({ id: 'payments', title: 'Payments on-call', pinnedLayers: ['GENERAL[payments]'], defaultWindowMs: 7_200_000 })],
      });
    alarmsReply = servePages(GROUPED, { payments: ['GENERAL[payments]'] });
    const w = await mountAlarms('payments');
    expect(w.get('.ax__h1').text()).toBe('Payments on-call');
    expect(tiles(w)).toEqual({ Active: 2, 'payments · General': 2 });
    const read = alarmReads.at(-1)!;
    expect(Number(read.get('endTime')) - Number(read.get('startTime'))).toBe(7_200_000);
  });

  it('says a page the reader is not served is not available, and reads no alarms for it', async () => {
    const w = await mountAlarms('nope');
    expect(w.text()).toContain('This alarm page does not exist or is not available to you.');
    expect(w.get('.ax__empty a').attributes('href')).toBe('/alarms');
    expect(alarmReads).toHaveLength(0);
  });

  it('starts another page afresh: filter and selection cleared, its own window applied', async () => {
    pagesReply = () =>
      json({
        unreachable: false,
        default: view({ id: 'default', pinnedLayers: ['GENERAL'] }),
        pages: [view({ id: 'mesh', title: 'Mesh', pinnedLayers: ['MESH'], defaultWindowMs: 14_400_000 })],
      });
    // A service filter reads that service's alarms alone, as OAP answers it.
    alarmsReply = (q) => {
      const service = q.get('service');
      return servePages(service ? MSGS.filter((m) => m.name.includes(service)) : MSGS, { mesh: ['MESH'] })(q);
    };
    const w = await mountAlarms();
    const [layerPick, servicePick] = w.findAll('.ax__filters select');
    await layerPick!.setValue('GENERAL');
    await flushPromises();
    await servicePick!.setValue('payments::checkout');
    await w.get('.ax__filter-apply').trigger('click');
    await flushPromises();
    expect(alarmReads.at(-1)!.get('service')).toBe('payments::checkout');
    await w.findAll('.ax__row')[0]!.trigger('click');
    expect(w.findAll('.ax__row.active')).toHaveLength(1);

    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const reply = alarmsReply;
    alarmsReply = async (q) => {
      await held;
      return reply(q);
    };
    const readsBefore = alarmReads.length;
    await w.setProps({ pageId: 'mesh' });
    await flushPromises();
    expect(w.get('.ax__h1').text()).toBe('Mesh');
    // The new window is being read: no count yet, not the last page's, not zero.
    expect(w.findAll('.ax__kpi-val').map((v) => v.text())).toEqual(['—', '—']);
    expect(w.text()).toContain('loading…');

    release();
    await flushPromises();
    expect(tiles(w)).toEqual({ Active: 1, Mesh: 1 });
    expect(w.findAll('.ax__row.active')).toHaveLength(0);
    // One read for the new page, not one that still carries the old filter first.
    expect(alarmReads).toHaveLength(readsBefore + 1);
    const read = alarmReads.at(-1)!;
    expect(read.get('page')).toBe('mesh');
    expect(Number(read.get('endTime')) - Number(read.get('startTime'))).toBe(14_400_000);
    expect(read.get('layer')).toBeNull();
    expect(read.get('service')).toBeNull();
    expect((w.findAll('.ax__filters select')[0]!.element as HTMLSelectElement).value).toBe('');
  });

  it('links to the page setup only for a reader who may open it', async () => {
    const withSetup = await mountAlarms();
    expect(withSetup.find('.ax__lede a[href="/admin/alert-page-setup"]').exists()).toBe(true);
    session.setup = false;
    const without = await mountAlarms();
    expect(without.find('.ax__lede a').exists()).toBe(false);
    expect(without.get('.ax__lede').text()).toContain('Click a tile or a tab to narrow the list');
  });

  it('reads a layer-limited reader their own alarms without asking them to pick a service', async () => {
    session.limited = true;
    const w = await mountAlarms();
    expect(alarmReads).toHaveLength(1);
    expect(alarmReads[0]!.get('service')).toBeNull();
    expect(w.text()).not.toContain('Pick a layer and a service');
    expect(rowNames(w)).toHaveLength(MSGS.length);
  });

  it('does not call a partial read empty', async () => {
    alarmsReply = () => json({ returned: 0, pageNum: 1, pageSize: 500, truncated: true, generatedAt: NOW, msgs: [] });
    const w = await mountAlarms();
    expect(w.get('.ax__empty').text()).toContain('more alarms in this window than were fetched');
  });
});

describe('Alarms page — a named page lists only what its pins cover', () => {
  const PINS: Record<string, string[]> = { payments: ['GENERAL[payments]'] };
  beforeEach(() => {
    pagesReply = () =>
      json({
        unreachable: false,
        default: view({ id: 'default', pinnedLayers: ['GENERAL'] }),
        pages: [
          view({ id: 'payments', title: 'Payments on-call', pinnedLayers: PINS.payments }),
          // Served by the pages route when it was read, and no longer by the list route.
          view({ id: 'retired', title: 'Retired', pinnedLayers: ['MESH'] }),
        ],
      } satisfies AlarmPagesResponse);
    alarmsReply = servePages(MSGS, PINS);
  });

  it('asks for the page, and counts and tabs its pins alone: no Other, no layer tabs', async () => {
    const w = await mountAlarms('payments');
    expect(alarmReads.at(-1)!.get('page')).toBe('payments');
    // The payments rows are in So11y Java Agent too; the default page would give that layer a tab.
    expect(tiles(w)).toEqual({ Active: 3, 'payments · General': 3 });
    expect(tabs(w)).toEqual([
      ['All', 3],
      ['payments · General', 3],
    ]);
    expect(rowNames(w)).toHaveLength(3);
  });

  it('reads the page again when its pins change, rather than re-arranging the old rows', async () => {
    const w = await mountAlarms('payments');
    expect(rowNames(w)).toHaveLength(3);
    const before = alarmReads.length;
    // Another admin re-pins the page; the pages are read again.
    PINS.payments = ['MESH'];
    await queryClient.invalidateQueries({ queryKey: ['alarms/pages'] });
    await flushPromises();
    expect(alarmReads.length).toBe(before + 1);
    expect(tiles(w)).toEqual({ Active: 1, Mesh: 1 });
    expect(rowNames(w).join(' ')).toContain('mesh::edge');
    PINS.payments = ['GENERAL[payments]'];
  });

  it('offers only the page\'s layers to filter by, and asks for the services of the page', async () => {
    const w = await mountAlarms('payments');
    const layerSelect = w.findAll('.ax__filter select')[0]!;
    const offered = layerSelect.findAll('option').map((o) => o.attributes('value'));
    expect(offered).toEqual(['', 'GENERAL']);
    await layerSelect.setValue('GENERAL');
    await flushPromises();
    expect(serviceReads.at(-1)!.get('page')).toBe('payments');

    // The default page offers every layer the reader reads, and asks for no page.
    const d = await mountAlarms();
    expect(d.findAll('.ax__filter select')[0]!.findAll('option').map((o) => o.attributes('value'))).toEqual(['', 'GENERAL', 'MESH']);
    await d.findAll('.ax__filter select')[0]!.setValue('GENERAL');
    await flushPromises();
    expect(serviceReads.at(-1)!.get('page')).toBeNull();
  });

  it('draws the pins its rows were read by, and reads the pages again, when a refresh finds the page re-pinned', async () => {
    const w = await mountAlarms('payments');
    expect(tiles(w)).toEqual({ Active: 3, 'payments · General': 3 });
    const pagesBefore = pagesReads;
    // Re-pinned elsewhere. The pages answer is held back, so what the page
    // draws meanwhile can only come from the rows' own read.
    PINS.payments = ['MESH'];
    const served = pagesReply;
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    pagesReply = (async () => {
      await held;
      return served();
    }) as unknown as () => Response;
    await w.get('.ax__refresh').trigger('click');
    await flushPromises();
    expect(tiles(w)).toEqual({ Active: 1, Mesh: 1 });
    expect(w.findAll('.ax__filter select')[0]!.findAll('option').map((o) => o.attributes('value'))).toEqual(['', 'MESH']);
    expect(pagesReads).toBeGreaterThan(pagesBefore);
    release();
    await flushPromises();
    expect(tiles(w)).toEqual({ Active: 1, Mesh: 1 });
    PINS.payments = ['GENERAL[payments]'];
  });

  it('drops a filter the page no longer offers when its pins change, before reading again', async () => {
    const w = await mountAlarms('payments');
    const layerSelect = w.findAll('.ax__filter select')[0]!;
    await layerSelect.setValue('GENERAL');
    await flushPromises();
    await w.get('.ax__filter-apply').trigger('click');
    await flushPromises();
    expect(alarmReads.at(-1)!.get('layer')).toBe('GENERAL');

    PINS.payments = ['MESH'];
    await queryClient.invalidateQueries({ queryKey: ['alarms/pages'] });
    await flushPromises();
    const read = alarmReads.at(-1)!;
    expect(read.get('page')).toBe('payments');
    expect(read.get('layer')).toBeNull();
    expect(tiles(w)).toEqual({ Active: 1, Mesh: 1 });
    PINS.payments = ['GENERAL[payments]'];
  });

  it('selects nothing for a ?layer= the page does not offer', async () => {
    await router.replace('/alarms/payments?layer=OTHER');
    const w = await mountAlarms('payments');
    expect(w.findAll('.ax__kpi.active').map((b) => b.get('.ax__kpi-label').text())).toEqual(['Active']);
    expect(rowNames(w)).toHaveLength(3);
  });

  it('reads again on every move between a named page and the default page, once each, clearing the counts meanwhile', async () => {
    // The clock stands still for the first move, so only the page tells the reads apart.
    const clock = vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const w = await mountAlarms(undefined, true);
    expect(alarmReads).toHaveLength(1);

    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    alarmsReply = async (q) => {
      await held;
      return servePages(MSGS, PINS)(q);
    };
    await w.setProps({ pageId: 'payments' });
    await flushPromises();
    expect(w.findAll('.ax__kpi-val').map((v) => v.text())).toEqual(['—', '—']);
    expect(w.text()).toContain('loading…');
    release();
    await flushPromises();
    expect(alarmReads).toHaveLength(2);
    expect(alarmReads[1]!.get('page')).toBe('payments');
    expect(tiles(w)).toEqual({ Active: 3, 'payments · General': 3 });

    // Back on the default page later: its earlier read is still
    // cached, and must not be served in place of the current window.
    clock.mockReturnValue(NOW + 30_000);
    await w.setProps({ pageId: undefined });
    await flushPromises();
    expect(alarmReads).toHaveLength(3);
    expect(alarmReads[2]!.get('page')).toBeNull();
    expect(tiles(w)).toEqual({ Active: 5, General: 3, Other: 2 });
  });

  it('says a page the list route no longer serves is not available, and reads the pages again', async () => {
    const w = await mountAlarms('retired');
    expect(alarmReads.at(-1)!.get('page')).toBe('retired');
    expect(w.text()).toContain('This alarm page does not exist or is not available to you.');
    expect(w.get('.ax__empty a').attributes('href')).toBe('/alarms');
    expect(w.find('.ax__kpis').exists()).toBe(false);
    expect(pagesReads).toBe(2);
  });
});
