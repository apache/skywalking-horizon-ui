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

import { describe, it, expect, beforeEach } from 'vitest';
import { OAuthTokenResolver, issueAccessToken } from './tokens.js';
import { RoleResolver } from '../user/roles.js';
import { readFileSync } from 'node:fs';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { configSchema } from '../config/schema.js';
import { requireBrowserSession } from '../user/middleware.js';
import { sessionHasVerb } from '../rbac/policy.js';
import { sign, verify } from './signing.js';
import { readClient, redirectAllowed, redirectUriAcceptable, registerClient } from './clients.js';
import { parseScope, verbCapFor, grantedVerbs, DEFAULT_SCOPE } from './scopes.js';
import {
  clearClientMetadataCache,
  fetchClientMetadata,
  isMetadataUrl,
  isPublicAddress,
} from './client-metadata.js';

const KEY = 'test-signing-key';

describe('signed values are the store this server does not have', () => {
  it('round-trips a value of the right kind', () => {
    const t = sign(KEY, 'code', { sub: 'ada' });
    expect(verify<{ sub: string }>(KEY, 'code', t)).toEqual({ sub: 'ada' });
  });

  // The kind is INSIDE the signed material, so a token cannot be replayed as
  // an authorization code, nor a code as a client registration.
  it('refuses a correctly-signed value of the wrong kind', () => {
    expect(verify(KEY, 'access', sign(KEY, 'code', { sub: 'ada' }))).toBeNull();
  });

  it('refuses a value signed with another key — which is what key rotation is', () => {
    expect(verify(KEY, 'code', sign('other-key', 'code', { sub: 'ada' }))).toBeNull();
  });

  it('refuses a tampered payload', () => {
    const t = sign(KEY, 'code', { sub: 'ada' });
    const [payload, mac] = t.split('.');
    const forged = Buffer.from(JSON.stringify({ kind: 'code', data: { sub: 'root' } })).toString('base64url');
    expect(verify(KEY, 'code', `${forged}.${mac}`)).toBeNull();
    expect(verify(KEY, 'code', `${payload}.${mac.slice(0, -1)}x`)).toBeNull();
  });

  it('refuses an expired value', () => {
    expect(verify(KEY, 'code', sign(KEY, 'code', { sub: 'ada' }, -1))).toBeNull();
  });

  it('refuses malformed input without throwing', () => {
    for (const bad of ['', 'nodot', '.', 'a.b.c', '!!!.!!!']) {
      expect(() => verify(KEY, 'code', bad)).not.toThrow();
      expect(verify(KEY, 'code', bad)).toBeNull();
    }
  });
});

describe('redirect matching', () => {
  const client = registerClient(KEY, { redirectUris: ['http://127.0.0.1:51234/callback'] });
  const uris = readClient(KEY, client)!.redirectUris;

  it('reads back what was registered', () => {
    expect(uris).toEqual(['http://127.0.0.1:51234/callback']);
    expect(readClient(KEY, 'hzc_garbage')).toBeNull();
    expect(readClient(KEY, 'not-a-client-id')).toBeNull();
  });

  // RFC 8252 §7.3, and not a nicety: Claude Code binds a fresh ephemeral port
  // every session, so without this a client logs in exactly once.
  it('ignores the port on a loopback redirect', () => {
    expect(redirectAllowed(uris, 'http://127.0.0.1:51234/callback')).toBe(true);
    expect(redirectAllowed(uris, 'http://127.0.0.1:60999/callback')).toBe(true);
  });

  it('still matches host and path on loopback', () => {
    expect(redirectAllowed(uris, 'http://127.0.0.1:60999/elsewhere')).toBe(false);
    expect(redirectAllowed(uris, 'http://localhost:60999/callback')).toBe(false);
  });

  // The port exception is confined to loopback. Anywhere else it would let
  // whoever can bind a port on that host collect someone else's code.
  it('never relaxes the port off loopback', () => {
    const https = readClient(KEY, registerClient(KEY, { redirectUris: ['https://app.example/cb'] }))!.redirectUris;
    expect(redirectAllowed(https, 'https://app.example/cb')).toBe(true);
    expect(redirectAllowed(https, 'https://app.example:8443/cb')).toBe(false);
    expect(redirectAllowed(https, 'https://evil.example/cb')).toBe(false);
  });

  it('accepts only redirects a code can safely travel to', () => {
    expect(redirectUriAcceptable('https://app.example/cb')).toBe(true);
    expect(redirectUriAcceptable('http://127.0.0.1:1234/cb')).toBe(true);
    expect(redirectUriAcceptable('http://localhost/cb')).toBe(true);
    expect(redirectUriAcceptable('myapp://cb')).toBe(true);
    // A code in a URL over plain HTTP to a remote host is a code on the wire.
    expect(redirectUriAcceptable('http://app.example/cb')).toBe(false);
    expect(redirectUriAcceptable('javascript:alert(1)')).toBe(false);
    expect(redirectUriAcceptable('data:text/html,x')).toBe(false);
    expect(redirectUriAcceptable('not a url')).toBe(false);
  });
});

