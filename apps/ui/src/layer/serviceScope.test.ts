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
 * One invariant, three tabs: a service-scoped tab (Traces / Logs / Browser
 * errors) must not query OAP before it knows its service. The window between
 * "a service is selected" and "its name resolved" is the dangerous one — a read
 * that carries no service is a read of the WHOLE LAYER, and it would render
 * under the picked service's title.
 *
 * The tabs are MOUNTED rather than their composables called, because the gate
 * has to hold on the Run-query path: `refetch()` fetches regardless of the
 * query's `enabled`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createRouter, createMemoryHistory, type Router } from 'vue-router';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import type { Component } from 'vue';
import { i18n } from '@/i18n';
import { useLayerSelectionStore } from '@/state/layerSelection';
import { resolveLayerServiceName, tabServiceScope } from './useLayerServiceName';
import LayerTracesView from './traces/LayerTracesView.vue';
import LayerLogsView from './logs/LayerLogsView.vue';
import LayerBrowserErrorsView from './browser-errors/LayerBrowserErrorsView.vue';

const SERVICE_ID = 'bWVzaC1zdnI6OnNvbmdz.1';
const SERVICE_NAME = 'songs';

describe('resolveLayerServiceName — "still resolving" is not "resolved to nothing"', () => {
  const base = { selectedId: SERVICE_ID, landingRows: [], landingSettled: true, roster: [], rosterSettled: true };

  it('resolves from the landing sample first', () => {
    expect(
      resolveLayerServiceName({
        ...base,
        landingRows: [{ serviceId: SERVICE_ID, serviceName: SERVICE_NAME }],
      }),
    ).toEqual({ name: SERVICE_NAME, id: SERVICE_ID, status: 'resolved' });
  });

  it('falls back to the full roster for a service outside the sample', () => {
    expect(
      resolveLayerServiceName({
        ...base,
        roster: [{ id: SERVICE_ID, name: SERVICE_NAME, normal: true, group: '' }],
      }),
    ).toEqual({ name: SERVICE_NAME, id: SERVICE_ID, status: 'resolved' });
  });

  it('reports `resolving` — never `unknown` — while either feed is outstanding', () => {
    expect(resolveLayerServiceName({ ...base, rosterSettled: false }).status).toBe('resolving');
    expect(resolveLayerServiceName({ ...base, landingSettled: false }).status).toBe('resolving');
  });

  it('reports `unknown` once both feeds settled without the id', () => {
    expect(resolveLayerServiceName(base)).toEqual({ name: null, id: null, status: 'unknown' });
  });

  it('treats a failed read as settled — the refusal is honest, the wait is not', () => {
    // Both feeds answered (one with an error); there is nothing more to await.
    expect(resolveLayerServiceName({ ...base, roster: [] }).status).toBe('unknown');
  });

  it('is `idle`, not `resolving`, when nothing is selected and landing has answered', () => {
    expect(resolveLayerServiceName({ ...base, selectedId: null })).toEqual({
      name: null,
      id: null,
      status: 'idle',
    });
    expect(resolveLayerServiceName({ ...base, selectedId: null, landingSettled: false }).status).toBe(
      'resolving',
    );
  });

  it('resolves OAP\'s blank-entity service to a queryable `_blank`', () => {
    expect(
      resolveLayerServiceName({
        ...base,
        landingRows: [{ serviceId: SERVICE_ID, serviceName: '' }],
      }),
    ).toEqual({ name: '_blank', id: SERVICE_ID, status: 'resolved' });
  });
});

