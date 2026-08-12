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
 * Endpoint-dependency builder — an endpoint's upstream/downstream
 * API-dependency chain (OAP `getEndpointDependencies`), shared by the
 * endpoint-dependency route and the AI assistant's `show_endpoint_dependency`
 * tool. Edge metrics are SERVER-SIDE only (OAP has no endpoint-relation client
 * family). Never throws: an OAP failure returns a `reachable:false` response.
 * The caller resolves the (preview OR effective) config first; the returned
 * `endpointId` PINS which endpoint chain was drawn (the AI snapshot freezes it
 * so a reload doesn't redraw a different — now busier — endpoint).
 */

import type {
  EndpointDependencyCall,
  EndpointDependencyConfig,
  EndpointDependencyNode,
  EndpointDependencyResponse,
  TopologyMetricDef,
} from '@skywalking-horizon-ui/api-client';
import type { HorizonConfig } from '../../config/schema.js';
import type { GraphqlOptions } from '../../client/graphql.js';
import type { Window } from '../../util/window.js';
import { graphqlPost, fetchAliasedChunks } from '../../client/graphql.js';
import { type MqeShape, aggregateMqe, seriesFromMqe } from './topology-mqe.js';

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

function endpointFragment(
  alias: string,
  m: TopologyMetricDef,
  serviceName: string,
  endpointName: string,
  normal: boolean,
  w: Window,
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
  w: Window,
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

export function emptyEndpointDependencyResponse(
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

export interface BuildEndpointDependencyInput {
  opts: GraphqlOptions;
  perf: HorizonConfig['performance'];
  window: Window;
  coldStage: boolean;
  /** The resolved (preview OR effective) endpoint-dependency config. */
  cfg: EndpointDependencyConfig;
  layerKey: string;
  /** Service NAME or id to resolve. */
  serviceArg: string;
  /** Endpoint NAME or id — resolved to an endpointId that PINS the chain. */
  endpointArg: string;
}

export async function buildEndpointDependency(input: BuildEndpointDependencyInput): Promise<EndpointDependencyResponse> {
  const { opts, perf, window, coldStage, cfg: epCfg, layerKey, serviceArg, endpointArg } = input;
  const oapLayer = layerKey.toUpperCase();
  const durationVar = coldStage
    ? { start: window.start, end: window.end, step: window.step, coldStage: true }
    : { start: window.start, end: window.end, step: window.step };

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
      return emptyEndpointDependencyResponse(layerKey, serviceArg, endpointArg, null, epCfg, true, 'service not found');
    }
    serviceId = match.id;
    normal = match.normal !== false;
  } catch (err) {
    return emptyEndpointDependencyResponse(layerKey, serviceArg, endpointArg, null, epCfg, false, err instanceof Error ? err.message : String(err));
  }

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
        return emptyEndpointDependencyResponse(layerKey, serviceArg, endpointArg, null, epCfg, true, 'endpoint not found');
      }
      endpointId = match.id;
    } catch (err) {
      return emptyEndpointDependencyResponse(layerKey, serviceArg, endpointArg, null, epCfg, false, err instanceof Error ? err.message : String(err));
    }
  }

  let graph: EndpointDepResp['topology'];
  try {
    const data = await graphqlPost<EndpointDepResp>(opts, ENDPOINT_DEPENDENCY, {
      endpointId,
      duration: durationVar,
    });
    graph = data.topology;
  } catch (err) {
    return emptyEndpointDependencyResponse(layerKey, serviceArg, endpointArg, endpointId, epCfg, false, err instanceof Error ? err.message : String(err));
  }

  const realNodes = graph.nodes.filter(
    (n) => n.isReal && n.serviceName && n.name && n.name !== 'User',
  );
  // Per-node + per-edge MQE. Build both fragment families, then fan them
  // out concurrently (disjoint OAP entities + result maps); each chunks
  // internally and soft-fails per chunk, keeping the graph on a hiccup.
  const nodeMetricVals = new Map<string, Record<string, number | null>>();
  const edgeMetricVals = new Map<string, Record<string, number | null>>();
  const edgeMetricSeries = new Map<string, Record<string, Array<number | null> | null>>();

  const nodeAliasMap = new Map<string, { nodeId: string; metric: TopologyMetricDef }>();
  const nodeFragments: string[] = [];
  if (realNodes.length > 0 && epCfg.nodeMetrics.length > 0) {
    realNodes.forEach((n, i) => {
      const isFocus = n.serviceId === serviceId;
      const useNormal = isFocus ? normal : true;
      epCfg.nodeMetrics.forEach((m, j) => {
        const alias = `e${i}_${j}`;
        nodeAliasMap.set(alias, { nodeId: n.id, metric: m });
        nodeFragments.push(endpointFragment(alias, m, n.serviceName, n.name, useNormal, window, coldStage));
      });
    });
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
  const realEndpointMap = new Map(realNodes.map((n) => [n.id, n]));
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  const candidateEdges = graph.calls.filter((c) => {
    const dst = nodeById.get(c.target);
    return !!dst && dst.isReal && !!dst.name && !!dst.serviceName;
  });
  const edgeAliasMap = new Map<string, { callId: string; metric: TopologyMetricDef }>();
  const edgeFragments: string[] = [];
  if (candidateEdges.length > 0 && linkMetrics.length > 0) {
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
        edgeAliasMap.set(alias, { callId: c.id, metric: m });
        edgeFragments.push(
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
  }

  // track failed metric chunks → surface "blank may be unavailable, not zero"
  const mstats = { failed: 0, total: 0 };
  const [nodeEnv, edgeEnv] = await Promise.all([
    fetchAliasedChunks<MqeShape>(opts, nodeFragments, perf.bulk.topology.nodeBulkSize, 'EndpointMetrics', perf.bulk.topology.concurrency, mstats),
    fetchAliasedChunks<MqeShape>(opts, edgeFragments, perf.bulk.topology.edgeBulkSize, 'EndpointEdgeMetrics', perf.bulk.topology.concurrency, mstats),
  ]);

  for (const [alias, shape] of Object.entries(nodeEnv)) {
    const info = nodeAliasMap.get(alias);
    if (!info) continue;
    const v = aggregateMqe(shape, info.metric.aggregation ?? 'avg');
    const rec = nodeMetricVals.get(info.nodeId) ?? {};
    rec[info.metric.id] = v;
    nodeMetricVals.set(info.nodeId, rec);
  }
  for (const [alias, shape] of Object.entries(edgeEnv)) {
    const info = edgeAliasMap.get(alias);
    if (!info) continue;
    const v = aggregateMqe(shape, info.metric.aggregation ?? 'avg');
    const rec = edgeMetricVals.get(info.callId) ?? {};
    rec[info.metric.id] = v;
    edgeMetricVals.set(info.callId, rec);
    const sRec = edgeMetricSeries.get(info.callId) ?? {};
    sRec[info.metric.id] = seriesFromMqe(shape);
    edgeMetricSeries.set(info.callId, sRec);
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

  return {
    layer: layerKey,
    service: serviceArg,
    endpoint: endpointArg,
    endpointId,
    generatedAt: Date.now(),
    config: epCfg,
    nodes: liveNodes,
    calls: liveCalls,
    reachable: true,
    ...(mstats.failed > 0 ? { metricsPartial: { failedChunks: mstats.failed, totalChunks: mstats.total } } : {}),
  } satisfies EndpointDependencyResponse;
}
