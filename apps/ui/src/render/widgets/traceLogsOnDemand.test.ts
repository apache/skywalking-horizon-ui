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
 * A trace's logs are read when Logs or Related logs is clicked, and only then.
 * The trace detail's own reading hint shows only while the trace has no spans,
 * so it never sits beside the Logs button as if the logs were loading.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter, type Router } from 'vue-router';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import type { NativeSpan, ZipkinSpan } from '@skywalking-horizon-ui/api-client';
import { i18n } from '@/i18n';
import TraceDetailCard from './TraceDetailCard.vue';
import SpanDetailModal from './SpanDetailModal.vue';
import ZipkinTraceDetailCard from './ZipkinTraceDetailCard.vue';
import TraceLogsPopout from './TraceLogsPopout.vue';
import TraceQLDetailCard from '@/layer/traceql/TraceQLDetailCard.vue';

const NOW = Date.now();
const NATIVE: NativeSpan = {
  traceId: 't1', segmentId: 't1.seg', spanId: 0, parentSpanId: -1, refs: [],
  serviceCode: 'checkout', serviceInstanceName: 'i1', startTime: NOW - 5, endTime: NOW, endpointName: 'GET /checkout',
  type: 'Entry', peer: '', component: 'SpringMVC', isError: false, layer: 'Http', tags: [], logs: [], attachedEvents: [],
};
const ZIPKIN = {
  traceId: 'a1b2c3d4e5f60718', id: '0123456789abcdef', name: 'get /checkout',
  timestamp: NOW * 1000, duration: 5000, localEndpoint: { serviceName: 'checkout' }, tags: {},
} as unknown as ZipkinSpan;

let router: Router;
let wrapper: VueWrapper | null = null;
const reads: string[] = [];
const urls: string[] = [];
const logReads = () => reads.filter((p) => p.endsWith('/logs'));

beforeEach(async () => {
  setActivePinia(createPinia());
  reads.length = 0;
  urls.length = 0;
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    reads.push(new URL(String(input), 'http://ui').pathname);
    urls.push(String(input));
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  }));
  router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div />' } }] });
  await router.push('/layer/general/trace');
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  vi.unstubAllGlobals();
});

const plugins = () => [router, i18n, [VueQueryPlugin, { queryClient: new QueryClient() }]] as never;
const button = (w: VueWrapper, label: string) => w.findAll('button').find((b) => b.text().trim() === label);
const headerText = (w: VueWrapper, selector: string) => w.get(selector).text();

describe('trace detail header', () => {
  it('says it is reading spans, and offers no Logs, while the trace has none', () => {
    wrapper = mount(TraceDetailCard, {
      props: { spans: [], traceId: 't1', traceIds: ['t1'], loading: true },
      global: { plugins: plugins() },
    });
    expect(headerText(wrapper, '.tr-detail-tools')).toContain('loading spans…');
    expect(button(wrapper, 'Logs')).toBeUndefined();
  });

  it('shows no reading hint beside Logs while a shown trace is read again', () => {
    wrapper = mount(TraceDetailCard, {
      props: { spans: [NATIVE], traceId: 't1', traceIds: ['t1'], loading: true },
      global: { plugins: plugins() },
    });
    expect(headerText(wrapper, '.tr-detail-tools')).not.toMatch(/loading/);
    expect(button(wrapper, 'Logs')).toBeDefined();
  });

  it('keeps the Zipkin header free of a reading hint while a shown trace is read again', () => {
    wrapper = mount(ZipkinTraceDetailCard, {
      props: { spans: [ZIPKIN], traceId: 'a1b2c3d4e5f60718', loading: true },
      global: { plugins: plugins() },
    });
    expect(headerText(wrapper, '.ztr-detail-head')).not.toMatch(/loading/);
    expect(button(wrapper, 'Logs')).toBeDefined();
  });
});

describe('logs are read on click', () => {
  it('reads the trace logs only when Logs is clicked', async () => {
    wrapper = mount(TraceDetailCard, {
      props: { spans: [NATIVE], traceId: 't1', traceIds: ['t1'] },
      global: { plugins: plugins() },
      attachTo: document.body,
    });
    await flushPromises();
    expect(logReads()).toEqual([]);
    await button(wrapper, 'Logs')!.trigger('click');
    await flushPromises();
    expect(logReads()).toEqual(['/api/trace/t1/logs']);
  });

  it('reads a span\'s logs only when Related logs is clicked', async () => {
    wrapper = mount(SpanDetailModal, {
      props: { span: NATIVE, traceId: 't1', serviceColors: new Map(), traceStartMs: NATIVE.startTime, traceEndMs: NATIVE.endTime },
      global: { plugins: plugins() },
      attachTo: document.body,
    });
    await flushPromises();
    expect(logReads()).toEqual([]);
    await button(wrapper, 'Related logs')!.trigger('click');
    await flushPromises();
    expect(logReads()).toEqual(['/api/trace/t1/logs']);
  });
});