describe('a scope narrows access and can never widen it', () => {
  const config = configSchema.parse({});

  it('defaults to read-only when the client asks for nothing', () => {
    expect(parseScope(undefined).scopes).toEqual([DEFAULT_SCOPE]);
    expect(parseScope('').scopes).toEqual(['horizon:read']);
  });

  // Silently dropping an unknown scope hands the client a token that fails
  // later, somewhere unrelated, with no clue its scope was not the one it asked
  // for.
  it('refuses an unknown scope rather than dropping it', () => {
    expect(parseScope('horizon:read horizon:everything').unknown).toBe('horizon:everything');
    expect(parseScope('horizon:read horizon:everything').scopes).toEqual([]);
  });

  it('caps reads only for horizon:read, and not at all for horizon:full', () => {
    expect(verbCapFor(['horizon:read'])).toEqual(['*:read']);
    expect(verbCapFor(['horizon:full'])).toBeUndefined();
  });

  /**
   * The two halves of the guarantee, and both matter:
   * the SCOPE stops an admin's agent writing, and the ROLES stop a viewer
   * granting more than a viewer has.
   */
  it('stops an admin lending write access under a read scope', () => {
    const admin = { roles: ['admin'], verbCap: verbCapFor(['horizon:read']) };
    expect(sessionHasVerb(config, admin, 'metrics:read')).toBe(true);
    expect(sessionHasVerb(config, admin, 'overview:write')).toBe(false);
    expect(sessionHasVerb(config, admin, 'user:write')).toBe(false);
  });

  it('leaves a viewer a viewer even under the full scope', () => {
    const viewer = { roles: ['viewer'], verbCap: verbCapFor(['horizon:full']) };
    expect(sessionHasVerb(config, viewer, 'metrics:read')).toBe(true);
    expect(sessionHasVerb(config, viewer, 'user:read')).toBe(false);
    expect(sessionHasVerb(config, viewer, 'overview:write')).toBe(false);
  });

  it('leaves an uncapped credential exactly its user, as a cookie session is', () => {
    expect(sessionHasVerb(config, { roles: ['admin'] }, 'user:write')).toBe(true);
    expect(sessionHasVerb(config, { roles: ['viewer'] }, 'user:write')).toBe(false);
  });

  // The consent screen must not promise access the user cannot delegate — a
  // viewer consenting to horizon:full should not read "change alarm rules".
  it('shows only verbs the signed-in user actually holds', () => {
    const shown = grantedVerbs(config, ['viewer'], ['horizon:full']);
    expect(shown).toContain('metrics:read');
    expect(shown).not.toContain('user:write');
    expect(grantedVerbs(config, ['viewer'], ['horizon:read']).every((v) => v.endsWith(':read'))).toBe(true);
  });
});


