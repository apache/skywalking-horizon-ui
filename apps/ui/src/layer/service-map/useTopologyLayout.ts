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
 * Pure, Vue-agnostic topology layout — the booster-ported hierarchical
 * map algorithm, factored out of LayerServiceMapView so the same layout
 * can drive the service map AND (next) Deployment / EndpointDependency
 * without re-implementing the BFS column maths. Nothing here touches a
 * ref / computed; every function takes plain data and returns geometry,
 * so the column placement is unit-testable in isolation.
 *
 * Layout pipeline:
 *   1. `computeBoosterLevels` — BFS-from-one-seed column assignment
 *      (faithful port of booster-ui `computeLevels`).
 *   2. `clusterBuckets` — two-level layout: bucket by topology-cluster
 *      key, BFS each bucket internally, BFS the inter-cluster meta-graph
 *      for left→right bucket order, then position each bucket's rect.
 *   3. `nodePositions` — per-node (cx, cy) from the bucket geometry,
 *      with drag overrides folded in.
 *   4. `clusterRects` — live cluster bounding boxes derived from the
 *      actual node positions (so a dragged node grows / shrinks its box).
 */

import type { TopologyCall, TopologyNode } from '@/api/client';
import { isUserNode } from '@/layer/service-map/useTopologyIcons';

// ── Geometry constants (shared with the view's SVG render loop). ──────
/**
 * Node geometry — radius drives the icon size and the column spacing.
 * Sized smaller than the design's r=42 so a chain reads comfortably on
 * a 12" laptop without horizontal scroll; metrics text sits beneath the
 * node with a larger size to compensate.
 */
export const NODE_R = 32;
export const COL_GAP = 220;
// ~20% taller than the bare NODE_R*2 + 90 so the secondary node beneath
// a spine node has breathing room and diagonal calls reach a clearly
// distinct row instead of crowding it.
export const ROW_GAP = Math.round((NODE_R * 2 + 90) * 1.2);

// Group bounding-box paddings. Top padding is bigger so the alias chip
// (`namespace · sample`) has room to live above the inner column area.
export const GROUP_PAD_X = 36;
export const GROUP_PAD_TOP = 38;
export const GROUP_PAD_BOTTOM = 28;
export const GROUP_GAP_X = 80;

export const CLUSTER_MARGIN = 36; // breathing room around the outermost node centres
export const CLUSTER_HEAD_HEIGHT = 32; // space reserved above the topmost node for the chip

// Sentinel encoding for the cluster key — `null` (unclustered) gets
// pinned to a stable string so it can serve as a Map key alongside real
// cluster values. The leading NUL byte guarantees no real cluster name
// (a k8s namespace / mesh group) can ever collide with it. Decoded back
// on the read side.
export const UNCLUSTERED = '\u0000__ungrouped__';
export function ckeyEnc(k: string | null): string { return k ?? UNCLUSTERED; }
export function ckeyDec(s: string): string | null { return s === UNCLUSTERED ? null : s; }

export interface Pos { cx: number; cy: number }

export interface LayoutNode extends TopologyNode {
  layerIdx: number;
}

/**
 * One topology-cluster bucket. Each bucket runs its own internal BFS
 * column layout (mirroring the legacy single-graph layout) and is
 * positioned into a row of bucket regions whose order is decided by an
 * inter-cluster BFS over cross-cluster calls.
 */
export interface ClusterBucket {
  key: string | null;
  alias: string | null;
  nodes: LayoutNode[];        // intra-bucket BFS-ordered nodes with `layerIdx`
  cols: number;               // internal BFS columns
  maxRowsPerCol: number;      // tallest column in this bucket
  rect: { x: number; y: number; w: number; h: number };
}

export interface ClusterRect {
  key: string;
  alias: string | null;
  rect: { x: number; y: number; w: number; h: number };
}

/** Resolve a node's cluster key (the layer's topology-cluster rule) +
 *  the alias label for the cluster chip. Supplied by the caller so this
 *  module stays decoupled from the naming-rule resolver. */
export interface ClusterResolver {
  cluster(name: string | null | undefined): string | null;
  alias: string | null;
}

function isUser(n: TopologyNode): boolean {
  return isUserNode(n);
}

