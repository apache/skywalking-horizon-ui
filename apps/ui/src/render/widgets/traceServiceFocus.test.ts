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
 * Clicking a service in a trace detail's legend highlights that service's
 * spans in every view of the trace — waterfall rows, tree nodes, statistics
 * rows — and brings the first of them into view. Clicking it again, or
 * opening another trace, clears it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter, type Router } from 'vue-router';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import type { NativeSpan, TraceQLSpan, ZipkinSpan } from '@skywalking-horizon-ui/api-client';
import { i18n } from '@/i18n';
import TraceDetailCard from './TraceDetailCard.vue';
import ZipkinTraceDetailCard from './ZipkinTraceDetailCard.vue';
import TraceQLDetailCard from '@/layer/traceql/TraceQLDetailCard.vue';

const NOW = Date.now();
const native = (segmentId: string, spanId: number, parentSpanId: number, serviceCode: string, endpointName: string): NativeSpan => ({
  traceId: 't1', segmentId, spanId, parentSpanId, refs: [], serviceCode, serviceInstanceName: 'i1',
  startTime: NOW - 10 + spanId, endTime: NOW, endpointName, type: 'Entry', peer: '', component: 'SpringMVC',
  isError: false, layer: 'Http', tags: [], logs: [], attachedEvents: [],
});
const NATIVE: NativeSpan[] = [
  native('seg-a', 0, -1, 'checkout', 'GET /checkout'),
  native('seg-a', 1, 0, 'checkout', 'Local/prepare'),
  { ...native('seg-b', 0, -1, 'payment', 'POST /pay'), refs: [{ traceId: 't1', parentSegmentId: 'seg-a', parentSpanId: 1, type: 'CROSS_PROCESS' }] } as NativeSpan,
];
const zipkin = (id: string, parentId: string | undefined, serviceName: string): ZipkinSpan => ({
  traceId: 'a1b2c3d4e5f60718', id, parentId, name: `op ${id}`, timestamp: NOW * 1000, duration: 5000,
  localEndpoint: { serviceName }, tags: {},
} as unknown as ZipkinSpan);
const traceql = (spanId: string, parentSpanId: string, service: string): TraceQLSpan => ({
  spanId, parentSpanId, service, resourceAttributes: [], name: `op ${spanId}`, kind: 'SPAN_KIND_SERVER',
  startUs: 1000, durationUs: 100, status: 'ok', attributes: [], events: [],
});

let router: Router;
let wrapper: VueWrapper | null = null;
/** How far the page was scrolled, per reveal. */
const scrolled: number[] = [];
// jsdom lays nothing out: a highlighted row sits at `rowTop`, every other
// element spans the page, and the window is 768px tall.
let rowTop = 2000;
const rect = (top: number, height: number) => ({ top, bottom: top + height, left: 0, right: 100, width: 100, height, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;
const realRect = Element.prototype.getBoundingClientRect;

beforeEach(async () => {
  setActivePinia(createPinia());
  scrolled.length = 0;
  rowTop = 2000;
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })));
  vi.spyOn(window, 'scrollBy').mockImplementation(((_x: number, dy: number) => { scrolled.push(dy); }) as typeof window.scrollBy);
  Element.prototype.getBoundingClientRect = function getBoundingClientRect(this: Element) {
    return this.classList.contains('svc-hl') ? rect(rowTop, 20) : rect(0, 4000);
  };
  router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div />' } }] });
  await router.push('/layer/general/trace');
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  Element.prototype.getBoundingClientRect = realRect;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const plugins = () => [router, i18n, [VueQueryPlugin, { queryClient: new QueryClient() }]] as never;
const chip = (w: VueWrapper, service: string) => w.findAll('button[aria-pressed]').find((b) => b.text().trim() === service)!;
const highlighted = (w: VueWrapper, selector: string) => w.findAll(`${selector}.svc-hl`).map((e) => e.text());
const view = async (w: VueWrapper, name: string) => {
  await w.findAll('button').find((b) => b.text().trim() === name)!.trigger('click');
  await flushPromises();
};