describe('a grant is issued by a person, never by a credential acting for one', () => {
  const spy = (): { reply: FastifyReply; sent: { code?: number; body?: Record<string, string> } } => {
    const sent: { code?: number; body?: Record<string, string> } = {};
    const reply = {
      code(c: number) { sent.code = c; return this; },
      send(b: Record<string, string>) { sent.body = b; return this; },
    } as unknown as FastifyReply;
    return { reply, sent };
  };

  it('admits a browser session', () => {
    const { reply, sent } = spy();
    expect(requireBrowserSession({ authKind: 'session' } as FastifyRequest, reply)).toBe(true);
    expect(sent.code).toBeUndefined();
  });

  /**
   * The escalation this exists to stop: an agent holding a `horizon:read`
   * token registers a client, drives /authorize, approves its OWN consent for
   * `horizon:full`, and redeems a token wider than the one it was given. The
   * scope cap is enforced perfectly on every data route and is worth nothing
   * if the grant itself can be self-issued.
   */
  it.each(['oauth-token', 'api-token', undefined])('refuses %s', (kind) => {
    const { reply, sent } = spy();
    expect(requireBrowserSession({ authKind: kind } as FastifyRequest, reply)).toBe(false);
    expect(sent.code).toBe(403);
    expect(sent.body?.error).toBe('browser_session_required');
  });

  // Both consent routes, not just the POST: the GET reports whose access is
  // about to be lent out, which is not a token's business either.
  it('is applied to both consent routes', () => {
    const src = readFileSync(new URL('./route.ts', import.meta.url), 'utf8');
    const starts = [...src.matchAll(/app\.(get|post)\('\/api\/oauth\/consent'/g)];
    expect(starts.length, 'both consent routes').toBe(2);
    for (const m of starts) {
      // The guard is the first thing each handler does after the enabled()
      // check, so a generous window is enough and stays readable.
      const head = src.slice(m.index!, m.index! + 500);
      expect(head, `${m[1].toUpperCase()} /api/oauth/consent must gate on a browser session`)
        .toContain('requireBrowserSession');
    }
  });

  /**
   * The consent screen showed the one identity nobody checked and hid the one
   * Horizon verified.
   *
   * A registered client's name is free text from an unauthenticated call. A
   * client-id metadata client's id is a URL whose document had to name the same
   * id back — a real check — but `readClient` returns null for it (the id is
   * not an `hzc_` handle), so the screen fell back to the anonymous phrasing
   * and the URL never reached the UI at all. So the name is now carried in the
   * SIGNED request rather than looked up, and the URL is sent as a distinct
   * field the screen can label as verified.
   */
  it('carries the client name in the signed request, and marks a URL identity as such', () => {
    const src = readFileSync(new URL('./route.ts', import.meta.url), 'utf8');
    // The name is put INTO the request at /authorize…
    expect(src, 'the resolved client name must be signed into the request')
      .toMatch(/clientName:\s*client\.clientName/);
    // …and read back from it, not re-looked-up, since the lookup cannot work.
    expect(src, 'consent must read the name from the request')
      .toMatch(/clientName:\s*request\.clientName/);
    expect(src, 'a URL-identified client must be reported as one')
      .toMatch(/clientUrl:\s*isMetadataUrl\(request\.clientId\)/);
  });
});


describe('a protocol error is not a way to bounce someone off this site', () => {
  /**
   * Registration is unauthenticated by spec, so anyone can register
   * `https://evil.example` and then hand out a Horizon link with a malformed
   * `response_type`. Returning the RFC's redirect there makes this server an
   * open redirector with no consent screen and no interaction — on a URL that
   * looks like ours.
   */
  it('refuses to forward an error to a non-loopback redirect', () => {
    const src = readFileSync(new URL('./route.ts', import.meta.url), 'utf8');
    const fn = /function redirectError[\s\S]*?\n}/.exec(src)?.[0] ?? '';
    expect(fn, 'redirectError must test for loopback before redirecting').toMatch(/loopback/);
    expect(fn).toMatch(/127\.0\.0\.1/);
    // And the non-loopback path must ANSWER rather than silently drop.
    expect(fn).toContain('oauthError(');
  });

  // Loopback is where every real client of this server lives, and a redirect to
  // the victim's own machine carries nobody anywhere.
  it('still forwards to loopback, where the clients actually are', () => {
    const src = readFileSync(new URL('./route.ts', import.meta.url), 'utf8');
    const fn = /function redirectError[\s\S]*?\n}/.exec(src)?.[0] ?? '';
    expect(fn).toContain('reply.redirect');
  });
});

