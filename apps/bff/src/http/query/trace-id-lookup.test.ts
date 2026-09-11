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
 * A lookup by trace id reads the id within a window only when the caller sends
 * one. The native list carries no `queryDuration` for a bare trace id — the
 * protocol takes either one, and a window hides a trace that falls outside it —
 * and the Zipkin surfaces read the ids through `/api/v2/traceMany` with
 * `endTs` + `lookback` only when asked. The cold stage is read only within a
 * window, so the Cold pill reaches a lookup only when it has one. Asserted on
 * what the fake OAP was asked.
 */

import { describe, it, expect } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import type { FetchLike, ZipkinSpan } from '@skywalking-horizon-ui/api-client';
import { configSchema } from '../../config/schema.js';
import type { ConfigSource } from '../../config/loader.js';
import { SessionStore } from '../../user/sessions.js';
import { makeRouteAuthHook } from '../../rbac/route-policy.js';
import { registerColdStageHook } from '../../util/duration.js';
import { serviceLayerCatalog } from '../../logic/services/service-layer-catalog.js';
import { registerZipkinRoutes } from './zipkin.js';
import { registerTraceRoutes } from './trace.js';
import { registerExploreRoutes } from './explore.js';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

interface Asked {
  zipkin: URL[];
  conditions: Array<Record<string, unknown>>;
}

/** A fake OAP: Trace Query v1, UTC, and a `traceMany` the test answers. It
 *  keeps every Zipkin URL and every trace-list condition it was asked. */
function fakeOap(
  traceMany: (ids: string[]) => Response = () => json([]),
  list: () => Response = () => json([]),
): { fetch: FetchLike; asked: Asked } {
  const asked: Asked = { zipkin: [], conditions: [] };
  const fetch: FetchLike = async (rawUrl, init) => {
    const url = new URL(String(rawUrl));
    if (url.pathname.includes('/api/v2/')) {
      asked.zipkin.push(url);
      if (url.pathname.endsWith('/api/v2/traceMany')) return traceMany((url.searchParams.get('traceIds') ?? '').split(','));
      if (url.pathname.endsWith('/api/v2/traces')) return list();
      return json([]);
    }
    const body = JSON.parse(String(init?.body ?? '{}')) as { query?: string; variables?: { condition?: Record<string, unknown> } };
    const query = body.query ?? '';
    if (query.includes('getTimeInfo')) return json({ data: { getTimeInfo: { timezone: '+0000', currentTimestamp: Date.now() } } });
    if (query.includes('hasQueryTracesV2Support')) return json({ data: { hasQueryTracesV2Support: false } });
    if (body.variables?.condition) asked.conditions.push(body.variables.condition);
    return json({ data: { data: { traces: [] } } });
  };
  return { fetch, asked };
}

function fakeConfig(): ConfigSource {
  const cfg = configSchema.parse({});
  return { current: cfg, current_: () => cfg, path: '', onChange: () => () => {}, close: async () => {} };
}

async function build(fetchImpl: FetchLike): Promise<{ app: FastifyInstance; sid: string }> {
  const config = fakeConfig();
  const sessions = new SessionStore({ ttlMinutes: 60 });
  const app = Fastify();
  await app.register(cookie);
  registerColdStageHook(app);
  app.addHook('onRoute', makeRouteAuthHook({ config, sessions }));
  const deps = { config, sessions, fetch: fetchImpl, serviceLayer: serviceLayerCatalog({ config, fetch: fetchImpl }) };
  registerZipkinRoutes(app, deps as unknown as Parameters<typeof registerZipkinRoutes>[1]);
  registerTraceRoutes(app, deps as unknown as Parameters<typeof registerTraceRoutes>[1]);
  registerExploreRoutes(app, deps as unknown as Parameters<typeof registerExploreRoutes>[1]);
  await app.ready();
  return { app, sid: sessions.create('op', ['admin']).sid };
}

/** Call one route with the Cold pill ON — the case where a window would carry it. */
async function callCold(
  oap: ReturnType<typeof fakeOap>,
  method: 'GET' | 'POST',
  url: string,
  payload?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { app, sid } = await build(oap.fetch);
  const res = await app.inject({
    method,
    url,
    headers: { cookie: `horizon_sid=${sid}`, 'x-horizon-cold-stage': '1', ...(payload ? { 'content-type': 'application/json' } : {}) },
    ...(payload ? { payload } : {}),
  });
  expect(res.statusCode).toBe(200);
  return res.json() as Record<string, unknown>;
}

const params = (u: URL): Record<string, string> => Object.fromEntries(u.searchParams.entries());

function trace(traceId: string): ZipkinSpan[] {
  return [{ traceId, id: 'aaaaaaaaaaaaaaaa', name: 'get /checkout', timestamp: 1_700_000_000_000_000, duration: 4000, localEndpoint: { serviceName: 'gateway' } }];
}