function findMostFrequentInCalls(
  callsList: TopologyCall[],
  pool: TopologyNode[],
): TopologyNode | null {
  if (callsList.length === 0) return null;
  const count = new Map<string, number>();
  let maxCount = 0;
  let maxId: string | null = null;
  for (const c of callsList) {
    const s = (count.get(c.source) ?? 0) + 1;
    count.set(c.source, s);
    if (s > maxCount) { maxCount = s; maxId = c.source; }
    const t = (count.get(c.target) ?? 0) + 1;
    count.set(c.target, t);
    if (t > maxCount) { maxCount = t; maxId = c.target; }
  }
  if (!maxId) return null;
  return pool.find((n) => n.id === maxId) ?? null;
}

/**
 * BFS-from-one-seed column assignment (port of booster-ui
 * `computeLevels` / `layout`):
 *
 *   1. Pick ONE seed — the literal `User` node if present, else the
 *      node that appears most often as either source or target.
 *   2. BFS walks BOTH directions (upstream + downstream) from the seed.
 *      The insertion order is preserved: whichever node enters level N
 *      first sits at the top row of that column.
 *   3. Disconnected subgraphs are processed recursively and their
 *      levels are merged by index.
 *   4. No barycentric reorder, no metric-based sort: a node's row within
 *      a column is exactly the order BFS reached it.
 */
export function computeBoosterLevels(
  callsList: TopologyCall[],
  nodeList: TopologyNode[],
  acc: TopologyNode[][],
): TopologyNode[][] {
  if (nodeList.length === 0) return acc;
  // Sort by name first so the seed-pick + traversal are deterministic
  // across renders. Booster-ui does the same.
  let pool = [...nodeList].sort((a, b) =>
    a.name.toLowerCase() < b.name.toLowerCase() ? -1 :
    a.name.toLowerCase() > b.name.toLowerCase() ? 1 : 0,
  );
  let seedIdx = pool.findIndex(isUser);
  if (seedIdx < 0) {
    const most = findMostFrequentInCalls(callsList, pool);
    seedIdx = most ? pool.findIndex((n) => n.id === most.id) : 0;
  }
  if (seedIdx < 0) seedIdx = 0;
  const levels: TopologyNode[][] = [[pool[seedIdx]]];
  pool = pool.filter((_, i) => i !== seedIdx);
  // Walk levels — new levels get appended inside the loop, so this is an
  // index-based for so the freshly-pushed levels are visited too.
  for (let li = 0; li < levels.length; li++) {
    const level = levels[li];
    const next: TopologyNode[] = [];
    for (const l of level) {
      for (const c of callsList) {
        if (c.target === l.id) {
          const i = pool.findIndex((d) => d.id === c.source);
          if (i > -1) {
            next.push(pool[i]);
            pool = pool.filter((_, idx) => idx !== i);
          }
        }
        if (c.source === l.id) {
          const i = pool.findIndex((d) => d.id === c.target);
          if (i > -1) {
            next.push(pool[i]);
            pool = pool.filter((_, idx) => idx !== i);
          }
        }
      }
    }
    if (next.length > 0) levels.push(next);
  }
  // Merge this subgraph's levels into the running accumulator by index:
  // subgraph level-K nodes append to acc[K]. Booster's exact shape —
  // keeps disconnected subgraphs aligned to the same columns.
  const longer = levels.length > acc.length ? levels : acc;
  const shorter = levels.length > acc.length ? acc : levels;
  const merged = longer.map((sub, idx) =>
    shorter[idx] ? [...sub, ...shorter[idx]] : sub,
  );
  if (pool.length > 0) {
    const remainingIds = new Set(pool.map((n) => n.id));
    const remainingCalls = callsList.filter(
      (c) => remainingIds.has(c.source) || remainingIds.has(c.target),
    );
    return computeBoosterLevels(remainingCalls, pool, merged);
  }
  return merged;
}

/**
 * Two-level layout: bucket by the layer-resolved topology cluster, BFS
 * each bucket internally, then BFS the inter-cluster call graph to
 * decide bucket order along the X axis. Returns the buckets in render
 * order with each bucket's anchor rect already positioned.
 *
 * Unclustered nodes (layer has no topology-cluster rule, or the rule
 * didn't match — synthetic User, external endpoints, …) collapse into a
 * single null-key bucket that renders WITHOUT a bounding box, preserving
 * the look of layers that haven't opted in to clustering.
 */
