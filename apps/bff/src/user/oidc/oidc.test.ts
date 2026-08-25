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

import { describe, it, expect, afterEach } from 'vitest';
import { configSchema } from '../../config/schema.js';
import { readFileSync } from 'node:fs';
import { clearDiscoveryCache, discover, DiscoveryError } from './discovery.js';
import { domainAllowed, oidcRolesFor, rolesForEmail } from './identity.js';
import { readPath, readBounded, MAX_PROVIDER_BODY, fetchOauth2Identity, UserinfoError } from './userinfo.js';

const provider = (over: Record<string, unknown> = {}) =>
  configSchema.parse({
    auth: { sso: { providers: [{ id: 'p', issuer: 'https://idp.example', clientId: 'c', ...over }] } },
  }).auth.sso.providers[0];

/** The role table is now ONE block, shared by every provider. */
const roles = (over: Record<string, unknown> = {}) =>
  configSchema.parse({ auth: { sso: { roles: over } } }).auth.sso.roles;

describe('an identity provider says who you are, never what you may do', () => {
  it('defaults to viewer — an external directory does not get to grant privileges', () => {
    expect(roles().defaultRoles).toEqual(['viewer']);
  });

  it('resolves most-specific-first: address, then domain, then the default', () => {
    const r = roles({
      defaultRoles: ['viewer'],
      roleByDomain: { 'example.com': ['maintainer'] },
      roleByEmail: { 'boss@example.com': ['admin'] },
    });
    expect(rolesForEmail(r, 'boss@example.com')).toEqual(['admin']);
    expect(rolesForEmail(r, 'dev@example.com')).toEqual(['maintainer']);
    expect(rolesForEmail(r, 'someone@other.org')).toEqual(['viewer']);
  });

  it('matches an address and a domain case-insensitively', () => {
    const r = roles({ roleByEmail: { 'Boss@Example.com': ['admin'] } });
    expect(rolesForEmail(r, 'BOSS@EXAMPLE.COM')).toEqual(['admin']);
  });

  /**
   * A subdomain is a DIFFERENT domain, and admitting one would be a grant the
   * operator never wrote. `accounts.google.com` is shared by every Workspace
   * tenant with no claim naming which, so anyone who controls DNS for a label
   * under the allowed domain can verify a tenant on it and inherit the parent's
   * roles.
   */
  it('treats a subdomain as a different domain', () => {
    const p = provider({ allowedDomains: ['apache.org'] });
    expect(domainAllowed(p, 'a@apache.org')).toBe(true);
    expect(domainAllowed(p, 'a@mail.apache.org')).toBe(false);
    // The tell-tale near miss: a domain that merely ENDS with the allowed one.
    expect(domainAllowed(p, 'a@notapache.org')).toBe(false);
    expect(domainAllowed(p, 'a@evil.com')).toBe(false);
  });

  it('maps roles by exact domain only', () => {
    const r = roles({ defaultRoles: ['viewer'], roleByDomain: { 'corp.com': ['admin'] } });
    expect(rolesForEmail(r, 'boss@corp.com')).toEqual(['admin']);
    expect(rolesForEmail(r, 'someone@dev.corp.com')).toEqual(['viewer']);
  });

  /**
   * An empty allow-list means every address the provider will authenticate.
   * For a public provider that is the entire internet, so this test exists to
   * make the default's consequence explicit rather than surprising.
   */
  it('admits everyone when no domain is configured', () => {
    expect(domainAllowed(provider(), 'anyone@anywhere.example')).toBe(true);
  });
});

describe('SSO roles resolve from the address alone, on every request', () => {
  const config = configSchema.parse({
    auth: {
      local: { users: [{ username: 'admin', passwordHash: 'x', roles: ['admin'] }] },
      sso: {
        providers: [{
          id: 'p', issuer: 'https://idp.example', clientId: 'c',
          allowedDomains: ['example.com'],
        }],
        roles: { defaultRoles: ['viewer'], roleByEmail: { 'boss@example.com': ['operator'] } },
      },
    },
  });

  // This is what makes an SSO user's API token unable to outlive their access:
  // there is no stored claim to go stale, only config.
  it('answers the same for the same config, with no login context', () => {
    expect(oidcRolesFor(config, 'dev@example.com')).toEqual(['viewer']);
    expect(oidcRolesFor(config, 'boss@example.com')).toEqual(['operator']);
  });

  it('gives nothing to an address no provider would admit', () => {
    expect(oidcRolesFor(config, 'outsider@elsewhere.org')).toEqual([]);
  });

  it('gives nothing to something that is not an address', () => {
    expect(oidcRolesFor(config, 'admin')).toEqual([]);
  });
});

