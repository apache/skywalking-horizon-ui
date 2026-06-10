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
 * The 3D infra map's topology model (`MapTopology`) + the `buildSceneGraph`
 * pass that turns it into the renderable `SceneGraph`. The model is the same
 * whether assembled live from OAP (see `useLiveTopology`) or read from the
 * committed fallback snapshot via `loadFallbackTopology()` — layers, services
 * per layer, cross-layer hierarchy peers, and per-layer service maps.
 *
 * `loadFallbackTopology()` reads `data/fallback-topology.json` (a snapshot of
 * the showcase deployment) — rendered until the first live load lands and as
 * the offline fallback when OAP is unreachable.
 */

import fallbackJson from '../data/fallback-topology.json';

export interface MapLayer {
  key: string;
  name: string;
  level: number | null;
  group: string | null;
  serviceCount: number;
  color: string | null;
}
export interface MapServiceRef {
  id: string;
  name: string;
  normal: boolean;
}
export interface MapHierarchyPeer {
  layer: string;
  services: Array<{ id: string; name: string; normal: boolean; role: string }>;
}
export interface MapHierarchyEntry {
  fromLayer: string;
  fromService: MapServiceRef;
  peers: MapHierarchyPeer[];
}
export interface MapTopologyCall {
  source: string;
  target: string;
  detectPoints: string[];
}
export interface MapLayerTopology {
  nodes: Array<{ id: string; name: string; layer: string }>;
  calls: MapTopologyCall[];
}

export interface MapTopology {
  capturedAt: string;
  source: string;
  layers: MapLayer[];
  servicesByLayer: Record<string, MapServiceRef[]>;
  hierarchy: MapHierarchyEntry[];
  /** Per-layer service-map snapshot. Only layers whose template carries
   *  a topology component populate this (general / mesh / k8s_service in
   *  the showcase demo). */
  topologies: Record<string, MapLayerTopology>;
}

/** Level id from the admin config (`apps` / `mesh` / `middleware` /
 *  `infra` by default — admins can rename, reorder, or add).
 *
 *  Historical alias `PlaneId` kept so callers don't all rename at once;
 *  semantically it's just a level-id string. */
export type PlaneId = string;

/** Resolver function: layer key → level id. Wired to
 *  `useInfra3dConfig().levelForLayer` at the Scene's setup edge so the
 *  build-graph pass stays synchronous (we gate scene mount on config
 *  being loaded before any of this runs). */
export type LevelResolver = (layerKey: string) => string;

/** Legacy three-plane fallback — only used when no resolver is passed
 *  (early page mount before the composable resolves; tests / fixtures).
 *  The config-driven path supersedes it as soon as the admin config
 *  loads. Same mental model as before: apps tier, mesh tier, everything
 *  else lands in `middleware` (NOT `infra`, since the dominant non-mesh
 *  layers — DB / MQ / SO11Y — are middleware, not platform). */
export function planeForLayer(layerKey: string, resolver?: LevelResolver): PlaneId {
  if (resolver) return resolver(layerKey);
  const k = layerKey.toLowerCase();
  if (
    k === 'mesh' ||
    k === 'mesh_cp' ||
    k === 'mesh_dp' ||
    k === 'cilium_service' ||
    k.startsWith('envoy_')
  ) {
    return 'mesh';
  }
  if (
    k === 'general' ||
    k === 'browser' ||
    k === 'ios' ||
    k.endsWith('_mini_program') ||
    k.startsWith('virtual_') ||
    k.startsWith('so11y_')
  ) {
    return 'apps';
  }
  if (k === 'k8s' || k === 'k8s_service' || k.startsWith('os_') || k === 'virtual_machine' || k === 'aws_eks') {
    return 'infra';
  }
  return 'middleware';
}

export interface SceneServiceNode {
  nodeId: string;
  layerKey: string;
  serviceId: string;
  name: string;
  shortName: string;
  normal: boolean;
}

export interface SceneHierarchyEdge {
  fromNodeId: string;
  toNodeId: string;
}

/** Intra-layer call edge — both endpoints belong to the same layer. */
export interface SceneCallEdge {
  fromNodeId: string;
  toNodeId: string;
  /** OAP detection point: CLIENT-only means the target is detected by
   *  the source side (often external); CLIENT+SERVER means both ends
   *  are instrumented. Used to dim half-instrumented edges. */
  detectPoints: string[];
}

