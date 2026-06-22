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
 * `GET /api/infra-3d/config` — the EFFECTIVE 3D Infrastructure Map config
 * the `/3d/map` view consumes. The config is a first-class template kind
 * (`horizon.infra-3d.config`), so it follows the same bundled → remote
 * policy as every other template: when OAP holds a non-disabled remote
 * row, that wins; otherwise the bundled default is served. Writes do NOT
 * happen here — the admin editor publishes through the generic template
 * sync surface (`POST /api/admin/templates/save`), which validates the
 * 3D-map content before it reaches OAP.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { UITemplateClient } from '@skywalking-horizon-ui/api-client';
import type { ConfigSource } from '../../config/loader.js';
import type { SessionStore } from '../../user/sessions.js';
import { requireAuth } from '../../user/middleware.js';
import { getSyncStatus } from '../../logic/templates/sync.js';
import { iterateBundledTemplates } from '../../logic/templates/aggregator.js';
import {
  formatName,
  parseEnvelope,
  INFRA3D_CONFIG_KEY,
} from '../../logic/templates/names.js';
import { loadBundledInfra3dConfig } from '../../logic/infra-3d/bundled.js';
import { validateInfra3dConfig } from '../../logic/infra-3d/validate.js';
import type { Infra3dConfig } from '../../logic/infra-3d/types.js';
import { logger } from '../../logger.js';

export interface Infra3dConfigRouteDeps {
  config: ConfigSource;
  sessions: SessionStore;
  uiTemplateClient: () => UITemplateClient;
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
      const cfg = await resolveEffectiveConfig(deps);
      // The metric fan-out budget is OPERATIONAL (per-deployment, hot-
      // reloaded), so it lives in horizon.yaml — NOT the published template.
      // Inject it server-side so the UI keeps reading `cfg.pipeline.*`; this
      // overrides any stale `pipeline` a hand-edited / imported template row
      // might still carry (validate.ts accepts-and-ignores it).
      const perf = deps.config.current.performance.bulk.infra3d;
      return reply.send({
        ...cfg,
        pipeline: {
          metricChunkSize: perf.metricBulkSize,
          metricConcurrency: perf.metricConcurrency,
          topologyConcurrency: perf.topologyConcurrency,
          templateConcurrency: perf.templateConcurrency,
        },
      });
    },
  );
}

/** Remote-wins resolution, mirroring `pickLayerContent` in the config
 *  bundle. The remote envelope is re-validated defensively — a row
 *  hand-edited on OAP into an invalid shape falls back to bundled rather
 *  than breaking the map. */
async function resolveEffectiveConfig(deps: Infra3dConfigRouteDeps): Promise<Infra3dConfig> {
  const bundled = loadBundledInfra3dConfig();
  try {
    const sync = await getSyncStatus({
      client: deps.uiTemplateClient(),
      bundled: () => iterateBundledTemplates(),
      logger,
    });
    const name = formatName('infra-3d', INFRA3D_CONFIG_KEY);
    const row = sync.rows.find((r) => r.name === name);
    if (row && row.status !== 'disabled' && row.effective === 'remote' && row.remote) {
      const env = parseEnvelope(row.remote.configuration);
      if (env) {
        const v = validateInfra3dConfig(env.content);
        if (v.ok) return v.value;
        logger.warn({ issues: v.issues }, 'remote infra-3d config invalid; using bundled');
      }
    }
  } catch (err) {
    logger.warn({ err }, 'infra-3d effective resolve failed; using bundled');
  }
  return bundled;
}
