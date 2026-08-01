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
 * The Logs pager reads the BFF's `hasNext`, not the page's own length.
 *
 * A last page that happens to be exactly full is the whole point: the old gate
 * (`logs.length < pageSize`) left Next enabled there, and the click landed on
 * an empty screen. It also drives the page-size control, because OAP derives
 * the offset from the page size — growing it without resetting the page
 * multiplies the offset.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createMemoryHistory, createRouter, type Router } from 'vue-router';
import { createPinia, setActivePinia } from 'pinia';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import { i18n } from '@/i18n';
import LayerLogsView from './LayerLogsView.vue';

const LAYER = 'general';
const SERVICE = 'songs';
const SERVICE_ID = 'c29uZ3M=.1';

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** A BFF whose log feed reports a page's worth of rows plus whatever `hasNext`
 *  the test asks for, so the pager is driven by the flag and nothing else. */
function fakeBff(hasNext: boolean) {
  const logRequests: Array<{ page: number; pageSize: number }> = [];
  const fetchSpy = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const path = new URL(url, 'http://ui').pathname;
    if (path === `/api/layer/${LAYER}/logs`) {
      const body = JSON.parse(String(init?.body ?? '{}')) as { page: number; pageSize: number };
      logRequests.push({ page: body.page, pageSize: body.pageSize });
      return jsonResponse({
        generatedAt: 0,
        query: {},
        pageNum: body.page,
        pageSize: body.pageSize,
        hasNext,
        // A FULL page: length alone cannot tell this from a mid-stream page.
        logs: Array.from({ length: body.pageSize }, (_, i) => ({
          serviceName: SERVICE,
          serviceId: SERVICE_ID,
          serviceInstanceName: null,
          serviceInstanceId: null,
          endpointName: null,
          endpointId: null,
          traceId: null,
          timestamp: i,
          contentType: 'TEXT',
          content: `line-${i}`,
          tags: [],
        })),
        reachable: true,
      });
    }
    if (path === `/api/layer/${LAYER}/logs/facets`) {
      return jsonResponse({
        generatedAt: 0,
        sampled: 0,
        truncated: false,
        level: { error: 0, warn: 0, info: 0, debug: 0, other: 0 },
        services: [],
        reachable: true,
      });
    }
    if (path === '/api/menu') {
      return jsonResponse({
        layers: [
          {
            key: LAYER,
            name: 'General',
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
        rows: [{ serviceId: SERVICE_ID, serviceName: SERVICE }],
        sampledRows: [{ serviceId: SERVICE_ID, serviceName: SERVICE }],
        reachable: true,
      });
    }
    if (path === `/api/layer/${LAYER}/services`) {
      return jsonResponse({
        layer: LAYER,
        services: [{ id: SERVICE_ID, name: SERVICE, normal: true, group: '' }],
        reachable: true,
      });
    }
    if (path.endsWith('/instances')) return jsonResponse({ reachable: true, instances: [] });
    if (path.endsWith('/endpoints')) {
      return jsonResponse({ reachable: true, endpoints: [], hasMore: false });
    }
    return jsonResponse({});
  });
  return { fetchSpy, logRequests };
}

let router: Router;
let wrapper: VueWrapper | null = null;

async function mountLogs(hasNext: boolean) {
  const bff = fakeBff(hasNext);
  vi.stubGlobal('fetch', bff.fetchSpy);
  router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/layer/:layerKey/logs', component: LayerLogsView }],
  });
  await router.push(`/layer/${LAYER}/logs`);
  await router.isReady();
  wrapper = mount(LayerLogsView, {
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

/** The pager's Next button, found by its rendered label. */
function nextButton(w: VueWrapper) {
  return w
    .findAll('.lg-pager-ctrls button')
    .find((b) => b.text() === 'Next');
}

beforeEach(() => setActivePinia(createPinia()));
afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  vi.unstubAllGlobals();
});

describe('the Logs pager gates Next on the probe, not on the page being full', () => {
  it('leaves Next disabled on a FULL page the BFF says is the last one', async () => {
    await mountLogs(false);
    await wrapper!.find('.lg-run-btn').trigger('click');
    await flushPromises();
    const rows = wrapper!.findAll('.lg-pager .hint');
    expect(rows[0].text()).toContain('showing 50');
    const next = nextButton(wrapper!);
    expect(next).toBeTruthy();
    expect(next!.attributes('disabled')).toBeDefined();
  });

  it('enables Next when the probe found a row behind the page', async () => {
    await mountLogs(true);
    await wrapper!.find('.lg-run-btn').trigger('click');
    await flushPromises();
    expect(nextButton(wrapper!)!.attributes('disabled')).toBeUndefined();
  });

  it('states the page it is on without claiming a total it cannot know', async () => {
    await mountLogs(true);
    await wrapper!.find('.lg-run-btn').trigger('click');
    await flushPromises();
    const hint = wrapper!.find('.lg-pager .hint').text();
    expect(hint).toBe('page 1 · showing 50');
    expect(hint).not.toContain('total');
  });
});

describe('changing the page size restarts at page 1', () => {
  it('never asks OAP for the deep offset the larger size would multiply', async () => {
    const bff = await mountLogs(true);
    await wrapper!.find('.lg-run-btn').trigger('click');
    await flushPromises();
    await nextButton(wrapper!)!.trigger('click');
    await flushPromises();
    expect(bff.logRequests.at(-1)).toEqual({ page: 2, pageSize: 50 });

    const sizeSelect = wrapper!.find('select[name="log-page-size"]');
    await sizeSelect.setValue('100');
    await flushPromises();
    // Page 2 at size 100 would read offset 100 — past the end of a window the
    // operator was two pages into at size 50.
    expect(bff.logRequests.at(-1)).toEqual({ page: 1, pageSize: 100 });
    expect(bff.logRequests.some((r) => r.page > 1 && r.pageSize === 100)).toBe(false);
  });
});