describe('another trace closes what belonged to the last one', () => {
  it('closes the native card\'s logs box and span dialog', async () => {
    wrapper = mount(TraceDetailCard, { props: { spans: [NATIVE], traceId: 't1', traceIds: ['t1'] }, global: { plugins: plugins() }, attachTo: document.body });
    await button(wrapper, 'Logs')!.trigger('click');
    await wrapper.get('.tr-default-row').trigger('click');
    await flushPromises();
    expect(wrapper.findComponent(SpanDetailModal).exists()).toBe(true);
    await wrapper.setProps({ traceId: 't2', traceIds: ['t2'] });
    await flushPromises();
    expect(wrapper.findComponent(SpanDetailModal).exists()).toBe(false);
    expect(wrapper.findAllComponents(TraceLogsPopout).every((p) => p.props('open') === false)).toBe(true);
  });

  it('closes the Zipkin card\'s logs box', async () => {
    wrapper = mount(ZipkinTraceDetailCard, { props: { spans: [ZIPKIN], traceId: 'a1b2c3d4e5f60718' }, global: { plugins: plugins() }, attachTo: document.body });
    await button(wrapper, 'Logs')!.trigger('click');
    expect(wrapper.getComponent(TraceLogsPopout).props('open')).toBe(true);
    await wrapper.setProps({ traceId: 'ffffffffffffffff' });
    await flushPromises();
    expect(wrapper.getComponent(TraceLogsPopout).props('open')).toBe(false);
  });

  it('closes the TraceQL card\'s logs box, and forgets its span', async () => {
    const span = { spanId: 's1', parentSpanId: '', service: 'app', resourceAttributes: [], name: 'op', kind: 'SPAN_KIND_SERVER', startUs: 1000, durationUs: 100, status: 'ok' as const, attributes: [], events: [] };
    wrapper = mount(TraceQLDetailCard, { props: { ds: 'otlp', traceId: 'tq1', spans: [span] }, global: { plugins: plugins() }, attachTo: document.body });
    await button(wrapper, 'Logs')!.trigger('click');
    expect(wrapper.getComponent(TraceLogsPopout).props('open')).toBe(true);
    await wrapper.setProps({ traceId: 'tq2' });
    await flushPromises();
    expect(wrapper.getComponent(TraceLogsPopout).props('open')).toBe(false);
    expect(wrapper.getComponent(TraceLogsPopout).props('otlpSpanId') ?? null).toBe(null);
  });
});

describe('a Zipkin trace\'s logs are read by the id as OAP holds it', () => {
  it('pads a short id typed for the Zipkin card', async () => {
    wrapper = mount(ZipkinTraceDetailCard, { props: { spans: [ZIPKIN], traceId: 'ABC' }, global: { plugins: plugins() }, attachTo: document.body });
    await button(wrapper, 'Logs')!.trigger('click');
    await flushPromises();
    expect(logReads()).toEqual(['/api/trace/0000000000000abc/logs']);
    // A 64-bit id's logs may be held under its 32-character spelling too.
    expect(urls.find((u) => u.includes('/logs?'))).toContain('altTraceId=00000000000000000000000000000abc');
  });

  it('lowercases an OTLP id, as OAP does to find the trace', async () => {
    const span = { spanId: 's1', parentSpanId: '', service: 'app', resourceAttributes: [], name: 'op', kind: 'SPAN_KIND_SERVER', startUs: 1000, durationUs: 100, status: 'ok' as const, attributes: [], events: [] };
    wrapper = mount(TraceQLDetailCard, { props: { ds: 'otlp', traceId: '0AF7651916CD43DD8448EB211C80319C', spans: [span] }, global: { plugins: plugins() }, attachTo: document.body });
    await button(wrapper, 'Logs')!.trigger('click');
    await flushPromises();
    expect(logReads()).toEqual(['/api/trace/0af7651916cd43dd8448eb211c80319c/logs']);
    expect(urls.find((u) => u.includes('/logs?'))).not.toContain('altTraceId');
  });

  it('shortens a 128-bit id whose upper half is zero on the TraceQL Zipkin datasource', async () => {
    const span = { spanId: 's1', parentSpanId: '', service: 'app', resourceAttributes: [], name: 'op', kind: 'SPAN_KIND_SERVER', startUs: 1000, durationUs: 100, status: 'ok' as const, attributes: [], events: [] };
    wrapper = mount(TraceQLDetailCard, { props: { ds: 'zipkin', traceId: '0000000000000000a1b2c3d4e5f60718', spans: [span] }, global: { plugins: plugins() }, attachTo: document.body });
    await button(wrapper, 'Logs')!.trigger('click');
    await flushPromises();
    expect(logReads()).toEqual(['/api/trace/a1b2c3d4e5f60718/logs']);
  });
});
