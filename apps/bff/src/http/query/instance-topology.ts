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
 * `GET /api/layer/:key/instance-topology?client=<svcId>&server=<svcId>`
 *
 * Instance-to-instance topology drill-down for one service→service edge,
 * opened from the per-layer service map. The graph comes from OAP's
 * `getServiceInstanceTopology(clientServiceId, serverServiceId,
 * duration)` — nodes are the instances of the two services, calls are
 * the instance-level dependencies between them.
 *
 *  - Per-node MQE evaluates under `{ scope: ServiceInstance }`.
 *  - Per-edge MQE evaluates under ServiceInstanceRelation, split into a
 *    server family + a client family. Same per-side rule as the service
 *    map: fetch server metrics only when the DEST instance is real,
 *    client metrics only when the SOURCE instance is real — OAP returns
 *    nothing for the missing side otherwise.
 *
 * The metric set is the LAYER TEMPLATE's `topology.instanceTopology`
 * block. When a layer doesn't define one the route 404s — the service
 * map only offers the drill-down for layers that echo the config, so a
 * direct hit on an unconfigured layer is the only way to reach this.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ConfigSource } from '../../config/loader.js';
import type { SessionStore } from '../../user/sessions.js';
import type {
  FetchLike,
  InstanceTopologyCall,
  InstanceTopologyConfig,
  InstanceTopologyNode,
  InstanceTopologyResponse,
  TopologyMetricDef,
  UITemplateClient,
} from '@skywalking-horizon-ui/api-client';
import { requireAuth } from '../../user/middleware.js';
import { graphqlPost, buildOapOpts } from '../../client/graphql.js';
import { withColdStage } from '../../util/duration.js';
import {
  defaultMinuteWindow,
  getServerOffsetMinutes,
  windowFromRange,
  type TimeStep,
  type Window,
} from '../../util/window.js';
import { instanceTopologyConfigFor } from '../../logic/layers/loader.js';
import { resolveEffectiveLayer } from '../../logic/layers/effective.js';
import { parsePreviewTopology } from '../../logic/layers/preview.js';
import { aggregateMqe, seriesFromMqe, type MqeShape } from './topology.js';

export interface InstanceTopologyRouteDeps {
  config: ConfigSource;
  sessions: SessionStore;
  fetch?: FetchLike;
  /** OAP UI-template client — lets the route serve the in-use
   *  (remote-or-bundled) topology config, matching the admin + sidebar. */
  uiTemplateClient?: () => UITemplateClient;
}

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

const DEFAULT_WINDOW_MIN = 60;

/** Per-instance fragment under `{ scope: ServiceInstance }`. */
function nodeFragment(
  alias: string,
  m: TopologyMetricDef,
  serviceName: string,
  instanceName: string,
  normal: boolean,
  w: Window,
  coldStage: boolean,
): string {
  const coldFrag = coldStage ? ', coldStage: true' : '';
  return (
    `${alias}: execExpression(\n` +
    `      expression: ${JSON.stringify(m.mqe)},\n` +
    `      entity: { scope: ServiceInstance, serviceName: ${JSON.stringify(serviceName)},` +
    ` normal: ${normal ? 'true' : 'false'}, serviceInstanceName: ${JSON.stringify(instanceName)} },\n` +
    `      duration: { start: ${JSON.stringify(w.start)}, end: ${JSON.stringify(w.end)}, step: ${w.step}${coldFrag} }\n` +
    `    ) { type error results { values { value } } }`
  );
}

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