describe('tabServiceScope — the query gate', () => {
  /** What the picker hands the tab: the service it selected, BY ID. */
  const PICKED = { kind: 'id', id: SERVICE_ID } as const;

  it('opens only on `resolved`', () => {
    for (const status of ['idle', 'resolving', 'unknown'] as const) {
      expect(tabServiceScope({ name: null, ref: null, status }, false, undefined).ready).toBe(false);
    }
    expect(
      tabServiceScope({ name: SERVICE_NAME, ref: PICKED, status: 'resolved' }, false, undefined).ready,
    ).toBe(true);
  });

  // The picker selects by id, so that is the handle the tab's queries carry —
  // the name is only what the operator reads.
  it('hands the route tab the picked ID, not the name it resolved to', () => {
    expect(
      tabServiceScope({ name: SERVICE_NAME, ref: PICKED, status: 'resolved' }, false, undefined).ref,
    ).toEqual({ kind: 'id', id: SERVICE_ID });
  });

  it('takes an embedded block\'s service from its prop, not from the picker', () => {
    // The chat block already knows its service; the resolver's in-flight state
    // must not park it. It was scoped by NAME (a prompt named it), so a name is
    // what it carries.
    expect(tabServiceScope({ name: null, ref: null, status: 'resolving' }, true, SERVICE_NAME)).toEqual({
      name: SERVICE_NAME,
      ref: { kind: 'name', name: SERVICE_NAME },
      status: 'resolved',
      ready: true,
    });
  });

  it('refuses an embedded block with no service rather than widening it', () => {
    expect(tabServiceScope({ name: SERVICE_NAME, ref: PICKED, status: 'resolved' }, true, '')).toEqual({
      name: null,
      ref: null,
      status: 'idle',
      ready: false,
    });
  });
});

/** One request a tab made: what it asked for, and with which body. */
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

/** A BFF whose service ROSTER is held open, so a test controls exactly when the
 *  selected id resolves to a name. The landing rollup answers immediately with
 *  no rows — the real-world case that sends resolution to the roster (a service
 *  outside landing's sampled top-N, or one arriving by deep link). */
function fakeBff(entityRead: { path: string; payload: unknown }) {
  const asked: Asked[] = [];
  let releaseRoster: (() => void) | null = null;
  const rosterAnswered = new Promise<void>((resolve) => {
    releaseRoster = resolve;
  });
  let rosterHasService = false;

  const fetchSpy = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    let body: Record<string, unknown> = {};
    if (typeof init?.body === 'string') body = JSON.parse(init.body) as Record<string, unknown>;
    asked.push({ url, body });
    const path = new URL(url, 'http://ui').pathname;
    if (path.endsWith('/services')) {
      await rosterAnswered;
      return jsonResponse({
        services: rosterHasService ? [{ id: SERVICE_ID, name: SERVICE_NAME, layers: ['MESH'] }] : [],
        reachable: true,
      });
    }
    if (path.endsWith('/landing')) {
      return jsonResponse({ rows: [], sampledRows: [], reachable: true, generatedAt: 0 });
    }
    if (path.endsWith('/source-maps')) {
      return jsonResponse({ maps: [], usage: null, enabled: true });
    }
    // The Logs tab's second read — the facet sample — is gated by the same
    // service, so it is asserted on alongside the stream.
    if (path.endsWith('/logs/facets')) {
      return jsonResponse({
        generatedAt: 0,
        total: 0,
        sampled: 0,
        level: { error: 0, warn: 0, info: 0, debug: 0, other: 0 },
        services: [],
        reachable: true,
      });
    }
    if (path.endsWith(entityRead.path)) return jsonResponse(entityRead.payload);
    return jsonResponse({});
  });

  return {
    fetchSpy,
    /** Let the roster answer — with or without the selected service in it. */
    answerRoster(withService: boolean) {
      rosterHasService = withService;
      releaseRoster?.();
    },
    to(suffix: string): Asked[] {
      return asked.filter((a) => new URL(a.url, 'http://ui').pathname.endsWith(suffix));
    },
  };
}

let router: Router;
let pinia: ReturnType<typeof createPinia>;

async function mountTab(view: Component, layerKey: string): Promise<VueWrapper> {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const w = mount(view, {
    props: { layerKey },
    global: { plugins: [pinia, router, i18n, [VueQueryPlugin, { queryClient }]] },
  });
  await flushPromises();
  return w;
}

