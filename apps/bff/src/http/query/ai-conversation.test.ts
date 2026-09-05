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

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import type { FetchLike } from '@skywalking-horizon-ui/api-client';
import { configSchema } from '../../config/schema.js';
import type { ConfigSource } from '../../config/loader.js';
import { SessionStore } from '../../user/sessions.js';
import { makeRouteAuthHook } from '../../rbac/route-policy.js';
import { registerColdStageHook } from '../../util/duration.js';
import { fmtSecond } from '../../util/window.js';
import {
  clampLimit,
  clampWindowMs,
  passthroughHeaders,
  registerAiConversationRoutes,
  wantsYaml,
} from './ai-conversation.js';

const DAY_MS = 24 * 60 * 60_000;
const NOW = 1_782_800_000_000;

describe('clampWindowMs', () => {
  it('defaults to a rolling week ending now', () => {
    expect(clampWindowMs(undefined, undefined, NOW)).toEqual({ startMs: NOW - 7 * DAY_MS, endMs: NOW });
  });
  it('honours a rolling window in minutes, capped at 90 days', () => {
    expect(clampWindowMs(60, undefined, NOW)).toEqual({ startMs: NOW - 60 * 60_000, endMs: NOW });
    expect(clampWindowMs(365 * 24 * 60, undefined, NOW)).toEqual({ startMs: NOW - 90 * DAY_MS, endMs: NOW });
  });
  it('keeps an explicit range within the cap, and clamps a wider one to its newest 90 days', () => {
    const explicit = { startMs: NOW - 30 * DAY_MS, endMs: NOW };
    expect(clampWindowMs(undefined, explicit, NOW)).toEqual(explicit);
    expect(clampWindowMs(undefined, { startMs: NOW - 400 * DAY_MS, endMs: NOW }, NOW)).toEqual({
      startMs: NOW - 90 * DAY_MS,
      endMs: NOW,
    });
  });
  it('ignores an inverted explicit range and falls back to rolling', () => {
    expect(clampWindowMs(undefined, { startMs: NOW, endMs: NOW - DAY_MS }, NOW)).toEqual({
      startMs: NOW - 7 * DAY_MS,
      endMs: NOW,
    });
  });
});

describe('clampLimit', () => {
  it('sends the cap when the caller says nothing, or nonsense', () => {
    expect(clampLimit(undefined, 10_000)).toBe(10_000);
    expect(clampLimit(0, 10_000)).toBe(10_000);
    expect(clampLimit(Number.NaN, 10_000)).toBe(10_000);
  });
  it('honours a smaller request and never exceeds the cap', () => {
    expect(clampLimit(50, 10_000)).toBe(50);
    expect(clampLimit(42.4, 10_000)).toBe(42);
    expect(clampLimit(1_000_000, 10_000)).toBe(10_000);
  });
});

describe('wantsYaml', () => {
  it('reads Accept the way OAP does: any type naming yaml', () => {
    expect(wantsYaml(undefined)).toBe(false);
    expect(wantsYaml('application/json')).toBe(false);
    expect(wantsYaml('application/vnd.skywalking.asz.view+yaml')).toBe(true);
    expect(wantsYaml(['text/html', 'text/YAML'])).toBe(true);
  });
});

describe('passthroughHeaders', () => {
  it('keeps what names the bytes and drops the upstream hop', () => {
    expect(
      passthroughHeaders({
        'content-type': 'application/vnd.skywalking.asz.view+json; version=1.0',
        'content-encoding': 'gzip',
        'content-length': '1234',
        vary: 'accept-encoding',
        server: 'Armeria',
        date: 'now',
        connection: 'keep-alive',
        'transfer-encoding': 'chunked',
      }),
    ).toEqual({
      'content-type': 'application/vnd.skywalking.asz.view+json; version=1.0',
      'content-encoding': 'gzip',
      'content-length': '1234',
      vary: 'accept-encoding',
    });
  });
});

/* ── the routes, through Fastify ─────────────────────────────────────── */

