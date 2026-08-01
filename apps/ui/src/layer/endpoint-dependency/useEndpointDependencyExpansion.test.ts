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
 * Expanding a node in the API-dependency graph is a service-scoped read like
 * any other: the clicked node carries its owning service whole — id, name, and
 * the normal flag OAP tagged it with — so the expansion asks by that identity
 * rather than handing the BFF a display name to resolve back into an id.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { defineComponent, h, ref } from 'vue';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import type { EndpointDependencyCall, EndpointDependencyNode } from '@/api/client';

const endpointDependency = vi.fn(async () => ({
  layer: 'general',
  endpointId: null,
  nodes: [],
  calls: [],
  config: { nodeMetrics: [], linkMetrics: [] },
  reachable: true,
  generatedAt: 0,
}));

vi.mock('@/api/client', () => ({
  bffClient: { layer: { endpointDependency: (...args: unknown[]) => endpointDependency(...(args as [])) } },
}));

const { useEndpointDependencyExpansion } = await import('./useEndpointDependencyExpansion');

const NODE: EndpointDependencyNode = {
  id: 'ep-1',
  name: '/api/orders',
  serviceId: 'Z2VuZXJhbC1zdnI6Om9yZGVycw==.1',
  serviceName: 'general-svr::orders',
  type: null,
  isReal: true,
  metrics: {},
  cpm: null,
  respTime: null,
  sla: null,
};

function mountExpansion() {
  let api!: ReturnType<typeof useEndpointDependencyExpansion>;
  const Host = defineComponent({
    setup() {
      api = useEndpointDependencyExpansion({
        layerKey: ref('general'),
        baseNodes: ref<EndpointDependencyNode[]>([]),
        baseCalls: ref<EndpointDependencyCall[]>([]),
        selectedEndpoint: ref<string | null>('/api/checkout'),
        onFocusReset: () => {},
      });
      return () => h('div');
    },
  });
  mount(Host);
  return api;
}

beforeEach(() => {
  setActivePinia(createPinia());
  endpointDependency.mockClear();
});

describe('expandNode — the clicked node keeps its service identity', () => {
  it('asks by the node\'s service id, name and normal flag', async () => {
    const api = mountExpansion();
    await api.expandNode(NODE);

    expect(endpointDependency).toHaveBeenCalledTimes(1);
    const [layer, service, endpoint] = endpointDependency.mock.calls[0] as unknown as [
      string,
      { id: string; name: string; normal: boolean | null },
      string,
    ];
    expect(layer).toBe('general');
    // `isReal` IS the owning service's normal flag on this wire — the chain's
    // own endpoint MQE is scoped by it.
    expect(service).toEqual({ id: NODE.serviceId, name: NODE.serviceName, normal: NODE.isReal });
    expect(endpoint).toBe(NODE.name);
  });

  it('does not expand a node whose service identity is incomplete', async () => {
    const api = mountExpansion();
    await api.expandNode({ ...NODE, serviceId: '' });

    expect(endpointDependency).not.toHaveBeenCalled();
  });
});
