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
 * `GET /api/layer/:key/endpoint-dependency?serviceId=&service=&normal=&endpoint=<name|id>`
 *
 * API-dependency feed for the per-layer "API dependency" tab. This is the HTTP
 * edge: it parses the request, resolves the (preview OR effective)
 * `endpointDependency` config + the time window, then delegates the OAP
 * fan-out to `buildEndpointDependency` (logic/oap/endpoint-dependency.ts) —
 * the same builder the AI assistant's `show_endpoint_dependency` tool calls.
 *
 * The service arrives as its whole roster row (id + name + normal): the id
 * finds the endpoint, the name and flag build the endpoint-scoped MQE entity.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { EndpointDependencyConfig, FetchLike, UITemplateClient } from '@skywalking-horizon-ui/api-client';
import type { AuthDeps } from '../../user/middleware.js';
import { requireAuth } from '../../user/middleware.js';
import { buildOapOpts } from '../../client/graphql.js';
import { clientGone } from '../client-gone.js';
import {
  defaultMinuteWindow,
  getServerOffsetMinutes,
  windowFromRange,
  type TimeStep,
  type Window,
} from '../../util/window.js';
import { endpointDependencyConfigFor } from '../../logic/layers/loader.js';
import { blockedReason, resolveEffectiveLayer } from '../../logic/layers/effective.js';
import { parsePreviewEndpointDep } from '../../logic/layers/preview.js';
import { buildEndpointDependency, emptyEndpointDependencyResponse } from '../../logic/oap/endpoint-dependency.js';
import { serviceNormalOf, serviceScopeOf } from '../../logic/oap/service-scope.js';

export interface EndpointDependencyRouteDeps extends AuthDeps {
  fetch?: FetchLike;
  /** OAP UI-template client — serve the in-use REMOTE config (blocked /
   *  in-code defaults when there is none; see `resolveEffectiveLayer`). */
  uiTemplateClient?: () => UITemplateClient;
}

const DEFAULT_WINDOW_MIN = 60;

export function registerEndpointDependencyRoute(
  app: FastifyInstance,
  deps: EndpointDependencyRouteDeps,
): void {
  const auth = requireAuth(deps);
  app.get(
    '/api/layer/:key/endpoint-dependency',
    { preHandler: auth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const params = req.params as { key: string };
      const layerKey = params.key;
      if (!layerKey || !/^[a-z0-9_]+$/i.test(layerKey)) {
        return reply.code(400).send({ error: 'invalid_layer_key' });
      }
      const q = req.query as {
        serviceId?: string;
        service?: string;
        normal?: string;
        endpoint?: string;
        previewConfig?: string;
        step?: string;
        startMs?: string;
        endMs?: string;
      };
      const endpointArg = (q.endpoint ?? '').trim();
      const scope = serviceScopeOf(q);
      if (scope.kind === 'all') return reply.code(400).send({ error: 'missing_service' });
      if (scope.kind === 'incomplete') {
        return reply.code(400).send({ error: 'incomplete_service', message: scope.message });
      }
      // The focus service's endpoint metrics are MQE under
      // `{ scope: Endpoint, serviceName, endpointName, normal }` — no id form,
      // so the name and its flag must both ride along or the chain's own node
      // reads blank and drops off the graph.
      const normal = serviceNormalOf(q.normal);
      if (!scope.service.name || normal === null) {
        return reply.code(400).send({
          error: 'incomplete_service',
          message: 'service (name) and normal must accompany serviceId, as the service roster returned them.',
        });
      }
      const service = { id: scope.service.id, name: scope.service.name, normal };
      if (!endpointArg) return reply.code(400).send({ error: 'missing_endpoint' });

      // Admin Preview: render the operator's draft `endpointDependency`
      // block when forwarded + valid (bypasses the remote resolve + block).
      const previewCfg = parsePreviewEndpointDep(q.previewConfig);
      let epCfg: EndpointDependencyConfig;
      if (previewCfg) {
        epCfg = previewCfg;
      } else {
        const eff = await resolveEffectiveLayer(deps.uiTemplateClient, layerKey);
        if (eff.blocked) {
          // Template store unreachable / layer disabled — block, no defaults.
          // `reachable: false` for the same reason as the service-topology
          // route: an empty body here is a failure to read, and a caller must
          // be able to tell it from a graph that is legitimately empty.
          return reply.send({
            ...emptyEndpointDependencyResponse(layerKey, service.name, endpointArg, null, { nodeMetrics: [] }, false),
            ...blockedReason(eff.reason),
          });
        }
        epCfg = endpointDependencyConfigFor(eff.template);
      }

      const cfgCurrent = deps.config.current;
      const signal = clientGone(reply);
      const opts = buildOapOpts(cfgCurrent, deps.fetch, signal);
      const offset = await getServerOffsetMinutes(deps.config, deps.fetch, signal);
      // Honor the SPA's topbar picker triplet; else fall back to the
      // last-hour MINUTE window (dashboards family — minute precision).
      const stepArg = (q.step ?? '').toUpperCase() as TimeStep;
      const startMs = Number(q.startMs);
      const endMs = Number(q.endMs);
      const window: Window =
        (stepArg === 'MINUTE' || stepArg === 'HOUR' || stepArg === 'DAY') &&
        Number.isFinite(startMs) &&
        Number.isFinite(endMs)
          ? windowFromRange(stepArg, startMs, endMs, offset) ??
            defaultMinuteWindow(offset, DEFAULT_WINDOW_MIN)
          : defaultMinuteWindow(offset, DEFAULT_WINDOW_MIN);

      const response = await buildEndpointDependency({
        opts,
        perf: cfgCurrent.performance,
        window,
        coldStage: !!req.coldStage,
        cfg: epCfg,
        layerKey,
        service,
        endpointArg,
      });
      return reply.send(response);
    },
  );
}
