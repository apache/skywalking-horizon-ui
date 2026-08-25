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
 * `GET /api/oap/config` — read-only snapshot of OAP's resolved runtime
 * config from the admin port's `/debugging/config/dump`. OAP masks
 * secret values server-side, so this is safe to surface. Never rejects
 * on an unreachable admin host: returns `{ reachable: false }` so the
 * page degrades like the cluster-status admin pane does.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type {
  FetchLike,
  OapConfigEntry,
  OapConfigResponse,
} from '@skywalking-horizon-ui/api-client';
import type { AuthDeps } from '../../user/middleware.js';
import { requireAuth } from '../../user/middleware.js';
import { fetchConfigDump } from '../../client/config-dump.js';

export interface OapConfigRouteDeps extends AuthDeps {
  fetch?: FetchLike;
}

export function registerOapConfigRoute(app: FastifyInstance, deps: OapConfigRouteDeps): void {
  const auth = requireAuth(deps);
  app.get('/api/oap/config', { preHandler: auth }, async (_req: FastifyRequest, reply: FastifyReply) => {
    const cfg = deps.config.current;
    const adminUrl = cfg.oap.adminUrl;
    try {
      const dump = await fetchConfigDump(adminUrl, {
        fetch: deps.fetch,
        timeoutMs: cfg.oap.timeoutMs,
        auth: cfg.oap.auth,
      });
      const entries: OapConfigEntry[] = Object.entries(dump)
        .map(([key, value]) => ({ key, value: String(value), module: key.split('.', 1)[0] }))
        .sort((a, b) => a.key.localeCompare(b.key));
      const body: OapConfigResponse = {
        reachable: true,
        adminUrl,
        entries,
        generatedAt: Date.now(),
      };
      return reply.send(body);
    } catch (err) {
      const body: OapConfigResponse = {
        reachable: false,
        error: err instanceof Error ? err.message : String(err),
        adminUrl,
        entries: [],
        generatedAt: Date.now(),
      };
      return reply.status(200).send(body);
    }
  });
}
