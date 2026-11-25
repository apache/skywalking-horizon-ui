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
 * `/api/otlp-pairing/*` routes — passthrough to OAP's `/trace-pairing-debugging/*` (11.2 and later): an on-demand
 * capture of the backend task that pairs an OTLP call's caller and callee halves on the node that owns the trace.
 * One capture per OAP node, shared by every reader, no sessions; OAP keeps it running while it is read.
 *
 *   POST /api/otlp-pairing/start      — turn the capture on, on every OAP node
 *   POST /api/otlp-pairing/stop       — turn it off
 *   GET  /api/otlp-pairing/pairings   — the counts, the peers matched, the peers and servers unmatched; `?limit=`
 *
 * RBAC lives in `ROUTE_POLICY`, as for the live debugger: the reads take `live-debug:read`, start and stop
 * `live-debug:write`.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { RuntimeRuleApiError, type FetchLike } from '@skywalking-horizon-ui/api-client';
import type { AuthDeps } from '../../user/middleware.js';
import { requireAuth } from '../../user/middleware.js';
import { buildOapClients, type OapClients } from '../../client/index.js';
import { clientGone } from '../client-gone.js';

export interface OtlpPairingRouteDeps extends AuthDeps {
  fetch?: FetchLike;
}

/** OAP's bound: at most 1000 entries a list. */
const MAX_ENTRIES = 1000;

/** A positive integer query parameter up to `max`; `undefined` when absent, `null` when invalid. */
function limitOf(value: unknown, max: number): number | undefined | null {
  if (value === undefined) return undefined;
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= max ? n : null;
}

export function registerOtlpPairingRoutes(app: FastifyInstance, deps: OtlpPairingRouteDeps): void {
  const auth = requireAuth(deps);

  function clients(): OapClients {
    return buildOapClients(deps.config.current, { fetch: deps.fetch });
  }

  app.post('/api/otlp-pairing/start', { preHandler: auth }, async (_req: FastifyRequest, reply: FastifyReply) => {
    try {
      return reply.send(await clients().pairing().start());
    } catch (err) {
      return passOapError(err, reply);
    }
  });

  app.post('/api/otlp-pairing/stop', { preHandler: auth }, async (_req: FastifyRequest, reply: FastifyReply) => {
    try {
      return reply.send(await clients().pairing().stop());
    } catch (err) {
      return passOapError(err, reply);
    }
  });

  app.get('/api/otlp-pairing/pairings', { preHandler: auth }, async (req: FastifyRequest, reply: FastifyReply) => {
    const limit = limitOf((req.query as { limit?: unknown } | undefined)?.limit, MAX_ENTRIES);
    if (limit === null) return reply.code(400).send({ error: 'invalid_limit', message: `limit is 1 to ${MAX_ENTRIES}` });
    try {
      return reply.send(await clients().pairing().getPairings(limit, clientGone(reply)));
    } catch (err) {
      return passOapError(err, reply);
    }
  });
}

function passOapError(err: unknown, reply: FastifyReply): FastifyReply {
  if (err instanceof RuntimeRuleApiError) {
    return reply.code(err.status).send(err.body);
  }
  return reply.code(502).send({ error: 'oap_unreachable', message: err instanceof Error ? err.message : String(err) });
}
