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
import { mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import type { RecordTrace } from '@skywalking-horizon-ui/api-client';
import { i18n } from '@/i18n';
import RecordList from './RecordList.vue';

const openNative = vi.fn();
const openZipkin = vi.fn();
const openTraceQL = vi.fn();
vi.mock('@/layer/traces/useTracePopout', () => ({ useTracePopout: () => ({ openTrace: openNative }) }));
vi.mock('@/layer/traces/useZipkinTracePopout', () => ({ useZipkinTracePopout: () => ({ openTrace: openZipkin }) }));
vi.mock('@/layer/traceql/useTraceQLTracePopout', () => ({ useTraceQLTracePopout: () => ({ openTrace: openTraceQL }) }));

const Blank = { template: '<div />' };

async function mountAt(path: string, trace?: RecordTrace) {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: Blank },
      { path: '/layer/:layerKey', component: Blank, children: [{ path: ':row', component: Blank }] },
    ],
  });
  await router.push(path);
  await router.isReady();
  return mount(RecordList, {
    props: {
      items: [
        { name: 'SELECT 1', value: 250, traceId: 'abc123' },
        { name: 'SELECT 2', value: 210 },
      ],
      unit: 'ms',
      trace,
    },
    global: { plugins: [router, i18n] },
  });
}

describe('RecordList — trace icon', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    openNative.mockClear();
    openZipkin.mockClear();
    openTraceQL.mockClear();
  });

  it('draws the icon only on a row that carries a trace id', async () => {
    const w = await mountAt('/');
    const rows = w.findAll('.rec-row');
    expect(rows[0].find('.rec-trace').exists()).toBe(true);
    expect(rows[1].find('.rec-trace').exists()).toBe(false);
  });

  it('opens the native popout when the widget names no store', async () => {
    const w = await mountAt('/');
    await w.find('.rec-trace').trigger('click');
    expect(openNative).toHaveBeenCalledWith('abc123');
    expect(openZipkin).not.toHaveBeenCalled();
  });

  it('forces the native popout when the widget names the native store', async () => {
    const w = await mountAt('/', { source: 'native' });
    await w.find('.rec-trace').trigger('click');
    expect(openNative).toHaveBeenCalledWith('abc123', undefined, 'SKYWALKING_NATIVE');
  });

  it('opens the Zipkin popout for the zipkin store', async () => {
    const w = await mountAt('/', { source: 'zipkin' });
    await w.find('.rec-trace').trigger('click');
    expect(openZipkin).toHaveBeenCalledWith('abc123');
    expect(openNative).not.toHaveBeenCalled();
  });

  it.each([
    ['traceql-otlp', 'otlp'],
    ['traceql-zipkin', 'zipkin'],
    ['traceql-native', 'native'],
  ] as const)('opens the %s store in the TraceQL popout over the page', async (source, ds) => {
    const w = await mountAt('/layer/otlp_virtual_database/service', { source });
    await w.find('.rec-trace').trigger('click');
    expect(openTraceQL).toHaveBeenCalledWith('abc123', ds);
    expect(openNative).not.toHaveBeenCalled();
    expect(openZipkin).not.toHaveBeenCalled();
  });
});
