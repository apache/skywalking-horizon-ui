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
  traceDetail: vi.fn(), zipkinTrace: vi.fn(),
}));
vi.mock('@/api/client', () => ({ bffClient: {
  evaluationRecord: { list: api.list, facets: api.facets, callerServices: api.callerServices },
  layer: { instances: api.instances },
  trace: { detail: api.traceDetail },
  zipkin: { trace: api.zipkinTrace },
} }));
vi.mock('@/layer/traces/useResultTracePopout', () => ({
  useResultTracePopout: () => ({ openResultTrace: api.openTrace }),
}));
vi.mock('@/controls/useAutoRefreshSubscribe', () => ({ useAutoRefreshSubscribe: () => {} }));
const authState = vi.hoisted(() => ({ verbs: null as Set<string> | null }));
vi.mock('@/state/auth', () => ({ useAuthStore: () => ({ hasVerb: (verb: string) => (authState.verbs ? authState.verbs.has(verb) : true) }) }));

let wrapper: VueWrapper;
let router: Router;
let client: QueryClient;

beforeEach(() => {
  vi.clearAllMocks();
  // A caller application sorts FIRST across layers; only the rows on the
  // page's layer are providers.
  api.callerServices.mockResolvedValue({ services: [
    { id: 'app', name: 'e2e-app', normal: true, layer: 'GENERAL' },
    { id: 'provider', name: 'OpenAI', normal: false, layer: 'VIRTUAL_GENAI' },
    { id: 'provider-2', name: 'Anthropic', normal: false, layer: 'VIRTUAL_GENAI' },
  ] });
  api.instances.mockResolvedValue({ instances: [{ id: 'new-model', name: 'New model' }] });
  api.list.mockResolvedValue({ records: [], reachable: true, total: null });
  api.facets.mockResolvedValue({ reachable: true, level: {} });
});
afterEach(() => {
  authState.verbs = null;
  wrapper?.unmount();
  client?.clear();
  document.body.innerHTML = '';
});

async function openPage(query = '', address = '/layer/virtual_genai/evaluation-records?providerId=provider'): Promise<void> {
  router = createRouter({ history: createMemoryHistory(), routes: [
    { path: '/layer/:layerKey/evaluation-records', component: LayerEvaluationRecordView },
  ] });
  await router.push(`${address}${query}`);
  await router.isReady();
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  wrapper = mount(LayerEvaluationRecordView, {
    attachTo: document.body,
    global: { plugins: [createPinia(), router, i18n, [VueQueryPlugin, { queryClient: client }]] },
  });
  await flushPromises();
}

/** Press Run query: the reads are staged until then, as on the Logs tab. */
async function runQuery(): Promise<void> {
  await wrapper.get('.lg-run-btn').trigger('click');
  await flushPromises();
}
function expectModel(modelId: string | undefined): void {
  for (const request of [api.list, api.facets]) {
    expect(request).toHaveBeenCalled();
    expect(request.mock.lastCall?.[1].modelId).toBe(modelId);
  }
}
function expectProvider(providerId: string | undefined): void {
  for (const request of [api.list, api.facets]) {
    expect(request).toHaveBeenCalled();
    expect(request.mock.lastCall?.[1].providerId).toBe(providerId);
  }
}
function fieldFor(label: string) {
  const field = wrapper.findAll('label.cf').find((candidate) => candidate.find('span').text() === label);
  expect(field, `a condition labelled ${label}`).toBeDefined();
  return field!;
}
/** The condition bar's native `<select>` under the given label. */
function selectFor(label: string) {
  return fieldFor(label).get('select');
}
/** What a type-to-filter picker shows as picked. */
function pickedLabel(label: string): string {
  return fieldFor(label).get('.tas__label').text().trim();
}
/** Open a type-to-filter picker and read its option labels; Escape closes it. */
async function optionLabels(label: string): Promise<string[]> {
  await fieldFor(label).get('.tas__trigger').trigger('click');
  await flushPromises();
  const labels = [...document.querySelectorAll('.tas__panel .tas__row-label')].map((el) => el.textContent?.trim() ?? '');
  document.querySelector<HTMLInputElement>('.tas__search')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await flushPromises();
  return labels;
}
/** Pick an option in a type-to-filter picker, the way an operator does: open, filter, click. */
async function pickOption(label: string, option: string): Promise<void> {
  await fieldFor(label).get('.tas__trigger').trigger('click');
  await flushPromises();
  const search = document.querySelector<HTMLInputElement>('.tas__search');
  if (search) { search.value = option; search.dispatchEvent(new Event('input', { bubbles: true })); await flushPromises(); }
  const row = [...document.querySelectorAll<HTMLElement>('.tas__panel .tas__row')].find((el) => el.querySelector('.tas__row-label')?.textContent?.trim() === option);
  expect(row, `option ${option} under ${label}`).toBeDefined();
  row!.click();
  await flushPromises();
}

