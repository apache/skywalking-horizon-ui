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
 * Scene-placement layout for the 3D infra map.
 *
 *   - Three tier-planes stack vertically: apps on top, service mesh in
 *     the middle, infrastructure at the bottom.
 *   - Each plane is subdivided into per-layer "zones". Topology-bearing
 *     layers (general / mesh / k8s_service) sit at the center of their
 *     plane; non-topology layers tile on the sides — operators read
 *     "the topology I care about is the one with the graph in the
 *     middle, and the supporting tier is around it".
 *   - Inside a topology zone, nodes are placed by a rank-based grid
 *     (Sugiyama-lite): every node belongs to a column (rank = longest
 *     call-path from any source), each column is centered vertically,
 *     and the within-rank order is fixed by a median heuristic so
 *     edges don't cross unnecessarily. This produces a clean top-down
 *     graph similar to the booster-ui service-map view, just rendered
 *     in 3D as cubes on the plane.
 *   - Non-topology layers use a tight column-fill grid (vertical-first,
 *     cols ≤ rows − 1).
 *   - See CLAUDE.md in this directory for the full layout-rule spec.
 */

import type { PlaneId, SceneGraph, SceneLayer, SceneServiceNode } from './useDemoTopology';

// ── Output types ────────────────────────────────────────────────────────

export interface NodePlacement {
  nodeId: string;
  x: number;
  y: number;
  z: number;
}

export interface PlanePlacement {
  id: PlaneId;
  name: string;
  y: number;
  width: number;
  depth: number;
}

export interface ZonePlacement {
  layerKey: string;
  layerName: string;
  plane: PlaneId;
  y: number;
  centerX: number;
  centerZ: number;
  width: number;
  depth: number;
  tint: ZoneTint;
  /** True when this zone carries a service-map (topology) layout —
   *  drives the "center zones with topology, sides for the rest"
   *  arrangement on each plane. */
  hasTopology: boolean;
}

export type ZoneTint =
  | 'app'
  | 'browser'
  | 'mobile'
  | 'virtual'
  | 'so11y'
  | 'mesh'
  | 'mesh-cp'
  | 'mesh-dp'
  | 'cilium'
  | 'k8s'
  | 'vm'
  | 'db'
  | 'mq'
  | 'cache'
  | 'gateway'
  | 'cloud'
  | 'misc';

export interface ScenePlacement {
  planes: PlanePlacement[];
  zones: ZonePlacement[];
  nodes: Map<string, NodePlacement>;
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number; minY: number; maxY: number };
}

// ── Layout constants ───────────────────────────────────────────────────

/** Vertical gap between adjacent planes. The placement function turns
 *  the caller-supplied plane order into Y values `index * PLANE_VGAP`
 *  — so a 4-plane config (apps → mesh → middleware → infra) takes 3×
 *  this height, growing the camera-fit accordingly. The bottom plane
 *  is at Y=0, top at Y=(n-1) * gap. */
const PLANE_VGAP = 8;
/** Horizontal gap between adjacent zones on the same plane. */
const ZONE_GAP_X = 2.4;
/** Cube-cell stride inside a zone. */
const CELL_STRIDE_X = 2.4;
const CELL_STRIDE_Z = 2.4;
/** Padding INSIDE a zone — keeps cubes off the colored edge. */
const ZONE_INNER_PAD = 1.2;

// ── Layer → zone tint ───────────────────────────────────────────────────

