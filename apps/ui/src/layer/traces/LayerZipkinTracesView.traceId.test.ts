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
 * The Zipkin Traces tab's Trace ID mode looks traces up by id. Each id is
 * locked in with Enter, spelled the way OAP looks it up; Run query — never
 * Enter — reads all of them in one request, within the time range when one is
 * picked, and names the ids OAP returned nothing for. It replaces an "Open
 * trace ID" field that Run query ignored and Enter turned into a popout.
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

const FOUND = '463ac35c9f6413ad';

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
}

// Fixed, so the same lookup gets the same answer and the query keeps its data.
const T0 = (Date.now() - 60_000) * 1000;

function zipkinRow(traceId: string): ZipkinTraceListRow {
  const timestamp = T0;
  return {
    traceId,
    rootName: '/checkout',
    rootService: 'gateway',
    timestamp,
    duration: 4000,
    spanCount: 1,
    errorCount: 0,
    spans: [{ traceId, id: 'aaaaaaaaaaaaaaaa', name: '/checkout', kind: 'SERVER', timestamp, duration: 4000, localEndpoint: { serviceName: 'gateway' } }],
  };
}

/** A Zipkin source that finds FOUND and nothing else, recording each list read. */
function fakeBff() {
  const listReads: URLSearchParams[] = [];
  const fetchSpy = vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input), 'http://ui');
    if (url.pathname === '/api/zipkin/traces') {
      listReads.push(url.searchParams);
      const asked = (url.searchParams.get('traceIds') ?? '').split(',').filter(Boolean);
      return jsonResponse({
        source: 'zipkin',
        traces: asked.includes(FOUND) ? [zipkinRow(FOUND)] : [],
        hasNext: false,
        reachable: true,
        ...(asked.some((id) => id !== FOUND) ? { missingTraceIds: asked.filter((id) => id !== FOUND) } : {}),
      });
    }
    return jsonResponse([]);
  });
  return { fetchSpy, listReads };
}

let router: Router;
let bff: ReturnType<typeof fakeBff>;
let wrapper: VueWrapper | null = null;

async function mountZipkinTab(): Promise<VueWrapper> {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  wrapper = mount(LayerZipkinTracesView, {
    props: { layerKey: 'mesh' },
    global: { plugins: [router, i18n, [VueQueryPlugin, { queryClient }]] },
  });
  await flushPromises();
  return wrapper;
}

async function switchTo(w: VueWrapper, mode: 'Filter' | 'Trace ID'): Promise<void> {
  const button = w.findAll('.ztr-head .seg button').find((b) => b.text() === mode);
  if (!button) throw new Error(`the tab has no ${mode} switch`);
  await button.trigger('click');
  await flushPromises();
}

function chipInput(w: VueWrapper) {
  return w.get('.chi__input');
}

async function lock(w: VueWrapper, value: string): Promise<void> {
  await chipInput(w).setValue(value);
  await chipInput(w).trigger('keydown', { key: 'Enter' });
  await flushPromises();
}

async function run(w: VueWrapper): Promise<void> {
  await w.get('.ztr-run-btn').trigger('click');
  await flushPromises();
}