describe('evaluation provider identity', () => {
  it('picks the first provider on the layer when the address names none, not the first service in the catalog', async () => {
    await openPage('', '/layer/virtual_genai/evaluation-records');
    await runQuery();
    expectProvider('provider');
    expect(pickedLabel('Provider')).toBe('OpenAI');
    expect(await optionLabels('Provider')).toEqual(['OpenAI', 'Anthropic']);
  });

  it('writes provider and model to the address together', async () => {
    await openPage('&modelId=old-model');
    await runQuery();
    expectProvider('provider');
    expectModel('old-model');

    await pickOption('Provider', 'Anthropic');
    // A provider switch clears back to the prompt; nothing reads until Run query.
    expect(api.list.mock.lastCall?.[1].providerId).toBe('provider');
    expect(wrapper.text()).toContain('Pick your conditions, then click Run query.');
    await runQuery();
    expectProvider('provider-2');
    expectModel(undefined);
    expect(router.currentRoute.value.query).toMatchObject({ providerId: 'provider-2' });
    expect(router.currentRoute.value.query.modelId).toBeUndefined();

    await pickOption('Model', 'New model');
    await runQuery();
    expectProvider('provider-2');
    expectModel('new-model');
    expect(router.currentRoute.value.query).toMatchObject({ providerId: 'provider-2', modelId: 'new-model' });
  });
});

describe('manual-fire gate', () => {
  it('reads nothing on open, stages edits, and reads only on Run query', async () => {
    await openPage('&modelId=old-model');
    expect(api.list).not.toHaveBeenCalled();
    expect(api.facets).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain('Pick your conditions, then click Run query.');

    await runQuery();
    expect(api.list).toHaveBeenCalledTimes(1);
    expectModel('old-model');

    const taskName = wrapper.findAll('label.cf').find((l) => l.find('span').text() === 'Task name')!.get('input');
    await taskName.setValue('Faithfulness');
    await flushPromises();
    expect(api.list).toHaveBeenCalledTimes(1);
    expect(api.list.mock.lastCall?.[1].taskName).toBeUndefined();

    await runQuery();
    expect(api.list.mock.lastCall?.[1]).toMatchObject({ taskName: 'Faithfulness', modelId: 'old-model' });
  });

  it('a level chip under the results commits and re-reads at once', async () => {
    await openPage('&modelId=old-model');
    await runQuery();
    expect(api.list).toHaveBeenCalledTimes(1);
    const chip = wrapper.findAll('.lg-legend-chip').find((c) => c.text().includes('good'))!;
    await chip.trigger('click');
    await flushPromises();
    expect(api.list).toHaveBeenCalledTimes(2);
    expect(api.list.mock.lastCall?.[1]).toMatchObject({ evaluationLevel: 'good' });
    await chip.trigger('click');
    await flushPromises();
    expect(api.list.mock.lastCall?.[1].evaluationLevel).toBeUndefined();
  });

  it('offers a caller seen only in the records once a query has run, and filters by its id', async () => {
    api.facets.mockResolvedValue({ reachable: true, level: {}, sampled: 3, services: [
      { id: 'provider', name: 'OpenAI', count: 1 },
      { id: 'py-id', name: 'e2e-otel-python', count: 2 },
    ] });
    await openPage('&modelId=old-model');
    expect(await optionLabels('Service')).toEqual(['All services', 'e2e-app', 'OpenAI', 'Anthropic']);
    await runQuery();
    expect(await optionLabels('Service')).toEqual(['All services', 'e2e-app', 'OpenAI', 'Anthropic', 'e2e-otel-python']);
    await pickOption('Service', 'e2e-otel-python');
    await runQuery();
    expect(api.list.mock.lastCall?.[1]).toMatchObject({ serviceId: 'py-id' });
  });

  it('keeps a caller seen in an earlier sample, and the picked one, when a later sample has none', async () => {
    api.facets
      .mockResolvedValueOnce({ reachable: true, level: {}, sampled: 2, services: [{ id: 'py-id', name: 'e2e-otel-python', count: 2 }] })
      .mockResolvedValue({ reachable: true, level: {}, sampled: 0, services: [] });
    await openPage('&modelId=old-model');
    await runQuery();
    await pickOption('Service', 'e2e-otel-python');
    await runQuery();
    expect(api.list.mock.lastCall?.[1]).toMatchObject({ serviceId: 'py-id' });
    // The empty sample must neither hide the active filter nor drop the option.
    expect(pickedLabel('Service')).toBe('e2e-otel-python');
    expect(await optionLabels('Service')).toContain('e2e-otel-python');
  });

  it('reports a catalog that cannot be read, with a retry, instead of asking for a provider that cannot be picked', async () => {
    api.callerServices.mockResolvedValue({ reachable: false, services: [], error: 'OAP timed out' });
    await openPage('', '/layer/virtual_genai/evaluation-records');
    const banner = wrapper.get('.lg-catalog-failure');
    expect(banner.text()).toContain('OAP timed out');
    expect(wrapper.text()).not.toContain('Pick a provider to run this query.');
    expect(api.callerServices).toHaveBeenCalledTimes(1);
    await banner.get('button').trigger('click');
    await flushPromises();
    expect(api.callerServices).toHaveBeenCalledTimes(2);
  });

  it('runs a dashboard drill on arrival, once the provider resolves', async () => {
    await openPage('&modelId=old-model&startTime=1788307200000&endTime=1788393600000&taskName=Faithfulness');
    expect(api.list).toHaveBeenCalledTimes(1);
    expect(api.list.mock.lastCall?.[1]).toMatchObject({
      providerId: 'provider', modelId: 'old-model', taskName: 'Faithfulness', startTime: 1788307200000, endTime: 1788393600000,
    });
  });
});