export function tintForLayer(layerKey: string, group: string | null): ZoneTint {
  const k = layerKey.toLowerCase();
  if (k === 'general') return 'app';
  if (k === 'browser') return 'browser';
  if (k === 'ios' || k.endsWith('_mini_program')) return 'mobile';
  if (k.startsWith('virtual_')) return 'virtual';
  if (k.startsWith('so11y_')) return 'so11y';
  if (k === 'mesh') return 'mesh';
  if (k === 'mesh_cp') return 'mesh-cp';
  if (k === 'mesh_dp') return 'mesh-dp';
  if (k === 'cilium_service' || k.startsWith('envoy_')) return 'cilium';
  if (k.startsWith('k8s')) return 'k8s';
  if (k.startsWith('os_')) return 'vm';
  if (group === 'Databases' || ['mysql', 'postgresql', 'mongodb', 'clickhouse', 'elasticsearch'].includes(k)) {
    return 'db';
  }
  if (k === 'redis') return 'cache';
  if (group === 'Workflow Scheduler' || k === 'airflow') return 'misc';
  if (group === 'MQ' || ['kafka', 'rocketmq', 'rabbitmq', 'activemq', 'pulsar', 'bookkeeper', 'flink'].includes(k)) {
    return 'mq';
  }
  if (group === 'Gateways' || k === 'faas' || k === 'virtual_gateway') return 'gateway';
  if (group === 'AWS' || k.startsWith('aws_')) return 'cloud';
  return 'misc';
}

export function tintCssVar(tint: ZoneTint): string {
  switch (tint) {
    case 'app':
      return '--sw-accent';
    case 'browser':
      return '--sw-cyan';
    case 'mobile':
      return '--sw-info';
    case 'virtual':
      return '--sw-warn';
    case 'so11y':
      return '--sw-purple';
    case 'mesh':
    case 'mesh-dp':
      return '--sw-purple';
    case 'mesh-cp':
      return '--sw-info';
    case 'cilium':
      return '--sw-cyan';
    case 'k8s':
      return '--sw-ok';
    case 'vm':
      return '--sw-fg-2';
    case 'db':
      return '--sw-warn';
    case 'mq':
      return '--sw-accent-2';
    case 'cache':
      return '--sw-err';
    case 'gateway':
      return '--sw-info';
    case 'cloud':
      return '--sw-fg-3';
    case 'misc':
      return '--sw-fg-2';
  }
}

export function readTintColor(tint: ZoneTint): string {
  const root = getComputedStyle(document.documentElement);
  const v = root.getPropertyValue(tintCssVar(tint)).trim();
  return v || '#888888';
}

// ── Layout primitives ──────────────────────────────────────────────────

interface LocalPoint {
  x: number;
  z: number;
}

/**
 * Column-fill grid for non-topology layers. Vertical-first: nodes stack
 * into one column up to a max height; when a column fills, a new column
 * opens to the right. The constraint `cols ≤ rows − 1` keeps the
 * layout taller than it is wide (a column of stacked cubes is a
 * natural shape on a plane). See CLAUDE.md for the rule + examples.
 */
function columnFillLayout(nodes: SceneServiceNode[]): { positions: Map<string, LocalPoint>; rows: number; cols: number } {
  const n = nodes.length;
  if (n === 0) return { positions: new Map(), rows: 0, cols: 0 };
  if (n === 1) {
    return { positions: new Map([[nodes[0]!.nodeId, { x: 0, z: 0 }]]), rows: 1, cols: 1 };
  }
  // Find the smallest `rows` such that the grid `rows × (rows − 1)` can
  // hold every node — i.e. cols ≤ rows − 1. For n ≤ 3 we degenerate to
  // a single column (cols=1, rows=n) since (rows − 1) lower-bounds at 0
  // when rows = 1 and 1 when rows = 2.
  let rows: number;
  if (n <= 3) {
    rows = n;
  } else {
    rows = 2;
    while (rows * (rows - 1) < n) rows++;
  }
  const cols = Math.max(1, Math.ceil(n / rows));

  // Fill cols left-to-right, each up to `rows` cubes. The last col may
  // be shorter. This matches the user's spec: 7 → 4-3, 10 → 4-4-2, 11
  // → 4-4-3, 35 (k8s) → 7-7-7-7-7.
  const positions = new Map<string, LocalPoint>();
  for (let i = 0; i < n; i++) {
    const col = Math.floor(i / rows);
    const row = i % rows;
    const x = (col - (cols - 1) / 2) * CELL_STRIDE_X;
    const z = (row - (rows - 1) / 2) * CELL_STRIDE_Z;
    positions.set(nodes[i]!.nodeId, { x, z });
  }
  return { positions, rows, cols };
}

