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
 * Login / logout / current-user routes.
 *
 * The login handler dispatches to the configured backend:
 *
 *   - `local` → verify against `auth.local.users` (argon2id hashes).
 *   - `ldap`  → verify by binding as the user against the directory.
 *               If the directory is unreachable AND `auth.breakGlass`
 *               is configured, fall back to verifying the break-glass
 *               credentials. Every break-glass success is logged at
 *               WARN level with the source IP.
 *
 * Logout and `/api/auth/me` are backend-agnostic.
 */

import type { AuthDeps } from '../user/middleware.js';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { badRequest, unauthorized } from '../errors.js';
import { resolveVerbsForRoles } from '../rbac/verbs.js';
import { verifyLocalCredentials, type VerifiedUser } from '../user/local.js';
import { auditReasonOf, granted, refused, type Verified } from '../user/outcome.js';
import { verifyLdapCredentials } from '../user/ldap.js';
import { verifyBreakGlass } from '../user/break-glass.js';
import type { LdapHealth } from '../user/ldap-health.js';
import type { UserSeenCache, SeenSource } from '../user/seen-cache.js';
import type { Session } from '../user/sessions.js';
import type { HorizonConfig } from '../config/schema.js';
import { logger } from '../logger.js';
import type { AuditService } from '../store/audit/types.js';

/**
 * The stable identity to meter a principal by.
 *
 * A directory DN names one account whatever spelling was typed at the login
 * form; a local account is already its config key. Only the audit budget uses
 * this — it is never recorded.
 */
function canonicalKey(identity: VerifiedUser & { dn?: string }): string {
  return identity.dn ?? identity.username;
}

const loginBodySchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

export interface AuthRouteDeps extends AuthDeps {
  ldapHealth: LdapHealth;
  seenCache: UserSeenCache;
  /** Always present — a deployment with the feature off gets a no-op service,
   *  so no emit site needs to know whether auditing is configured. */
  audit: AuditService;
}

