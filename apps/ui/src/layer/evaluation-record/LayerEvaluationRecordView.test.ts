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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils';
import { createMemoryHistory, createRouter, type Router } from 'vue-router';
import { createPinia } from 'pinia';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import { i18n } from '@/i18n';
import LayerEvaluationRecordView from './LayerEvaluationRecordView.vue';
import EvaluationRecordStreamPanel from '@/render/widgets/EvaluationRecordStreamPanel.vue';

const api = vi.hoisted(() => ({
  list: vi.fn(), facets: vi.fn(), instances: vi.fn(), callerServices: vi.fn(), openTrace: vi.fn(),
}));
vi.mock('@/api/client', () => ({ bffClient: {
  evaluationRecord: { list: api.list, facets: api.facets, callerServices: api.callerServices },
  layer: { instances: api.instances },
} }));
vi.mock('@/layer/traces/useResultTracePopout', () => ({
  useResultTracePopout: () => ({ openResultTrace: api.openTrace }),
}));
vi.mock('@/controls/useAutoRefreshSubscribe', () => ({ useAutoRefreshSubscribe: () => {} }));
vi.mock('@/state/auth', () => ({ useAuthStore: () => ({ hasVerb: () => true }) }));

let wrapper: VueWrapper;
let router: Router;
let client: QueryClient;

beforeEach(() => {
  vi.clearAllMocks();
  api.callerServices.mockResolvedValue({ services: [{ id: 'provider', name: 'OpenAI', normal: false }] });
  api.instances.mockResolvedValue({ instances: [{ id: 'new-model', name: 'New model' }] });
  api.list.mockResolvedValue({ records: [], reachable: true, total: null });
  api.facets.mockResolvedValue({ reachable: true, level: {} });
});
afterEach(() => {
  wrapper?.unmount();
  client?.clear();
  document.body.innerHTML = '';
});

async function openPage(query = ''): Promise<void> {
  router = createRouter({ history: createMemoryHistory(), routes: [
    { path: '/layer/:layerKey/evaluation-records', component: LayerEvaluationRecordView },
  ] });
  await router.push(`/layer/virtual_genai/evaluation-records?providerId=provider${query}`);
  await router.isReady();
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  wrapper = mount(LayerEvaluationRecordView, {
    attachTo: document.body,
    global: { plugins: [createPinia(), router, i18n, [VueQueryPlugin, { queryClient: client }]] },
  });
  await flushPromises();
}

function expectModel(modelId: string | undefined): void {
  for (const request of [api.list, api.facets]) {
    expect(request).toHaveBeenCalled();
    expect(request.mock.lastCall?.[1].modelId).toBe(modelId);
  }
}

describe('evaluation model identity', () => {
  it('retains the supplied model when navigating to another provider in the same view', async () => {
    await openPage('&modelId=old-model');
    await router.replace({ query: { providerId: 'other-provider', modelId: 'other-old-model' } });
    await flushPromises();
    expectModel('other-old-model');
    expect(router.currentRoute.value.query.modelId).toBe('other-old-model');
  });

  it('keeps an inactive bookmarked model in records and facets until explicitly changed or cleared', async () => {
    await openPage('&modelId=old-model&startTime=1788307200000&endTime=1788393600000');
    expectModel('old-model');
    const select = wrapper.get('select');
    expect((select.element as HTMLSelectElement).value).toBe('old-model');
    expect(select.text()).toContain('old-model');

    await client.invalidateQueries({ queryKey: ['layer-instances'] });
    await flushPromises();
    expectModel('old-model');
    await select.setValue('new-model');
    await flushPromises();
    expectModel('new-model');
    expect(router.currentRoute.value.query.modelId).toBe('new-model');

    // Roster refreshes must not erase a previously selected model either.
    api.instances.mockResolvedValue({ instances: [] });
    await client.invalidateQueries({ queryKey: ['layer-instances'] });
    await flushPromises();
    expectModel('new-model');
    await select.setValue('');
    await flushPromises();
    expectModel(undefined);
    expect(router.currentRoute.value.query.modelId).toBeUndefined();
    await client.invalidateQueries({ queryKey: ['layer-instances'] });
    await flushPromises();
    expectModel(undefined);
  });
});

describe('evaluation detail trace navigation', () => {
  it.each(['SKYWALKING_NATIVE', 'OTLP'])('closes the actual detail modal before inspecting a %s trace', async (type) => {
    api.list.mockResolvedValue({ reachable: true, total: null, records: [{
      traceId: 'trace-1', traceRef: { type, traceId: 'trace-1', segmentId: null, spanIndex: null, spanId: null },
      evaluationTime: 1788393600000, taskName: 'quality', valueType: 'SCORE', scoreValue: 0.5,
    }] });
    await openPage();
    const panel = wrapper.getComponent(EvaluationRecordStreamPanel);
    const row = panel.props('rows')[0];
    panel.vm.$emit('select', { row, key: 'trace-1' });
    await flushPromises();
    const modal = document.querySelector('[role="dialog"]');
    expect(modal).not.toBeNull();
    const button = [...modal!.querySelectorAll('button')].find((candidate) => candidate.textContent?.includes('↗'));
    expect(button).toBeDefined();
    button!.click();
    await flushPromises();
    expect(api.openTrace).toHaveBeenCalledWith(expect.objectContaining({ type, traceId: 'trace-1' }), 1788393600000);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
});
