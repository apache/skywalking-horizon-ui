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
 * `GET /api/admin/layer-templates` — the disk-bundled per-layer JSON
 * templates, as the layer-dashboards editor's "bundled" source.
 */

import type { FastifyInstance } from 'fastify';
import type { ConfigSource } from '../../config/loader.js';
import type { SessionStore } from '../../user/sessions.js';
import { requireAuth } from '../../user/middleware.js';
import { allLayerTemplates } from '../../logic/layers/loader.js';

export interface LayerTemplateConfigDeps {
  config: ConfigSource;
  sessions: SessionStore;
}

export function registerLayerTemplateRoutes(
  app: FastifyInstance,
  deps: LayerTemplateConfigDeps,
): void {
  const auth = requireAuth(deps);
  // English source by design — the admin Layer-Dashboards page uses this
  // route to drive an editor; translations are managed through the
  // dedicated translation editor and shipped separately as overlays.
  app.get('/api/admin/layer-templates', { preHandler: auth }, async (_req, reply) => {
    return reply.send({ templates: allLayerTemplates() });
  });

  // No write route here: operator updates go through `/api/admin/templates/save`
  // (OAP-backed). Bundled JSON is immutable at runtime.
}
