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
 * Pages with no landing rollup (profiling, pod logs) still have to query by the
 * whole identity. The URL pins an id; the layer roster row is where its name
 * comes from — read from the roster snapshot the shell already validates that
 * id against, so the pair costs no extra round-trip.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, ref, type ComputedRef } from 'vue';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import { useLayerSelectionStore } from '@/state/layerSelection';
import type { ServiceRef } from '@/utils/serviceRef';
import { useSelectedServiceRef } from './useLayerServiceName';

const SERVICE_ID = 'a3Vi::c29uZ3M=.1';
const SERVICE_NAME = 'kub::songs';

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

let pinia: ReturnType<typeof createPinia>;

function mountRef(): ComputedRef<ServiceRef | null> {
  let picked!: ComputedRef<ServiceRef | null>;
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const Host = defineComponent({
    setup() {
      picked = useSelectedServiceRef(ref('k8s_service'));
      return () => h('div');
    },
  });
  mount(Host, { global: { plugins: [pinia, [VueQueryPlugin, { queryClient }]] } });
  return picked;
}

beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useSelectedServiceRef', () => {
  it('yields the roster row for the selected id — both halves', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          reachable: true,
          services: [{ id: SERVICE_ID, name: SERVICE_NAME, normal: true, group: '' }],
        }),
      ),
    );
    useLayerSelectionStore().setService(SERVICE_ID);
    const picked = mountRef();
    await flushPromises();

    expect(picked.value).toEqual({ id: SERVICE_ID, name: SERVICE_NAME, normal: true });
  });

  it('stays null for an id the roster does not hold, rather than inventing a name', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ reachable: true, services: [] })));
    useLayerSelectionStore().setService(SERVICE_ID);
    const picked = mountRef();
    await flushPromises();

    expect(picked.value).toBeNull();
  });
});
