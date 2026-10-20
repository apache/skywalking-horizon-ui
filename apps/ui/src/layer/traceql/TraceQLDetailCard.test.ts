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

import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import type { TraceQLSpan } from '@skywalking-horizon-ui/api-client';
import { i18n } from '@/i18n';
import TraceQLDetailCard from './TraceQLDetailCard.vue';
import TraceQLSpanModal from './TraceQLSpanModal.vue';

function span(spanId: string): TraceQLSpan {
  return {
    spanId, parentSpanId: '', service: 'app', resourceAttributes: [], name: 'chat', kind: 'SPAN_KIND_CLIENT',
    startUs: 1000, durationUs: 100, status: 'ok', attributes: [], events: [],
  };
}

function mountCard(props: { traceId: string; spans: TraceQLSpan[]; focusSpanId?: string | null }) {
  return mount(TraceQLDetailCard, {
    props: { ds: 'otlp', ...props },
    global: {
      plugins: [i18n],
      stubs: { TraceQLWaterfall: true, TraceQLTreeView: true, TraceQLStatsView: true, TraceQLSpanModal: { props: ['span'], template: '<div class="modal" />' } },
    },
  });
}

describe('TraceQL detail card span focus', () => {
  it('selects the named span once the spans land', async () => {
    const wrapper = mountCard({ traceId: 'trace', spans: [], focusSpanId: 'judged' });
    expect(wrapper.findComponent(TraceQLSpanModal).exists()).toBe(false);
    await wrapper.setProps({ spans: [span('other'), span('judged')] });
    expect(wrapper.getComponent(TraceQLSpanModal).props('span')).toMatchObject({ spanId: 'judged' });
    wrapper.unmount();
  });

  it('does not reopen a span the operator closed when the same trace is read again', async () => {
    const wrapper = mountCard({ traceId: 'trace', spans: [span('judged')], focusSpanId: 'judged' });
    wrapper.getComponent(TraceQLSpanModal).vm.$emit('close');
    await wrapper.vm.$nextTick();
    expect(wrapper.findComponent(TraceQLSpanModal).exists()).toBe(false);
    await wrapper.setProps({ spans: [span('judged')] });
    expect(wrapper.findComponent(TraceQLSpanModal).exists()).toBe(false);
    wrapper.unmount();
  });

  it('selects the named span of another trace opened in its place', async () => {
    const wrapper = mountCard({ traceId: 'trace-1', spans: [span('a')], focusSpanId: 'a' });
    await wrapper.setProps({ traceId: 'trace-2', spans: [span('b')], focusSpanId: 'b' });
    expect(wrapper.getComponent(TraceQLSpanModal).props('span')).toMatchObject({ spanId: 'b' });
    wrapper.unmount();
  });
});
