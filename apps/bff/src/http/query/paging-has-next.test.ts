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
 * The paging contract every list feed now answers: `hasNext` is READ, never
 * guessed from the page's own length.
 *
 * The fake OAP below implements the real `PaginationUtils.exchange` arithmetic
 * (`limit = pageSize`, `from = pageSize * (pageNum - 1)`) over a fixed row
 * universe, so the exact-multiple case these tests turn on is the same one the
 * live demo OAP produces: an 8-row window read 4 at a time ends on a FULL page
 * 2, and the old `rows.length >= pageSize` heuristic offered a Next that landed
 * on an empty page 3.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import type { FetchLike } from '@skywalking-horizon-ui/api-client';
import { configSchema } from '../../config/schema.js';
import type { ConfigSource } from '../../config/loader.js';
import { SessionStore } from '../../user/sessions.js';
import { makeRouteAuthHook } from '../../rbac/route-policy.js';
import { invalidateTraceQueryApiCache } from '../../util/trace-protocol-cache.js';
import {
  resetServiceLayerCatalog,
  serviceLayerCatalog,
} from '../../logic/services/service-layer-catalog.js';
import { registerLogRoute } from './log.js';
import { registerBrowserErrorsRoute } from './browser-errors.js';
import { registerEventsRoute } from './events.js';
import { registerTraceRoutes } from './trace.js';
import { registerAlarmsQueryRoutes } from './alarms.js';
import { registerEndpointRoute } from './endpoint.js';
import { registerAsyncProfileRoutes } from './async-profile.js';
import { registerZipkinRoutes } from './zipkin.js';

const SERVICE_ID = 'c29uZ3M=.1';
const SERVICE_NAME = 'songs.sample-services';

interface Call {
  query: string;
  variables: Record<string, unknown>;
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

interface Paging {
  pageNum: number;
  pageSize: number;
}

/** OAP's own arithmetic, verbatim from `PaginationUtils.exchange`. */
function slice<T>(universe: readonly T[], paging: Paging | undefined): T[] {
  const pageSize = paging?.pageSize ?? universe.length;
  const from = pageSize * ((paging?.pageNum ?? 1) - 1);
  return universe.slice(from, from + pageSize);
}

/** A fake OAP holding exactly `size` rows for every list query, answered with
 *  the real offset formula. Records every call so the wire can be asserted. */
function fakeOap(size: number): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const ids = Array.from({ length: size }, (_, i) => i);
  const fetch: FetchLike = async (rawUrl, init) => {
    const url = String(rawUrl);
    // Zipkin is plain REST on its own base URL — `Span[][]`, one inner array
    // per trace, capped by `limit` and nothing else.
    if (url.includes('/api/v2/traces')) {
      const limit = Number(new URL(url).searchParams.get('limit') ?? size);
      calls.push({ query: 'zipkin /api/v2/traces', variables: { limit } });
      return json(
        ids.slice(0, limit).map((i) => [{ traceId: `z-${i}`, id: `s-${i}`, name: 'GET /', duration: 1 }]),
      );
    }
    const body = JSON.parse(String(init?.body ?? '{}')) as Call;
    const query = body.query ?? '';
    const vars = body.variables ?? {};
    calls.push({ query, variables: vars });
    if (query.includes('hasQueryTracesV2Support')) {
      return json({ data: { hasQueryTracesV2Support: false } });
    }
    const paging = (name: string): Paging | undefined => {
      const holder = vars[name] as Record<string, unknown> | undefined;
      return holder?.paging as Paging | undefined;
    };
    const rowsFor = (name: string, make: (i: number) => unknown): unknown[] =>
      slice(ids, paging(name)).map(make);
    const both = (field: string, make: (i: number) => unknown): Response =>
      json({
        data: {
          data: { [field]: rowsFor('condition', make) },
          ...(query.includes('probe:') ? { probe: { [field]: rowsFor('probe', make) } } : {}),
        },
      });

    if (query.includes('queryLogs')) {
      return both('logs', (i) => ({
        timestamp: i,
        contentType: 'TEXT',
        content: `line-${i}`,
        tags: [{ key: 'level', value: 'INFO' }],
        serviceName: SERVICE_NAME,
      }));
    }
    if (query.includes('queryBrowserErrorLogs')) {
      return both('logs', (i) => ({
        service: 'app',
        serviceVersion: 'v1',
        // Descending time so the route's newest-first re-sort is a no-op and
        // the assertions read the same rows the page boundary produced.
        time: size - i,
        pagePath: '/',
        category: 'AJAX',
        firstReportedError: false,
      }));
    }
    if (query.includes('queryEvents')) {
      return both('events', (i) => ({
        uuid: `e-${i}`,
        source: { service: SERVICE_NAME },
        name: 'Start',
        type: 'Normal',
        startTime: i,
        layer: 'GENERAL',
      }));
    }
    if (query.includes('queryBasicTraces')) {
      return both('traces', (i) => ({
        key: `seg-${i}`,
        endpointNames: ['/api'],
        duration: 1,
        start: String(i),
        isError: false,
        traceIds: [`t-${i}`],
      }));
    }
    if (query.includes('getAlarm')) {
      const p = vars.paging as Paging | undefined;
      return json({
        data: {
          getAlarm: {
            msgs: slice(ids, p).map((i) => ({
              id: `a-${i}`,
              startTime: i,
              recoveryTime: null,
              scope: 'Service',
              name: SERVICE_NAME,
              message: 'm',
              tags: [],
              snapshot: { expression: 'x', metrics: [] },
            })),
          },
        },
      });
    }
    // `findEndpoint` / the profiling task lists take a bare `limit` root
    // argument rather than a Pagination — the cap-only half of the seam.
    const capped = (make: (i: number) => unknown): unknown[] => {
      const holder = (vars.request ?? vars) as Record<string, unknown>;
      return ids.slice(0, Number(holder.limit ?? size)).map(make);
    };
    if (query.includes('findEndpoint')) {
      return json({ data: { endpoints: capped((i) => ({ id: `ep-${i}`, name: `/api/${i}` })) } });
    }
    if (query.includes('queryAsyncProfilerTaskList')) {
      return json({ data: { asyncTaskList: { tasks: capped((i) => ({ id: `async-${i}` })) } } });
    }
    if (query.includes('queryPprofTaskList')) {
      return json({ data: { pprofTaskList: { tasks: capped((i) => ({ id: `pprof-${i}` })) } } });
    }
    if (query.includes('getTimeInfo')) {
      return json({ data: { getTimeInfo: { timezone: '+0000', currentTimestamp: 0 } } });
    }
    return json({ data: {} });
  };
  return { fetch, calls };
}

