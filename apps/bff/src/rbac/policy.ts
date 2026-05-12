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

import type { FastifyReply, FastifyRequest } from 'fastify';
import { forbidden, unauthorized } from '../errors.js';
import type { Session } from '../auth/sessions.js';
import type { SessionStore } from '../auth/sessions.js';
import type { ConfigSource } from '../config/loader.js';
import { hasVerb, resolveVerbsForRoles, type Verb } from './verbs.js';

// Augment Fastify's request type so handlers can `req.session` without casts.
declare module 'fastify' {
  interface FastifyRequest {
    session?: Session;
    verbs?: Verb[];
  }
}

export function makeRequireAuth(source: ConfigSource, sessions: SessionStore) {
  return async function requireAuth(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
    const cookieName = source.current.session.cookieName;
    const sid = req.cookies[cookieName];
    if (!sid) throw unauthorized();
    const session = sessions.touch(sid);
    if (!session) throw unauthorized();
    req.session = session;
    req.verbs = resolveVerbsForRoles(
      source.current.rbac.roles,
      session.roles,
      source.current.rbac.enabled,
    );
  };
}

export function makeRequireVerb(source: ConfigSource, sessions: SessionStore, verb: Verb) {
  const requireAuth = makeRequireAuth(source, sessions);
  return async function requireVerb(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    await requireAuth(req, reply);
    if (!hasVerb(req.verbs ?? [], verb)) {
      throw forbidden(`missing verb: ${verb}`);
    }
  };
}