export function clusterBuckets(
  nodes: TopologyNode[],
  calls: TopologyCall[],
  resolver: ClusterResolver,
): ClusterBucket[] {
  if (nodes.length === 0) return [];
  // 1. Bucket nodes by resolved group key.
  const byGroup = new Map<string, TopologyNode[]>();
  for (const n of nodes) {
    const k = ckeyEnc(resolver.cluster(n.name));
    if (!byGroup.has(k)) byGroup.set(k, []);
    byGroup.get(k)!.push(n);
  }
  // 2. Run BFS on the inter-group meta-graph to decide bucket order.
  //    Each group becomes a meta-node; cross-group calls become meta-
  //    edges. `computeBoosterLevels` is reused with synthesised
  //    TopologyNode / TopologyCall shells.
  const clusterOfId = new Map<string, string>();
  for (const n of nodes) clusterOfId.set(n.id, ckeyEnc(resolver.cluster(n.name)));
  const interGroupCalls: TopologyCall[] = [];
  for (const c of calls) {
    const s = clusterOfId.get(c.source);
    const t = clusterOfId.get(c.target);
    if (s === undefined || t === undefined) continue;
    if (s === t) continue;
    interGroupCalls.push({
      id: `${s}->${t}`,
      source: s,
      target: t,
      detectPoints: [],
      serverMetrics: {}, clientMetrics: {},
      serverMetricSeries: {}, clientMetricSeries: {},
      serverCpm: null, serverRespTime: null,
      clientCpm: null, clientRespTime: null,
    });
  }
  const groupKeys = [...byGroup.keys()];
  const metaNodes: TopologyNode[] = groupKeys.map((k) => ({
    id: k, name: k === UNCLUSTERED ? '' : k,
    type: null, isReal: true, layers: [],
    metrics: {}, cpm: null, respTime: null, sla: null,
  }));
  const metaLevels = computeBoosterLevels(interGroupCalls, metaNodes, []);
  const ordered: string[] = [];
  for (const level of metaLevels) for (const n of level) ordered.push(n.id);
  // Any groups missed by BFS (no inter-group edges) are tacked on the
  // end in deterministic order so the canvas doesn't drop them.
  for (const k of groupKeys) if (!ordered.includes(k)) ordered.push(k);
  // 3. Internal BFS per bucket — restrict the call graph to the bucket's
  //    own ids so the seed-pick + traversal don't leak.
  const buckets: ClusterBucket[] = [];
  for (const k of ordered) {
    const groupNodes = byGroup.get(k) ?? [];
    if (groupNodes.length === 0) continue;
    const ids = new Set(groupNodes.map((n) => n.id));
    const internalCalls = calls.filter((c) => ids.has(c.source) && ids.has(c.target));
    const levels = computeBoosterLevels(internalCalls, groupNodes, []);
    const lay: LayoutNode[] = [];
    levels.forEach((lvl, idx) => {
      for (const n of lvl) lay.push({ ...n, layerIdx: idx });
    });
    // Tuck in any nodes the internal BFS missed (isolated nodes that
    // only have cross-group edges) so they still render.
    const seen = new Set(lay.map((n) => n.id));
    const orphanCol = levels.length;
    for (const n of groupNodes) {
      if (!seen.has(n.id)) lay.push({ ...n, layerIdx: orphanCol });
    }
    const cols = Math.max(1, lay.reduce((m, n) => Math.max(m, n.layerIdx), -1) + 1);
    const rowsByCol = new Map<number, number>();
    for (const n of lay) rowsByCol.set(n.layerIdx, (rowsByCol.get(n.layerIdx) ?? 0) + 1);
    const maxRowsPerCol = Math.max(1, ...rowsByCol.values());
    buckets.push({
      key: ckeyDec(k),
      // Cluster boxes / alias chips only render when the layer carries an
      // explicit topology-cluster rule. Layers without one have all nodes
      // in the null-key bucket and never reach this branch with a
      // non-null key.
      alias: resolver.alias,
      nodes: lay,
      cols,
      maxRowsPerCol,
      rect: { x: 0, y: 0, w: 0, h: 0 },
    });
  }
  // 4. Position bucket rects left-to-right. Each bucket's width =
  //    internal-cols * COL_GAP + horizontal padding; its height =
  //    tallest-col * ROW_GAP + top/bottom padding.
  let cursorX = 40;
  for (const b of buckets) {
    const innerW = b.cols * COL_GAP;
    const innerH = b.maxRowsPerCol * ROW_GAP;
    const w = innerW + GROUP_PAD_X * 2;
    const h = innerH + GROUP_PAD_TOP + GROUP_PAD_BOTTOM;
    // y=110 gives ~40px headroom above the cluster boxes so the floating
    // alias·value chip (which extends ~30px above each cluster's top
    // edge) has room without clipping at the SVG top.
    b.rect = { x: cursorX, y: 110, w, h };
    cursorX += w + GROUP_GAP_X;
  }
  return buckets;
}

