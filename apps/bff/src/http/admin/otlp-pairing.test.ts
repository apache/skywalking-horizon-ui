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
 * The OTLP pairing routes pass OAP's pairing capture through: a read takes `live-debug:read` and is cancelled when the
 * browser leaves, start and stop take `live-debug:write`, and a bad limit never reaches OAP.
 */
import { describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import type { FetchLike } from '@skywalking-horizon-ui/api-client';
import { configSchema } from '../../config/schema.js';
import type { ConfigSource } from '../../config/loader.js';
import { SessionStore } from '../../user/sessions.js';
import { makeRouteAuthHook } from '../../rbac/route-policy.js';
import { registerOtlpPairingRoutes } from './otlp-pairing.js';

function fakeConfig(): ConfigSource {
  // A role that may watch a capture but not run one, beside the built-in roles.
  const cfg = configSchema.parse({ rbac: { builtinRoles: 'keep', roles: { watcher: ['live-debug:read'] } } });
  return { current: cfg, current_: () => cfg, path: '', onChange: () => () => {}, close: async () => {} };
}

interface Seen {
  url: string;
  method: string;
  signal: AbortSignal | null;
}

async function buildApp(
  answer: (url: string, signal: AbortSignal | null) => Response | Promise<Response>,
): Promise<{ app: FastifyInstance; sessions: SessionStore; seen: Seen[] }> {
  const seen: Seen[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const signal = (init?.signal as AbortSignal | undefined) ?? null;
    seen.push({ url: String(url), method: init?.method ?? 'GET', signal });
    return answer(String(url), signal);
  };
  const config = fakeConfig();
  const sessions = new SessionStore({ ttlMinutes: 60 });
  const app = Fastify();
  await app.register(cookie);
  app.addHook('onRoute', makeRouteAuthHook({ config, sessions }));
  registerOtlpPairingRoutes(app, { config, sessions, fetch: fetchImpl });
  await app.ready();
  return { app, sessions, seen };
}

const ok = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200 });

describe('OTLP pairing routes', () => {
  it('reads the pairings, and refuses a bad limit before OAP', async () => {
    const { app, sessions, seen } = await buildApp(() => ok({ state: 'off', nodes: [] }));
    const sid = sessions.create('op', ['operator']).sid;
    const read = await app.inject({ method: 'GET', url: '/api/otlp-pairing/pairings?limit=10', headers: { cookie: `horizon_sid=${sid}` } });
    expect(read.statusCode).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toMatch(/\/trace-pairing-debugging\/pairings\?limit=10$/);

    const bad = await app.inject({ method: 'GET', url: '/api/otlp-pairing/pairings?limit=0', headers: { cookie: `horizon_sid=${sid}` } });
    expect(bad.statusCode).toBe(400);
    expect(seen, 'never sent').toHaveLength(1);
    await app.close();
  });

  it('passes OAP\'s 404 through, so the page can say OAP does not serve the capture', async () => {
    const { app, sessions } = await buildApp(() => new Response('{"code":"not_found"}', { status: 404 }));
    const sid = sessions.create('op', ['operator']).sid;
    const res = await app.inject({ method: 'GET', url: '/api/otlp-pairing/pairings', headers: { cookie: `horizon_sid=${sid}` } });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('cancels the read at OAP when the browser hangs up', async () => {
    let cancelled = false;
    const { app, sessions } = await buildApp((_url, signal) => new Promise<Response>((_resolve, reject) => {
      signal?.addEventListener('abort', () => {
        cancelled = true;
        reject(new Error('aborted'));
      });
    }));
    const sid = sessions.create('op', ['operator']).sid;
    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    const browser = new AbortController();
    const read = fetch(`http://127.0.0.1:${port}/api/otlp-pairing/pairings`, {
      headers: { cookie: `horizon_sid=${sid}` },
      signal: browser.signal,
    }).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 50));
    browser.abort();
    await read;
    await new Promise((r) => setTimeout(r, 100));
    expect(cancelled, 'an abandoned read stops costing OAP').toBe(true);
    await app.close();
  });

  it('lets a watcher read but not start or stop, and keeps a role without the verbs out of all three', async () => {
    const { app, sessions, seen } = await buildApp(() => ok({ state: 'off', nodes: [] }));
    const watcher = sessions.create('w', ['watcher']).sid;
    const viewer = sessions.create('v', ['viewer']).sid;
    const calls = [['GET', '/api/otlp-pairing/pairings'], ['POST', '/api/otlp-pairing/start'], ['POST', '/api/otlp-pairing/stop']] as const;
    const asWatcher = [];
    for (const [method, url] of calls) {
      asWatcher.push((await app.inject({ method, url, headers: { cookie: `horizon_sid=${watcher}` } })).statusCode);
    }
    expect(asWatcher).toEqual([200, 403, 403]);
    for (const [method, url] of calls) {
      const res = await app.inject({ method, url, headers: { cookie: `horizon_sid=${viewer}` } });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
    }
    expect(seen.map((s) => s.method), 'only the watcher\'s read reached OAP').toEqual(['GET']);
    await app.close();
  });

});
