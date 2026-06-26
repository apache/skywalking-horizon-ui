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
 * Edge geometry model for the 3D infra scene.
 *
 * Resolves the four edge classes — intra-layer call, same-plane
 * cross-layer call (always-on), cross-plane cross-layer call
 * (selection-gated), and hierarchy (selection-gated) — into curves and
 * builds a TubeGeometry per visible edge. Each `*Tubes` computed mints a
 * fresh batch of `TubeGeometry` on every recompute (a layer-visibility
 * toggle or a selection change re-runs the `visible*Edges` deps); the
 * previous batch's GPU buffers would otherwise be abandoned, so a
 * `flush:'post'` watcher frees the prior batch once the new geometries
 * have rendered and the old meshes are detached. `disposeAll()` frees the
 * current batch on unmount.
 *
 * The visibility gates live in the Scene (`isVisible`, `selectedNodeId`)
 * and are passed in so this composable stays a pure transform over the
 * graph + placement.
 */
import { computed, watch, type ComputedRef, type Ref } from 'vue';
import { CatmullRomCurve3, Quaternion, TubeGeometry, Vector3 } from 'three';
import type {
  SceneCallEdge,
  SceneCrossLayerEdge,
  SceneGraph,
  SceneHierarchyEdge,
} from './useMapTopology';
import type { NodePlacement, ScenePlacement } from './useScenePlacement';

export interface VisibleCallEdge extends SceneCallEdge {
  curve: CatmullRomCurve3;
}
export interface VisibleCrossEdge extends SceneCrossLayerEdge {
  curve: CatmullRomCurve3;
  arrowPos: Vector3;
  arrowDir: Vector3;
  /** True when the endpoints sit on the same plane (no y delta). */
  intraLevel: boolean;
}
export interface VisibleHierarchyEdge extends SceneHierarchyEdge {
  curve: CatmullRomCurve3;
}

interface CrossTube {
  edge: VisibleCrossEdge;
  geometry: TubeGeometry;
  arrowQuat: Quaternion;
}

export interface SceneEdges {
  visibleCallEdges: ComputedRef<VisibleCallEdge[]>;
  visibleCrossEdges: ComputedRef<VisibleCrossEdge[]>;
  visibleVerticalEdges: ComputedRef<VisibleCrossEdge[]>;
  visibleHierarchyEdges: ComputedRef<VisibleHierarchyEdge[]>;
  callTubes: ComputedRef<{ edge: VisibleCallEdge; geometry: TubeGeometry }[]>;
  crossTubes: ComputedRef<CrossTube[]>;
  verticalTubes: ComputedRef<CrossTube[]>;
  hierarchyTubes: ComputedRef<{ edge: VisibleHierarchyEdge; geometry: TubeGeometry }[]>;
  disposeAll: () => void;
}

/**
 * @param graph             scene graph (call / cross-layer / hierarchy edges).
 * @param placement         resolved node positions.
 * @param isVisible         layer-visibility gate (side-panel eye toggles).
 * @param selectedNodeId    reactive selection — gates the cross-plane +
 *                          hierarchy edge sets.
 */
