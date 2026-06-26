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

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { FetchLike } from '@skywalking-horizon-ui/api-client';
import type { ConfigSource } from '../../config/loader.js';
import { requireAuth } from '../../user/middleware.js';
import type { SessionStore } from '../../user/sessions.js';
import { getPreflight } from '../../logic/preflight/preflight.js';

export interface PreflightRouteDeps {
  config: ConfigSource;
  sessions: SessionStore;
  fetch?: FetchLike;
}

/** `GET /api/preflight` — probes each admin feature's REST path and
 *  returns per-feature reachability (30s single-flight cache; pass
 *  `?refresh=1` to force a fresh round). Authenticated but ungated by
 *  verb — every logged-in user can see whether OAP is correctly set up. */
export function registerPreflightRoutes(app: FastifyInstance, deps: PreflightRouteDeps): void {
  const auth = requireAuth(deps);
  app.get(
    '/api/preflight',
    { preHandler: auth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const fetchImpl = deps.fetch ?? globalThis.fetch.bind(globalThis);
      const force = (req.query as { refresh?: string }).refresh === '1';
      const result = await getPreflight(deps.config.current, fetchImpl, { force });
      return reply.send(result);
    },
  );
}