function fakeConfig(): ConfigSource {
  const cfg = configSchema.parse({});
  return { current: cfg, current_: () => cfg, path: '', onChange: () => () => {}, close: async () => {} };
}

type Register = (app: FastifyInstance, deps: never) => void;

async function build(register: Register, fetchImpl: FetchLike) {
  const config = fakeConfig();
  const sessions = new SessionStore({ ttlMinutes: 60 });
  const app = Fastify();
  await app.register(cookie);
  app.addHook('onRoute', makeRouteAuthHook({ config, sessions }));
  (register as (app: FastifyInstance, deps: unknown) => void)(app, {
    config,
    sessions,
    fetch: fetchImpl,
    serviceLayer: serviceLayerCatalog({ config, fetch: fetchImpl }),
  });
  await app.ready();
  return { app, sid: sessions.create('op', ['admin']).sid };
}

async function post(
  register: Register,
  fetchImpl: FetchLike,
  url: string,
  payload: Record<string, unknown>,
) {
  const { app, sid } = await build(register, fetchImpl);
  const res = await app.inject({
    method: 'POST',
    url,
    headers: { cookie: `horizon_sid=${sid}`, 'content-type': 'application/json' },
    payload,
  });
  return res.json();
}

async function get(register: Register, fetchImpl: FetchLike, url: string) {
  const { app, sid } = await build(register, fetchImpl);
  const res = await app.inject({ method: 'GET', url, headers: { cookie: `horizon_sid=${sid}` } });
  return res.json();
}

// Both caches are process-global; clear them so each fake OAP answers its own
// probes instead of inheriting another test's.
beforeEach(() => {
  invalidateTraceQueryApiCache();
  resetServiceLayerCatalog();
});

