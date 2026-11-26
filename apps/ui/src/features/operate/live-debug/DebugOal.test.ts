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
 * The OAL tab, as every debugger tab: a start or back to live leaves a saved capture and its address, a deep link is
 * taken only by the tab the address names, and what the tab holds of one capture starts over with the next.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import type { SessionResponse } from '@skywalking-horizon-ui/api-client';
import { i18n } from '@/i18n';

const record = (i: number) => ({ startedAtMs: 1, captureTime: `1.00000${i}`, dsl: '', rule: { ruleName: 'service_cpm' }, samples: [] });
const capture = (sessionId: string): SessionResponse =>
  ({ sessionId, capturedAt: 1, nodes: [{ nodeId: 'n', instanceId: 'i-a', status: 'captured', records: [record(1), record(2)] }] }) as unknown as SessionResponse;

const start = vi.fn();
const resume = vi.fn();
const shown = ref<SessionResponse | null>(null);
vi.mock('./useDebugSession', () => ({
  useDebugSession: () => ({
    clientId: 'c',
    state: ref('captured'),
    session: shown,
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
vi.mock('@/features/operate/live-debug/useDebugSession', () => ({
  useDebugSession: () => ({
    clientId: 'c',
    state: ref('captured'),
    session: shown,
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
      oalFiles: async () => ({ files: [{ name: 'core.oal', sources: ['Service'] }] }),
      oalSources: async () => ({ rules: [] }),
    },
  },
}));

/** The live debugger's routes as the app declares them: the tab is the `:tab` param, MAL when absent. */
const ROUTES = [
  { path: '/operate/live-debug/:tab(mal|lal|oal|tal)?', component: { template: '<div />' } },
  { path: '/:pathMatch(.*)*', component: { template: '<div />' } },
];

const { default: DebugOal } = await import('./DebugOal.vue');
const { useDebugHistory } = await import('./useDebugHistory');

async function open(at: string) {
  const router = createRouter({ history: createMemoryHistory(), routes: ROUTES });
  await router.push(at);
  await router.isReady();
  const w = mount(DebugOal, { global: { plugins: [i18n, router, [VueQueryPlugin, { queryClient: new QueryClient() }]] } });
  await flushPromises();
  return { w, router };
}

function saveCapture(sessionId: string, deadline?: number) {
  return useDebugHistory('oal').save({
    widget: 'oal', catalog: 'oal', name: 'core.oal', ruleName: 'service_cpm', recordCount: 2, nodeCount: 1,
    ...(deadline ? { retentionDeadline: deadline } : {}),
    session: capture(sessionId),
  });
}

describe('DebugOal', () => {
  beforeEach(() => {
    localStorage.clear();
    start.mockReset();
    resume.mockReset();
    shown.value = null;
  });

  it('leaves a saved capture and its address when a new capture starts', async () => {
    const saved = saveCapture('old');
    const { w, router } = await open(`/operate/live-debug/oal?file=core.oal&ruleName=service_cpm&historyId=${saved.id}`);
    expect(w.find('.oal__histbanner').exists(), 'the saved capture is on screen').toBe(true);
    await w.findAll('button').find((b) => b.text() === 'start sampling')!.trigger('click');
    await flushPromises();
    expect(start).toHaveBeenCalledTimes(1);
    expect(w.find('.oal__histbanner').exists(), 'the new capture is shown, not the saved one').toBe(false);
    expect(router.currentRoute.value.query.historyId).toBeUndefined();
    w.unmount();
  });

  it('leaves the saved capture’s address on back to live', async () => {
    const saved = saveCapture('old');
    const { w, router } = await open(`/operate/live-debug/oal?historyId=${saved.id}`);
    await w.find('.oal__histback').trigger('click');
    await flushPromises();
    expect(router.currentRoute.value.query.historyId, 'a reload opens the tab, not the saved capture').toBeUndefined();
    w.unmount();
  });

  it('takes a deep link only when the address is its own tab’s', async () => {
    saveCapture('live-a', Date.now() + 600_000);
    const { w, router } = await open('/operate/live-debug/mal?resumeSessionId=live-a');
    expect(resume, 'another tab’s address').not.toHaveBeenCalled();
    await router.push('/operate/live-debug/oal?resumeSessionId=live-a');
    await flushPromises();
    expect(resume).toHaveBeenCalledTimes(1);
    w.unmount();
  });

  it('starts the folds over when another capture comes on screen', async () => {
    shown.value = capture('a');
    const { w } = await open('/operate/live-debug/oal');
    const header = () => w.findAll('.oal__grouph');
    expect(header().length, 'the records render').toBeGreaterThan(1);
    await header()[1]!.trigger('click');
    expect(w.findAll('.oal__group--folded')).toHaveLength(1);
    shown.value = capture('b');
    await flushPromises();
    expect(w.findAll('.oal__group--folded'), 'nothing folded in the new capture').toHaveLength(0);
    w.unmount();
  });

  it('leaves another tab’s capture address alone when the address moves to it', async () => {
    const saved = saveCapture('old');
    const { w, router } = await open(`/operate/live-debug/oal?historyId=${saved.id}`);
    expect(w.find('.oal__histbanner').exists()).toBe(true);
    await router.push('/operate/live-debug/tal?resumeSessionId=live-t');
    await flushPromises();
    expect(router.currentRoute.value.query.resumeSessionId, 'the TAL capture a reload resumes').toBe('live-t');
    expect(w.find('.oal__histbanner').exists(), 'the OAL tab left its saved capture').toBe(false);
    w.unmount();
  });
});
