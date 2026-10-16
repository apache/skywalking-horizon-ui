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
import TraceQLWaterfall from './TraceQLWaterfall.vue';
import TraceQLDetailCard from './TraceQLDetailCard.vue';

const span: TraceQLSpan = {
  spanId: 'judged', parentSpanId: '', service: 'app', resourceAttributes: [], name: 'chat', kind: 'SPAN_KIND_CLIENT',
  startUs: 1000, durationUs: 100, status: 'ok', attributes: [], events: [],
};
describe('TraceQL result span focus', () => {
  it('selects the judged span when it arrives and clears the selection for another trace', async () => {
    const wrapper = mount(TraceQLDetailCard, {
      props: { ds: 'otlp', traceId: 'trace', spans: [], focusSpanId: 'judged' },
      global: { plugins: [i18n], stubs: {
        TraceQLWaterfall: { props: ['selectedSpan'], template: '<div class="waterfall" />' },
        TraceQLTreeView: true, TraceQLStatsView: true, TraceQLSpanModal: true,
      } },
    });
    expect(wrapper.getComponent(TraceQLWaterfall).props('selectedSpan')).toBeNull();
    await wrapper.setProps({ spans: [span] });
    expect(wrapper.getComponent(TraceQLWaterfall).props('selectedSpan')).toEqual(span);
    await wrapper.setProps({ focusSpanId: undefined });
    expect(wrapper.getComponent(TraceQLWaterfall).props('selectedSpan')).toBeNull();
    await wrapper.setProps({ traceId: 'another', spans: [] });
    expect(wrapper.getComponent(TraceQLWaterfall).props('selectedSpan')).toBeNull();
    wrapper.unmount();
  });
});
