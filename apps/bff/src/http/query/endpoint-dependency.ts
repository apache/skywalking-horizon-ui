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
 * `GET /api/layer/:key/endpoint-dependency?service=<id|name>&endpoint=<name|id>`
 *
 * API-dependency feed for the per-layer "API dependency" tab.
 *
 * Same shape as topology-routes.ts but scoped to endpoint nodes /
 * edges. The MQE expressions, units, labels, and visual-role bindings
 * come from the LAYER TEMPLATE's `endpointDependency` block (with a
 * booster-ui-derived default). Nodes with no resolvable metric values
 * are dropped from the response — phantom endpoints don't help the
 * operator.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ConfigSource } from '../../config/loader.js';
import type { SessionStore } from '../../user/sessions.js';
import type {
  EndpointDependencyCall,
  EndpointDependencyConfig,
  EndpointDependencyNode,
  EndpointDependencyResponse,
  FetchLike,
  TopologyMetricDef,
  UITemplateClient,
} from '@skywalking-horizon-ui/api-client';
import { requireAuth } from '../../user/middleware.js';
import {  graphqlPost, buildOapOpts } from '../../client/graphql.js';
import { withColdStage } from '../../util/duration.js';
import {
  defaultMinuteWindow,
  getServerOffsetMinutes,
  windowFromRange,
  type TimeStep,
} from '../../util/window.js';
import { endpointDependencyConfigFor } from '../../logic/layers/loader.js';
import { resolveEffectiveLayer } from '../../logic/layers/effective.js';
import { parsePreviewEndpointDep } from '../../logic/layers/preview.js';

export interface EndpointDependencyRouteDeps {
  config: ConfigSource;
  sessions: SessionStore;
  fetch?: FetchLike;
  /** OAP UI-template client — serve the in-use (remote-or-bundled) config. */
  uiTemplateClient?: () => UITemplateClient;
}

interface OapEpNode {
  id: string;
  name: string;
  serviceId: string;
  serviceName: string;
  type: string | null;
  isReal: boolean;
}
interface OapEpCall {
  id: string;
  source: string;
  target: string;
  detectPoints: string[];
}
interface EndpointDepResp {
  topology: { nodes: OapEpNode[]; calls: OapEpCall[] };
}

const LIST_SERVICES_FOR_RESOLVE = /* GraphQL */ `
  query ListServicesForEndpointDep($layer: String!) {
    services: listServices(layer: $layer) {
      id
      name
      normal
    }
  }
`;
const FIND_ENDPOINT = /* GraphQL */ `
  query FindEndpointForDep($serviceId: ID!, $keyword: String!, $duration: Duration!) {
    endpoints: findEndpoint(serviceId: $serviceId, keyword: $keyword, limit: 50, duration: $duration) {
      id
      name
    }
  }
`;
const ENDPOINT_DEPENDENCY = /* GraphQL */ `
  query EndpointDependency($endpointId: ID!, $duration: Duration!) {
    topology: getEndpointDependencies(endpointId: $endpointId, duration: $duration) {
      nodes { id name serviceId serviceName type isReal }
      calls { id source target detectPoints }
    }
  }
`;

const DEFAULT_WINDOW_MIN = 60;

interface MqeValueRow {
  value: string | number | null;
}
interface MqeResult {
  values?: MqeValueRow[];
}
interface MqeShape {
  type?: string;
  error?: string | null;
  results?: MqeResult[];
}

function endpointFragment(
  alias: string,
  m: TopologyMetricDef,
  serviceName: string,
  endpointName: string,
  normal: boolean,
  w: { start: string; end: string; step: TimeStep },
  coldStage: boolean,
): string {
  const coldFrag = coldStage ? ', coldStage: true' : '';
  return (
    `${alias}: execExpression(\n` +
    `      expression: ${JSON.stringify(m.mqe)},\n` +
    `      entity: { scope: Endpoint,` +
    ` serviceName: ${JSON.stringify(serviceName)},` +
    ` endpointName: ${JSON.stringify(endpointName)},` +
    ` normal: ${normal ? 'true' : 'false'} },\n` +
    `      duration: { start: ${JSON.stringify(w.start)}, end: ${JSON.stringify(w.end)}, step: ${w.step}${coldFrag} }\n` +
    `    ) { type error results { values { value } } }`
  );
}

