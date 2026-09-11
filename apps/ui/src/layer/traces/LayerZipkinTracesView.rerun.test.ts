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
 * Run query on the Zipkin Traces tab starts the reading over
 * (apache/skywalking#14055). The tab used to clear the open trace only when
 * some of the conditions changed, so a run that narrowed nothing but the
 * duration kept it — and with the trace gone from the new list, it was then
 * fetched by id and drawn beside an empty result as though it were the answer.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type DOMWrapper, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter, type Router } from 'vue-router';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import type { ZipkinTraceListRow } from '@skywalking-horizon-ui/api-client';
import { i18n } from '@/i18n';
import TraceDistribution from '@/render/widgets/TraceDistribution.vue';
import LayerZipkinTracesView from './LayerZipkinTracesView.vue';

const LAYER = 'mesh';
const EMPTY = 'No Zipkin traces in the selected window.';
const READING = 'Reading data…';

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** One trace as Zipkin's list ships it — spans inline, microseconds. */
function zipkinRow(i: number): ZipkinTraceListRow {
  const traceId = `trace-${i}`;
  const timestamp = (Date.now() - i * 1000) * 1000;
  const duration = (i + 1) * 1000;
  return {
    traceId,
    rootName: `/checkout/${i}`,
    rootService: 'gateway',
    timestamp,
    duration,
    spanCount: 1,
    errorCount: 0,
    spans: [{
      traceId,
      id: `span-${i}`,
      name: `/checkout/${i}`,
      kind: 'SERVER',
      timestamp,
      duration,
      localEndpoint: { serviceName: 'gateway' },
    }],
  };
}

/** A Zipkin source whose list answers from a queue, one answer per read, and
 *  which records every by-id lookup — the path that drew a stale trace. */
function fakeBff() {
  const answers: Array<Promise<ZipkinTraceListRow[]>> = [];
  const byIdReads: string[] = [];
  let listReads = 0;
  const fetchSpy = vi.fn(async (input: string | URL | Request) => {
    const path = new URL(String(input), 'http://ui').pathname;
    if (path === '/api/zipkin/traces') {
      listReads += 1;
      const traces = await (answers.shift() ?? Promise.resolve([]));
      return jsonResponse({ source: 'zipkin', traces, hasNext: false, reachable: true });
    }
    if (path.startsWith('/api/zipkin/trace/')) {
      const id = decodeURIComponent(path.slice('/api/zipkin/trace/'.length));
      byIdReads.push(id);
      // What OAP answers for a trace that exists: enough to draw it again.
      return jsonResponse({ source: 'zipkin', traceId: id, spans: zipkinRow(0).spans, reachable: true });
    }
    // Autocomplete lists — the toolbar's dropdowns, empty is fine.
    return jsonResponse([]);
  });
  return {
    fetchSpy,
    byIdReads,
    listReads: () => listReads,
    answer(rows: ZipkinTraceListRow[]): void {
      answers.push(Promise.resolve(rows));
    },
    /** Queue an answer that lands only when the returned function is called. */
    answerLater(): (rows: ZipkinTraceListRow[]) => void {
      let land: (rows: ZipkinTraceListRow[]) => void = () => {};
      answers.push(new Promise<ZipkinTraceListRow[]>((resolve) => { land = resolve; }));
      return land;
    },
  };
}

let router: Router;
let bff: ReturnType<typeof fakeBff>;
let wrapper: VueWrapper | null = null;

async function mountZipkinTab(): Promise<VueWrapper> {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  wrapper = mount(LayerZipkinTracesView, {
    props: { layerKey: LAYER },
    global: { plugins: [router, i18n, [VueQueryPlugin, { queryClient }]] },
  });
  await flushPromises();
  return wrapper;
}

async function runQuery(w: VueWrapper): Promise<void> {
  await w.get('.ztr-run-btn').trigger('click');
  await flushPromises();
}

/** Min duration (ms) — the first of the two duration inputs. */
function minDuration(w: VueWrapper): DOMWrapper<Element> {
  const input = w.findAll('input[type="number"]')[0];
  if (!input) throw new Error('the Min duration condition is not on the page');
  return input;
}

beforeEach(async () => {
  setActivePinia(createPinia());
  bff = fakeBff();
  vi.stubGlobal('fetch', bff.fetchSpy);
  router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div />' } }],
  });
  await router.push(`/layer/${LAYER}/trace`);
  await router.isReady();
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  vi.unstubAllGlobals();
});

describe('Zipkin Traces — Run query starts the reading over', () => {
  it('closes the open trace when a run that only narrows the duration finds nothing', async () => {
    const w = await mountZipkinTab();
    bff.answer([zipkinRow(0), zipkinRow(1)]);
    await runQuery(w);
    await w.get('.tr-row-card').trigger('click');
    await flushPromises();
    expect(w.find('.ztr-detail').exists()).toBe(true);

    await minDuration(w).setValue('60000');
    bff.answer([]);
    await runQuery(w);

    expect(bff.listReads()).toBe(2);
    expect(w.find('.ztr-detail').exists()).toBe(false);
    expect(w.text()).toContain(EMPTY);
    // Nothing went back for the old trace to draw it again.
    expect(bff.byIdReads).toEqual([]);
  });

  it('says it is reading while the run is out, not that the window is empty', async () => {
    const w = await mountZipkinTab();
    bff.answer([zipkinRow(0)]);
    await runQuery(w);
    await minDuration(w).setValue('60000');
    const land = bff.answerLater();
    await runQuery(w);

    expect(w.text()).toContain(READING);
    expect(w.text()).not.toContain(EMPTY);

    land([]);
    await flushPromises();
    expect(w.text()).not.toContain(READING);
    expect(w.text()).toContain(EMPTY);
  });

  it('drops the distribution pick, which keys on rows of the previous result', async () => {
    const w = await mountZipkinTab();
    bff.answer([zipkinRow(0), zipkinRow(1)]);
    await runQuery(w);
    w.findComponent(TraceDistribution).vm.$emit('brush', ['trace-1']);
    await flushPromises();
    expect(w.text()).toContain('1 picked');

    bff.answer([zipkinRow(0), zipkinRow(1)]);
    await runQuery(w);

    expect(w.text()).not.toContain('1 picked');
    expect(w.get('.ztr-list-head .hint').text()).toBe('2 traces');
  });
});
