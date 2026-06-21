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

declare module 'fastify' {
  interface FastifyRequest {
    session?: Session;
  }
}

export interface AuthDeps {
  config: ConfigSource;
  sessions: SessionStore;
}

export function requireAuth(deps: AuthDeps) {
  return async function authPreHandler(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const cookieName = deps.config.current.session.cookieName;
    const sid = req.cookies?.[cookieName];
    if (!sid) {
      return void reply.code(401).send({ error: 'unauthenticated' });
    }
    const session = deps.sessions.touch(sid);
    if (!session) {
      return void reply.code(401).send({ error: 'unauthenticated' });
    }
    req.session = session;
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
