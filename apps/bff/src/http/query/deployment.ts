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
 * `GET /api/layer/:key/deployment?service=<svcId>`
 *
 * The instance-to-instance call graph WITHIN one service. This is the HTTP
 * edge: it parses the request, resolves the (preview OR effective)
 * `deployment` config + the time window, then delegates the OAP fan-out to
 * `buildDeployment` (logic/oap/deployment.ts) — the same builder the AI
 * assistant's `show_deployment` tool calls. Absent config ⇒ 404 (the tab only
 * appears for layers that configure it).
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ConfigSource } from '../../config/loader.js';
import type { SessionStore } from '../../user/sessions.js';
import type { FetchLike, DeploymentConfig, UITemplateClient } from '@skywalking-horizon-ui/api-client';
import { requireAuth } from '../../user/middleware.js';
import { buildOapOpts } from '../../client/graphql.js';
import {
  defaultMinuteWindow,
  getServerOffsetMinutes,
  windowFromRange,
  type TimeStep,
  type Window,
} from '../../util/window.js';
import { deploymentConfigFor } from '../../logic/layers/loader.js';
import { resolveEffectiveLayer } from '../../logic/layers/effective.js';
import { parsePreviewDeployment } from '../../logic/layers/preview.js';
import { buildDeployment, emptyDeploymentResponse } from '../../logic/oap/deployment.js';

export interface DeploymentRouteDeps {
  config: ConfigSource;
  sessions: SessionStore;
  fetch?: FetchLike;
  /** OAP UI-template client — serves the in-use (remote-or-bundled)
   *  config, matching the admin + sidebar. */
  uiTemplateClient?: () => UITemplateClient;
}

const DEFAULT_WINDOW_MIN = 60;

export function registerDeploymentRoute(
  app: FastifyInstance,
  deps: DeploymentRouteDeps,
): void {
  const auth = requireAuth(deps);
  app.get(
    '/api/layer/:key/deployment',
    { preHandler: auth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const params = req.params as { key: string };
      const layerKey = params.key;
      if (!layerKey || !/^[a-z0-9_]+$/i.test(layerKey)) {
        return reply.code(400).send({ error: 'invalid_layer_key' });
      }
      const q = req.query as {
        service?: string;
        step?: string;
        startMs?: string;
        endMs?: string;
        previewConfig?: string;
      };
      const serviceId = (q.service ?? '').trim();
      if (!serviceId) {
        return reply.code(400).send({ error: 'missing_service' });
      }

      // Admin Preview: the page forwards the draft `deployment`
      // block; when previewing, that draft decides support (404 if it has
      // no metrics), bypassing the remote template entirely.
      const previewCfg = parsePreviewDeployment(q.previewConfig);
      let cfg: DeploymentConfig | null;
      if (previewCfg) {
        cfg = previewCfg;
      } else {
        const eff = await resolveEffectiveLayer(deps.uiTemplateClient, layerKey);
        if (eff.blocked) {
          // Template store unreachable (or this layer's template disabled)
          // — block (like the service-topology route) instead of a
          // misleading "not supported" 404. The SPA's connectivity banner
          // explains the empty state.
          return reply.send(
            emptyDeploymentResponse(layerKey, serviceId, { nodeMetrics: [] }, false),
          );
        }
        cfg = deploymentConfigFor(eff.template);
      }
      if (!cfg) {
        return reply.code(404).send({ error: 'deployment_not_supported' });
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

      const response = await buildDeployment({
        opts,
        perf: cfgCurrent.performance,
        window,
        coldStage: !!req.coldStage,
        cfg,
        layerKey,
        serviceId,
      });
      return reply.send(response);
    },
  );
}
