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
 * Sign in with an external identity provider.
 *
 *   GET /api/auth/oidc/providers  the buttons the login page renders
 *   GET /api/auth/oidc/start      begin — redirects to the provider
 *   GET /api/auth/oidc/callback   the provider comes back here
 *
 * ONE callback for every provider. The provider id travels in the signed
 * `state` and in a short-lived cookie, never in the URL — so an operator
 * registers a single redirect URI per environment no matter how many providers
 * they add, and the URL names no vendor.
 *
 * This is Horizon acting as an OAuth CLIENT, which is the opposite direction
 * from `apps/bff/src/oauth/` (Horizon acting as an authorization server, for
 * MCP clients). They share a protocol and nothing else. They do compose: with
 * both on, an MCP client sends its operator to Horizon's login page, and that
 * page can send them to Google — three parties, and the MCP layer never learns
 * that the third exists.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { jwtVerify } from 'jose';
import type { HorizonConfig } from '../../config/schema.js';
import type { AuthDeps } from '../middleware.js';
import type { UserSeenCache } from '../seen-cache.js';
import { logger } from '../../logger.js';
import { discover, DiscoveryError } from './discovery.js';
import { domainAllowed, findProvider, oidcEnabled, rolesForEmail } from './identity.js';
import { fetchOauth2Identity, UserinfoError } from './userinfo.js';
import { FlowStore, type Flow } from './flows.js';

export interface OidcRouteDeps extends AuthDeps {
  seenCache: UserSeenCache;
  fetch?: typeof fetch;
}

/**
 * Names the in-flight sign-in across the leg between /start and /callback, and
 * carries NOTHING ELSE — the attempt itself is held server-side (see flows.ts),
 * because `httpOnly` stops a cookie being read and not being written, and a
 * cookie an attacker can write is a cookie whose contents cannot be trusted.
 *
 * `lax` because the provider returns via a cross-site top-level GET, which a
 * `strict` cookie is not sent on — that would break every login.
 */
const FLOW_COOKIE = 'horizon_oidc';
const FLOW_TTL_MS = 10 * 60_000;
/** Cap on any single call out to a provider. */
const PROVIDER_TIMEOUT_MS = 10_000;


/**
 * An open-redirect guard on our own return path.
 *
 * `?next=` comes from the browser, so it is only ever used as a same-origin
 * path. Anything with a scheme, an authority, or a backslash (which some
 * parsers read as a separator) is discarded rather than sanitised.
 */
function safeNext(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.startsWith('/')) return '/';
  // Browsers STRIP tab, CR and LF from a URL before resolving it, so `/\t/evil`
  // reaches the network as `//evil` — a protocol-relative URL off this origin,
  // past a guard that only looked at the literal first two characters. Checked
  // by code point rather than a regex, because a control-character class in a
  // pattern reads as a typo and lint rightly flags it.
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if (c <= 0x1f || c === 0x7f) return '/';
  }
  if (raw.startsWith('//') || raw.includes('\\') || raw.includes(':')) return '/';
  return raw;
}

function b64u(b: Buffer): string {
  return b.toString('base64url');
}

function constantTimeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
}

interface IdClaims {
  email?: string;
  email_verified?: boolean | string;
  name?: string;
  /** The handle a provider offers when it has one distinct from `name`. */
  preferred_username?: string;
  nonce?: string;
}

/**
 * Where the flow cookie lives, INCLUDING the deployment's path prefix.
 *
 * A browser matches a cookie's `Path` against the URL it is requesting, which
 * behind a prefix is `/horizon/api/auth/oidc/callback` — the proxy strips the
 * prefix on the way to Horizon, long after the browser has decided what to
 * send. Scoping the cookie to the un-prefixed path therefore meant it was never
 * sent at all, and every sign-in on a prefixed deployment ended at
 * `login_expired`.
 */
