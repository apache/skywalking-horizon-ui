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
 * A start pressed while a saved capture is on screen starts a capture the tab then shows and saves: it leaves the
 * saved one, as "back to live" does, rather than running a session nobody sees.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import type { SessionResponse } from '@skywalking-horizon-ui/api-client';
import { i18n } from '@/i18n';

const start = vi.fn();
const resume = vi.fn();
vi.mock('./useDebugSession', () => ({
  useDebugSession: () => ({
    clientId: 'c',
    state: ref('idle'),
    session: ref<SessionResponse | null>(null),
    sessionId: ref<string | null>(null),
    error: ref(null),
    peerAcks: ref([]),
    installed: ref(null),
    priorCleanup: ref(null),
    replacedPriorIds: ref([]),
    retentionDeadline: ref(null),
    startedWith: ref(null),
    start: (...args: unknown[]) => start(...args),
    resume: (...args: unknown[]) => resume(...args),
    stop: vi.fn(),
  }),
}));
vi.mock('@/api/client', () => ({
  BffApiError: class BffApiError extends Error {},
  describeApiError: (err: unknown) => String(err),
  bff: {
    dsl: {
      talFiles: async () => ({
        files: [{ name: 'native-segment', list: 'nativeTalFiles', inputType: 'sw-native', rules: [{ name: 'native-segment', layer: 'GENERAL', debuggable: true, order: 0 }] }],
      }),
      talFileContent: async () => 'rules:\n  - name: native-segment\n',
    },
  },
}));

/** The live debugger's routes as the app declares them: the tab is the `:tab` param, MAL when absent. */
const DEBUGGER_ROUTES = [
  { path: '/operate/live-debug/:tab(mal|lal|oal|tal)?', component: { template: '<div />' } },
  { path: '/:pathMatch(.*)*', component: { template: '<div />' } },
];

const { default: DebugTal } = await import('./DebugTal.vue');
const { useDebugHistory } = await import('./useDebugHistory');