function emptyResponse(
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

export function registerInstanceTopologyRoute(
  app: FastifyInstance,
  deps: InstanceTopologyRouteDeps,
): void {
  const auth = requireAuth(deps);
  app.get(
    '/api/layer/:key/instance-topology',
    { preHandler: auth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const params = req.params as { key: string };
      const layerKey = params.key;
      if (!layerKey || !/^[a-z0-9_]+$/i.test(layerKey)) {
        return reply.code(400).send({ error: 'invalid_layer_key' });
      }
      const q = req.query as {
        client?: string;
        server?: string;
        step?: string;
        startMs?: string;
        endMs?: string;
        previewConfig?: string;
      };
      const clientServiceId = (q.client ?? '').trim();
      const serverServiceId = (q.server ?? '').trim();
      if (!clientServiceId || !serverServiceId) {
        return reply.code(400).send({ error: 'missing_service_ids' });
      }

      // Admin Preview: the page forwards the draft `topology` block; the
      // instance map reads its nested `instanceTopology`. When previewing,
      // that draft decides support (404 if the draft has no instance map),
      // bypassing the remote template entirely.
      const previewTopo = parsePreviewTopology(q.previewConfig);
      let instCfg: InstanceTopologyConfig | null;
      if (previewTopo) {
        instCfg = previewTopo.instanceTopology ?? null;
      } else {
        const eff = await resolveEffectiveLayer(deps.uiTemplateClient, layerKey);
        if (eff.blocked) {
          // Template store unreachable (or this layer's template disabled)
          // — block, the same way the service-topology route does, instead
          // of collapsing to a misleading "not supported" 404. Serve an
          // empty unreachable response so the SPA's connectivity banner
          // explains the empty state.
          return reply.send(
            emptyResponse(
              layerKey,
              clientServiceId,
              serverServiceId,
              { nodeMetrics: [], linkServerMetrics: [], linkClientMetrics: [] },
              false,
            ),
          );
        }
        instCfg = instanceTopologyConfigFor(eff.template);
      }
      if (!instCfg) {
        return reply.code(404).send({ error: 'instance_topology_not_supported' });
      }

      const cfgCurrent = deps.config.current;
      const opts = buildOapOpts(cfgCurrent, deps.fetch);
      const offset = await getServerOffsetMinutes(deps.config, deps.fetch);
      // Honor the SPA's topbar picker triplet; else fall back to the
      // last-hour MINUTE window (dashboards family — minute precision).
      const stepArg = (q.step ?? '').toUpperCase() as TimeStep;
      const startMs = Number(q.startMs);
      const endMs = Number(q.endMs);
      const window: Window =
        (stepArg === 'MINUTE' || stepArg === 'HOUR' || stepArg === 'DAY') &&
        Number.isFinite(startMs) &&
        Number.isFinite(endMs)
          ? windowFromRange(stepArg, startMs, endMs, offset) ??
            defaultMinuteWindow(offset, DEFAULT_WINDOW_MIN)
          : defaultMinuteWindow(offset, DEFAULT_WINDOW_MIN);
      const oapLayer = layerKey.toUpperCase();
      const durationVar = withColdStage(req, { start: window.start, end: window.end, step: window.step });
      const coldStage = !!req.coldStage;

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
        return reply.send(
          emptyResponse(layerKey, clientServiceId, serverServiceId, instCfg, false,
            err instanceof Error ? err.message : String(err)),
        );
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
        return reply.send(
          emptyResponse(layerKey, clientServiceId, serverServiceId, instCfg, false,
            err instanceof Error ? err.message : String(err)),
        );
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

      // ── Per-node MQE.
      const nodeMetricVals = new Map<string, Record<string, number | null>>();
      const realNodes = nodes.filter((n) => n.isReal);
      if (realNodes.length > 0 && instCfg.nodeMetrics.length > 0) {
        const fragments: string[] = [];
        const aliasMap = new Map<string, { nodeId: string; metric: TopologyMetricDef }>();
        realNodes.forEach((n, i) => {
          instCfg.nodeMetrics.forEach((m, j) => {
            const alias = `n${i}_${j}`;
            aliasMap.set(alias, { nodeId: n.id, metric: m });
            fragments.push(nodeFragment(alias, m, n.serviceName, n.name, normalFor(n), window, coldStage));
          });
        });
        const CHUNK = 150;
        for (let i = 0; i < fragments.length; i += CHUNK) {
          const slice = fragments.slice(i, i + CHUNK);
          const query = `query InstanceNodeMetrics {\n  ${slice.join('\n  ')}\n}`;
          let env: Record<string, MqeShape>;
          try {
            env = await graphqlPost<Record<string, MqeShape>>(opts, query);
          } catch {
            break; // soft-fail: keep the graph with null node metrics
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

      // ── Per-edge MQE (server + client families, per-side gate).
      const serverMetricVals = new Map<string, Record<string, number | null>>();
      const clientMetricVals = new Map<string, Record<string, number | null>>();
      const serverMetricSeries = new Map<string, Record<string, Array<number | null> | null>>();
      const clientMetricSeries = new Map<string, Record<string, Array<number | null> | null>>();
      const linkSrv = instCfg.linkServerMetrics ?? [];
      const linkCli = instCfg.linkClientMetrics ?? [];
      const candidateEdges = calls.filter((c) => {
        const a = nodeById.get(c.source);
        const b = nodeById.get(c.target);
        return !!a && !!b && !!a.name && !!b.name;
      });
      if (candidateEdges.length > 0 && (linkSrv.length > 0 || linkCli.length > 0)) {
        const fragments: string[] = [];
        const aliasMap = new Map<
          string,
          { callId: string; metric: TopologyMetricDef; side: 'server' | 'client' }
        >();
        candidateEdges.forEach((c, i) => {
          const src = nodeById.get(c.source)!;
          const dst = nodeById.get(c.target)!;
          const srcNormal = normalFor(src);
          const dstNormal = normalFor(dst);
          if (dst.isReal) {
            linkSrv.forEach((m, j) => {
              const alias = `s${i}_${j}`;
              aliasMap.set(alias, { callId: c.id, metric: m, side: 'server' });
              fragments.push(
                relationFragment(alias, m, src.serviceName, src.name, srcNormal, dst.serviceName, dst.name, dstNormal, window, coldStage),
              );
            });
          }
          if (src.isReal) {
            linkCli.forEach((m, j) => {
              const alias = `c${i}_${j}`;
              aliasMap.set(alias, { callId: c.id, metric: m, side: 'client' });
              fragments.push(
                relationFragment(alias, m, src.serviceName, src.name, srcNormal, dst.serviceName, dst.name, dstNormal, window, coldStage),
              );
            });
          }
        });
        const CHUNK = 200;
        for (let i = 0; i < fragments.length; i += CHUNK) {
          const slice = fragments.slice(i, i + CHUNK);
          const query = `query InstanceEdgeMetrics {\n  ${slice.join('\n  ')}\n}`;
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
            const valBucket = info.side === 'server' ? serverMetricVals : clientMetricVals;
            const seriesBucket = info.side === 'server' ? serverMetricSeries : clientMetricSeries;
            const valRec = valBucket.get(info.callId) ?? {};
            valRec[info.metric.id] = v;
            valBucket.set(info.callId, valRec);
            const sRec = seriesBucket.get(info.callId) ?? {};
            sRec[info.metric.id] = seriesFromMqe(shape);
            seriesBucket.set(info.callId, sRec);
          }
        }
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

      return reply.send({
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
      } satisfies InstanceTopologyResponse);
    },
  );
}