/**
 * Rank-based layout for topology-bearing layers (general / mesh /
 * k8s_service in the demo). Builds a column-per-rank grid where rank is
 * the longest call-path from any source node, then orders nodes within
 * a rank by the median index of their incoming neighbours in the
 * previous rank — a one-pass Sugiyama crossing-reduction. The result
 * reads top-down like the 2D service-map view: upstream callers on the
 * left, downstream services on the right, rows aligned across ranks.
 *
 * Cycles are not strictly resolved; any node that the BFS never
 * reaches stays at rank 0. This is enough for the call graphs we see
 * in practice (showcase deployment has acyclic call graphs per layer).
 */
function rankBasedLayout(L: SceneLayer): { positions: Map<string, LocalPoint>; rows: number; cols: number } {
  const ids = L.nodes.map((n) => n.nodeId);
  if (ids.length === 0) return { positions: new Map(), rows: 0, cols: 0 };
  if (ids.length === 1) {
    return { positions: new Map([[ids[0]!, { x: 0, z: 0 }]]), rows: 1, cols: 1 };
  }
  const incoming = new Map<string, string[]>();
  const outgoing = new Map<string, string[]>();
  for (const id of ids) {
    incoming.set(id, []);
    outgoing.set(id, []);
  }
  for (const e of L.callEdges) {
    if (incoming.has(e.toNodeId) && outgoing.has(e.fromNodeId)) {
      incoming.get(e.toNodeId)!.push(e.fromNodeId);
      outgoing.get(e.fromNodeId)!.push(e.toNodeId);
    }
  }

  // ── Rank assignment: longest path from any source via BFS. Sources
  //    are nodes with no incoming edges; if there are none (fully
  //    cyclic), seed with the highest-out-degree node so we still get
  //    a layered view.
  const rank = new Map<string, number>();
  let sources = ids.filter((id) => (incoming.get(id) ?? []).length === 0);
  if (sources.length === 0) {
    let seed = ids[0]!;
    let best = -1;
    for (const id of ids) {
      const od = (outgoing.get(id) ?? []).length;
      if (od > best) {
        best = od;
        seed = id;
      }
    }
    sources = [seed];
  }
  for (const s of sources) rank.set(s, 0);
  // Relaxation pass: repeatedly extend the rank when a longer path is
  // discovered, until no more updates. Bounded by N iterations to
  // guarantee termination on cyclic graphs.
  let changed = true;
  let guard = ids.length;
  while (changed && guard-- > 0) {
    changed = false;
    for (const u of ids) {
      const ru = rank.get(u);
      if (ru === undefined) continue;
      for (const v of outgoing.get(u) ?? []) {
        const rv = rank.get(v);
        if (rv === undefined || ru + 1 > rv) {
          rank.set(v, ru + 1);
          changed = true;
        }
      }
    }
  }
  // Any unreached node lands at rank 0 (orphan / cycle).
  for (const id of ids) if (!rank.has(id)) rank.set(id, 0);

  const byRank = new Map<number, string[]>();
  for (const [id, r] of rank) {
    if (!byRank.has(r)) byRank.set(r, []);
    byRank.get(r)!.push(id);
  }
  const sortedRanks = [...byRank.keys()].sort((a, b) => a - b);

  // ── Median heuristic for within-rank ordering. One pass left→right
  //    over the ranks (R ≥ 1): order rank R's nodes by the median
  //    index of their incoming neighbours in rank R − 1. Ties keep
  //    the original (insertion) order — that's stable across reloads.
  const orderByRank = new Map<number, string[]>();
  orderByRank.set(sortedRanks[0]!, [...byRank.get(sortedRanks[0]!)!]);
  for (let i = 1; i < sortedRanks.length; i++) {
    const r = sortedRanks[i]!;
    const prevOrder = orderByRank.get(sortedRanks[i - 1]!)!;
    const prevIdx = new Map(prevOrder.map((id, idx) => [id, idx]));
    const cur = [...byRank.get(r)!];
    const medians = new Map<string, number>();
    for (const id of cur) {
      const neigh = (incoming.get(id) ?? [])
        .map((p) => prevIdx.get(p))
        .filter((x): x is number => x !== undefined);
      const m = neigh.length === 0 ? prevOrder.length : neigh.sort((a, b) => a - b)[Math.floor(neigh.length / 2)]!;
      medians.set(id, m);
    }
    cur.sort((a, b) => (medians.get(a)! - medians.get(b)!) || cur.indexOf(a) - cur.indexOf(b));
    orderByRank.set(r, cur);
  }

  const cols = sortedRanks.length;
  const rows = Math.max(...sortedRanks.map((r) => byRank.get(r)!.length));

  // ── Positioning. Each rank gets a column at X = (col − (cols−1)/2) ·
  //    stride. Within a rank, nodes are vertically centered with Z =
  //    (row − (rows−1)/2) · stride. The result is a clean rectangular
  //    matrix; an empty cell at the corner is just a gap.
  const positions = new Map<string, LocalPoint>();
  sortedRanks.forEach((r, ci) => {
    const list = orderByRank.get(r)!;
    const x = (ci - (cols - 1) / 2) * CELL_STRIDE_X;
    list.forEach((id, ri) => {
      // Center each column vertically within the rank-band so unequal
      // ranks still align around the midline — a column of 3 nodes
      // next to a column of 5 reads as concentric.
      const z = (ri - (list.length - 1) / 2) * CELL_STRIDE_Z;
      positions.set(id, { x, z });
    });
  });
  return { positions, rows, cols };
}

