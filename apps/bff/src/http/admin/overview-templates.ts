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
 * `/api/admin/overview-templates*` — admin CRUD for the per-dashboard
 * JSON templates that drive overview pages. Mirrors the layer-template
 * admin: write back to the same on-disk bundled file, invalidate the
 * loader cache so the next SPA fetch sees the new shape.
 *
 *   GET  /api/admin/overview-templates           — list (id, title,
 *                                                  widgets summary).
 *   GET  /api/admin/overview-templates/:id       — full dashboard config.
 *   POST /api/admin/overview-templates/:id       — write a dashboard's
 *                                                  full config back.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ConfigSource } from '../../config/loader.js';
import type { SessionStore } from '../../user/sessions.js';
import { requireAuth } from '../../user/middleware.js';
import {
  findOverviewFile,
  getOverviewDashboard,
  loadOverviewDashboards,
} from '../../logic/overview/loader.js';

export interface OverviewTemplatesAdminDeps {
  config: ConfigSource;
  sessions: SessionStore;
}

const WIDGET_TYPES = [
  'metric',
  'topology',
  'section-break',
  'kpi-tile',
  'alarms',
  'metric-composite',
] as const;

const kpiSchema = z
  .object({
    label: z.string().min(1),
    /* `mqe` is required when source is 'mqe' (the default), optional
     * when source is 'service-count'. Cross-field check below. */
    mqe: z.string().optional(),
    unit: z.string().optional(),
    aggregation: z.enum(['sum', 'avg']).optional(),
    style: z.enum(['number', 'progress-bar']).optional(),
    /* `max` is only meaningful when style is `progress-bar` — but
     * we accept it for any style and let the renderer ignore it
     * otherwise. Validating that pairing here would add false
     * positives during in-flight edits. */
    max: z.number().positive().optional(),
    source: z.enum(['mqe', 'service-count']).optional(),
  })
  .refine(
    (k) => {
      const src = k.source ?? 'mqe';
      if (src === 'mqe') return typeof k.mqe === 'string' && k.mqe.length > 0;
      return true;
    },
    { message: 'mqe is required when source is "mqe"' },
  )
  .refine((k) => k.style !== 'progress-bar' || (typeof k.max === 'number' && k.max > 0), {
    message: 'progress-bar style requires `max > 0`',
  });

const widgetSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  tip: z.string().optional(),
  layer: z.string().optional(),
  type: z.enum(WIDGET_TYPES),
  mqe: z.string().optional(),
  unit: z.string().optional(),
  aggregation: z.enum(['sum', 'avg']).optional(),
  cols: z.number().int().optional(),
  kpis: z.array(kpiSchema).optional(),
  showCount: z.boolean().optional(),
  aggregateOnPage: z.boolean().optional(),
  limit: z.number().int().min(1).max(100).optional(),
  rankBy: z
    .object({ kpi: z.number().int().min(0).optional(), mqe: z.string().optional() })
    .optional(),
  span: z.number().int().min(1).max(12).optional(),
  rowSpan: z.number().int().min(1).max(12).optional(),
});

/** Overview-dashboard content schema. Exported so the OAP-backed save path
 *  (`/api/admin/templates/save`) validates the same shape this create route
 *  does — the guard the editor relied on before the save migration. */
export const dashboardSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().optional(),
  visibility: z.enum(['public', 'operate']).optional(),
  icon: z.string().optional(),
  order: z.number().optional(),
  layers: z.array(z.string()).optional(),
  widgets: z.array(widgetSchema).max(64),
});

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