function flowCookiePath(config: HorizonConfig): string {
  return `${uiBasePath(config)}/api/auth/oidc`;
}

export function registerOidcRoutes(app: FastifyInstance, deps: OidcRouteDeps): void {
  const cfg = (): HorizonConfig => deps.config.current;
  const doFetch = deps.fetch ?? fetch;
  const flows = new FlowStore(FLOW_TTL_MS);

  // Back to the login page with a reason the operator can act on. A JSON body
  // would be shown as raw text: these endpoints are reached by a browser
  // navigation, not by the SPA's fetch layer. Always a 302 — there is no status
  // argument, because `redirect` sets its own and one taken here would be a lie.
  const fail = (reply: FastifyReply, reason: string): FastifyReply =>
    reply.redirect(`${uiBasePath(cfg())}/login?sso_error=${encodeURIComponent(reason)}`, 302);

  app.get('/api/auth/oidc/providers', async (_req, reply) =>
    reply.send({
      providers: cfg().auth.sso.providers.map((p) => ({
        id: p.id,
        displayName: p.displayName || p.id,
        icon: p.icon,
      })),
    }),
  );

  app.get('/api/auth/oidc/start', async (req, reply) => {
    const config = cfg();
    if (!oidcEnabled(config)) return fail(reply, 'sso_not_configured');
    const q = req.query as { provider?: string; next?: string };
    const provider = q.provider ? findProvider(config, q.provider) : config.auth.sso.providers[0];
    if (!provider) return fail(reply, 'unknown_provider');
    if (!provider.clientSecret) {
      logger.error({ provider: provider.id }, 'oidc: clientSecret is empty — refusing to start a login');
      return fail(reply, 'sso_not_configured');
    }

    // The ONE branch between the two kinds: where the endpoints come from.
    // Everything after it — state, nonce, PKCE, the redirect — is identical.
    let authorizationEndpoint: string;
    if (provider.kind === 'oidc') {
      try {
        authorizationEndpoint = (await discover(provider.issuer, doFetch)).authorizationEndpoint;
      } catch (err) {
        logger.error({ provider: provider.id, err: String(err) }, 'oidc: discovery failed');
        return fail(reply, 'provider_unreachable');
      }
    } else {
      authorizationEndpoint = provider.authorizationEndpoint;
    }

    const flow: Flow = {
      provider: provider.id,
      state: b64u(randomBytes(24)),
      nonce: b64u(randomBytes(24)),
      verifier: b64u(randomBytes(32)),
      next: safeNext(q.next),
    };
    // The verifier lives in an httpOnly COOKIE, never in `state`. State travels
    // through the provider and appears in its logs and in the browser history;
    // a verifier there would be a PKCE that proves nothing.
    reply.setCookie(FLOW_COOKIE, flows.put(flow), {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.session.cookieSecure,
      path: flowCookiePath(config),
      maxAge: FLOW_TTL_MS / 1000,
    });

    const u = new URL(authorizationEndpoint);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('client_id', provider.clientId);
    u.searchParams.set('redirect_uri', callbackUri(req, config));
    // OIDC needs `openid` to get an ID token at all; a plain OAuth2 provider
    // has its own vocabulary (GitHub `user:email`, Gitee `emails`) and would
    // reject ours, so it gets exactly what the operator configured.
    const scopes = provider.kind === 'oidc'
      ? ['openid', 'email', 'profile', ...provider.scopes]
      : provider.scopes;
    if (scopes.length) u.searchParams.set('scope', scopes.join(' '));
    u.searchParams.set('state', flow.state);
    // A nonce is an ID-token concept; a provider that issues none has no use
    // for it.
    if (provider.kind === 'oidc') u.searchParams.set('nonce', flow.nonce);
    u.searchParams.set('code_challenge', createHash('sha256').update(flow.verifier).digest('base64url'));
    u.searchParams.set('code_challenge_method', 'S256');
    return reply.redirect(u.toString(), 302);
  });

  app.get('/api/auth/oidc/callback', async (req, reply) => {
    const config = cfg();
    if (!oidcEnabled(config)) return fail(reply, 'sso_not_configured');
    const q = req.query as { code?: string; state?: string; error?: string };
    reply.clearCookie(FLOW_COOKIE, { path: flowCookiePath(cfg()) });

    if (q.error) return fail(reply, q.error);
    const flow = flows.take(req.cookies?.[FLOW_COOKIE]);
    if (!flow) return fail(reply, 'login_expired');
    // CSRF: the state the provider echoes must equal the one WE generated and
    // stored httpOnly. Without it an attacker can feed their own code to a
    // victim's browser and log them into the attacker's account.
    if (!q.state || !constantTimeEqual(q.state, flow.state)) return fail(reply, 'state_mismatch');
    if (!q.code) return fail(reply, 'no_code');

    const provider = findProvider(config, flow.provider);
    if (!provider) return fail(reply, 'unknown_provider');

    // Resolve the token endpoint the same two ways /start resolved authorize.
    let tokenEndpoint: string;
    let jwks: Awaited<ReturnType<typeof discover>>['jwks'] | null = null;
    let issuer = '';
    if (provider.kind === 'oidc') {
      try {
        const meta = await discover(provider.issuer, doFetch);
        tokenEndpoint = meta.tokenEndpoint;
        jwks = meta.jwks;
        issuer = meta.issuer;
      } catch (err) {
        logger.error({ provider: provider.id, err: String(err) }, 'oidc: discovery failed on callback');
        return fail(reply, err instanceof DiscoveryError ? 'provider_unreachable' : 'sso_failed');
      }
    } else {
      tokenEndpoint = provider.tokenEndpoint;
    }

    // Server-to-server, with the client secret. The code never goes near the
    // browser again and the response arrives over TLS from the provider itself.
    let tokens: { id_token?: string; access_token?: string };
    try {
      const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code: q.code,
        redirect_uri: callbackUri(req, config),
        client_id: provider.clientId,
        client_secret: provider.clientSecret,
        code_verifier: flow.verifier,
      });
      const res = await doFetch(tokenEndpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body,
        // A provider that accepts the connection and never answers would
        // otherwise hold this request until the socket died.
        signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
      });
      const json = (await res.json()) as { id_token?: string; access_token?: string; error?: string; error_description?: string };
      if (!res.ok || (provider.kind === 'oidc' ? !json.id_token : !json.access_token)) {
        // The provider's own words, logged server-side only: they routinely
        // name the misconfiguration (redirect_uri_mismatch, invalid_client).
        logger.error(
          { provider: provider.id, status: res.status, err: json.error, detail: json.error_description },
          'oidc: token exchange failed',
        );
        return fail(reply, 'sso_failed');
      }
      tokens = json;
    } catch (err) {
      logger.error({ provider: provider.id, err: String(err) }, 'oidc: token endpoint unreachable');
      return fail(reply, 'provider_unreachable');
    }

    // ── Identity: a verified signature, or a userinfo call ──
    let email: string;
    // Display only. Whatever the provider calls this person on screen — never
    // the identity, which stays the verified address.
    let displayName: string | undefined;
    if (provider.kind === 'oidc') {
      let claims: IdClaims;
      try {
        // Signature, issuer and audience against the provider's own JWKS. Belt
        // and braces given the token came straight from the token endpoint over
        // TLS, but it is what makes a misrouted or substituted token fail closed.
        const { payload } = await jwtVerify(tokens.id_token!, jwks!, {
          issuer,
          audience: provider.clientId,
        });
        claims = payload as IdClaims;
      } catch (err) {
        logger.error({ provider: provider.id, err: String(err) }, 'oidc: ID token verification failed');
        return fail(reply, 'sso_failed');
      }
      // Replay: the nonce binds this ID token to the request this browser began.
      if (!claims.nonce || !constantTimeEqual(claims.nonce, flow.nonce)) return fail(reply, 'sso_failed');
      // Accept ONLY an affirmative claim: some providers send the string
      // "false", and one that omits it has told us nothing — treating silence
      // as verified is how a self-asserted address gets in.
      if (String(claims.email_verified) !== 'true') return fail(reply, 'email_not_verified');
      email = (claims.email ?? '').toLowerCase();
      displayName = claims.name ?? claims.preferred_username;
    } else {
      try {
        const id = await fetchOauth2Identity(
          {
            userinfoEndpoint: provider.userinfoEndpoint,
            emailsEndpoint: provider.emailsEndpoint,
            accessToken: tokens.access_token!,
            emailPath: provider.emailPath,
            emailVerifiedPath: provider.emailVerifiedPath,
            emailVerifiedValue: provider.emailVerifiedValue,
            namePath: provider.namePath,
            providerId: provider.id,
          },
          doFetch,
          PROVIDER_TIMEOUT_MS,
        );
        email = id.email.toLowerCase();
        displayName = id.name;
      } catch (err) {
        logger.error({ provider: provider.id, err: String(err) }, 'oauth2: userinfo failed');
        return fail(reply, err instanceof UserinfoError ? 'no_email' : 'provider_unreachable');
      }
    }

    if (!email) return fail(reply, 'no_email');
    if (!domainAllowed(provider, email)) {
      return fail(reply, 'domain_not_allowed');
    }

    const roles = rolesForEmail(cfg().auth.sso.roles, email);
    if (roles.length === 0 && config.rbac.enabled) {
      return fail(reply, 'no_roles');
    }

    const session = deps.sessions.create(email, roles, displayName, 'sso', provider.id);
    deps.seenCache.record({ username: email, source: 'sso', roles, ip: req.ip });
    reply.setCookie(config.session.cookieName, session.sid, {
      httpOnly: true,
      sameSite: 'strict',
      secure: config.session.cookieSecure,
      path: '/',
      maxAge: config.session.ttlMinutes * 60,
    });
    // `next` is a path INSIDE the SPA, so it needs the same prefix the login
    // page gets in `fail()` — without it a prefixed deployment lands the
    // operator on the origin root, which serves someone else's application.
    return reply.redirect(`${uiBasePath(cfg())}${safeNext(flow.next)}`, 302);
  });
}