/** A `datetime-local` value, `hoursAgo` before now. */
function localDt(hoursAgo: number): string {
  const d = new Date(Date.now() - hoursAgo * 3600_000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

beforeEach(async () => {
  setActivePinia(createPinia());
  bff = fakeBff();
  vi.stubGlobal('fetch', bff.fetchSpy);
  router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div />' } }] });
  await router.push('/layer/mesh/trace');
  await router.isReady();
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  vi.unstubAllGlobals();
});

describe('Zipkin Traces — the Trace ID mode reads traces by id', () => {
  it('locks each id in with Enter, spelled the way OAP looks it up', async () => {
    const w = await mountZipkinTab();
    await switchTo(w, 'Trace ID');
    await lock(w, 'ABC');
    await lock(w, FOUND);

    expect(w.findAll('.chi__chip').map((c) => c.text().replace('×', '').trim())).toEqual(['0000000000000abc', FOUND]);
  });

  it('reads every locked id on Run query, in one request that carries nothing else, and names the ones not found', async () => {
    const w = await mountZipkinTab();
    await switchTo(w, 'Trace ID');
    await lock(w, 'abc');
    await lock(w, FOUND);
    // Enter on an empty field runs nothing.
    await chipInput(w).trigger('keydown', { key: 'Enter' });
    await flushPromises();
    expect(bff.listReads).toEqual([]);

    await run(w);

    expect(bff.listReads).toHaveLength(1);
    expect(Object.fromEntries(bff.listReads[0]!.entries())).toEqual({ traceIds: `0000000000000abc,${FOUND}` });
    expect(w.findAll('.tr-row-card')).toHaveLength(1);
    expect(w.text()).toContain('Not found: 0000000000000abc');
    // The lookup renders as the result; nothing is written to the address.
    expect(router.currentRoute.value.query).toEqual({});
  });

  it('bounds the lookup with the time range when one is picked', async () => {
    const w = await mountZipkinTab();
    await switchTo(w, 'Trace ID');
    await w.get('.ztr-conditions select').setValue(String(60 * 60_000));
    await lock(w, FOUND);
    await run(w);

    const asked = Object.fromEntries(bff.listReads[0]!.entries());
    expect(asked).toMatchObject({ traceIds: FOUND, lookback: '3600000' });
    expect(Number(asked.endTs)).toBeGreaterThan(0);
  });

  it('takes an id typed but not yet locked in when Run query is pressed', async () => {
    const w = await mountZipkinTab();
    await switchTo(w, 'Trace ID');
    await chipInput(w).setValue(FOUND);
    await run(w);

    expect(bff.listReads[0]!.get('traceIds')).toBe(FOUND);
  });

  it('refuses a value that is not a trace id, and keeps it in the field to fix', async () => {
    const w = await mountZipkinTab();
    await switchTo(w, 'Trace ID');
    await lock(w, 'xyz');

    expect(w.findAll('.chi__chip')).toHaveLength(0);
    expect(w.get('.chi__refusal').text()).toBe('Not a Zipkin trace ID: xyz');
    expect((chipInput(w).element as HTMLInputElement).value).toBe('xyz');
  });

  it('does not run while a typed value is refused, even with ids locked in', async () => {
    const w = await mountZipkinTab();
    await switchTo(w, 'Trace ID');
    await lock(w, FOUND);
    await chipInput(w).setValue('xyz');
    await run(w);

    expect(bff.listReads).toEqual([]);
    expect(w.get('.chi__refusal').text()).toBe('Not a Zipkin trace ID: xyz');
  });

  it('refuses to run with no id, and asks nothing', async () => {
    const w = await mountZipkinTab();
    await switchTo(w, 'Trace ID');
    await run(w);

    expect(w.text()).toContain('Enter a trace ID to look up.');
    expect(bff.listReads).toEqual([]);
  });

  it('trades the filter for the ids, and keeps the filter for the way back', async () => {
    const w = await mountZipkinTab();
    const min = w.findAll('input[type="number"]')[0]!;
    await min.setValue('250');
    await min.trigger('change');

    await switchTo(w, 'Trace ID');
    expect(w.findAll('input[type="number"]')).toHaveLength(0);
    expect(w.findAll('.ztr-conditions .tas__trigger')).toHaveLength(0);
    expect(w.find('.chi__input').exists()).toBe(true);

    await switchTo(w, 'Filter');
    expect((w.findAll('input[type="number"]')[0]!.element as HTMLInputElement).value).toBe('250');
    expect(w.find('.chi__input').exists()).toBe(false);
  });

  it('keeps each mode\'s custom range apart', async () => {
    const w = await mountZipkinTab();
    const bounds = () => w.findAll('.ztr-conditions input[type="datetime-local"]');
    const timeSelect = () => w.findAll('.ztr-conditions select').find((s) => s.find('option[value="-1"]').exists())!;
    const [filterFrom, filterTo, idFrom, idTo] = [localDt(3), localDt(2), localDt(48), localDt(47)];
    await timeSelect().setValue('-1');
    await bounds()[0]!.setValue(filterFrom);
    await bounds()[1]!.setValue(filterTo);

    await switchTo(w, 'Trace ID');
    await timeSelect().setValue('-1');
    await bounds()[0]!.setValue(idFrom);
    await bounds()[1]!.setValue(idTo);
    await lock(w, FOUND);
    await run(w);
    const byId = Object.fromEntries(bff.listReads[0]!.entries());
    expect(byId).toMatchObject({ endTs: String(new Date(idTo).getTime()), lookback: String(new Date(idTo).getTime() - new Date(idFrom).getTime()) });

    await switchTo(w, 'Filter');
    expect(bounds().map((b) => (b.element as HTMLInputElement).value)).toEqual([filterFrom, filterTo]);
  });

  it('drops the distribution pick when the same lookup runs again', async () => {
    // The same ids give the same answer, so the list keeps its identity and
    // nothing but Run query itself clears the pick.
    const w = await mountZipkinTab();
    await switchTo(w, 'Trace ID');
    await lock(w, FOUND);
    await run(w);
    w.findComponent(TraceDistribution).vm.$emit('brush', [FOUND]);
    await flushPromises();
    expect(w.text()).toContain('1 picked');

    await run(w);
    expect(bff.listReads).toHaveLength(2);
    expect(w.text()).not.toContain('1 picked');
  });

  it('forgets the ids not found when a layer switch returns the tab to its prompt', async () => {
    const w = await mountZipkinTab();
    await switchTo(w, 'Trace ID');
    await lock(w, 'abc');
    await lock(w, FOUND);
    await run(w);
    expect(w.text()).toContain('Not found: 0000000000000abc');

    await w.setProps({ layerKey: 'istio' });
    await flushPromises();
    expect(w.text()).not.toContain('Not found');
  });
});
