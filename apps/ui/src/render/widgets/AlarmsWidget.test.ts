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
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import { createPinia } from 'pinia';
import { i18n } from '@/i18n';
import type { AlarmMessage } from '@/api/client';
import AlarmsWidget from './AlarmsWidget.vue';

function reply(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
}

let alarmsReply: () => Response;
let queryAlarms: boolean;
let alarmReads: URLSearchParams[];

beforeEach(() => {
  queryAlarms = true;
  alarmReads = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input), 'http://ui');
      if (url.pathname === '/api/alarms') {
        alarmReads.push(url.searchParams);
        return alarmsReply();
      }
      if (url.pathname === '/api/oap/info') return reply(200, { reachable: true, capabilities: { queryAlarms } });
      return reply(200, {});
    }),
  );
});

async function draw(layer = 'GENERAL') {
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:p(.*)*', component: { template: '<div />' } }] });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const w = mount(AlarmsWidget, {
    props: { title: 'Alarms', layer },
    global: { plugins: [router, i18n, createPinia(), [VueQueryPlugin, { queryClient }]] },
  });
  await flushPromises();
  return w;
}

function firing(name: string, layerKeys: string[], owners: AlarmMessage['owners']): AlarmMessage {
  return {
    id: btoa(name),
    startTime: Date.now() - 60_000,
    recoveryTime: null,
    scope: 'Service',
    name,
    message: `${name} fired`,
    tags: [],
    snapshot: { expression: 'rule', metrics: [] },
    layerKeys,
    layerKey: layerKeys[0] ?? null,
    owners,
  };
}
const CHECKOUT = firing('checkout', ['GENERAL'], [{ layer: 'GENERAL', group: 'payments' }]);
const SCORER = firing('scorer', ['GENERAL'], [{ layer: 'GENERAL', group: 'risk' }]);
const EDGE = firing('edge', ['MESH'], [{ layer: 'MESH', group: '' }]);
const listed = (msgs: AlarmMessage[]) => () =>
  reply(200, { returned: msgs.length, pageNum: 1, pageSize: 200, truncated: false, generatedAt: Date.now(), msgs });
const shown = (w: Awaited<ReturnType<typeof draw>>) => w.findAll('.alarm-row .rule').map((r) => r.text());

describe('AlarmsWidget', () => {
  it('says the read failed instead of showing a window with no alarms', async () => {
    alarmsReply = () => reply(503, { error: 'catalog_unavailable', message: 'The service catalog could not be read' });
    const w = await draw();
    expect(w.get('.empty--err').text()).toContain('The service catalog could not be read');
    expect(w.text()).not.toContain('No alarms in the');
    expect(w.get('.total').text()).toMatch(/^— /);
  });

  it('still says a window with no alarms has none', async () => {
    alarmsReply = () => reply(200, { returned: 0, pageNum: 1, pageSize: 200, truncated: false, generatedAt: Date.now(), msgs: [] });
    const w = await draw();
    expect(w.find('.empty--err').exists()).toBe(false);
    expect(w.text()).toContain('No alarms in the');
  });

  it('does not call a partial read empty', async () => {
    alarmsReply = () => reply(200, { returned: 0, pageNum: 1, pageSize: 200, truncated: true, generatedAt: Date.now(), msgs: [] });
    const w = await draw();
    expect(w.text()).toContain('more alarms in this window than were fetched');
    expect(w.text()).not.toContain('No alarms in the');
  });
});

// A widget on one service group of a layer names it `GENERAL[payments]`.
describe('AlarmsWidget on one service group', () => {
  it('asks the BFF for the group as written, and shows what it returns', async () => {
    alarmsReply = listed([CHECKOUT]);
    const w = await draw('GENERAL[payments]');
    expect(alarmReads.at(-1)!.get('layer')).toBe('GENERAL[payments]');
    expect(shown(w)).toEqual(['checkout fired']);
  });

  it('narrows a legacy read, which covers every layer, to that group', async () => {
    queryAlarms = false;
    alarmsReply = listed([CHECKOUT, SCORER, EDGE]);
    const w = await draw('general[payments]');
    expect(alarmReads.every((q) => q.get('layer') === null)).toBe(true);
    expect(shown(w)).toEqual(['checkout fired']);
  });

  it('shows nothing for a layer that names no pin, rather than every layer', async () => {
    queryAlarms = false;
    alarmsReply = listed([CHECKOUT, SCORER, EDGE]);
    const w = await draw('GENERAL~payments');
    expect(shown(w)).toEqual([]);
  });

  it('narrows a legacy read to a whole layer by the rows\' layers', async () => {
    queryAlarms = false;
    alarmsReply = listed([CHECKOUT, SCORER, EDGE]);
    const w = await draw('general');
    expect(shown(w).sort()).toEqual(['checkout fired', 'scorer fired']);
  });
});
