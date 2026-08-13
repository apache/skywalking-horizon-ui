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
 * The Zipkin Traces tab shows two counts, and they answer different questions.
 *
 * Zipkin's list endpoint reports no total and takes no offset, so the only
 * "there is more" signal is the over-fetch, and the number beside it has to be
 * the size of the FETCHED set — that is what the limit capped. Brushing the
 * distribution filters the list in-page without re-querying, so the two numbers
 * separate exactly when an operator is brushing: the count says how many rows
 * they are looking at, the capped hint still says what the query returned.
 * Reading the filtered number as "capped at 2" would send them narrowing a
 * window that was never the problem.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter, type Router } from 'vue-router';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import type { ZipkinTraceListRow } from '@skywalking-horizon-ui/api-client';
import { i18n } from '@/i18n';
import TraceDistribution from '@/render/widgets/TraceDistribution.vue';
import LayerZipkinTracesView from './LayerZipkinTracesView.vue';

const LAYER = 'mesh';
const FETCHED = 30;

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** Zipkin reports microseconds; the row adapter divides by 1000. */
function zipkinRow(i: number): ZipkinTraceListRow {
  return {
    traceId: `trace-${i}`,
    rootName: `/checkout/${i}`,
    rootService: 'gateway',
    timestamp: (Date.now() - i * 1000) * 1000,
    duration: (i + 1) * 1000,
    spanCount: 2,
    errorCount: 0,
  };
}

/** A Zipkin source that returns a full page AND reports the cap — the state
 *  where the hint is rendered at all. */
function fakeBff() {
  const fetchSpy = vi.fn(async (input: string | URL | Request) => {
    const path = new URL(String(input), 'http://ui').pathname;
    if (path === '/api/zipkin/traces') {
      return jsonResponse({
        source: 'zipkin',
        traces: Array.from({ length: FETCHED }, (_, i) => zipkinRow(i)),
        hasNext: true,
        reachable: true,
      });
    }
    // Autocomplete lists — the toolbar's dropdowns, empty is fine.
    return jsonResponse([]);
  });
  return { fetchSpy };
}

let router: Router;
let wrapper: VueWrapper | null = null;

async function mountZipkinTab(): Promise<VueWrapper> {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const w = mount(LayerZipkinTracesView, {
    props: { layerKey: LAYER },
    global: { plugins: [router, i18n, [VueQueryPlugin, { queryClient }]] },
  });
  await flushPromises();
  await w.get('.ztr-run-btn').trigger('click');
  await flushPromises();
  wrapper = w;
  return w;
}

/** The two hints in the results header, in render order. */
function listHints(w: VueWrapper): string[] {
  return w.findAll('.ztr-list-head .hint').map((h) => h.text());
}

beforeEach(async () => {
  setActivePinia(createPinia());
  const bff = fakeBff();
  vi.stubGlobal('fetch', bff.fetchSpy);
  router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div />' } }],
  });
  await router.push(`/layer/${LAYER}/traces`);
  await router.isReady();
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  vi.unstubAllGlobals();
});

describe('Zipkin Traces — the capped hint counts what the query returned', () => {
  it('reports the fetched set on an unfiltered list', async () => {
    const w = await mountZipkinTab();
    expect(listHints(w)).toEqual([`${FETCHED} traces`, `capped at ${FETCHED} — narrow the window`]);
  });

  it('keeps that number while a scatter brush filters the list under it', async () => {
    const w = await mountZipkinTab();
    // Brushing a box over two dots narrows the list in-page; no query fires,
    // so the cap the query hit has not changed.
    w.findComponent(TraceDistribution).vm.$emit('brush', ['trace-1', 'trace-2']);
    await flushPromises();

    expect(w.text()).toContain('2 picked');
    expect(listHints(w)).toEqual(['2 traces', `capped at ${FETCHED} — narrow the window`]);
  });

  it('says nothing about a cap when Zipkin returned everything it had', async () => {
    vi.unstubAllGlobals();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const path = new URL(String(input), 'http://ui').pathname;
        if (path === '/api/zipkin/traces') {
          return jsonResponse({
            source: 'zipkin',
            traces: [zipkinRow(0)],
            hasNext: false,
            reachable: true,
          });
        }
        return jsonResponse([]);
      }),
    );
    const w = await mountZipkinTab();
    expect(listHints(w)).toEqual(['1 traces']);
  });
});
