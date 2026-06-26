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
 * `GET /api/layer/:key/instances?service=<id|name>` — list active
 * service instances for a service.
 *
 * The per-layer Instance dashboard surfaces a second selector below
 * the service picker: the user picks a service first, then chooses
 * one of its instances. The selector is fed by this endpoint; the
 * dashboard MQE then evaluates against `{ scope: ServiceInstance,
 * serviceName, serviceInstanceName }` for the selected pair.
 *
 * The `service` query param accepts the OAP service id (preferred —
 * passed through verbatim) or a plain service name (we resolve it via
 * `listServices(layer)` and pick the first matching row). Returning
 * both id + name keeps the SPA from re-resolving.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ConfigSource } from '../../config/loader.js';
import type { SessionStore } from '../../user/sessions.js';
import type { FetchLike } from '@skywalking-horizon-ui/api-client';
import { requireAuth } from '../../user/middleware.js';
import {  graphqlPost, buildOapOpts } from '../../client/graphql.js';
import { withColdStage } from '../../util/duration.js';
import { defaultMinuteWindow, getServerOffsetMinutes } from '../../util/window.js';

export interface InstanceRouteDeps {
  config: ConfigSource;
  sessions: SessionStore;
  fetch?: FetchLike;
}

interface OapInstance {
  id: string;
  name: string;
  language?: string | null;
  attributes?: Array<{ name: string; value: string }> | null;
}

interface ListServicesResp {
  services: Array<{ id: string; name: string; normal?: boolean | null }>;
}

const LIST_SERVICES_FOR_RESOLVE = /* GraphQL */ `
  query ListServicesForResolve($layer: String!) {
    services: listServices(layer: $layer) {
      id
      name
      normal
    }
  }
`;

const LIST_INSTANCES = /* GraphQL */ `
  query LayerInstances($serviceId: ID!, $duration: Duration!) {
    instances: listInstances(serviceId: $serviceId, duration: $duration) {
      id
      name
      language
      attributes {
        name
        value
      }
    }
  }
`;

const DEFAULT_WINDOW_MIN = 60;

export interface InstanceRow {
  id: string;
  name: string;
  language: string | null;
  attributes: Array<{ name: string; value: string }>;
}

export interface InstancesResponse {
  layer: string;
  service: string;
  generatedAt: number;
  instances: InstanceRow[];
  reachable: boolean;
  error?: string;
}

export function registerInstanceRoute(app: FastifyInstance, deps: InstanceRouteDeps): void {
  const auth = requireAuth(deps);
  app.get(
    '/api/layer/:key/instances',
    { preHandler: auth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const params = req.params as { key: string };
      const layerKey = params.key;
      if (!layerKey || !/^[a-z0-9_]+$/i.test(layerKey)) {
        return reply.code(400).send({ error: 'invalid_layer_key' });
      }
      const q = req.query as { service?: string };
      const serviceArg = (q.service ?? '').trim();
      if (!serviceArg) {
        return reply.code(400).send({ error: 'missing_service' });
      }
      const cfgCurrent = deps.config.current;
      const opts = buildOapOpts(cfgCurrent, deps.fetch);
      const offset = await getServerOffsetMinutes(deps.config, deps.fetch);
      const window = defaultMinuteWindow(offset, DEFAULT_WINDOW_MIN);
      // OAP service-id shape: `<base64>.<digits>` (e.g.
      // `Y2hlY2tvdXQ=.1`). Match this strictly, not "contains `.`":
      // a loose substring rule mis-classifies mesh / k8s_service names
      // that embed dots (e.g. `mesh-svr::r3-load.sample-services`) as
      // ids — they need a `listServices` lookup instead.
      let serviceId = serviceArg;
      if (!/^[A-Za-z0-9+/=]+\.\d+$/.test(serviceArg)) {
        try {
          const data = await graphqlPost<ListServicesResp>(opts, LIST_SERVICES_FOR_RESOLVE, {
            layer: layerKey.toUpperCase(),
          });
          const match =
            data.services.find((s) => s.name === serviceArg) ??
            data.services.find((s) => s.id === serviceArg) ??
            null;
          if (!match) {
            return reply.send({
              layer: layerKey,
              service: serviceArg,
              generatedAt: Date.now(),
              instances: [],
              reachable: true,
              error: 'service not found',
            } satisfies InstancesResponse);
          }
          serviceId = match.id;
        } catch (err) {
          return reply.send({
            layer: layerKey,
            service: serviceArg,
            generatedAt: Date.now(),
            instances: [],
            reachable: false,
            error: err instanceof Error ? err.message : String(err),
          } satisfies InstancesResponse);
        }
      }
      try {
        const data = await graphqlPost<{ instances: OapInstance[] }>(opts, LIST_INSTANCES, {
          serviceId,
          duration: withColdStage(req, { start: window.start, end: window.end, step: 'MINUTE' }),
        });
        const rows: InstanceRow[] = (data.instances ?? []).map((i) => ({
          id: i.id,
          name: i.name,
          language: i.language ?? null,
          attributes: i.attributes ?? [],
        }));
        return reply.send({
          layer: layerKey,
          service: serviceArg,
          generatedAt: Date.now(),
          instances: rows,
          reachable: true,
        } satisfies InstancesResponse);
      } catch (err) {
        return reply.send({
          layer: layerKey,
          service: serviceArg,
          generatedAt: Date.now(),
          instances: [],
          reachable: false,
          error: err instanceof Error ? err.message : String(err),
        } satisfies InstancesResponse);
      }
    },
  );
}