/**
 * Per-node (cx, cy) derived from the bucket geometry. Drag overrides win
 * — but only when the node is still in the visible set, so a stale id
 * from a previous layer doesn't bleed.
 */
export function nodePositions(
  buckets: ClusterBucket[],
  dragOverrides: Map<string, Pos>,
): Map<string, Pos> {
  const map = new Map<string, Pos>();
  for (const b of buckets) {
    // Bucket-local column buckets — needed to place each node at its row
    // index *within its column*. The internal BFS already assigns each
    // node a `layerIdx`; the row is the node's position in the column-
    // bucket order, mirroring the legacy single-graph layout.
    const byCol = new Map<number, LayoutNode[]>();
    for (const n of b.nodes) {
      if (!byCol.has(n.layerIdx)) byCol.set(n.layerIdx, []);
      byCol.get(n.layerIdx)!.push(n);
    }
    for (const [colIdx, list] of byCol) {
      const cx = b.rect.x + GROUP_PAD_X + colIdx * COL_GAP + NODE_R + 4;
      list.forEach((n, rowIdx) => {
        const cy = b.rect.y + GROUP_PAD_TOP + rowIdx * ROW_GAP + NODE_R;
        map.set(n.id, { cx, cy });
      });
    }
  }
  for (const [id, p] of dragOverrides) {
    if (map.has(id)) map.set(id, p);
  }
  return map;
}

/**
 * Live cluster bounding rects — derived from the actual node positions
 * (which already fold in drag overrides) rather than the BFS-anchor
 * `bucket.rect`. As soon as a node is dragged, the cluster box grows or
 * shrinks to keep it enclosed. Only buckets with a non-null key render —
 * layers without a topology-cluster rule never enter here.
 */
export function clusterRects(
  buckets: ClusterBucket[],
  positions: Map<string, Pos>,
): ClusterRect[] {
  const out: ClusterRect[] = [];
  for (const b of buckets) {
    if (!b.key) continue;
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    let count = 0;
    for (const n of b.nodes) {
      const p = positions.get(n.id);
      if (!p) continue;
      count++;
      if (p.cx < minX) minX = p.cx;
      if (p.cy < minY) minY = p.cy;
      if (p.cx > maxX) maxX = p.cx;
      if (p.cy > maxY) maxY = p.cy;
    }
    if (count === 0) continue;
    // Each "centre" needs room for the node circle (NODE_R) plus the
    // label text rendered beneath the node (~26px). Inflate by both.
    // `padTop` reserves CLUSTER_HEAD_HEIGHT above the topmost node for
    // the alias·value chip — which renders INSIDE the cluster top. The
    // cluster top can follow a dragged node freely (even off the visible
    // canvas top), and the node stays visually enclosed because `y` is
    // derived purely from node positions instead of being clamped.
    const padTop = NODE_R + CLUSTER_HEAD_HEIGHT;
    const padBot = NODE_R + 32; // label + RPM
    const padSide = NODE_R + 18;
    const x = minX - padSide - CLUSTER_MARGIN;
    const y = minY - padTop - CLUSTER_MARGIN;
    const w = (maxX - minX) + (padSide + CLUSTER_MARGIN) * 2;
    const h = (maxY - minY) + padTop + padBot + CLUSTER_MARGIN * 2;
    out.push({ key: b.key, alias: b.alias, rect: { x, y, w, h } });
  }
  return out;
}
