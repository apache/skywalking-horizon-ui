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
 * Trace inspect's Trace ID mode looks traces up by id: the request carries the
 * id(s) — and the time range, when one is picked — and nothing else. The target
 * and the other conditions give way to the id field and come back as they were;
 * Run query refuses without an id; a Zipkin id typed but not locked in is part
 * of the run; and Enter never runs the query.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter, type Router } from 'vue-router';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import { i18n } from '@/i18n';
import ExploreView from './ExploreView.vue';

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
}

/** The answer Trace inspect gets for one run — a row named after what it asked. */
function answer(body: Record<string, unknown>): unknown {
  const resolved = { kind: 'trace', source: body.traceSource, condition: {} };
  if (body.traceSource === 'zipkin') {
    const ids = (body.traceIds as string[] | undefined) ?? [];
    return {
      kind: 'trace', traceSource: 'zipkin', generatedAt: 0, resolved,
      zipkin: {
        source: 'zipkin', hasNext: false, reachable: true,
        traces: ids.map((id) => ({ traceId: id, rootName: `/${id}`, rootService: 'gateway', timestamp: 1_700_000_000_000_000, duration: 4000, spanCount: 1, errorCount: 0, spans: [] })),
      },
    };
  }
  const id = String(body.traceId);
  return {
    kind: 'trace', traceSource: 'native', generatedAt: 0, resolved,
    native: {
      source: 'native', api: 'queryTraces', hasNext: false, reachable: true,
      traces: [{ key: `${id}-seg`, segmentId: `${id}-seg`, endpointNames: [`/${id}`], duration: 5, start: String(Date.now()), isError: false, traceIds: [id], spans: [] }],
    },
  };
}

/** A BFF that answers Trace inspect's runs, recording each request body. */
function fakeBff() {
  const asked: Array<Record<string, unknown>> = [];
  const fetchSpy = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input), 'http://ui').pathname;
    if (path === '/api/explore/query') {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      asked.push(body);
      return jsonResponse(answer(body));
    }
    return jsonResponse({});
  });
  return { fetchSpy, asked };
}

let router: Router;
let wrapper: VueWrapper | null = null;

async function mountInspect(): Promise<VueWrapper> {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  wrapper = mount(ExploreView, { global: { plugins: [router, i18n, [VueQueryPlugin, { queryClient }]] } });
  await flushPromises();
  return wrapper;
}

async function pick(w: VueWrapper, label: 'Filter' | 'Trace ID' | 'Zipkin'): Promise<void> {
  const button = w.findAll('.iq-bar .seg button').find((b) => b.text() === label);
  if (!button) throw new Error(`the page has no ${label} switch`);
  await button.trigger('click');
  await flushPromises();
}

async function run(w: VueWrapper): Promise<void> {
  await w.get('.iq-run').trigger('click');
  await flushPromises();
}

function nativeIdInput(w: VueWrapper) {
  return w.get('input[placeholder="paste a trace id"]');
}

