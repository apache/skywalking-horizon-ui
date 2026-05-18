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
 *               credentials. Every break-glass success is audited at
 *               WARN level with the source IP.
 *
 * Logout and `/api/auth/me` are backend-agnostic.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AuditLogger } from '../audit/logger.js';
import { badRequest, unauthorized } from '../errors.js';
import type { ConfigSource } from '../config/loader.js';
import { resolveVerbsForRoles } from '../rbac/verbs.js';
import { verifyLocalCredentials, type VerifiedUser } from '../user/local.js';
import { verifyLdapCredentials } from '../user/ldap.js';
import { verifyBreakGlass } from '../user/break-glass.js';
import type { LdapHealth } from '../user/ldap-health.js';
import type { UserSeenCache, SeenSource } from '../user/seen-cache.js';
import type { SessionStore } from '../user/sessions.js';
import { logger } from '../logger.js';

const loginBodySchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

export interface AuthRouteDeps {
  config: ConfigSource;
  sessions: SessionStore;
  audit: AuditLogger;
  ldapHealth: LdapHealth;
  seenCache: UserSeenCache;
}

export function registerAuthRoutes(app: FastifyInstance, deps: AuthRouteDeps): void {
  const { config: source, sessions, audit, ldapHealth, seenCache } = deps;
  const cookieName = () => source.current.session.cookieName;
  const cookieSecure = () => source.current.session.cookieSecure;
  const ttlMs = () => source.current.session.ttlMinutes * 60_000;

  app.post('/api/auth/login', async (req, reply) => {
    const parsed = loginBodySchema.safeParse(req.body);
    if (!parsed.success) throw badRequest('invalid login body', parsed.error.flatten());
    const { username, password } = parsed.data;
    const cfg = source.current;
    const fromIp = req.ip;

    let verified: VerifiedUser | null = null;
    let outcomeDetail: string = 'success';
    let source_: SeenSource = cfg.auth.backend === 'ldap' ? 'ldap' : 'local';

    if (cfg.auth.backend === 'local') {
      verified = await verifyLocalCredentials(cfg, username, password);
      source_ = 'local';
    } else if (cfg.auth.backend === 'ldap' && cfg.auth.ldap) {
      verified = await verifyLdapCredentials(cfg.auth.ldap, username, password);
      // If LDAP rejected (or threw) and break-glass is armed, refresh
      // health and consider the fallback.
      if (!verified && cfg.auth.breakGlass) {
        await ldapHealth.probe(cfg.auth.ldap).catch(() => undefined);
        if (ldapHealth.isUnhealthy()) {
          const bg = await verifyBreakGlass(cfg.auth.breakGlass, username, password);
          if (bg) {
            verified = bg;
            outcomeDetail = 'break-glass';
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

    if (!verified) {
      audit.record({
        actor: username,
        action: 'auth.login',
        outcome: 'failure',
        fromIp,
        details: { backend: cfg.auth.backend },
      });
      throw unauthorized('invalid credentials');
    }

    const session = sessions.create(verified.username, verified.roles);
    seenCache.record({
      username: verified.username,
      source: source_,
      roles: verified.roles,
      ip: fromIp,
    });
    audit.record({
      actor: session.username,
      action: outcomeDetail === 'break-glass' ? 'auth.login.break-glass' : 'auth.login',
      outcome: outcomeDetail,
      fromIp,
      sessionId: session.sid,
      details: { backend: cfg.auth.backend, roles: session.roles },
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
    const verbs = resolveVerbsForRoles(cfg.rbac.roles, session.roles, cfg.rbac.enabled);
    return {
      username: session.username,
      roles: session.roles,
      verbs,
      landingRoute: pickLandingRoute(cfg.rbac.landingByRole, session.roles),
    };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const sid = req.cookies[cookieName()];
    if (sid) {
      const session = sessions.touch(sid);
      if (session) {
        audit.record({
          actor: session.username,
          action: 'auth.logout',
          outcome: 'success',
          fromIp: req.ip,
          sessionId: sid,
        });
      }
      sessions.destroy(sid);
    }
    reply.clearCookie(cookieName(), { path: '/' });
    return { status: 'ok' };
  });

  app.get('/api/auth/me', async (req) => {
    const sid = req.cookies[cookieName()];
    if (!sid) throw unauthorized();
    const session = sessions.touch(sid);
    if (!session) throw unauthorized();
    const cfg = source.current;
    const verbs = resolveVerbsForRoles(cfg.rbac.roles, session.roles, cfg.rbac.enabled);
    const landing = pickLandingRoute(cfg.rbac.landingByRole, session.roles);
    return {
      username: session.username,
      roles: session.roles,
      verbs,
      landingRoute: landing,
    };
  });
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
