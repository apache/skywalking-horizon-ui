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
 * The deferred status check. It reads traces the operator did not ask for, so
 * what matters is that it reads only the rows nobody could classify, abandons
 * a round the moment a new query starts, and refuses to turn a trace of
 * only-unset spans into a success.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, computed, shallowRef, h } from 'vue';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import type { TraceListRow, TraceQLSpan } from '@skywalking-horizon-ui/api-client';
import { useTraceQLStatusResolver } from './useTraceQL';

function row(key: string, unknown = true): TraceListRow {
  return {
    key,
    endpointNames: ['/homepage'],
    duration: 10,
    start: '1700000000000',
    isError: false,
    ...(unknown ? { errorUnknown: true } : {}),
    traceIds: [key],
  };
}

function span(status: TraceQLSpan['status'], attributes: Array<{ key: string; value: string }> = []): TraceQLSpan {
  return {
    spanId: 's1',
    parentSpanId: '',
    name: '/homepage',
    kind: 'SPAN_KIND_SERVER',
    service: 'agent::ui',
    startUs: 0,
    durationUs: 10,
    status,
    attributes,
    resourceAttributes: [],
    events: [],
  };
}

/** A BFF whose trace reads answer with the spans the test names. */
function fakeBffSpans(spansOf: (id: string) => TraceQLSpan[]) {
  const reads: string[] = [];
  const fetchSpy = vi.fn(async (input: string | URL | Request) => {
    const path = new URL(String(input), 'http://ui').pathname;
    const id = decodeURIComponent(path.split('/trace/')[1] ?? '');
    reads.push(id);
    return new Response(
      JSON.stringify({ ds: 'native', traceId: id, spans: spansOf(id), reachable: true, notFound: false }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  });
  vi.stubGlobal('fetch', fetchSpy);
  return { reads };
}

function fakeBff(statusOf: (id: string) => TraceQLSpan['status']) {
  return fakeBffSpans((id) => [span(statusOf(id))]);
}

/** Mount the composable, which needs a query client to live in. */
function harness() {
  const seen: Array<{ traceId: string; isError: boolean }> = [];
  // shallowRef, or Vue unwraps the composable's own refs inside the holder and
  // `pending.value` reads as undefined.
  const api = shallowRef<ReturnType<typeof useTraceQLStatusResolver> | null>(null);
  const comp = defineComponent({
    setup() {
      api.value = useTraceQLStatusResolver(
        computed(() => 'native' as const),
        computed(() => ({ startMs: 1, endMs: 2 })),
        (v) => seen.push(v),
      );
      return () => h('div');
    },
  });
  const wrapper = mount(comp, {
    global: { plugins: [[VueQueryPlugin, { queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }]] },
  });
  return { wrapper, seen, api: () => api.value! };
}

let mounted: VueWrapper | null = null;
afterEach(() => {
  mounted?.unmount();
  mounted = null;
  vi.unstubAllGlobals();
});

describe('deferred trace status', () => {
  it('reads only the rows the list could not classify', async () => {
    const { reads } = fakeBff(() => 'ok');
    const h1 = harness();
    mounted = h1.wrapper;
    await h1.api().resolve([row('a'), row('b', false), row('c')]);
    await flushPromises();
    expect(reads.sort()).toEqual(['a', 'c']);
    expect(h1.seen).toEqual([
      { traceId: 'a', isError: false },
      { traceId: 'c', isError: false },
    ]);
  });

  it('reports a failure when any span carries one', async () => {
    fakeBff((id) => (id === 'bad' ? 'error' : 'ok'));
    const h1 = harness();
    mounted = h1.wrapper;
    await h1.api().resolve([row('bad'), row('good')]);
    await flushPromises();
    expect(h1.seen.find((s) => s.traceId === 'bad')?.isError).toBe(true);
    expect(h1.seen.find((s) => s.traceId === 'good')?.isError).toBe(false);
  });

  it('leaves a trace of only-unset spans unknown', async () => {
    fakeBff(() => 'unset');
    const h1 = harness();
    mounted = h1.wrapper;
    await h1.api().resolve([row('a')]);
    await flushPromises();
    // `unset` is the absence of a verdict; reporting `false` would paint it
    // green on no evidence at all.
    expect(h1.seen).toEqual([]);
  });

  it('settles an unset span on the markers it carries', async () => {
    // Every span OAP converts from Zipkin is `unset`, so without this the
    // whole store stays permanently unknown however plainly it reports a 500.
    fakeBffSpans((id) => [span('unset', [{ key: 'http.status_code', value: id === 'bad' ? '500' : '200' }])]);
    const h1 = harness();
    mounted = h1.wrapper;
    await h1.api().resolve([row('bad'), row('good')]);
    await flushPromises();
    expect(h1.seen).toEqual([
      { traceId: 'bad', isError: true },
      { traceId: 'good', isError: false },
    ]);
  });

  it('still leaves a trace whose markers say nothing unknown', async () => {
    fakeBffSpans(() => [span('unset', [{ key: 'http.method', value: 'GET' }])]);
    const h1 = harness();
    mounted = h1.wrapper;
    await h1.api().resolve([row('a')]);
    await flushPromises();
    expect(h1.seen).toEqual([]);
  });

  it('abandons the round a new query replaces', async () => {
    const { reads } = fakeBff(() => 'ok');
    const h1 = harness();
    mounted = h1.wrapper;
    const first = h1.api().resolve([row('a'), row('b'), row('c'), row('d'), row('e'), row('f')]);
    h1.api().stop();
    await first;
    await flushPromises();
    // The four workers in flight finish their own read; nothing past them runs.
    expect(reads.length).toBeLessThanOrEqual(4);
    expect(h1.api().pending.value).toBe(0);
  });

  it('counts down what is left to check', async () => {
    fakeBff(() => 'ok');
    const h1 = harness();
    mounted = h1.wrapper;
    const done = h1.api().resolve([row('a'), row('b')]);
    expect(h1.api().pending.value).toBe(2);
    await done;
    await flushPromises();
    expect(h1.api().pending.value).toBe(0);
  });
});
