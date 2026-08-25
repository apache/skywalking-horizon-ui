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
 * Horizon as an OAuth 2.1 authorization server, so an MCP client can log its
 * operator in through a browser instead of being handed a secret.
 *
 *   /.well-known/oauth-protected-resource[/api/mcp]  what this resource is, and who authorizes for it
 *   /.well-known/oauth-authorization-server          RFC 8414 metadata
 *   POST /api/oauth/register                         RFC 7591 dynamic registration
 *   GET  /api/oauth/authorize                        → the SPA's consent screen
 *   GET  /api/oauth/consent                          what the consent screen renders
 *   POST /api/oauth/consent                          the operator's decision
 *   POST /api/oauth/token                            code → token, refresh → token
 *
 * The authorize endpoint deliberately renders **Horizon's own login page** —
 * the client never sees a password, and whatever `auth.backend` is configured
 * (local, LDAP, or an external identity provider later) works unchanged,
 * because the MCP layer never learns how the login happened.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { OAuthConfig } from '../config/schema.js';
import type { AuthDeps } from '../user/middleware.js';
import { requireAuth, requireBrowserSession } from '../user/middleware.js';
import type { RoleResolver } from '../user/roles.js';
import { sign, verify } from './signing.js';
import { isLoopbackRedirect, readClient, redirectAllowed, redirectUriAcceptable, registerClient } from './clients.js';
import { uiBasePath } from '../user/oidc/route.js';
import { fetchClientMetadata, isMetadataUrl } from './client-metadata.js';
import { grantedVerbs, knownScopes, parseScope } from './scopes.js';
import { issueAccessToken, issueRefreshToken, readRefreshToken, type TokenClaims } from './tokens.js';

export interface OAuthRouteDeps extends AuthDeps {
  roles: RoleResolver;
  /** Injected for tests; the metadata fetch is the only outbound call here. */
  fetch?: typeof fetch;
}

/** How long the operator has between being sent to the consent screen and
 *  deciding. Long enough to log in on the way, short enough that a link left in
 *  a browser tab does not stay live. */
const REQUEST_TTL_MS = 10 * 60_000;
/** RFC 6749 §4.1.2: an authorization code is single-use and short-lived. It
 *  cannot be single-use here (no store), so it is very short-lived instead —
 *  and PKCE means a replayed code is useless without the verifier. */
const CODE_TTL_MS = 60_000;

interface AuthzRequest {
  clientId: string;
  redirectUri: string;
  state?: string;
  scopes: string[];
  challenge: string;
  resource?: string;
  /**
   * The name the client goes by, carried here because it cannot be looked up
   * again later. A client-id metadata client's id is a URL, not an `hzc_`
   * handle, so `readClient` returns null for it — and the name that
   * `fetchClientMetadata` did read was being dropped at the end of
   * `/authorize`, leaving the consent screen anonymous for exactly the client
   * type whose identity Horizon actually verified. The request is signed, so
   * carrying it costs no trust.
   */
  clientName?: string;
}

interface AuthzCode extends AuthzRequest {
  sub: string;
}

const oauthError = (
  reply: FastifyReply,
  status: number,
  error: string,
  description: string,
): FastifyReply => reply.code(status).send({ error, error_description: description });

/**
 * Send a protocol error back to the CLIENT via its redirect (RFC 6749
 * §4.1.2.1) — but only to a LOOPBACK address.
 *
 * The redirect is registered, so this is the shape the RFC asks for. It is
 * still an open redirect: registration is unauthenticated by spec, so anyone
 * can register `https://evil.example`, then hand out a link to
 * `/api/oauth/authorize` with a deliberately malformed `response_type` and
 * have Horizon 302 the victim there — no consent screen, no interaction, on a
 * URL that looks like ours.
 *
 * Loopback is where every real client of this server lives (Claude Code, Codex
 * and mcp-remote all bind 127.0.0.1), and a redirect to the victim's own
 * machine carries nobody anywhere. So loopback clients get their error, and
 * everything else is told here instead — the operator sees what is wrong,
 * which is more use than a silent bounce to a stranger's site.
 */
function redirectError(reply: FastifyReply, uri: string, error: string, state?: string): FastifyReply {
  const u = new URL(uri);
  const loopback = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]';
  if (!loopback) {
    return oauthError(
      reply,
      400,
      error,
      `The request is invalid (${error}). It was not sent on to ${u.origin}, because this server only returns errors to a loopback address.`,
    );
  }
  u.searchParams.set('error', error);
  // `state` is opaque to us and echoed back verbatim per RFC 6749, but it is
  // still client-supplied text going into a URL: cap it so a multi-megabyte
  // value cannot be reflected, and let URLSearchParams do the encoding rather
  // than concatenating.
  if (state) u.searchParams.set('state', state.slice(0, 512));
  return reply.redirect(u.toString(), 302);
}