describe('DebugTal', () => {
  beforeEach(() => {
    localStorage.clear();
    start.mockReset();
    resume.mockReset();
  });
  afterEach(() => localStorage.clear());

  it('leaves a saved capture on screen when a new capture starts', async () => {
    const saved = useDebugHistory('tal').save({
      widget: 'tal',
      catalog: 'tal',
      name: 'native-segment',
      ruleName: 'native-segment',
      recordCount: 0,
      nodeCount: 0,
      session: { sessionId: 'old', capturedAt: 1, nodes: [] },
    });
    const router = createRouter({
      history: createMemoryHistory(),
      routes: DEBUGGER_ROUTES,
    });
    await router.push(`/operate/live-debug/tal?historyId=${saved.id}`);
    await router.isReady();
    const w = mount(DebugTal, {
      global: { plugins: [i18n, router, [VueQueryPlugin, { queryClient: new QueryClient() }]] },
    });
    await flushPromises();
    expect(w.find('.tal__histbanner').exists(), 'the saved capture is on screen').toBe(true);

    await w.findAll('button').find((b) => b.text() === 'start sampling')!.trigger('click');
    await flushPromises();
    expect(start).toHaveBeenCalledTimes(1);
    expect(w.find('.tal__histbanner').exists(), 'the new capture replaced it').toBe(false);
    expect(router.currentRoute.value.query.historyId, 'a reload opens the live tab, not the saved capture').toBeUndefined();
    w.unmount();
  });

  it('leaves the saved capture’s address on back to live', async () => {
    const saved = useDebugHistory('tal').save({
      widget: 'tal',
      catalog: 'tal',
      name: 'native-segment',
      ruleName: 'native-segment',
      recordCount: 0,
      nodeCount: 0,
      session: { sessionId: 'old', capturedAt: 1, nodes: [] },
    });
    const router = createRouter({
      history: createMemoryHistory(),
      routes: DEBUGGER_ROUTES,
    });
    await router.push(`/operate/live-debug/tal?historyId=${saved.id}`);
    await router.isReady();
    const w = mount(DebugTal, {
      global: { plugins: [i18n, router, [VueQueryPlugin, { queryClient: new QueryClient() }]] },
    });
    await flushPromises();
    await w.find('.tal__histback').trigger('click');
    await flushPromises();
    expect(w.find('.tal__histbanner').exists()).toBe(false);
    expect(router.currentRoute.value.query.historyId).toBeUndefined();
    w.unmount();
  });

  it('opens each saved capture’s frame at its own last step, though the two share a frame key', async () => {
    const step = (sourceLine: number) => ({ stage: 'extractor', kind: 'block', sourceLine, sourceText: 'extractor {' });
    const capture = (sessionId: string, steps: number) => ({
      sessionId,
      capturedAt: 1,
      nodes: [{
        instanceId: 'i-a',
        status: 'captured',
        records: [{
          startedAtMs: 1,
          captureTime: '1.000001',
          dsl: '',
          rule: { ruleName: 'otlp-general', file: 'otlp-general' },
          context: { kind: 'span' },
          spans: [{
            span: { name: 'GET', kind: 'SPAN_KIND_CLIENT' },
            run: { continueOn: true, steps: Array.from({ length: steps }, (_, i) => step(10 + i)), outputs: [], state: {} },
          }],
        }],
      }],
    }) as unknown as SessionResponse;
    const save = (sessionId: string, steps: number) => useDebugHistory('tal').save({
      widget: 'tal', catalog: 'tal', name: 'otlp-general', ruleName: 'otlp-general', recordCount: 1, nodeCount: 1,
      session: capture(sessionId, steps),
    });
    const long = save('a', 4);
    const short = save('b', 2);
    const router = createRouter({
      history: createMemoryHistory(),
      routes: DEBUGGER_ROUTES,
    });
    await router.push(`/operate/live-debug/tal?historyId=${long.id}`);
    await router.isReady();
    const w = mount(DebugTal, {
      global: { plugins: [i18n, router, [VueQueryPlugin, { queryClient: new QueryClient() }]] },
    });
    await flushPromises();
    expect(w.find('.tal__steppos').text()).toMatch(/^step 4 \/ 4/);

    await router.push(`/operate/live-debug/tal?historyId=${short.id}`);
    await flushPromises();
    expect(w.find('.tal__steppos').text(), 'the other capture’s frame, at its own last step').toMatch(/^step 2 \/ 2/);
    w.unmount();
  });

  it('resumes a capture only when the address is its own tab’s, and a start leaves the resumed capture’s address', async () => {
    useDebugHistory('tal').save({
      widget: 'tal', catalog: 'tal', name: 'native-segment', ruleName: 'native-segment', recordCount: 0, nodeCount: 0,
      retentionDeadline: Date.now() + 600_000,
      session: { sessionId: 'live-a', capturedAt: 1, nodes: [] },
    });
    const router = createRouter({
      history: createMemoryHistory(),
      routes: DEBUGGER_ROUTES,
    });
    // Another tab's address: the TAL tab, kept alive behind it, leaves the capture alone.
    await router.push('/operate/live-debug/mal?resumeSessionId=live-a');
    await router.isReady();
    const w = mount(DebugTal, {
      global: { plugins: [i18n, router, [VueQueryPlugin, { queryClient: new QueryClient() }]] },
    });
    await flushPromises();
    expect(resume, 'not its tab').not.toHaveBeenCalled();

    await router.push('/operate/live-debug/tal?resumeSessionId=live-a');
    await flushPromises();
    expect(resume).toHaveBeenCalledTimes(1);

    await w.findAll('button').find((b) => b.text() === 'start sampling')!.trigger('click');
    await flushPromises();
    expect(router.currentRoute.value.query.resumeSessionId, 'a reload opens the new capture’s tab, not the old capture').toBeUndefined();
    w.unmount();
  });
});