const LONG_ID = '1234567890abcdef1234567890abcdef';

describe('native: a trace id is looked up with no window unless one is sent', () => {
  it('sends the id and no queryDuration when no window is sent, even with the Cold pill on', async () => {
    const oap = fakeOap();
    await callCold(oap, 'POST', '/api/layer/general/traces', { source: 'native', traceId: 'abc.1.2', pageSize: 20 });
    expect(oap.asked.conditions).toHaveLength(1);
    expect(oap.asked.conditions[0]).toMatchObject({ traceId: 'abc.1.2' });
    expect(oap.asked.conditions[0]).not.toHaveProperty('queryDuration');
  });

  it('bounds the id by the window it is sent with, and asks for the cold stage within it', async () => {
    const oap = fakeOap();
    await callCold(oap, 'POST', '/api/layer/general/traces', { source: 'native', traceId: 'abc.1.2', windowMinutes: 60, pageSize: 20 });
    expect(oap.asked.conditions[0]).toMatchObject({ traceId: 'abc.1.2', queryDuration: { step: 'SECOND', coldStage: true } });
  });

  it('keeps the window, and the cold stage with it, when no trace id is given', async () => {
    const oap = fakeOap();
    await callCold(oap, 'POST', '/api/layer/general/traces', { source: 'native', windowMinutes: 30, pageSize: 20 });
    expect(oap.asked.conditions[0]).toMatchObject({ queryDuration: { step: 'SECOND', coldStage: true } });
  });

  it('does the same on Trace inspect, and echoes only the window it sent', async () => {
    const bare = fakeOap();
    const res = await callCold(bare, 'POST', '/api/explore/query', { kind: 'trace', traceSource: 'native', traceId: 'abc.1.2', pageSize: 20 });
    expect(bare.asked.conditions[0]).not.toHaveProperty('queryDuration');
    const condition = (res.resolved as { condition: Record<string, unknown> }).condition;
    expect(condition).toMatchObject({ traceId: 'abc.1.2' });
    expect(condition).not.toHaveProperty('windowMinutes');

    const bounded = fakeOap();
    const res2 = await callCold(bounded, 'POST', '/api/explore/query', { kind: 'trace', traceSource: 'native', traceId: 'abc.1.2', window: { windowMinutes: 60 }, pageSize: 20 });
    expect(bounded.asked.conditions[0]).toMatchObject({ traceId: 'abc.1.2', queryDuration: { coldStage: true } });
    expect((res2.resolved as { condition: Record<string, unknown> }).condition).toMatchObject({ traceId: 'abc.1.2', windowMinutes: 60 });
  });
});

