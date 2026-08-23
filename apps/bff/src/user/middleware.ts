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
 * Per-request authentication pre-handler. Verb gating is applied separately
 * by the ROUTE_POLICY `onRoute` hook (rbac/route-policy.ts); routes wire only
 * `requireAuth` here.
 *
 * It sends a JSON 401 and short-circuits when there's no valid session, using
 * `reply.code(...).send(...)` rather than `throw` because Fastify's global
 * error handler swallows the `WWW-Authenticate`-style metadata we may want to
 * attach in the future.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ConfigSource } from '../config/loader.js';
import type { Session, SessionStore } from './sessions.js';
import type { TokenStore } from './tokens.js';
import type { OAuthTokenResolver } from '../oauth/tokens.js';
import type { AuditService } from '../store/audit/types.js';

/**
 * WHICH credential authenticated a request.
 *
 * Almost every route is indifferent to this — that is the point of accepting
 * three credentials at one seam. The exception is any route that GRANTS
 * authority rather than exercising it: consenting to an OAuth scope is
 * something a person does in a browser, and a delegated credential presenting
 * itself there is a token approving its own promotion.
 */
export type AuthKind = 'session' | 'api-token' | 'oauth-token';

declare module 'fastify' {
  interface FastifyRequest {
    session?: Session;
    /** Set when the request authenticated with an API token rather than a
     *  session cookie. */
    tokenId?: string;
    authKind?: AuthKind;
  }
}

export interface AuthDeps {
  config: ConfigSource;
  sessions: SessionStore;
  /** API-token credential. Absent in tests and wherever token auth is not
   *  wired; the cookie path is unaffected either way. */
  tokens?: TokenStore;
  /** OAuth access tokens this Horizon issued. Absent unless `oauth.enabled`
   *  is wired; told apart from an API token by prefix, not by trying both. */
  oauthTokens?: OAuthTokenResolver;
  /** Counts ACCEPTED token uses. Absent in tests; a token is presented on
   *  every request, so uses are counted in memory and written per hour rather
   *  than one row per request. */
  audit?: AuditService;
}

/**
 * A 401 that tells an MCP client where to log in.
 *
 * RFC 9728 §5.1: the challenge names the resource-metadata document, and that
 * is the whole discovery chain for an agent — a bare 401 leaves Claude Code or
 * Codex with nothing to do but report a failure, while this one makes it open
 * a browser. Only sent when the authorization server is actually running;
 * pointing at a document that 404s would be worse than staying silent.
 */
function unauthenticated(deps: AuthDeps, req: FastifyRequest, reply: FastifyReply): void {
  const oauth = deps.config.current.oauth;
  if (oauth.enabled && oauth.issuer && oauth.signingKey && req.url.startsWith('/api/mcp')) {
    const meta = `${oauth.issuer.replace(/\/+$/, '')}/.well-known/oauth-protected-resource`;
    reply.header('WWW-Authenticate', `Bearer resource_metadata="${meta}"`);
  }
  reply.code(401).send({ error: 'unauthenticated' });
}

/**
 * Refuse a request that authenticated with anything but a browser session.
 *
 * For routes that hand out authority. Without it, `POST /api/oauth/consent`
 * accepts an OAuth access token like any other route — and an agent holding a
 * `horizon:read` token can then register a client, drive the authorize step,
 * approve its OWN consent for `horizon:full`, and redeem a token wider than
 * the one it was given. The scope cap is enforced perfectly on every data
 * route and is worth nothing if the grant itself can be self-issued.
 *
 * A session cookie is the only credential that proves a person is present:
 * it is set by a password login, it is `SameSite=strict`, and it cannot be
 * replayed by a background process holding a bearer string.
 */
export function requireBrowserSession(req: FastifyRequest, reply: FastifyReply): boolean {
  if (req.authKind === 'session') return true;
  reply.code(403).send({
    error: 'browser_session_required',
    error_description:
      'Granting access is done by a signed-in person in a browser. An API or OAuth token cannot approve a grant, including its own.',
  });
  return false;
}

export function requireAuth(deps: AuthDeps) {
  return async function authPreHandler(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    // A bearer token is the non-browser credential (scripts, CI, MCP clients).
    // It resolves to the same session shape a login produces, so it is checked
    // here rather than per route: every route then accepts it under the verb
    // policy it already declares, and none needs auth code of its own.
    // An OAuth token this server issued. Checked first because it is the
    // credential that carries a scope cap — and because both resolvers refuse
    // anything without their own prefix, so the order is about clarity, not
    // correctness.
    const oauth = await deps.oauthTokens?.resolve(req.headers.authorization);
    if (oauth) {
      const now = Date.now();
      req.session = {
        sid: `oauth:${oauth.tokenId}`,
        username: oauth.username,
        roles: oauth.roles,
        // The consented scope, carried into every verb check. See VerbSubject.
        verbCap: oauth.verbCap,
        authSource: 'oauth-token',
        createdAt: now,
        lastSeenAt: now,
      };
      req.tokenId = oauth.tokenId;
      req.authKind = 'oauth-token';
      // Deliberately NOT counted as token usage. This token is minted by
      // Horizon's own authorization server for a single sign-in, so the sign-in
      // it came from is already an audit row; counting its requests too would
      // report one person's session as machine traffic.
      return;
    }
    const bearer = await deps.tokens?.resolve(req.headers.authorization);
    if (bearer) {
      const now = Date.now();
      req.session = {
        // No server-side session row exists for a token, so `sid` names the
        // token instead — log lines then say which credential was used.
        sid: `token:${bearer.tokenId}`,
        username: bearer.username,
        roles: bearer.roles,
        authSource: 'api-token',
        createdAt: now,
        lastSeenAt: now,
      };
      req.tokenId = bearer.tokenId;
      req.authKind = 'api-token';
      // The token id names the credential that was presented; the username is
      // carried so a reader need not join against a tokens file that may since
      // have changed.
      deps.audit?.countTokenUse({
        tokenId: bearer.tokenId, username: bearer.username, at: now,
      });
      return;
    }
    const cookieName = deps.config.current.session.cookieName;
    const sid = req.cookies?.[cookieName];
    if (!sid) {
      return void unauthenticated(deps, req, reply);
    }
    const session = deps.sessions.touch(sid);
    if (!session) {
      return void unauthenticated(deps, req, reply);
    }
    req.session = session;
    req.authKind = 'session';
    // Sliding session: touch() just slid the server-side TTL, so
    // re-stamp the cookie's maxAge to match. The cookie's expiry was
    // set only at login, so without this an actively-used session still
    // expires in the browser at login + ttl while the server believes
    // it's alive — the user is logged out mid-session. Mirror the login
    // cookie options exactly so only maxAge slides.
    const s = deps.config.current.session;
    reply.setCookie(s.cookieName, sid, {
      httpOnly: true,
      sameSite: 'strict',
      secure: s.cookieSecure,
      path: '/',
      maxAge: s.ttlMinutes * 60,
    });
  };
}