export function registerAuthRoutes(app: FastifyInstance, deps: AuthRouteDeps): void {
  const { config: source, sessions, ldapHealth, seenCache, audit } = deps;
  const cookieName = () => source.current.session.cookieName;
  const cookieSecure = () => source.current.session.cookieSecure;
  const ttlMs = () => source.current.session.ttlMinutes * 60_000;

  app.post('/api/auth/login', async (req, reply) => {
    const parsed = loginBodySchema.safeParse(req.body);
    if (!parsed.success) throw badRequest('invalid login body', parsed.error.flatten());
    const { username, password } = parsed.data;
    const cfg = source.current;
    const fromIp = req.ip;

    let outcome: Verified<VerifiedUser> = refused('backend_unreachable');
    let source_: SeenSource = cfg.auth.backend === 'ldap' ? 'ldap' : 'local';

    if (cfg.auth.backend === 'local') {
      outcome = await verifyLocalCredentials(cfg, username, password);
      source_ = 'local';
    } else if (cfg.auth.backend === 'ldap' && cfg.auth.ldap) {
      outcome = await verifyLdapCredentials(cfg.auth.ldap, username, password);
      // If LDAP rejected (or threw) and break-glass is armed, refresh
      // health and consider the fallback.
      if (!outcome.ok && cfg.auth.breakGlass) {
        await ldapHealth.probe(cfg.auth.ldap).catch(() => undefined);
        if (ldapHealth.isUnhealthy()) {
          const bg = await verifyBreakGlass(cfg.auth.breakGlass, username, password);
          if (bg) {
            outcome = granted(bg);
            source_ = 'break-glass';
            logger.warn({ username, fromIp }, 'auth: break-glass login granted (LDAP unhealthy)');
          }
        }
      }
    } else {
      logger.error(
        { backend: cfg.auth.backend },
        'auth: backend is ldap but auth.ldap is missing; refusing login',
      );
    }

    if (!outcome.ok) {
      // Only a refusal reached AFTER authentication succeeded is recordable —
      // it carries a verified principal and is bounded by the real user count.
      // Everything else an anonymous caller can trigger stays log-only, which
      // is what keeps this table unreachable without a credential.
      const auditReason = auditReasonOf(outcome.reason);
      if (auditReason && outcome.identity) {
        audit.recordEvent({
          at: Date.now(),
          kind: source_ === 'break-glass' ? 'break-glass' : source_,
          outcome: 0,
          reason: auditReason,
          username: outcome.identity.username,
          // Empty on a policy refusal — that IS the finding.
          roles: outcome.identity.roles.join(','),
          principalKey: canonicalKey(outcome.identity),
          clientIp: fromIp,
        });
      }
    }

    const verified = outcome.ok ? outcome.identity : null;
    if (!verified) {
      // The only record a rejected sign-in leaves, and it is `warn` rather than
      // `info` so that a production default of `warn` still shows a brute-force
      // attempt rather than nothing at all. The typed password is never
      // included, and the reason stays coarse on purpose — "no such user" and
      // "wrong password" must not be distinguishable here.
      logger.warn(
        { username, fromIp, backend: cfg.auth.backend, reason: outcome.ok ? undefined : outcome.reason },
        'auth: login rejected',
      );
      throw unauthorized('invalid credentials');
    }

    const session = sessions.create(verified.username, verified.roles, verified.displayName, source_);
    // The other half of the sign-in record. A refusal is logged at `warn` so a
    // production default surfaces a brute-force attempt; a SUCCESS is `info`,
    // because one line per login at `warn` would drown the refusals that matter
    // — an operator who wants the successes lowers LOG_LEVEL to `info` and gets
    // them. The roles are included: what someone was granted at sign-in is the
    // part a browser session then carries until they sign in again.
    logger.info(
      { username: verified.username, roles: verified.roles, source: source_, fromIp },
      'auth: login succeeded',
    );
    seenCache.record({
      username: verified.username,
      source: source_,
      roles: verified.roles,
      ip: fromIp,
    });
    audit.recordEvent({
      at: Date.now(),
      kind: source_ === 'break-glass' ? 'break-glass' : source_,
      outcome: 1,
      username: verified.username,
      // What this sign-in GRANTED. A browser session carries it until the
      // person signs in again, and a role table read later has since changed.
      roles: verified.roles.join(','),
      principalKey: canonicalKey(verified),
      clientIp: fromIp,
    });
    reply.setCookie(cookieName(), session.sid, {
      httpOnly: true,
      sameSite: 'strict',
      secure: cookieSecure(),
      path: '/',
      maxAge: Math.floor(ttlMs() / 1000),
    });
    // Same payload as `/api/auth/me` — the UI's auth store doesn't
    // need a second round-trip to know what the new session can do.
    return mePayload(cfg, session);
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const sid = req.cookies[cookieName()];
    // `touch` used to run first only to name the session in an audit line.
    if (sid) sessions.destroy(sid);
    reply.clearCookie(cookieName(), { path: '/' });
    return { status: 'ok' };
  });

  app.get('/api/auth/me', async (req) => {
    // `requireAuth` (attached by the route-policy hook) already resolved the
    // caller — from a session cookie or an API token. Re-reading the cookie
    // here would answer 401 to a perfectly valid token holder.
    const session = req.session;
    if (!session) throw unauthorized();
    return mePayload(source.current, session);
  });
}

/**
 * What a caller is told about itself, built in ONE place so login and
 * `/api/auth/me` cannot drift apart — the UI treats the login reply as a `me`
 * and would silently lose any field added to only one of them.
 *
 * `authSource` and `provider` are reported, never consulted: permissions come
 * from roles, which re-resolve from the username on every request.
 */
function mePayload(cfg: HorizonConfig, session: Session) {
  return {
    username: session.username,
    displayName: session.displayName,
    authSource: session.authSource,
    provider: session.provider,
    providerName: providerLabel(cfg, session.provider),
    roles: session.roles,
    verbs: resolveVerbsForRoles(cfg.rbac.roles, session.roles, cfg.rbac.enabled),
    landingRoute: pickLandingRoute(cfg.rbac.landingByRole, session.roles),
  };
}

/** The provider's configured display name — what the operator sees on the
 *  sign-in button — rather than its config id. */
function providerLabel(cfg: HorizonConfig, providerId?: string): string | undefined {
  if (!providerId) return undefined;
  const p = cfg.auth.sso?.providers.find((x) => x.id === providerId);
  return p ? p.displayName || p.id : providerId;
}

/** Pick the landing route for a session — first matching role wins, falling back to '/'. */
function pickLandingRoute(
  landingByRole: Record<string, string>,
  roles: readonly string[],
): string {
  for (const r of roles) {
    if (landingByRole[r]) return landingByRole[r];
  }
  return '/';
}
