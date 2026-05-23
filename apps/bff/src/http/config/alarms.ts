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
 * `/api/alarms/config` — read + write the alarm-page setup. The shape
 * is `{ pinnedLayers: string[] }`: OAP layer keys that get a
 * dedicated tile + breakdown chip on the alarms page header. The
 * `serviceLayer` cache is invalidated on save so per-row layer tags
 * pick up any new layer immediately instead of waiting for the 60s
 * TTL.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ConfigSource } from '../../config/loader.js';
import type { SessionStore } from '../../user/sessions.js';
import type { AuditLogger } from '../../audit/logger.js';
import { requireAuth } from '../../user/middleware.js';
import type { ServiceLayerCatalog } from '../../logic/services/service-layer-catalog.js';
import {
  ALARMS_WINDOW_OPTIONS,
  OVERVIEW_ALARMS_LIMIT_MAX,
  OVERVIEW_ALARMS_LIMIT_MIN,
  type AlarmsStore,
  type AlarmsConfig,
} from '../../logic/alarms/store.js';

export interface AlarmsConfigRouteDeps {
  config: ConfigSource;
  sessions: SessionStore;
  audit: AuditLogger;
  store: AlarmsStore;
  serviceLayer: ServiceLayerCatalog;
}

const configSaveSchema = z.object({
  pinnedLayers: z.array(z.string().min(1)).max(8),
  /* Locked to the page-picker preset set so the admin's pick always
   * lights up a real tab. Hand-edited values are rejected with a 400
   * rather than silently coerced — keeps debugging predictable. */
  defaultWindowMs: z
    .number()
    .int()
    .refine((v) => (ALARMS_WINDOW_OPTIONS as readonly number[]).includes(v), {
      message: `must be one of ${ALARMS_WINDOW_OPTIONS.join(', ')}`,
    }),
  /* Bounded range — too low starves the widget's incident merge of
   * variety; too high pulls more bytes per poll than necessary. */
  overviewAlarmsLimit: z
    .number()
    .int()
    .min(OVERVIEW_ALARMS_LIMIT_MIN)
    .max(OVERVIEW_ALARMS_LIMIT_MAX),
});

export function registerAlarmsConfigRoutes(
  app: FastifyInstance,
  deps: AlarmsConfigRouteDeps,
): void {
  const auth = requireAuth(deps);

  app.get(
    '/api/alarms/config',
    { preHandler: auth },
    async (_req: FastifyRequest, reply: FastifyReply) => {
      const cfg = await deps.store.load();
      return reply.send(cfg);
    },
  );

  app.post(
    '/api/alarms/config',
    { preHandler: auth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const parsed = configSaveSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_body', detail: parsed.error.flatten() });
      }
      /* Normalise layer keys to upper-case + dedup so the persisted
       * shape is canonical regardless of what the admin form sent. */
      const seen = new Set<string>();
      const pinnedLayers: string[] = [];
      for (const raw of parsed.data.pinnedLayers) {
        const k = raw.trim().toUpperCase();
        if (!k || seen.has(k)) continue;
        seen.add(k);
        pinnedLayers.push(k);
      }
      const next: AlarmsConfig = {
        pinnedLayers,
        defaultWindowMs: parsed.data.defaultWindowMs,
        overviewAlarmsLimit: parsed.data.overviewAlarmsLimit,
      };
      await deps.store.save(next);
      deps.serviceLayer.invalidate();
      deps.audit.record({
        action: 'alarms.config.save',
        actor: req.session?.username ?? null,
        outcome: 'ok',
        details: {
          pinnedLayers: next.pinnedLayers,
          defaultWindowMs: next.defaultWindowMs,
          overviewAlarmsLimit: next.overviewAlarmsLimit,
        },
        fromIp: req.ip,
        sessionId: req.session?.sid,
      });
      return reply.send(next);
    },
  );
}
