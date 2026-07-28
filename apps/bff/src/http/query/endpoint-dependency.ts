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
 * `GET /api/layer/:key/endpoint-dependency?service=<id|name>&endpoint=<name|id>`
 *
 * API-dependency feed for the per-layer "API dependency" tab. This is the HTTP
 * edge: it parses the request, resolves the (preview OR effective)
 * `endpointDependency` config + the time window, then delegates the OAP
 * fan-out to `buildEndpointDependency` (logic/oap/endpoint-dependency.ts) —
 * the same builder the AI assistant's `show_endpoint_dependency` tool calls.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ConfigSource } from '../../config/loader.js';
import type { SessionStore } from '../../user/sessions.js';
import type { EndpointDependencyConfig, FetchLike, UITemplateClient } from '@skywalking-horizon-ui/api-client';
import { requireAuth } from '../../user/middleware.js';
import { buildOapOpts } from '../../client/graphql.js';
import {
  defaultMinuteWindow,
  getServerOffsetMinutes,
  windowFromRange,
  type TimeStep,
  type Window,
} from '../../util/window.js';
import { endpointDependencyConfigFor } from '../../logic/layers/loader.js';
import { resolveEffectiveLayer } from '../../logic/layers/effective.js';
import { parsePreviewEndpointDep } from '../../logic/layers/preview.js';
import { buildEndpointDependency, emptyEndpointDependencyResponse } from '../../logic/oap/endpoint-dependency.js';

export interface EndpointDependencyRouteDeps {
  config: ConfigSource;
  sessions: SessionStore;
  fetch?: FetchLike;
  /** OAP UI-template client — serve the in-use (remote-or-bundled) config. */
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
        service?: string;
        endpoint?: string;
        previewConfig?: string;
        step?: string;
        startMs?: string;
        endMs?: string;
      };
      const serviceArg = (q.service ?? '').trim();
      const endpointArg = (q.endpoint ?? '').trim();
      if (!serviceArg) return reply.code(400).send({ error: 'missing_service' });
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
          return reply.send(emptyEndpointDependencyResponse(layerKey, serviceArg, endpointArg, null, { nodeMetrics: [] }, true));
        }
        epCfg = endpointDependencyConfigFor(eff.template);
      }

      const cfgCurrent = deps.config.current;
      const opts = buildOapOpts(cfgCurrent, deps.fetch);
      const offset = await getServerOffsetMinutes(deps.config, deps.fetch);
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
        serviceArg,
        endpointArg,
      });
      return reply.send(response);
    },
  );
}
