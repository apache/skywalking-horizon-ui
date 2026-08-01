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
 * The alarms page reads the picked service's identity, not just its name.
 *
 * The composable resolves the roster's `normal` flag and the api façade
 * serializes it, but neither proves the page SENDS it: the view is the join
 * between them, so this drives the real filter row (pick a layer, pick a
 * service, apply) and reads the request that left the browser.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createMemoryHistory, createRouter, type Router } from 'vue-router';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import { i18n } from '@/i18n';
import AlarmsView from './AlarmsView.vue';

const LAYER = 'VIRTUAL_DATABASE';
/** A conjectural service and an agent-reporting one, on the same roster. */
const VIRTUAL = 'mysql-a';
const NORMAL = 'songs';

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** A BFF whose alarms roster carries both flags, so the page has to pick the
 *  right one rather than land on it by default. */
function fakeBff() {
  const asked: string[] = [];
  const fetchSpy = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    asked.push(url);
    const path = new URL(url, 'http://ui').pathname;
    if (path === '/api/menu') {
      return jsonResponse({
        layers: [
          {
            key: LAYER,
            name: 'Virtual Database',
            color: '#fff',
            serviceCount: 2,
            active: true,
            level: null,
            slots: {},
            caps: {},
          },
        ],
        oap: { reachable: true },
      });
    }
    if (path === '/api/oap/info') {
      return jsonResponse({ reachable: true, capabilities: { queryAlarms: true } });
    }
    if (path === '/api/admin/templates/sync-status') {
      return jsonResponse({
        mode: 'live',
        unreachable: false,
        lastSuccessfulSyncAt: null,
        generatedAt: 0,
        rows: [],
      });
    }
    if (path === '/api/alarms/services') {
      return jsonResponse({
        layer: LAYER,
        services: [
          { name: VIRTUAL, normal: false },
          { name: NORMAL, normal: true },
        ],
      });
    }
    if (path.endsWith('/instances')) return jsonResponse({ reachable: true, instances: [] });
    if (path.endsWith('/endpoints')) return jsonResponse({ reachable: true, endpoints: [] });
    if (path === '/api/alarms') {
      return jsonResponse({
        total: 0,
        pageNum: 1,
        pageSize: 500,
        truncated: false,
        generatedAt: 0,
        msgs: [],
      });
    }
    return jsonResponse({});
  });

  return {
    fetchSpy,
    /** The query string of the most recent alarm list request. */
    lastAlarmsQuery(): URLSearchParams {
      const hit = [...asked].reverse().find((u) => new URL(u, 'http://ui').pathname === '/api/alarms');
      return new URL(hit ?? '/api/alarms', 'http://ui').searchParams;
    },
  };
}

let router: Router;

async function mountAlarms(): Promise<VueWrapper> {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const w = mount(AlarmsView, {
    global: {
      plugins: [router, i18n, [VueQueryPlugin, { queryClient }]],
      // Both render through ECharts, which jsdom's canvas-less DOM can't
      // paint — mounting them for real throws out of `setOption`.
      stubs: { AlarmsTimeline: true, AlarmDetailPanel: true },
    },
  });
  await flushPromises();
  return w;
}

/** Drive the filter row the way an operator does, then commit it. */
async function filterBy(w: VueWrapper, service: string | null): Promise<void> {
  const selects = w.findAll('.ax__filters select');
  await selects[0]!.setValue(LAYER);
  await flushPromises();
  if (service !== null) {
    await w.findAll('.ax__filters select')[1]!.setValue(service);
    await flushPromises();
  }
  await w.get('.ax__filter-apply').trigger('click');
  await flushPromises();
}

beforeEach(async () => {
  router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div />' } }],
  });
  await router.push('/alarms');
  await router.isReady();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Alarms page — the applied filter sends the service identity', () => {
  it('asks for a virtual service as virtual', async () => {
    const bff = fakeBff();
    vi.stubGlobal('fetch', bff.fetchSpy);
    const w = await mountAlarms();

    await filterBy(w, VIRTUAL);

    const q = bff.lastAlarmsQuery();
    expect(q.get('layer')).toBe(LAYER);
    expect(q.get('service')).toBe(VIRTUAL);
    expect(q.get('normal')).toBe('false');
  });

  it('asks for an agent-reporting service as normal', async () => {
    const bff = fakeBff();
    vi.stubGlobal('fetch', bff.fetchSpy);
    const w = await mountAlarms();

    await filterBy(w, NORMAL);

    const q = bff.lastAlarmsQuery();
    expect(q.get('service')).toBe(NORMAL);
    expect(q.get('normal')).toBe('true');
  });

  it('sends no flag when the filter names no service — there is nothing to qualify', async () => {
    const bff = fakeBff();
    vi.stubGlobal('fetch', bff.fetchSpy);
    const w = await mountAlarms();

    await filterBy(w, null);

    const q = bff.lastAlarmsQuery();
    expect(q.get('layer')).toBe(LAYER);
    expect(q.get('service')).toBeNull();
    expect(q.get('normal')).toBeNull();
  });
});