/**
 * EndpointRelation entity. Scope is dropped — OAP infers it from the
 * MQE name (`endpoint_relation_*` → EndpointRelation). Per booster
 * the `normal` flags come from `node.normal || node.isReal`.
 */
function endpointRelationFragment(
  alias: string,
  m: TopologyMetricDef,
  sourceServiceName: string,
  sourceEndpointName: string,
  sourceNormal: boolean,
  destServiceName: string,
  destEndpointName: string,
  destNormal: boolean,
  w: { start: string; end: string; step: TimeStep },
  coldStage: boolean,
): string {
  const coldFrag = coldStage ? ', coldStage: true' : '';
  return (
    `${alias}: execExpression(\n` +
    `      expression: ${JSON.stringify(m.mqe)},\n` +
    `      entity: {` +
    ` serviceName: ${JSON.stringify(sourceServiceName)},` +
    ` endpointName: ${JSON.stringify(sourceEndpointName)},` +
    ` normal: ${sourceNormal ? 'true' : 'false'},` +
    ` destServiceName: ${JSON.stringify(destServiceName)},` +
    ` destEndpointName: ${JSON.stringify(destEndpointName)},` +
    ` destNormal: ${destNormal ? 'true' : 'false'} },\n` +
    `      duration: { start: ${JSON.stringify(w.start)}, end: ${JSON.stringify(w.end)}, step: ${w.step}${coldFrag} }\n` +
    `    ) { type error results { values { value } } }`
  );
}

/** Time-series extractor for the edge sidebar's sparkline. */
function seriesFromMqe(env: MqeShape | undefined): Array<number | null> | null {
  if (!env || env.error) return null;
  const values = env.results?.[0]?.values ?? [];
  if (values.length === 0) return null;
  return values.map((v) => {
    if (v.value === null || v.value === undefined) return null;
    const n = Number(v.value);
    return Number.isFinite(n) ? n : null;
  });
}

function aggregateMqe(env: MqeShape | undefined, kind: 'avg' | 'sum'): number | null {
  if (!env || env.error) return null;
  const values = env.results?.[0]?.values ?? [];
  const nums: number[] = [];
  for (const v of values) {
    if (v.value === null || v.value === undefined) continue;
    const n = Number(v.value);
    if (Number.isFinite(n)) nums.push(n);
  }
  if (nums.length === 0) return null;
  const sum = nums.reduce((a, b) => a + b, 0);
  return kind === 'sum' ? sum : sum / nums.length;
}

function emptyResponse(
  layerKey: string,
  serviceArg: string,
  endpointArg: string,
  endpointId: string | null,
  cfg: EndpointDependencyConfig,
  reachable: boolean,
  err?: string,
): EndpointDependencyResponse {
  return {
    layer: layerKey,
    service: serviceArg,
    endpoint: endpointArg,
    endpointId,
    generatedAt: Date.now(),
    config: cfg,
    nodes: [],
    calls: [],
    reachable,
    ...(err ? { error: err } : {}),
  };
}

function legacyNodeView(metrics: Record<string, number | null>): {
  cpm: number | null;
  respTime: number | null;
  sla: number | null;
} {
  return {
    cpm: metrics.cpm ?? null,
    respTime: metrics.respTime ?? null,
    sla: metrics.sla ?? null,
  };
}
function legacyEdgeView(metrics: Record<string, number | null>): {
  cpm: number | null;
  respTime: number | null;
} {
  return {
    cpm: metrics.cpm ?? null,
    respTime: metrics.respTime ?? null,
  };
}

