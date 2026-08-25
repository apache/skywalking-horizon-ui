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

/**
 * A page that filters the instance list must not lend its metrics another
 * instance's name.
 *
 * The widget query already used the page-local instance; comparison keys,
 * trace drill-down, the picker highlight and the freshness key still read
 * the SHARED selection, so a page showing `broker-1` could label it
 * `worker-1`. The identity the page presents and the identity it queries
 * are one value, and that is what this pins.
 */
describe('a filtered page presents the instance it actually shows', () => {
  const ROSTER = [
    { id: 'i-b1', name: 'broker-1', language: 'java', attributes: [] },
    { id: 'i-w1', name: 'worker-1', language: 'go', attributes: [] },
  ];

  function bffWith(instances: unknown[]): ReturnType<typeof vi.fn> {
    return vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (new URL(url, 'http://ui').pathname.endsWith('/instances')) {
        return jsonResponse({ reachable: true, instances });
      }
      return jsonResponse({});
    });
  }

  /** A layer whose `brokers` page shows only `broker-*`. */
  const LAYER = {
    extPages: { instance: [{ id: 'brokers', name: 'Brokers', instanceFilter: '/^broker-/' }] },
  } as unknown as LayerDef;

  function mountOn(pageId: string | null, layer: LayerDef | null) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    let api!: ReturnType<typeof useInstanceCascade>;
    const Host = defineComponent({
      setup() {
        api = useInstanceCascade(
          ref('mesh'),
          computed(() => 'instance'),
          computed(() => SERVICE),
          computed<LayerDef | null>(() => layer),
          computed(() => pageId),
        );
        return () => h('div');
      },
    });
    const w = mount(Host, { global: { plugins: [createPinia(), [VueQueryPlugin, { queryClient }]] } });
    return { w, api };
  }

  it('shows only what the page allows, and resolves to one of those', async () => {
    vi.stubGlobal('fetch', bffWith(ROSTER));
    const { api } = mountOn('brokers', LAYER);
    await flushPromises();

    expect(api.instanceList.value.map((i) => i.name)).toEqual(['broker-1']);
    expect(api.effectiveInstance.value).toBe('broker-1');
  });

  it('keeps the operator’s excluded pick as the SHARED choice, and never presents it', async () => {
    vi.stubGlobal('fetch', bffWith(ROSTER));
    const { api } = mountOn('brokers', LAYER);
    await flushPromises();

    api.setSelectedInstance('worker-1');
    await flushPromises();

    // The cross-page choice survives — leaving the page must not lose it.
    expect(api.selectedInstance.value).toBe('worker-1');
    // But nothing the page renders or queries may be `worker-1`: that is
    // the mismatch that labelled one instance's metrics with another's name.
    expect(api.effectiveInstance.value).toBe('broker-1');
    expect(api.instanceList.value.some((i) => i.name === 'worker-1')).toBe(false);
  });

  it('lets a pick the page DOES allow take effect', async () => {
    vi.stubGlobal('fetch', bffWith([...ROSTER, { id: 'i-b2', name: 'broker-2', language: 'java', attributes: [] }]));
    const { api } = mountOn('brokers', LAYER);
    await flushPromises();

    api.setSelectedInstance('broker-2');
    await flushPromises();
    expect(api.effectiveInstance.value).toBe('broker-2');
  });

  it('presents the shared pick unchanged on an unfiltered page', async () => {
    vi.stubGlobal('fetch', bffWith(ROSTER));
    const { api } = mountOn(null, LAYER);
    await flushPromises();

    api.setSelectedInstance('worker-1');
    await flushPromises();
    expect(api.effectiveInstance.value).toBe('worker-1');
  });
});

/**
 * Instance names repeat across services, so a pin has to be decided by the
 * service it belongs to.
 *
 * Deciding on the name alone let a foreign pin inherit the eligibility of
 * a same-named instance under the current service — a Java `worker-1`
 * here vouching for a Go `worker-1` there, on a page whose rule is
 * exactly that distinction.
 */
describe('a pinned instance is judged by its OWN service', () => {
  const CURRENT = [{ id: 'i-w1', name: 'worker-1', language: 'java', attributes: [] }];

  function mountWithFilter(filter: Record<string, unknown>) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) =>
        new URL(String(input), 'http://ui').pathname.endsWith('/instances')
          ? jsonResponse({ reachable: true, instances: CURRENT })
          : jsonResponse({}),
      ),
    );
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    let api!: ReturnType<typeof useInstanceCascade>;
    const layer = { extPages: { instance: [{ id: 'jvms', name: 'JVMs', ...filter }] } } as unknown as LayerDef;
    const Host = defineComponent({
      setup() {
        api = useInstanceCascade(
          ref('mesh'),
          computed(() => 'instance'),
          computed(() => SERVICE),
          computed<LayerDef | null>(() => layer),
          computed(() => 'jvms'),
        );
        return () => h('div');
      },
    });
    mount(Host, { global: { plugins: [createPinia(), [VueQueryPlugin, { queryClient }]] } });
    return api;
  }

  it('refuses a foreign pin an attribute rule cannot decide, same name or not', async () => {
    const api = mountWithFilter({ instanceAttributes: [{ attribute: 'language', op: 'eq', value: 'java' }] });
    await flushPromises();

    // In hand under the current service: the full rule already ran on it.
    expect(api.pageAllowsInstance(SERVICE.id, 'worker-1')).toBe(true);
    // Same NAME, another service: nothing about its attributes is known,
    // and the page's rule is about attributes.
    expect(api.pageAllowsInstance('other-service-id', 'worker-1')).toBe(false);
  });

  it('decides a foreign pin on the name when the rule is only a name', async () => {
    const api = mountWithFilter({ instanceFilter: '/^worker-/' });
    await flushPromises();
    expect(api.pageAllowsInstance('other-service-id', 'worker-9')).toBe(true);
    expect(api.pageAllowsInstance('other-service-id', 'broker-9')).toBe(false);
  });

  it('admits everything when the page has no rule', async () => {
    const api = mountWithFilter({});
    await flushPromises();
    expect(api.pageAllowsInstance('other-service-id', 'anything')).toBe(true);
  });

  it('refuses a CURRENT-service instance the page filtered out', async () => {
    const api = mountWithFilter({ instanceFilter: '/^broker-/' });
    await flushPromises();
    expect(api.pageAllowsInstance(SERVICE.id, 'worker-1')).toBe(false);
  });
});
