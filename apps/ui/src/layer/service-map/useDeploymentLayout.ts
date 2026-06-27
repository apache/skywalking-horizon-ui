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
 * Framework-free layout math for the Deployment tab. Pure functions only —
 * no Vue, no d3 — so the view's `layout` computed is a thin reactive wrapper
 * around `computeLayout`. Pods tile in a near-square grid per cluster box;
 * each pod = a main hex with up to 6 siblings attached at its edge midpoints.
 *
 * Sizing tracks the service map (NODE_R 32 / COL_GAP 220 / ROW_GAP 185) so the
 * two topologies read at the same scale + zoom. Siblings are half the main hex.
 */

import type { DeploymentNode } from '@/api/client';

export const MAIN_R = 32;
export const SIB_R = 16;
const SIB_DIST = 48; // main centre -> sibling centre
// Edge-midpoint directions (SVG y-down), in attach order.
const SIB_ANGLES = [30, 150, 330, 210, 90, 270].map((d) => (d * Math.PI) / 180);
const POD_DX = 210;
const POD_DY = 190;
const CLUSTER_GAP_X = 60;
const CLUSTER_PAD = 24;
const HEAD_H = 30;

// Cluster-box geometry shared by the layout packer and the live rect renderer
// (they MUST agree, or packing gaps drift). Padding leaves room for the header
// band (top) and the sibling labels (bottom).
export const BOX_HEAD_BAND = 34;
export const BOX_PAD_X = 22;
export const BOX_PAD_TOP = 10;
export const BOX_PAD_BOTTOM = 28;

export interface Pos { cx: number; cy: number; r: number }
export interface ClusterRect { key: string | null; label: string; x: number; y: number; w: number; h: number; boxed: boolean }
export interface Layout { pos: Map<string, Pos>; w: number; h: number; nodeToPod: Map<string, string> }

export interface Pod {
  clusterKey: string | null;
  siblingKey: string;
  main: DeploymentNode;
  siblings: DeploymentNode[];
}
export interface ClusterBucket { key: string | null; label: string; pods: Pod[] }

export const podIdOf = (clusterKey: string | null, siblingKey: string): string => `${clusterKey ?? ''}␟${siblingKey}`;

/** Rank each node by its longest path from a source (no incoming edge) along
 *  the call graph — rank 0 = source. Used twice: on the intra-cluster pod
 *  graph (rank ⇒ the tier column a pod sits in) and on the inter-cluster graph
 *  (rank ⇒ a box's left→right slot). Cycles are handled by condensing each
 *  strongly-connected component to one super-node before ranking, so a
 *  mutually-calling pair (a liaison↔liaison pair, or a bidirectional
 *  cross-cluster RPC) shares a rank instead of STARVING a plain Kahn pass —
 *  which, with no in-degree-0 seed, would leave every node at rank 0 and
 *  collapse the whole axis to alphabetical order. Ranks are densified so there
 *  are no gaps. For acyclic input this is identical to a longest-path BFS. */
export function rankPods(podIds: string[], edges: Array<[string, string]>): Map<string, number> {
  const idSet = new Set(podIds);
  const succ = new Map<string, string[]>(podIds.map((id) => [id, []]));
  for (const [s, t] of edges) {
    if (!idSet.has(s) || !idSet.has(t) || s === t) continue;
    succ.get(s)!.push(t);
  }
  // Tarjan SCC → comp id per node (numbered in reverse-topological order).
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const comp = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  let idx = 0;
  let nComp = 0;
  const strongConnect = (v: string): void => {
    index.set(v, idx); low.set(v, idx); idx++;
    stack.push(v); onStack.add(v);
    for (const w of succ.get(v)!) {
      if (!index.has(w)) { strongConnect(w); low.set(v, Math.min(low.get(v)!, low.get(w)!)); }
      else if (onStack.has(w)) { low.set(v, Math.min(low.get(v)!, index.get(w)!)); }
    }
    if (low.get(v) === index.get(v)) {
      for (;;) { const w = stack.pop()!; onStack.delete(w); comp.set(w, nComp); if (w === v) break; }
      nComp++;
    }
  };
  for (const v of podIds) if (!index.has(v)) strongConnect(v);
  // Longest-path rank on the condensation DAG (acyclic ⇒ Kahn never starves).
  const compSucc = new Map<number, Set<number>>();
  const compInDeg = new Map<number, number>();
  for (let c = 0; c < nComp; c++) { compSucc.set(c, new Set()); compInDeg.set(c, 0); }
  for (const [s, ts] of succ) {
    for (const t of ts) {
      const cs = comp.get(s)!, ct = comp.get(t)!;
      if (cs !== ct && !compSucc.get(cs)!.has(ct)) {
        compSucc.get(cs)!.add(ct);
        compInDeg.set(ct, (compInDeg.get(ct) ?? 0) + 1);
      }
    }
  }
  const compRank = new Map<number, number>();
  for (let c = 0; c < nComp; c++) compRank.set(c, 0);
  const queue: number[] = [];
  for (let c = 0; c < nComp; c++) if ((compInDeg.get(c) ?? 0) === 0) queue.push(c);
  while (queue.length) {
    const c = queue.shift()!;
    for (const d of compSucc.get(c)!) {
      compRank.set(d, Math.max(compRank.get(d) ?? 0, (compRank.get(c) ?? 0) + 1));
      compInDeg.set(d, (compInDeg.get(d) ?? 0) - 1);
      if ((compInDeg.get(d) ?? 0) <= 0) queue.push(d);
    }
  }
  const rank = new Map<string, number>(podIds.map((id) => [id, compRank.get(comp.get(id)!) ?? 0]));
  // Densify ranks → no gaps.
  const used = [...new Set(rank.values())].sort((a, b) => a - b);
  const dense = new Map(used.map((r, i) => [r, i]));
  for (const [id, r] of rank) rank.set(id, dense.get(r) ?? 0);
  return rank;
}