describe('discovery is what removes per-provider code', () => {
  afterEach(() => clearDiscoveryCache());

  const doc = {
    issuer: 'https://idp.example',
    authorization_endpoint: 'https://idp.example/auth',
    token_endpoint: 'https://idp.example/token',
    jwks_uri: 'https://idp.example/jwks',
    code_challenge_methods_supported: ['S256'],
  };
  // A real Response, not a hand-rolled stand-in: the code under test reads
  // headers and streams the body, and a fake that only has `.json()` would
  // pass while the real path threw.
  const serve = (body: unknown, ok = true): typeof fetch =>
    (async () => new Response(JSON.stringify(body), { status: ok ? 200 : 500 })) as unknown as typeof fetch;

  it('reads the endpoints from the document, not from code', async () => {
    const meta = await discover('https://idp.example', serve(doc));
    expect(meta.authorizationEndpoint).toBe('https://idp.example/auth');
    expect(meta.tokenEndpoint).toBe('https://idp.example/token');
    expect(meta.supportsS256).toBe(true);
  });

  it('caches, so a login is not a second round trip to the provider', async () => {
    let calls = 0;
    const counting = (async () => { calls++; return new Response(JSON.stringify(doc)); }) as unknown as typeof fetch;
    await discover('https://idp.example', counting);
    await discover('https://idp.example', counting);
    expect(calls).toBe(1);
  });

  // A document whose issuer disagrees with where it was fetched from is either
  // misconfigured or not the provider you think it is — and `iss` is what every
  // ID token is checked against.
  it('refuses a document that declares a different issuer', async () => {
    await expect(discover('https://idp.example', serve({ ...doc, issuer: 'https://evil.example' })))
      .rejects.toBeInstanceOf(DiscoveryError);
  });

  it('refuses a document missing an endpoint it needs', async () => {
    await expect(discover('https://idp.example', serve({ ...doc, jwks_uri: undefined })))
      .rejects.toBeInstanceOf(DiscoveryError);
  });

  it('refuses an unreachable provider rather than proceeding', async () => {
    await expect(discover('https://idp.example', serve({}, false))).rejects.toBeInstanceOf(DiscoveryError);
  });
});


describe('providers admit, one table decides', () => {
  /**
   * Roles are re-resolved on every request from a username and nothing else,
   * so a per-provider role table could never be honoured for a token — there is
   * no record of which provider authenticated it. Keeping one produced the
   * failure this block used to describe: two providers disagreeing about an
   * address resolved it to NO roles, and a credential with no roles is refused,
   * so adding a second provider logged every agent out with a 401.
   *
   * With one table there is nothing to disagree. A provider decides only
   * WHETHER someone may sign in through it.
   */
  const cfg = configSchema.parse({
    auth: {
      sso: {
        providers: [
          { id: 'okta', issuer: 'https://okta.example', clientId: 'c', allowedDomains: ['corp.com'] },
          { id: 'google', issuer: 'https://accounts.google.com', clientId: 'c', allowedDomains: [] },
        ],
        roles: { defaultRoles: ['viewer'], roleByDomain: { 'corp.com': ['admin'] } },
      },
    },
  });

  it('gives the same answer no matter which provider could have authenticated', () => {
    expect(oidcRolesFor(cfg, 'bob@corp.com')).toEqual(['admin']);
  });

  it('falls to the default for an address the table does not name', () => {
    expect(oidcRolesFor(cfg, 'someone@elsewhere.org')).toEqual(['viewer']);
  });

  /** Empty is what a token resolver turns into a 401 — the lockout state. */
  it('never resolves an admitted address to no roles at all', () => {
    for (const who of ['bob@corp.com', 'someone@elsewhere.org', 'x@gmail.com']) {
      expect(oidcRolesFor(cfg, who), who).not.toEqual([]);
    }
  });

  it('still refuses an address no provider admits', () => {
    const closed = configSchema.parse({
      auth: { sso: {
        providers: [{ id: 'okta', issuer: 'https://okta.example', clientId: 'c', allowedDomains: ['corp.com'] }],
        roles: { defaultRoles: ['viewer'] },
      } },
    });
    expect(oidcRolesFor(closed, 'bob@corp.com')).toEqual(['viewer']);
    expect(oidcRolesFor(closed, 'stranger@other.org')).toEqual([]);
  });
});