interface Captured {
  query: string;
  variables: Record<string, unknown>;
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

const ROWS = [
  { conversation: 'old', serviceInstanceId: 'i', serviceInstanceName: 'me@host', title: 'first', round: 2, talks: 1, steps: 5, streams: 1, segments: 1, unresolved: 0, from: 10, to: 100 },
  { conversation: 'new', serviceInstanceId: 'i', serviceInstanceName: 'me@host', title: '', round: 9, talks: 4, steps: 40, streams: 2, segments: 1, unresolved: 0, from: 50, to: 900 },
];

/** An OAP that tells the time and answers the list, oldest row first so the
 *  route's ordering is proven rather than inherited. */
function fakeOap(fail = false): { fetch: FetchLike; asked: (fragment: string) => Captured[] } {
  const calls: Captured[] = [];
  const fetch: FetchLike = async (_url, init) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as Captured;
    calls.push({ query: body.query ?? '', variables: body.variables ?? {} });
    if (body.query.includes('getTimeInfo')) return json({ data: { time: { timezone: '+0000' } } });
    if (body.query.includes('listConversations')) {
      if (fail) return new Response('boom', { status: 500 });
      return json({ data: { listConversations: { errorReason: null, conversations: ROWS } } });
    }
    return json({ data: {} });
  };
  return { fetch, asked: (fragment) => calls.filter((c) => c.query.includes(fragment)) };
}

function fakeConfig(overrides: Record<string, unknown> = {}): ConfigSource {
  const cfg = configSchema.parse(overrides);
  return { current: cfg, current_: () => cfg, path: '', onChange: () => () => {}, close: async () => {} };
}

async function build(
  fetchImpl: FetchLike,
  overrides: Record<string, unknown> = {},
  roles: string[] = ['admin'],
): Promise<{ app: FastifyInstance; cookie: string }> {
  const config = fakeConfig(overrides);
  const sessions = new SessionStore({ ttlMinutes: 60 });
  const app = Fastify();
  await app.register(cookie);
  // The server installs both hooks before any route; the cold-stage one is
  // what turns the request header into `req.coldStage`.
  registerColdStageHook(app);
  app.addHook('onRoute', makeRouteAuthHook({ config, sessions }));
  registerAiConversationRoutes(app, { config, sessions, fetch: fetchImpl });
  await app.ready();
  return { app, cookie: `horizon_sid=${sessions.create('op', roles).sid}` };
}

