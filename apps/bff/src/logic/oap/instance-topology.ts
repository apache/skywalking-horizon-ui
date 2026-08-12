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
 * Instance-topology builder — the instance-to-instance graph for one
 * service→service edge (OAP `getServiceInstanceTopology(client, server)`),
 * shared by the instance-topology route and the AI assistant's
 * `show_instance_topology` tool so both draw the identical graph (per-instance
 * metrics + twin server/client edge series). Never throws: an OAP failure
 * returns a `reachable:false` response. The caller resolves the (preview OR
 * effective) config first — a null config means the layer has no instance map.
 */

import type {
  InstanceTopologyCall,
  InstanceTopologyConfig,
  InstanceTopologyNode,
  InstanceTopologyResponse,
  TopologyMetricDef,
} from '@skywalking-horizon-ui/api-client';
import type { HorizonConfig } from '../../config/schema.js';
import type { GraphqlOptions } from '../../client/graphql.js';
import type { Window } from '../../util/window.js';
import { graphqlPost, fetchAliasedChunks } from '../../client/graphql.js';
import { type MqeShape, aggregateMqe, seriesFromMqe, instanceNodeFragment } from './topology-mqe.js';

interface OapInstNode {
  id: string;
  name: string;
  serviceName: string;
  serviceId: string;
  isReal: boolean;
}
interface OapInstCall {
  id: string;
  source: string;
  target: string;
  detectPoints: string[];
}
interface InstanceTopologyResp {
  topology: { nodes: OapInstNode[]; calls: OapInstCall[] };
}

const INSTANCE_TOPOLOGY = /* GraphQL */ `
  query InstanceTopology($clientServiceId: ID!, $serverServiceId: ID!, $duration: Duration!) {
    topology: getServiceInstanceTopology(
      clientServiceId: $clientServiceId
      serverServiceId: $serverServiceId
      duration: $duration
    ) {
      nodes { id name serviceName serviceId isReal }
      calls { id source target detectPoints }
    }
  }
`;

const LIST_SERVICES_FOR_RESOLVE = /* GraphQL */ `
  query ListServicesForInstanceTopology($layer: String!) {
    services: listServices(layer: $layer) {
      id
      name
      normal
    }
  }
`;

/**
 * Per-edge fragment for ServiceInstanceRelation. As with the service
 * map's relation fragment we do NOT set `scope` — OAP infers it from
 * the metric name (`service_instance_relation_server_*` →
 * ServiceInstanceRelation server, `*_client_*` → client). The entity
 * carries both endpoints' service + instance names.
 */
function relationFragment(
  alias: string,
  m: TopologyMetricDef,
  srcServiceName: string,
  srcInstanceName: string,
  srcNormal: boolean,
  dstServiceName: string,
  dstInstanceName: string,
  dstNormal: boolean,
  w: Window,
  coldStage: boolean,
): string {
  const coldFrag = coldStage ? ', coldStage: true' : '';
  return (
    `${alias}: execExpression(\n` +
    `      expression: ${JSON.stringify(m.mqe)},\n` +
    `      entity: {` +
    ` serviceName: ${JSON.stringify(srcServiceName)},` +
    ` normal: ${srcNormal ? 'true' : 'false'},` +
    ` serviceInstanceName: ${JSON.stringify(srcInstanceName)},` +
    ` destServiceName: ${JSON.stringify(dstServiceName)},` +
    ` destNormal: ${dstNormal ? 'true' : 'false'},` +
    ` destServiceInstanceName: ${JSON.stringify(dstInstanceName)} },\n` +
    `      duration: { start: ${JSON.stringify(w.start)}, end: ${JSON.stringify(w.end)}, step: ${w.step}${coldFrag} }\n` +
    `    ) { type error results { values { value } } }`
  );
}

export function emptyInstanceTopologyResponse(
  layerKey: string,
  clientServiceId: string,
  serverServiceId: string,
  cfg: InstanceTopologyConfig,
  reachable: boolean,
  err?: string,
): InstanceTopologyResponse {
  return {
    layer: layerKey,
    clientServiceId,
    serverServiceId,
    clientServiceName: null,
    serverServiceName: null,
    generatedAt: Date.now(),
    config: cfg,
    nodes: [],
    calls: [],
    reachable,
    ...(err ? { error: err } : {}),
  };
}

export interface BuildInstanceTopologyInput {
  opts: GraphqlOptions;
  perf: HorizonConfig['performance'];
  window: Window;
  coldStage: boolean;
  /** The resolved (preview OR effective) instance-topology config — non-null. */
  cfg: InstanceTopologyConfig;
  layerKey: string;
  clientServiceId: string;
  serverServiceId: string;
}