export function registerEndpointDependencyRoute(
  app: FastifyInstance,
  deps: EndpointDependencyRouteDeps,
): void {
  const auth = requireAuth(deps);
  app.get(
    '/api/layer/:key/endpoint-dependency',
    { preHandler: auth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const params = req.params as { key: string };
      const layerKey = params.key;
      if (!layerKey || !/^[a-z0-9_]+$/i.test(layerKey)) {
        return reply.code(400).send({ error: 'invalid_layer_key' });
      }
      const q = req.query as {
        service?: string;
        endpoint?: string;
        previewConfig?: string;
        step?: string;
        startMs?: string;
        endMs?: string;
      };
      const serviceArg = (q.service ?? '').trim();
      const endpointArg = (q.endpoint ?? '').trim();
      if (!serviceArg) return reply.code(400).send({ error: 'missing_service' });
      if (!endpointArg) return reply.code(400).send({ error: 'missing_endpoint' });

      // Admin Preview: render the operator's draft `endpointDependency`
      // block when forwarded + valid (bypasses the remote resolve + block).
      const previewCfg = parsePreviewEndpointDep(q.previewConfig);
      let epCfg: EndpointDependencyConfig;
      if (previewCfg) {
        epCfg = previewCfg;
      } else {
        const eff = await resolveEffectiveLayer(deps.uiTemplateClient, layerKey);
        if (eff.blocked) {
          // Template store unreachable / layer disabled — block, no defaults.
          return reply.send(emptyResponse(layerKey, serviceArg, endpointArg, null, { nodeMetrics: [] }, true));
        }
        epCfg = endpointDependencyConfigFor(eff.template);
      }

      const cfgCurrent = deps.config.current;
      const opts = buildOapOpts(cfgCurrent, deps.fetch);
      const offset = await getServerOffsetMinutes(deps.config, deps.fetch);
      // Honor the SPA's topbar picker triplet; else fall back to the
      // last-hour MINUTE window (dashboards family — minute precision).
      const stepArg = (q.step ?? '').toUpperCase() as TimeStep;
      const startMs = Number(q.startMs);
      const endMs = Number(q.endMs);
      const window =
        (stepArg === 'MINUTE' || stepArg === 'HOUR' || stepArg === 'DAY') &&
        Number.isFinite(startMs) &&
        Number.isFinite(endMs)
          ? windowFromRange(stepArg, startMs, endMs, offset) ??
            defaultMinuteWindow(offset, DEFAULT_WINDOW_MIN)
          : defaultMinuteWindow(offset, DEFAULT_WINDOW_MIN);
      const oapLayer = layerKey.toUpperCase();
      const durationVar = withColdStage(req, { start: window.start, end: window.end, step: window.step });
      const coldStage = !!req.coldStage;

      // ── Resolve service name → id.
      let serviceId = serviceArg;
      let normal = true;
      try {
        const data = await graphqlPost<{
          services: Array<{ id: string; name: string; normal?: boolean | null }>;
        }>(opts, LIST_SERVICES_FOR_RESOLVE, { layer: oapLayer });
        const match =
          data.services.find((s) => s.name === serviceArg) ??
          data.services.find((s) => s.id === serviceArg) ??
          null;
        if (!match) {
          return reply.send(emptyResponse(layerKey, serviceArg, endpointArg, null, epCfg, true, 'service not found'));
        }
        serviceId = match.id;
        normal = match.normal !== false;
      } catch (err) {
        return reply.send(
          emptyResponse(
            layerKey,
            serviceArg,
            endpointArg,
            null,
            epCfg,
            false,
            err instanceof Error ? err.message : String(err),
          ),
        );
      }

      // ── Resolve endpoint name → id.
      let endpointId = endpointArg;
      if (!/\.0_/.test(endpointArg)) {
        try {
          const data = await graphqlPost<{ endpoints: Array<{ id: string; name: string }> }>(
            opts,
            FIND_ENDPOINT,
            { serviceId, keyword: endpointArg, duration: durationVar },
          );
          const match =
            data.endpoints.find((e) => e.name === endpointArg) ??
            data.endpoints[0] ??
            null;
          if (!match) {
            return reply.send(
              emptyResponse(layerKey, serviceArg, endpointArg, null, epCfg, true, 'endpoint not found'),
            );
          }
          endpointId = match.id;
        } catch (err) {
          return reply.send(
            emptyResponse(
              layerKey,
              serviceArg,
              endpointArg,
              null,
              epCfg,
              false,
              err instanceof Error ? err.message : String(err),
            ),
          );
        }
      }

      // ── Fetch the dependency graph.
      let graph: EndpointDepResp['topology'];
      try {
        const data = await graphqlPost<EndpointDepResp>(opts, ENDPOINT_DEPENDENCY, {
          endpointId,
          duration: durationVar,
        });
        graph = data.topology;
      } catch (err) {
        return reply.send(
          emptyResponse(
            layerKey,
            serviceArg,
            endpointArg,
            endpointId,
            epCfg,
            false,
            err instanceof Error ? err.message : String(err),
          ),
        );
      }

      // ── Per-node MQE.
      const realNodes = graph.nodes.filter(
        (n) => n.isReal && n.serviceName && n.name && n.name !== 'User',
      );
      const nodeMetricVals = new Map<string, Record<string, number | null>>();
      if (realNodes.length > 0 && epCfg.nodeMetrics.length > 0) {
        const fragments: string[] = [];
        const aliasMap = new Map<string, { nodeId: string; metric: TopologyMetricDef }>();
        realNodes.forEach((n, i) => {
          const isFocus = n.serviceId === serviceId;
          const useNormal = isFocus ? normal : true;
          epCfg.nodeMetrics.forEach((m, j) => {
            const alias = `e${i}_${j}`;
            aliasMap.set(alias, { nodeId: n.id, metric: m });
            fragments.push(endpointFragment(alias, m, n.serviceName, n.name, useNormal, window, coldStage));
          });
        });
        const CHUNK = 150;
        for (let i = 0; i < fragments.length; i += CHUNK) {
          const slice = fragments.slice(i, i + CHUNK);
          const query = `query EndpointMetrics {\n  ${slice.join('\n  ')}\n}`;
          let env: Record<string, MqeShape>;
          try {
            env = await graphqlPost<Record<string, MqeShape>>(opts, query);
          } catch {
            break;
          }
          for (const [alias, shape] of Object.entries(env)) {
            const info = aliasMap.get(alias);
            if (!info) continue;
            const v = aggregateMqe(shape, info.metric.aggregation ?? 'avg');
            const rec = nodeMetricVals.get(info.nodeId) ?? {};
            rec[info.metric.id] = v;
            nodeMetricVals.set(info.nodeId, rec);
          }
        }
      }

      // ── Per-edge MQE under EndpointRelation. We also capture the
      // per-bucket series so the UI's edge sidebar can draw sparklines.
      //
      // Endpoint relation metrics are SERVER-SIDE only (OAP has no
      // `endpoint_relation_client_*` family) — they live on the
      // callee that records the incoming call. So an edge is
      // queryable when the DEST endpoint is real + named, regardless
      // of whether the source is real (e.g. `User → consumer` edges
      // still produce server-side numbers). When the source is
      // virtual we use a synthetic source service name and
      // `sourceNormal: false`, which is what booster does too.
      const linkMetrics = epCfg.linkMetrics ?? [];
      const edgeMetricVals = new Map<string, Record<string, number | null>>();
      const edgeMetricSeries = new Map<string, Record<string, Array<number | null> | null>>();
      const realEndpointMap = new Map(realNodes.map((n) => [n.id, n]));
      const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
      const candidateEdges = graph.calls.filter((c) => {
        const dst = nodeById.get(c.target);
        return !!dst && dst.isReal && !!dst.name && !!dst.serviceName;
      });
      if (candidateEdges.length > 0 && linkMetrics.length > 0) {
        const fragments: string[] = [];
        const aliasMap = new Map<string, { callId: string; metric: TopologyMetricDef }>();
        candidateEdges.forEach((c, i) => {
          const dst = realEndpointMap.get(c.target) ?? nodeById.get(c.target)!;
          const src = nodeById.get(c.source);
          // Source may be a synthetic node (`User`, `localhost:-1`).
          // Booster's pattern: pass the source's name + serviceName
          // through, and set `sourceNormal = isReal`. OAP accepts
          // virtual sources for endpoint-relation queries.
          const srcName = src?.name || 'User';
          const srcServiceName = src?.serviceName || 'User';
          const srcNormal = src ? src.isReal : false;
          const dstNormal = dst.serviceId === serviceId ? normal : true;
          linkMetrics.forEach((m, j) => {
            const alias = `r${i}_${j}`;
            aliasMap.set(alias, { callId: c.id, metric: m });
            fragments.push(
              endpointRelationFragment(
                alias,
                m,
                srcServiceName,
                srcName,
                srcNormal,
                dst.serviceName,
                dst.name,
                dstNormal,
                window,
                coldStage,
              ),
            );
          });
        });
        const CHUNK = 200;
        for (let i = 0; i < fragments.length; i += CHUNK) {
          const slice = fragments.slice(i, i + CHUNK);
          const query = `query EndpointEdgeMetrics {\n  ${slice.join('\n  ')}\n}`;
          let env: Record<string, MqeShape>;
          try {
            env = await graphqlPost<Record<string, MqeShape>>(opts, query);
          } catch {
            break;
          }
          for (const [alias, shape] of Object.entries(env)) {
            const info = aliasMap.get(alias);
            if (!info) continue;
            const v = aggregateMqe(shape, info.metric.aggregation ?? 'avg');
            const rec = edgeMetricVals.get(info.callId) ?? {};
            rec[info.metric.id] = v;
            edgeMetricVals.set(info.callId, rec);
            const sRec = edgeMetricSeries.get(info.callId) ?? {};
            sRec[info.metric.id] = seriesFromMqe(shape);
            edgeMetricSeries.set(info.callId, sRec);
          }
        }
      }

      // ── Build response — drop nodes without any metric values, then
      // re-prune dangling edges.
      function hasAnyValue(r: Record<string, number | null>): boolean {
        for (const v of Object.values(r)) if (v !== null) return true;
        return false;
      }
      const liveNodes: EndpointDependencyNode[] = [];
      for (const n of graph.nodes) {
        const m = nodeMetricVals.get(n.id) ?? {};
        const filled: Record<string, number | null> = {};
        for (const def of epCfg.nodeMetrics) filled[def.id] = m[def.id] ?? null;
        if (n.isReal && n.name !== 'User' && !hasAnyValue(filled)) continue;
        liveNodes.push({
          id: n.id,
          name: n.name,
          serviceId: n.serviceId,
          serviceName: n.serviceName,
          type: n.type,
          isReal: n.isReal,
          metrics: filled,
          ...legacyNodeView(filled),
        });
      }
      const liveIds = new Set(liveNodes.map((n) => n.id));
      const liveCalls: EndpointDependencyCall[] = [];
      for (const c of graph.calls) {
        if (!liveIds.has(c.source) || !liveIds.has(c.target)) continue;
        const m = edgeMetricVals.get(c.id) ?? {};
        const s = edgeMetricSeries.get(c.id) ?? {};
        const filled: Record<string, number | null> = {};
        const filledSeries: Record<string, Array<number | null> | null> = {};
        for (const def of linkMetrics) {
          filled[def.id] = m[def.id] ?? null;
          filledSeries[def.id] = s[def.id] ?? null;
        }
        liveCalls.push({
          id: c.id,
          source: c.source,
          target: c.target,
          detectPoints: c.detectPoints ?? [],
          metrics: filled,
          metricSeries: filledSeries,
          ...legacyEdgeView(filled),
        });
      }

      return reply.send({
        layer: layerKey,
        service: serviceArg,
        endpoint: endpointArg,
        endpointId,
        generatedAt: Date.now(),
        config: epCfg,
        nodes: liveNodes,
        calls: liveCalls,
        reachable: true,
      } satisfies EndpointDependencyResponse);
    },
  );
}