describe('Zipkin: trace ids are read through traceMany, within a window only when one is sent', () => {
  it('normalizes and de-duplicates the ids as OAP would, and asks for no window or stage', async () => {
    const oap = fakeOap(() => json([trace('0000000000000abc')]));
    const res = await callCold(oap, 'GET', `/api/zipkin/traces?traceIds=ABC,abc,0000000000000abc,${LONG_ID.toUpperCase()}`);
    expect(oap.asked.zipkin).toHaveLength(1);
    expect(oap.asked.zipkin[0]!.pathname.endsWith('/api/v2/traceMany')).toBe(true);
    expect(params(oap.asked.zipkin[0]!)).toEqual({ traceIds: `0000000000000abc,${LONG_ID}` });
    expect(res).toMatchObject({ reachable: true, hasNext: false, missingTraceIds: [LONG_ID] });
    const rows = res.traces as Array<{ traceId: string; spans?: ZipkinSpan[] }>;
    expect(rows.map((r) => r.traceId)).toEqual(['0000000000000abc']);
    expect(rows[0]!.spans).toHaveLength(1);
  });

  it('bounds the lookup by the window it is sent with, and asks for the cold stage within it', async () => {
    const oap = fakeOap(() => json([trace('0000000000000abc')]));
    await callCold(oap, 'GET', '/api/zipkin/traces?traceIds=abc&endTs=1700000000000&lookback=3600000');
    expect(params(oap.asked.zipkin[0]!)).toEqual({
      traceIds: '0000000000000abc',
      endTs: '1700000000000',
      lookback: '3600000',
      coldStage: 'true',
    });
  });

  it('treats an id and its zero-padded spelling as one, as OAP does', async () => {
    const oap = fakeOap(() => json([trace('463ac35c9f6413ad')]));
    const res = await callCold(oap, 'GET', '/api/zipkin/traces?traceIds=0463ac35c9f6413ad,463ac35c9f6413ad');
    expect(params(oap.asked.zipkin[0]!)).toEqual({ traceIds: '463ac35c9f6413ad' });
    expect(res).toMatchObject({ reachable: true });
    expect(res).not.toHaveProperty('missingTraceIds');
  });

  it('reads OAP’s 404 — the ids it was sent, then "not found" — as none of the ids found, not as a failure', async () => {
    const oap = fakeOap(() => new Response('0000000000000abc,0000000000000def not found', { status: 404 }));
    const res = await callCold(oap, 'GET', '/api/zipkin/traces?traceIds=abc,def');
    expect(res).toMatchObject({ reachable: true, traces: [], missingTraceIds: ['0000000000000abc', '0000000000000def'] });
  });

  it('refuses a value that is not a trace id without asking OAP', async () => {
    const oap = fakeOap();
    const res = await callCold(oap, 'GET', '/api/zipkin/traces?traceIds=abc,xyz');
    expect(oap.asked.zipkin).toEqual([]);
    expect(res).toMatchObject({ reachable: false, traces: [] });
    expect(String(res.error)).toContain('xyz');
  });

  it('refuses more ids than one read may carry rather than dropping the rest', async () => {
    const oap = fakeOap();
    const ids = Array.from({ length: 101 }, (_, i) => (i + 1).toString(16).padStart(16, '0'));
    const res = await callCold(oap, 'GET', `/api/zipkin/traces?traceIds=${ids.join(',')}`);
    expect(oap.asked.zipkin).toEqual([]);
    expect(res).toMatchObject({ reachable: false, traces: [] });
  });

  it('reads a 404 that is not OAP’s own answer as a failure — a wrong Zipkin URL or a proxy answers 404 too', async () => {
    for (const body of ['Status: 404\nDescription: Not Found', '404 page not found', 'ffffffffffffffff not found']) {
      const res = await callCold(fakeOap(() => new Response(body, { status: 404 })), 'GET', '/api/zipkin/traces?traceIds=abc');
      expect(res, body).toMatchObject({ reachable: false, traces: [] });
      expect(res, body).not.toHaveProperty('missingTraceIds');
    }
  });

  it('counts an HTTP 5xx span as an error, as the window list does', async () => {
    const failing = (): Response => json([[{ ...trace('0000000000000abc')[0]!, tags: { 'http.status_code': '503' } }]]);
    const byId = await callCold(fakeOap(failing), 'GET', '/api/zipkin/traces?traceIds=abc');
    const byWindow = await callCold(fakeOap(() => json([]), failing), 'GET', '/api/zipkin/traces?limit=5');
    expect((byId.traces as Array<{ errorCount: number }>)[0]!.errorCount).toBe(1);
    expect((byWindow.traces as Array<{ errorCount: number }>)[0]!.errorCount).toBe(1);
  });

  it('reads the ids the same way from the layer route and from Trace inspect', async () => {
    const layer = fakeOap(() => json([trace('0000000000000abc')]));
    await callCold(layer, 'POST', '/api/layer/general/traces', { source: 'zipkin', traceIds: ['abc'] });
    expect(layer.asked.zipkin.map((u) => u.pathname.split('/').pop())).toEqual(['traceMany']);
    expect(params(layer.asked.zipkin[0]!)).toEqual({ traceIds: '0000000000000abc' });

    const explore = fakeOap(() => json([trace('0000000000000abc')]));
    const res = await callCold(explore, 'POST', '/api/explore/query', { kind: 'trace', traceSource: 'zipkin', traceIds: ['abc'] });
    expect(params(explore.asked.zipkin[0]!)).toEqual({ traceIds: '0000000000000abc' });
    expect((res.resolved as { condition: Record<string, unknown> }).condition).toEqual({ traceIds: ['abc'] });
  });

  it('bounds the ids by the window from the layer route and from Trace inspect alike', async () => {
    const layer = fakeOap(() => json([trace('0000000000000abc')]));
    await callCold(layer, 'POST', '/api/layer/general/traces', { source: 'zipkin', traceIds: ['abc'], windowMinutes: 30 });
    expect(params(layer.asked.zipkin[0]!)).toMatchObject({ traceIds: '0000000000000abc', lookback: '1800000', coldStage: 'true' });

    const explore = fakeOap(() => json([trace('0000000000000abc')]));
    const res = await callCold(explore, 'POST', '/api/explore/query', { kind: 'trace', traceSource: 'zipkin', traceIds: ['abc'], window: { windowMinutes: 60 } });
    expect(params(explore.asked.zipkin[0]!)).toMatchObject({ traceIds: '0000000000000abc', lookback: '3600000', coldStage: 'true' });
    expect((res.resolved as { condition: Record<string, unknown> }).condition).toMatchObject({ traceIds: ['abc'], lookback: 3_600_000 });
  });
});