describe('evaluation model identity', () => {
  it('retains the supplied model when navigating to another provider in the same view', async () => {
    await openPage('&modelId=old-model');
    await runQuery();
    await router.replace({ query: { providerId: 'other-provider', modelId: 'other-old-model' } });
    await flushPromises();
    await runQuery();
    expectModel('other-old-model');
    expect(router.currentRoute.value.query.modelId).toBe('other-old-model');
  });

  it('keeps an inactive bookmarked model in records and facets until explicitly changed or cleared', async () => {
    await openPage('&modelId=old-model&startTime=1788307200000&endTime=1788393600000');
    expectModel('old-model');
    // Not in the roster, yet still the picked one — an inactive model stays addressable.
    expect(pickedLabel('Model')).toBe('old-model');
    expect(await optionLabels('Model')).toEqual(['All models', 'old-model', 'New model']);

    await client.invalidateQueries({ queryKey: ['layer-instances'] });
    await flushPromises();
    expectModel('old-model');
    await pickOption('Model', 'New model');
    await runQuery();
    expectModel('new-model');
    expect(router.currentRoute.value.query.modelId).toBe('new-model');

    // Roster refreshes must not erase a previously selected model either.
    api.instances.mockResolvedValue({ instances: [] });
    await client.invalidateQueries({ queryKey: ['layer-instances'] });
    await flushPromises();
    expectModel('new-model');
    await pickOption('Model', 'All models');
    await runQuery();
    expectModel(undefined);
    expect(router.currentRoute.value.query.modelId).toBeUndefined();
    await client.invalidateQueries({ queryKey: ['layer-instances'] });
    await flushPromises();
    expectModel(undefined);
  });
});

