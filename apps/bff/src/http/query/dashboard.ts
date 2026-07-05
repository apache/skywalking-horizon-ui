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
 * `POST /api/layer/:key/dashboard` — runs each widget's MQE expression
 * against the OAP server and returns the result keyed by widget id.
 *
 * Body shape: `{ service?: string, widgets?: DashboardWidget[] }`. When
 * `widgets` is omitted, the BFF substitutes the layer's built-in
 * default set (see `defaults.ts`). When `service` is omitted, the BFF
 * picks the first service from `listServices(layer)` so the response
 * is never empty — UIs can pass an explicit service to scope.
 *
 * This route resolves the entity (service/instance/endpoint) + time
 * window, then hands the widget set to the shared `runWidgets` executor
 * (gate-probe → batch → collapse) — the same path the AI `emit_widgets`
 * tool uses.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type {
  DashboardResponse,
  DashboardWidget,
  FetchLike,
  UITemplateClient,
} from '@skywalking-horizon-ui/api-client';
import type { ConfigSource } from '../../config/loader.js';
import type { SessionStore } from '../../user/sessions.js';
import { requireAuth } from '../../user/middleware.js';
import { graphqlPost, buildOapOpts } from '../../client/graphql.js';
import { withColdStage } from '../../util/duration.js';
import {
  defaultMinuteWindow,
  getServerOffsetMinutes,
  windowFromRange,
} from '../../util/window.js';
import { widgetsForScope } from '../../logic/layers/loader.js';
import { serviceLayerCatalog } from '../../logic/services/service-layer-catalog.js';
import { resolveEffectiveLayer } from '../../logic/layers/effective.js';
import { defaultWidgetsFor } from '../../logic/dashboard/defaults.js';
import { bodySchema, MAX_REQUEST_WIDGETS } from '../../logic/dashboard/schema.js';
import { flattenTabWidgets } from '../../logic/dashboard/gates.js';
import { runWidgets } from '../../logic/dashboard/run.js';

export interface DashboardRouteDeps {
  config: ConfigSource;
  sessions: SessionStore;
  fetch?: FetchLike;
  /** OAP UI-template client — serve the in-use (remote-or-bundled)
   *  widget set when the caller doesn't pass explicit widgets. */
  uiTemplateClient?: () => UITemplateClient;
}

const LIST_FIRST_SERVICE = /* GraphQL */ `
  query FirstService($layer: String!) {
    services: listServices(layer: $layer) { id name normal group }
  }
`;

/** Auto-pick a default instance/endpoint when the caller asks for the
 *  matching scope but doesn't carry an explicit `serviceInstance` /
 *  `endpoint` body field. Without this the dashboard fires with a
 *  Service-scope entity and every ServiceInstance / Endpoint metric
 *  (so11y_* meters, envoy_cluster_*, JVM metrics, endpoint_cpm, …)
 *  returns "no data" on first paint. */
const LIST_FIRST_INSTANCE = /* GraphQL */ `
  query FirstInstance($serviceId: ID!, $duration: Duration!) {
    instances: listInstances(serviceId: $serviceId, duration: $duration) {
      id name
    }
  }
`;
const FIND_FIRST_ENDPOINT = /* GraphQL */ `
  query FirstEndpoint($serviceId: ID!, $duration: Duration!) {
    endpoints: findEndpoint(serviceId: $serviceId, keyword: "", limit: 1, duration: $duration) {
      id name
    }
  }
`;

const DEFAULT_WINDOW_MIN = 60;
function defaultWindow(offsetMinutes: number) {
  return defaultMinuteWindow(offsetMinutes, DEFAULT_WINDOW_MIN);
}

