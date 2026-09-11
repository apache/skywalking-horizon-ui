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
 * Run query on the Traces tab starts the reading over (apache/skywalking#14055).
 * The open trace and the distribution pick came from the previous result set:
 * left up, a run that finds nothing shows the old trace beside an empty list as
 * though it were the answer. Until the new answer lands, the list says it is
 * reading rather than that the window is empty.
 *
 * Mounted, as in serviceSwitch.test.ts, because the state that goes stale lives
 * in the view.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type DOMWrapper, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter, type Router } from 'vue-router';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import type { NativeTraceListRow } from '@/api/client';
import { i18n } from '@/i18n';
import { useLayerSelectionStore } from '@/state/layerSelection';
import TraceDistribution from '@/render/widgets/TraceDistribution.vue';
import LayerTracesView from './LayerTracesView.vue';

const SONGS = { id: 'bWVzaC1zdnI6OnNvbmdz.1', name: 'songs' };
const ROW: NativeTraceListRow = {
  key: 'checkout-row',
  segmentId: 'checkout-segment',
  endpointNames: ['/songs/checkout'],
  duration: 42,
  start: String(Date.now()),
  isError: false,
  traceIds: ['checkout-trace'],
};
const EMPTY = 'No traces in window.';
const READING = 'Reading data…';

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** A BFF whose trace list answers from a queue, one answer per read. An answer
 *  can be held back, to look at the page while its read is still out. */
function fakeBff() {
  const answers: Array<Promise<NativeTraceListRow[]>> = [];
  const listReads: Array<Record<string, unknown>> = [];
  const fetchSpy = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input), 'http://ui').pathname;
    if (path.endsWith('/landing')) {
      return jsonResponse({
        rows: [],
        sampledRows: [{ serviceId: SONGS.id, serviceName: SONGS.name, metrics: {} }],
        reachable: true,
        generatedAt: 0,
      });
    }
    if (path.endsWith('/services')) {
      return jsonResponse({
        services: [{ id: SONGS.id, name: SONGS.name, normal: true, group: '' }],
        reachable: true,
      });
    }
    if (path.endsWith('/traces')) {
      listReads.push(typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {});
      const traces = await (answers.shift() ?? Promise.resolve([]));
      return jsonResponse({
        generatedAt: 0,
        source: 'native',
        native: { source: 'native', api: 'queryBasicTraces', traces, reachable: true },
      });
    }
    if (path.startsWith('/api/trace/')) {
      return jsonResponse({
        generatedAt: 0,
        source: 'native',
        native: { source: 'native', spans: [], reachable: true },
      });
    }
    return jsonResponse({});
  });
  return {
    fetchSpy,
    listReads,
    answer(rows: NativeTraceListRow[]): void {
      answers.push(Promise.resolve(rows));
    },
    /** Queue an answer that lands only when the returned function is called. */
    answerLater(): (rows: NativeTraceListRow[]) => void {
      let land: (rows: NativeTraceListRow[]) => void = () => {};
      answers.push(new Promise<NativeTraceListRow[]>((resolve) => { land = resolve; }));
      return land;
    },
  };
}

let router: Router;
let pinia: ReturnType<typeof createPinia>;
let wrapper: VueWrapper | null = null;

async function mountTracesTab(): Promise<VueWrapper> {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  wrapper = mount(LayerTracesView, {
    props: { layerKey: 'mesh' },
    global: { plugins: [pinia, router, i18n, [VueQueryPlugin, { queryClient }]] },
  });
  await flushPromises();
  return wrapper;
}

async function runQuery(w: VueWrapper): Promise<void> {
  await w.get('.tr-run-btn').trigger('click');
  await flushPromises();
}

async function openFirstRow(w: VueWrapper): Promise<void> {
  await w.get('.tr-row-card').trigger('click');
  await flushPromises();
}

/** The Status condition — the one select that offers ERROR. */
function statusSelect(w: VueWrapper): DOMWrapper<HTMLSelectElement> {
  const select = w.findAll('select').find((s) => s.find('option[value="ERROR"]').exists());
  if (!select) throw new Error('the Status condition is not on the page');
  return select;
}

beforeEach(async () => {
  pinia = createPinia();
  setActivePinia(pinia);
  router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div />' } }],
  });
  await router.push('/layer/mesh/trace');
  await router.isReady();
  useLayerSelectionStore().setService(SONGS.id);
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  vi.unstubAllGlobals();
});

describe('Traces tab — Run query starts the reading over', () => {
  it('closes the open trace when the new run finds nothing', async () => {
    const bff = fakeBff();
    vi.stubGlobal('fetch', bff.fetchSpy);
    const w = await mountTracesTab();

    bff.answer([ROW]);
    await runQuery(w);
    await openFirstRow(w);
    expect(w.find('.tr-detail').exists()).toBe(true);

    // The report's case: narrow to errors, which this window has none of.
    await statusSelect(w).setValue('ERROR');
    bff.answer([]);
    await runQuery(w);

    expect(bff.listReads[bff.listReads.length - 1]?.traceState).toBe('ERROR');
    expect(w.find('.tr-detail').exists()).toBe(false);
    expect(w.find('.tr-detail-split').exists()).toBe(false);
    expect(w.text()).toContain(EMPTY);
  });

  it('closes it even when the new result still holds the same trace', async () => {
    // The open trace answered the previous question; a run asks again, so it
    // starts from the list rather than guessing which selection still applies.
    const bff = fakeBff();
    vi.stubGlobal('fetch', bff.fetchSpy);
    const w = await mountTracesTab();

    bff.answer([ROW]);
    await runQuery(w);
    await openFirstRow(w);
    bff.answer([ROW]);
    await runQuery(w);

    expect(bff.listReads).toHaveLength(2);
    expect(w.find('.tr-detail').exists()).toBe(false);
    expect(w.text()).toContain('/songs/checkout');
  });

  it('drops the distribution pick, which keys on rows of the previous result', async () => {
    const bff = fakeBff();
    vi.stubGlobal('fetch', bff.fetchSpy);
    const w = await mountTracesTab();

    bff.answer([ROW]);
    await runQuery(w);
    w.findComponent(TraceDistribution).vm.$emit('select', ROW);
    await flushPromises();
    expect(w.text()).toContain('1 picked');

    bff.answer([ROW]);
    await runQuery(w);

    expect(w.text()).not.toContain('1 picked');
    expect(w.text()).toContain('/songs/checkout');
  });

  it('says it is reading while the run is out, not that the window is empty', async () => {
    const bff = fakeBff();
    vi.stubGlobal('fetch', bff.fetchSpy);
    const w = await mountTracesTab();

    bff.answer([ROW]);
    await runQuery(w);
    await statusSelect(w).setValue('ERROR');
    const land = bff.answerLater();
    await runQuery(w);

    expect(w.text()).toContain(READING);
    expect(w.text()).not.toContain(EMPTY);
    expect(w.text()).not.toContain('/songs/checkout');

    land([]);
    await flushPromises();
    expect(w.text()).not.toContain(READING);
    expect(w.text()).toContain(EMPTY);
  });
});
