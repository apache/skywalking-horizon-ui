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
 * `GET /api/cluster/state` — fires `/runtime/rule/list` once against the
 * configured OAP admin URL and returns the cluster rule list. OAP itself
 * handles cluster-internal routing for runtime rules, so a single fire
 * to any one node returns the cluster view. Gated on `cluster:read`.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { FetchLike } from '@skywalking-horizon-ui/api-client';
import type { ConfigSource } from '../../config/loader.js';
import type { SessionStore } from '../../user/sessions.js';
import { requireAuth } from '../../user/middleware.js';
import { ensureVerb, makeClients } from './dsl/_shared.js';
import { fetchClusterState } from '../../client/cluster.js';
import type { AuditLogger } from '../../audit/logger.js';

export interface ClusterRouteDeps {
  config: ConfigSource;
  sessions: SessionStore;
  audit: AuditLogger;
  fetch?: FetchLike;
}

export function registerClusterRoutes(app: FastifyInstance, deps: ClusterRouteDeps): void {
  const auth = requireAuth(deps);
  const clients = makeClients(deps);
  app.get(
    '/api/cluster/state',
    { preHandler: auth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      if (!ensureVerb(req, reply, deps, 'cluster:read')) return;
      return reply.send(await fetchClusterState(clients()));
    },
  );
}
