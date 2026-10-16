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
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import { i18n } from '@/i18n';
import TraceQLDetailCard from '@/layer/traceql/TraceQLDetailCard.vue';
import OTLPEvaluationTraceDetail from './OTLPEvaluationTraceDetail.vue';

const api = vi.hoisted(() => ({ sources: vi.fn(), otlp: vi.fn(), zipkin: vi.fn() }));
vi.mock('@/api/client', () => ({ bffClient: {
  traceql: { sources: api.sources, trace: api.otlp }, zipkin: { trace: api.zipkin },
} }));
vi.mock('@/layer/traceql/TraceQLDetailCard.vue', () => ({ default: {
  props: ['ds', 'traceId', 'spans', 'focusSpanId'], template: '<div class="native-otlp" />',
} }));
let wrapper: VueWrapper;
let router: Router;
let client: QueryClient;
const AT = 1788393600000;
beforeEach(() => {
  vi.resetAllMocks();
  api.sources.mockResolvedValue([{ ds: 'otlp', configured: true, reachable: true }]);
  api.otlp.mockResolvedValue({ ds: 'otlp', traceId: 'trace', reachable: true, notFound: false, spans: [{ spanId: 'span' }] });
});
afterEach(() => { wrapper?.unmount(); client?.clear(); });
async function open(cachedLegacy = false) {
  router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/records', component: { template: '<div />' } }] });
  await router.push(`/records?task=quality&traceqlId=trace&ds=otlp&evaluationTrace=1&traceqlSpanId=span&traceqlAt=${AT}`);
  await router.isReady();
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 60_000 } } });
  if (cachedLegacy) client.setQueryData(['evaluation-otlp-trace', 'trace', AT - 43_200_000, AT + 43_200_000], { source: 'zipkin', detail: { traceId: 'trace', reachable: true, spans: [{ id: 'span' }] } });
  wrapper = mount(OTLPEvaluationTraceDetail, {
    props: { traceId: 'trace', spanId: 'span', atMs: AT },
    global: { plugins: [router, i18n, [VueQueryPlugin, { queryClient: client }]] },
  });
  await flushPromises();
}

describe('OTLP evaluation trace detail', () => {
  it('renders original OTLP spans with the judged span selected', async () => {
    await open();
    const card = wrapper.getComponent(TraceQLDetailCard);
    expect(card.props()).toMatchObject({ ds: 'otlp', traceId: 'trace', focusSpanId: 'span', spans: [{ spanId: 'span' }] });
    expect(api.zipkin).not.toHaveBeenCalled();
    expect(router.currentRoute.value.query.evaluationTrace).toBe('1');
  });

  it('reuses a legacy result on the Zipkin popout without leaving stale TraceQL URL state', async () => {
    api.sources.mockResolvedValue([{ ds: 'otlp', configured: true, served: false, reachable: false }]);
    const detail = { traceId: 'trace', spans: [{ id: 'span' }], reachable: true };
    api.zipkin.mockResolvedValue(detail);
    await open();
    await flushPromises();
    expect(router.currentRoute.value.query).toEqual({ task: 'quality', traceId: 'trace', traceType: 'OTLP', traceSpanId: 'span', traceAt: String(AT) });
    expect(client.getQueryData(['zipkin-trace', 'trace', AT + 43_200_000, 86_400_000])).toEqual(detail);
  });

  it('opens a cached legacy result again without waiting for a refetch', async () => {
    await open(true);
    await flushPromises();
    expect(router.currentRoute.value.query.traceId).toBe('trace');
    expect(router.currentRoute.value.query.traceqlId).toBeUndefined();
    expect(api.sources).not.toHaveBeenCalled();
  });

  it('shows a native query failure and permits closing without redirecting to Zipkin', async () => {
    api.otlp.mockResolvedValue({ ds: 'otlp', traceId: 'trace', spans: [], reachable: false, notFound: false, error: 'OTLP query timed out' });
    await open();
    expect(wrapper.get('[role="alert"]').text()).toContain('OTLP query timed out');
    expect(api.zipkin).not.toHaveBeenCalled();
    expect(router.currentRoute.value.query.evaluationTrace).toBe('1');
    await wrapper.get('button').trigger('click');
    expect(wrapper.emitted('close')).toHaveLength(1);
  });
});
