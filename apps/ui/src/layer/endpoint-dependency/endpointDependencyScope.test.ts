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
 * The API-dependency tab is service-scoped twice over: the endpoint search that
 * feeds its picker, and the dependency chain itself. Both carry the same
 * identity the screen holds — id, name, and the roster row's normal flag, which
 * the chain's own endpoint MQE is scoped by — so neither leaves the BFF to work
 * one part out of another.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createRouter, createMemoryHistory, type Router } from 'vue-router';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import { i18n } from '@/i18n';
import { useLayerSelectionStore } from '@/state/layerSelection';
import LayerEndpointDependencyView from './LayerEndpointDependencyView.vue';

const SERVICE_ID = 'Z2VuZXJhbC1zdnI6Om9yZGVycw==.1';
const SERVICE_NAME = 'general-svr::orders';
const ENDPOINT = '/api/orders';

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function fakeBff(rosterNormal: boolean | null = false) {
  const urls: string[] = [];
  const fetchSpy = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    urls.push(url);
    const path = new URL(url, 'http://ui').pathname;
    if (path.endsWith('/endpoints')) {
      return jsonResponse({ reachable: true, endpoints: [{ id: 'ep-1', name: ENDPOINT }] });
    }
    if (path.endsWith('/endpoint-dependency')) {
      return jsonResponse({
        layer: 'general',
        endpointId: 'ep-1',
        nodes: [],
        calls: [],
        config: { nodeMetrics: [], linkMetrics: [] },
        reachable: true,
        generatedAt: 0,
      });
    }
    if (path.endsWith('/landing')) {
      return jsonResponse({ rows: [], sampledRows: [], reachable: true, generatedAt: 0 });
    }
    if (path.endsWith('/services')) {
      return jsonResponse({
        reachable: true,
        services: [{ id: SERVICE_ID, name: SERVICE_NAME, normal: rosterNormal, group: '' }],
      });
    }
    return jsonResponse({});
  });
  return {
    fetchSpy,
    to: (suffix: string) =>
      urls
        .filter((u) => new URL(u, 'http://ui').pathname.endsWith(suffix))
        .map((u) => new URL(u, 'http://ui').searchParams),
  };
}

let router: Router;
let pinia: ReturnType<typeof createPinia>;

beforeEach(async () => {
  pinia = createPinia();
  setActivePinia(pinia);
  router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div />' } }],
  });
  await router.push('/layer/general/endpoint-dependency');
  await router.isReady();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('API dependency — every read carries the service pair', () => {
  it('searches endpoints and draws the chain by the whole roster row', async () => {
    const bff = fakeBff();
    vi.stubGlobal('fetch', bff.fetchSpy);
    // The picker selected a VIRTUAL service: its flag has to reach the chain
    // query, or the focus endpoint's own MQE is evaluated as another entity.
    useLayerSelectionStore().setService(SERVICE_ID);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    mount(LayerEndpointDependencyView, {
      props: { layerKey: 'general' },
      global: { plugins: [pinia, router, i18n, [VueQueryPlugin, { queryClient }]] },
    });
    await flushPromises();
    await flushPromises();

    const endpoints = bff.to('/endpoints');
    expect(endpoints.length).toBeGreaterThan(0);
    expect(endpoints[0]!.get('serviceId')).toBe(SERVICE_ID);
    expect(endpoints[0]!.get('service')).toBe(SERVICE_NAME);

    const chain = bff.to('/endpoint-dependency');
    expect(chain.length).toBeGreaterThan(0);
    expect(chain[0]!.get('serviceId')).toBe(SERVICE_ID);
    expect(chain[0]!.get('service')).toBe(SERVICE_NAME);
    expect(chain[0]!.get('normal')).toBe('false');
    expect(chain[0]!.get('endpoint')).toBe(ENDPOINT);
  });

  // The chain query is a trailing control on the roster row: without the flag
  // the BFF has to refuse the request, so the view waits for the row instead of
  // firing one. The endpoint search is id-scoped and runs regardless.
  it('holds the chain back while the row carries no flag', async () => {
    const bff = fakeBff(null);
    vi.stubGlobal('fetch', bff.fetchSpy);
    useLayerSelectionStore().setService(SERVICE_ID);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    mount(LayerEndpointDependencyView, {
      props: { layerKey: 'general' },
      global: { plugins: [pinia, router, i18n, [VueQueryPlugin, { queryClient }]] },
    });
    await flushPromises();
    await flushPromises();

    expect(bff.to('/endpoints').length).toBeGreaterThan(0);
    expect(bff.to('/endpoint-dependency')).toHaveLength(0);
  });

  it('reads nothing when the block carries only the service name', async () => {
    const bff = fakeBff();
    vi.stubGlobal('fetch', bff.fetchSpy);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    mount(LayerEndpointDependencyView, {
      props: { layerKey: 'general', embedded: true, focusService: SERVICE_NAME },
      global: { plugins: [pinia, router, i18n, [VueQueryPlugin, { queryClient }]] },
    });
    await flushPromises();
    await flushPromises();

    expect(bff.to('/endpoints')).toHaveLength(0);
    expect(bff.to('/endpoint-dependency')).toHaveLength(0);
  });
});
