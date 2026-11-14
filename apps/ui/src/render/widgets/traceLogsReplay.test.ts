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
 * A trace detail replayed from an AI chat block shows what was captured, and a
 * trace's logs never are — so a replayed detail offers no Logs and no Related
 * logs, where a live one offers both.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter, type Router } from 'vue-router';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import type { NativeSpan, ZipkinSpan } from '@skywalking-horizon-ui/api-client';
import { i18n } from '@/i18n';
import TraceDetailCard from './TraceDetailCard.vue';
import SpanDetailModal from './SpanDetailModal.vue';
import ZipkinTraceDetailCard from './ZipkinTraceDetailCard.vue';

const NOW = Date.now();
const NATIVE: NativeSpan = {
  traceId: 't1', segmentId: 't1.seg', spanId: 0, parentSpanId: -1, refs: [],
  serviceCode: 'checkout', serviceInstanceName: 'i1', startTime: NOW - 5, endTime: NOW, endpointName: 'GET /checkout',
  type: 'Entry', peer: '', component: 'SpringMVC', isError: false, layer: 'Http', tags: [], logs: [], attachedEvents: [],
};
const ZIPKIN = {
  traceId: 'a1b2c3d4e5f60718', id: '0123456789abcdef', name: 'get /checkout',
  timestamp: NOW * 1000, duration: 5000, localEndpoint: { serviceName: 'checkout' }, tags: {},
} as unknown as ZipkinSpan;

let router: Router;
let wrapper: VueWrapper | null = null;
const reads: string[] = [];

beforeEach(async () => {
  setActivePinia(createPinia());
  reads.length = 0;
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    reads.push(new URL(String(input), 'http://ui').pathname);
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  }));
  router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div />' } }] });
  await router.push('/layer/general/trace');
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  vi.unstubAllGlobals();
});

const plugins = () => [router, i18n, [VueQueryPlugin, { queryClient: new QueryClient() }]] as never;
const buttons = (w: VueWrapper, label: string) => w.findAll('button').filter((b) => b.text().trim() === label);

describe('a replayed trace detail offers no live log reads', () => {
  for (const replay of [false, true]) {
    it(`the native card ${replay ? 'drops' : 'offers'} Logs`, async () => {
      wrapper = mount(TraceDetailCard, {
        props: { spans: [NATIVE], traceId: 't1', traceIds: ['t1'], replay },
        global: { plugins: plugins() },
      });
      expect(buttons(wrapper, 'Logs')).toHaveLength(replay ? 0 : 1);
    });

    it(`the native span dialog ${replay ? 'drops' : 'offers'} Related logs`, async () => {
      wrapper = mount(SpanDetailModal, {
        props: { span: NATIVE, traceId: 't1', serviceColors: new Map(), replay },
        global: { plugins: plugins() },
      });
      expect(buttons(wrapper, 'Related logs')).toHaveLength(replay ? 0 : 1);
    });

    it(`the Zipkin card ${replay ? 'drops' : 'offers'} Logs and its span's Related logs`, async () => {
      wrapper = mount(ZipkinTraceDetailCard, {
        props: { spans: [ZIPKIN], traceId: 'a1b2c3d4e5f60718', replay },
        global: { plugins: plugins() },
        attachTo: document.body,
      });
      expect(buttons(wrapper, 'Logs')).toHaveLength(replay ? 0 : 1);
      await wrapper.get('.tp-row').trigger('click');
      await flushPromises();
      expect(buttons(wrapper, 'Related logs')).toHaveLength(replay ? 0 : 1);
    });
  }

  it('reads no logs from a replayed detail', async () => {
    wrapper = mount(ZipkinTraceDetailCard, {
      props: { spans: [ZIPKIN], traceId: 'a1b2c3d4e5f60718', replay: true },
      global: { plugins: plugins() },
      attachTo: document.body,
    });
    await wrapper.get('.tp-row').trigger('click');
    await flushPromises();
    expect(reads.filter((p) => p.includes('/logs'))).toEqual([]);
  });
});
