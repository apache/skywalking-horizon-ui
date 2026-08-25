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
 * What the single sign-on callback RECORDS.
 *
 * The audit emit sites live at the end of a route nothing else registers in a
 * test, so every property the audit log claims about single sign-on rested on
 * reading the code. These drive the real route through `app.inject` with the
 * provider stubbed, and assert on what reached the service.
 *
 * The three properties, and why each matters:
 *  - a verified sign-in records exactly one row, attributed to the provider
 *    registration that produced it;
 *  - an identity the provider verified but Horizon refuses on policy records
 *    exactly one refusal AND creates no session;
 *  - a failure BEFORE any identity exists records nothing, which is what keeps
 *    the table unreachable by an unauthenticated caller.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair, type CryptoKey } from 'jose';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { configSchema, type HorizonConfig } from '../../config/schema.js';
import type { ConfigSource } from '../../config/loader.js';
import { SessionStore } from '../sessions.js';
import { UserSeenCache } from '../seen-cache.js';
import { registerOidcRoutes } from './route.js';
import { clearDiscoveryCache } from './discovery.js';
import type { AuditEvent, AuditService } from '../../store/audit/types.js';

const ISSUER = 'https://idp.example';
const EMAIL = 'dev@example.com';

function config(over: Record<string, unknown> = {}): HorizonConfig {
  return configSchema.parse({
    server: { publicUrl: 'https://horizon.example' },
    rbac: { enabled: true },
    auth: {
      backend: 'local',
      sso: {
        providers: [
          {
            id: 'p',
            kind: 'oauth2',
            clientId: 'client-abc',
            clientSecret: 'SECRET-must-not-be-recorded',
            authorizationEndpoint: `${ISSUER}/auth`,
            tokenEndpoint: `${ISSUER}/token`,
            userinfoEndpoint: `${ISSUER}/userinfo`,
            emailVerifiedPath: 'email_verified',
          },
        ],
        roles: { defaultRoles: ['viewer'] },
        ...over,
      },
    },
  }) as HorizonConfig;
}

/** Records what the routes hand the audit service, and nothing else. */
function recorder(): { events: Array<Omit<AuditEvent, 'shape'>>; service: AuditService } {
  const events: Array<Omit<AuditEvent, 'shape'>> = [];
  const service = {
    recordEvent: (e: Omit<AuditEvent, 'shape'>) => void events.push(e),
    query: async () => ({ rows: [], pageNum: 1, pageSize: 0, hasNext: false }),
    queryStat: async () => ({ columns: [], overBudget: 0, writeUncertain: 0, tokenLost: 0, horizonNodes: 0 }),
    health: async () => ({}) as never,
    start: async () => {},
    stop: async () => {},
  } as unknown as AuditService;
  return { events, service };
}

async function build(cfg: HorizonConfig, audit: AuditService, fetchImpl: typeof fetch) {
  const app: FastifyInstance = Fastify();
  await app.register(cookie);
  const source: ConfigSource = {
    current: cfg, path: '', current_: () => cfg, onChange: () => () => {}, close: async () => {},
  };
  const sessions = new SessionStore({ ttlMinutes: () => 60 });
  registerOidcRoutes(app, {
    config: source, sessions, seenCache: new UserSeenCache(), audit, fetch: fetchImpl,
  } as never);
  await app.ready();
  return { app, sessions };
}

/** Drives /start to mint a real flow, then feeds its state back to /callback. */
async function signIn(app: FastifyInstance, opts: { state?: string } = {}) {
  const start = await app.inject({ method: 'GET', url: '/api/auth/oidc/start?provider=p' });
  const location = start.headers.location as string;
  if (!location || location.includes('sso_error')) {
    throw new Error(`/start did not begin a sign-in: ${start.statusCode} ${location}`);
  }
  const state = opts.state ?? new URL(location, 'https://x').searchParams.get('state');
  const setCookie = start.headers['set-cookie'];
  return app.inject({
    method: 'GET',
    url: `/api/auth/oidc/callback?code=CODE-must-not-be-recorded&state=${encodeURIComponent(state ?? '')}`,
    headers: { cookie: Array.isArray(setCookie) ? setCookie.join('; ') : String(setCookie ?? '') },
  });
}