describe('related trace span narrowing', () => {
  const span = (over: Partial<{ segmentId: string; spanId: number; layer: string; tags: Array<{ key: string; value: string }>; endpointName: string }>) => ({
    traceId: 'trace-1', segmentId: 'seg-1', spanId: 0, parentSpanId: -1, refs: [], serviceCode: 'e2e-spring-ai',
    serviceInstanceName: 'i1', startTime: 1788393600000, endTime: 1788393600100, endpointName: 'GET:/ai', type: 'Entry',
    peer: '', component: 'Tomcat', isError: false, layer: 'Http', tags: [], logs: [], attachedEvents: [], ...over,
  });

  it('lists the judged spans first and narrows the query to the picked one', async () => {
    api.traceDetail.mockResolvedValue({ generatedAt: 0, source: 'native', native: { spans: [
      span({}),
      span({ spanId: 3, layer: 'GenAI', endpointName: 'chat', tags: [
        { key: 'gen_ai.response.model', value: 'gpt-4.1-mini' }, { key: 'gen_ai.provider.name', value: 'openai' },
      ] }),
    ] } });
    await openPage('&evaluationTraceId=trace-1');
    expect(api.list.mock.lastCall?.[1]).toMatchObject({ traceId: 'trace-1', traceType: 'SKYWALKING_NATIVE' });
    expect(api.list.mock.lastCall?.[1].traceSegmentId).toBeUndefined();

    await wrapper.get('.cf-pick-span').trigger('click');
    await flushPromises();
    const picker = document.querySelector('[role="dialog"] .sp');
    expect(picker).not.toBeNull();
    // LLM-only by default: the Http span is hidden, the GenAI one is marked.
    const shown = [...picker!.querySelectorAll('tbody tr')];
    expect(shown).toHaveLength(1);
    expect(shown[0].classList.contains('llm')).toBe(true);
    expect(shown[0].textContent).toContain('openai / gpt-4.1-mini');
    (shown[0].querySelector('.sp-use') as HTMLButtonElement).click();
    await flushPromises();

    expect(document.querySelector('[role="dialog"] .sp')).toBeNull();
    expect((wrapper.get('.cf-segment-id').element as HTMLInputElement).value).toBe('seg-1');
    expect((wrapper.get('.cf-span-index').element as HTMLInputElement).value).toBe('3');
    await runQuery();
    for (const request of [api.list, api.facets]) {
      expect(request.mock.lastCall?.[1]).toMatchObject({ traceId: 'trace-1', traceSegmentId: 'seg-1', traceSpanIndex: 3 });
    }

    // A different trace id drops the narrowing: the span belonged to the old one.
    await wrapper.get('.cf-trace-id').setValue('trace-2');
    await runQuery();
    expect(api.list.mock.lastCall?.[1]).toMatchObject({ traceId: 'trace-2' });
    expect(api.list.mock.lastCall?.[1].traceSegmentId).toBeUndefined();
    expect(api.list.mock.lastCall?.[1].traceSpanIndex).toBeUndefined();
  });

  it('keeps re-reading a trace that answers empty, since a fresh record can name a segment still landing', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      api.traceDetail
        .mockResolvedValueOnce({ generatedAt: 0, source: 'native', native: { spans: [] } })
        .mockResolvedValue({ generatedAt: 0, source: 'native', native: { spans: [
          span({ spanId: 3, layer: 'GenAI', endpointName: 'chat', tags: [{ key: 'gen_ai.response.model', value: 'gpt-4.1-mini' }] }),
        ] } });
      await openPage('&evaluationTraceId=trace-1');
      await wrapper.get('.cf-pick-span').trigger('click');
      await flushPromises();
      const picker = () => document.querySelector('[role="dialog"] .sp')!;
      expect(picker().textContent).toContain('No spans yet');
      expect(api.traceDetail).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(3_000);
      await flushPromises();
      expect(api.traceDetail).toHaveBeenCalledTimes(2);
      expect(picker().querySelectorAll('tbody tr.llm')).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('looks a native trace up over the whole selected range, padded an hour each side', async () => {
    api.traceDetail.mockResolvedValue({ generatedAt: 0, source: 'native', native: { spans: [], reachable: true } });
    // A three-day custom range: a midpoint lookup would search only its middle day.
    const start = 1788134400000;
    const end = 1788393600000;
    await openPage(`&evaluationTraceId=trace-1&startTime=${start}&endTime=${end}`);
    await wrapper.get('.cf-pick-span').trigger('click');
    await flushPromises();
    expect(api.traceDetail).toHaveBeenCalledWith('trace-1', 'native', { startMs: start - 3_600_000, endMs: end + 3_600_000, step: 'HOUR' });
  });

  it('takes the rolling window when the picker opens, not when the page rendered', async () => {
    api.traceDetail.mockResolvedValue({ generatedAt: 0, source: 'native', native: { spans: [], reachable: true } });
    await openPage('&evaluationTraceId=trace-1');
    const before = Date.now();
    await wrapper.get('.cf-pick-span').trigger('click');
    await flushPromises();
    const range = api.traceDetail.mock.lastCall?.[2] as { startMs: number; endMs: number };
    // Last 30 minutes, padded an hour each side, ending no earlier than the click.
    expect(range.endMs - range.startMs).toBe(30 * 60_000 + 2 * 3_600_000);
    expect(range.endMs).toBeGreaterThanOrEqual(before + 3_600_000);
  });

  it('shows a backend failure the trace route reports, instead of retrying it as an empty trace', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      api.traceDetail.mockResolvedValue({ generatedAt: 0, source: 'native', native: { spans: [], reachable: false, error: 'OAP timed out' } });
      await openPage('&evaluationTraceId=trace-1');
      await wrapper.get('.cf-pick-span').trigger('click');
      await flushPromises();
      const picker = document.querySelector('[role="dialog"] .sp')!;
      expect(picker.querySelector('.banner.err')?.textContent).toContain('OAP timed out');
      expect(picker.textContent).not.toContain('No spans yet');
      await vi.advanceTimersByTimeAsync(10_000);
      await flushPromises();
      expect(api.traceDetail).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('hides Pick span… without traces:read, and leaves the address typable', async () => {
    authState.verbs = new Set(['logs:read']);
    await openPage('&evaluationTraceId=trace-1');
    expect(wrapper.find('.cf-pick-span').exists()).toBe(false);
    expect(wrapper.find('.cf-segment-id').exists()).toBe(true);
  });

  it('re-reads an OTLP trace OAP has no record of yet, since the Zipkin route reports that as not found', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      api.zipkinTrace
        .mockResolvedValueOnce({ generatedAt: 0, source: 'zipkin', traceId: 'trace-1', spans: [], reachable: false, error: 'trace not found', notFound: true })
        .mockResolvedValue({ generatedAt: 0, source: 'zipkin', traceId: 'trace-1', reachable: true, spans: [
          { traceId: 'trace-1', id: 'bbbb', name: 'chat', timestamp: 1788393600001000, duration: 100000, localEndpoint: { serviceName: 'py' }, tags: { 'gen_ai.response.model': 'gpt-4.1-mini' } },
        ] });
      await openPage('&evaluationTraceId=trace-1');
      await selectFor('Trace ID type').setValue('OTLP');
      await wrapper.get('.cf-pick-span').trigger('click');
      await flushPromises();
      const picker = () => document.querySelector('[role="dialog"] .sp')!;
      expect(picker().textContent).toContain('No spans yet');
      expect(picker().querySelector('.banner.err')).toBeNull();
      await vi.advanceTimersByTimeAsync(3_000);
      await flushPromises();
      expect(api.zipkinTrace).toHaveBeenCalledTimes(2);
      expect(picker().querySelectorAll('tbody tr.llm')).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('addresses an OTLP span by its span id, typed or picked', async () => {
    api.zipkinTrace.mockResolvedValue({ generatedAt: 0, spans: [
      { traceId: 'trace-1', id: 'aaaa', name: 'GET /', timestamp: 1788393600000000, duration: 200000, localEndpoint: { serviceName: 'py' }, tags: {} },
      { traceId: 'trace-1', id: 'bbbb', parentId: 'aaaa', name: 'chat gpt-4.1-mini', timestamp: 1788393600001000, duration: 100000,
        localEndpoint: { serviceName: 'py' }, tags: { 'gen_ai.response.model': 'gpt-4.1-mini', 'gen_ai.system': 'openai' } },
    ] });
    await openPage('&evaluationTraceId=trace-1');
    await selectFor('Trace ID type').setValue('OTLP');
    await flushPromises();
    await wrapper.get('.cf-span-id').setValue('typed-span');
    await runQuery();
    expect(api.list.mock.lastCall?.[1]).toMatchObject({ traceType: 'OTLP', traceSpanId: 'typed-span' });

    await wrapper.get('.cf-pick-span').trigger('click');
    await flushPromises();
    const picker = document.querySelector('[role="dialog"] .sp')!;
    const shown = [...picker.querySelectorAll('tbody tr')];
    expect(shown).toHaveLength(1);
    expect(shown[0].textContent).toContain('openai / gpt-4.1-mini');
    (shown[0].querySelector('.sp-use') as HTMLButtonElement).click();
    await flushPromises();
    expect((wrapper.get('.cf-span-id').element as HTMLInputElement).value).toBe('bbbb');
    await runQuery();
    expect(api.list.mock.lastCall?.[1]).toMatchObject({ traceType: 'OTLP', traceSpanId: 'bbbb' });
    expect(api.list.mock.lastCall?.[1].traceSegmentId).toBeUndefined();
  });
});

describe('evaluation detail trace navigation', () => {
  it.each(['SKYWALKING_NATIVE', 'OTLP'])('closes the actual detail modal before inspecting a %s trace', async (type) => {
    api.list.mockResolvedValue({ reachable: true, total: null, records: [{
      traceId: 'trace-1', traceRef: { type, traceId: 'trace-1', segmentId: null, spanIndex: null, spanId: null },
      evaluationTime: 1788393600000, taskName: 'quality', valueType: 'SCORE', scoreValue: 0.5,
    }] });
    await openPage();
    await runQuery();
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