// ── Top-level placement ────────────────────────────────────────────────

/** Sort key for arranging zones on a plane. Topology-bearing zones
 *  (largest first) take the center; non-topology zones tile outward
 *  alternating left/right by size, so the visual weight stays
 *  balanced. The returned `centerIndex` is the index in the input
 *  array that maps to the center slot. */
function arrangeZonesByCenter(layers: SceneLayer[]): SceneLayer[] {
  // Center = topology-bearing layers, ordered by node count desc.
  // Sides = others, ordered by node count desc.
  const center = layers.filter((L) => L.callEdges.length > 0)
    .sort((a, b) => b.nodes.length - a.nodes.length);
  const sides = layers.filter((L) => L.callEdges.length === 0)
    .sort((a, b) => b.nodes.length - a.nodes.length);
  // Interleave the sides around the center: side[0] → left, side[1] →
  // right, side[2] → further left, side[3] → further right, …
  const left: SceneLayer[] = [];
  const right: SceneLayer[] = [];
  sides.forEach((L, i) => {
    if (i % 2 === 0) left.unshift(L);
    else right.push(L);
  });
  return [...left, ...center, ...right];
}

export interface PlaneSpec {
  /** Level id — matches `SceneLayer.plane`. */
  id: PlaneId;
  /** Operator-facing label rendered on the plane fringe. */
  label: string;
}

/** Computes node + zone + plane placement.
 *
 *  `planeOrder` is the TOP-TO-BOTTOM list of planes (apps first, infra
 *  last in the default 4-plane config). The bottom plane lands at Y=0;
 *  each subsequent plane stacks up by `PLANE_VGAP`. An empty array
 *  falls back to the legacy 3-plane order so the function stays useful
 *  in tests and very-early renders. */