describe('a client identified by URL, and the SSRF surface that creates', () => {
  const doc = (over: Record<string, unknown> = {}) => ({
    client_id: 'https://claude.ai/oauth-client',
    client_name: 'Claude Code',
    redirect_uris: ['http://127.0.0.1:51234/callback'],
    ...over,
  });
  const serve = (body: unknown, ok = true): typeof fetch =>
    (async () => new Response(JSON.stringify(body), { status: ok ? 200 : 500 })) as unknown as typeof fetch;

  beforeEach(() => clearClientMetadataCache());

  it('tells a URL client id from a registered one', () => {
    expect(isMetadataUrl('https://claude.ai/oauth-client')).toBe(true);
    expect(isMetadataUrl(registerClient(KEY, { redirectUris: ['http://127.0.0.1:1/cb'] }))).toBe(false);
  });


/**
 * Answers a hostname without touching the network.
 *
 * These cases test Horizon's OWN allow-list, scheme and redirect rules — there
 * is no provider in them — so reaching public DNS to run one only means it
 * fails on a train, which says nothing about the code. `fetch` is already
 * injected here for exactly the same reason.
 */
const publicDns = async (): Promise<Array<{ address: string; family: number }>> => [
  { address: '203.0.113.10', family: 4 },
];

  it('reads the redirect URIs out of the document', async () => {
    const c = await fetchClientMetadata('https://claude.ai/oauth-client', [], serve(doc()), publicDns);
    expect(c.redirectUris).toEqual(['http://127.0.0.1:51234/callback']);
    expect(c.clientName).toBe('Claude Code');
  });

  /**
   * `client_id` arrives on an unauthenticated endpoint from anyone, so this
   * fetch is a server-side request forgery primitive aimed at whatever the BFF
   * can reach — which for an observability tool is the inside of a production
   * network.
   */
  it('refuses a non-https URL', async () => {
    await expect(fetchClientMetadata('http://claude.ai/c', [], serve(doc()), publicDns))
      .rejects.toThrow(/https/);
  });

  it('refuses a host outside an explicit allow-list', async () => {
    await expect(fetchClientMetadata('https://evil.example/c', ['claude.ai'], serve(doc()), publicDns))
      .rejects.toThrow(/clientMetadataHosts/);
  });

  // A name is not a location: the check is on the resolved ADDRESS, which is
  // what stops a public name pointing at 169.254.169.254.
  it.each([
    ['127.0.0.1', 4], ['10.1.2.3', 4], ['172.16.0.1', 4], ['192.168.1.1', 4],
    ['169.254.169.254', 4], ['100.64.0.1', 4], ['198.18.0.1', 4], ['198.19.255.1', 4],
    ['::1', 6], ['fd00::1', 6], ['fe80::1', 6], ['::ffff:10.0.0.1', 6],
  ])('treats %s as non-public', (ip, family) => {
    expect(isPublicAddress(ip, family as number)).toBe(false);
  });

  it.each([['8.8.8.8', 4], ['1.1.1.1', 4], ['2606:4700::1', 6]])('treats %s as public', (ip, family) => {
    expect(isPublicAddress(ip, family as number)).toBe(true);
  });

  /**
   * FOUR notations put an IPv4 address inside an IPv6 one, and an attacker
   * picks the spelling. Reading the leading hextet — which is what a check on
   * the TEXT amounts to — sees `0` for every `::`-prefixed form and `0x0064`
   * for NAT64, so all of these were judged public while the socket landed on
   * the address they carry. NAT64 is the one that matters most: it is the
   * standard translation layer in an IPv6-only cluster, so `64:ff9b::a9fe:a9fe`
   * reaches the cloud metadata service this guard exists to stop.
   */
  it.each([
    ['::ffff:0a00:0001', 'IPv4-mapped, hex notation'],
    ['::10.0.0.1', 'IPv4-compatible'],
    ['::169.254.169.254', 'IPv4-compatible, metadata service'],
    ['64:ff9b::a9fe:a9fe', 'NAT64, hex'],
    ['64:ff9b::169.254.169.254', 'NAT64, dotted'],
    ['2002:0a00:0001::', '6to4 wrapping 10.0.0.1'],
    ['2002:7f00:0001::', '6to4 wrapping 127.0.0.1'],
    ['2001:0:c000:200::', 'Teredo tunnel'],
    ['febf::1', 'the far end of fe80::/10'],
    ['fec0::1', 'site-local, deprecated but still routed internally'],
    ['ff02::1', 'all-nodes multicast'],
  ])('treats %s as non-public (%s)', (ip) => {
    expect(isPublicAddress(ip, 6)).toBe(false);
  });

  // The same embedding forms around a genuinely public address must still pass
  // — a guard that refuses everything it does not recognise would be useless.
  it.each([
    ['2002:0808:0808::', '6to4 wrapping 8.8.8.8'],
    ['64:ff9b::0808:0808', 'NAT64 wrapping 8.8.8.8'],
    ['2001:4860:4860::8888', 'ordinary global unicast'],
  ])('treats %s as public (%s)', (ip) => {
    expect(isPublicAddress(ip, 6)).toBe(true);
  });

  // "I could not tell" has to mean no: this verdict becomes the connection.
  it.each([['not-an-address'], ['1:2:3'], ['::ffff:999.1.1.1'], ['gggg::1']])(
    'refuses %s rather than guessing',
    (ip) => {
      expect(isPublicAddress(ip, 6)).toBe(false);
    },
  );

  // Any host could otherwise serve a document impersonating another client.
  it('refuses a document that claims a different client_id', async () => {
    await expect(
      fetchClientMetadata('https://claude.ai/oauth-client', [], serve(doc({ client_id: 'https://evil.example/c' })), publicDns),
    ).rejects.toThrow(/declares client_id/);
  });

  it('refuses a document with no usable redirect_uris', async () => {
    await expect(fetchClientMetadata('https://claude.ai/oauth-client', [], serve(doc({ redirect_uris: [] })), publicDns))
      .rejects.toThrow(/redirect_uris/);
    await expect(fetchClientMetadata('https://claude.ai/oauth-client', [], serve(doc({ redirect_uris: [1, 2] })), publicDns))
      .rejects.toThrow(/redirect_uris/);
  });
});