export function registerDashboardQueryRoute(app: FastifyInstance, deps: DashboardRouteDeps): void {
  const auth = requireAuth(deps);
  app.post(
    '/api/layer/:key/dashboard',
    { preHandler: auth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const params = req.params as { key: string };
      const layerKey = params.key;
      if (!layerKey || !/^[a-z0-9_]+$/i.test(layerKey)) {
        return reply.code(400).send({ error: 'invalid_layer_key' });
      }
      const parsed = bodySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_body', detail: parsed.error.flatten() });
      }
      const scope = parsed.data.scope ?? 'service';
      const eff = await resolveEffectiveLayer(deps.uiTemplateClient, layerKey);
      // Blocked (template store unreachable / layer disabled) → no
      // BFF-derived widgets and no in-code defaults; the grid stays empty.
      // An explicit `widgets[]` in the body still runs — the caller owns it.
      const widgets: DashboardWidget[] = flattenTabWidgets(
        parsed.data.widgets ??
          (eff.blocked
            ? []
            : eff.template
              ? widgetsForScope(eff.template, scope)
              : defaultWidgetsFor(eff.template, layerKey)),
      );
      // Re-apply the cap AFTER expansion for a body-PROVIDED set: a tab counts
      // as 1 in the zod cap but flattens to many leaves, so a hand-built body
      // could fan past it. The SPA pre-flattens + chunks, so this never trips
      // it; the template fallback is trusted (and the OAP batch is bulk-chunked).
      if (parsed.data.widgets && widgets.length > MAX_REQUEST_WIDGETS) {
        return reply.code(400).send({
          error: 'too_many_widgets',
          detail: `${widgets.length} widgets after tab expansion exceeds ${MAX_REQUEST_WIDGETS}`,
        });
      }
      let serviceName = parsed.data.service ?? '';
      let serviceId = '';
      let normal = true;
      const cfgCurrent = deps.config.current;
      const opts = buildOapOpts(cfgCurrent, deps.fetch);
      // Probe OAP's timezone so the Duration strings we emit match
      // OAP-server local time (not UTC, not browser-local). Cached 60s
      // inside getServerOffsetMinutes; ~one OAP round-trip per minute.
      const offset = await getServerOffsetMinutes(deps.config, deps.fetch);
      // Honor the SPA's time picker (step + start/end). Falls back to
      // the last-hour MINUTE default when the caller omits the range.
      const window =
        parsed.data.step && parsed.data.startMs && parsed.data.endMs
          ? windowFromRange(parsed.data.step, parsed.data.startMs, parsed.data.endMs, offset) ??
            defaultWindow(offset)
          : defaultWindow(offset);

      const baseResp: DashboardResponse = {
        layer: layerKey,
        service: serviceName || null,
        generatedAt: Date.now(),
        step: window.step,
        durationStart: window.start,
        durationEnd: window.end,
        widgets: [],
        reachable: true,
      };

      // Step 1 — resolve service. The `normal` flag has to ride along with
      // the service entity: some layers (VIRTUAL_MQ, VIRTUAL_DATABASE,
      // VIRTUAL_CACHE, AWS_*) use `normal: false` services, and without it
      // every MQE on those layers comes back null because the entity-scope
      // filter doesn't match the dimension OAP stored them under.
      //
      // Read the shared per-layer catalog first (60s TTL, kept warm by the
      // sidebar) so the common case needs no per-dashboard `listServices`.
      // Fall back to a live `listServices` on a miss — a cold/empty
      // snapshot, a just-registered service, or OAP being unreachable: the
      // catalog soft-fails to empty, so only the live probe tells
      // "unreachable" (reachable:false) apart from "no such service".
      //
      // `?group=` (split-by-service-group menu entry) constrains the
      // auto-pick default to that OAP Service.group; an explicit `service`
      // is honored regardless of group.
      const group = (req.query as { group?: string }).group;
      type PickRow = { id: string; name: string; normal: boolean | null; group?: string | null };
      const pick = (all: PickRow[]): PickRow | undefined => {
        if (serviceName) return all.find((s) => s.name === serviceName) ?? all.find((s) => s.id === serviceName);
        const inGroup = group === undefined ? all : all.filter((s) => (s.group ?? '') === group);
        return inGroup[0];
      };
      let picked = pick((await serviceLayerCatalog(deps).get()).byLayer.get(layerKey.toUpperCase()) ?? []);
      if (!picked) {
        try {
          const data = await graphqlPost<{ services: PickRow[] }>(opts, LIST_FIRST_SERVICE, {
            layer: layerKey.toUpperCase(),
          });
          picked = pick(data.services ?? []);
        } catch (err) {
          return reply.send({
            ...baseResp,
            reachable: false,
            error: err instanceof Error ? err.message : String(err),
            widgets: widgets.map((w) => ({ id: w.id, error: 'oap unreachable' })),
          });
        }
        if (!picked) {
          return reply.send({
            ...baseResp,
            widgets: widgets.map((w) => ({
              id: w.id,
              error: serviceName ? `service "${serviceName}" not in layer` : 'no service in layer',
            })),
          });
        }
      }
      serviceName = picked.name;
      serviceId = picked.id;
      normal = picked.normal !== false;
      baseResp.service = serviceName;

      // Step 1b — auto-pick instance/endpoint when scope requires one
      // but the caller didn't pass one. Without this, the first paint
      // on /instance or /endpoint fires Service-scope queries against
      // ServiceInstance / Endpoint-scope metrics and every widget
      // shows "no data" until the UI's instance/endpoint picker
      // resolves and the dashboard re-fires. Symmetric to the
      // listServices auto-pick above.
      let selectedInstance: string | null = parsed.data.serviceInstance ?? null;
      let selectedEndpoint: string | null = parsed.data.endpoint ?? null;
      if (scope === 'instance' && !selectedInstance && serviceId) {
        try {
          const data = await graphqlPost<{ instances: Array<{ id: string; name: string }> }>(
            opts,
            LIST_FIRST_INSTANCE,
            {
              serviceId,
              duration: withColdStage(req, { start: window.start, end: window.end, step: window.step }),
            },
          );
          selectedInstance = data.instances?.[0]?.name ?? null;
        } catch {
          /* leave selectedInstance null — widgets surface "no data" */
        }
      }
      if (scope === 'endpoint' && !selectedEndpoint && serviceId) {
        try {
          const data = await graphqlPost<{ endpoints: Array<{ id: string; name: string }> }>(
            opts,
            FIND_FIRST_ENDPOINT,
            {
              serviceId,
              duration: withColdStage(req, { start: window.start, end: window.end, step: window.step }),
            },
          );
          selectedEndpoint = data.endpoints?.[0]?.name ?? null;
        } catch {
          /* leave selectedEndpoint null — widgets surface "no data" */
        }
      }

      // Step 2/3 — gate-probe, batch every widget × expression, collapse
      // per widget type. Shared with the AI `emit_widgets` tool.
      const { widgets: results, reachable } = await runWidgets(
        widgets,
        {
          service: serviceName,
          serviceId: serviceId || undefined,
          instance: selectedInstance,
          endpoint: selectedEndpoint,
          scope,
          normal,
        },
        window,
        {
          opts,
          bulkSize: cfgCurrent.performance.bulk.dashboard.bulkSize,
          coldStage: !!req.coldStage,
        },
      );

      return reply.send({ ...baseResp, reachable, widgets: results });
    },
  );
}
