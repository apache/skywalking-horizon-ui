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
 * `GET /api/layer/:key/topology?service=<id|name>&depth=<1-3>`
 *
 * Service-map feed for the per-layer Topology tab.
 *
 *  - The graph itself comes from OAP's `getServicesTopology(serviceIds,
 *    duration)`, expanded BFS to `depth`.
 *  - Per-node + per-edge metrics are driven by the LAYER TEMPLATE's
 *    `topology` block (see `apps/bff/src/layers/loader.ts`). The MQE
 *    expressions, units, labels, and visual-role bindings live there;
 *    this route is a thin executor that builds aliased fragments and
 *    folds the OAP response back into `metrics: Record<id, value>`.
 *
 * Nodes / edges that come back with NO metric values are dropped from
 * the response — operators don't want phantom services cluttering the
 * graph just because OAP returned a stub row.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ConfigSource } from '../../config/loader.js';
import type { SessionStore } from '../../user/sessions.js';
import type {
  FetchLike,
  TopologyCall,
  TopologyConfig,
  TopologyMetricDef,
  TopologyNode,
  TopologyResponse,
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
  type Window,
} from '../../util/window.js';
import { topologyConfigFor } from '../../logic/layers/loader.js';
import { resolveEffectiveLayer } from '../../logic/layers/effective.js';
import { parsePreviewTopology } from '../../logic/layers/preview.js';
import { getServiceHierarchy } from '../../logic/oap/hierarchy.js';

export interface TopologyRouteDeps {
  config: ConfigSource;
  sessions: SessionStore;
  fetch?: FetchLike;
  /** OAP UI-template client — lets the route serve the in-use
   *  (remote-or-bundled) topology config, matching the admin + sidebar. */
  uiTemplateClient?: () => UITemplateClient;
}

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

const DEFAULT_WINDOW_MIN = 60;

interface MqeValueRow {
  value: string | number | null;
}
interface MqeResult {
  values?: MqeValueRow[];
}
export interface MqeShape {
  type?: string;
  error?: string | null;
  results?: MqeResult[];
}

function nodeFragment(
  alias: string,
  m: TopologyMetricDef,
  serviceName: string,
  normal: boolean,
  w: Window,
  coldStage: boolean,
): string {
  const coldFrag = coldStage ? ', coldStage: true' : '';
  return (
    `${alias}: execExpression(\n` +
    `      expression: ${JSON.stringify(m.mqe)},\n` +
    `      entity: { scope: Service, serviceName: ${JSON.stringify(serviceName)},` +
    ` normal: ${normal ? 'true' : 'false'} },\n` +
    `      duration: { start: ${JSON.stringify(w.start)}, end: ${JSON.stringify(w.end)}, step: ${w.step}${coldFrag} }\n` +
    `    ) { type error results { values { value } } }`
  );
}

/**
 * ServiceRelation entity fragment. Booster-ui's hooks build the same
 * shape — notice we do NOT set `scope` here. OAP infers scope from
 * the MQE metric name (`service_relation_server_*` → ServiceRelation
 * server, `service_relation_client_*` → ServiceRelation client),
 * and forcing the scope explicitly empties the result on some OAP
 * versions. Booster's hook fills `sourceNormal` / `destNormal` from
 * `isReal || normal`, so we accept that pre-resolved value verbatim
 * (route handler picks the right thing per node).
 */
function relationFragment(
  alias: string,
  m: TopologyMetricDef,
  sourceName: string,
  sourceNormal: boolean,
  destName: string,
  destNormal: boolean,
  w: Window,
  coldStage: boolean,
): string {
  const coldFrag = coldStage ? ', coldStage: true' : '';
  return (
    `${alias}: execExpression(\n` +
    `      expression: ${JSON.stringify(m.mqe)},\n` +
    `      entity: {` +
    ` serviceName: ${JSON.stringify(sourceName)},` +
    ` normal: ${sourceNormal ? 'true' : 'false'},` +
    ` destServiceName: ${JSON.stringify(destName)},` +
    ` destNormal: ${destNormal ? 'true' : 'false'} },\n` +
    `      duration: { start: ${JSON.stringify(w.start)}, end: ${JSON.stringify(w.end)}, step: ${w.step}${coldFrag} }\n` +
    `    ) { type error results { values { value } } }`
  );
}

export function aggregateMqe(env: MqeShape | undefined, kind: 'avg' | 'sum'): number | null {
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

/**
 * Series extractor — same MQE response, returns the per-bucket values
 * as a `(number | null)[]`. Used for the edge detail panel's twin
 * sparkline chart (client | server) so the operator sees the trend
 * shape over the duration window rather than a single scalar.
 */
export function seriesFromMqe(env: MqeShape | undefined): Array<number | null> | null {
  if (!env || env.error) return null;
  const values = env.results?.[0]?.values ?? [];
  if (values.length === 0) return null;
  return values.map((v) => {
    if (v.value === null || v.value === undefined) return null;
    const n = Number(v.value);
    return Number.isFinite(n) ? n : null;
  });
}

function emptyResponse(
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

export function registerTopologyRoute(app: FastifyInstance, deps: TopologyRouteDeps): void {
  const auth = requireAuth(deps);
  app.get(
    '/api/layer/:key/topology',
    { preHandler: auth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const params = req.params as { key: string };
      const layerKey = params.key;
      if (!layerKey || !/^[a-z0-9_]+$/i.test(layerKey)) {
        return reply.code(400).send({ error: 'invalid_layer_key' });
      }
      const q = req.query as {
        service?: string;
        depth?: string;
        step?: string;
        startMs?: string;
        endMs?: string;
        previewConfig?: string;
      };
      const serviceArg = (q.service ?? '').trim();
      const depth = Math.max(1, Math.min(3, Number(q.depth) || 1));

      // Admin "Preview" mode: the page forwards the operator's unpublished
      // draft `topology` block so we render it against live OAP without
      // publishing first. When present + valid it wins outright — the
      // remote-resolved config and its block/disabled gate don't apply to
      // a draft the operator is actively editing.
      const previewCfg = parsePreviewTopology(q.previewConfig);
      let topoCfg: TopologyConfig;
      if (previewCfg) {
        topoCfg = previewCfg;
      } else {
        const eff = await resolveEffectiveLayer(deps.uiTemplateClient, layerKey);
        if (eff.blocked) {
          // Template store unreachable or this layer's template disabled —
          // block: serve no map and no in-code default config. The SPA's
          // connectivity banner explains the empty state (unreachable); a
          // disabled layer is hidden from the sidebar so it isn't reached.
          return reply.send(
            emptyResponse(layerKey, serviceArg, depth, { nodeMetrics: [], linkServerMetrics: [], linkClientMetrics: [] }, true),
          );
        }
        topoCfg = topologyConfigFor(eff.template);
      }

      const cfgCurrent = deps.config.current;
      const opts = buildOapOpts(cfgCurrent, deps.fetch);
      const offset = await getServerOffsetMinutes(deps.config, deps.fetch);
      // Honor the SPA's topbar time picker when all three triplet
      // query-params are present; otherwise fall back to the last-hour
      // MINUTE window. The Overview "topology" widget + per-layer
      // service map both forward the picker so the topology metrics
      // line up with whatever window the operator is looking at.
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

      // ── Resolve seed service ids.
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
            return reply.send(
              emptyResponse(layerKey, serviceArg, depth, topoCfg, true, `service${wants.length === 1 ? '' : 's'} not found: ${missing.join(', ')}`),
            );
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
          const group = (req.query as { group?: string }).group;
          seedIds = data.services
            .filter((s) => group === undefined || ((s as { group?: string }).group ?? '') === group)
            .map((s) => s.id);
        }
      } catch (err) {
        return reply.send(
          emptyResponse(
            layerKey,
            serviceArg || null,
            depth,
            topoCfg,
            false,
            err instanceof Error ? err.message : String(err),
          ),
        );
      }

      // ── BFS expand topology.
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
        return reply.send(
          emptyResponse(
            layerKey,
            serviceArg || null,
            depth,
            topoCfg,
            false,
            err instanceof Error ? err.message : String(err),
          ),
        );
      }

      // (Disconnected services are dropped a few lines below — they
      // don't belong on a topology map. The earlier "fill them in as
      // standalone nodes" pass was reverted after a closer look at
      // booster-ui's demo, which only renders connected nodes too.)

      // ── Per-node MQE. Builds fragments off the layer's
      // `topology.nodeMetrics`. Synthetic nodes (User / external) are
      // skipped since OAP has no metrics for them.
      const realNodes = [...nodes.values()].filter((n) => n.isReal);
      const nodeMetricVals = new Map<string, Record<string, number | null>>();
      if (realNodes.length > 0 && topoCfg.nodeMetrics.length > 0) {
        const fragments: string[] = [];
        const aliasMap = new Map<string, { nodeId: string; metric: TopologyMetricDef }>();
        realNodes.forEach((n, i) => {
          const meta = knownServices.get(n.id);
          const normal = meta?.normal ?? true;
          topoCfg.nodeMetrics.forEach((m, j) => {
            const alias = `n${i}_${j}`;
            aliasMap.set(alias, { nodeId: n.id, metric: m });
            fragments.push(nodeFragment(alias, m, n.name, normal, window, coldStage));
          });
        });
        const CHUNK = 150;
        for (let i = 0; i < fragments.length; i += CHUNK) {
          const slice = fragments.slice(i, i + CHUNK);
          const query = `query NodeMetrics {\n  ${slice.join('\n  ')}\n}`;
          let env: Record<string, MqeShape>;
          try {
            env = await graphqlPost<Record<string, MqeShape>>(opts, query);
          } catch {
            // Soft-fail per operator direction: keep the graph and
            // emit null metrics rather than wiping the response.
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

      // ── Per-edge MQE. Only real → real edges have a relation entity
      // in OAP. We split into server / client families and fan out in a
      // single combined aliased query.
      const serverMetricVals = new Map<string, Record<string, number | null>>();
      const clientMetricVals = new Map<string, Record<string, number | null>>();
      // Per-edge time series for the right-sidebar line charts.
      const serverMetricSeries = new Map<string, Record<string, Array<number | null> | null>>();
      const clientMetricSeries = new Map<string, Record<string, Array<number | null> | null>>();
      // Per booster: an edge with at least one named endpoint is
      // queryable. We split per side:
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
      if (candidateEdges.length > 0 && (linkSrv.length > 0 || linkCli.length > 0)) {
        const fragments: string[] = [];
        const aliasMap = new Map<
          string,
          { callId: string; metric: TopologyMetricDef; side: 'server' | 'client' }
        >();
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
          // Server metrics live on the DEST — fetch only when the dest
          // is real. Otherwise OAP returns nothing for the server
          // family and we'd waste the round trip.
          if (dst.isReal) {
            linkSrv.forEach((m, j) => {
              const alias = `s${i}_${j}`;
              aliasMap.set(alias, { callId: c.id, metric: m, side: 'server' });
              fragments.push(relationFragment(alias, m, src.name, srcNormal, dst.name, dstNormal, window, coldStage));
            });
          }
          // Client metrics live on the SOURCE — fetch only when the
          // source is real.
          if (src.isReal) {
            linkCli.forEach((m, j) => {
              const alias = `c${i}_${j}`;
              aliasMap.set(alias, { callId: c.id, metric: m, side: 'client' });
              fragments.push(relationFragment(alias, m, src.name, srcNormal, dst.name, dstNormal, window, coldStage));
            });
          }
        });
        const CHUNK = 200;
        for (let i = 0; i < fragments.length; i += CHUNK) {
          const slice = fragments.slice(i, i + CHUNK);
          const query = `query EdgeMetrics {\n  ${slice.join('\n  ')}\n}`;
          let env: Record<string, MqeShape>;
          try {
            env = await graphqlPost<Record<string, MqeShape>>(opts, query);
          } catch {
            // Soft-fail: keep the graph with null edge metrics.
            break;
          }
          for (const [alias, shape] of Object.entries(env)) {
            const info = aliasMap.get(alias);
            if (!info) continue;
            const v = aggregateMqe(shape, info.metric.aggregation ?? 'avg');
            const seriesBucket =
              info.side === 'server' ? serverMetricSeries : clientMetricSeries;
            const valBucket =
              info.side === 'server' ? serverMetricVals : clientMetricVals;
            const valRec = valBucket.get(info.callId) ?? {};
            valRec[info.metric.id] = v;
            valBucket.set(info.callId, valRec);
            const sRec = seriesBucket.get(info.callId) ?? {};
            sRec[info.metric.id] = seriesFromMqe(shape);
            seriesBucket.set(info.callId, sRec);
          }
        }
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

      return reply.send({
        layer: layerKey,
        service: serviceArg || null,
        depth,
        generatedAt: Date.now(),
        config: topoCfg,
        nodes: liveNodes,
        calls: liveCalls,
        reachable: true,
      } satisfies TopologyResponse);
    },
  );

  // ── Service hierarchy probe — Smartscape overlay on the service map.
  //
  // The UI calls this lazily on node-select (one round-trip per selected
  // node) to decide whether to render the "expand hierarchy" chip and to
  // populate the focus+context+suggestions overlay when the operator
  // opens it. Not used by the overview topology widget (intentionally
  // non-interactive there).
  app.get(
    '/api/layer/:key/service-hierarchy',
    { preHandler: auth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const params = req.params as { key: string };
      const layerKey = params.key;
      if (!layerKey || !/^[a-z0-9_]+$/i.test(layerKey)) {
        return reply.code(400).send({ error: 'invalid_layer_key' });
      }
      const q = req.query as { service?: string };
      const serviceId = (q.service ?? '').trim();
      if (!serviceId) {
        return reply.code(400).send({ error: 'missing_service' });
      }
      const result = await getServiceHierarchy(
        deps.config.current,
        serviceId,
        layerKey,
        deps.fetch,
      );
      return reply.send(result);
    },
  );
}