/**
 * RFC 6749 §4.1.3 requires the token endpoint to accept
 * `application/x-www-form-urlencoded`, and every conformant client sends it.
 * Fastify parses only JSON by default, so the endpoint threw on the one body
 * format it is obliged to read and answered a 500 error envelope where the
 * client expected `access_token`. Every earlier test posted JSON, which worked
 * — which is exactly why nothing caught it until a real client tried.
 */
describe('the token endpoint reads the body format the spec mandates', () => {
  it('parses a form-encoded body into the same shape as JSON', () => {
    const parsed = Object.fromEntries(
      new URLSearchParams('grant_type=authorization_code&code=abc&code_verifier=xyz'),
    );
    expect(parsed).toEqual({ grant_type: 'authorization_code', code: 'abc', code_verifier: 'xyz' });
  });

  it('keeps a value containing the characters a PKCE verifier can hold', () => {
    const verifier = 'aB3-_.~xyz';
    const parsed = Object.fromEntries(new URLSearchParams(`code_verifier=${encodeURIComponent(verifier)}`));
    expect(parsed.code_verifier).toBe(verifier);
  });
});

/**
 * `resource` (RFC 8707) was recorded into `aud` and never checked, so it was
 * decoration: a client that believed it had scoped its token had not, and a
 * token naming somebody else's resource was accepted here unchanged.
 */