export async function buildInstanceTopology(input: BuildInstanceTopologyInput): Promise<InstanceTopologyResponse> {
  const { opts, perf, window, coldStage, cfg: instCfg, layerKey, clientServiceId, serverServiceId } = input;
  const oapLayer = layerKey.toUpperCase();
  const durationVar = coldStage
    ? { start: window.start, end: window.end, step: window.step, coldStage: true }
    : { start: window.start, end: window.end, step: window.step };

  // ── Resolve the two services' names + normal-flags. The instance
  // node entity needs the SERVICE's normal flag (not the instance's);
  // booster resolves `normal = node.normal || isReal`.
  const knownServices = new Map<string, { name: string; normal: boolean }>();
  try {
    const data = await graphqlPost<{
      services: Array<{ id: string; name: string; normal?: boolean | null }>;
    }>(opts, LIST_SERVICES_FOR_RESOLVE, { layer: oapLayer });
    for (const s of data.services) {
      knownServices.set(s.id, { name: s.name, normal: s.normal !== false });
    }
  } catch (err) {
    return emptyInstanceTopologyResponse(layerKey, clientServiceId, serverServiceId, instCfg, false, err instanceof Error ? err.message : String(err));
  }
  const clientSvc = knownServices.get(clientServiceId) ?? null;
  const serverSvc = knownServices.get(serverServiceId) ?? null;

  // ── Fetch the instance topology between the two services.
  let topo: { nodes: OapInstNode[]; calls: OapInstCall[] };
  try {
    const data = await graphqlPost<InstanceTopologyResp>(opts, INSTANCE_TOPOLOGY, {
      clientServiceId,
      serverServiceId,
      duration: durationVar,
    });
    topo = data.topology;
  } catch (err) {
    return emptyInstanceTopologyResponse(layerKey, clientServiceId, serverServiceId, instCfg, false, err instanceof Error ? err.message : String(err));
  }

  const nodes = topo.nodes ?? [];
  const calls = topo.calls ?? [];
  const nodeById = new Map<string, OapInstNode>();
  for (const n of nodes) nodeById.set(n.id, n);
  // Per-instance `normal` resolves off the owning service's flag;
  // fall back to the instance node's `isReal` when the service isn't
  // in the catalog snapshot (conjured peers).
  function normalFor(n: OapInstNode): boolean {
    return knownServices.get(n.serviceId)?.normal ?? n.isReal;
  }

  // ── Per-node + per-edge MQE. Build both fragment families, then fan them
  // out concurrently (disjoint OAP entities + disjoint result maps); each
  // chunks internally and soft-fails per chunk, keeping the graph on a hiccup.
  const nodeMetricVals = new Map<string, Record<string, number | null>>();
  const serverMetricVals = new Map<string, Record<string, number | null>>();
  const clientMetricVals = new Map<string, Record<string, number | null>>();
  const serverMetricSeries = new Map<string, Record<string, Array<number | null> | null>>();
  const clientMetricSeries = new Map<string, Record<string, Array<number | null> | null>>();

  const realNodes = nodes.filter((n) => n.isReal);
  const nodeAliasMap = new Map<string, { nodeId: string; metric: TopologyMetricDef }>();
  const nodeFragments: string[] = [];
  if (realNodes.length > 0 && instCfg.nodeMetrics.length > 0) {
    realNodes.forEach((n, i) => {
      instCfg.nodeMetrics.forEach((m, j) => {
        const alias = `n${i}_${j}`;
        nodeAliasMap.set(alias, { nodeId: n.id, metric: m });
        nodeFragments.push(instanceNodeFragment(alias, m, n.serviceName, n.name, normalFor(n), window, coldStage));
      });
    });
  }

  // Per-edge: server + client families, per-side gate (server needs a real
  // DEST, client a real SOURCE).
  const linkSrv = instCfg.linkServerMetrics ?? [];
  const linkCli = instCfg.linkClientMetrics ?? [];
  const candidateEdges = calls.filter((c) => {
    const a = nodeById.get(c.source);
    const b = nodeById.get(c.target);
    return !!a && !!b && !!a.name && !!b.name;
  });
  const edgeAliasMap = new Map<
    string,
    { callId: string; metric: TopologyMetricDef; side: 'server' | 'client' }
  >();
  const edgeFragments: string[] = [];
  if (candidateEdges.length > 0 && (linkSrv.length > 0 || linkCli.length > 0)) {
    candidateEdges.forEach((c, i) => {
      const src = nodeById.get(c.source)!;
      const dst = nodeById.get(c.target)!;
      const srcNormal = normalFor(src);
      const dstNormal = normalFor(dst);
      if (dst.isReal) {
        linkSrv.forEach((m, j) => {
          const alias = `s${i}_${j}`;
          edgeAliasMap.set(alias, { callId: c.id, metric: m, side: 'server' });
          edgeFragments.push(
            relationFragment(alias, m, src.serviceName, src.name, srcNormal, dst.serviceName, dst.name, dstNormal, window, coldStage),
          );
        });
      }
      if (src.isReal) {
        linkCli.forEach((m, j) => {
          const alias = `c${i}_${j}`;
          edgeAliasMap.set(alias, { callId: c.id, metric: m, side: 'client' });
          edgeFragments.push(
            relationFragment(alias, m, src.serviceName, src.name, srcNormal, dst.serviceName, dst.name, dstNormal, window, coldStage),
          );
        });
      }
    });
  }

  // track failed metric chunks → surface "blank may be unavailable, not zero"
  const mstats = { failed: 0, total: 0 };
  const [nodeEnv, edgeEnv] = await Promise.all([
    fetchAliasedChunks<MqeShape>(opts, nodeFragments, perf.bulk.topology.nodeBulkSize, 'InstanceNodeMetrics', perf.bulk.topology.concurrency, mstats),
    fetchAliasedChunks<MqeShape>(opts, edgeFragments, perf.bulk.topology.edgeBulkSize, 'InstanceEdgeMetrics', perf.bulk.topology.concurrency, mstats),
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
    const valBucket = info.side === 'server' ? serverMetricVals : clientMetricVals;
    const seriesBucket = info.side === 'server' ? serverMetricSeries : clientMetricSeries;
    const valRec = valBucket.get(info.callId) ?? {};
    valRec[info.metric.id] = v;
    valBucket.set(info.callId, valRec);
    const sRec = seriesBucket.get(info.callId) ?? {};
    sRec[info.metric.id] = seriesFromMqe(shape);
    seriesBucket.set(info.callId, sRec);
  }

  // ── Build response. Connected instances only — an instance with no
  // edge in the window doesn't belong on the drill-down graph.
  const connectedNodeIds = new Set<string>();
  for (const c of calls) {
    connectedNodeIds.add(c.source);
    connectedNodeIds.add(c.target);
  }
  const liveNodes: InstanceTopologyNode[] = [];
  for (const n of nodes) {
    if (!connectedNodeIds.has(n.id)) continue;
    const m = nodeMetricVals.get(n.id) ?? {};
    const filled: Record<string, number | null> = {};
    for (const def of instCfg.nodeMetrics) filled[def.id] = m[def.id] ?? null;
    liveNodes.push({
      id: n.id,
      name: n.name,
      serviceId: n.serviceId,
      serviceName: n.serviceName,
      isReal: n.isReal,
      metrics: filled,
    });
  }
  const liveNodeIds = new Set(liveNodes.map((n) => n.id));
  const liveCalls: InstanceTopologyCall[] = [];
  for (const c of calls) {
    if (!liveNodeIds.has(c.source) || !liveNodeIds.has(c.target)) continue;
    const sm = serverMetricVals.get(c.id) ?? {};
    const cm = clientMetricVals.get(c.id) ?? {};
    const ss = serverMetricSeries.get(c.id) ?? {};
    const cs = clientMetricSeries.get(c.id) ?? {};
    const filledSrv: Record<string, number | null> = {};
    const filledSrvSeries: Record<string, Array<number | null> | null> = {};
    for (const def of linkSrv) {
      filledSrv[def.id] = sm[def.id] ?? null;
      filledSrvSeries[def.id] = ss[def.id] ?? null;
    }
    const filledCli: Record<string, number | null> = {};
    const filledCliSeries: Record<string, Array<number | null> | null> = {};
    for (const def of linkCli) {
      filledCli[def.id] = cm[def.id] ?? null;
      filledCliSeries[def.id] = cs[def.id] ?? null;
    }
    liveCalls.push({
      id: c.id,
      source: c.source,
      target: c.target,
      detectPoints: c.detectPoints ?? [],
      serverMetrics: filledSrv,
      clientMetrics: filledCli,
      serverMetricSeries: filledSrvSeries,
      clientMetricSeries: filledCliSeries,
    });
  }

  // Resolve the display name. The layer roster (`listServices`) only
  // carries entry-point services, so a callee addressed by host:port
  // (e.g. `rcmd:80`) — real, but not a roster entry — misses there.
  // OAP already hands us the decoded `serviceName` on each instance
  // node, so fall back to that before surfacing the raw base64 id.
  const nameForService = (id: string): string | null =>
    nodes.find((n) => n.serviceId === id)?.serviceName ?? null;

  return {
    layer: layerKey,
    clientServiceId,
    serverServiceId,
    clientServiceName: clientSvc?.name ?? nameForService(clientServiceId),
    serverServiceName: serverSvc?.name ?? nameForService(serverServiceId),
    generatedAt: Date.now(),
    config: instCfg,
    nodes: liveNodes,
    calls: liveCalls,
    reachable: true,
    ...(mstats.failed > 0 ? { metricsPartial: { failedChunks: mstats.failed, totalChunks: mstats.total } } : {}),
  } satisfies InstanceTopologyResponse;
}
