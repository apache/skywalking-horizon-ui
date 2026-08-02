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
 * The Browser Logs pager gates Next on the BFF's `hasNext`, same contract as
 * the Logs tab. Its old gate (`logs.length >= pageSize`) had the same
 * exact-multiple false positive: a last page that exactly fills the size left
 * Next enabled and the click landed on an empty screen.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createMemoryHistory, createRouter, type Router } from 'vue-router';
import { createPinia, setActivePinia } from 'pinia';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import { i18n } from '@/i18n';
import LayerBrowserErrorsView from './LayerBrowserErrorsView.vue';

const LAYER = 'browser';
const APP = 'browser-app';
const APP_ID = 'YnJvd3Nlci1hcHA=.1';

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function fakeBff(hasNext: boolean) {
  const fetchSpy = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input), 'http://ui').pathname;
    if (path === `/api/layer/${LAYER}/browser-errors`) {
      const body = JSON.parse(String(init?.body ?? '{}')) as { page: number; pageSize: number };
      return jsonResponse({
        generatedAt: 0,
        query: {},
        pageNum: body.page,
        pageSize: body.pageSize,
        hasNext,
        // A FULL page — indistinguishable from a mid-stream page by length.
        logs: Array.from({ length: body.pageSize }, (_, i) => ({
          service: APP,
          serviceVersion: 'v1',
          time: 1000 - i,
          pagePath: '/',
          category: 'ajax',
          grade: null,
          message: `boom ${i}`,
          line: 0,
          col: 0,
          stack: null,
          errorUrl: null,
          firstReportedError: false,
        })),
        reachable: true,
      });
    }
    if (path === '/api/menu') {
      return jsonResponse({
        layers: [
          {
            key: LAYER,
            name: 'Browser',
            color: '#fff',
            serviceCount: 1,
            active: true,
            level: null,
            slots: {},
            caps: {},
          },
        ],
        oap: { reachable: true },
      });
    }
    if (path === `/api/layer/${LAYER}/landing`) {
      return jsonResponse({
        generatedAt: 0,
        rows: [{ serviceId: APP_ID, serviceName: APP }],
        sampledRows: [{ serviceId: APP_ID, serviceName: APP }],
        reachable: true,
      });
    }
    if (path === `/api/layer/${LAYER}/services`) {
      return jsonResponse({
        layer: LAYER,
        services: [{ id: APP_ID, name: APP, normal: true, group: '' }],
        reachable: true,
      });
    }
    if (path.endsWith('/instances')) return jsonResponse({ reachable: true, instances: [] });
    if (path.endsWith('/endpoints')) {
      return jsonResponse({ reachable: true, endpoints: [], hasMore: false });
    }
    if (path === '/api/browser-errors/source-maps') {
      return jsonResponse({ enabled: false, maps: [], usage: null, reachable: true });
    }
    return jsonResponse({});
  });
  return { fetchSpy };
}

let router: Router;
let wrapper: VueWrapper | null = null;

async function mountView(hasNext: boolean) {
  const bff = fakeBff(hasNext);
  vi.stubGlobal('fetch', bff.fetchSpy);
  router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/layer/:layerKey/browser-errors', component: LayerBrowserErrorsView }],
  });
  await router.push(`/layer/${LAYER}/browser-errors`);
  await router.isReady();
  wrapper = mount(LayerBrowserErrorsView, {
    global: {
      plugins: [
        router,
        i18n,
        [VueQueryPlugin, { queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }],
      ],
    },
  });
  await flushPromises();
  return bff;
}

function nextButton(w: VueWrapper) {
  return w.findAll('.lg-pager-ctrls button').find((b) => b.text() === 'Next');
}

beforeEach(() => setActivePinia(createPinia()));
afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  vi.unstubAllGlobals();
});

describe('the Browser Logs pager gates Next on the probe', () => {
  it('leaves Next disabled on a FULL page the BFF says is the last one', async () => {
    await mountView(false);
    await wrapper!.find('.sw-btn.primary').trigger('click');
    await flushPromises();
    expect(nextButton(wrapper!)!.attributes('disabled')).toBeDefined();
  });

  it('enables Next when the probe found a row behind the page', async () => {
    await mountView(true);
    await wrapper!.find('.sw-btn.primary').trigger('click');
    await flushPromises();
    expect(nextButton(wrapper!)!.attributes('disabled')).toBeUndefined();
  });

  it('states the page without claiming a total it cannot know', async () => {
    await mountView(true);
    await wrapper!.find('.sw-btn.primary').trigger('click');
    await flushPromises();
    const hint = wrapper!.find('.lg-pager .hint').text();
    expect(hint).toBe('page 1 · showing 30');
    expect(hint).not.toContain('loaded');
  });
});
