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

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AuditLogger } from '../audit/logger.js';
import { badRequest, unauthorized } from '../errors.js';
import type { ConfigSource } from '../config/loader.js';
import { resolveVerbsForRoles } from '../rbac/verbs.js';
import { verifyLocalCredentials } from './local.js';
import type { SessionStore } from './sessions.js';

const loginBodySchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

export function registerAuthRoutes(
  app: FastifyInstance,
  source: ConfigSource,
  sessions: SessionStore,
  audit: AuditLogger,
): void {
  const cookieName = () => source.current.session.cookieName;
  const cookieSecure = () => source.current.session.cookieSecure;
  const ttlMs = () => source.current.session.ttlMinutes * 60_000;

  app.post('/api/auth/login', async (req, reply) => {
    const parsed = loginBodySchema.safeParse(req.body);
    if (!parsed.success) throw badRequest('invalid login body', parsed.error.flatten());

    const verified = await verifyLocalCredentials(
      source.current,
      parsed.data.username,
      parsed.data.password,
    );
    if (!verified) {
      audit.record({ actor: parsed.data.username, action: 'auth.login', outcome: 'failure' });
      throw unauthorized('invalid credentials');
    }

    const session = sessions.create(verified.username, verified.roles);
    audit.record({ actor: session.username, action: 'auth.login', outcome: 'success' });
    reply.setCookie(cookieName(), session.sid, {
      httpOnly: true,
      sameSite: 'strict',
      secure: cookieSecure(),
      path: '/',
      maxAge: Math.floor(ttlMs() / 1000),
    });
    return { username: session.username, roles: session.roles };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const sid = req.cookies[cookieName()];
    if (sid) {
      const session = sessions.touch(sid);
      if (session) audit.record({ actor: session.username, action: 'auth.logout', outcome: 'success' });
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
    const verbs = resolveVerbsForRoles(
      source.current.rbac.roles,
      session.roles,
      source.current.rbac.enabled,
    );
    return { username: session.username, roles: session.roles, verbs };
  });
}