/** Cross-layer call edge — source and target sit in DIFFERENT layers,
 *  whether on the same plane (e.g. BROWSER → GENERAL, both apps-tier)
 *  or different planes (e.g. GENERAL → VIRTUAL_DATABASE). Drawn as a
 *  separate render class (amber + arrow head) so the operator reads
 *  "this call leaves the layer" at a glance. The curve is arched only
 *  when the endpoints sit on different planes; same-plane cross-layer
 *  edges hug the plane to avoid wasted vertical motion. */
export interface SceneCrossLayerEdge {
  fromNodeId: string;
  toNodeId: string;
  fromLayer: string;
  toLayer: string;
  detectPoints: string[];
}

export interface SceneLayer extends MapLayer {
  plane: PlaneId;
  nodes: SceneServiceNode[];
  /** Same-plane call edges between this layer's services. */
  callEdges: SceneCallEdge[];
}

export interface SceneGraph {
  layers: SceneLayer[];
  nodesByKey: Map<string, SceneServiceNode>;
  hierarchyEdges: SceneHierarchyEdge[];
  /** Edges whose source and target belong to DIFFERENT layers (regardless
   *  of plane). The layout pipeline does NOT introduce phantom nodes for
   *  the foreign endpoint — both endpoints stay anchored at their native
   *  layer's computed positions; only the rendered tube crosses layers. */
  crossLayerEdges: SceneCrossLayerEdge[];
}

function nodeKey(layerKey: string, serviceId: string): string {
  return `${layerKey.toUpperCase()}::${serviceId}`;
}
function shortName(name: string): string {
  // `mesh-svr::frontend.sample-services` → `frontend`
  // `agent::frontend` → `frontend`
  // BUT `10.100.200.52:61616` must stay whole — virtual MQ / DB
  // targets are addressed by raw IP:port; the period separator means
  // octets here, not FQDN segments. Splitting on `.` chopped these
  // to "10" which is useless as a label.
  const afterColon = name.includes('::') ? name.split('::').slice(-1)[0] : name;
  if (/^(\d{1,3}\.){3}\d{1,3}(:\d+)?$/.test(afterColon)) return afterColon;
  return afterColon.split('.')[0] || afterColon;
}

export function loadFallbackTopology(): MapTopology {
  return fallbackJson as MapTopology;
}