/** Fire the Run-query handler itself. `trigger('click')` is deliberately inert
 *  on a disabled element (as a browser is), so it can only ever prove the
 *  attribute — this dispatch proves the guard INSIDE the handler, which is what
 *  covers the other ways a query is started (mount auto-run, a metric→trace
 *  drill) and a click that races the disable. */
async function fireRunQuery(w: VueWrapper, selector: string): Promise<void> {
  w.get(selector).element.dispatchEvent(new MouseEvent('click'));
  await flushPromises();
}

beforeEach(async () => {
  pinia = createPinia();
  setActivePinia(pinia);
  router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div />' } }],
  });
  await router.push('/layer/mesh/logs');
  await router.isReady();
  // A service IS selected (picker or deep link) — only its name is unknown.
  useLayerSelectionStore().setService(SERVICE_ID);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Logs tab', () => {
  const RUN = '.lg-run-btn';
  const logsPayload = { generatedAt: 0, query: {}, total: 0, logs: [], reachable: true };

  it('runs no log read — and says it is resolving — while the name is in flight', async () => {
    const bff = fakeBff({ path: '/logs', payload: logsPayload });
    vi.stubGlobal('fetch', bff.fetchSpy);
    const w = await mountTab(LayerLogsView, 'mesh');

    expect(w.text()).toContain('Resolving service…');
    expect(w.get(RUN).attributes('disabled')).toBeDefined();

    await fireRunQuery(w, RUN);

    expect(bff.to('/logs')).toHaveLength(0);
    expect(bff.to('/logs/facets')).toHaveLength(0);
  });

  // The picked service is an ID all the way down: the tab resolves a name only
  // to SHOW it, and a read scoped by that name would be re-resolved against the
  // roster — where a virtual service can wear the same name.
  it('runs the read scoped to the picked service ID once the roster answers', async () => {
    const bff = fakeBff({ path: '/logs', payload: logsPayload });
    vi.stubGlobal('fetch', bff.fetchSpy);
    const w = await mountTab(LayerLogsView, 'mesh');
    bff.answerRoster(true);
    await flushPromises();

    expect(w.get(RUN).attributes('disabled')).toBeUndefined();
    await fireRunQuery(w, RUN);

    expect(bff.to('/logs')).toHaveLength(1);
    expect(bff.to('/logs')[0]?.body.serviceId).toBe(SERVICE_ID);
    expect(bff.to('/logs')[0]?.body.service).toBeUndefined();
    expect(bff.to('/logs/facets')[0]?.body.serviceId).toBe(SERVICE_ID);
    expect(bff.to('/logs/facets')[0]?.body.service).toBeUndefined();
  });

  // The instance / endpoint pickers hang off the same handle.
  it('asks for the pickers by that same id, not by the display name', async () => {
    const bff = fakeBff({ path: '/logs', payload: logsPayload });
    vi.stubGlobal('fetch', bff.fetchSpy);
    await mountTab(LayerLogsView, 'mesh');
    bff.answerRoster(true);
    await flushPromises();

    const asked = bff.to('/instances')[0];
    expect(asked).toBeDefined();
    expect(new URL(asked!.url, 'http://ui').searchParams.get('serviceId')).toBe(SERVICE_ID);
    expect(new URL(asked!.url, 'http://ui').searchParams.get('service')).toBeNull();
  });

  // A chat block is scoped by a NAME the prompt supplied — there is no picker
  // and no id, so the name slot is the honest one to fill.
  it('sends a NAME when that is genuinely all the caller has', async () => {
    const bff = fakeBff({ path: '/logs', payload: logsPayload });
    vi.stubGlobal('fetch', bff.fetchSpy);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    mount(LayerLogsView, {
      props: { layerKey: 'mesh', embedded: true, focusService: SERVICE_NAME },
      global: { plugins: [pinia, router, i18n, [VueQueryPlugin, { queryClient }]] },
    });
    await flushPromises();

    expect(bff.to('/logs')[0]?.body.service).toBe(SERVICE_NAME);
    expect(bff.to('/logs')[0]?.body.serviceId).toBeUndefined();
  });

  it('refuses — with the reason — when the roster settles without the service', async () => {
    const bff = fakeBff({ path: '/logs', payload: logsPayload });
    vi.stubGlobal('fetch', bff.fetchSpy);
    const w = await mountTab(LayerLogsView, 'mesh');
    bff.answerRoster(false);
    await flushPromises();

    expect(w.text()).toContain('The selected service is not in this layer');
    expect(w.get(RUN).attributes('disabled')).toBeDefined();

    await fireRunQuery(w, RUN);

    expect(bff.to('/logs')).toHaveLength(0);
  });
});

