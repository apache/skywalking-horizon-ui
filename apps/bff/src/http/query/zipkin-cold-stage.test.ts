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
 * The Cold pill on the Zipkin path. OAP's Zipkin-compatible API takes
 * `coldStage` as its own addition, bounded by `endTs` and `lookback`; every
 * Zipkin read Horizon makes must carry the flag when the header is on and
 * nothing of it when the header is off. Asserted on the wire the fake OAP
 * records, for the two Zipkin routes and the two Zipkin branches of the
 * trace routes.
 */

import { describe, it, expect } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import type { FetchLike } from '@skywalking-horizon-ui/api-client';
import { configSchema } from '../../config/schema.js';
import type { ConfigSource } from '../../config/loader.js';
import { SessionStore } from '../../user/sessions.js';
import { makeRouteAuthHook } from '../../rbac/route-policy.js';
import { registerColdStageHook } from '../../util/duration.js';
import { serviceLayerCatalog } from '../../logic/services/service-layer-catalog.js';
import { registerZipkinRoutes } from './zipkin.js';
import { registerTraceRoutes } from './trace.js';
import { registerExploreRoutes } from './explore.js';

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

/** A fake OAP that answers every Zipkin read empty and the time probe with
 *  UTC, and keeps each Zipkin URL it was asked. */
