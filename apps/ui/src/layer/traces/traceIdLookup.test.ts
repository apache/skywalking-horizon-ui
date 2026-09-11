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
 * The Traces tab's Trace ID mode looks one trace up by its id. The switch above
 * the conditions trades the filter for the id and a time range, which may be
 * none; Run query — and nothing else — reads the id within that range, with no
 * service and no other condition, and the filter keeps its values for the way
 * back.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter, type Router } from 'vue-router';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import type { NativeTraceListRow } from '@/api/client';
import { i18n } from '@/i18n';
import { useLayerSelectionStore } from '@/state/layerSelection';
import { useColdStageStore } from '@/controls/coldStage';
import LayerTracesView from './LayerTracesView.vue';

const SONGS = { id: 'bWVzaC1zdnI6OnNvbmdz.1', name: 'songs' };
const ROW: NativeTraceListRow = {
  key: 'checkout-row',
  segmentId: 'checkout-segment',
  endpointNames: ['/songs/checkout'],
  duration: 42,
  start: String(Date.now()),
  isError: false,
  traceIds: ['abc.1.2'],
};

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
}

/** A BFF with one service in the layer and a trace list that answers `rows`,
 *  recording each list read's body. */
function fakeBff(rows: NativeTraceListRow[] = [ROW]) {
  const listReads: Array<Record<string, unknown>> = [];
  const fetchSpy = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input), 'http://ui').pathname;
    if (path.endsWith('/landing')) {
      return jsonResponse({ rows: [], sampledRows: [{ serviceId: SONGS.id, serviceName: SONGS.name, metrics: {} }], reachable: true, generatedAt: 0 });
    }
    if (path.endsWith('/services')) {
      return jsonResponse({ services: [{ id: SONGS.id, name: SONGS.name, normal: true, group: '' }], reachable: true });
    }
    if (path.endsWith('/traces')) {
      listReads.push(typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {});
      return jsonResponse({ generatedAt: 0, source: 'native', native: { source: 'native', api: 'queryTraces', traces: rows, hasNext: false, reachable: true } });
    }
    return jsonResponse({});
  });
  return { fetchSpy, listReads };
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

async function switchTo(w: VueWrapper, mode: 'Filter' | 'Trace ID'): Promise<void> {
  const button = w.findAll('.tr-toolbar-head .seg button').find((b) => b.text() === mode);
  if (!button) throw new Error(`the tab has no ${mode} switch`);
  await button.trigger('click');
  await flushPromises();
}

function idInput(w: VueWrapper) {
  return w.get('.tr-conditions input[placeholder="paste trace id…"]');
}

/** In Trace ID mode the time range is the one select left. */
function timeSelect(w: VueWrapper) {
  return w.get('.tr-conditions select');
}

/** The Status select, found by a choice only it has. */
function statusSelect(w: VueWrapper) {
  return w.findAll('select').find((s) => s.find('option[value="ERROR"]').exists());
}

async function run(w: VueWrapper): Promise<void> {
  await w.get('.tr-run-btn').trigger('click');
  await flushPromises();
}

