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
 * Service-map builder — the fan-out shared by the per-layer Topology route
 * (`GET /api/layer/:key/topology`) and the AI assistant's `show_topology`
 * tool, so both draw the identical metric-carrying graph. The graph comes
 * from OAP's `getServicesTopology`, BFS-expanded to `depth`; per-node +
 * per-edge metrics are driven by the layer template's `topology` block. Never
 * throws: an OAP failure returns a well-formed `reachable:false` response so
 * neither caller needs a try/catch. Nodes/edges with no metric values are
 * kept only when still connected — a phantom stub never clutters the map.
 */

import type {
  TopologyCall,
  TopologyConfig,
  TopologyMetricDef,
  TopologyNode,
  TopologyResponse,
} from '@skywalking-horizon-ui/api-client';
import type { HorizonConfig } from '../../config/schema.js';
import type { GraphqlOptions } from '../../client/graphql.js';
import type { Window } from '../../util/window.js';
import { graphqlPost, fetchAliasedChunks } from '../../client/graphql.js';
import { type MqeShape, aggregateMqe, seriesFromMqe, nodeFragment, relationFragment } from './topology-mqe.js';

interface OapTopoNode {
  id: string;
  name: string;
  type: string | null;
  isReal: boolean;
  layers: string[];
}
interface OapTopoCall {
  id: string;
  source: string;
  target: string;
  detectPoints: string[];
}
interface ServicesTopologyResp {
  topology: { nodes: OapTopoNode[]; calls: OapTopoCall[] };
}

const SERVICES_TOPOLOGY = /* GraphQL */ `
  query ServicesTopology($duration: Duration!, $serviceIds: [ID!]!) {
    topology: getServicesTopology(duration: $duration, serviceIds: $serviceIds) {
      nodes { id name type isReal layers }
      calls { id source target detectPoints }
    }
  }
`;

const LIST_SERVICES_FOR_RESOLVE = /* GraphQL */ `
  query ListServicesForTopology($layer: String!) {
    services: listServices(layer: $layer) {
      id
      name
      normal
      group
    }
  }
`;

export function emptyTopologyResponse(
  layerKey: string,
  serviceArg: string | null,
  depth: number,
  cfg: TopologyConfig,
  reachable: boolean,
  err?: string,
): TopologyResponse {
  return {
    layer: layerKey,
    service: serviceArg,
    depth,
    generatedAt: Date.now(),
    config: cfg,
    nodes: [],
    calls: [],
    reachable,
    ...(err ? { error: err } : {}),
  };
}

// Legacy back-compat fields. Older callers read `cpm` / `respTime` /
// `sla` directly off the node — we still emit them so we don't churn
// every reader.
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
function legacyEdgeView(
  serverMetrics: Record<string, number | null>,
  clientMetrics: Record<string, number | null>,
): {
  serverCpm: number | null;
  serverRespTime: number | null;
  clientCpm: number | null;
  clientRespTime: number | null;
} {
  return {
    serverCpm: serverMetrics.cpm ?? null,
    serverRespTime: serverMetrics.respTime ?? null,
    clientCpm: clientMetrics.cpm ?? null,
    clientRespTime: clientMetrics.respTime ?? null,
  };
}

export interface BuildServiceTopologyInput {
  opts: GraphqlOptions;
  perf: HorizonConfig['performance'];
  window: Window;
  coldStage: boolean;
  /** The resolved (preview OR effective) topology config. */
  cfg: TopologyConfig;
  /** Layer key as the response should report it; upper-cased for the OAP query. */
  layerKey: string;
  /** Comma-separated service ids/names to seed; empty ⇒ the whole layer. */
  serviceArg: string;
  depth: number;
  /** Layer-overview only: scope the all-services seed to one Service.group. */
  group?: string;
}

