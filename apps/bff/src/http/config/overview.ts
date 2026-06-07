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
 * Overview-dashboard routes.
 *
 *   GET  /api/overview/dashboards            — list (id, title, count).
 *   GET  /api/overview/dashboards/:id        — full dashboard config.
 *
 * Widget DATA is fetched by the SPA on a per-widget basis through
 * existing routes — service-count + topology hit
 * `/api/layer/:key/landing` and `/api/layer/:key/topology` directly,
 * and `metric` widgets evaluate their MQE through the dashboard data
 * route. Keeping the overview route lean (config only) lets the SPA
 * mix and match — e.g. a "Mesh service" dashboard widget reusing
 * the same topology endpoint that the per-layer page hits.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type {
  OverviewDashboard,
  OverviewDashboardListResponse,
  OverviewDashboardResponse,
  UITemplateClient,
} from '@skywalking-horizon-ui/api-client';
import type { ConfigSource } from '../../config/loader.js';
import type { SessionStore } from '../../user/sessions.js';
import { requireAuth } from '../../user/middleware.js';
import {
  resolveEffectiveOverviews,
  resolveEffectiveOverview,
} from '../../logic/overview/effective.js';
import { oapOverlayContentFor } from '../../logic/templates/overlay.js';
import { localizeContent, localeFromRequest } from '../../i18n/index.js';

export interface OverviewRouteDeps {
  config: ConfigSource;
  sessions: SessionStore;
  /** OAP UI-template client — serve the in-use (remote-or-bundled)
   *  overviews + apply OAP translation overlays, matching the bundle. */
  uiTemplateClient?: () => UITemplateClient;
}

export function registerOverviewRoutes(app: FastifyInstance, deps: OverviewRouteDeps): void {
  const auth = requireAuth(deps);

  app.get('/api/overview/dashboards', { preHandler: auth }, async (req, reply) => {
    const locale = localeFromRequest(req);
    const dashboards = await resolveEffectiveOverviews(deps.uiTemplateClient);
    const body: OverviewDashboardListResponse = {
      generatedAt: Date.now(),
      dashboards: await Promise.all(
        dashboards.map(async (d) => {
          const ld = localizeContent<OverviewDashboard>(
            d,
            await oapOverlayContentFor(deps.uiTemplateClient, 'overview', d.id, locale),
            locale,
          );
          return {
            id: ld.id,
            title: ld.title,
            description: ld.description,
            visibility: ld.visibility,
            icon: ld.icon,
            order: ld.order,
            layers: ld.layers,
            widgetCount: ld.widgets.length,
          };
        }),
      ),
    };
    return reply.send(body);
  });

  app.get(
    '/api/overview/dashboards/:id',
    { preHandler: auth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = req.params as { id: string };
      const dash = await resolveEffectiveOverview(deps.uiTemplateClient, id);
      if (!dash) {
        // null ⇒ unknown OR admin-disabled on OAP — either way it doesn't
        // render (a disabled overview must not resurrect from bundled).
        const body: OverviewDashboardResponse = {
          generatedAt: Date.now(),
          dashboard: { id, title: id, widgets: [] },
          reachable: false,
          error: `unknown dashboard "${id}"`,
        };
        return reply.code(404).send(body);
      }
      const locale = localeFromRequest(req);
      const body: OverviewDashboardResponse = {
        generatedAt: Date.now(),
        dashboard: localizeContent<OverviewDashboard>(
          dash,
          await oapOverlayContentFor(deps.uiTemplateClient, 'overview', dash.id, locale),
          locale,
        ),
        reachable: true,
      };
      return reply.send(body);
    },
  );
}
