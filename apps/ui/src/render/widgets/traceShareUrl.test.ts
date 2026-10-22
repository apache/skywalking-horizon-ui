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
import { flushPromises, mount } from '@vue/test-utils';
import { i18n } from '@/i18n';
import TraceDetailCard from './TraceDetailCard.vue';
import ZipkinTraceDetailCard from './ZipkinTraceDetailCard.vue';

const clipboard = vi.hoisted(() => ({ copyText: vi.fn(async (_text: string) => true) }));
vi.mock('@/utils/clipboard', () => clipboard);

afterEach(() => { vi.clearAllMocks(); window.history.replaceState({}, '', '/'); });

/** The query of the URL the card's ⧉ url button copied, on a page at `at`. */
async function copiedQuery(component: object, props: Record<string, unknown>, at: string): Promise<Record<string, string>> {
  window.history.replaceState({}, '', at);
  const wrapper = mount(component, {
    props,
    global: { plugins: [i18n], stubs: { TraceWaterfallView: true, TraceTreeView: true, TraceStatsView: true } },
  });
  await wrapper.get('button[title="Copy shareable URL"]').trigger('click');
  await flushPromises();
  wrapper.unmount();
  const copied = clipboard.copyText.mock.lastCall?.[0];
  if (!copied) throw new Error('nothing copied');
  return Object.fromEntries(new URL(copied).searchParams);
}

describe('a trace card\'s shareable URL names the trace source that reads it', () => {
  it('native: traceType=native, no source', async () => {
    const q = await copiedQuery(TraceDetailCard, { spans: [], traceId: 'n1', traceIds: [] }, '/operate/trace-inspect?service=a');
    expect(q).toEqual({ service: 'a', traceId: 'n1', traceType: 'native' });
  });

  it('Zipkin: traceType=zipkin, no source', async () => {
    const q = await copiedQuery(ZipkinTraceDetailCard, { spans: [], traceId: 'z1' }, '/operate/trace-inspect?service=a');
    expect(q).toEqual({ service: 'a', traceId: 'z1', traceType: 'zipkin' });
  });
});
