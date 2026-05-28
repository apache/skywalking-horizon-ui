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
 * `/api/infra-3d/config` — read + write the 3D Infrastructure Map admin
 * config. The GET path is the same source the `/3d/map` view consumes;
 * the POST path is what the `/admin/3d-map` Monaco YAML editor calls on
 * save. Validation happens at the route edge so a bad PUT never reaches
 * the store — the response carries the issue list back to the editor.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ConfigSource } from '../../config/loader.js';
import type { SessionStore } from '../../user/sessions.js';
import type { AuditLogger } from '../../audit/logger.js';
import { requireAuth } from '../../user/middleware.js';
import type { Infra3dStore } from '../../logic/infra-3d/store.js';
import { validateInfra3dConfig } from '../../logic/infra-3d/validate.js';
import { loadBundledInfra3dConfig } from '../../logic/infra-3d/bundled.js';

export interface Infra3dConfigRouteDeps {
  config: ConfigSource;
  sessions: SessionStore;
  audit: AuditLogger;
  store: Infra3dStore;
}

export function registerInfra3dConfigRoutes(
  app: FastifyInstance,
  deps: Infra3dConfigRouteDeps,
): void {
  const auth = requireAuth(deps);

  app.get(
    '/api/infra-3d/config',
    { preHandler: auth },
    async (_req: FastifyRequest, reply: FastifyReply) => {
      const cfg = await deps.store.load();
      return reply.send(cfg);
    },
  );

  // Read-only bundled defaults — the admin editor's "Reset to bundled"
  // button needs a way to retrieve the unsaved baseline so it can POST
  // it back. Same `infra-3d:read` verb as the main GET.
  app.get(
    '/api/infra-3d/config/bundled',
    { preHandler: auth },
    async (_req: FastifyRequest, reply: FastifyReply) => {
      return reply.send(loadBundledInfra3dConfig());
    },
  );

  app.post(
    '/api/infra-3d/config',
    { preHandler: auth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const parsed = validateInfra3dConfig(req.body);
      if (!parsed.ok) {
        return reply.code(400).send({ error: 'invalid_body', issues: parsed.issues });
      }
      await deps.store.save(parsed.value);
      deps.audit.record({
        action: 'infra-3d.config.save',
        actor: req.session?.username ?? null,
        outcome: 'ok',
        details: {
          levels: parsed.value.levels.map((l) => l.id),
          layers: Object.keys(parsed.value.layers).length,
        },
        fromIp: req.ip,
        sessionId: req.session?.sid,
      });
      return reply.send(parsed.value);
    },
  );
}