const LOGS_URL = '/api/layer/mesh/logs';
const IDENTITY = { serviceId: SERVICE_ID, service: SERVICE_NAME };

describe('logs — a full page never offers an empty next page', () => {
  it('page 2 of an 8-row window at pageSize 4 is FULL and reports no next page', async () => {
    const oap = fakeOap(8);
    const out = await post(registerLogRoute, oap.fetch, LOGS_URL, {
      ...IDENTITY,
      page: 2,
      pageSize: 4,
    });
    expect(out.logs).toHaveLength(4);
    // The old heuristic read `logs.length >= pageSize` and enabled Next here.
    expect(out.hasNext).toBe(false);
  });

  it('and page 3 really is empty, so the disabled Next was right', async () => {
    const oap = fakeOap(8);
    const out = await post(registerLogRoute, oap.fetch, LOGS_URL, {
      ...IDENTITY,
      page: 3,
      pageSize: 4,
    });
    expect(out.logs).toHaveLength(0);
    expect(out.hasNext).toBe(false);
  });

  it('page 1 of an exactly-full window reports no next page', async () => {
    const oap = fakeOap(4);
    const out = await post(registerLogRoute, oap.fetch, LOGS_URL, {
      ...IDENTITY,
      page: 1,
      pageSize: 4,
    });
    expect(out.logs).toHaveLength(4);
    expect(out.hasNext).toBe(false);
  });

  it('a partial page reports no next page', async () => {
    const oap = fakeOap(6);
    const out = await post(registerLogRoute, oap.fetch, LOGS_URL, {
      ...IDENTITY,
      page: 2,
      pageSize: 4,
    });
    expect(out.logs).toHaveLength(2);
    expect(out.hasNext).toBe(false);
  });

  it('a page with rows behind it reports a next page', async () => {
    const oap = fakeOap(9);
    const p1 = await post(registerLogRoute, oap.fetch, LOGS_URL, { ...IDENTITY, page: 1, pageSize: 4 });
    const p2 = await post(registerLogRoute, fakeOap(9).fetch, LOGS_URL, { ...IDENTITY, page: 2, pageSize: 4 });
    expect(p1.hasNext).toBe(true);
    expect(p2.hasNext).toBe(true);
  });

  it('no cross-page total is reported, because OAP exposes none', async () => {
    const oap = fakeOap(8);
    const out = await post(registerLogRoute, oap.fetch, LOGS_URL, { ...IDENTITY, page: 1, pageSize: 4 });
    expect(out).not.toHaveProperty('total');
    expect(out.pageNum).toBe(1);
    expect(out.pageSize).toBe(4);
  });

  it('walks every page of a 9-row window exactly once, with no empty tail page', async () => {
    const seen: number[] = [];
    let page = 1;
    for (;;) {
      const out = await post(registerLogRoute, fakeOap(9).fetch, LOGS_URL, {
        ...IDENTITY,
        page,
        pageSize: 4,
      });
      seen.push(out.logs.length);
      if (!out.hasNext) break;
      page += 1;
      expect(page).toBeLessThan(10);
    }
    expect(seen).toEqual([4, 4, 1]);
  });
});

describe('logs — the wire the two branches put on it', () => {
  it('page 1 over-fetches by exactly one, in a single-field document', async () => {
    const oap = fakeOap(8);
    await post(registerLogRoute, oap.fetch, LOGS_URL, { ...IDENTITY, page: 1, pageSize: 4 });
    const call = oap.calls.find((c) => c.query.includes('queryLogs'));
    const condition = call?.variables.condition as { paging: Paging };
    expect(condition.paging).toEqual({ pageNum: 1, pageSize: 5 });
    expect(call?.query).not.toContain('probe:');
    expect(call?.variables.probe).toBeUndefined();
  });

  it('page 2 asks its true size plus a one-row probe at the next page, in ONE call', async () => {
    const oap = fakeOap(8);
    await post(registerLogRoute, oap.fetch, LOGS_URL, { ...IDENTITY, page: 2, pageSize: 4 });
    const logCalls = oap.calls.filter((c) => c.query.includes('queryLogs'));
    expect(logCalls).toHaveLength(1);
    const call = logCalls[0];
    const condition = call.variables.condition as { paging: Paging; queryDuration: unknown };
    const probe = call.variables.probe as { paging: Paging; queryDuration: unknown };
    // `pageSize + 1` on page 2 would read offset 5 and skip a row, because OAP
    // derives `from` from `pageSize`. The page keeps its true size.
    expect(condition.paging).toEqual({ pageNum: 2, pageSize: 4 });
    // pageNum * pageSize + 1 = offset 8 = the first row of page 3.
    expect(probe.paging).toEqual({ pageNum: 9, pageSize: 1 });
    // Both aliases must read the SAME window, or the probe answers about a
    // range the page never covered.
    expect(probe.queryDuration).toEqual(condition.queryDuration);
  });
});