/*
 * The property this file used to assert by scanning roles.ts as TEXT — that a
 * failed lookup refuses rather than falling through to the SSO table — is now
 * asserted behaviourally in user/roles.test.ts, against a mocked directory
 * error with an SSO table that would otherwise hand back `admin`. The text scan
 * broke twice on legitimate refactors while never once catching a real defect,
 * which is the wrong ratio for a test guarding a fail-closed path.
 */

describe('the post-login return path cannot leave this origin', () => {
  const safeNext = (raw: string): string => {
    // Mirrors user/oidc/route.ts — asserted against the source below so the
    // two cannot drift.
    if (typeof raw !== 'string' || !raw.startsWith('/')) return '/';
    for (let i = 0; i < raw.length; i++) {
      const c = raw.charCodeAt(i);
      if (c <= 0x1f || c === 0x7f) return '/';
    }
    if (raw.startsWith('//') || raw.includes('\\') || raw.includes(':')) return '/';
    return raw;
  };

  it('keeps an ordinary in-app path', () => {
    expect(safeNext('/alarms')).toBe('/alarms');
    expect(safeNext('/layer/GENERAL/traces?x=1')).toBe('/layer/GENERAL/traces?x=1');
  });

  // Browsers strip tab/CR/LF from a URL before resolving it, so `/\t/evil`
  // reaches the network as `//evil` — off-origin, past a two-character check.
  it.each(['//evil.example', '/\t/evil.example', '/\n/evil.example', '/\r/evil.example',
           '/\\evil.example', 'https://evil.example', 'javascript:alert(1)', ''])(
    'refuses %j', (bad) => { expect(safeNext(bad)).toBe('/'); },
  );

  it('matches the implementation it mirrors', () => {
    const src = readFileSync(new URL('./route.ts', import.meta.url), 'utf8');
    const fn = /function safeNext[\s\S]*?\n}/.exec(src)?.[0] ?? '';
    expect(fn).toContain('0x1f');
    expect(fn).toContain("raw.startsWith('//')");
  });
});

