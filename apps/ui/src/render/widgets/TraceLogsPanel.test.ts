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
 * A trace's logs re-read over cached rows — a reopened box, a flipped Cold pill
 * — show the reading state until the read lands, never the previous rows.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import type { LogRow, TraceLogsResponse } from '@skywalking-horizon-ui/api-client';
import { i18n } from '@/i18n';
import TraceLogsPanel from './TraceLogsPanel.vue';

const row = (content: string): LogRow => ({
  serviceName: 'checkout', serviceId: 's', serviceInstanceName: null, serviceInstanceId: null,
  endpointName: null, endpointId: null, traceId: 't1', timestamp: 1_700_000_000_000,
  contentType: 'TEXT', content, tags: [],
});
const page = (content: string, over: Partial<TraceLogsResponse> = {}): TraceLogsResponse => ({
  generatedAt: 0, pageNum: 1, pageSize: 50, traceId: 't1', hasNext: false, logs: [row(content)], withheld: 0, windowClipped: false,
  startMs: 1, endMs: 2, reachable: true, ...over,
});
const answering = (body: TraceLogsResponse) => vi.fn(async () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }));
const mountPanel = () => mount(TraceLogsPanel, {
  props: { traceId: 't1', startMs: 1000, endMs: 2000 },
  global: { plugins: [i18n, [VueQueryPlugin, { queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }]] },
});

let wrapper: VueWrapper | null = null;
afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  vi.unstubAllGlobals();
});

describe('TraceLogsPanel', () => {
  it('hides the cached rows while it re-reads them', async () => {
    let answer: (r: Response) => void = () => {};
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { answer = resolve; })));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    // A previous read, long since stale: mounting reads again.
    queryClient.setQueryData(['trace-logs', { traceId: 't1', startMs: 1000, endMs: 2000 }, 1], page('the previous read'), {
      updatedAt: 0,
    });

    wrapper = mount(TraceLogsPanel, {
      props: { traceId: 't1', startMs: 1000, endMs: 2000 },
      global: { plugins: [i18n, [VueQueryPlugin, { queryClient }]] },
    });
    await flushPromises();
    expect(wrapper.text()).toContain('Reading logs');
    expect(wrapper.text()).not.toContain('the previous read');

    answer(new Response(JSON.stringify(page('this read')), { status: 200, headers: { 'content-type': 'application/json' } }));
    await flushPromises();
    expect(wrapper.text()).toContain('this read');
    expect(wrapper.text()).not.toContain('Reading logs');
  });
});

describe('TraceLogsPanel lines left out for access', () => {
  it('says a page of left-out lines is that, not a trace without logs', async () => {
    vi.stubGlobal('fetch', answering(page('x', { logs: [], withheld: 50, hasNext: true })));
    wrapper = mountPanel();
    await flushPromises();
    expect(wrapper.text()).toContain('Every line on this page comes from a service you may not read (50 left out).');
    expect(wrapper.text()).toContain('Later pages may hold lines you can read.');
    expect(wrapper.text()).not.toContain('No logs carry this trace id');
    expect(wrapper.find('button:not([disabled])').exists()).toBe(true);
  });

  it('shows the lines it may and says how many it left out', async () => {
    vi.stubGlobal('fetch', answering(page('readable line', { withheld: 3 })));
    wrapper = mountPanel();
    await flushPromises();
    expect(wrapper.text()).toContain('readable line');
    expect(wrapper.text()).toContain('3 lines on this page come from services you may not read and are left out.');
  });

  it('keeps the no-logs answer for a first and only page with nothing left out', async () => {
    vi.stubGlobal('fetch', answering(page('x', { logs: [] })));
    wrapper = mountPanel();
    await flushPromises();
    expect(wrapper.text()).toContain('No logs carry this trace id in the searched window.');
  });
});

describe('TraceLogsPanel searched window', () => {
  it('says when only the last week of a longer trace was searched', async () => {
    vi.stubGlobal('fetch', answering(page('line', { windowClipped: true })));
    wrapper = mountPanel();
    await flushPromises();
    expect(wrapper.text()).toContain('The trace runs longer than one read can search, so only its last week was searched.');
  });
});

describe('TraceLogsPanel paging by the id that answered', () => {
  it('reads later pages by the spelling the first page was found under, without asking for another', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      calls.push(String(input));
      return new Response(JSON.stringify(page('line', { traceId: '0000000000000000a1b2c3d4e5f60718', hasNext: true })), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    wrapper = mount(TraceLogsPanel, {
      props: { traceId: 'a1b2c3d4e5f60718', altTraceId: '0000000000000000a1b2c3d4e5f60718', startMs: 1000, endMs: 2000 },
      global: { plugins: [i18n, [VueQueryPlugin, { queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }]] },
    });
    await flushPromises();
    expect(calls[0]).toContain('/api/trace/a1b2c3d4e5f60718/logs?');
    expect(calls[0]).toContain('altTraceId=0000000000000000a1b2c3d4e5f60718');
    await wrapper.findAll('button').find((b) => b.text() === 'Next')!.trigger('click');
    await flushPromises();
    expect(calls[1]).toContain('/api/trace/0000000000000000a1b2c3d4e5f60718/logs?');
    expect(calls[1]).not.toContain('altTraceId');
    expect(calls[1]).toContain('page=2');
  });

  it('remembers that spelling when the box reopens on a cached first page', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      calls.push(String(input));
      return new Response(JSON.stringify(page('line', { traceId: '0000000000000000a1b2c3d4e5f60718', hasNext: true })), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const open = () => mount(TraceLogsPanel, {
      props: { traceId: 'a1b2c3d4e5f60718', altTraceId: '0000000000000000a1b2c3d4e5f60718', startMs: 1000, endMs: 2000 },
      global: { plugins: [i18n, [VueQueryPlugin, { queryClient }]] },
    });
    wrapper = open();
    await flushPromises();
    wrapper.unmount();
    wrapper = open();
    await flushPromises();
    expect(calls).toHaveLength(1);
    await wrapper.findAll('button').find((b) => b.text() === 'Next')!.trigger('click');
    await flushPromises();
    expect(calls[1]).toContain('/api/trace/0000000000000000a1b2c3d4e5f60718/logs?');
  });
});
