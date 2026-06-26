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
 * (`horizon.infra-3d.config`) and is read ONLY from the remote row, exactly
 * like the layer/overview surfaces — never the disk bundle as a runtime
 * fallback. The bundle reaches OAP via boot-seed; readonly mode renders it
 * through the synthetic bundled row. When the ui_template store is unreachable
 * (or the row is absent / invalid) this 503s so the map blocks, rather than
 * silently serving a stale bundle. Writes do NOT happen here — the admin editor
 * publishes through the generic template sync surface (`POST /api/admin/templates/save`).
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
      // Live + ui_template store unreachable → block, exactly like every other
      // surface (the UI renders its connectivity-empty state). The 3D map used
      // to be the lone exception that silently served the bundle here.
      if (!cfg) {
        return reply.code(503).send({
          error: 'template_store_unreachable',
          reason:
            "OAP's ui_template store is unreachable; in live mode the 3D map renders only from OAP (no bundled fallback). It recovers when the store is reachable, or run templates.mode=readonly to serve the bundle.",
        });
      }
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

/**
 * Render ONLY from the remote row — never the disk bundle as a runtime
 * fallback. This matches the layer/overview surfaces (bundle.ts): the bundle
 * reaches OAP via boot-seed, then is read back as a remote row. `getSyncStatus`
 * supplies that row — a real OAP row in live mode, the synthetic bundled row in
 * readonly — so readonly renders the bundle through the SAME remote path.
 *
 * Returns null (→ the route blocks with 503) when there is no usable remote
 * row: the store is unreachable, the row is absent / not-yet-seeded / disabled,
 * or the remote envelope is invalid. A live ui_template outage must surface as
 * a block like every other surface, not a silent stale bundle.
 */
async function resolveEffectiveConfig(deps: Infra3dConfigRouteDeps): Promise<Infra3dConfig | null> {
  try {
    const sync = await getSyncStatus({
      client: deps.uiTemplateClient(),
      bundled: () => iterateBundledTemplates(),
      logger,
    });
    if (sync.unreachable) return null;
    const name = formatName('infra-3d', INFRA3D_CONFIG_KEY);
    const row = sync.rows.find((r) => r.name === name);
    if (row && row.status !== 'disabled' && row.effective === 'remote' && row.remote) {
      const env = parseEnvelope(row.remote.configuration);
      if (env) {
        const v = validateInfra3dConfig(env.content);
        if (v.ok) return v.value;
        logger.warn({ issues: v.issues }, 'remote infra-3d config invalid — blocking, not falling back');
      }
    }
    return null;
  } catch (err) {
    logger.warn({ err }, 'infra-3d effective resolve failed — blocking, not falling back');
    return null;
  }
}
