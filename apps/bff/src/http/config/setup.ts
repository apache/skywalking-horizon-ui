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

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { SetupResponse, SetupSavePayload } from '@skywalking-horizon-ui/api-client';
import type { AuditLogger } from '../../audit/logger.js';
import { requireAuth } from '../../user/middleware.js';
import type { ConfigSource } from '../../config/loader.js';
import type { SessionStore } from '../../user/sessions.js';
import { badRequest } from '../../errors.js';
import type { SetupStore } from '../../logic/setup/store.js';

export interface SetupRouteDeps {
  config: ConfigSource;
  sessions: SessionStore;
  audit: AuditLogger;
  store: SetupStore;
}

const aggregationSchema = z.enum(['sum', 'avg']);

const landingColumnSchema = z
  .object({
    metric: z.string().min(1),
    label: z.string().min(1),
    unit: z.string().optional(),
    mqe: z.string().optional(),
    aggregation: aggregationSchema.optional(),
    scale: z.number().finite().optional(),
    precision: z.number().int().min(0).max(6).optional(),
  })
  .strict();

const landingSchema = z
  .object({
    priority: z.number().int().min(0).max(99),
    topN: z.number().int().min(5).max(8),
    orderBy: z.string().min(1),
    columns: z.array(landingColumnSchema).max(5),
    style: z.enum(['table', 'bar', 'mini-topology']),
  })
  // `.strip()` (not `.strict()`): setups persisted by older builds carry the
  // retired `spark` / `throughput` keys — drop them silently on re-save
  // instead of failing the whole payload.
  .strip();

const layerConfigSchema = z
  .object({
    displayName: z.string().optional(),
    slots: z
      .object({
        services: z.string().optional(),
        instances: z.string().optional(),
        endpoints: z.string().optional(),
        endpointDependency: z.string().optional(),
      })
      .strict(),
    caps: z
      .object({
        serviceMap: z.boolean().optional(),
        endpointDependency: z.boolean().optional(),
        instanceTopology: z.boolean().optional(),
        processTopology: z.boolean().optional(),
        dashboards: z.boolean().optional(),
        traces: z.boolean().optional(),
        logs: z.boolean().optional(),
        profiling: z.boolean().optional(),
        events: z.boolean().optional(),
      })
      .strict(),
    landing: landingSchema,
  })
  .strict();

const savePayloadSchema = z
  .object({
    layers: z.record(z.string().min(1), layerConfigSchema),
  })
  .strict();

export function registerSetupRoutes(app: FastifyInstance, deps: SetupRouteDeps): void {
  const auth = requireAuth(deps);

  app.get('/api/setup', { preHandler: auth }, async (_req: FastifyRequest, reply: FastifyReply) => {
    const layers = await deps.store.load();
    const body: SetupResponse = { generatedAt: Date.now(), layers };
    return reply.send(body);
  });

  app.post('/api/setup', { preHandler: auth }, async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = savePayloadSchema.safeParse(req.body);
    if (!parsed.success) {
      throw badRequest('invalid setup payload', parsed.error.flatten());
    }
    const payload = parsed.data as SetupSavePayload;
    await deps.store.save(payload.layers);
    deps.audit.record({
      actor: req.session?.username ?? null,
      action: 'setup.save',
      outcome: 'success',
      details: { layerCount: Object.keys(payload.layers).length },
    });
    const body: SetupResponse = { generatedAt: Date.now(), layers: payload.layers };
    return reply.send(body);
  });
}