/**
 * The redirect URI. It must be BYTE-IDENTICAL between /start and the token
 * exchange or the provider rejects the code, and identical to what the operator
 * registered with the provider — which is why it is built one way, in one
 * place.
 *
 * `server.publicUrl` when set, else the request's own origin. The fallback is
 * right for a plain deployment and wrong behind anything that rewrites Host —
 * including the dev proxy, which makes the BFF see `:8081` while the operator
 * is browsing `:9091`, so the login would end on a port serving no UI.
 */
/**
 * The path Horizon is mounted under, for redirects that go to the UI.
 *
 * A gateway may serve Horizon at `https://example.com/horizon/`, which the UI
 * build already knows as `HORIZON_UI_BASE`. The server has no such setting and
 * does not need one: `server.publicUrl` must already carry the prefix for the
 * OAuth callback to work, so the same value answers this. Root-relative
 * redirects to `/login` sent an operator to the gateway's root instead.
 */
export function uiBasePath(config: HorizonConfig): string {
  const raw = config.server.publicUrl;
  if (!raw) return '';
  try {
    return new URL(raw).pathname.replace(/\/+$/, '');
  } catch {
    return '';
  }
}

function callbackUri(req: FastifyRequest, config: HorizonConfig): string {
  const base = config.server.publicUrl
    ? config.server.publicUrl.replace(/\/+$/, '')
    : `${req.protocol}://${req.headers.host ?? '127.0.0.1'}`;
  return `${base}/api/auth/oidc/callback`;
}
