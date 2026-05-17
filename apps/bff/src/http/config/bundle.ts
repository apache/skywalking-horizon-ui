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
 * `GET /api/configs/bundle` — preload payload for the SPA. Returns the
 * dashboard widget set for every (layer, scope) pair PLUS the full
 * overview-dashboard list in one round-trip so the SPA can cache the
 * lot in localStorage and serve config lookups synchronously after
 * the first visit. The body excludes runtime data (no MQE evaluation
 * happens here) — the SPA still fires the dashboard/landing routes
 * to populate widget values.
 *
 * Versioning: `etag` is a stable hash of the payload (md5 of the
 * JSON shape). The SPA passes it back as `If-None-Match` on
 * subsequent loads; an unchanged bundle returns 304 so the client
 * keeps using its localStorage copy.
 */

import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { DashboardWidget, OverviewDashboard } from '@skywalking-horizon-ui/api-client';
import type { ConfigSource } from '../../config/loader.js';
import type { SessionStore } from '../../user/sessions.js';
import { requireAuth } from '../../user/middleware.js';
import { allLayerTemplates, widgetsForScope } from '../../logic/layers/loader.js';
import { loadOverviewDashboards } from '../../logic/overview/loader.js';

export interface ConfigBundleDeps {
  config: ConfigSource;
  sessions: SessionStore;
}

type ScopeMap = Partial<Record<'service' | 'instance' | 'endpoint', DashboardWidget[]>>;
export interface ConfigBundle {
  etag: string;
  generatedAt: number;
  layers: Record<string, ScopeMap>;
  overviews: OverviewDashboard[];
}

let cached: ConfigBundle | null = null;
let cachedSourceVersion = -1;
function bundle(sourceVersion: number): ConfigBundle {
  if (cached && cachedSourceVersion === sourceVersion) return cached;
  const layers: Record<string, ScopeMap> = {};
  for (const tpl of allLayerTemplates()) {
    const scopes: ScopeMap = {};
    for (const scope of ['service', 'instance', 'endpoint'] as const) {
      const ws = widgetsForScope(tpl, scope);
      // Only include scopes that actually have widgets — keeps the
      // bundle tight (so11y_java_agent contributes only `instance`,
      // mesh_dp the same, etc.).
      if (ws.length > 0) scopes[scope] = ws;
    }
    layers[tpl.key.toLowerCase()] = scopes;
  }
  const overviews = loadOverviewDashboards();
  const body = { layers, overviews };
  const etag = createHash('md5').update(JSON.stringify(body)).digest('hex');
  cached = { etag, generatedAt: Date.now(), ...body };
  cachedSourceVersion = sourceVersion;
  return cached;
}

export function registerConfigBundleRoute(app: FastifyInstance, deps: ConfigBundleDeps): void {
  const auth = requireAuth(deps);
  app.get(
    '/api/configs/bundle',
    { preHandler: auth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const sourceVersion = (deps.config as { version?: number }).version ?? 0;
      const body = bundle(sourceVersion);
      const inm = req.headers['if-none-match'];
      if (typeof inm === 'string' && inm === body.etag) {
        return reply.code(304).send();
      }
      reply.header('ETag', body.etag);
      reply.header('Cache-Control', 'private, max-age=0, must-revalidate');
      return reply.send(body);
    },
  );
}