describe('a token names the resource it is for, and that is checked', () => {
  const KEY = 'k'.repeat(40);
  const ISSUER = 'https://horizon.example.com';
  const cfg = configSchema.parse({
    server: { publicUrl: ISSUER },
    auth: { local: { users: [{ username: 'alice', passwordHash: 'x', roles: ['admin'] }] } },
    oauth: { enabled: true, signingKey: KEY, issuer: ISSUER },
  });
  const source = { current: cfg } as never;
  const resolver = new OAuthTokenResolver(source, new RoleResolver(source));
  const bearer = (aud?: string) =>
    `Bearer ${issueAccessToken(KEY, { sub: 'alice', scope: 'horizon:full', ...(aud ? { aud } : {}) }, 60_000)}`;

  it('accepts a token for a resource under this issuer', async () => {
    expect(await resolver.resolve(bearer(`${ISSUER}/api/mcp`))).not.toBeNull();
    expect(await resolver.resolve(bearer(ISSUER))).not.toBeNull();
  });

  /**
   * The audience must be one this deployment ADVERTISES, not merely one under
   * its origin. A prefix match accepted `${issuer}/api/not-mcp` — a resource
   * this server never offers and never mints — so a token issued elsewhere for
   * an invented resource on the same origin authenticated here.
   */
  it.each([
    ['a resource this server never advertises', `${ISSUER}/api/not-mcp`],
    ['a deeper path under the advertised one', `${ISSUER}/api/mcp/extra`],
    ['a lookalike origin', `${ISSUER}.evil.example/api/mcp`],
    ['another deployment entirely', 'https://other.example/api/mcp'],
  ])('refuses a token whose audience is %s', async (_label, aud) => {
    expect(await resolver.resolve(bearer(aud))).toBeNull();
  });

  /** A client that sends no `resource` is asking for a token for Horizon
   *  itself, and the signature already proves which Horizon issued it. */
  it('accepts a token that names no resource at all', async () => {
    expect(await resolver.resolve(bearer())).not.toBeNull();
  });

  it('refuses a token minted for someone else', async () => {
    expect(await resolver.resolve(bearer('https://evil.example/api/mcp'))).toBeNull();
  });

  /** A prefix of the issuer is a different host, and the `/` matters. */
  it('refuses an issuer-prefixed impostor', async () => {
    expect(await resolver.resolve(bearer(`${ISSUER}.evil.test/api/mcp`))).toBeNull();
  });
});

/**
 * DNS rebinding: validating a NAME and then handing that name to `fetch`
 * checks one resolution and connects on another. A host that answers a public
 * address to the check and a private one to the connection passes and is
 * reached anyway — and this path is behind an unauthenticated endpoint.
 *
 * The fix is structural rather than a second check: the connection is pinned to
 * the address that was validated, so there is no later resolution to poison.
 * These assert the shape that makes that true, since exercising real rebinding
 * would need a hostile DNS server.
 */
describe('the metadata fetch connects to the address it checked', () => {
  const SRC = readFileSync(new URL('./client-metadata.ts', import.meta.url), 'utf8');

  it('hands the validated address to the connection, not the hostname', () => {
    // assertReachableTarget returns what it checked, and that value is what
    // the request is made against.
    expect(SRC).toMatch(/return addrs\[0\]\.address;/);
    expect(SRC).toMatch(/const pinned = await assertReachableTarget\(/);
    expect(SRC).toMatch(/fetchPinned\(url, pinned,/);
    expect(SRC).toMatch(/host: address,/);
  });

  /** Pinning the address must not become a way to skip certificate checks:
   *  TLS still has to be verified against the name the caller asked for. */
  it('keeps TLS bound to the hostname', () => {
    expect(SRC).toMatch(/servername: url\.hostname/);
    expect(SRC).toMatch(/headers: \{ host: url\.hostname/);
  });

  /** The next hop would be a fresh name with no check at all. */
  it('refuses a redirect rather than following it', () => {
    expect(SRC).toMatch(/redirect refused/);
  });
});
