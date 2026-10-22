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
 * A native span's cross-trace ref points at another NATIVE trace. On a page
 * whose own traces are Zipkin, a jump that names no store would be handed to
 * the Zipkin popout and read from the wrong store.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { ref } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter, type Router } from 'vue-router';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import type { LayerDef, NativeSpan } from '@skywalking-horizon-ui/api-client';
import { i18n } from '@/i18n';
import SpanDetailModal from '@/render/widgets/SpanDetailModal.vue';
import TracePopout from './TracePopout.vue';

const menu = ref([{ key: 'mesh', traces: { sources: ['zipkin'] } }] as unknown as LayerDef[]);
vi.mock('@/shell/useLayers', () => ({ useLayers: () => ({ layers: menu }) }));

const NOW = Date.now();
function span(traceId: string, refTo: string): NativeSpan {
  return {
    traceId, segmentId: `${traceId}.seg`, spanId: 0, parentSpanId: -1,
    refs: [{ traceId: refTo, parentSegmentId: `${refTo}.seg`, parentSpanId: 0, type: 'CROSS_PROCESS' }],
    serviceCode: 'checkout', serviceInstanceName: 'i1', startTime: NOW - 5, endTime: NOW, endpointName: 'GET /checkout',
    type: 'Entry', peer: '', component: 'SpringMVC', isError: false, layer: 'Http', tags: [], logs: [], attachedEvents: [],
  };
}

let router: Router;
let wrapper: VueWrapper | null = null;

beforeEach(async () => {
  setActivePinia(createPinia());
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const path = new URL(String(input), 'http://ui').pathname;
    const id = decodeURIComponent(path.replace('/api/trace/', ''));
    return new Response(JSON.stringify({ generatedAt: 0, source: 'native', native: { spans: [span(id, 'upstream')], reachable: true } }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }));
  router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div />' } }] });
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  vi.unstubAllGlobals();
});

const queryClient = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

describe('a native span\'s cross-trace ref, on a page whose traces are Zipkin', () => {
  it('the span dialog opens the referenced trace as native', async () => {
    await router.push('/layer/mesh/service');
    wrapper = mount(SpanDetailModal, {
      props: { span: span('t1', 'upstream'), traceId: 't1', serviceColors: new Map() },
      global: { plugins: [router, i18n, [VueQueryPlugin, { queryClient: queryClient() }]] },
    });
    await wrapper.get('.trace-link').trigger('click');
    await flushPromises();
    expect(router.currentRoute.value.query).toMatchObject({ traceId: 'upstream', traceType: 'native' });
  });

  it('the native popout swaps to the referenced trace and stays native', async () => {
    await router.push({ path: '/layer/mesh/service', query: { traceId: 't1', traceType: 'native' } });
    wrapper = mount(TracePopout, { global: { plugins: [router, i18n, [VueQueryPlugin, { queryClient: queryClient() }]] } });
    await flushPromises();
    await wrapper.get('.tp-row').trigger('click');
    await wrapper.get('.trace-link').trigger('click');
    await flushPromises();
    expect(router.currentRoute.value.query).toMatchObject({ traceId: 'upstream', traceType: 'native' });
    expect(wrapper.find('.tp-card').exists()).toBe(true);
  });
});