/** A `datetime-local` value, `hoursAgo` before now. */
function localDt(hoursAgo: number): string {
  const d = new Date(Date.now() - hoursAgo * 3600_000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

beforeEach(async () => {
  setActivePinia(createPinia());
  router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div />' } }] });
  await router.push('/operate/trace-inspect');
  await router.isReady();
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  vi.unstubAllGlobals();
});

describe('Trace inspect — the Trace ID mode looks traces up by id', () => {
  it('sends the native id and nothing else when no time range is picked, with the target gone', async () => {
    const bff = fakeBff();
    vi.stubGlobal('fetch', bff.fetchSpy);
    const w = await mountInspect();
    await pick(w, 'Trace ID');
    expect(w.find('fieldset.iq-target').exists()).toBe(false);

    await nativeIdInput(w).setValue('abc.1.2');
    await run(w);

    expect(bff.asked).toEqual([{ kind: 'trace', traceSource: 'native', traceId: 'abc.1.2', pageSize: 100 }]);
    expect(w.text()).toContain('/abc.1.2');
  });

  it('bounds the lookup with the time range when one is picked', async () => {
    const bff = fakeBff();
    vi.stubGlobal('fetch', bff.fetchSpy);
    const w = await mountInspect();
    await pick(w, 'Trace ID');

    await w.get('.iq-time select').setValue('60');
    await nativeIdInput(w).setValue('abc.1.2');
    await run(w);

    expect(bff.asked).toEqual([{ kind: 'trace', traceSource: 'native', traceId: 'abc.1.2', pageSize: 100, window: { windowMinutes: 60 } }]);
  });

  it('refuses to run without an id, and asks nothing', async () => {
    const bff = fakeBff();
    vi.stubGlobal('fetch', bff.fetchSpy);
    const w = await mountInspect();
    await pick(w, 'Trace ID');

    await run(w);

    expect(w.text()).toContain('Enter a trace ID to look up.');
    expect(bff.asked).toEqual([]);
  });

  it('never runs on Enter in the native id field', async () => {
    const bff = fakeBff();
    vi.stubGlobal('fetch', bff.fetchSpy);
    const w = await mountInspect();
    await pick(w, 'Trace ID');

    await nativeIdInput(w).setValue('abc.1.2');
    await nativeIdInput(w).trigger('keydown', { key: 'Enter' });
    await nativeIdInput(w).trigger('keyup', { key: 'Enter' });
    await flushPromises();

    expect(bff.asked).toEqual([]);
  });

  it('locks Zipkin ids in with Enter without running, and takes one typed but not locked in', async () => {
    const bff = fakeBff();
    vi.stubGlobal('fetch', bff.fetchSpy);
    const w = await mountInspect();
    await pick(w, 'Zipkin');
    await pick(w, 'Trace ID');

    await w.get('.chi__input').setValue('ABC');
    await w.get('.chi__input').trigger('keydown', { key: 'Enter' });
    await w.get('.chi__input').trigger('keydown', { key: 'Enter' });
    await flushPromises();
    expect(bff.asked).toEqual([]);

    await w.get('.chi__input').setValue('def');
    await run(w);

    expect(bff.asked).toEqual([{ kind: 'trace', traceSource: 'zipkin', traceIds: ['0000000000000abc', '0000000000000def'] }]);
  });

  it('keeps each mode\'s custom range apart', async () => {
    const bff = fakeBff();
    vi.stubGlobal('fetch', bff.fetchSpy);
    const w = await mountInspect();
    const bounds = () => w.findAll('.iq-time input[type="datetime-local"]');
    const [filterFrom, filterTo, idFrom, idTo] = [localDt(3), localDt(2), localDt(48), localDt(47)];
    await w.get('.iq-time select').setValue('-1');
    await bounds()[0]!.setValue(filterFrom);
    await bounds()[1]!.setValue(filterTo);

    await pick(w, 'Trace ID');
    await w.get('.iq-time select').setValue('-1');
    await bounds()[0]!.setValue(idFrom);
    await bounds()[1]!.setValue(idTo);

    await pick(w, 'Filter');
    expect(bounds().map((b) => (b.element as HTMLInputElement).value)).toEqual([filterFrom, filterTo]);
    await run(w);
    expect(bff.asked[0]!.window).toEqual({ startMs: new Date(filterFrom).getTime(), endMs: new Date(filterTo).getTime() });
  });

  it('keeps the filter for the way back', async () => {
    const bff = fakeBff();
    vi.stubGlobal('fetch', bff.fetchSpy);
    const w = await mountInspect();
    const status = () => w.findAll('select').find((s) => s.find('option[value="ERROR"]').exists());
    await status()!.setValue('ERROR');

    await pick(w, 'Trace ID');
    expect(status()).toBeUndefined();

    await pick(w, 'Filter');
    expect(status()!.element.value).toBe('ERROR');
    expect(w.find('fieldset.iq-target').exists()).toBe(true);
  });
});
