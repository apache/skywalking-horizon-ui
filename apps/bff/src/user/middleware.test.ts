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
 * The sliding-session contract has TWO halves that must move together: the
 * server-side TTL (SessionStore.touch) and the browser's cookie expiry. The
 * cookie is stamped at login only, so if the pre-handler stops re-stamping it
 * an actively-used session dies in the browser at login + ttl while the server
 * still considers it alive — the operator is logged out mid-session. These
 * cases pin the re-stamp (value, units, flags), and pin that an UNauthENTICATED
 * request is never handed a cookie.
 */

import { describe, it, expect } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { configSchema, type HorizonConfig } from '../config/schema.js';
import type { ConfigSource } from '../config/loader.js';
import { SessionStore } from './sessions.js';
import { requireAuth } from './middleware.js';

type SessionCfg = Partial<HorizonConfig['session']>;

/** A ConfigSource whose `current` can be swapped, mirroring a horizon.yaml hot-reload. */
function fakeConfig(session: SessionCfg = {}): { source: ConfigSource; reload: (next: SessionCfg) => void } {
  let cfg = configSchema.parse({ session });
  const source: ConfigSource = {
    get current() {
      return cfg;
    },
    current_: () => cfg,
    path: '',
    onChange: () => () => {},
    close: async () => {},
  };
  return { source, reload: (next) => void (cfg = configSchema.parse({ session: { ...session, ...next } })) };
}

async function buildApp(config: ConfigSource, sessions: SessionStore): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(cookie);
  app.get('/whoami', { preHandler: requireAuth({ config, sessions }) }, async (req) => ({
    username: req.session?.username ?? null,
    roles: req.session?.roles ?? null,
  }));
  await app.ready();
  return app;
}

interface SetCookie {
  name: string;
  value: string;
  attrs: Map<string, string>;
}

function setCookieOf(headers: Record<string, unknown>): SetCookie | undefined {
  const raw = headers['set-cookie'];
  const header = Array.isArray(raw) ? raw[0] : raw;
  if (typeof header !== 'string') return undefined;
  const [pair, ...rest] = header.split('; ');
  const eq = pair.indexOf('=');
  const attrs = new Map(
    rest.map((part) => {
      const i = part.indexOf('=');
      return i === -1
        ? ([part.toLowerCase(), ''] as const)
        : ([part.slice(0, i).toLowerCase(), part.slice(i + 1)] as const);
    }),
  );
  return { name: pair.slice(0, eq), value: pair.slice(eq + 1), attrs };
}

