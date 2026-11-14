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
 * A trace id the native store does not hold — a bare id from a log row, which
 * may belong to an OTLP or Zipkin trace — is offered to those stores, keeping
 * the time hint the link carried.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { ref } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter, type Router } from 'vue-router';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import type { LayerDef } from '@skywalking-horizon-ui/api-client';
import { i18n } from '@/i18n';
import TracePopout from './TracePopout.vue';

const menu = ref([] as unknown as LayerDef[]);
vi.mock('@/shell/useLayers', () => ({ useLayers: () => ({ layers: menu }) }));

let router: Router;
let wrapper: VueWrapper | null = null;

beforeEach(async () => {
  setActivePinia(createPinia());
  vi.stubGlobal('fetch', vi.fn(async () => new Response(
    JSON.stringify({ generatedAt: 0, source: 'native', native: { spans: [], reachable: true } }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )));
  router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div />' } }] });
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  vi.unstubAllGlobals();
});

describe('a native trace popout with no spans', () => {
  it('offers the OTLP and Zipkin stores for the same id and time', async () => {
    await router.push('/operate/log-inspect?traceId=0af7651916cd43dd8448eb211c80319c&traceType=native&traceAt=1700000000000');
    wrapper = mount(TracePopout, {
      global: { plugins: [router, i18n, [VueQueryPlugin, { queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }]] },
    });
    await flushPromises();
    expect(wrapper.text()).toContain('Not a SkyWalking trace? Query this id from:');
    const offered = wrapper.findAll('.tp-elsewhere button').map((b) => b.text());
    expect(offered).toEqual(['zipkin', 'traceql-otlp']);
    await wrapper.findAll('.tp-elsewhere button')[1]!.trigger('click');
    await flushPromises();
    expect(router.currentRoute.value.query).toMatchObject({
      traceId: '0af7651916cd43dd8448eb211c80319c',
      traceType: 'traceql-otlp',
      traceAt: '1700000000000',
    });
  });
});