export async function buildServiceTopology(input: BuildServiceTopologyInput): Promise<TopologyResponse> {
  const { opts, perf, window, coldStage, cfg: topoCfg, layerKey, serviceArg, depth, group } = input;
  const oapLayer = layerKey.toUpperCase();
  const durationVar = coldStage
    ? { start: window.start, end: window.end, step: window.step, coldStage: true }
    : { start: window.start, end: window.end, step: window.step };

  let seedIds: string[] = [];
  const knownServices = new Map<string, { id: string; name: string; normal: boolean }>();
  try {
    const data = await graphqlPost<{
      services: Array<{ id: string; name: string; normal?: boolean | null }>;
    }>(opts, LIST_SERVICES_FOR_RESOLVE, { layer: oapLayer });
    for (const s of data.services) {
      knownServices.set(s.id, { id: s.id, name: s.name, normal: s.normal !== false });
    }
    if (serviceArg) {
      // `service` accepts a comma-separated list of names/ids so
      // the SPA can multi-seed without a separate query param. Any
      // entry that doesn't resolve is reported back individually
      // instead of failing the whole request.
      const wants = serviceArg.split(',').map((s) => s.trim()).filter(Boolean);
      const matches = wants.map((w) =>
        data.services.find((s) => s.id === w) ??
        data.services.find((s) => s.name === w) ??
        null,
      );
      const missing = wants.filter((_, i) => matches[i] === null);
      if (matches.every((m) => m === null)) {
        return emptyTopologyResponse(layerKey, serviceArg, depth, topoCfg, true, `service${wants.length === 1 ? '' : 's'} not found: ${missing.join(', ')}`);
      }
      seedIds = matches.filter((m): m is { id: string; name: string; normal?: boolean | null } => m !== null).map((m) => m.id);
    } else {
      // Layer-overview topology — seed with EVERY service the layer
      // exposes. Booster-ui does the same: it computes the topology
      // off `selectorStore.services.map(d => d.id)`, no cap. The
      // earlier 30-service cap was leftover from a per-node MQE
      // batch-size worry, but the MQE step already chunks at 150
      // fragments per query (see below), so a layer with hundreds
      // of services scales fine.
      // `?group=` (split-by-service-group menu entry) scopes the
      // layer-overview seed to one OAP Service.group; absent ⇒ all.
      seedIds = data.services
        .filter((s) => group === undefined || ((s as { group?: string }).group ?? '') === group)
        .map((s) => s.id);
    }
  } catch (err) {
    return emptyTopologyResponse(layerKey, serviceArg || null, depth, topoCfg, false, err instanceof Error ? err.message : String(err));
  }

  // BFS-expand the seed services out to `depth` hops.
  const nodes = new Map<string, OapTopoNode>();
  const calls = new Map<string, OapTopoCall>();
  let frontier = seedIds.slice();
  const seen = new Set<string>(frontier);
  try {
    for (let d = 0; d < depth && frontier.length > 0; d++) {
      const data = await graphqlPost<ServicesTopologyResp>(opts, SERVICES_TOPOLOGY, {
        duration: durationVar,
        serviceIds: frontier,
      });
      for (const n of data.topology.nodes) {
        if (!nodes.has(n.id)) nodes.set(n.id, n);
      }
      for (const c of data.topology.calls) {
        if (!calls.has(c.id)) calls.set(c.id, c);
      }
      const next: string[] = [];
      for (const n of data.topology.nodes) {
        if (!seen.has(n.id)) {
          seen.add(n.id);
          if (n.isReal) next.push(n.id);
        }
      }
      frontier = next;
    }
  } catch (err) {
    return emptyTopologyResponse(layerKey, serviceArg || null, depth, topoCfg, false, err instanceof Error ? err.message : String(err));
  }

  // Reject-with-guidance instead of a partial graph: too large to draw
  // legibly + risks OOMing the browser. UI shows a narrow-scope hint.
  if (nodes.size > perf.limits.topologyMaxNodes || calls.size > perf.limits.topologyMaxEdges) {
    return {
      ...emptyTopologyResponse(layerKey, serviceArg, depth, topoCfg, true),
      tooLarge: { nodes: nodes.size, edges: calls.size },
    } satisfies TopologyResponse;
  }

  // ── Per-node MQE. Builds fragments off the layer's
  // `topology.nodeMetrics`. Synthetic nodes (User / external) are
  // skipped since OAP has no metrics for them.
  const realNodes = [...nodes.values()].filter((n) => n.isReal);
  const nodeMetricVals = new Map<string, Record<string, number | null>>();
  const serverMetricVals = new Map<string, Record<string, number | null>>();
  const clientMetricVals = new Map<string, Record<string, number | null>>();
  // Per-edge time series for the right-sidebar line charts.
  const serverMetricSeries = new Map<string, Record<string, Array<number | null> | null>>();
  const clientMetricSeries = new Map<string, Record<string, Array<number | null> | null>>();

  // Build the per-node and per-edge MQE fragments, then fan BOTH families
  // out concurrently: they query disjoint OAP entities (node metrics vs
  // service-relation metrics) and fill disjoint result maps, so there's no
  // reason to await one before the other. Each family chunks internally and
  // soft-fails per chunk, keeping the graph with null metrics on a hiccup.
  const nodeAliasMap = new Map<string, { nodeId: string; metric: TopologyMetricDef }>();
  const nodeFragments: string[] = [];
  if (realNodes.length > 0 && topoCfg.nodeMetrics.length > 0) {
    realNodes.forEach((n, i) => {
      const meta = knownServices.get(n.id);
      const normal = meta?.normal ?? true;
      topoCfg.nodeMetrics.forEach((m, j) => {
        const alias = `n${i}_${j}`;
        nodeAliasMap.set(alias, { nodeId: n.id, metric: m });
        nodeFragments.push(nodeFragment(alias, m, n.name, normal, window, coldStage));
      });
    });
  }

  // ── Per-edge MQE. Only real → real edges have a relation entity
  // in OAP. We split into server / client families and fan both out
  // concurrently in chunked aliased queries (see the Promise.all below).
  //   - server metrics need a real DEST (the callee that records
  //     the incoming call) — `User → consumer` works on the
  //     server side, `provider → localhost:-1` does not.
  //   - client metrics need a real SOURCE — `provider → external`
  //     works on the client side, `User → consumer` does not.
  // Filtering edges per-side keeps OAP from rejecting queries that
  // would never have data and avoids empty result rows.
  const candidateEdges = [...calls.values()].filter((c) => {
    const a = nodes.get(c.source);
    const b = nodes.get(c.target);
    return !!a && !!b && !!a.name && !!b.name;
  });
  const linkSrv = topoCfg.linkServerMetrics ?? [];
  const linkCli = topoCfg.linkClientMetrics ?? [];
  const edgeAliasMap = new Map<
    string,
    { callId: string; metric: TopologyMetricDef; side: 'server' | 'client' }
  >();
  const edgeFragments: string[] = [];
  if (candidateEdges.length > 0 && (linkSrv.length > 0 || linkCli.length > 0)) {
    candidateEdges.forEach((c, i) => {
      const src = nodes.get(c.source)!;
      const dst = nodes.get(c.target)!;
      const srcMeta = knownServices.get(src.id);
      const dstMeta = knownServices.get(dst.id);
      // Booster's hook resolves `normal = node.normal || node.isReal`.
      // `listServices.normal` (when known) wins; otherwise we fall
      // back to the graph node's `isReal`.
      const srcNormal = srcMeta?.normal ?? src.isReal;
      const dstNormal = dstMeta?.normal ?? dst.isReal;
      // Server metrics live on the DEST — fetch only when the dest is real.
      if (dst.isReal) {
        linkSrv.forEach((m, j) => {
          const alias = `s${i}_${j}`;
          edgeAliasMap.set(alias, { callId: c.id, metric: m, side: 'server' });
          edgeFragments.push(relationFragment(alias, m, src.name, srcNormal, dst.name, dstNormal, window, coldStage));
        });
      }
      // Client metrics live on the SOURCE — fetch only when the source is real.
      if (src.isReal) {
        linkCli.forEach((m, j) => {
          const alias = `c${i}_${j}`;
          edgeAliasMap.set(alias, { callId: c.id, metric: m, side: 'client' });
          edgeFragments.push(relationFragment(alias, m, src.name, srcNormal, dst.name, dstNormal, window, coldStage));
        });
      }
    });
  }

  // Accumulate failed metric chunks so the response can flag "blank =
  // unavailable, not zero" rather than letting an OAP 5xx read as no-traffic.
  const mstats = { failed: 0, total: 0 };
  const [nodeEnv, edgeEnv] = await Promise.all([
    fetchAliasedChunks<MqeShape>(opts, nodeFragments, perf.bulk.topology.nodeBulkSize, 'NodeMetrics', perf.bulk.topology.concurrency, mstats),
    fetchAliasedChunks<MqeShape>(opts, edgeFragments, perf.bulk.topology.edgeBulkSize, 'EdgeMetrics', perf.bulk.topology.concurrency, mstats),
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
    const seriesBucket = info.side === 'server' ? serverMetricSeries : clientMetricSeries;
    const valBucket = info.side === 'server' ? serverMetricVals : clientMetricVals;
    const valRec = valBucket.get(info.callId) ?? {};
    valRec[info.metric.id] = v;
    valBucket.set(info.callId, valRec);
    const sRec = seriesBucket.get(info.callId) ?? {};
    sRec[info.metric.id] = seriesFromMqe(shape);
    seriesBucket.set(info.callId, sRec);
  }

  // ── Build response. Connected nodes only — a service with zero
  // edges in the duration window doesn't belong on the topology
  // map; it's a "service" not a "topology participant". The canvas
  // only renders nodes that are endpoints of at least one call
  // edge. We keep idle-but-still-connected nodes (their metrics may
  // be null on the windowed sample, but they still take part in
  // the topology graph). Same rule booster-ui's Service Mesh and
  // Kubernetes topology pages use.
  const connectedNodeIds = new Set<string>();
  for (const c of calls.values()) {
    connectedNodeIds.add(c.source);
    connectedNodeIds.add(c.target);
  }
  const liveNodes: TopologyNode[] = [];
  for (const n of nodes.values()) {
    if (!connectedNodeIds.has(n.id)) continue;
    const m = nodeMetricVals.get(n.id) ?? {};
    // Pad with explicit nulls so every metric id is present in the
    // wire shape — UI binds by id, an absent key would look the
    // same as `null` but with worse iteration ergonomics.
    const filled: Record<string, number | null> = {};
    for (const def of topoCfg.nodeMetrics) {
      filled[def.id] = m[def.id] ?? null;
    }
    liveNodes.push({
      id: n.id,
      name: n.name,
      type: n.type,
      isReal: n.isReal,
      layers: n.layers ?? [],
      metrics: filled,
      ...legacyNodeView(filled),
    });
  }
  // Re-prune edges whose endpoint(s) were dropped.
  const liveNodeIds = new Set(liveNodes.map((n) => n.id));
  const liveCalls: TopologyCall[] = [];
  for (const c of calls.values()) {
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
      ...legacyEdgeView(filledSrv, filledCli),
    });
  }

  return {
    layer: layerKey,
    service: serviceArg || null,
    depth,
    generatedAt: Date.now(),
    config: topoCfg,
    nodes: liveNodes,
    calls: liveCalls,
    reachable: true,
    ...(mstats.failed > 0
      ? { metricsPartial: { failedChunks: mstats.failed, totalChunks: mstats.total } }
      : {}),
  } satisfies TopologyResponse;
}