describe('browser errors — same contract, and the sort happens inside the page', () => {
  const URL = '/api/layer/browser/browser-errors';

  it('page 2 of an 8-row window at pageSize 4 is FULL and reports no next page', async () => {
    const out = await post(registerBrowserErrorsRoute, fakeOap(8).fetch, URL, {
      ...IDENTITY,
      page: 2,
      pageSize: 4,
    });
    expect(out.logs).toHaveLength(4);
    expect(out.hasNext).toBe(false);
  });

  it('a partial page reports no next page', async () => {
    const out = await post(registerBrowserErrorsRoute, fakeOap(6).fetch, URL, {
      ...IDENTITY,
      page: 2,
      pageSize: 4,
    });
    expect(out.logs).toHaveLength(2);
    expect(out.hasNext).toBe(false);
  });

  it('page 1 of a 9-row window keeps the over-fetched row OUT of the page', async () => {
    const oap = fakeOap(9);
    const out = await post(registerBrowserErrorsRoute, oap.fetch, URL, {
      ...IDENTITY,
      page: 1,
      pageSize: 4,
    });
    // The +1 row is a page boundary, not a member — the newest-first re-sort
    // must not be able to pull it into view.
    expect(out.logs).toHaveLength(4);
    expect(out.hasNext).toBe(true);
    expect(out).not.toHaveProperty('total');
  });
});

describe('events — an exactly-full window is complete, not truncated', () => {
  it('does not flag a window that exactly fills the cap', async () => {
    const out = await post(registerEventsRoute, fakeOap(5).fetch, '/api/events', { pageSize: 5 });
    expect(out.events).toHaveLength(5);
    expect(out.hasNext).toBe(false);
  });

  it('flags a window holding one more than the cap', async () => {
    const out = await post(registerEventsRoute, fakeOap(6).fetch, '/api/events', { pageSize: 5 });
    expect(out.events).toHaveLength(5);
    expect(out.hasNext).toBe(true);
  });
});

describe('native traces — the capped badge the list never had', () => {
  const URL = '/api/layer/mesh/traces';

  it('a result that exactly fills the limit is complete', async () => {
    const out = await post(registerTraceRoutes, fakeOap(5).fetch, URL, {
      source: 'native',
      ...IDENTITY,
      pageSize: 5,
    });
    expect(out.native.traces).toHaveLength(5);
    expect(out.native.hasNext).toBe(false);
  });

  it('one row beyond the limit is reported as capped, and never rendered', async () => {
    const out = await post(registerTraceRoutes, fakeOap(6).fetch, URL, {
      source: 'native',
      ...IDENTITY,
      pageSize: 5,
    });
    expect(out.native.traces).toHaveLength(5);
    expect(out.native.hasNext).toBe(true);
  });
});

describe('log facets — the sample says when it is a sample', () => {
  it('a window that exactly fills the sample is not flagged truncated', async () => {
    const out = await post(registerLogRoute, fakeOap(50).fetch, `${LOGS_URL}/facets`, {
      ...IDENTITY,
      sampleSize: 50,
    });
    expect(out.sampled).toBe(50);
    expect(out.truncated).toBe(false);
    expect(out).not.toHaveProperty('total');
  });

  it('a window holding more than the sample is flagged, and the extra row is not counted', async () => {
    const out = await post(registerLogRoute, fakeOap(51).fetch, `${LOGS_URL}/facets`, {
      ...IDENTITY,
      sampleSize: 50,
    });
    expect(out.sampled).toBe(50);
    expect(out.truncated).toBe(true);
  });
});

