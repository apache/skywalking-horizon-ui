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
 *   GET /api/catalog/list     — runtime + bundled rule list per catalog.
 *   GET /api/catalog/bundled  — bundled-only list (with raw content opt).
 *
 * Both gated on `rule:read`; read-only.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { requireAuth } from '../../../user/middleware.js';
import {
  type DslRouteDeps,
  ensureVerb,
  hasCatalogParam,
  makeClients,
  parseBoolean,
  parseOptionalCatalog,
  parseRequiredCatalog,
  passOapError,
} from './_shared.js';

export function registerDslCatalogRoutes(app: FastifyInstance, deps: DslRouteDeps): void {
  const auth = requireAuth(deps);
  const clients = makeClients(deps);

  app.get(
    '/api/catalog/list',
    { preHandler: auth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      if (!ensureVerb(req, reply, deps, 'rule:read')) return;
      const catalog = parseOptionalCatalog(req.query, reply);
      if (catalog === undefined && hasCatalogParam(req.query)) return;
      try {
        const env = await clients().primary().list(catalog);
        return reply.send(env);
      } catch (err) {
        return passOapError(err, reply);
      }
    },
  );

  app.get(
    '/api/catalog/bundled',
    { preHandler: auth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      if (!ensureVerb(req, reply, deps, 'rule:read')) return;
      const catalog = parseRequiredCatalog(req.query, reply);
      if (!catalog) return;
      const withContent = parseBoolean((req.query as Record<string, string>).withContent, true);
      try {
        const list = await clients().primary().listBundled(catalog, withContent);
        return reply.send(list);
      } catch (err) {
        return passOapError(err, reply);
      }
    },
  );
}