describe('requireAuth — the sliding-cookie re-stamp', () => {
  it('re-stamps the session cookie on every authenticated request', async () => {
    const { source } = fakeConfig({ ttlMinutes: 15 });
    const sessions = new SessionStore({ ttlMinutes: 15 });
    const app = await buildApp(source, sessions);
    const { sid } = sessions.create('alice', ['admin']);

    const res = await app.inject({ method: 'GET', url: '/whoami', headers: { cookie: `horizon_sid=${sid}` } });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ username: 'alice', roles: ['admin'] });

    const stamped = setCookieOf(res.headers);
    expect(stamped?.name).toBe('horizon_sid');
    // Same sid — the re-stamp slides the expiry, it does not rotate the session.
    expect(stamped?.value).toBe(sid);
    // Max-Age is SECONDS: 15 minutes must be 900, not 900000 and not 15.
    expect(stamped?.attrs.get('max-age')).toBe('900');
    await app.close();
  });

  it('mirrors the login cookie flags exactly, so only maxAge slides', async () => {
    const { source } = fakeConfig({ ttlMinutes: 60, cookieSecure: true });
    const sessions = new SessionStore({ ttlMinutes: 60 });
    const app = await buildApp(source, sessions);
    const { sid } = sessions.create('alice', ['admin']);

    const res = await app.inject({ method: 'GET', url: '/whoami', headers: { cookie: `horizon_sid=${sid}` } });
    const stamped = setCookieOf(res.headers);

    expect(stamped?.attrs.has('httponly')).toBe(true);
    expect(stamped?.attrs.get('samesite')).toBe('Strict');
    expect(stamped?.attrs.get('path')).toBe('/');
    expect(stamped?.attrs.has('secure')).toBe(true);
    expect(stamped?.attrs.get('max-age')).toBe('3600');
    await app.close();
  });

  it('leaves Secure off when the deployment is plain HTTP (cookieSecure false)', async () => {
    const { source } = fakeConfig({ cookieSecure: false });
    const sessions = new SessionStore({ ttlMinutes: 60 });
    const app = await buildApp(source, sessions);
    const { sid } = sessions.create('alice', ['admin']);

    const res = await app.inject({ method: 'GET', url: '/whoami', headers: { cookie: `horizon_sid=${sid}` } });

    expect(setCookieOf(res.headers)?.attrs.has('secure')).toBe(false);
    await app.close();
  });

  it('picks up a new ttlMinutes from a config reload without a restart', async () => {
    const { source, reload } = fakeConfig({ ttlMinutes: 15 });
    const sessions = new SessionStore({ ttlMinutes: 15 });
    const app = await buildApp(source, sessions);
    const { sid } = sessions.create('alice', ['admin']);
    const call = () => app.inject({ method: 'GET', url: '/whoami', headers: { cookie: `horizon_sid=${sid}` } });

    expect(setCookieOf((await call()).headers)?.attrs.get('max-age')).toBe('900');
    reload({ ttlMinutes: 30 });
    expect(setCookieOf((await call()).headers)?.attrs.get('max-age')).toBe('1800');
    await app.close();
  });

  it('picks up a renamed session cookie from a config reload without a restart', async () => {
    const { source, reload } = fakeConfig({ cookieName: 'horizon_sid' });
    const sessions = new SessionStore({ ttlMinutes: 60 });
    const app = await buildApp(source, sessions);
    const { sid } = sessions.create('alice', ['admin']);
    const call = (name: string) =>
      app.inject({ method: 'GET', url: '/whoami', headers: { cookie: `${name}=${sid}` } });

    expect((await call('horizon_sid')).statusCode).toBe(200);
    reload({ cookieName: 'sw_sid' });

    // The name has to be re-read per request, not captured when the handler was
    // wired: login stamps the new name immediately, so a pre-handler still
    // looking for the old one 401s every request until the process restarts.
    const renamed = await call('sw_sid');
    expect(renamed.statusCode).toBe(200);
    expect(setCookieOf(renamed.headers)?.name).toBe('sw_sid');
    expect((await call('horizon_sid')).statusCode).toBe(401);
    await app.close();
  });

  it('reads and writes the configured cookie name, not a hard-coded one', async () => {
    const { source } = fakeConfig({ cookieName: 'sw_sid' });
    const sessions = new SessionStore({ ttlMinutes: 60 });
    const app = await buildApp(source, sessions);
    const { sid } = sessions.create('alice', ['admin']);

    const ok = await app.inject({ method: 'GET', url: '/whoami', headers: { cookie: `sw_sid=${sid}` } });
    expect(ok.statusCode).toBe(200);
    expect(setCookieOf(ok.headers)?.name).toBe('sw_sid');

    const wrongName = await app.inject({ method: 'GET', url: '/whoami', headers: { cookie: `horizon_sid=${sid}` } });
    expect(wrongName.statusCode).toBe(401);
    await app.close();
  });

  it('slides the server-side TTL as well as the cookie', async () => {
    const { source } = fakeConfig({ ttlMinutes: 60 });
    const sessions = new SessionStore({ ttlMinutes: 60 });
    const app = await buildApp(source, sessions);
    const session = sessions.create('alice', ['admin']);
    // Age the session to 30 minutes idle — still inside the TTL.
    const aged = Date.now() - 30 * 60_000;
    session.lastSeenAt = aged;

    const res = await app.inject({ method: 'GET', url: '/whoami', headers: { cookie: `horizon_sid=${session.sid}` } });

    expect(res.statusCode).toBe(200);
    const after = sessions.get(session.sid)?.lastSeenAt ?? 0;
    expect(after).toBeGreaterThan(aged);
    expect(Date.now() - after).toBeLessThan(5_000);
    await app.close();
  });
});

describe('requireAuth — rejection never hands out a cookie', () => {
  it('401s a request with no session cookie and stamps nothing', async () => {
    const { source } = fakeConfig();
    const sessions = new SessionStore({ ttlMinutes: 60 });
    const app = await buildApp(source, sessions);

    const res = await app.inject({ method: 'GET', url: '/whoami' });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'unauthenticated' });
    expect(res.headers['set-cookie']).toBeUndefined();
    await app.close();
  });

  it('401s an unknown sid without minting a session for it', async () => {
    const { source } = fakeConfig();
    const sessions = new SessionStore({ ttlMinutes: 60 });
    const app = await buildApp(source, sessions);

    const res = await app.inject({ method: 'GET', url: '/whoami', headers: { cookie: 'horizon_sid=forged' } });

    expect(res.statusCode).toBe(401);
    // Never echo an attacker-chosen sid back with a fresh expiry.
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(sessions.size()).toBe(0);
    await app.close();
  });

  it('401s an expired session, drops it, and does not extend its cookie', async () => {
    const { source } = fakeConfig({ ttlMinutes: 60 });
    const sessions = new SessionStore({ ttlMinutes: 60 });
    const app = await buildApp(source, sessions);
    const session = sessions.create('alice', ['admin']);
    session.lastSeenAt = Date.now() - 61 * 60_000;

    const res = await app.inject({ method: 'GET', url: '/whoami', headers: { cookie: `horizon_sid=${session.sid}` } });

    expect(res.statusCode).toBe(401);
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(sessions.size()).toBe(0);
    await app.close();
  });
});