describe('alarms — truncated is proven, not guessed at the cap', () => {
  const url = (extra = '') => `/api/alarms?startTime=1000&endTime=2000${extra}`;

  it('a window that exactly fills the fetch is NOT reported truncated', async () => {
    const out = await get(registerAlarmsQueryRoutes, fakeOap(4).fetch, url('&pageSize=4'));
    expect(out.msgs).toHaveLength(4);
    expect(out.returned).toBe(4);
    expect(out.truncated).toBe(false);
  });

  it('one row beyond the fetch is reported truncated, and stays out of the rows', async () => {
    const out = await get(registerAlarmsQueryRoutes, fakeOap(5).fetch, url('&pageSize=4'));
    expect(out.msgs).toHaveLength(4);
    expect(out.truncated).toBe(true);
  });

  it('the count badge stops claiming "200+" at exactly 200 events', async () => {
    const out = await get(
      registerAlarmsQueryRoutes,
      fakeOap(200).fetch,
      '/api/alarms/count?startTime=1000&endTime=2000',
    );
    expect(out.total).toBe(200);
    expect(out.truncated).toBe(false);
  });

  it('the count badge still flags a window holding 201', async () => {
    const out = await get(
      registerAlarmsQueryRoutes,
      fakeOap(201).fetch,
      '/api/alarms/count?startTime=1000&endTime=2000',
    );
    expect(out.total).toBe(200);
    expect(out.truncated).toBe(true);
  });
});

describe('cap-only reads that have no offset to page with', () => {
  const PAIR = `serviceId=${encodeURIComponent(SERVICE_ID)}&service=${encodeURIComponent(SERVICE_NAME)}`;

  it('the endpoint picker says nothing more matched when the list is exactly the limit', async () => {
    const out = await get(registerEndpointRoute, fakeOap(20).fetch, `/api/layer/mesh/endpoints?${PAIR}&q=`);
    expect(out.endpoints).toHaveLength(20);
    expect(out.hasMore).toBe(false);
  });

  it('the endpoint picker flags one match beyond the limit, and does not render it', async () => {
    const out = await get(registerEndpointRoute, fakeOap(21).fetch, `/api/layer/mesh/endpoints?${PAIR}&q=`);
    expect(out.endpoints).toHaveLength(20);
    expect(out.hasMore).toBe(true);
  });

  it('the async-profiler task list flags one task beyond the limit', async () => {
    const exact = await get(registerAsyncProfileRoutes, fakeOap(5).fetch, `/api/layer/mesh/async/tasks?${PAIR}&limit=5`);
    expect(exact.tasks).toHaveLength(5);
    expect(exact.truncated).toBe(false);
    const over = await get(registerAsyncProfileRoutes, fakeOap(6).fetch, `/api/layer/mesh/async/tasks?${PAIR}&limit=5`);
    expect(over.tasks).toHaveLength(5);
    expect(over.truncated).toBe(true);
  });

  it('the pprof task list flags one task beyond the limit', async () => {
    const exact = await get(registerAsyncProfileRoutes, fakeOap(5).fetch, `/api/layer/mesh/pprof/tasks?${PAIR}&limit=5`);
    expect(exact.tasks).toHaveLength(5);
    expect(exact.truncated).toBe(false);
    const over = await get(registerAsyncProfileRoutes, fakeOap(6).fetch, `/api/layer/mesh/pprof/tasks?${PAIR}&limit=5`);
    expect(over.tasks).toHaveLength(5);
    expect(over.truncated).toBe(true);
  });

  // Zipkin's list endpoint has no offset parameter at all, so the over-fetch is
  // the only has-more signal it can ever carry — and never a next page.
  it('the Zipkin list calls an exactly-full result complete', async () => {
    const out = await get(registerZipkinRoutes, fakeOap(5).fetch, '/api/zipkin/traces?limit=5');
    expect(out.traces).toHaveLength(5);
    expect(out.hasNext).toBe(false);
  });

  it('the Zipkin list flags one trace beyond the limit, and does not render it', async () => {
    const out = await get(registerZipkinRoutes, fakeOap(6).fetch, '/api/zipkin/traces?limit=5');
    expect(out.traces).toHaveLength(5);
    expect(out.hasNext).toBe(true);
  });
});
