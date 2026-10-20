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

import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import { i18n } from '@/i18n';
import TraceQLTraceDetail from './TraceQLTraceDetail.vue';

const api = vi.hoisted(() => ({ trace: vi.fn() }));
vi.mock('@/api/client', () => ({ bffClient: { traceql: { trace: api.trace } } }));

let wrapper: VueWrapper | null = null;
afterEach(() => { wrapper?.unmount(); wrapper = null; vi.clearAllMocks(); });

async function open(answer: Record<string, unknown>) {
  api.trace.mockResolvedValue({ ds: 'otlp', traceId: 'trace', spans: [], ...answer });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  wrapper = mount(TraceQLTraceDetail, {
    props: { ds: 'otlp', traceId: 'trace' },
    global: { plugins: [i18n, [VueQueryPlugin, { queryClient: client }]], stubs: { TraceQLDetailCard: true } },
  });
  await flushPromises();
  return wrapper.text();
}

describe('TraceQL trace detail', () => {
  it('names the switch and the path key of a datasource OAP does not serve, instead of calling the trace missing', async () => {
    const text = await open({ reachable: false, notFound: false, served: false });
    expect(text).toContain('SW_TRACEQL_ENABLE_DATASOURCE_OTLP');
    expect(text).toContain('oap.traceql.otlpPath');
    expect(text).not.toContain('No trace with that id.');
  });

  it('names a source Horizon has no TraceQL address for', async () => {
    const text = await open({ reachable: false, notFound: false, configured: false });
    expect(text).toContain('oap.traceql');
  });

  it('re-reads a trace the store has no record of yet, and says it is looking', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      api.trace.mockResolvedValueOnce({ ds: 'otlp', traceId: 'trace', spans: [], reachable: true, notFound: true });
      const text = await open({ reachable: true, notFound: false, spans: [{ spanId: 's' }] });
      expect(text).toContain('No spans yet');
      await vi.advanceTimersByTimeAsync(3_000);
      await flushPromises();
      expect(api.trace).toHaveBeenCalledTimes(2);
      expect(wrapper!.text()).not.toContain('No spans yet');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not re-read a store that is missing', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      await open({ reachable: false, notFound: false, served: false });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(api.trace).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
