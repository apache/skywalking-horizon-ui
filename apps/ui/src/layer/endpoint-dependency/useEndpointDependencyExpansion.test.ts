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
import { defineComponent, h, nextTick, ref } from 'vue';
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
  // The failure path reports through the error center, which classifies by
  // error type — so the mock has to carry the type, not just the client.
  BffApiError: class BffApiError extends Error {},
  describeApiError: (e: unknown) => String(e),
}));

const { useEndpointDependencyExpansion } = await import('./useEndpointDependencyExpansion');
const { useErrorCenterStore } = await import('@/controls/errorCenter');

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
  const selectedEndpoint = ref<string | null>('/api/checkout');
  // The two things an expansion is built ON, so a test can move either and
  // watch what happens to the expansions hanging off it.
  const predicateGeneration = ref(0);
  const baseSnapshotVersion = ref(0);
  const Host = defineComponent({
    setup() {
      api = useEndpointDependencyExpansion({
        layerKey: ref('general'),
        baseNodes: ref<EndpointDependencyNode[]>([]),
        baseCalls: ref<EndpointDependencyCall[]>([]),
        selectedEndpoint,
        predicateGeneration,
        previewConfig: ref(undefined),
        baseWindow: ref({ step: 'MINUTE' as const, startMs: 0, endMs: 60_000 }),
        baseSnapshotVersion,
        onFocusReset: () => {},
      });
      return () => h('div');
    },
  });
  mount(Host);
  return { api, selectedEndpoint, predicateGeneration, baseSnapshotVersion };
}

beforeEach(() => {
  setActivePinia(createPinia());
  endpointDependency.mockClear();
});

describe('expandNode — the clicked node keeps its service identity', () => {
  it('asks by the node\'s service id, name and normal flag', async () => {
    const { api } = mountExpansion();
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
    const { api } = mountExpansion();
    await api.expandNode({ ...NODE, serviceId: '' });

    expect(endpointDependency).not.toHaveBeenCalled();
  });
});

/**
 * An expansion is an MQE fan-out on the BFF, so the wait is seconds — long
 * enough to pick a different endpoint while one is in flight. Nothing disables
 * the picker meanwhile, so the reply lands after the focus watcher has cleared
 * state and, unguarded, repopulates the NEW graph with the OLD focus's branch.
 */
describe('a reply that outlives its focus', () => {
  it('is discarded rather than merged into the graph that replaced it', async () => {
    // The reply's CONTENTS do not matter here — the assertion is whether the
    // expansion map gained this node's key at all.
    type Reply = Awaited<ReturnType<typeof endpointDependency>>;
    let release!: (r: Reply) => void;
    endpointDependency.mockImplementationOnce(
      () => new Promise<Reply>((resolve) => { release = resolve; }),
    );

    const { api, selectedEndpoint } = mountExpansion();
    const inFlight = api.expandNode(NODE);

    // The operator picks a different endpoint while the request is out.
    selectedEndpoint.value = '/api/refunds';
    await nextTick();
    expect(api.hasExpansion(NODE), 'the focus change did not clear expansions').toBe(false);

    release({
      layer: 'general',
      endpointId: null,
      nodes: [],
      calls: [],
      config: { nodeMetrics: [], linkMetrics: [] },
      reachable: true,
      generatedAt: 0,
    });
    await inFlight;

    expect(
      api.hasExpansion(NODE),
      "a reply from the previous focus was merged into the current graph",
    ).toBe(false);
  });

  it('still commits a reply that arrives under the focus that asked for it', async () => {
    const { api } = mountExpansion();

    await api.expandNode(NODE);

    expect(api.hasExpansion(NODE)).toBe(true);
  });
});

/**
 * An expansion that could not be READ is not an answer about dependencies.
 *
 * The route replies 200 with an empty body when OAP is unreachable, so the
 * "no new nodes" branch used to fire and mark the node exhausted — telling the
 * operator this endpoint has no further callers or callees, which is a claim
 * about their system made from a failure to read it.
 */
