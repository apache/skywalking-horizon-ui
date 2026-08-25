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
 * Access and refresh tokens issued by Horizon's authorization server, and the
 * resolver that turns one back into an identity.
 *
 * The token carries a USERNAME and a SCOPE — never roles. Roles are re-read
 * from the auth backend on every request, exactly as an API token does, so:
 * deleting the user revokes the token immediately, a demotion applies at the
 * next request, and a token minted while someone was an admin does not keep
 * admin rights after they stop being one.
 */

import type { ConfigSource } from '../config/loader.js';
import type { RoleResolver } from '../user/roles.js';
import { sign, verify, newId } from './signing.js';
import { logger } from '../logger.js';
import { verbCapFor } from './scopes.js';

const ACCESS_PREFIX = 'hzo_';
const REFRESH_PREFIX = 'hzr_';

export interface TokenClaims {
  /** Horizon username the operator logged in as. */
  sub: string;
  /** Granted scopes, space-joined on the wire as OAuth spells them. */
  scope: string;
  /** The `resource` the client asked the token for (RFC 8707), when it sent
   *  one. Recorded so a token minted for this Horizon is visibly for this
   *  Horizon; MCP clients are required to send it. */
  aud?: string;
  /** Names the credential in a log line without the credential appearing. */
  jti: string;
}

export interface OAuthIdentity {
  username: string;
  roles: string[];
  verbCap?: string[];
  scope: string;
  tokenId: string;
}

export function issueAccessToken(key: string, claims: Omit<TokenClaims, 'jti'>, ttlMs: number): string {
  return `${ACCESS_PREFIX}${sign(key, 'access', { ...claims, jti: newId() }, ttlMs)}`;
}

export function issueRefreshToken(key: string, claims: Omit<TokenClaims, 'jti'>, ttlMs: number): string {
  return `${REFRESH_PREFIX}${sign(key, 'refresh', { ...claims, jti: newId() }, ttlMs)}`;
}

export function readRefreshToken(key: string, raw: string): TokenClaims | null {
  if (!raw.startsWith(REFRESH_PREFIX)) return null;
  return verify<TokenClaims>(key, 'refresh', raw.slice(REFRESH_PREFIX.length));
}

/**
 * Resolve an `Authorization: Bearer` value issued by this server.
 *
 * Returns null for anything that is not one — including a perfectly good
 * `hzn_` API token, which the other resolver owns. The two live side by side
 * in `requireAuth` and are told apart by prefix.
 */
export class OAuthTokenResolver {
  constructor(
    private readonly config: ConfigSource,
    private readonly roles: RoleResolver,
  ) {}

  /**
   * Does this `aud` name a resource this deployment actually authorizes for?
   *
   * EXACT, against the list discovery advertises — not "anything under the
   * issuer". A prefix match accepted `${issuer}/api/not-mcp`, an audience this
   * server never offers and never mints, so a token minted elsewhere for a
   * made-up resource under the same origin authenticated here. The advertised
   * set is one entry today; keeping it a list is what stops the check drifting
   * from what `/.well-known/oauth-protected-resource` promises.
   */
  private audienceIsOurs(aud: string): boolean {
    const issuer = this.config.current.oauth.issuer.replace(/\/+$/, '');
    if (!issuer) return false;
    return aud === issuer || aud === `${issuer}/api/mcp`;
  }

  async resolve(authorization: string | undefined): Promise<OAuthIdentity | null> {
    const cfg = this.config.current.oauth;
    if (!cfg.enabled || !cfg.signingKey) return null;
    // RFC 7235 makes the scheme case-insensitive, and clients do send `bearer`.
    if (!authorization || authorization.slice(0, 7).toLowerCase() !== 'bearer ') return null;
    const raw = authorization.slice(7).trim();
    if (!raw.startsWith(ACCESS_PREFIX)) return null;
    const claims = verify<TokenClaims>(cfg.signingKey, 'access', raw.slice(ACCESS_PREFIX.length));
    if (!claims) return null;
    // The audience was recorded and never checked, so `resource` was decoration:
    // a client that believed it had scoped its token had not, and a token minted
    // naming some other resource was accepted here unchanged. When the claim is
    // present it must name THIS deployment. It is not required, because a client
    // that sends no `resource` is asking for a token for Horizon itself, and the
    // signature already proves which Horizon issued it.
    if (claims.aud && !this.audienceIsOurs(claims.aud)) {
      logger.warn(
        { aud: claims.aud, issuer: cfg.issuer },
        'oauth: refusing a token minted for another resource',
      );
      return null;
    }
    // Existence first, and independently of roles — see the same guard in
    // user/tokens.ts. An access token outliving its owner is the one thing this
    // stateless design has to get right, and under `rbac.enabled: false` the
    // role list cannot carry that answer.
    if (!(await this.roles.knows(claims.sub))) return null;
    const live = await this.roles.rolesFor(claims.sub);
    // With RBAC off every session holds `*`, so a role-less user signs in fine
    // in the browser; refusing their token would make the two credentials
    // disagree about the same person.
    if (live.length === 0 && this.config.current.rbac.enabled) return null;
    return {
      username: claims.sub,
      roles: live,
      verbCap: verbCapFor(claims.scope.split(' ').filter(Boolean)),
      scope: claims.scope,
      tokenId: claims.jti,
    };
  }
}