/** Horizontal box geometry shared by the layout packer and the live rect
 *  renderer (they MUST agree, or packing gaps drift): node extents + side
 *  padding, grown — centred — to the header width so a narrow cluster
 *  neither hangs its title off the right edge nor huddles its pods left.
 *  `label === null` ⇒ unboxed layer (no clusterBy): plain padded extents.
 *  `headerMinW` measures the box header for a given label (the renderer
 *  supplies the live alias / instance-word). */
export function clusterBoxX(
  minX: number,
  maxX: number,
  label: string | null,
  headerMinW: (label: string) => number,
): { x: number; w: number } {
  const contentW = maxX - minX + BOX_PAD_X * 2;
  const w = label === null ? contentW : Math.max(contentW, headerMinW(label));
  return { x: minX - BOX_PAD_X - (w - contentW) / 2, w };
}

/** Pure packer behind the view's `layout` computed. `clusters` carries the
 *  already-bucketed pods; `calls` are the raw instance relations; `showBoxes`
 *  is `!!clusterBy`. `headerMinW` is threaded through to `clusterBoxX`. */
export function computeLayout(
  clusters: ClusterBucket[],
  calls: Array<{ source: string; target: string }>,
  showBoxes: boolean,
  headerMinW: (label: string) => number,
): Layout {
  const pos = new Map<string, Pos>();
  const nodeToPod = new Map<string, string>();

  // node → podId, podId → clusterKey
  const podCluster = new Map<string, string | null>();
  for (const cl of clusters) {
    for (const pod of cl.pods) {
      const pid = podIdOf(cl.key, pod.siblingKey);
      podCluster.set(pid, cl.key);
      for (const node of [pod.main, ...pod.siblings]) nodeToPod.set(node.id, pid);
    }
  }
  // Directed pod edges (deduped). Intra-cluster ones drive pod flow order
  // WITHIN a box; inter-cluster ones (deduped at cluster granularity) drive the
  // left→right order of the boxes themselves.
  const intraByCluster = new Map<string, Array<[string, string]>>();
  const interEdges: Array<[string, string]> = [];
  const interSeen = new Set<string>();
  const seen = new Set<string>();
  for (const c of calls) {
    const sp = nodeToPod.get(c.source);
    const tp = nodeToPod.get(c.target);
    if (!sp || !tp || sp === tp) continue;
    const sig = `${sp}>${tp}`;
    if (seen.has(sig)) continue;
    seen.add(sig);
    const sc = podCluster.get(sp) ?? '';
    const tc = podCluster.get(tp) ?? '';
    if (sc === tc) {
      if (!intraByCluster.has(sc)) intraByCluster.set(sc, []);
      intraByCluster.get(sc)!.push([sp, tp]);
    } else {
      const isig = `${sc}>${tc}`;
      if (!interSeen.has(isig)) { interSeen.add(isig); interEdges.push([sc, tc]); }
    }
  }
  // Cluster order: rank the boxes along the inter-cluster call DAG (longest
  // path from sources, same ranker as the pods) so an upstream→downstream
  // chain — liaison → hot data → warm → cold — reads left→right. Raw in-degree
  // doesn't: with composite clustering, warm and cold receive a similar number
  // of edges and would order arbitrarily. Ties break by key.
  const clusterRank = rankPods(clusters.map((cl) => cl.key ?? ''), interEdges);
  const orderedClusters = [...clusters].sort((a, b) => {
    const ra = clusterRank.get(a.key ?? '') ?? 0;
    const rb = clusterRank.get(b.key ?? '') ?? 0;
    if (ra !== rb) return ra - rb;
    if (a.key === null) return 1;
    if (b.key === null) return -1;
    return a.key.localeCompare(b.key);
  });

  // All clusters flow in ONE left→right row (call-flow order). The canvas
  // pans/zooms and a service has only a handful of groupings, so there is no
  // row-wrap — every cluster box stays on the same line. Clusters are packed
  // by their VISIBLE box (node extents → same `clusterBoxX` math the rect
  // renderer uses), NOT by sub-column slot arithmetic: a slot is up to a full
  // POD_DX wider than the drawn box, which read as dead corridors between
  // boxes and a blank leading strip before the first one.
  let cursorX = 0;
  let maxW = 0;
  let clusterIdx = -1;
  for (const cl of orderedClusters) {
    clusterIdx++;
    const podById = new Map(cl.pods.map((p) => [podIdOf(cl.key, p.siblingKey), p]));
    const ids = [...podById.keys()];
    const rank = rankPods(ids, intraByCluster.get(cl.key ?? '') ?? []);
    // Group pods into COLUMNS by rank (rank = tier: hot→warm→cold left→right);
    // within a column order by main name and stack VERTICALLY, centred — so a
    // tier's nodes (e.g. 4 hot) form a vertical column and the chain flows
    // left→right. Mirrors the service map's BFS column layout.
    const maxRank = Math.max(0, ...ids.map((id) => rank.get(id) ?? 0));
    const rankCols: string[][] = Array.from({ length: maxRank + 1 }, () => []);
    for (const id of ids) rankCols[rank.get(id) ?? 0].push(id);
    for (const col of rankCols) col.sort((a, b) => podById.get(a)!.main.name.localeCompare(podById.get(b)!.main.name));
    // A tier column holds at most COL_CAP pods; overflow wraps into extra
    // sub-columns (so 9 hot pods → 3 sub-columns of 4/4/1). Each rank reserves
    // as many sub-columns as it needs; later ranks shift right accordingly.
    const COL_CAP = 4;
    const subColsPerRank = rankCols.map((c) => Math.max(1, Math.ceil(c.length / COL_CAP)));
    const headH = showBoxes ? HEAD_H : 0;
    // Pods are TOP-aligned (row 0 just under the header) so tiers line up; the
    // canvas pans/zooms to fit. Staggered: drop every other sub-column by half a
    // row so adjacent columns interleave — keeps long pod labels and cross-tier
    // edges from colliding on a rigid grid.
    // Cluster start rows zigzag (low-high-low) so adjacent clusters don't line
    // up flat; offset alternates by half the default height diff (50% of POD_DY).
    const rowTop = headH + CLUSTER_PAD + MAIN_R + (clusterIdx % 2 === 0 ? 1 : -1) * POD_DY * 0.25;
    const clusterNodeIds: string[] = [];
    let subColBase = 0;
    rankCols.forEach((col, r) => {
      col.forEach((pid, k) => {
        const pod = podById.get(pid)!;
        const subCol = Math.floor(k / COL_CAP);
        const rowInCol = k % COL_CAP;
        const cx = CLUSTER_PAD + (subColBase + subCol) * POD_DX + POD_DX / 2;
        const cy = rowTop + rowInCol * POD_DY + (subCol % 2) * (POD_DY / 2);
        pos.set(pod.main.id, { cx, cy, r: MAIN_R });
        clusterNodeIds.push(pod.main.id);
        pod.siblings.slice(0, SIB_ANGLES.length).forEach((sib, j) => {
          const a = SIB_ANGLES[j];
          pos.set(sib.id, { cx: cx + Math.cos(a) * SIB_DIST, cy: cy + Math.sin(a) * SIB_DIST, r: SIB_R });
          clusterNodeIds.push(sib.id);
        });
      });
      subColBase += subColsPerRank[r];
    });
    if (clusterNodeIds.length === 0) continue;
    // Shift the whole cluster so its visible box's left edge lands at cursorX.
    let minX = Infinity;
    let maxX = -Infinity;
    for (const id of clusterNodeIds) {
      const p = pos.get(id)!;
      minX = Math.min(minX, p.cx - p.r);
      maxX = Math.max(maxX, p.cx + p.r);
    }
    const box = clusterBoxX(minX, maxX, showBoxes ? cl.label : null, headerMinW);
    const shift = cursorX - box.x;
    for (const id of clusterNodeIds) pos.get(id)!.cx += shift;
    cursorX += box.w + CLUSTER_GAP_X;
    maxW = cursorX - CLUSTER_GAP_X;
  }
  // Canvas height from the ACTUAL node extents — a per-row reservation would
  // float the graph high with dead space below. Add room for the sibling
  // labels hanging beneath the lowest node.
  let contentBottom = 0;
  for (const p of pos.values()) contentBottom = Math.max(contentBottom, p.cy + p.r);
  const h = contentBottom > 0 ? contentBottom + 46 : 240;
  return { pos, w: Math.max(320, maxW), h: Math.max(240, h), nodeToPod };
}
