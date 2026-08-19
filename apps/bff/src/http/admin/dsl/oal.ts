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
 * OAL read-only browse (SWIP-13 §4.1). All gated on `rule:read`.
 *   GET /api/oal/files          — { files: string[], count }
 *   GET /api/oal/files/:name    — text/plain raw .oal content
 *   GET /api/oal/rules          — per-dispatcher source listing
 *   GET /api/oal/rules/:source  — single source detail with `status`
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { requireAuth } from '../../../user/middleware.js';
import {
  type DslRouteDeps,
  ensureVerb,
  makeClients,
  passOapError,
} from './_shared.js';

export function registerDslOalRoutes(app: FastifyInstance, deps: DslRouteDeps): void {
  const auth = requireAuth(deps);
  const clients = makeClients(deps);

  app.get(
    '/api/oal/files',
    { preHandler: auth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      if (!ensureVerb(req, reply, deps, 'rule:read')) return;
      try {
        const list = await clients().oal().listFiles();
        return reply.send(list);
      } catch (err) {
        return passOapError(err, reply);
      }
    },
  );

  app.get(
    '/api/oal/files/:name',
    { preHandler: auth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      if (!ensureVerb(req, reply, deps, 'rule:read')) return;
      const params = req.params as { name: string };
      if (!params.name) return reply.code(400).send({ error: 'missing_name' });
      try {
        const content = await clients().oal().getFileContent(params.name);
        if (content === null) return reply.code(404).send({ error: 'not_found' });
        reply.header('content-type', 'text/plain; charset=utf-8');
        return reply.send(content);
      } catch (err) {
        return passOapError(err, reply);
      }
    },
  );

  app.get(
    '/api/oal/rules',
    { preHandler: auth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      if (!ensureVerb(req, reply, deps, 'rule:read')) return;
      try {
        const sources = await clients().oal().listSources();
        return reply.send(sources);
      } catch (err) {
        return passOapError(err, reply);
      }
    },
  );

  app.get(
    '/api/oal/rules/:source',
    { preHandler: auth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      if (!ensureVerb(req, reply, deps, 'rule:read')) return;
      const params = req.params as { source: string };
      if (!params.source) return reply.code(400).send({ error: 'missing_source' });
      try {
        const detail = await clients().oal().getSource(params.source);
        if (detail === null) return reply.code(404).send({ error: 'not_found' });
        return reply.send(detail);
      } catch (err) {
        return passOapError(err, reply);
      }
    },
  );
}