describe('plain OAuth2 providers, for the ones that never adopted OIDC', () => {
  it('requires the endpoints discovery would otherwise supply', () => {
    const bad = () => configSchema.parse({
      auth: { sso: { providers: [{ id: 'github', kind: 'oauth2', clientId: 'c' }] } },
    });
    // Caught at config-parse time: a provider missing its own kind's fields can
    // never work, and a browser redirect is a poor way to find that out.
    expect(bad).toThrow(/authorizationEndpoint|tokenEndpoint|userinfoEndpoint/);
  });

  it('requires an issuer for the oidc kind, and not for oauth2', () => {
    expect(() => configSchema.parse({
      auth: { sso: { providers: [{ id: 'x', clientId: 'c' }] } },
    })).toThrow(/issuer/);
    expect(() => configSchema.parse({
      auth: { sso: { providers: [{
        id: 'github', kind: 'oauth2', clientId: 'c',
        authorizationEndpoint: 'https://github.com/login/oauth/authorize',
        tokenEndpoint: 'https://github.com/login/oauth/access_token',
        userinfoEndpoint: 'https://api.github.com/user',
        emailsEndpoint: 'https://api.github.com/user/emails',
      }] } },
    })).not.toThrow();
  });

  // `oidc` gets this from a signed ID token's `email_verified`; `oauth2` has no
  // ID token, so it has to be configured — and REQUIRED, because the fallback
  // of trusting a profile field is a way to sign in as somebody else.
  it('refuses an oauth2 provider that can prove no address', () => {
    const provider = (over: Record<string, unknown> = {}) => ({
      auth: { sso: { providers: [{
        id: 'p', kind: 'oauth2', clientId: 'c',
        authorizationEndpoint: 'https://p.example/authorize',
        tokenEndpoint: 'https://p.example/token',
        userinfoEndpoint: 'https://p.example/user',
        ...over,
      }] } },
    });
    expect(() => configSchema.parse(provider())).toThrow(/verified/);
    expect(() => configSchema.parse(provider({ emailsEndpoint: 'https://p.example/emails' }))).not.toThrow();
    expect(() => configSchema.parse(provider({ emailVerifiedPath: 'email_verified' }))).not.toThrow();
  });

  /**
   * The client SECRET is posted to the token endpoint and the access token is
   * sent to the other two, so a cleartext endpoint puts both on the wire. The
   * `oidc` kind never faces this — its endpoints arrive in a document fetched
   * over https — which is exactly why only `oauth2` needs the check.
   */
  it('refuses cleartext oauth2 endpoints, except on loopback', () => {
    const at = (over: Record<string, unknown>) =>
      configSchema.parse({
        auth: { sso: { providers: [{
          id: 'p', kind: 'oauth2', clientId: 'c',
          authorizationEndpoint: 'https://p.example/authorize',
          tokenEndpoint: 'https://p.example/token',
          userinfoEndpoint: 'https://p.example/user',
          emailVerifiedPath: 'email_verified',
          ...over,
        }] } },
      });
    expect(() => at({ tokenEndpoint: 'http://p.example/token' })).toThrow(/https/);
    expect(() => at({ userinfoEndpoint: 'http://p.example/user' })).toThrow(/https/);
    expect(() => at({ emailsEndpoint: 'http://p.example/emails' })).toThrow(/https/);
    // A provider running beside you in development has no network to read.
    expect(() => at({ tokenEndpoint: 'http://localhost:9000/token' })).not.toThrow();
    expect(() => at({ tokenEndpoint: 'http://127.0.0.1:9000/token' })).not.toThrow();
    // A hostname that merely CONTAINS localhost is a different host.
    expect(() => at({ tokenEndpoint: 'http://localhost.evil.example/token' })).toThrow(/https/);
  });

  /**
   * The one field that makes the adapter generic rather than a pile of
   * per-vendor branches: providers disagree on where the address lives and
   * none of them is wrong.
   */
  it('reads the email from wherever that provider puts it', () => {
    expect(readPath({ email: 'a@b.c' }, 'email')).toBe('a@b.c');
    expect(readPath({ data: { email: 'a@b.c' } }, 'data.email')).toBe('a@b.c');
    expect(readPath({ user: { primary_email: 'a@b.c' } }, 'user.primary_email')).toBe('a@b.c');
  });

  // A provider that returns `{email: null}` for an unverified address must not
  // read as an identity.
  it.each([
    [{ email: null }, 'email'],
    [{ email: '' }, 'email'],
    [{ email: 123 }, 'email'],
    [{}, 'email'],
    [{ data: 'not-an-object' }, 'data.email'],
    [null, 'email'],
  ])('treats %j at %s as no identity', (body, path) => {
    expect(readPath(body, path)).toBeUndefined();
  });
});

/**
 * GitHub's `/user` answers `email: null` unless the operator has published an
 * address on their public profile, which most have not — so without the list
 * endpoint the most common GitHub account cannot sign in at all. Verified
 * against a real account: `gh api user` returns `"email": null`.
 */