export function computePlacement(graph: SceneGraph, planeOrder?: PlaneSpec[]): ScenePlacement {
  const order: PlaneSpec[] =
    planeOrder && planeOrder.length > 0
      ? planeOrder
      : [
          { id: 'apps', label: 'Apps' },
          { id: 'mesh', label: 'Service Mesh' },
          { id: 'middleware', label: 'Middleware' },
          { id: 'infra', label: 'Infrastructure' },
        ];

  const byPlane = new Map<PlaneId, SceneLayer[]>();
  for (const p of order) byPlane.set(p.id, []);
  for (const L of graph.layers) {
    if (L.nodes.length === 0) continue;
    // Layers whose resolved level id isn't in the ordered list still
    // need a plane — drop them onto the bottom plane so the operator
    // sees them and can fix the mapping in the admin editor.
    if (!byPlane.has(L.plane)) {
      const fallback = order[order.length - 1]!.id;
      byPlane.get(fallback)!.push(L);
      continue;
    }
    byPlane.get(L.plane)!.push(L);
  }
  // Y for each plane: top of stack at Y = (n - 1) * PLANE_VGAP, bottom
  // at 0. `planeOrder` is top-down, so index 0 is the highest.
  const planeYById = new Map<PlaneId, number>();
  order.forEach((p, i) => planeYById.set(p.id, (order.length - 1 - i) * PLANE_VGAP));

  const planes: PlanePlacement[] = [];
  const zones: ZonePlacement[] = [];
  const nodes = new Map<string, NodePlacement>();
  let maxPlaneW = 0;
  let maxPlaneD = 0;

  for (const spec of order) {
    const id = spec.id;
    const ordered = arrangeZonesByCenter(byPlane.get(id) ?? []);
    const planeY = planeYById.get(id)!;

    // ── Per-zone layout. We compute the local positions first, then
    //    derive each zone's footprint from the layout bbox + padding.
    interface PreZone {
      layer: SceneLayer;
      positions: Map<string, LocalPoint>;
      hasTopology: boolean;
      width: number;
      depth: number;
    }
    const pre: PreZone[] = ordered.map((L) => {
      const layout =
        L.callEdges.length > 0 ? rankBasedLayout(L) : columnFillLayout(L.nodes);
      // Bounding box from the layout's local points.
      let minX = 0, maxX = 0, minZ = 0, maxZ = 0;
      let any = false;
      for (const p of layout.positions.values()) {
        if (!any) {
          minX = maxX = p.x;
          minZ = maxZ = p.z;
          any = true;
        } else {
          if (p.x < minX) minX = p.x;
          if (p.x > maxX) maxX = p.x;
          if (p.z < minZ) minZ = p.z;
          if (p.z > maxZ) maxZ = p.z;
        }
      }
      const w = (maxX - minX) + CELL_STRIDE_X + ZONE_INNER_PAD * 2;
      const d = (maxZ - minZ) + CELL_STRIDE_Z + ZONE_INNER_PAD * 2;
      return { layer: L, positions: layout.positions, hasTopology: L.callEdges.length > 0, width: w, depth: d };
    });

    // ── Tile zones left-to-right on the plane, centered at X = 0.
    const totalW = pre.reduce((acc, z, i) => acc + z.width + (i > 0 ? ZONE_GAP_X : 0), 0);
    const maxD = pre.reduce((acc, z) => Math.max(acc, z.depth), 0);
    const planeW = Math.max(totalW + 4, 14);
    const planeD = maxD + 2;
    planes.push({ id, name: spec.label, y: planeY, width: planeW, depth: planeD });
    maxPlaneW = Math.max(maxPlaneW, planeW);
    maxPlaneD = Math.max(maxPlaneD, planeD);

    let cursor = -totalW / 2;
    for (const z of pre) {
      const cx = cursor + z.width / 2;
      const cz = 0;
      cursor += z.width + ZONE_GAP_X;
      const tint = tintForLayer(z.layer.key, z.layer.group);
      zones.push({
        layerKey: z.layer.key,
        layerName: z.layer.name,
        plane: id,
        y: planeY,
        centerX: cx,
        centerZ: cz,
        width: z.width,
        depth: z.depth,
        tint,
        hasTopology: z.hasTopology,
      });
      for (const n of z.layer.nodes) {
        const off = z.positions.get(n.nodeId) ?? { x: 0, z: 0 };
        nodes.set(n.nodeId, { nodeId: n.nodeId, x: cx + off.x, y: planeY, z: cz + off.z });
      }
    }
  }

  const minY = 0;
  const maxY = (order.length - 1) * PLANE_VGAP;
  const halfX = maxPlaneW / 2;
  const halfZ = maxPlaneD / 2;
  return {
    planes,
    zones,
    nodes,
    bounds: { minX: -halfX, maxX: halfX, minZ: -halfZ, maxZ: halfZ, minY, maxY },
  };
}

export function pointFor(p: ScenePlacement, nodeId: string): NodePlacement | null {
  return p.nodes.get(nodeId) ?? null;
}

export function zonesByKey(p: ScenePlacement): Map<string, ZonePlacement> {
  const m = new Map<string, ZonePlacement>();
  for (const z of p.zones) m.set(z.layerKey, z);
  return m;
}
