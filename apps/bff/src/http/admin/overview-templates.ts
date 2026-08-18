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
 * `/api/admin/overview-templates*` — read side of the per-dashboard JSON
 * templates that drive overview pages. Operator writes go through
 * `/api/admin/templates/save` (OAP-backed); the bundled JSON is immutable at
 * runtime, and its content schema lives with the other publish-boundary
 * schemas in `logic/templates/bundled-schema.ts`.
 *
 *   GET  /api/admin/overview-templates           — list (id, title,
 *                                                  widgets summary).
 *   GET  /api/admin/overview-templates/:id       — full dashboard config.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AuthDeps } from '../../user/middleware.js';
import { requireAuth } from '../../user/middleware.js';
import {
  findOverviewFile,
  getOverviewDashboard,
  loadOverviewDashboards,
} from '../../logic/overview/loader.js';

export interface OverviewTemplatesAdminDeps extends AuthDeps {
}

export function registerOverviewTemplatesAdminRoutes(
  app: FastifyInstance,
  deps: OverviewTemplatesAdminDeps,
): void {
  const auth = requireAuth(deps);

  /* GET /api/admin/overview-templates — every loaded dashboard. */
  app.get(
    '/api/admin/overview-templates',
    { preHandler: auth },
    async (_req: FastifyRequest, reply: FastifyReply) => {
      const dashboards = loadOverviewDashboards();
      return reply.send({
        generatedAt: Date.now(),
        dashboards: dashboards.map((d) => ({
          id: d.id,
          title: d.title,
          description: d.description,
          widgetCount: d.widgets.length,
          editable: !!findOverviewFile(d.id),
        })),
      });
    },
  );

  /* GET /api/admin/overview-templates/:id — full editable config. */
  app.get(
    '/api/admin/overview-templates/:id',
    { preHandler: auth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = req.params as { id: string };
      const dash = getOverviewDashboard(id);
      if (!dash) return reply.code(404).send({ error: 'not_found', id });
      return reply.send({
        generatedAt: Date.now(),
        dashboard: dash,
        editable: !!findOverviewFile(id),
      });
    },
  );

}