function provider(email: string | null, verified = true): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/token')) {
      return new Response(JSON.stringify({ access_token: 'TOKEN-must-not-be-recorded' }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    if (url.endsWith('/userinfo')) {
      return new Response(JSON.stringify({ email, email_verified: verified }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
}

beforeEach(() => clearDiscoveryCache());

describe('what the single sign-on callback records', () => {
  it('records exactly one accepted row, attributed to the registration used', async () => {
    const { events, service } = recorder();
    const { app } = await build(config(), service, provider(EMAIL));

    await signIn(app);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'sso',
      outcome: 1,
      username: EMAIL,
      mail: EMAIL,
      provider: 'p',
      // Recorded because config stops holding it once a registration is
      // replaced — see the audit docs.
    });
    expect(events[0].reason).toBeUndefined();
  });

  /** Authenticated by the provider, refused by OUR policy: one of only two
   *  refusals the table admits, and the only kind that carries a principal. */
  it('records one no_roles refusal for a verified identity with no roles', async () => {
    const { events, service } = recorder();
    const cfg = config({ roles: { defaultRoles: [] } });
    const { app, sessions } = await build(cfg, service, provider(EMAIL));

    const res = await signIn(app);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'sso', outcome: 0, reason: 'no_roles', username: EMAIL });
    // Refused means refused: no session, and the browser goes back to login.
    expect(sessions.size()).toBe(0);
    expect(res.headers.location).toMatch(/sso_error=no_roles/);
  });

  /**
   * The property the whole valid-credential-only rule exists for. A caller who
   * never proved anything must leave no row — otherwise the table is
   * writable by anyone who can reach the callback.
   */
  it('records nothing when the failure happens before an identity exists', async () => {
    const { events, service } = recorder();
    const { app } = await build(config(), service, provider(EMAIL));

    // A state that matches no in-flight sign-in.
    const forged = await app.inject({
      method: 'GET',
      url: '/api/auth/oidc/callback?code=CODE-must-not-be-recorded&state=not-a-real-state',
    });
    expect(forged.headers.location).toMatch(/sso_error=/);
    expect(events).toEqual([]);
  });

  it('records nothing when the provider reports an unverified address', async () => {
    const { events, service } = recorder();
    const { app } = await build(config(), service, provider(EMAIL, false));

    await signIn(app);
    expect(events).toEqual([]);
  });

  /** Nothing that could resume a session, and nothing the provider echoed. */
  it('never carries a code, a token or any exchange material into the row', async () => {
    const { events, service } = recorder();
    const { app } = await build(config(), service, provider(EMAIL));

    await signIn(app);

    const serialized = JSON.stringify(events);
    for (const secret of [
      'CODE-must-not-be-recorded',
      'SECRET-must-not-be-recorded',
      'TOKEN-must-not-be-recorded',
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });
});

/**
 * The OIDC path, where the identity comes from a SIGNED ID token rather than a
 * userinfo call.
 *
 * Structurally the emit sites are the same calls the OAuth2 tests already
 * cover — but "structurally the same" is reasoning, not coverage, and this is
 * the branch that verifies a signature, checks issuer and audience, and binds
 * the nonce. A regression here would be invisible to every other test.
 */
describe('what the OIDC callback records', () => {
  let keyPair: { publicKey: CryptoKey; privateKey: CryptoKey };
  let jwks: string;

  beforeEach(async () => {
    keyPair = await generateKeyPair('ES256', { extractable: true });
    jwks = JSON.stringify({ keys: [{ ...(await exportJWK(keyPair.publicKey)), kid: 'k1', alg: 'ES256' }] });
    // `createRemoteJWKSet` fetches with the GLOBAL fetch, not the injected
    // one, so the key set has to be served here.
    vi.stubGlobal('fetch', (async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/jwks')) {
        return new Response(jwks, { status: 200, headers: { 'content-type': 'application/json' } });
      }
      throw new Error(`unexpected global fetch: ${String(input)}`);
    }) as unknown as typeof fetch);
  });
  afterEach(() => vi.unstubAllGlobals());

  function oidcConfig(over: Record<string, unknown> = {}): HorizonConfig {
    return configSchema.parse({
      server: { publicUrl: 'https://horizon.example' },
      rbac: { enabled: true },
      auth: {
        backend: 'local',
        sso: {
          providers: [{ id: 'p', kind: 'oidc', issuer: ISSUER, clientId: 'client-abc', clientSecret: 'SECRET-must-not-be-recorded' }],
          roles: { defaultRoles: ['viewer'] },
          ...over,
        },
      },
    }) as HorizonConfig;
  }

  /** Discovery + token endpoint. The ID token carries the nonce the route
   *  minted, read back out of the authorize redirect. */
  function oidcProvider(nonceOf: () => string, claims: Record<string, unknown> = {}): typeof fetch {
    return (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('.well-known/openid-configuration')) {
        return new Response(
          JSON.stringify({
            issuer: ISSUER,
            authorization_endpoint: `${ISSUER}/auth`,
            token_endpoint: `${ISSUER}/token`,
            jwks_uri: `${ISSUER}/jwks`,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.endsWith('/token')) {
        const idToken = await new SignJWT({
          email: EMAIL,
          email_verified: true,
          nonce: nonceOf(),
          ...claims,
        })
          .setProtectedHeader({ alg: 'ES256', kid: 'k1' })
          .setIssuer(ISSUER)
          .setAudience('client-abc')
          .setSubject('subject-1')
          .setIssuedAt()
          .setExpirationTime('5m')
          .sign(keyPair.privateKey);
        return new Response(JSON.stringify({ id_token: idToken }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`unexpected provider fetch: ${url}`);
    }) as unknown as typeof fetch;
  }

  it('records one accepted row from a verified ID token', async () => {
    const { events, service } = recorder();
    let nonce = '';
    const { app } = await build(oidcConfig(), service, oidcProvider(() => nonce));

    const start = await app.inject({ method: 'GET', url: '/api/auth/oidc/start?provider=p' });
    const location = start.headers.location as string;
    const authorize = new URL(location);
    nonce = authorize.searchParams.get('nonce') ?? '';
    const state = authorize.searchParams.get('state') ?? '';
    const setCookie = start.headers['set-cookie'];
    await app.inject({
      method: 'GET',
      url: `/api/auth/oidc/callback?code=CODE-must-not-be-recorded&state=${encodeURIComponent(state)}`,
      headers: { cookie: Array.isArray(setCookie) ? setCookie.join('; ') : String(setCookie ?? '') },
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'sso',
      outcome: 1,
      username: EMAIL,
      provider: 'p',
      // The distinction the two SSO protocols exist as separate series for.
    });
  });

  /** The nonce binds the token to the browser that began this sign-in. A
   *  token that verifies but carries someone else's nonce is a replay, and
   *  must record nothing. */
  it('records nothing when the ID token carries the wrong nonce', async () => {
    const { events, service } = recorder();
    const { app } = await build(oidcConfig(), service, oidcProvider(() => 'a-different-nonce'));

    const start = await app.inject({ method: 'GET', url: '/api/auth/oidc/start?provider=p' });
    const authorize = new URL(start.headers.location as string);
    const setCookie = start.headers['set-cookie'];
    const res = await app.inject({
      method: 'GET',
      url: `/api/auth/oidc/callback?code=c&state=${encodeURIComponent(authorize.searchParams.get('state') ?? '')}`,
      headers: { cookie: Array.isArray(setCookie) ? setCookie.join('; ') : String(setCookie ?? '') },
    });

    expect(res.headers.location).toMatch(/sso_error=/);
    expect(events).toEqual([]);
  });

  /** A correctly signed token whose claims are the wrong SHAPE used to reach
   *  a string comparison as a number and throw out of the handler as a 500. */
  it('refuses a numeric nonce rather than failing with a 500', async () => {
    const { events, service } = recorder();
    const { app } = await build(oidcConfig(), service, oidcProvider(() => '', { nonce: 12345 }));

    const start = await app.inject({ method: 'GET', url: '/api/auth/oidc/start?provider=p' });
    const authorize = new URL(start.headers.location as string);
    const setCookie = start.headers['set-cookie'];
    const res = await app.inject({
      method: 'GET',
      url: `/api/auth/oidc/callback?code=c&state=${encodeURIComponent(authorize.searchParams.get('state') ?? '')}`,
      headers: { cookie: Array.isArray(setCookie) ? setCookie.join('; ') : String(setCookie ?? '') },
    });

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toMatch(/sso_error=/);
    expect(events).toEqual([]);
  });
});
