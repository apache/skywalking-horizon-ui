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
 * Pure BFS + column layout math for the API-dependency graph. Takes the
 * merged graph (`nodes` / `calls`) + the focus id and produces the
 * left-to-right column layout the SVG scene binds against: layer index per
 * node (BFS from focus, callers left / callees right), per-column node cap,
 * pixel positions, the drag-offset-folded `displayPos`, the SVG extent
 * (W / H + adaptive card height), and the bi-direction-aware curved edge
 * geometry. No fetch, no lifecycle — just geometry, so the view (and the
 * config-driven metric accessors it owns) stays in charge of the visuals.
 */

import { computed, type Ref } from 'vue';
import type {
  EndpointDependencyCall,
  EndpointDependencyNode,
  TopologyMetricDef,
} from '@/api/client';

// ── SVG layout math. The template binds NW / COL_GAP via these names; the
// view re-exports them so Vue's setup-script auto-binding stays happy.
export const NW = 152;
// Compact box: 3 tight stacked rows (service name / API name / RPM).
export const NH = 56;
// Gap between columns leaves room for the curved edge's line-metric
// chip (60-80px) without colliding with adjacent node boxes.
export const COL_GAP = 300;
export const ROW_GAP = 80;

// ── Per-layer cap: rank each column's nodes by the configured center
// metric and keep the top NODES_PER_LAYER; overflow is summarised.
const NODES_PER_LAYER = 8;

/**
 * Card height adapts to the graph the same way the topology view does:
 * 60% floor of a 780px baseline, capped at 1100px. Operators get a
 * consistent envelope across both dependency tabs.
 */
const CARD_BASELINE = 780;
const CARD_MIN = Math.round(CARD_BASELINE * 0.6);
const CARD_MAX = 1100;

export interface LayoutNode extends EndpointDependencyNode {
  layerIdx: number;
}
export interface LayerColumn {
  index: number;
  label: string;
  visible: LayoutNode[];
  hidden: number;
}
export interface Pos {
  x: number;
  y: number;
  col: number;
  row: number;
}

interface LayoutOptions {
  nodes: Ref<EndpointDependencyNode[]>;
  calls: Ref<EndpointDependencyCall[]>;
  focusedId: Ref<string | null>;
  /** Operator-configured `center` metric — drives the per-column ranking. */
  centerDef: Ref<TopologyMetricDef | null>;
  /** Resolve a node's value for a metric def (null when absent). */
  nodeVal: (n: EndpointDependencyNode, def: TopologyMetricDef | null) => number | null;
  /** Manual drag offsets layered on the BFS positions. */
  dragOffsets: Ref<Map<string, { dx: number; dy: number }>>;
  /** i18n translator — column labels (`L-1 · Callers`, …). */
  t: (key: string, named?: Record<string, unknown>) => string;
}

