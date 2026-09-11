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
 * The Zipkin trace popout opens a picked span in a centered dialog over the
 * waterfall — the shape the Traces tab's trace detail uses — so the waterfall
 * keeps the popout's full width. The backdrop and Escape each close one layer:
 * the dialog first, then the popout.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type DOMWrapper, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter, type Router } from 'vue-router';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import type { ZipkinSpan } from '@skywalking-horizon-ui/api-client';
import { i18n } from '@/i18n';
import ZipkinTracePopout from './ZipkinTracePopout.vue';

const TRACE = '5af7183fb1d4cf5f';
const T0 = (Date.now() - 60_000) * 1000;

function span(id: string, parentId: string | null, name: string, offsetUs: number, durationUs: number): ZipkinSpan {
  return {
    traceId: TRACE,
    id,
    parentId,
    name,
    kind: 'SERVER',
    timestamp: T0 + offsetUs,
    duration: durationUs,
    localEndpoint: { serviceName: 'gateway' },
    tags: { 'db.statement': `${name} …` },
  };
}
const SPANS = [span('s1', null, 'get /checkout', 0, 9000), span('s2', 's1', 'select orders', 1000, 4000)];

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

let router: Router;
let wrapper: VueWrapper | null = null;

/** Open the popout the way every caller does — by the address. */
async function openPopout(extra: Record<string, string> = {}): Promise<VueWrapper> {
  await router.push({ path: '/layer/mesh/trace', query: { traceId: TRACE, traceType: 'OTLP', ...extra } });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  wrapper = mount(ZipkinTracePopout, {
    global: { plugins: [router, i18n, [VueQueryPlugin, { queryClient }]] },
  });
  await flushPromises();
  return wrapper;
}

/** The waterfall row of one span, found by the name drawn in its bar. */
function rowOf(w: VueWrapper, name: string): DOMWrapper<Element> {
  const row = w.findAll('.zk-waterfall .tp-row').find((r) => r.text().includes(name));
  if (!row) throw new Error(`no waterfall row for ${name}`);
  return row;
}

async function pressEscape(): Promise<void> {
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  await flushPromises();
}

beforeEach(async () => {
  setActivePinia(createPinia());
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const path = new URL(String(input), 'http://ui').pathname;
      if (path === `/api/zipkin/trace/${TRACE}`) {
        return jsonResponse({ source: 'zipkin', traceId: TRACE, spans: SPANS, reachable: true });
      }
      return jsonResponse({});
    }),
  );
  router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div />' } }],
  });
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  vi.unstubAllGlobals();
});

describe('Zipkin trace popout — a picked span opens in a dialog over the waterfall', () => {
  it('opens the span in a centered dialog, with the whole waterfall still under it', async () => {
    const w = await openPopout();
    await rowOf(w, 'select orders').trigger('click');

    const dialog = w.find('.span-modal-backdrop .span-modal');
    expect(dialog.exists()).toBe(true);
    expect(dialog.get('.span-modal-head').text()).toContain('select orders');
    expect(dialog.text()).toContain('db.statement');
    expect(w.findAll('.zk-waterfall .tp-row')).toHaveLength(2);
  });

  it('closes the dialog on a backdrop click and keeps the trace; a click inside keeps the dialog', async () => {
    const w = await openPopout();
    await rowOf(w, 'select orders').trigger('click');

    await w.get('.span-modal-body').trigger('click');
    expect(w.find('.span-modal').exists()).toBe(true);

    await w.get('.span-modal-backdrop').trigger('click');
    expect(w.find('.span-modal').exists()).toBe(false);
    expect(w.find('.zk-popout').exists()).toBe(true);
  });

  it('closes the dialog on the first Escape and the popout on the second', async () => {
    const w = await openPopout();
    await rowOf(w, 'select orders').trigger('click');

    await pressEscape();
    expect(w.find('.span-modal').exists()).toBe(false);
    expect(w.find('.zk-popout').exists()).toBe(true);

    await pressEscape();
    expect(router.currentRoute.value.query.traceId).toBeUndefined();
    expect(w.find('.zk-popout').exists()).toBe(false);
  });

  it('opens on the span a link names, as an evaluation record’s trace link does', async () => {
    const w = await openPopout({ traceSpanId: 's2' });
    expect(w.get('.span-modal-head').text()).toContain('select orders');
  });
});
