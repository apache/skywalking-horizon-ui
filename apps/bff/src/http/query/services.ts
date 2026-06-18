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
 * `GET /api/layer/:key/services` — full service roster for one layer.
 *
 * Reads from the shared {@link serviceLayerCatalog} (the BFF's
 * single-flight, 60s-TTL fan-out over `listLayers` + `listServices`),
 * so this route adds no extra OAP traffic — every caller (sidebar
 * counts, alarms tagger, layer-shell URL validator, …) sees the same
 * snapshot.
 *
 * Used by the layer shell to validate a URL-pinned `?service=<id>`
 * against the layer's real service set (independent of landing's
 * top-N rollup, which can miss low-traffic services). When a deep
 * link refers to a service that's truly absent the shell pops a
 * "service not found" notice; when present, the operator's pick is
 * trusted regardless of whether it shows up in landing's top-N.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { FetchLike } from '@skywalking-horizon-ui/api-client';
import type { ConfigSource } from '../../config/loader.js';
import type { SessionStore } from '../../user/sessions.js';
import { requireAuth } from '../../user/middleware.js';
import { serviceLayerCatalog } from '../../logic/services/service-layer-catalog.js';

export interface LayerServicesRouteDeps {
  config: ConfigSource;
  sessions: SessionStore;
  fetch?: FetchLike;
}

export function registerLayerServicesRoute(
  app: FastifyInstance,
  deps: LayerServicesRouteDeps,
): void {
  const auth = requireAuth(deps);
  const catalog = serviceLayerCatalog({ config: deps.config, fetch: deps.fetch });
  app.get(
    '/api/layer/:key/services',
    { preHandler: auth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const params = req.params as { key: string };
      const layerKey = params.key;
      if (!layerKey || !/^[a-z0-9_]+$/i.test(layerKey)) {
        return reply.code(400).send({ error: 'invalid_layer_key' });
      }
      const layerUpper = layerKey.toUpperCase();
      // Optional `?group=` (from a split-by-service-group menu entry) —
      // narrow the roster to that OAP Service.group. Absent ⇒ all groups.
      const group = (req.query as { group?: string }).group;
      try {
        const snap = await catalog.get();
        const all = snap.byLayer.get(layerUpper) ?? [];
        const rows = group === undefined ? all : all.filter((r) => r.group === group);
        return reply.send({
          reachable: true,
          layer: layerUpper,
          services: rows.map((r) => ({ id: r.id, name: r.name, normal: r.normal })),
        });
      } catch (err) {
        return reply.send({
          reachable: false,
          layer: layerUpper,
          services: [],
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );
}