describe('the address a provider keeps in a list, not on the profile', () => {
  const serveEach = (bodies: Record<string, unknown>): typeof fetch =>
    (async (url: string) => {
      const body = bodies[String(url)];
      if (body === undefined) return new Response('{}', { status: 404 });
      return new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof fetch;

  const opts = (over: Record<string, unknown> = {}) => ({
    userinfoEndpoint: 'https://api.github.com/user',
    emailsEndpoint: 'https://api.github.com/user/emails',
    accessToken: 't',
    emailPath: 'email',
    namePath: 'name',
    providerId: 'github',
    ...over,
  });

  const GITHUB_PROFILE = { email: null, name: 'Wu Sheng' };

  it('takes the primary verified address from the list, and the name from the profile', async () => {
    const id = await fetchOauth2Identity(opts(), serveEach({
      'https://api.github.com/user': GITHUB_PROFILE,
      'https://api.github.com/user/emails': [
        { email: 'secondary@example.com', primary: false, verified: true },
        { email: 'primary@example.com', primary: true, verified: true },
      ],
    }), 1000);
    expect(id.email).toBe('primary@example.com');
    // The name still comes from the profile — only the address was missing.
    expect(id.name).toBe('Wu Sheng');
  });

  /**
   * Roles resolve from the address, and GitHub lets anyone attach any address
   * to their account and leave it unverified. Accepting one would let a
   * stranger claim an admin's address and inherit their roles.
   */
  it('refuses an unverified address even when it is the primary one', async () => {
    await expect(fetchOauth2Identity(opts(), serveEach({
      'https://api.github.com/user': GITHUB_PROFILE,
      'https://api.github.com/user/emails': [
        { email: 'admin@victim.example', primary: true, verified: false },
      ],
    }), 1000)).rejects.toBeInstanceOf(UserinfoError);
  });

  it('skips the unverified entry and takes a verified one', async () => {
    const id = await fetchOauth2Identity(opts(), serveEach({
      'https://api.github.com/user': GITHUB_PROFILE,
      'https://api.github.com/user/emails': [
        { email: 'admin@victim.example', primary: true, verified: false },
        { email: 'mine@example.com', primary: false, verified: true },
      ],
    }), 1000);
    expect(id.email).toBe('mine@example.com');
  });

  /**
   * The case this rule exists for. A rule that only rejected an explicit
   * `verified: false` accepts silence — a missing key, a null, a zero — and
   * silence is not an affirmation. The address may be one the person typed and
   * does not own, and roles resolve from the address.
   *
   * The `state` rows matter for a second reason: verification under a
   * DIFFERENT key is not verification under this one. Reading Gitee's
   * `state: "confirmed"` as an affirmative here would be reading a field the
   * operator never nominated — they say which field proves an address, with
   * `emailVerifiedPath` / `emailVerifiedValue`, and the default nominates
   * `verified`.
   */
  it.each([
    ['a different key entirely (Gitee)', { email: 'a@b.c', state: 'unconfirmed' }],
    ['a confirmed-looking different key', { email: 'a@b.c', state: 'confirmed' }],
    ['the string "false"', { email: 'a@b.c', verified: 'false' }],
    ['no verification field at all', { email: 'a@b.c' }],
    ['a null', { email: 'a@b.c', verified: null }],
    ['a zero', { email: 'a@b.c', verified: 0 }],
  ])('refuses an address whose verification is %s', async (_label, entry) => {
    await expect(fetchOauth2Identity(opts(), serveEach({
      'https://api.github.com/user': { email: null },
      'https://api.github.com/user/emails': [entry],
    }), 1000)).rejects.toBeInstanceOf(UserinfoError);
  });

  /**
   * The string `"true"` IS an affirmative, deliberately — the OIDC branch has
   * always read `String(claims.email_verified) === 'true'`, and two paths in
   * one codebase disagreeing about what "verified" looks like is a trap for
   * whoever configures the second one. The protection that matters — silence
   * and explicit negatives are refused — is untouched.
   */
  it('accepts the string "true", as the OIDC branch does', async () => {
    const id = await fetchOauth2Identity(opts(), serveEach({
      'https://api.github.com/user': { email: null },
      'https://api.github.com/user/emails': [{ email: 'a@b.c', verified: 'true' }],
    }), 1000);
    expect(id.email).toBe('a@b.c');
  });

  /**
   * Which field proves an address is CONFIGURATION, not a branch per vendor.
   * Gitee keeps verification at `state: "confirmed"`, so an operator nominates
   * that field and that value — and the same list check then works, rather than
   * the provider being pushed onto the unchecked profile field.
   */
  it('accepts a provider that spells verification its own way', async () => {
    const gitee = { ...opts({ emailVerifiedPath: 'state', emailVerifiedValue: 'confirmed' }) };
    const id = await fetchOauth2Identity(gitee, serveEach({
      'https://api.github.com/user': { email: null },
      'https://api.github.com/user/emails': [
        { email: 'unconfirmed@example.com', state: 'unconfirmed' },
        { email: 'confirmed@example.com', state: 'confirmed' },
      ],
    }), 1000);
    expect(id.email).toBe('confirmed@example.com');
  });

  /**
   * Gitee answers `/api/v5/user` with the literal string `未公开邮箱` for an
   * account that has hidden its address. It is a non-empty string, so it passes
   * `readPath` — and every such account would then share ONE Horizon username,
   * landing on defaultRoles because no role rule can match it.
   */
  it('refuses a non-address in the address field', async () => {
    await expect(fetchOauth2Identity(opts(), serveEach({
      'https://api.github.com/user': { email: null },
      'https://api.github.com/user/emails': [{ email: '未公开邮箱', verified: true }],
    }), 1000)).rejects.toBeInstanceOf(UserinfoError);
  });

  // The list is AUTHORITATIVE, not a fallback, and this is the test that says
  // so. It previously asserted the opposite — that a profile address short-
  // circuits the list — which is exactly the impersonation: at a provider whose
  // profile email is free text, anyone could type a colleague's address there
  // and be handed that colleague's roles, while the verified list that would
  // have caught it went unread.
  it('prefers the verified list over a self-asserted profile address', async () => {
    const id = await fetchOauth2Identity(opts(), serveEach({
      'https://api.github.com/user': { email: 'i-typed-this@victim.example' },
      'https://api.github.com/user/emails': [{ email: 'real@example.com', verified: true, primary: true }],
    }), 1000);
    expect(id.email).toBe('real@example.com');
  });

  it('refuses when the list holds nothing verified, even though the profile has an address', async () => {
    await expect(fetchOauth2Identity(opts(), serveEach({
      'https://api.github.com/user': { email: 'i-typed-this@victim.example' },
      'https://api.github.com/user/emails': [{ email: 'i-typed-this@victim.example', verified: false }],
    }), 1000)).rejects.toBeInstanceOf(UserinfoError);
  });
});

describe('a provider with no list endpoint must prove the profile address instead', () => {
  const serve = (body: unknown): typeof fetch =>
    (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;

  const profileOpts = (over: Record<string, unknown> = {}) =>
    ({
      userinfoEndpoint: 'https://p.example/user',
      emailsEndpoint: '',
      accessToken: 't',
      emailPath: 'email',
      namePath: 'name',
      providerId: 'p',
      ...over,
    }) as Parameters<typeof fetchOauth2Identity>[0];

  const VERIFIED = { emailVerifiedPath: 'email_verified' };

  it('accepts an address the profile marks verified', async () => {
    const id = await fetchOauth2Identity(
      profileOpts(VERIFIED),
      serve({ email: 'real@example.com', email_verified: true }),
      1000,
    );
    expect(id.email).toBe('real@example.com');
  });

  it('accepts the string "true", which some providers send instead of a boolean', async () => {
    const id = await fetchOauth2Identity(
      profileOpts(VERIFIED),
      serve({ email: 'real@example.com', email_verified: 'true' }),
      1000,
    );
    expect(id.email).toBe('real@example.com');
  });

  it.each([
    ['false', false],
    ['the string "false"', 'false'],
    ['a zero', 0],
    ['a null', null],
  ])('refuses an address whose profile flag is %s', async (_label, flag) => {
    await expect(
      fetchOauth2Identity(profileOpts(VERIFIED), serve({ email: 'a@b.c', email_verified: flag }), 1000),
    ).rejects.toBeInstanceOf(UserinfoError);
  });

  it('refuses when the flag key is absent entirely', async () => {
    await expect(
      fetchOauth2Identity(profileOpts(VERIFIED), serve({ email: 'a@b.c' }), 1000),
    ).rejects.toBeInstanceOf(UserinfoError);
  });

  // Belt and braces behind the schema, which rejects such a provider at boot.
  it('refuses every address when neither proof is configured', async () => {
    await expect(
      fetchOauth2Identity(profileOpts(), serve({ email: 'a@b.c', email_verified: true }), 1000),
    ).rejects.toBeInstanceOf(UserinfoError);
  });
});

describe('a provider response cannot exhaust this process', () => {
  const body = (bytes: number, headers: Record<string, string> = {}): Response => {
    const chunk = new Uint8Array(1024).fill(0x20);
    let sent = 0;
    return new Response(
      new ReadableStream({
        pull(c) {
          if (sent >= bytes) return c.close();
          c.enqueue(chunk);
          sent += chunk.length;
        },
      }),
      { headers },
    );
  };

  // A timeout does not help here: the bytes arrive steadily, so the request
  // never stalls — it just never stops.
  it('refuses a body over the cap, and stops reading it', async () => {
    await expect(readBounded(body(MAX_PROVIDER_BODY * 2), 'userinfo')).rejects.toThrow(/exceeded/);
  });

  it('refuses on a declared content-length before reading a byte', async () => {
    await expect(
      readBounded(body(64, { 'content-length': String(MAX_PROVIDER_BODY * 4) }), 'discovery'),
    ).rejects.toThrow(/over the/);
  });

  it('reads an ordinary response', async () => {
    const res = new Response(JSON.stringify({ email: 'a@b.c' }));
    expect(await readBounded(res, 'userinfo')).toEqual({ email: 'a@b.c' });
  });
});

describe('the login page offers a password box only when one can succeed', () => {
  /**
   * `passwordLogin` is about CONFIGURATION, not about whether a particular
   * person could sign in — an unreachable directory keeps its box, because the
   * break-glass account is the way back in while it is down. But a backend NAME
   * with no directory behind it is not a configuration: the login route refuses
   * every credential with "backend is ldap but auth.ldap is missing", so the box
   * was a form that could not succeed.
   */
  const offers = (over: Record<string, unknown>): boolean => {
    const c = configSchema.parse({ auth: over });
    return (c.auth.backend === 'ldap' && !!c.auth.ldap) || c.auth.local.users.length > 0;
  };

  const LDAP = { url: 'ldap://dir.example:389', userBaseDn: 'dc=example,dc=com' };

  it('offers it for a configured directory', () => {
    expect(offers({ backend: 'ldap', ldap: LDAP })).toBe(true);
  });

  it('does NOT offer it for backend: ldap with no directory configured', () => {
    expect(offers({ backend: 'ldap' })).toBe(false);
  });

  it('offers it whenever local users exist, whatever the backend', () => {
    expect(offers({ backend: 'ldap', local: { users: [{ username: 'a', passwordHash: 'x', roles: ['viewer'] }] } })).toBe(true);
  });

  it('does not offer it when nothing can take a password', () => {
    expect(offers({})).toBe(false);
  });
});

describe('provider endpoints must be https', () => {
  const parse = (over: Record<string, unknown>) =>
    configSchema.parse({ auth: { sso: { providers: [{ id: 'p', clientId: 'c', ...over }] } } });

  /** The client secret is sent to the token endpoint, so a plaintext provider
   *  URL puts it on the wire. Loopback is exempt because there is no network
   *  to listen on — that is what makes a local mock usable. */
  it('refuses a plaintext remote issuer', () => {
    expect(() => parse({ issuer: 'http://idp.example' })).toThrow();
    expect(() => parse({ issuer: 'https://idp.example' })).not.toThrow();
  });

  it('allows plaintext loopback, for a local mock provider', () => {
    expect(() => parse({ issuer: 'http://127.0.0.1:9999' })).not.toThrow();
    expect(() => parse({ issuer: 'http://localhost:9999' })).not.toThrow();
  });

  it('refuses a plaintext explicit endpoint on an oauth2 provider', () => {
    expect(() =>
      parse({
        kind: 'oauth2',
        authorizationEndpoint: 'https://idp.example/a',
        tokenEndpoint: 'http://idp.example/t',
        userinfoEndpoint: 'https://idp.example/u',
        emailVerifiedPath: 'email_verified',
      }),
    ).toThrow();
  });
});

describe('the in-flight sign-in store is bounded', () => {
  it('holds at most MAX_FLOWS and evicts the oldest, never the newest', async () => {
    const { FlowStore, MAX_FLOWS } = await import('./flows.js');
    const store = new FlowStore(60_000);
    const first = store.put({ state: 's', nonce: 'n', verifier: 'v', provider: 'p', next: '/' });
    for (let i = 0; i < MAX_FLOWS; i += 1) {
      store.put({ state: `s${i}`, nonce: 'n', verifier: 'v', provider: 'p', next: '/' });
    }
    // The oldest went; the one just added is still usable.
    expect(store.take(first)).toBeNull();
    const latest = store.put({ state: 'latest', nonce: 'n', verifier: 'v', provider: 'p', next: '/' });
    expect(store.take(latest)?.state).toBe('latest');
  });
});