export function useEndpointDependencyLayout(opts: LayoutOptions) {
  const { nodes, calls, focusedId, centerDef, nodeVal, dragOffsets, t } = opts;

  const layoutNodes = computed<LayoutNode[]>(() => {
    const all = nodes.value;
    if (all.length === 0) return [];
    const focusId = focusedId.value;
    const byId = new Map(all.map((n) => [n.id, n]));
    const callsList = calls.value;
    const downstream = new Map<string, string[]>();
    const upstream = new Map<string, string[]>();
    for (const c of callsList) {
      if (!downstream.has(c.source)) downstream.set(c.source, []);
      downstream.get(c.source)!.push(c.target);
      if (!upstream.has(c.target)) upstream.set(c.target, []);
      upstream.get(c.target)!.push(c.source);
    }
    const layerOf = new Map<string, number>();
    if (focusId && byId.has(focusId)) {
      // ONE direction-aware BFS over the whole connected component: from
      // each reached node a downstream neighbour sits one layer right (+1),
      // an upstream neighbour one layer left (-1). A single combined pass —
      // not forward-only then backward-only — so cross-links land relative
      // to their own neighbour. The old two-pass version couldn't reach a
      // CALLER of a callee-of-focus (e.g. a node revealed by expanding a
      // downstream endpoint) and dumped it into a far straggler column.
      layerOf.set(focusId, 0);
      const queue = [focusId];
      while (queue.length > 0) {
        const id = queue.shift()!;
        const cur = layerOf.get(id)!;
        for (const target of downstream.get(id) ?? []) {
          if (!layerOf.has(target)) {
            layerOf.set(target, cur + 1);
            queue.push(target);
          }
        }
        for (const source of upstream.get(id) ?? []) {
          if (!layerOf.has(source)) {
            layerOf.set(source, cur - 1);
            queue.push(source);
          }
        }
      }
    }
    // Stragglers — genuinely disconnected nodes get a column just past the
    // rightmost real layer (not a hard-coded index that could collide).
    let maxLayer = 0;
    for (const v of layerOf.values()) if (v > maxLayer) maxLayer = v;
    let extra = maxLayer + 1;
    for (const n of all) {
      if (!layerOf.has(n.id)) {
        layerOf.set(n.id, extra++);
      }
    }
    return all.map((n) => ({ ...n, layerIdx: layerOf.get(n.id)! }));
  });

  const layerColumns = computed<LayerColumn[]>(() => {
    const byLayer = new Map<number, LayoutNode[]>();
    for (const n of layoutNodes.value) {
      if (!byLayer.has(n.layerIdx)) byLayer.set(n.layerIdx, []);
      byLayer.get(n.layerIdx)!.push(n);
    }
    const indices = [...byLayer.keys()].sort((a, b) => a - b);
    return indices.map((i) => {
      // Sort by the operator-configured `center` metric (typically RPM).
      // Falls back to the legacy `cpm` field when the config hasn't
      // arrived yet (first render before the BFF responds).
      const list = byLayer.get(i)!.slice().sort((a, b) => {
        const va = nodeVal(a, centerDef.value) ?? a.cpm ?? 0;
        const vb = nodeVal(b, centerDef.value) ?? b.cpm ?? 0;
        return vb - va;
      });
      const visible = list.slice(0, NODES_PER_LAYER);
      const hidden = list.length - visible.length;
      let label: string;
      // Focus = L0; layers to the LEFT (negative index) are the focus's
      // callers, to the RIGHT (positive) its callees. Labelled `Callers`
      // / `Callees` to match the node popout (Callers/Callees) and the
      // expand handles — the old `Upstream`/`Downstream` pair was both
      // ambiguous and inverted (nginx vs data-flow conventions clashed).
      if (i < 0) label = t('L{i} · Callers', { i });
      else if (i === 0) label = t('L0 · Focus');
      else label = t('L+{i} · Callees', { i });
      return { index: i, label, visible, hidden };
    });
  });

  const W = computed(() => Math.max(800, layerColumns.value.length * COL_GAP + 80));
  const H = computed(() => {
    const maxNodes = Math.max(1, ...layerColumns.value.map((c) => c.visible.length));
    return 80 + maxNodes * ROW_GAP + 40;
  });
  const cardHeightPx = computed<number>(() => {
    const ideal = H.value + 80;
    return Math.max(CARD_MIN, Math.min(CARD_MAX, ideal));
  });

  const nodePos = computed<Map<string, Pos>>(() => {
    const map = new Map<string, Pos>();
    layerColumns.value.forEach((col, colIdx) => {
      const x = 40 + colIdx * COL_GAP;
      col.visible.forEach((n, rowIdx) => {
        const y = 80 + rowIdx * ROW_GAP;
        map.set(n.id, { x, y, col: colIdx, row: rowIdx });
      });
    });
    return map;
  });

  // Drag offsets layer on the BFS positions so edges (which read displayPos) follow.
  const displayPos = computed<Map<string, Pos>>(() => {
    if (dragOffsets.value.size === 0) return nodePos.value;
    const out = new Map<string, Pos>();
    for (const [id, p] of nodePos.value) {
      const off = dragOffsets.value.get(id);
      out.set(id, off ? { ...p, x: p.x + off.dx, y: p.y + off.dy } : p);
    }
    return out;
  });

  const visibleCalls = computed<EndpointDependencyCall[]>(() => {
    const ids = new Set(nodePos.value.keys());
    return calls.value.filter((c) => ids.has(c.source) && ids.has(c.target));
  });

  // ── Bi-direction-aware curved edge geometry. Same rule as the service
  // map's `callPathD`: bow the arc to one side of the chord; for the
  // matching reverse call we bow the other side so both lines stay visible.
  // No arrowhead — animated traffic dots advertise direction.
  function hasReverse(c: EndpointDependencyCall): boolean {
    return calls.value.some((x) => x.source === c.target && x.target === c.source);
  }
  function bowSign(c: EndpointDependencyCall): number {
    if (!hasReverse(c)) return 0;
    return c.source < c.target ? 1 : -1;
  }
  function callPathD(c: EndpointDependencyCall): string {
    const a = displayPos.value.get(c.source);
    const b = displayPos.value.get(c.target);
    if (!a || !b) return '';
    const x1 = a.x + NW;
    const y1 = a.y + NH / 2;
    const x2 = b.x;
    const y2 = b.y + NH / 2;
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    const perpX = -uy;
    const perpY = ux;
    const bow = Math.min(30, Math.max(14, len * 0.10));
    const sign = bowSign(c);
    const amplitude = sign === 0 ? 12 : bow;
    const signed = sign === 0 ? -1 : sign;
    const ctrlX = (x1 + x2) / 2 + perpX * amplitude * signed;
    const ctrlY = (y1 + y2) / 2 + perpY * amplitude * signed;
    return `M ${x1} ${y1} Q ${ctrlX} ${ctrlY} ${x2} ${y2}`;
  }
  function callMidpoint(c: EndpointDependencyCall): { x: number; y: number } | null {
    const a = displayPos.value.get(c.source);
    const b = displayPos.value.get(c.target);
    if (!a || !b) return null;
    const x1 = a.x + NW;
    const y1 = a.y + NH / 2;
    const x2 = b.x;
    const y2 = b.y + NH / 2;
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    const perpX = -uy;
    const perpY = ux;
    const bow = Math.min(30, Math.max(14, len * 0.10));
    const sign = bowSign(c);
    const amplitude = sign === 0 ? 12 : bow;
    const signed = sign === 0 ? -1 : sign;
    return {
      x: (x1 + x2) / 2 + perpX * amplitude * signed * 0.55,
      y: (y1 + y2) / 2 + perpY * amplitude * signed * 0.55,
    };
  }

  return {
    layoutNodes,
    layerColumns,
    W,
    H,
    cardHeightPx,
    nodePos,
    displayPos,
    visibleCalls,
    callPathD,
    callMidpoint,
  };
}
