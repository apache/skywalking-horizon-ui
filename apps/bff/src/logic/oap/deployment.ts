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
 * Deployment builder — the instance-to-instance call graph WITHIN one service
 * (OAP `getServiceInstanceTopology(svc, svc)`), shared by the Deployment route
 * and the AI assistant's `show_deployment` tool so both draw the identical
 * graph (per-instance metrics, role clustering, twin server/client edge series).
 * Never throws: an OAP failure returns a `reachable:false` response. The caller
 * resolves the (preview OR effective) config first — a null config means the
 * layer doesn't support deployment (the route 404s; the AI narrates that).
 */

import type {
  ClusterByRule,
  DeploymentCall,
  DeploymentConfig,
  DeploymentNode,
  DeploymentMetricDef,
  DeploymentResponse,
  RolePairMetrics,
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
interface OapInstanceMeta {
  id: string;
  name: string;
  attributes?: Array<{ name: string; value: string }> | null;
}

const INSTANCE_TOPOLOGY = /* GraphQL */ `
  query DeploymentInstanceTopology($clientServiceId: ID!, $serverServiceId: ID!, $duration: Duration!) {
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
  query ListServicesForDeployment($layer: String!) {
    services: listServices(layer: $layer) {
      id
      name
      normal
    }
  }
`;

const LIST_INSTANCES = /* GraphQL */ `
  query DeploymentInstances($serviceId: ID!, $duration: Duration!) {
    instances: listInstances(serviceId: $serviceId, duration: $duration) {
      id
      name
      attributes {
        name
        value
      }
    }
  }
`;

/**
 * Per-edge fragment for ServiceInstanceRelation. As with the service-map
 * relation fragment we do NOT set `scope` — OAP infers it from the metric
 * name. Both endpoints share the selected service (intra-service graph),
 * so the same service name + normal flag rides both sides.
 */
function relationFragment(
  alias: string,
  m: DeploymentMetricDef,
  serviceName: string,
  srcInstanceName: string,
  dstInstanceName: string,
  normal: boolean,
  w: Window,
  coldStage: boolean,
): string {
  const coldFrag = coldStage ? ', coldStage: true' : '';
  return (
    `${alias}: execExpression(\n` +
    `      expression: ${JSON.stringify(m.mqe)},\n` +
    `      entity: {` +
    ` serviceName: ${JSON.stringify(serviceName)},` +
    ` normal: ${normal ? 'true' : 'false'},` +
    ` serviceInstanceName: ${JSON.stringify(srcInstanceName)},` +
    ` destServiceName: ${JSON.stringify(serviceName)},` +
    ` destNormal: ${normal ? 'true' : 'false'},` +
    ` destServiceInstanceName: ${JSON.stringify(dstInstanceName)} },\n` +
    `      duration: { start: ${JSON.stringify(w.start)}, end: ${JSON.stringify(w.end)}, step: ${w.step}${coldFrag} }\n` +
    `    ) { type error results { values { value } } }`
  );
}

/** Resolve a rule's key for an instance — attribute value (case-insensitive)
 *  or a named-capture from a regex on the instance name. Mirrors the UI's
 *  `keyFromRule`; used for `roleBy` so per-role MQE is picked server-side. */
function ruleKey(
  rule: ClusterByRule | undefined,
  name: string,
  attrs: Array<{ name: string; value: string }>,
): string | null {
  if (!rule) return null;
  const attrVal = (a: string): string | undefined =>
    attrs.find((x) => x.name.toLowerCase() === a.toLowerCase())?.value || undefined;
  if (rule.kind === 'attribute') return attrVal(rule.attribute) ?? null;
  if (rule.kind === 'attributes') {
    const parts = rule.attributes.map(attrVal).filter((v): v is string => !!v);
    return parts.length ? parts.join(rule.separator ?? ' / ') : null;
  }
  try {
    const m = new RegExp(rule.pattern, rule.flags ?? '').exec(name);
    return (m?.groups?.[rule.valueGroup ?? 'group']) || null;
  } catch {
    return null;
  }
}

export function emptyDeploymentResponse(
  layerKey: string,
  serviceId: string,
  cfg: DeploymentConfig,
  reachable: boolean,
  err?: string,
): DeploymentResponse {
  return {
    layer: layerKey,
    serviceId,
    serviceName: null,
    generatedAt: Date.now(),
    config: cfg,
    nodes: [],
    calls: [],
    reachable,
    ...(err ? { error: err } : {}),
  };
}

export interface BuildDeploymentInput {
  opts: GraphqlOptions;
  perf: HorizonConfig['performance'];
  window: Window;
  coldStage: boolean;
  /** The resolved (preview OR effective) deployment config — non-null (the
   *  caller already handled "deployment not supported"). */
  cfg: DeploymentConfig;
  layerKey: string;
  serviceId: string;
}

export async function buildDeployment(input: BuildDeploymentInput): Promise<DeploymentResponse> {
  const { opts, perf, window, coldStage, cfg, layerKey, serviceId } = input;
  const oapLayer = layerKey.toUpperCase();
  const durationVar = coldStage
    ? { start: window.start, end: window.end, step: window.step, coldStage: true }
    : { start: window.start, end: window.end, step: window.step };

  // ── Resolve the selected service's name + normal flag (the node
  // entity needs the SERVICE's normal flag). Booster resolves
  // `normal = service.normal || isReal`.
  let serviceName: string | null = null;
  let serviceNormal = true;
  try {
    const data = await graphqlPost<{
      services: Array<{ id: string; name: string; normal?: boolean | null }>;
    }>(opts, LIST_SERVICES_FOR_RESOLVE, { layer: oapLayer });
    const svc = data.services.find((s) => s.id === serviceId) ?? null;
    if (svc) {
      serviceName = svc.name;
      serviceNormal = svc.normal !== false;
    }
  } catch (err) {
    return emptyDeploymentResponse(layerKey, serviceId, cfg, false, err instanceof Error ? err.message : String(err));
  }

  // ── Fetch the intra-service instance topology (same id both sides).
  let topo: { nodes: OapInstNode[]; calls: OapInstCall[] };
  try {
    const data = await graphqlPost<InstanceTopologyResp>(opts, INSTANCE_TOPOLOGY, {
      clientServiceId: serviceId,
      serverServiceId: serviceId,
      duration: durationVar,
    });
    topo = data.topology;
  } catch (err) {
    return emptyDeploymentResponse(layerKey, serviceId, cfg, false, err instanceof Error ? err.message : String(err));
  }

  // ── Per-instance attributes (node_role / node_type / …) so the UI can
  // cluster by attribute — AND the fallback node source. A metrics-only
  // cluster emits no intra-service instance RELATIONS (OAP ships no MAL
  // SERVICE_INSTANCE_RELATION scope yet, SWIP-15 future work), so
  // getServiceInstanceTopology returns nothing — but the containers still
  // exist as instances. We render them as an inventory (grouped by
  // role/tier, per-node metrics, no edges) until the relation scope lands.
  // Soft-fail: degrade to ungrouped if listInstances is unavailable.
  const attrsById = new Map<string, Array<{ name: string; value: string }>>();
  const attrsByName = new Map<string, Array<{ name: string; value: string }>>();
  let instanceMetas: OapInstanceMeta[] = [];
  try {
    const data = await graphqlPost<{ instances: OapInstanceMeta[] }>(opts, LIST_INSTANCES, {
      serviceId,
      duration: durationVar,
    });
    instanceMetas = data.instances ?? [];
    for (const inst of instanceMetas) {
      const a = inst.attributes ?? [];
      attrsById.set(inst.id, a);
      attrsByName.set(inst.name, a);
    }
  } catch {
    // keep going with empty attribute maps
  }

  const calls = topo.calls ?? [];
  // Show the FULL container inventory AND the relation edges. Start from the
  // topology nodes (they carry the call graph), then MERGE IN any roster
  // instance the topology omits: a container with no intra-service relation
  // (e.g. the lifecycle sidecar while no migration is running) is absent
  // from getServiceInstanceTopology but is still a real container we want on
  // the map. Match by instance name (`pod_name@container_name`), which both
  // sources key on identically.
  const topoNodes = topo.nodes ?? [];
  const topoNames = new Set(topoNodes.map((n) => n.name));
  const nodes: OapInstNode[] = [
    ...topoNodes,
    ...instanceMetas
      .filter((i) => !topoNames.has(i.name))
      .map((i) => ({
        id: i.id,
        name: i.name,
        serviceName: serviceName ?? '',
        serviceId,
        isReal: true,
      })),
  ];
  const nodeById = new Map<string, OapInstNode>();
  for (const n of nodes) nodeById.set(n.id, n);
  // OAP hands the decoded service name on each instance node; prefer the
  // roster name but fall back to it for services missing from the
  // roster snapshot.
  if (!serviceName) serviceName = nodes.find((n) => n.serviceId === serviceId)?.serviceName ?? null;
  const entityServiceName = serviceName ?? '';
  function attrsFor(n: OapInstNode): Array<{ name: string; value: string }> {
    return attrsById.get(n.id) ?? attrsByName.get(n.name) ?? [];
  }
  // Per-node role (from roleBy) + its metric defs: the role's `nodeMetrics`
  // if any, else the top-level `nodeMetrics` fallback (which may be empty
  // for a roles-only config). Keeps the real path role-aware once a
  // clustered store actually emits intra-service instance relations.
  const cfgNN = cfg; // non-null past the 404 guard; stable for closures
  const cfgRoles = cfgNN.roles ?? [];
  function roleOf(n: OapInstNode): string | undefined {
    return ruleKey(cfgNN.roleBy, n.name, attrsFor(n)) ?? undefined;
  }
  function defsFor(n: OapInstNode): DeploymentMetricDef[] {
    const rk = roleOf(n);
    const rc = rk ? cfgRoles.find((r) => r.key.toLowerCase() === rk.toLowerCase()) : undefined;
    return rc?.nodeMetrics ?? cfgNN.nodeMetrics ?? [];
  }

  // ── Per-node + per-edge MQE. Build both fragment families (each node uses
  // its role's metric defs; each edge its role-pair defs), then fan them out
  // concurrently — disjoint OAP entities + disjoint result maps. Each family
  // chunks internally and soft-fails per chunk, keeping the graph on a hiccup.
  const nodeMetricVals = new Map<string, Record<string, number | null>>();
  const serverMetricVals = new Map<string, Record<string, number | null>>();
  const clientMetricVals = new Map<string, Record<string, number | null>>();
  const serverMetricSeries = new Map<string, Record<string, Array<number | null> | null>>();
  const clientMetricSeries = new Map<string, Record<string, Array<number | null> | null>>();

  const realNodes = nodes.filter((n) => n.isReal);
  const nodeAliasMap = new Map<string, { nodeId: string; metric: DeploymentMetricDef }>();
  const nodeFragments: string[] = [];
  realNodes.forEach((n, i) => {
    defsFor(n).forEach((m, j) => {
      const alias = `n${i}_${j}`;
      nodeAliasMap.set(alias, { nodeId: n.id, metric: m });
      nodeFragments.push(instanceNodeFragment(alias, m, n.serviceName, n.name, serviceNormal, window, coldStage));
    });
  });

  // Per-edge: server + client families, per-side gate. Self-loop edges
  // (source === target) are allowed — a node may call itself.
  const linkSrv = cfg.linkServerMetrics ?? [];
  const linkCli = cfg.linkClientMetrics ?? [];
  const roleToRole = cfg.roleToRole ?? [];
  const dedupeById = (defs: DeploymentMetricDef[]): DeploymentMetricDef[] => {
    const seen = new Set<string>();
    return defs.filter((d) => (seen.has(d.id) ? false : (seen.add(d.id), true)));
  };
  // An edge's role-pair (source role → target role via `roleBy`) selects a
  // roleToRole entry; most-specific wins (exact `from`/`to` beat a `'*'`
  // wildcard). The pair's metrics layer on top of the flat link defs.
  function pairFor(srcRole: string | undefined, dstRole: string | undefined): RolePairMetrics | null {
    if (roleToRole.length === 0) return null;
    const s = (srcRole ?? '').toLowerCase();
    const d = (dstRole ?? '').toLowerCase();
    const hit = (pat: string, v: string): boolean => pat === '*' || pat.toLowerCase() === v;
    const score = (p: RolePairMetrics): number => (p.from === '*' ? 0 : 1) + (p.to === '*' ? 0 : 1);
    let best: RolePairMetrics | null = null;
    let bestScore = -1;
    for (const p of roleToRole) {
      if (hit(p.from, s) && hit(p.to, d) && score(p) > bestScore) { best = p; bestScore = score(p); }
    }
    return best;
  }
  function edgeDefs(c: OapInstCall): { server: DeploymentMetricDef[]; client: DeploymentMetricDef[] } {
    const src = nodeById.get(c.source);
    const dst = nodeById.get(c.target);
    const pair = pairFor(src ? roleOf(src) : undefined, dst ? roleOf(dst) : undefined);
    const pm = pair?.metrics ?? [];
    return {
      server: dedupeById([...linkSrv, ...pm.filter((m) => m.role === 'lineServer')]),
      client: dedupeById([...linkCli, ...pm.filter((m) => m.role === 'lineClient')]),
    };
  }
  const candidateEdges = calls.filter((c) => {
    const a = nodeById.get(c.source);
    const b = nodeById.get(c.target);
    return !!a && !!b && !!a.name && !!b.name;
  });
  const edgeAliasMap = new Map<
    string,
    { callId: string; metric: DeploymentMetricDef; side: 'server' | 'client' }
  >();
  const edgeFragments: string[] = [];
  if (candidateEdges.length > 0 && (linkSrv.length > 0 || linkCli.length > 0 || roleToRole.length > 0)) {
    candidateEdges.forEach((c, i) => {
      const src = nodeById.get(c.source)!;
      const dst = nodeById.get(c.target)!;
      const { server, client } = edgeDefs(c);
      if (dst.isReal) {
        server.forEach((m, j) => {
          const alias = `s${i}_${j}`;
          edgeAliasMap.set(alias, { callId: c.id, metric: m, side: 'server' });
          edgeFragments.push(
            relationFragment(alias, m, entityServiceName, src.name, dst.name, serviceNormal, window, coldStage),
          );
        });
      }
      if (src.isReal) {
        client.forEach((m, j) => {
          const alias = `c${i}_${j}`;
          edgeAliasMap.set(alias, { callId: c.id, metric: m, side: 'client' });
          edgeFragments.push(
            relationFragment(alias, m, entityServiceName, src.name, dst.name, serviceNormal, window, coldStage),
          );
        });
      }
    });
  }

  // track failed metric chunks → surface "blank may be unavailable, not zero"
  const mstats = { failed: 0, total: 0 };
  const [nodeEnv, edgeEnv] = await Promise.all([
    fetchAliasedChunks<MqeShape>(opts, nodeFragments, perf.bulk.topology.nodeBulkSize, 'DeploymentNodeMetrics', perf.bulk.topology.concurrency, mstats),
    fetchAliasedChunks<MqeShape>(opts, edgeFragments, perf.bulk.topology.edgeBulkSize, 'DeploymentEdgeMetrics', perf.bulk.topology.concurrency, mstats),
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

  // ── Build response. Show EVERY container — both the ones in the call
  // graph (drawn with edges) and the edge-less ones (lifecycle sidecar, or
  // a node OAP hasn't yet linked). The graph view groups them by cluster /
  // pod regardless; hiding un-called nodes would drop the lifecycle
  // containers the moment any relation edge appears.
  const liveNodes: DeploymentNode[] = [];
  for (const n of nodes) {
    const m = nodeMetricVals.get(n.id) ?? {};
    const filled: Record<string, number | null> = {};
    for (const def of defsFor(n)) filled[def.id] = m[def.id] ?? null;
    liveNodes.push({
      id: n.id,
      name: n.name,
      serviceId: n.serviceId,
      serviceName: n.serviceName,
      isReal: n.isReal,
      metrics: filled,
      attributes: attrsFor(n),
      role: roleOf(n),
    });
  }
  const liveNodeIds = new Set(liveNodes.map((n) => n.id));
  const liveCalls: DeploymentCall[] = [];
  for (const c of calls) {
    if (!liveNodeIds.has(c.source) || !liveNodeIds.has(c.target)) continue;
    const sm = serverMetricVals.get(c.id) ?? {};
    const cm = clientMetricVals.get(c.id) ?? {};
    const ss = serverMetricSeries.get(c.id) ?? {};
    const cs = clientMetricSeries.get(c.id) ?? {};
    const { server: eServer, client: eClient } = edgeDefs(c);
    const filledSrv: Record<string, number | null> = {};
    const filledSrvSeries: Record<string, Array<number | null> | null> = {};
    for (const def of eServer) {
      filledSrv[def.id] = sm[def.id] ?? null;
      filledSrvSeries[def.id] = ss[def.id] ?? null;
    }
    const filledCli: Record<string, number | null> = {};
    const filledCliSeries: Record<string, Array<number | null> | null> = {};
    for (const def of eClient) {
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

  return {
    layer: layerKey,
    serviceId,
    serviceName,
    generatedAt: Date.now(),
    config: cfg,
    nodes: liveNodes,
    calls: liveCalls,
    reachable: true,
    ...(mstats.failed > 0 ? { metricsPartial: { failedChunks: mstats.failed, totalChunks: mstats.total } } : {}),
  } satisfies DeploymentResponse;
}
