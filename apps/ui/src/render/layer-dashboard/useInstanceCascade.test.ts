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
 * The instance picker on the per-layer Instance dashboard hangs off the service
 * the operator picked — as one identity. The list is fetched with the roster
 * row whole (id AND name), and not at all until that row has resolved, which is
 * what keeps the landing → service → instance → metrics cascade in order.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { computed, defineComponent, h, ref, type Ref } from 'vue';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import type { LayerDef } from '@skywalking-horizon-ui/api-client';
import type { ServiceRef } from '@/utils/serviceRef';
import { useInstanceCascade } from './useInstanceCascade';

const SERVICE: ServiceRef = { id: 'bWVzaC1zdnI6OnNvbmdz.1', name: 'mesh-svr::songs' };

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** URLs the cascade asked the BFF for. */
function fakeBff(): { fetchSpy: ReturnType<typeof vi.fn>; instanceCalls: () => URLSearchParams[] } {
  const urls: string[] = [];
  const fetchSpy = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    urls.push(url);
    if (new URL(url, 'http://ui').pathname.endsWith('/instances')) {
      return jsonResponse({ reachable: true, instances: [{ id: 'i-1', name: 'songs-1', language: 'java', attributes: [] }] });
    }
    return jsonResponse({});
  });
  return {
    fetchSpy,
    instanceCalls: () =>
      urls
        .filter((u) => new URL(u, 'http://ui').pathname.endsWith('/instances'))
        .map((u) => new URL(u, 'http://ui').searchParams),
  };
}

function mountCascade(service: Ref<ServiceRef | null>) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const Host = defineComponent({
    setup() {
      useInstanceCascade(
        ref('mesh'),
        computed(() => 'instance'),
        computed(() => service.value),
        computed<LayerDef | null>(() => null),
      );
      return () => h('div');
    },
  });
  return mount(Host, { global: { plugins: [createPinia(), [VueQueryPlugin, { queryClient }]] } });
}

beforeEach(() => {
  setActivePinia(createPinia());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useInstanceCascade — the instance list is fetched by the picked identity', () => {
  it('asks with the service id AND name', async () => {
    const bff = fakeBff();
    vi.stubGlobal('fetch', bff.fetchSpy);
    mountCascade(ref<ServiceRef | null>(SERVICE));
    await flushPromises();

    const asked = bff.instanceCalls();
    expect(asked).toHaveLength(1);
    expect(asked[0]!.get('serviceId')).toBe(SERVICE.id);
    expect(asked[0]!.get('service')).toBe(SERVICE.name);
  });

  it('fetches nothing until the service has resolved', async () => {
    const bff = fakeBff();
    vi.stubGlobal('fetch', bff.fetchSpy);
    const service = ref<ServiceRef | null>(null);
    mountCascade(service);
    await flushPromises();
    expect(bff.instanceCalls()).toHaveLength(0);

    service.value = SERVICE;
    await flushPromises();
    expect(bff.instanceCalls()).toHaveLength(1);
  });
});
