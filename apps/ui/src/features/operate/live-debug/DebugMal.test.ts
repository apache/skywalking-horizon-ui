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

/** The MAL tab's fold all folds the records the cards show, keyed as the cards key them. */

import { describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import type { SessionResponse } from '@skywalking-horizon-ui/api-client';
import { i18n } from '@/i18n';

const record = (i: number) => ({ startedAtMs: 1, captureTime: `1.00000${i}`, dsl: '', rule: { ruleName: 'r' }, samples: [] });
const captured: SessionResponse = {
  sessionId: 's-1',
  capturedAt: 1,
  nodes: [{ nodeId: '0.0.0.0_11800', instanceId: 'i-a', status: 'captured', records: [record(1), record(2)] }],
} as unknown as SessionResponse;

const shown = ref<SessionResponse | null>(captured);
const startedWith = ref<Record<string, unknown> | null>(null);
vi.mock('./useDebugSession', () => ({
  useDebugSession: () => ({
    clientId: 'c',
    state: ref('captured'),
    session: shown,
    sessionId: ref<string | null>('s-1'),
    error: ref(null),
    peerAcks: ref([]),
    installed: ref(null),
    priorCleanup: ref(null),
    replacedPriorIds: ref([]),
    retentionDeadline: ref(null),
    startedWith,
    start: vi.fn(),
    resume: vi.fn(),
    stop: vi.fn(),
  }),
}));
vi.mock('@/api/client', () => ({
  BffApiError: class BffApiError extends Error {},
  describeApiError: (err: unknown) => String(err),
  bff: {
    dsl: {
      catalogList: async () => ({ rules: [] }),
      catalogBundled: async () => [],
      getRule: async () => null,
    },
  },
}));

/** The live debugger's routes as the app declares them: the tab is the `:tab` param, MAL when absent. */
const DEBUGGER_ROUTES = [
  { path: '/operate/live-debug/:tab(mal|lal|oal|tal)?', component: { template: '<div />' } },
  { path: '/:pathMatch(.*)*', component: { template: '<div />' } },
];

const { default: DebugMal } = await import('./DebugMal.vue');
const { useDebugHistory } = await import('./useDebugHistory');

describe('DebugMal', () => {
  it('folds every record card on fold all', async () => {
    localStorage.clear();
    const router = createRouter({
      history: createMemoryHistory(),
      routes: DEBUGGER_ROUTES,
    });
    await router.push('/operate/live-debug/mal');
    await router.isReady();
    const w = mount(DebugMal, {
      global: { plugins: [i18n, router, [VueQueryPlugin, { queryClient: new QueryClient() }]] },
    });
    await flushPromises();
    const cards = () => w.findAll('.mal__rec');
    expect(cards()).toHaveLength(2);
    expect(w.findAll('.mal__rec--folded')).toHaveLength(0);

    await w.findAll('button').find((b) => b.text() === 'fold all')!.trigger('click');
    expect(w.findAll('.mal__rec--folded'), 'each card folds').toHaveLength(2);
    w.unmount();
  });

  it('starts the folds over when another capture comes on screen', async () => {
    shown.value = captured;
    const router = createRouter({
      history: createMemoryHistory(),
      routes: DEBUGGER_ROUTES,
    });
    await router.push('/operate/live-debug/mal');
    await router.isReady();
    const w = mount(DebugMal, {
      global: { plugins: [i18n, router, [VueQueryPlugin, { queryClient: new QueryClient() }]] },
    });
    await flushPromises();
    await w.findAll('.mal__rec')[1]!.find('.mal__rech').trigger('click');
    expect(w.findAll('.mal__rec--folded')).toHaveLength(1);

    // Another capture of the same node: its record #2 is not the one folded.
    shown.value = { ...captured, sessionId: 's-2' } as SessionResponse;
    await flushPromises();
    expect(w.findAll('.mal__rec--folded'), 'nothing folded in the new capture').toHaveLength(0);
    expect(w.findAll('button').find((b) => b.text() === 'fold all')!.attributes('disabled')).toBeUndefined();
    w.unmount();
  });

  it('saves the live capture under what it started with, whatever the form holds or the screen shows', async () => {
    shown.value = captured;
    startedWith.value = { catalog: 'otel-rules', name: 'vm', ruleName: 'alpha', recordCap: 10, retentionMillis: 300_000 };
    const history = useDebugHistory('mal');
    const older = history.save({
      widget: 'mal', catalog: 'otel-rules', name: 'vm', ruleName: 'older', recordCount: 2, nodeCount: 1,
      session: { ...captured, sessionId: 'older' } as SessionResponse,
    });
    const router = createRouter({ history: createMemoryHistory(), routes: DEBUGGER_ROUTES });
    // A saved capture on screen, and no rule picked in the form.
    await router.push(`/operate/live-debug/mal?historyId=${older.id}`);
    await router.isReady();
    const w = mount(DebugMal, {
      global: { plugins: [i18n, router, [VueQueryPlugin, { queryClient: new QueryClient() }]] },
    });
    await flushPromises();
    expect(w.find('.mal__histbanner').exists(), 'the saved capture is on screen').toBe(true);

    // The live capture reads a record more.
    shown.value = { ...captured, nodes: [{ ...captured.nodes[0]!, records: [record(1), record(2), record(3)] }] } as SessionResponse;
    await flushPromises();
    const live = history.entries.value.find((e) => e.session.sessionId === 's-1');
    expect(live?.ruleName, 'saved under the rule it runs').toBe('alpha');
    expect(live?.name).toBe('vm');
    expect(live?.recordCount, 'with the record it just read').toBe(3);
    startedWith.value = null;
    w.unmount();
  });
});
