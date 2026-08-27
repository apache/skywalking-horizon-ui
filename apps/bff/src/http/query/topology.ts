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
 * `GET /api/layer/:key/topology?serviceId=&service=&depth=<1-3>`
 *
 * The map is seeded by the OAP service ID the caller already held; the name
 * half rides along as identity but the graph names its own nodes. No service
 * at all is the deliberate layer-wide map.
 *
 * Service-map feed for the per-layer Topology tab. This is the HTTP edge:
 * it parses the request, resolves the (preview OR effective) `topology`
 * config + the time window, then delegates the OAP fan-out to
 * `buildServiceTopology` (logic/oap/service-topology.ts) — the same builder
 * the AI assistant's `show_topology` tool calls, so both draw the identical
 * metric-carrying graph.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { FetchLike, TopologyConfig, UITemplateClient } from '@skywalking-horizon-ui/api-client';
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
import { topologyConfigFor } from '../../logic/layers/loader.js';
import { blockedReason, resolveEffectiveLayer } from '../../logic/layers/effective.js';
import { parsePreviewTopology } from '../../logic/layers/preview.js';
import { getServiceHierarchy } from '../../logic/oap/hierarchy.js';
import { buildServiceTopology, emptyTopologyResponse } from '../../logic/oap/service-topology.js';
import { serviceScopeOf } from '../../logic/oap/service-scope.js';

export interface TopologyRouteDeps extends AuthDeps {
  fetch?: FetchLike;
  /** OAP UI-template client — lets the route serve the in-use REMOTE
   *  topology config, matching the admin + sidebar. */
  uiTemplateClient?: () => UITemplateClient;
}

const DEFAULT_WINDOW_MIN = 60;

export function registerTopologyRoute(app: FastifyInstance, deps: TopologyRouteDeps): void {
  const auth = requireAuth(deps);
  app.get(
    '/api/layer/:key/topology',
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
        depth?: string;
        step?: string;
        startMs?: string;
        endMs?: string;
        previewConfig?: string;
        group?: string;
      };
      const scope = serviceScopeOf(q);
      // A named service with no id is refused rather than dropped: an empty
      // seed is the LAYER-WIDE map, which reads as the focused one.
      if (scope.kind === 'incomplete') {
        return reply.code(400).send({ error: 'incomplete_service', message: scope.message });
      }
      const serviceArg = scope.kind === 'service' ? scope.service.id : '';
      const depth = Math.max(1, Math.min(3, Number(q.depth) || 1));

      // Admin "Preview" mode: the page forwards the operator's unpublished
      // draft `topology` block so we render it against live OAP without
      // publishing first. When present + valid it wins outright — the
      // remote-resolved config and its block/disabled gate don't apply to
      // a draft the operator is actively editing.
      const previewCfg = parsePreviewTopology(q.previewConfig);
      let topoCfg: TopologyConfig;
      if (previewCfg) {
        topoCfg = previewCfg;
      } else {
        const eff = await resolveEffectiveLayer(deps.uiTemplateClient, layerKey);
        if (eff.blocked) {
          // Template store unreachable or this layer's template disabled —
          // block: serve no map and no in-code default config. A disabled
          // layer is hidden from the sidebar so it isn't reached.
          //
          // `reachable: false`, like every other graph route: the empty body
          // is a FAILURE to read, not a map that happens to have no nodes,
          // and a client that cannot tell those apart will replace a good
          // graph with this one. The four routes disagreed here — two sent
          // `true` for this exact condition — which made the flag unusable
          // as the signal for "is this response worth drawing".
          return reply.send({
            ...emptyTopologyResponse(layerKey, serviceArg, depth, { nodeMetrics: [], linkServerMetrics: [], linkClientMetrics: [] }, false),
            // WHICH block, so the page can say something an operator can act
            // on. A store to go and fix and a template an administrator
            // switched off need opposite responses, and one sentence for both
            // sends people looking in the wrong place.
            ...blockedReason(eff.reason),
          });
        }
        topoCfg = topologyConfigFor(eff.template);
      }

      const cfgCurrent = deps.config.current;
      const signal = clientGone(reply);
      const opts = buildOapOpts(cfgCurrent, deps.fetch, signal);
      const offset = await getServerOffsetMinutes(deps.config, deps.fetch, signal);
      // Honor the SPA's topbar time picker when all three triplet
      // query-params are present; otherwise fall back to the last-hour
      // MINUTE window. The Overview "topology" widget + per-layer
      // service map both forward the picker so the topology metrics
      // line up with whatever window the operator is looking at.
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

      const response = await buildServiceTopology({
        opts,
        perf: cfgCurrent.performance,
        window,
        coldStage: !!req.coldStage,
        cfg: topoCfg,
        layerKey,
        serviceArg,
        depth,
        group: q.group,
      });
      return reply.send(response);
    },
  );

  // ── Service hierarchy probe — Smartscape overlay on the service map.
  //
  // The UI calls this lazily on node-select (one round-trip per selected
  // node) to decide whether to render the "expand hierarchy" chip and to
  // populate the focus+context+suggestions overlay when the operator
  // opens it. Not used by the overview topology widget (intentionally
  // non-interactive there).
  app.get(
    '/api/layer/:key/service-hierarchy',
    { preHandler: auth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const params = req.params as { key: string };
      const layerKey = params.key;
      if (!layerKey || !/^[a-z0-9_]+$/i.test(layerKey)) {
        return reply.code(400).send({ error: 'invalid_layer_key' });
      }
      const q = req.query as { serviceId?: string };
      const serviceId = (q.serviceId ?? '').trim();
      if (!serviceId) {
        return reply.code(400).send({ error: 'missing_service' });
      }
      const result = await getServiceHierarchy(
        deps.config.current,
        serviceId,
        layerKey,
        deps.fetch,
      );
      return reply.send(result);
    },
  );
}