export function useSceneEdges(
  graph: SceneGraph,
  placement: ScenePlacement,
  isVisible: (layerKey: string) => boolean,
  selectedNodeId: Ref<string | null>,
): SceneEdges {
  // Intra-layer call edges — same plane, both endpoints in the same
  // layer. Rendered as cyan translucent tubes; traffic packets travel
  // along these.
  const visibleCallEdges = computed<VisibleCallEdge[]>(() => {
    const out: VisibleCallEdge[] = [];
    for (const L of graph.layers) {
      if (!isVisible(L.key)) continue;
      for (const e of L.callEdges) {
        const a = placement.nodes.get(e.fromNodeId);
        const b = placement.nodes.get(e.toNodeId);
        if (!a || !b) continue;
        const mid = new Vector3((a.x + b.x) / 2, a.y + 0.9, (a.z + b.z) / 2);
        const curve = new CatmullRomCurve3([
          new Vector3(a.x, a.y + 0.45, a.z),
          mid,
          new Vector3(b.x, b.y + 0.45, b.z),
        ]);
        out.push({ ...e, curve });
      }
    }
    return out;
  });

  function buildCrossEdgeCurve(a: NodePlacement, b: NodePlacement): {
    curve: CatmullRomCurve3;
    arrowPos: Vector3;
    arrowDir: Vector3;
    intraLevel: boolean;
  } {
    const dy = Math.abs(b.y - a.y);
    const intraLevel = dy < 0.1;
    // Same-plane → small bump; cross-plane → larger arch scaling with the
    // y gap so two opposite-direction vertical tubes don't visually collide.
    const horiz = Math.hypot(b.x - a.x, b.z - a.z);
    const arch = intraLevel
      ? 0.6 + Math.min(horiz * 0.05, 0.8)
      : 1.2 + dy * 0.25;
    const archY = Math.max(a.y, b.y) + arch;
    const mid = new Vector3((a.x + b.x) / 2, archY, (a.z + b.z) / 2);
    const tip = new Vector3(b.x, b.y + 0.55, b.z);
    const curve = new CatmullRomCurve3([
      new Vector3(a.x, a.y + 0.55, a.z),
      mid,
      tip,
    ]);
    // Sample just shy of the tip so the arrow points along the actual
    // curve tangent, not the straight chord.
    const near = curve.getPoint(0.94);
    const arrowDir = new Vector3().subVectors(tip, near).normalize();
    return { curve, arrowPos: tip, arrowDir, intraLevel };
  }

  /** Same-plane cross-layer edges — always visible. */
  const visibleCrossEdges = computed<VisibleCrossEdge[]>(() => {
    const out: VisibleCrossEdge[] = [];
    for (const e of graph.crossLayerEdges) {
      if (!isVisible(e.fromLayer) || !isVisible(e.toLayer)) continue;
      const a = placement.nodes.get(e.fromNodeId);
      const b = placement.nodes.get(e.toNodeId);
      if (!a || !b) continue;
      const built = buildCrossEdgeCurve(a, b);
      if (!built.intraLevel) continue; // cross-plane → selection-gated list
      out.push({ ...e, ...built });
    }
    return out;
  });

  /** Cross-plane cross-layer edges — only shown when the selected cube
   *  is one of the endpoints. "Show this cube's relatives once." */
  const visibleVerticalEdges = computed<VisibleCrossEdge[]>(() => {
    const sel = selectedNodeId.value;
    if (!sel) return [];
    const out: VisibleCrossEdge[] = [];
    for (const e of graph.crossLayerEdges) {
      if (e.fromNodeId !== sel && e.toNodeId !== sel) continue;
      if (!isVisible(e.fromLayer) || !isVisible(e.toLayer)) continue;
      const a = placement.nodes.get(e.fromNodeId);
      const b = placement.nodes.get(e.toNodeId);
      if (!a || !b) continue;
      const built = buildCrossEdgeCurve(a, b);
      if (built.intraLevel) continue; // intra-level → already in the always-on list
      out.push({ ...e, ...built });
    }
    return out;
  });

  /** Hierarchy edges — peers of the SELECTED cube only. They tell
   *  identity ("same logical service across layers"), not traffic; drawn
   *  only on selection so the static view stays uncluttered. */
  const visibleHierarchyEdges = computed<VisibleHierarchyEdge[]>(() => {
    const sel = selectedNodeId.value;
    if (!sel) return [];
    const out: VisibleHierarchyEdge[] = [];
    for (const e of graph.hierarchyEdges) {
      if (e.fromNodeId !== sel && e.toNodeId !== sel) continue;
      const a = placement.nodes.get(e.fromNodeId);
      const b = placement.nodes.get(e.toNodeId);
      if (!a || !b) continue;
      const fromNode = graph.nodesByKey.get(e.fromNodeId);
      const toNode = graph.nodesByKey.get(e.toNodeId);
      if (!fromNode || !toNode) continue;
      if (!isVisible(fromNode.layerKey) || !isVisible(toNode.layerKey)) continue;
      const dy = Math.abs(b.y - a.y);
      const archY = (a.y + b.y) / 2 + 0.8 + dy * 0.2;
      const mid = new Vector3((a.x + b.x) / 2, archY, (a.z + b.z) / 2);
      const curve = new CatmullRomCurve3([
        new Vector3(a.x, a.y + 0.55, a.z),
        mid,
        new Vector3(b.x, b.y + 0.55, b.z),
      ]);
      out.push({ ...e, curve });
    }
    return out;
  });

  const callTubes = computed(() =>
    visibleCallEdges.value.map((e) => ({
      edge: e,
      geometry: new TubeGeometry(e.curve, 16, 0.04, 6, false),
    })),
  );

  function buildCrossTubes(edges: VisibleCrossEdge[]): CrossTube[] {
    return edges.map((e) => ({
      edge: e,
      geometry: new TubeGeometry(e.curve, 32, 0.06, 8, false),
      // Quaternion that rotates the cone's default +Y axis onto the edge
      // direction. Composed here so the template stays declarative.
      arrowQuat: new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), e.arrowDir),
    }));
  }
  const crossTubes = computed(() => buildCrossTubes(visibleCrossEdges.value));
  const verticalTubes = computed(() => buildCrossTubes(visibleVerticalEdges.value));

  const hierarchyTubes = computed(() =>
    visibleHierarchyEdges.value.map((e) => ({
      edge: e,
      // Radius bumped above the intra/cross tube widths so the gray
      // hierarchy tube reads as the "identity" link even when many edges
      // share the same screen region around a selected cube.
      geometry: new TubeGeometry(e.curve, 24, 0.07, 8, false),
    })),
  );

  function disposeTubeBatch(batch: ReadonlyArray<{ geometry: TubeGeometry }>): void {
    for (const t of batch) t.geometry.dispose();
  }
  watch(callTubes, (_now, prev) => disposeTubeBatch(prev), { flush: 'post' });
  watch(crossTubes, (_now, prev) => disposeTubeBatch(prev), { flush: 'post' });
  watch(verticalTubes, (_now, prev) => disposeTubeBatch(prev), { flush: 'post' });
  watch(hierarchyTubes, (_now, prev) => disposeTubeBatch(prev), { flush: 'post' });

  function disposeAll(): void {
    for (const t of callTubes.value) t.geometry.dispose();
    for (const t of crossTubes.value) t.geometry.dispose();
    for (const t of verticalTubes.value) t.geometry.dispose();
    for (const t of hierarchyTubes.value) t.geometry.dispose();
  }

  return {
    visibleCallEdges,
    visibleCrossEdges,
    visibleVerticalEdges,
    visibleHierarchyEdges,
    callTubes,
    crossTubes,
    verticalTubes,
    hierarchyTubes,
    disposeAll,
  };
}