export function buildSceneGraph(
  topo: MapTopology,
  resolver?: LevelResolver,
  /** Layers this returns true for are dropped from the graph entirely —
   *  the global `filter.layer` gate, so an excluded layer is off the map
   *  (not silently re-homed on the failover tier). */
  isExcluded?: (layerKey: string) => boolean,
): SceneGraph {
  // Build the per-layer node + call-edge view (filter-excluded layers out).
  const visibleLayers = isExcluded ? topo.layers.filter((L) => !isExcluded(L.key)) : topo.layers;
  const layers: SceneLayer[] = visibleLayers.map((L) => {
    const plane = planeForLayer(L.key, resolver);
    const nodes: SceneServiceNode[] = (topo.servicesByLayer[L.key] ?? []).map((s) => ({
      nodeId: nodeKey(L.key, s.id),
      layerKey: L.key,
      serviceId: s.id,
      name: s.name,
      shortName: shortName(s.name),
      normal: s.normal,
    }));
    // Intra-layer call edges from the topology snapshot. We filter to
    // calls where BOTH endpoints are services that belong to this
    // layer — the topology snapshot also surfaces external nodes (e.g.
    // a virtual DB hit from an instrumented service), and rendering
    // those as "intra-layer" edges would be misleading.
    const knownIds = new Set(nodes.map((n) => n.serviceId));
    const t = topo.topologies?.[L.key];
    const callEdges: SceneCallEdge[] =
      t?.calls
        .filter((c) => knownIds.has(c.source) && knownIds.has(c.target))
        .map((c) => ({
          fromNodeId: nodeKey(L.key, c.source),
          toNodeId: nodeKey(L.key, c.target),
          detectPoints: c.detectPoints,
        })) ?? [];
    return { ...L, plane, nodes, callEdges };
  });

  const nodesByKey = new Map<string, SceneServiceNode>();
  for (const L of layers) for (const n of L.nodes) nodesByKey.set(n.nodeId, n);

  // Index every known service-id to its owning layer so we can resolve
  // cross-layer call edges in the second pass below. A service-id can
  // theoretically appear in multiple layers (rare); we keep the
  // first-seen mapping — the per-layer topology snapshot wins later
  // anyway, this index only routes leftover edges to a foreign owner.
  const layerByServiceId = new Map<string, string>();
  for (const L of layers) {
    for (const n of L.nodes) {
      if (!layerByServiceId.has(n.serviceId)) {
        layerByServiceId.set(n.serviceId, L.key);
      }
    }
  }
  // Cross-LAYER call edges. Pass over every layer's topology calls
  // and pick the ones where source and target belong to DIFFERENT
  // layers — regardless of plane. Examples in the showcase demo:
  //   BROWSER agent::ui  →  GENERAL agent::frontend   (same plane)
  //   GENERAL agent::songs → VIRTUAL_DATABASE psql:5432 (same plane)
  //   GENERAL agent::songs → VIRTUAL_MQ  10.x:61616     (same plane)
  //   GENERAL agent::gateway → K8S_SERVICE rcmd:80      (different plane)
  // The foreign endpoint stays in its native layer's grid — the
  // layout pipeline does not introduce phantom nodes. We dedupe
  // undirected pairs so two-way traffic only draws one tube; the
  // arrow head on the rendered tube preserves direction.
  const crossSeen = new Set<string>();
  const crossLayerEdges: SceneCrossLayerEdge[] = [];
  for (const L of layers) {
    const t = topo.topologies?.[L.key];
    if (!t) continue;
    const localIds = new Set(L.nodes.map((n) => n.serviceId));
    for (const c of t.calls) {
      const sourceLocal = localIds.has(c.source);
      const targetLocal = localIds.has(c.target);
      // Both endpoints local → intra-layer call (already emitted by
      // the layer's own callEdges); both foreign → some other layer
      // will pick it up on its own pass.
      if (sourceLocal === targetLocal) continue;
      const foreignId = sourceLocal ? c.target : c.source;
      const foreignLayer = layerByServiceId.get(foreignId);
      if (!foreignLayer) continue;
      const sourceLayer = sourceLocal ? L.key : foreignLayer;
      const targetLayer = sourceLocal ? foreignLayer : L.key;
      // Guard: a degenerate "cross-layer" where both sides resolve
      // to the SAME layer (can happen if an external service id
      // collides with a local one) collapses to intra-layer.
      if (sourceLayer.toUpperCase() === targetLayer.toUpperCase()) continue;
      const fromNodeId = nodeKey(sourceLayer, c.source);
      const toNodeId = nodeKey(targetLayer, c.target);
      if (!nodesByKey.has(fromNodeId) || !nodesByKey.has(toNodeId)) continue;
      const sig = `${fromNodeId}|${toNodeId}`;
      const rev = `${toNodeId}|${fromNodeId}`;
      if (crossSeen.has(sig) || crossSeen.has(rev)) continue;
      crossSeen.add(sig);
      crossLayerEdges.push({
        fromNodeId,
        toNodeId,
        fromLayer: sourceLayer,
        toLayer: targetLayer,
        detectPoints: c.detectPoints,
      });
    }
  }

  // Cross-layer hierarchy edges. Anchored at level-3 services in the
  // snapshot. We drop self-edges and dedupe undirected pairs.
  const seen = new Set<string>();
  const edges: SceneHierarchyEdge[] = [];
  for (const h of topo.hierarchy) {
    const from = nodeKey(h.fromLayer, h.fromService.id);
    if (!nodesByKey.has(from)) continue;
    for (const p of h.peers) {
      if (p.layer.toUpperCase() === h.fromLayer.toUpperCase()) continue;
      for (const s of p.services) {
        const to = nodeKey(p.layer, s.id);
        if (!nodesByKey.has(to)) continue;
        const sig = `${from}|${to}`;
        const rev = `${to}|${from}`;
        if (seen.has(sig) || seen.has(rev)) continue;
        seen.add(sig);
        edges.push({ fromNodeId: from, toNodeId: to });
      }
    }
  }

  return { layers, nodesByKey, hierarchyEdges: edges, crossLayerEdges };
}