/** A `datetime-local` value, `hoursAgo` before now. */
function localDt(hoursAgo: number): string {
  const d = new Date(Date.now() - hoursAgo * 3600_000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

beforeEach(async () => {
  pinia = createPinia();
  setActivePinia(pinia);
  router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div />' } }] });
  await router.push('/layer/mesh/trace');
  await router.isReady();
  useLayerSelectionStore().setService(SONGS.id);
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('Traces tab — the Trace ID mode looks a trace up by its id', () => {
  it('trades the filter for the id and a time range, and keeps the filter for the way back', async () => {
    const bff = fakeBff();
    vi.stubGlobal('fetch', bff.fetchSpy);
    const w = await mountTracesTab();
    await statusSelect(w)!.setValue('ERROR');

    await switchTo(w, 'Trace ID');
    expect(statusSelect(w)).toBeUndefined();
    expect(w.findAll('.tr-conditions .tas__trigger')).toHaveLength(0);
    expect(w.find('.tr-conditions input[placeholder="paste trace id…"]').exists()).toBe(true);
    expect((timeSelect(w).element as HTMLSelectElement).value).toBe('0');
    expect(timeSelect(w).findAll('option')[0]!.text()).toBe('No time range');

    await switchTo(w, 'Filter');
    expect(statusSelect(w)!.element.value).toBe('ERROR');
    expect(w.find('.tr-conditions input[placeholder="paste trace id…"]').exists()).toBe(false);
  });

  it('refuses to run without an id, and asks nothing', async () => {
    const bff = fakeBff();
    vi.stubGlobal('fetch', bff.fetchSpy);
    const w = await mountTracesTab();
    await switchTo(w, 'Trace ID');

    await run(w);

    expect(w.text()).toContain('Enter a trace ID to look up.');
    expect(bff.listReads).toEqual([]);
  });

  it('reads the id with no window when no time range is picked — no service, no other condition', async () => {
    const bff = fakeBff();
    vi.stubGlobal('fetch', bff.fetchSpy);
    const w = await mountTracesTab();
    // Staged in the filter before the switch; none of it may ride along.
    await statusSelect(w)!.setValue('ERROR');
    await w.get('input[placeholder="min"]').setValue('250');
    await switchTo(w, 'Trace ID');

    await idInput(w).setValue('abc.1.2');
    await run(w);

    expect(bff.listReads).toHaveLength(1);
    const body = bff.listReads[0]!;
    expect(body).toMatchObject({ traceId: 'abc.1.2', traceState: 'ALL' });
    for (const absent of ['serviceId', 'service', 'windowMinutes', 'startMs', 'endMs', 'instanceId', 'endpointId', 'tags', 'minTraceDuration', 'maxTraceDuration']) {
      expect(body).not.toHaveProperty(absent);
    }
    expect(w.text()).toContain('/songs/checkout');
  });

  it('bounds the lookup with the time range when one is picked', async () => {
    const bff = fakeBff();
    vi.stubGlobal('fetch', bff.fetchSpy);
    const w = await mountTracesTab();
    await switchTo(w, 'Trace ID');

    await timeSelect(w).setValue('60');
    await idInput(w).setValue('abc.1.2');
    await run(w);

    expect(bff.listReads[0]).toMatchObject({ traceId: 'abc.1.2', windowMinutes: 60 });
    expect(bff.listReads[0]).not.toHaveProperty('serviceId');
  });

  it('runs only from Run query — not on Enter, not on a switch of mode', async () => {
    const bff = fakeBff();
    vi.stubGlobal('fetch', bff.fetchSpy);
    const w = await mountTracesTab();
    await switchTo(w, 'Trace ID');
    await idInput(w).setValue('abc.1.2');
    await idInput(w).trigger('keydown', { key: 'Enter' });
    await idInput(w).trigger('keyup', { key: 'Enter' });
    await switchTo(w, 'Filter');
    await switchTo(w, 'Trace ID');
    expect(bff.listReads).toEqual([]);

    await run(w);
    expect(bff.listReads).toHaveLength(1);
  });

  it('reads the filter again, with the header\'s service, once switched back — and keeps the id', async () => {
    const bff = fakeBff();
    vi.stubGlobal('fetch', bff.fetchSpy);
    const w = await mountTracesTab();
    await switchTo(w, 'Trace ID');
    await idInput(w).setValue('abc.1.2');
    await run(w);

    await switchTo(w, 'Filter');
    await run(w);

    const body = bff.listReads[bff.listReads.length - 1]!;
    expect(body).not.toHaveProperty('traceId');
    expect(body).toMatchObject({ windowMinutes: 30, serviceId: SONGS.id });
    await switchTo(w, 'Trace ID');
    expect((idInput(w).element as HTMLInputElement).value).toBe('abc.1.2');
  });

  it('needs no service from the header', async () => {
    const bff = fakeBff();
    vi.stubGlobal('fetch', bff.fetchSpy);
    useLayerSelectionStore().setService('not-in-this-layer.1');
    const w = await mountTracesTab();
    expect((w.get('.tr-run-btn').element as HTMLButtonElement).disabled).toBe(true);

    await switchTo(w, 'Trace ID');
    expect((w.get('.tr-run-btn').element as HTMLButtonElement).disabled).toBe(false);
    await idInput(w).setValue('abc.1.2');
    await run(w);

    expect(bff.listReads).toHaveLength(1);
    expect(w.text()).toContain('/songs/checkout');
  });

  it('says so when no trace has the id, and suggests widening a picked time range', async () => {
    const bff = fakeBff([]);
    vi.stubGlobal('fetch', bff.fetchSpy);
    const w = await mountTracesTab();
    await switchTo(w, 'Trace ID');
    await idInput(w).setValue('abc.1.2');
    await run(w);

    expect(w.text()).toContain('No trace found for this ID.');
    expect(w.text()).not.toContain('Widen the time range');

    await timeSelect(w).setValue('15');
    await run(w);
    expect(w.text()).toContain('Widen the time range, or pick No time range.');
  });

  it('keeps a finished lookup when the header\'s service switches — the lookup read no service', async () => {
    const bff = fakeBff();
    vi.stubGlobal('fetch', bff.fetchSpy);
    const w = await mountTracesTab();
    await switchTo(w, 'Trace ID');
    await idInput(w).setValue('abc.1.2');
    await run(w);
    await w.get('.tr-row-card').trigger('click');
    await flushPromises();
    expect(w.find('.tr-detail').exists()).toBe(true);

    useLayerSelectionStore().setService('not-in-this-layer.1');
    await flushPromises();

    expect(w.find('.tr-detail').exists()).toBe(true);
    expect(w.text()).not.toContain('Pick your conditions, then click Run query.');
    expect(bff.listReads).toHaveLength(1);
  });

  it('keeps each mode\'s custom range apart', async () => {
    const bff = fakeBff();
    vi.stubGlobal('fetch', bff.fetchSpy);
    const w = await mountTracesTab();
    const bounds = () => w.findAll('.tr-conditions input[type="datetime-local"]');
    const customChoice = () => w.findAll('.tr-conditions select').find((s) => s.find('option[value="-1"]').exists())!;
    const [filterFrom, filterTo, idFrom, idTo] = [localDt(3), localDt(2), localDt(48), localDt(47)];
    await customChoice().setValue('-1');
    await bounds()[0]!.setValue(filterFrom);
    await bounds()[1]!.setValue(filterTo);

    await switchTo(w, 'Trace ID');
    await customChoice().setValue('-1');
    await bounds()[0]!.setValue(idFrom);
    await bounds()[1]!.setValue(idTo);

    await switchTo(w, 'Filter');
    expect(bounds().map((b) => (b.element as HTMLInputElement).value)).toEqual([filterFrom, filterTo]);
    await run(w);
    expect(bff.listReads[0]).toMatchObject({ startMs: new Date(filterFrom).getTime(), endMs: new Date(filterTo).getTime() });

    await switchTo(w, 'Trace ID');
    expect(bounds().map((b) => (b.element as HTMLInputElement).value)).toEqual([idFrom, idTo]);
  });

  it('says the cold stage is not searched while the Cold pill is on and no time range is picked', async () => {
    const bff = fakeBff();
    vi.stubGlobal('fetch', bff.fetchSpy);
    const w = await mountTracesTab();
    await switchTo(w, 'Trace ID');
    expect(w.text()).not.toContain('The cold stage is not searched');

    useColdStageStore().set(true);
    await flushPromises();
    expect(w.text()).toContain('The cold stage is not searched: it can only be read within a time range.');

    await timeSelect(w).setValue('60');
    await flushPromises();
    expect(w.text()).not.toContain('The cold stage is not searched');
  });
});
