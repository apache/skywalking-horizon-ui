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
 * Cascade-clear on the Traces tab. The committed query snapshot and everything
 * it produced belong to ONE service, so a service switch must reset the tab to
 * its Run-query prompt: a list, an open waterfall, or a distribution pick left
 * over from the previous service reads as the new service's data.
 *
 * The view is MOUNTED rather than its composable called, because the state that
 * can go stale (committed refs, the query gate, the selection) lives in the
 * view.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter, type Router } from 'vue-router';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import type { NativeTraceListRow } from '@/api/client';
import { i18n } from '@/i18n';
import { useLayerSelectionStore } from '@/state/layerSelection';
import TraceDistribution from '@/render/widgets/TraceDistribution.vue';
import LayerTracesView from './LayerTracesView.vue';

const SONGS = { id: 'bWVzaC1zdnI6OnNvbmdz.1', name: 'songs' };
const GATEWAY = { id: 'bWVzaC1zdnI6OmdhdGV3YXk.1', name: 'gateway' };
const RUN = '.tr-run-btn';
const PROMPT = 'Pick your conditions, then click Run query.';

/** One row per service, named after the service that asked for it — so the
 *  rendered endpoint name says whose result set is on screen. */
function traceRow(service: string): NativeTraceListRow {
  return {
    key: `${service}-row`,
    segmentId: `${service}-segment`,
    endpointNames: [`/${service}/checkout`],
    duration: 42,
    start: String(Date.now()),
    isError: false,
    traceIds: [`${service}-trace`],
  };
}

/** One request the tab made: what it asked for, and with which body. */
interface Asked {
  url: string;
  body: Record<string, unknown>;
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** A BFF whose landing sample carries BOTH services, so each id resolves to a
 *  name the moment it is picked — the switch, not the resolution, is under test. */
function fakeBff() {
  const asked: Asked[] = [];
  const fetchSpy = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    let body: Record<string, unknown> = {};
    if (typeof init?.body === 'string') body = JSON.parse(init.body) as Record<string, unknown>;
    asked.push({ url, body });
    const path = new URL(url, 'http://ui').pathname;
    if (path.endsWith('/landing')) {
      return jsonResponse({
        rows: [],
        sampledRows: [SONGS, GATEWAY].map((s) => ({
          serviceId: s.id,
          serviceName: s.name,
          metrics: {},
        })),
        reachable: true,
        generatedAt: 0,
      });
    }
    if (path.endsWith('/services')) {
      return jsonResponse({
        services: [SONGS, GATEWAY].map((s) => ({ id: s.id, name: s.name, normal: true, group: '' })),
        reachable: true,
      });
    }
    if (path.endsWith('/traces')) {
      const service = typeof body.service === 'string' ? body.service : '';
      return jsonResponse({
        generatedAt: 0,
        source: 'native',
        native: {
          source: 'native',
          api: 'queryBasicTraces',
          traces: [traceRow(service)],
          reachable: true,
        },
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
    to(suffix: string): Asked[] {
      return asked.filter((a) => new URL(a.url, 'http://ui').pathname.endsWith(suffix));
    },
  };
}

let router: Router;
let pinia: ReturnType<typeof createPinia>;

async function mountTracesTab(): Promise<VueWrapper> {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const w = mount(LayerTracesView, {
    props: { layerKey: 'mesh' },
    global: { plugins: [pinia, router, i18n, [VueQueryPlugin, { queryClient }]] },
  });
  await flushPromises();
  return w;
}

async function runQuery(w: VueWrapper): Promise<void> {
  await w.get(RUN).trigger('click');
  await flushPromises();
}

/** Switch the picked service the way the layer header does — the tab stays
 *  mounted, only the selection changes underneath it. */
async function switchTo(service: { id: string }): Promise<void> {
  useLayerSelectionStore().setService(service.id);
  await flushPromises();
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
  vi.unstubAllGlobals();
});

describe('Traces tab — a service switch clears what the previous service produced', () => {
  it('drops the committed query and its result list, back to the Run-query prompt', async () => {
    const bff = fakeBff();
    vi.stubGlobal('fetch', bff.fetchSpy);
    const w = await mountTracesTab();

    await runQuery(w);
    expect(bff.to('/traces')).toHaveLength(1);
    expect(bff.to('/traces')[0]?.body.service).toBe(SONGS.name);
    expect(w.text()).toContain('/songs/checkout');

    const readsForSongs = bff.to('/traces').length;
    await switchTo(GATEWAY);

    expect(w.text()).not.toContain('/songs/checkout');
    expect(w.text()).toContain(PROMPT);
    // The switch stages; it never fires — least of all under the old service.
    expect(bff.to('/traces')).toHaveLength(readsForSongs);

    await runQuery(w);
    const reads = bff.to('/traces');
    expect(reads.length).toBeGreaterThan(readsForSongs);
    for (const r of reads.slice(readsForSongs)) expect(r.body.service).toBe(GATEWAY.name);
    expect(w.text()).toContain('/gateway/checkout');
  });

  it('closes the inline trace detail — the open waterfall is the old service\'s', async () => {
    const bff = fakeBff();
    vi.stubGlobal('fetch', bff.fetchSpy);
    const w = await mountTracesTab();

    await runQuery(w);
    await w.get('.tr-row-card').trigger('click');
    await flushPromises();
    expect(w.find('.tr-detail-split').exists()).toBe(true);

    await switchTo(GATEWAY);

    expect(w.find('.tr-detail-split').exists()).toBe(false);
    expect(w.text()).toContain(PROMPT);
  });

  it('drops the distribution pick, which would otherwise filter the new list to nothing', async () => {
    const bff = fakeBff();
    vi.stubGlobal('fetch', bff.fetchSpy);
    const w = await mountTracesTab();

    await runQuery(w);
    // Picking a dot filters the list in-page; the pick keys on the row it came from.
    w.findComponent(TraceDistribution).vm.$emit('select', traceRow(SONGS.name));
    await flushPromises();
    expect(w.text()).toContain('1 picked');

    await switchTo(GATEWAY);
    await runQuery(w);

    expect(w.text()).toContain('/gateway/checkout');
    expect(w.text()).not.toContain('No traces match the distribution selection.');
  });
});