describe('Traces tab', () => {
  const RUN = '.tr-run-btn';
  const tracesPayload = {
    generatedAt: 0,
    source: 'native',
    native: { source: 'native', api: 'queryBasicTraces', traces: [], reachable: true },
  };

  it('runs no trace read — and says it is resolving — while the name is in flight', async () => {
    const bff = fakeBff({ path: '/traces', payload: tracesPayload });
    vi.stubGlobal('fetch', bff.fetchSpy);
    const w = await mountTab(LayerTracesView, 'mesh');

    expect(w.text()).toContain('Resolving service…');
    expect(w.get(RUN).attributes('disabled')).toBeDefined();

    await fireRunQuery(w, RUN);

    expect(bff.to('/traces')).toHaveLength(0);
  });

  it('runs the read scoped to the service once the roster answers', async () => {
    const bff = fakeBff({ path: '/traces', payload: tracesPayload });
    vi.stubGlobal('fetch', bff.fetchSpy);
    const w = await mountTab(LayerTracesView, 'mesh');
    bff.answerRoster(true);
    await flushPromises();

    await fireRunQuery(w, RUN);

    expect(bff.to('/traces')).toHaveLength(1);
    expect(bff.to('/traces')[0]?.body.service).toBe(SERVICE_NAME);
  });

  // The reason used to live in the list header's `title` — invisible unless you
  // hover, and absent from the page text entirely.
  it('prints the refusal reason in the body, not only in a tooltip', async () => {
    const reason = `Unknown service "${SERVICE_NAME}" in layer MESH.`;
    const bff = fakeBff({
      path: '/traces',
      payload: {
        generatedAt: 0,
        source: 'native',
        native: { source: 'native', api: 'queryBasicTraces', traces: [], reachable: false, error: reason },
      },
    });
    vi.stubGlobal('fetch', bff.fetchSpy);
    const w = await mountTab(LayerTracesView, 'mesh');
    bff.answerRoster(true);
    await flushPromises();
    await fireRunQuery(w, RUN);

    expect(w.get('.banner.err').text()).toContain(reason);
  });
});

describe('Browser errors tab', () => {
  const RUN = '.be-head-right .sw-btn.primary';
  const errorsPayload = { generatedAt: 0, query: {}, total: 0, logs: [], reachable: true };

  it('runs no browser-error read while the name is in flight', async () => {
    const bff = fakeBff({ path: '/browser-errors', payload: errorsPayload });
    vi.stubGlobal('fetch', bff.fetchSpy);
    const w = await mountTab(LayerBrowserErrorsView, 'browser');

    expect(w.text()).toContain('Resolving service…');
    expect(w.get(RUN).attributes('disabled')).toBeDefined();

    await fireRunQuery(w, RUN);

    expect(bff.to('/browser-errors')).toHaveLength(0);
  });

  it('runs the read scoped to the picked app ID once the roster answers', async () => {
    const bff = fakeBff({ path: '/browser-errors', payload: errorsPayload });
    vi.stubGlobal('fetch', bff.fetchSpy);
    const w = await mountTab(LayerBrowserErrorsView, 'browser');
    bff.answerRoster(true);
    await flushPromises();

    await fireRunQuery(w, RUN);

    expect(bff.to('/browser-errors')).toHaveLength(1);
    expect(bff.to('/browser-errors')[0]?.body.serviceId).toBe(SERVICE_ID);
    expect(bff.to('/browser-errors')[0]?.body.service).toBeUndefined();
  });
});