describe('native trace detail', () => {
  it('highlights the picked service in the waterfall, tree and statistics, and brings its first row into view', async () => {
    wrapper = mount(TraceDetailCard, { props: { spans: NATIVE, traceId: 't1', traceIds: ['t1'] }, global: { plugins: plugins() } });
    await chip(wrapper, 'payment').trigger('click');
    await flushPromises();
    expect(chip(wrapper, 'payment').attributes('aria-pressed')).toBe('true');
    expect(highlighted(wrapper, '.tr-default-row')).toEqual([expect.stringContaining('POST /pay')]);
    // The highlighted row sits below the window, so the page scrolls down to it.
    expect(scrolled).toHaveLength(1);
    expect(scrolled[0]).toBeGreaterThan(0);

    await view(wrapper, 'Tree');
    expect(highlighted(wrapper, '.tree-node')).toEqual([expect.stringContaining('POST /pay')]);

    await view(wrapper, 'Statistics');
    expect(highlighted(wrapper, '.tr-table tbody tr')).toEqual([expect.stringContaining('POST /pay')]);
  });

  it('leaves the list where it is when the first highlighted row is in view already', async () => {
    rowTop = 100;
    wrapper = mount(TraceDetailCard, { props: { spans: NATIVE, traceId: 't1', traceIds: ['t1'] }, global: { plugins: plugins() } });
    await chip(wrapper, 'payment').trigger('click');
    await flushPromises();
    expect(highlighted(wrapper, '.tr-default-row')).toHaveLength(1);
    expect(scrolled).toEqual([]);
  });

  it('picks another service in place of the first, and clears on a second click', async () => {
    wrapper = mount(TraceDetailCard, { props: { spans: NATIVE, traceId: 't1', traceIds: ['t1'] }, global: { plugins: plugins() } });
    await chip(wrapper, 'payment').trigger('click');
    await chip(wrapper, 'checkout').trigger('click');
    await flushPromises();
    expect(highlighted(wrapper, '.tr-default-row')).toHaveLength(2);
    expect(chip(wrapper, 'payment').attributes('aria-pressed')).toBe('false');
    await chip(wrapper, 'checkout').trigger('click');
    await flushPromises();
    expect(highlighted(wrapper, '.tr-default-row')).toEqual([]);
  });

  it('clears the highlight when another trace opens', async () => {
    wrapper = mount(TraceDetailCard, { props: { spans: NATIVE, traceId: 't1', traceIds: ['t1'] }, global: { plugins: plugins() } });
    await chip(wrapper, 'payment').trigger('click');
    await wrapper.setProps({ traceId: 't2', traceIds: ['t2'] });
    await flushPromises();
    expect(highlighted(wrapper, '.tr-default-row')).toEqual([]);
    expect(chip(wrapper, 'payment').attributes('aria-pressed')).toBe('false');
  });
});

describe('Zipkin trace detail', () => {
  it('highlights the picked service\'s rows', async () => {
    wrapper = mount(ZipkinTraceDetailCard, {
      props: { spans: [zipkin('0000000000000001', undefined, 'frontend'), zipkin('0000000000000002', '0000000000000001', 'rating')], traceId: 'a1b2c3d4e5f60718' },
      global: { plugins: plugins() },
    });
    await chip(wrapper, 'rating').trigger('click');
    await flushPromises();
    expect(highlighted(wrapper, '.tp-row')).toEqual([expect.stringContaining('op 0000000000000002')]);
    expect(scrolled).toHaveLength(1);
  });
});

describe('TraceQL trace detail', () => {
  it('highlights the picked service in the waterfall, tree and statistics', async () => {
    wrapper = mount(TraceQLDetailCard, {
      props: { ds: 'otlp', traceId: 'tq1', spans: [traceql('a', '', 'frontend'), traceql('b', 'a', 'cart')] },
      global: { plugins: plugins() },
    });
    await chip(wrapper, 'cart').trigger('click');
    await flushPromises();
    expect(highlighted(wrapper, '.tqw-row')).toEqual([expect.stringContaining('op b')]);
    await view(wrapper, 'Tree');
    expect(highlighted(wrapper, '.tqt-node')).toEqual([expect.stringContaining('op b')]);
    await view(wrapper, 'Statistics');
    expect(highlighted(wrapper, '.tqs-table tbody tr')).toEqual([expect.stringContaining('op b')]);
  });
});