const registerBody = z.object({
  redirect_uris: z.array(z.string()).min(1),
  client_name: z.string().optional(),
});

const consentBody = z.object({
  request: z.string().min(1),
  approve: z.boolean(),
});

const tokenBody = z.object({
  grant_type: z.string(),
  code: z.string().optional(),
  redirect_uri: z.string().optional(),
  client_id: z.string().optional(),
  code_verifier: z.string().optional(),
  refresh_token: z.string().optional(),
  resource: z.string().optional(),
});

export function registerOAuthRoutes(app: FastifyInstance, deps: OAuthRouteDeps): void {
  const auth = requireAuth(deps);
  const cfg = (): OAuthConfig => deps.config.current.oauth;

  const issuer = (): string => cfg().issuer.replace(/\/+$/, '');
  const key = (): string => cfg().signingKey;
  const off = (reply: FastifyReply): FastifyReply =>
    oauthError(reply, 404, 'not_found', 'This Horizon does not run an OAuth authorization server.');
  // Mirrors the boot warning in config/loader.ts: a half-configured server
  // answers 404 rather than advertising endpoints built from a blank issuer.
  const enabled = (): boolean =>
    cfg().enabled && Boolean(cfg().signingKey) && /^https?:\/\/[^/]+/.test(cfg().issuer);

  // ── Discovery ──────────────────────────────────────────────────────────
  // RFC 9728. Two paths for one document: a client that knows only the MCP
  // endpoint appends its path, and one that knows only the origin does not.
  const protectedResource = async (_req: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
    if (!enabled()) return off(reply);
    return reply.send({
      resource: `${issuer()}/api/mcp`,
      authorization_servers: [issuer()],
      scopes_supported: knownScopes(),
      bearer_methods_supported: ['header'],
    });
  };
  app.get('/.well-known/oauth-protected-resource', protectedResource);
  app.get('/.well-known/oauth-protected-resource/api/mcp', protectedResource);

  app.get('/.well-known/oauth-authorization-server', async (_req, reply) => {
    if (!enabled()) return off(reply);
    return reply.send({
      issuer: issuer(),
      authorization_endpoint: `${issuer()}/api/oauth/authorize`,
      token_endpoint: `${issuer()}/api/oauth/token`,
      registration_endpoint: `${issuer()}/api/oauth/register`,
      scopes_supported: knownScopes(),
      response_types_supported: ['code'],
      grant_types_supported: cfg().refreshTokenDays > 0 ? ['authorization_code', 'refresh_token'] : ['authorization_code'],
      // S256 only. `plain` is in the RFC and offers no protection at all on a
      // loopback redirect, which is exactly where these clients live.
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      // No revocation_endpoint: tokens are signed, not stored, so there is
      // nothing to revoke one at a time. Advertising one that quietly did
      // nothing would be worse than not having it.
    });
  });

  // ── Dynamic client registration (RFC 7591) ─────────────────────────────
  app.post('/api/oauth/register', async (req, reply) => {
    if (!enabled()) return off(reply);
    const parsed = registerBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      return oauthError(reply, 400, 'invalid_client_metadata', 'redirect_uris is required.');
    }
    const bad = parsed.data.redirect_uris.find((u) => !redirectUriAcceptable(u));
    if (bad) {
      return oauthError(
        reply,
        400,
        'invalid_redirect_uri',
        `${bad} is not acceptable — use https, an http loopback address, or a custom scheme.`,
      );
    }
    const clientId = registerClient(key(), {
      redirectUris: parsed.data.redirect_uris,
      clientName: parsed.data.client_name,
    });
    return reply.code(201).send({
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      redirect_uris: parsed.data.redirect_uris,
      ...(parsed.data.client_name ? { client_name: parsed.data.client_name } : {}),
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    });
  });

  // ── Authorize ──────────────────────────────────────────────────────────
  app.get('/api/oauth/authorize', async (req, reply) => {
    if (!enabled()) return off(reply);
    const q = req.query as Record<string, string | undefined>;

    // Everything before the redirect is validated is answered HERE, not
    // bounced: an error sent to an unverified redirect_uri would make this an
    // open redirector, and the operator seeing the message is the point.
    // TWO ways to be a client. A registered one presents the signed id we
    // issued; a metadata one presents a URL we fetch. Claude Code does the
    // second, so without it the primary client of this server is turned away
    // at the first step.
    let client = null;
    if (q.client_id && isMetadataUrl(q.client_id)) {
      try {
        client = await fetchClientMetadata(q.client_id, cfg().clientMetadataHosts, deps.fetch);
      } catch (err) {
        // The detail goes to the LOG, never to the caller. This endpoint is
        // unauthenticated and needs only a client_id, so echoing back "…
        // resolves to a non-public address (10.4.1.9)" or "could not resolve
        // <host>" turns it into a scanner: sweep internal names, read the
        // private addresses and which names exist. The operator reading the log
        // still gets the exact reason.
        req.log.warn({ clientId: q.client_id, err: String(err) }, 'oauth: client metadata rejected');
        return oauthError(reply, 400, 'invalid_client', 'Could not read the client metadata document.');
      }
    } else if (q.client_id) {
      client = readClient(key(), q.client_id);
    }
    if (!client) {
      return oauthError(reply, 400, 'invalid_client', 'Unknown or malformed client_id. Register first, or present a client-id metadata URL.');
    }
    if (!q.redirect_uri || !redirectAllowed(client.redirectUris, q.redirect_uri)) {
      return oauthError(reply, 400, 'invalid_request', 'redirect_uri does not match this client registration.');
    }

    // From here the redirect is trusted, so the client learns what went wrong.
    if (q.response_type !== 'code') {
      return redirectError(reply, q.redirect_uri, 'unsupported_response_type', q.state);
    }
    if (!q.code_challenge || q.code_challenge_method !== 'S256') {
      return redirectError(reply, q.redirect_uri, 'invalid_request', q.state);
    }
    const { scopes, unknown } = parseScope(q.scope);
    if (unknown) return redirectError(reply, q.redirect_uri, 'invalid_scope', q.state);

    // RFC 8707: a client names the resource it wants a token FOR. Horizon
    // advertises exactly one, so anything else is refused rather than carried
    // into the token as an audience nothing will ever accept — a client that
    // asked for the wrong resource should learn it here, not on its first call.
    if (q.resource && q.resource !== `${issuer()}/api/mcp`) {
      return redirectError(reply, q.redirect_uri, 'invalid_target', q.state);
    }
    const request: AuthzRequest = {
      clientId: q.client_id!,
      redirectUri: q.redirect_uri,
      state: q.state,
      scopes,
      challenge: q.code_challenge,
      resource: q.resource,
      clientName: client.clientName,
    };
    // The SPA route is not public, so an operator who is not signed in is sent
    // to Horizon's own login page by the router guard and returns here after —
    // which is how LDAP, and any future identity provider, works for MCP
    // without the MCP layer knowing anything about it.
    const blob = encodeURIComponent(sign(key(), 'request', request, REQUEST_TTL_MS));
    return reply.redirect(`${uiBasePath(deps.config.current)}/oauth/consent?request=${blob}`, 302);
  });

  // What the consent screen renders. Behind a browser SESSION specifically, so
  // reaching it proves a person is signed in — and it reports THEIR name, so a
  // shared browser shows whose access is about to be lent out.
  app.get('/api/oauth/consent', { preHandler: auth }, async (req, reply) => {
    if (!enabled()) return off(reply);
    if (!requireBrowserSession(req, reply)) return reply;
    const raw = (req.query as { request?: string }).request;
    const request = raw ? verify<AuthzRequest>(key(), 'request', raw) : null;
    if (!request) {
      return oauthError(reply, 400, 'invalid_request', 'This authorization request has expired. Start again from your client.');
    }
    const session = req.session!;
    return reply.send({
      clientName: request.clientName ?? '',
      // Present ONLY for a client that identified itself by URL, and it is the
      // one identity here that was checked rather than typed: the document at
      // that address had to name this same client_id back. A registered client
      // has an `hzc_` handle instead, which says nothing to a reader, so the
      // screen has only a self-asserted name to go on and must say so.
      clientUrl: isMetadataUrl(request.clientId) ? request.clientId : undefined,
      redirectUri: request.redirectUri,
      scopes: request.scopes,
      username: session.username,
      roles: session.roles,
      verbs: grantedVerbs(deps.config.current, session.roles, request.scopes),
    });
  });

  app.post('/api/oauth/consent', { preHandler: auth }, async (req, reply) => {
    if (!enabled()) return off(reply);
    // A grant is issued by a PERSON, never by a credential acting for one —
    // otherwise a horizon:read token approves its own promotion to
    // horizon:full and the scope cap protects nothing. See requireBrowserSession.
    if (!requireBrowserSession(req, reply)) return reply;
    const parsed = consentBody.safeParse(req.body ?? {});
    if (!parsed.success) return oauthError(reply, 400, 'invalid_request', 'Malformed consent decision.');
    const request = verify<AuthzRequest>(key(), 'request', parsed.data.request);
    if (!request) {
      return oauthError(reply, 400, 'invalid_request', 'This authorization request has expired. Start again from your client.');
    }
    const session = req.session!;

    if (!parsed.data.approve) {
      // Declining must not NAVIGATE anywhere a stranger chose. Registration is
      // open by design, so anyone can register `https://horizon-corp-sso.evil`
      // as a redirect and send an operator a link on Horizon's own origin —
      // and it is the safe action, Cancel, that would deliver them there, from
      // a trusted origin, to a page free to imitate this one.
      //
      // A loopback redirect is different in kind: it reaches a listener on the
      // operator's own machine, which is where every real MCP client lives
      // (RFC 8252), so telling it the request was declined costs nothing and
      // saves it from waiting for a callback that will never come. Anything
      // remote is simply not told; the UI ends the flow on this origin.
      if (!isLoopbackRedirect(request.redirectUri)) return reply.send({ declined: true });
      const u = new URL(request.redirectUri);
      u.searchParams.set('error', 'access_denied');
      if (request.state) u.searchParams.set('state', request.state);
      return reply.send({ redirectTo: u.toString(), declined: true });
    }

    const code: AuthzCode = { ...request, sub: session.username };
    const u = new URL(request.redirectUri);
    u.searchParams.set('code', sign(key(), 'code', code, CODE_TTL_MS));
    if (request.state) u.searchParams.set('state', request.state);
    return reply.send({ redirectTo: u.toString() });
  });

  // ── Token ──────────────────────────────────────────────────────────────
  app.post('/api/oauth/token', async (req, reply) => {
    if (!enabled()) return off(reply);
    const parsed = tokenBody.safeParse(req.body ?? {});
    if (!parsed.success) return oauthError(reply, 400, 'invalid_request', 'Malformed token request.');
    const b = parsed.data;
    const accessTtl = cfg().accessTokenMinutes * 60_000;
    const refreshTtl = cfg().refreshTokenDays * 86_400_000;

    const respond = (claims: Omit<TokenClaims, 'jti'>): FastifyReply =>
      reply.send({
        access_token: issueAccessToken(key(), claims, accessTtl),
        token_type: 'Bearer',
        expires_in: Math.floor(accessTtl / 1000),
        scope: claims.scope,
        ...(refreshTtl > 0 ? { refresh_token: issueRefreshToken(key(), claims, refreshTtl) } : {}),
      });

    if (b.grant_type === 'authorization_code') {
      if (!b.code || !b.code_verifier) {
        return oauthError(reply, 400, 'invalid_request', 'code and code_verifier are required.');
      }
      const code = verify<AuthzCode>(key(), 'code', b.code);
      if (!code) return oauthError(reply, 400, 'invalid_grant', 'The authorization code is invalid or has expired.');
      // Bind the code to the same client and redirect it was issued for, or a
      // code intercepted from one client could be redeemed by another.
      if (b.client_id && b.client_id !== code.clientId) {
        return oauthError(reply, 400, 'invalid_grant', 'This code was issued to a different client.');
      }
      if (b.redirect_uri && b.redirect_uri !== code.redirectUri) {
        return oauthError(reply, 400, 'invalid_grant', 'redirect_uri does not match the one the code was issued for.');
      }
      const computed = createHash('sha256').update(b.code_verifier, 'utf8').digest('base64url');
      if (computed !== code.challenge) {
        return oauthError(reply, 400, 'invalid_grant', 'PKCE verification failed.');
      }
      return respond({
        sub: code.sub,
        scope: code.scopes.join(' '),
        ...(code.resource ? { aud: code.resource } : {}),
      });
    }

    if (b.grant_type === 'refresh_token') {
      if (refreshTtl === 0) {
        return oauthError(reply, 400, 'unsupported_grant_type', 'Refresh tokens are disabled on this server.');
      }
      if (!b.refresh_token) return oauthError(reply, 400, 'invalid_request', 'refresh_token is required.');
      const claims = readRefreshToken(key(), b.refresh_token);
      if (!claims) return oauthError(reply, 400, 'invalid_grant', 'The refresh token is invalid or has expired.');
      // Roles are NOT carried over — they are re-read on every request from the
      // token's username, so a refresh cannot resurrect access its owner lost.
      return respond({ sub: claims.sub, scope: claims.scope, ...(claims.aud ? { aud: claims.aud } : {}) });
    }

    return oauthError(reply, 400, 'unsupported_grant_type', `${b.grant_type} is not supported.`);
  });
}