describe('an expansion that failed', () => {
  it('does not mark the node exhausted, and stays clickable', async () => {
    endpointDependency.mockImplementationOnce(async () => ({
      layer: 'general', endpointId: null, nodes: [], calls: [],
      config: { nodeMetrics: [], linkMetrics: [] },
      reachable: false, generatedAt: 0,
    }));

    const { api } = mountExpansion();
    await api.expandNode(NODE);

    expect(api.isExhausted(NODE), 'a failed read was reported as “no further dependencies”').toBe(false);
    expect(api.hasExpansion(NODE), 'a failed read was merged into the graph').toBe(false);
    expect(api.expansionFailed.value?.endpoint).toBe(NODE.name);

    // Clickable again: a second attempt really does reach the backend.
    endpointDependency.mockClear();
    await api.expandNode(NODE);
    expect(endpointDependency).toHaveBeenCalledTimes(1);
  });

  it('reports a transport failure the same way', async () => {
    endpointDependency.mockImplementationOnce(async () => { throw new Error('network'); });
    const { api } = mountExpansion();

    await api.expandNode(NODE);

    expect(api.isExhausted(NODE)).toBe(false);
    expect(api.expansionFailed.value?.endpoint).toBe(NODE.name);
  });

  it('still reports exhaustion when the read SUCCEEDED and found nothing new', async () => {
    const { api } = mountExpansion();

    await api.expandNode(NODE);

    // The default mock is reachable:true with no nodes — a real answer.
    expect(api.isExhausted(NODE)).toBe(true);
  });
});

/**
 * An expansion is drawn ON a base graph, so it only means anything for the base
 * it was fetched against. Two things end that: a new base arriving, and the
 * question changing underneath it.
 */
describe('what an expansion is built on', () => {
  it('drops with the base it was drawn on when a NEW base commits', async () => {
    const { api, baseSnapshotVersion } = mountExpansion();
    await api.expandNode(NODE);
    expect(api.hasExpansion(NODE), 'nothing was expanded — the rest proves nothing').toBe(true);

    // A round landed and replaced the base. The expansion describes nodes that
    // may not be in it, so it goes in the same update rather than being merged
    // onto a graph that never contained it.
    baseSnapshotVersion.value += 1;
    await nextTick();

    expect(api.hasExpansion(NODE)).toBe(false);
  });

  it('survives a base refresh that FAILED, which commits no new base', async () => {
    const { api } = mountExpansion();
    await api.expandNode(NODE);

    // A failed round changes nothing: no new snapshot, so no version bump.
    await nextTick();

    expect(api.hasExpansion(NODE), 'a failed refresh discarded the operator’s work').toBe(true);
  });

  it('drops when the QUESTION changes — window, preview or cold stage', async () => {
    const { api, predicateGeneration } = mountExpansion();
    await api.expandNode(NODE);

    predicateGeneration.value += 1;
    await nextTick();

    expect(api.hasExpansion(NODE)).toBe(false);
  });

  it('forgets that a node was exhausted, so the new graph can be asked again', async () => {
    const { api, predicateGeneration } = mountExpansion();
    await api.expandNode(NODE);
    await api.expandNode(NODE);

    predicateGeneration.value += 1;
    await nextTick();

    expect(api.isExhausted(NODE), 'a stale “no further dependencies” carried over').toBe(false);
  });
});

/**
 * §十.5 — the three things a failed expansion must do, asserted together.
 *
 * The existing case covers two of them; the toast was the one nothing checked,
 * and it is the only part the operator actually sees.
 */
describe('acceptance: a failed expansion', () => {
  it('does not exhaust, says so on screen, and a second click asks again', async () => {
    const { api } = mountExpansion();
    endpointDependency.mockClear();
    const center = useErrorCenterStore();

    // HTTP 200 with an unreadable body — how an OAP outage reaches this page.
    endpointDependency.mockResolvedValueOnce({
      layer: 'general', service: null, endpoint: null, endpointId: null,
      generatedAt: 0, config: { nodeMetrics: [] }, nodes: [], calls: [], reachable: false,
    } as never);
    await api.expandNode(NODE);

    expect(api.isExhausted(NODE), 'a failure was reported as “no further dependencies”').toBe(false);
    expect(api.isLoadingExpansion(NODE), 'the handle stayed stuck loading').toBe(false);
    expect(center.toasts, 'nothing on screen said the expansion failed').toHaveLength(1);
    expect(center.toasts[0]?.scope, 'the operator’s own click went to the background history').toBe(
      'component',
    );

    // Clickable again: a failure is not an answer, so asking twice is allowed.
    const before = endpointDependency.mock.calls.length;
    await api.expandNode(NODE);
    expect(endpointDependency.mock.calls.length, 'a retry produced no second request').toBe(
      before + 1,
    );
  });
});
