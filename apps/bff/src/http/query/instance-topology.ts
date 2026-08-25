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
 * `GET /api/layer/:key/instance-topology?client=<svcId>&server=<svcId>`
 *
 * Instance-to-instance drill-down for one service→service edge. This is the
 * HTTP edge: it parses the request, resolves the (preview OR effective)
 * `topology.instanceTopology` config + the time window, then delegates the
 * OAP fan-out to `buildInstanceTopology` (logic/oap/instance-topology.ts) —
 * the same builder the AI assistant's `show_instance_topology` tool calls.
 * Absent config ⇒ 404 (the service map only offers the drill-down for layers
 * that echo the config).
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { FetchLike, InstanceTopologyConfig, UITemplateClient } from '@skywalking-horizon-ui/api-client';
import type { AuthDeps } from '../../user/middleware.js';
import { requireAuth } from '../../user/middleware.js';
import { buildOapOpts } from '../../client/graphql.js';
import {
  defaultMinuteWindow,
  getServerOffsetMinutes,
  windowFromRange,
  type TimeStep,
  type Window,
} from '../../util/window.js';
import { instanceTopologyConfigFor } from '../../logic/layers/loader.js';
import { resolveEffectiveLayer } from '../../logic/layers/effective.js';
import { parsePreviewTopology } from '../../logic/layers/preview.js';
import { buildInstanceTopology, emptyInstanceTopologyResponse } from '../../logic/oap/instance-topology.js';

export interface InstanceTopologyRouteDeps extends AuthDeps {
  fetch?: FetchLike;
  /** OAP UI-template client — lets the route serve the in-use REMOTE
   *  topology config, matching the admin + sidebar. */
  uiTemplateClient?: () => UITemplateClient;
}

const DEFAULT_WINDOW_MIN = 60;

export function registerInstanceTopologyRoute(
  app: FastifyInstance,
  deps: InstanceTopologyRouteDeps,
): void {
  const auth = requireAuth(deps);
  app.get(
    '/api/layer/:key/instance-topology',
    { preHandler: auth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const params = req.params as { key: string };
      const layerKey = params.key;
      if (!layerKey || !/^[a-z0-9_]+$/i.test(layerKey)) {
        return reply.code(400).send({ error: 'invalid_layer_key' });
      }
      const q = req.query as {
        client?: string;
        server?: string;
        step?: string;
        startMs?: string;
        endMs?: string;
        previewConfig?: string;
      };
      const clientServiceId = (q.client ?? '').trim();
      const serverServiceId = (q.server ?? '').trim();
      if (!clientServiceId || !serverServiceId) {
        return reply.code(400).send({ error: 'missing_service_ids' });
      }

      // Admin Preview: the page forwards the draft `topology` block; the
      // instance map reads its nested `instanceTopology`. When previewing,
      // that draft decides support (404 if the draft has no instance map),
      // bypassing the remote template entirely.
      const previewTopo = parsePreviewTopology(q.previewConfig);
      let instCfg: InstanceTopologyConfig | null;
      if (previewTopo) {
        instCfg = previewTopo.instanceTopology ?? null;
      } else {
        const eff = await resolveEffectiveLayer(deps.uiTemplateClient, layerKey);
        if (eff.blocked) {
          // Template store unreachable (or this layer's template disabled)
          // — block, the same way the service-topology route does, instead
          // of collapsing to a misleading "not supported" 404. Serve an
          // empty unreachable response so the SPA's connectivity banner
          // explains the empty state.
          return reply.send(
            emptyInstanceTopologyResponse(
              layerKey,
              clientServiceId,
              serverServiceId,
              { nodeMetrics: [], linkServerMetrics: [], linkClientMetrics: [] },
              false,
            ),
          );
        }
        instCfg = instanceTopologyConfigFor(eff.template);
      }
      if (!instCfg) {
        return reply.code(404).send({ error: 'instance_topology_not_supported' });
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

      const response = await buildInstanceTopology({
        opts,
        perf: cfgCurrent.performance,
        window,
        coldStage: !!req.coldStage,
        cfg: instCfg,
        layerKey,
        clientServiceId,
        serverServiceId,
      });
      return reply.send(response);
    },
  );
}