function fakeOap(): { fetch: FetchLike; urls: URL[] } {
  const urls: URL[] = [];
  const fetch: FetchLike = async (rawUrl, init) => {
    const url = new URL(String(rawUrl));
    if (url.pathname.includes('/api/v2/')) {
      urls.push(url);
      return json([]);
    }
    const body = JSON.parse(String(init?.body ?? '{}')) as { query?: string };
    if ((body.query ?? '').includes('getTimeInfo')) return json({ data: { getTimeInfo: { timezone: '+0000', currentTimestamp: Date.now() } } });
    if ((body.query ?? '').includes('hasQueryTracesV2Support')) return json({ data: { hasQueryTracesV2Support: false } });
    return json({ data: {} });
  };
  return { fetch, urls };
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

async function call(cold: boolean, method: 'GET' | 'POST', url: string, payload?: Record<string, unknown>): Promise<URL[]> {
  const oap = fakeOap();
  const { app, sid } = await build(oap.fetch);
  const res = await app.inject({
    method,
    url,
    headers: { cookie: `horizon_sid=${sid}`, ...(cold ? { 'x-horizon-cold-stage': '1' } : {}), ...(payload ? { 'content-type': 'application/json' } : {}) },
    ...(payload ? { payload } : {}),
  });
  expect(res.statusCode).toBe(200);
  return oap.urls;
}

const params = (u: URL): Record<string, string> => Object.fromEntries(u.searchParams.entries());

describe('the Cold pill on the Zipkin routes', () => {
  it('sends coldStage on the Zipkin list only while the header is on', async () => {
    const on = await call(true, 'GET', '/api/zipkin/traces?limit=5&lookback=3600000&endTs=1700000000000');
    expect(on).toHaveLength(1);
    expect(params(on[0]!)).toMatchObject({ coldStage: 'true', lookback: '3600000', endTs: '1700000000000' });
    const off = await call(false, 'GET', '/api/zipkin/traces?limit=5');
    expect(off[0]!.searchParams.has('coldStage')).toBe(false);
  });

  it('bounds a by-id lookup to the window it came from, and asks nothing when it has neither', async () => {
    const on = await call(true, 'GET', '/api/zipkin/trace/abc123?endTs=1700000000000&lookback=86400000');
    expect(on[0]!.pathname.endsWith('/api/v2/trace/abc123')).toBe(true);
    expect(params(on[0]!)).toEqual({ endTs: '1700000000000', lookback: '86400000', coldStage: 'true' });
    const coldNoWindow = await call(true, 'GET', '/api/zipkin/trace/abc123');
    expect(params(coldNoWindow[0]!)).toEqual({ coldStage: 'true' });
    const off = await call(false, 'GET', '/api/zipkin/trace/abc123');
    expect(off[0]!.search).toBe('');
  });
});

describe('a Zipkin by-id lookup that OAP answers 404', () => {
  it('reports the trace as not found as well as unreachable, so a reader sure of the id can tell the two apart', async () => {
    const fetch: FetchLike = async (rawUrl, init) => {
      const url = new URL(String(rawUrl));
      if (url.pathname.includes('/api/v2/trace/')) return new Response('', { status: 404 });
      const body = JSON.parse(String(init?.body ?? '{}')) as { query?: string };
      if ((body.query ?? '').includes('getTimeInfo')) return json({ data: { getTimeInfo: { timezone: '+0000', currentTimestamp: Date.now() } } });
      return json({ data: {} });
    };
    const { app, sid } = await build(fetch);
    const res = await app.inject({ method: 'GET', url: '/api/zipkin/trace/abc123', headers: { cookie: `horizon_sid=${sid}` } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ reachable: false, notFound: true, error: 'trace not found', spans: [] });
  });
});

describe('the Cold pill on the trace routes’ Zipkin branches', () => {
  it('sends coldStage and the requested window on the layer list when the source is Zipkin', async () => {
    const on = await call(true, 'POST', '/api/layer/general/traces', { source: 'zipkin', pageSize: 5, startMs: 1700000000000, endMs: 1700432000000 });
    const zipkin = on.filter((u) => u.pathname.endsWith('/api/v2/traces'));
    expect(zipkin).toHaveLength(1);
    expect(params(zipkin[0]!)).toMatchObject({ coldStage: 'true', endTs: '1700432000000', lookback: '432000000' });
    const rolling = await call(false, 'POST', '/api/layer/general/traces', { source: 'zipkin', pageSize: 5, windowMinutes: 90 });
    const p = params(rolling.find((u) => u.pathname.endsWith('/api/v2/traces'))!);
    expect(p.coldStage).toBeUndefined();
    expect(p.lookback).toBe(String(90 * 60_000));
    expect(Number(p.endTs)).toBeGreaterThan(1700000000000);
  });

  it('turns the by-id window into endTs and lookback and rides the flag with it', async () => {
    const on = await call(true, 'GET', '/api/trace/abc123?source=zipkin&startMs=1700000000000&endMs=1700003600000&step=HOUR');
    expect(on[0]!.pathname.endsWith('/api/v2/trace/abc123')).toBe(true);
    // The Zipkin base, not the GraphQL port: the two option objects type-check alike.
    expect(on[0]!.origin + on[0]!.pathname).toBe('http://127.0.0.1:9412/zipkin/api/v2/trace/abc123');
    expect(params(on[0]!)).toEqual({ endTs: '1700003600000', lookback: '3600000', coldStage: 'true' });
    const off = await call(false, 'GET', '/api/trace/abc123?source=zipkin');
    expect(off[0]!.search).toBe('');
  });
});

describe('the Cold pill on the Explore page’s Zipkin list', () => {
  it('sends coldStage with the window the page asked for, so its detail reads the same stage', async () => {
    const body = { kind: 'trace', traceSource: 'zipkin', window: { startMs: 1700000000000, endMs: 1700432000000 }, pageSize: 5 };
    const on = await call(true, 'POST', '/api/explore/query', body);
    const zipkin = on.filter((u) => u.pathname.endsWith('/api/v2/traces'));
    expect(zipkin).toHaveLength(1);
    expect(params(zipkin[0]!)).toMatchObject({ coldStage: 'true', endTs: '1700432000000' });
    const off = await call(false, 'POST', '/api/explore/query', body);
    expect(off.find((u) => u.pathname.endsWith('/api/v2/traces'))!.searchParams.has('coldStage')).toBe(false);
  });
});