describe('POST /api/layer/:key/ai-conversations', () => {
  it('refuses a request that names no service', async () => {
    const { app, cookie: c } = await build(fakeOap().fetch);
    const res = await app.inject({ method: 'POST', url: '/api/layer/ai_agent/ai-conversations', headers: { cookie: c }, payload: {} });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'service_required' });
  });

  it('asks OAP by service name at the ceiling limit, in SECOND precision, and answers newest activity first', async () => {
    const oap = fakeOap();
    const { app, cookie: c } = await build(oap.fetch);
    const res = await app.inject({
      method: 'POST',
      url: '/api/layer/ai_agent/ai-conversations',
      headers: { cookie: c },
      payload: { service: 'Claude Code', startMs: NOW - DAY_MS, endMs: NOW },
    });
    expect(res.statusCode).toBe(200);
    const sent = oap.asked('listConversations')[0]!.variables;
    expect(sent.condition).toEqual({ service: { serviceName: 'Claude Code' }, limit: 10_000 });
    // The fake OAP sits at +0000, so the strings are the epoch range rendered
    // in UTC at SECOND precision.
    expect(sent.duration).toEqual({ start: fmtSecond(NOW - DAY_MS, 0), end: fmtSecond(NOW, 0), step: 'SECOND' });
    const body = res.json() as { reachable: boolean; limit: number; rows: Array<{ conversation: string }> };
    expect(body.reachable).toBe(true);
    expect(body.limit).toBe(10_000);
    expect(body.rows.map((r) => r.conversation)).toEqual(['new', 'old']);
  });

  it('forwards the sender filter, a smaller limit, and the cold-stage flag', async () => {
    const oap = fakeOap();
    const { app, cookie: c } = await build(oap.fetch);
    await app.inject({
      method: 'POST',
      url: '/api/layer/ai_agent/ai-conversations',
      headers: { cookie: c, 'x-horizon-cold-stage': '1' },
      payload: { service: 'Claude Code', instanceName: 'me@host', limit: 25 },
    });
    const sent = oap.asked('listConversations')[0]!.variables;
    expect(sent.condition).toEqual({
      service: { serviceName: 'Claude Code' },
      instance: { serviceName: 'Claude Code', instanceName: 'me@host' },
      limit: 25,
    });
    expect((sent.duration as { coldStage?: boolean }).coldStage).toBe(true);
  });

  it('answers reachable: false with the reason instead of failing', async () => {
    const { app, cookie: c } = await build(fakeOap(true).fetch);
    const res = await app.inject({
      method: 'POST',
      url: '/api/layer/ai_agent/ai-conversations',
      headers: { cookie: c },
      payload: { service: 'Claude Code' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { reachable: boolean; rows: unknown[]; error?: string };
    expect(body.reachable).toBe(false);
    expect(body.rows).toEqual([]);
    expect(body.error).toContain('500');
  });

  it('is gated on ai-conversation:read', async () => {
    const { app, cookie: c } = await build(fakeOap().fetch, { rbac: { roles: { nobody: ['metrics:read'] } } }, ['nobody']);
    const res = await app.inject({
      method: 'POST',
      url: '/api/layer/ai_agent/ai-conversations',
      headers: { cookie: c },
      payload: { service: 'Claude Code' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'permission_denied', verb: 'ai-conversation:read' });
  });
});

describe('GET /api/ai-conversation/:conversation/view', () => {
  let server: Server | null = null;

  afterEach(async () => {
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  });

  async function serveOap(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> {
    server = createServer(handler);
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  const DOC_GZIP = gzipSync(JSON.stringify({ format: 'asz.view', version: '1.0', conversation: 'c1' }));
  const JSON_TYPE = 'application/vnd.skywalking.asz.view+json; version=1.0; charset=utf-8';

  it('refuses a request that names no service', async () => {
    const { app, cookie: c } = await build(fakeOap().fetch);
    const res = await app.inject({ method: 'GET', url: '/api/ai-conversation/c1/view', headers: { cookie: c } });
    expect(res.statusCode).toBe(400);
  });

  it('relays the document compressed, with the headers that name it, and forwards the browser encoding', async () => {
    let seenEncoding: string | undefined;
    let path = '';
    const url = await serveOap((req, res) => {
      seenEncoding = req.headers['accept-encoding'];
      path = req.url ?? '';
      res.writeHead(200, { 'content-type': JSON_TYPE, 'content-encoding': 'gzip', 'vary': 'accept-encoding' });
      res.end(DOC_GZIP);
    });
    const { app, cookie: c } = await build(fakeOap().fetch, { oap: { queryUrl: url } });
    const res = await app.inject({
      method: 'GET',
      url: '/api/ai-conversation/c1/view?service=Claude%20Code&instance=me%40host',
      headers: { cookie: c, 'accept-encoding': 'gzip, deflate, br' },
    });
    expect(path).toBe('/ai-agent/conversations/c1/v1/view?service=Claude+Code&instance=me%40host');
    expect(seenEncoding).toBe('gzip, deflate, br');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe(JSON_TYPE);
    expect(res.headers['content-encoding']).toBe('gzip');
    expect(res.headers.vary).toBe('accept-encoding');
    expect(res.headers.server).toBeUndefined();
    expect(res.rawPayload.equals(DOC_GZIP)).toBe(true);
  });

  it('relays OAP problem+json with its own status', async () => {
    const problem = { type: 'about:blank', title: 'Not Found', status: 404, detail: 'no round of conversation c1 is stored for this service' };
    const url = await serveOap((_req, res) => {
      res.writeHead(404, { 'content-type': 'application/problem+json; charset=utf-8' });
      res.end(JSON.stringify(problem));
    });
    const { app, cookie: c } = await build(fakeOap().fetch, { oap: { queryUrl: url } });
    const res = await app.inject({ method: 'GET', url: '/api/ai-conversation/c1/view?service=x', headers: { cookie: c } });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.json()).toEqual(problem);
  });

  it('answers 504 when OAP sends nothing within the configured view timeout', async () => {
    const url = await serveOap(() => {
      /* never answers */
    });
    const { app, cookie: c } = await build(fakeOap().fetch, {
      oap: { queryUrl: url },
      performance: { aiConversation: { viewTimeoutMs: 100 } },
    });
    const res = await app.inject({ method: 'GET', url: '/api/ai-conversation/c1/view?service=x', headers: { cookie: c } });
    expect(res.statusCode).toBe(504);
    expect(res.json()).toMatchObject({ error: 'oap_timeout' });
  });

  it('answers 502 when OAP cannot be reached', async () => {
    const { app, cookie: c } = await build(fakeOap().fetch, { oap: { queryUrl: 'http://127.0.0.1:9' } });
    const res = await app.inject({ method: 'GET', url: '/api/ai-conversation/c1/view?service=x', headers: { cookie: c } });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ error: 'oap_unreachable' });
  });
});
