<!--
  Licensed to the Apache Software Foundation (ASF) under one or more
  contributor license agreements.  See the NOTICE file distributed with
  this work for additional information regarding copyright ownership.
  The ASF licenses this file to You under the Apache License, Version 2.0
  (the "License"); you may not use this file except in compliance with
  the License.  You may obtain a copy of the License at

      http://www.apache.org/licenses/LICENSE-2.0

  Unless required by applicable law or agreed to in writing, software
  distributed under the License is distributed on an "AS IS" BASIS,
  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
  See the License for the specific language governing permissions and
  limitations under the License.
-->
<!--
  Per-layer Topology tab — left-to-right hierarchical service map with
  circular nodes.

  Layout
    User nodes (`isReal === false` OR `name === 'User'`) anchor column 0.
    BFS depth from there decides each node's column. Within a column
    nodes are sorted by RPM (descending) so the heavy lanes stay
    visually aligned across columns.

  Visual binding
    Every visual channel reads from the LAYER TEMPLATE's `topology`
    block (delivered in the response's `config` field):
      - the metric with `role: 'center'`     → number printed inside
                                                the circle, with its
                                                configured unit
      - the metric with `role: 'ring'`       → SLA-style colour band on
                                                the circle's perimeter
      - the metric with `role: 'secondary'`  → surfaced in detail panel
                                                + node tooltip
      - linkServerMetrics[`role: lineServer`] / linkClientMetrics[`role: lineClient`]
        → edge thickness; server has priority, client is the fallback.
    Nothing is hardcoded; swapping `mqe` / `unit` / `role` in the layer
    JSON is enough to repaint.

  Heaviest path
    Greedy walk from the highest-traffic entry. At each step we pick
    the outgoing edge with the highest server-cpm, falling back to
    client-cpm when server is null (per operator direction). The
    accent stroke highlights the dominant call lane.

  Large graphs
    Columns cap at NODES_PER_LAYER by RPM; overflow folds into a
    "+N more" chip per column. The whole SVG sits in an overflow:auto
    scroll container.
-->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import * as d3 from 'd3';
import { useRoute, useRouter } from 'vue-router';
import type {
  LayerDef,
  TopologyCall,
  TopologyMetricDef,
  TopologyNode,
} from '@/api/client';
import { useLayerTopology } from '@/composables/useLayerTopology';
import { useLayerLanding } from '@/composables/useLayerLanding';
import { useLayers } from '@/composables/useLayers';
import { useSetupStore } from '@/stores/setup';
import { fmtMetric } from '@/utils/formatters';
import { parseServiceName, serviceBaseName } from '@/utils/serviceName';
import Sparkline from '@/components/charts/Sparkline.vue';
import { isUserNode } from '@/composables/useTopologyIcons';

const route = useRoute();
const router = useRouter();
const layerKey = computed(() => String(route.params.layerKey ?? ''));

const { layers } = useLayers();
const layer = computed<LayerDef | null>(
  () => layers.value.find((l) => l.key === layerKey.value) ?? null,
);
const store = useSetupStore();
const safeLayer = computed<LayerDef>(() => layer.value ?? {
  key: layerKey.value, name: layerKey.value, color: 'var(--sw-fg-2)',
  serviceCount: -1, active: false, level: null, slots: {}, caps: {},
});
const safeCfg = computed(() => {
  if (!layer.value) return { priority: 99, topN: 5, orderBy: 'cpm', columns: [], style: 'table' as const };
  return store.ensure(layer.value.key, {
    slots: layer.value.slots, caps: layer.value.caps, metrics: layer.value.metrics, overview: layer.value.overview,
  }).landing;
});
const landing = useLayerLanding(safeLayer, safeCfg);
const landingRows = computed(() => landing.data.value?.sampledRows ?? landing.rows.value ?? []);

// Focus-service is local to the topology view (NOT the header's
// `useSelectedService` — the topology map is layer-wide by default).
//   - empty array = no focus, BFF seeds from up-to-30 services in the
//     layer for a layer-overview graph
//   - one or more entries = comma-joined and passed as `?service=` so
//     the BFF seeds BFS from each selected service (multi-select)
const focusServiceNames = ref<string[]>([]);
const focusSearch = ref<string>('');
const focusPickerOpen = ref(false);
function toggleFocusPicker(): void { focusPickerOpen.value = !focusPickerOpen.value; }
function toggleService(name: string): void {
  const i = focusServiceNames.value.indexOf(name);
  if (i >= 0) focusServiceNames.value.splice(i, 1);
  else focusServiceNames.value.push(name);
}
function clearFocus(): void { focusServiceNames.value = []; focusPickerOpen.value = false; }
const serviceName = computed<string | null>(() =>
  focusServiceNames.value.length === 0 ? null : focusServiceNames.value.join(','),
);

// Service-list rows grouped by `<group>::` prefix so the search panel
// can render "agent" / "mesh" / "" sections.
interface GroupedRow { group: string | null; name: string; id: string }
const groupedRows = computed<Map<string, GroupedRow[]>>(() => {
  const map = new Map<string, GroupedRow[]>();
  const term = focusSearch.value.trim().toLowerCase();
  for (const r of landingRows.value) {
    const { group, base } = parseServiceName(r.serviceName);
    if (term && !r.serviceName.toLowerCase().includes(term)) continue;
    const key = group ?? '';
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push({ group, name: base, id: r.serviceId });
  }
  return map;
});

// Defensive truncate for long node labels — preserves the head + an
// ellipsis so cluster IDs that share a long prefix still distinguish.
function truncateLabel(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 2) + '…' : s;
}

const depth = ref<number>(2);
const { nodes, calls, isLoading, isFetching, data, refetch } = useLayerTopology(
  layerKey,
  serviceName,
  depth,
);
const reachable = computed(() => data.value?.reachable !== false);
const errorText = computed(() => data.value?.error ?? null);

// ── Config from response (operator-edited layer JSON). Falls back to
// an empty config when the BFF hasn't responded yet — the renderer
// degrades gracefully to neutral colours / no number.
const cfg = computed(() => data.value?.config ?? {
  nodeMetrics: [] as TopologyMetricDef[],
  linkServerMetrics: [] as TopologyMetricDef[],
  linkClientMetrics: [] as TopologyMetricDef[],
});
function pickByRole(defs: TopologyMetricDef[], role: TopologyMetricDef['role']): TopologyMetricDef | null {
  return defs.find((d) => d.role === role) ?? null;
}
/**
 * Per-user threshold overrides take precedence over the template's
 * defaults. The setup store keys them by `<scope>.<metricId>`. We
 * patch the `thresholds` block on a copy of the metric def before
 * any threshold-driven colour band is computed.
 */
const setupCfg = computed(() => store.ensure(layerKey.value, {
  slots: safeLayer.value.slots,
  caps: safeLayer.value.caps,
  metrics: safeLayer.value.metrics,
  overview: safeLayer.value.overview,
}));
function mergeThresholdOverride(def: TopologyMetricDef, scope: 'topology' | 'dependency'): TopologyMetricDef {
  const ov = setupCfg.value.landing.thresholdOverrides?.[`${scope}.${def.id}`];
  if (!ov) return def;
  return {
    ...def,
    thresholds: {
      ...(def.thresholds ?? {}),
      ...(ov.ok !== undefined ? { ok: ov.ok } : {}),
      ...(ov.warn !== undefined ? { warn: ov.warn } : {}),
      ...(ov.danger !== undefined ? { danger: ov.danger } : {}),
      ...(ov.invertHealth !== undefined ? { invertHealth: ov.invertHealth } : {}),
      ...(ov.invertBase !== undefined ? { invertBase: ov.invertBase } : {}),
    },
  };
}
const ringDef = computed(() => {
  const def = pickByRole(cfg.value.nodeMetrics, 'ring');
  return def ? mergeThresholdOverride(def, 'topology') : null;
});
const centerDef = computed(() => pickByRole(cfg.value.nodeMetrics, 'center'));
const secondaryDef = computed(() => pickByRole(cfg.value.nodeMetrics, 'secondary'));
// (lineServerDef / lineClientDef were only used by the dropped
// heaviest-path overlay. The on-canvas edge chip now reads RPM
// directly off cfg.linkServerMetrics / linkClientMetrics via id.)

function nodeVal(n: TopologyNode, def: TopologyMetricDef | null): number | null {
  if (!def) return null;
  const v = n.metrics?.[def.id];
  return v ?? null;
}
function edgeVal(
  c: TopologyCall,
  side: 'server' | 'client',
  def: TopologyMetricDef | null,
): number | null {
  if (!def) return null;
  const bucket = side === 'server' ? c.serverMetrics : c.clientMetrics;
  const v = bucket?.[def.id];
  return v ?? null;
}
/** Per-bucket series for the edge sidebar's twin sparklines. */
function edgeSeries(
  c: TopologyCall,
  side: 'server' | 'client',
  def: TopologyMetricDef | null,
): Array<number | null> {
  if (!def) return [];
  const bucket = side === 'server' ? c.serverMetricSeries : c.clientMetricSeries;
  return bucket?.[def.id] ?? [];
}
function seriesAt(arr: Array<number | null>, idx: number): number | null {
  if (idx < 0 || idx >= arr.length) return null;
  return arr[idx];
}

// ── Synced crosshair across the client + server sparklines of one
// edge-metric row. Hovering either chart drives a hairline + dot on
// BOTH charts; a small tooltip surfaces the per-bucket values plus
// the client/server diff so the operator can read the comparison
// without doing the maths in their head. Single-row scope: only one
// row can be hovered at a time. -------------------------------------
const hoveredEdgeRowId = ref<string | null>(null);
const hoveredEdgeBucket = ref<number | null>(null);
function onEdgeBucketHover(rowId: string, bucket: number): void {
  hoveredEdgeRowId.value = rowId;
  hoveredEdgeBucket.value = bucket;
}
function onEdgeBucketLeave(): void {
  hoveredEdgeRowId.value = null;
  hoveredEdgeBucket.value = null;
}
function rowCrosshair(rowId: string): number | null {
  return hoveredEdgeRowId.value === rowId ? hoveredEdgeBucket.value : null;
}
function diffAt(row: EdgeRow, bucket: number | null): number | null {
  if (bucket === null || !row.clientDef || !row.serverDef || !selectedCall.value) return null;
  const c = seriesAt(edgeSeries(selectedCall.value, 'client', row.clientDef), bucket);
  const s = seriesAt(edgeSeries(selectedCall.value, 'server', row.serverDef), bucket);
  if (c === null || s === null) return null;
  return s - c;
}
function diffColor(d: number | null): string {
  if (d === null || Math.abs(d) < 0.001) return 'var(--sw-fg-3)';
  return d > 0 ? 'var(--sw-warn)' : 'var(--sw-ok)';
}
function diffText(d: number | null): string {
  if (d === null) return '—';
  return (d >= 0 ? '+' : '') + fmtMetric(d);
}

// ── Layered layout (BFS depth from entry points).
interface LayoutNode extends TopologyNode {
  layerIdx: number;
}
/** Only the literal `User` node OAP emits counts as the entry-user.
 *  Synthetic non-real nodes (localhost:-1, external IPs) are NOT users;
 *  they're unattributed callers and we render them with their own
 *  cloud-shaped icon so the operator can tell them apart. */
function isUser(n: TopologyNode): boolean {
  return isUserNode(n);
}
const layoutNodes = computed<LayoutNode[]>(() => {
  const all = nodes.value;
  if (all.length === 0) return [];
  const callsList = calls.value;
  const downstream = new Map<string, string[]>();
  const upstream = new Map<string, string[]>();
  for (const c of callsList) {
    if (!downstream.has(c.source)) downstream.set(c.source, []);
    downstream.get(c.source)!.push(c.target);
    if (!upstream.has(c.target)) upstream.set(c.target, []);
    upstream.get(c.target)!.push(c.source);
  }
  const userIds = new Set(all.filter(isUser).map((n) => n.id));
  const roots: string[] = [...userIds];
  for (const n of all) {
    if (userIds.has(n.id)) continue;
    if ((upstream.get(n.id) ?? []).length === 0) roots.push(n.id);
  }
  if (roots.length === 0) {
    const focus = all.find((n) => n.name === serviceName.value);
    if (focus) roots.push(focus.id);
    else {
      const sorted = [...all].sort((a, b) => (nodeVal(b, centerDef.value) ?? 0) - (nodeVal(a, centerDef.value) ?? 0));
      if (sorted[0]) roots.push(sorted[0].id);
    }
  }
  const layerOf = new Map<string, number>();
  for (const r of roots) layerOf.set(r, 0);
  let changed = true;
  let safety = all.length + 8;
  while (changed && safety-- > 0) {
    changed = false;
    for (const c of callsList) {
      const s = layerOf.get(c.source);
      if (s === undefined) continue;
      const tCur = layerOf.get(c.target);
      const want = s + 1;
      if (tCur === undefined || want > tCur) {
        layerOf.set(c.target, want);
        changed = true;
      }
    }
  }
  const maxLayer = Math.max(0, ...layerOf.values());
  for (const n of all) {
    if (!layerOf.has(n.id)) layerOf.set(n.id, maxLayer + 1);
  }
  return all.map((n) => ({ ...n, layerIdx: layerOf.get(n.id)! }));
});

// (Heaviest-path overlay removed — every edge now reads as equally
// important. The line is constant-weight; direction is conveyed by an
// animated dashed flow on every edge.)

const NODES_PER_LAYER = 12;
interface LayerColumn {
  index: number;
  label: string;
  visible: LayoutNode[];
  hidden: number;
}
const layerColumns = computed<LayerColumn[]>(() => {
  const byLayer = new Map<number, LayoutNode[]>();
  for (const n of layoutNodes.value) {
    if (!byLayer.has(n.layerIdx)) byLayer.set(n.layerIdx, []);
    byLayer.get(n.layerIdx)!.push(n);
  }
  const indices = [...byLayer.keys()].sort((a, b) => a - b);

  // Pass 1 — keep the top-N busiest nodes per column (metric-driven
  // overflow). Order within `keep` is unimportant here; pass 2 fixes
  // it via barycentric reorder.
  const buckets = indices.map((i) => {
    const list = byLayer.get(i)!.slice().sort((a, b) => {
      return (nodeVal(b, centerDef.value) ?? 0) - (nodeVal(a, centerDef.value) ?? 0);
    });
    const keep = list.slice(0, NODES_PER_LAYER);
    const hidden = Math.max(0, list.length - NODES_PER_LAYER);
    return { keep, hidden };
  });

  // Pass 2 — barycentric sweep to minimise edge crossings. For each
  // column, sort its nodes by the average row index of their connected
  // neighbours in the adjacent column (incoming on the forward sweep,
  // outgoing on the backward sweep). Three iterations is enough to
  // converge for graph sizes the topology view caps at; further
  // iterations don't change the order meaningfully.
  const callsList = calls.value;
  const callsBySource = new Map<string, string[]>();
  const callsByTarget = new Map<string, string[]>();
  for (const c of callsList) {
    (callsBySource.get(c.source) ?? callsBySource.set(c.source, []).get(c.source)!).push(c.target);
    (callsByTarget.get(c.target) ?? callsByTarget.set(c.target, []).get(c.target)!).push(c.source);
  }
  function rowOf(id: string, col: LayoutNode[]): number {
    const i = col.findIndex((n) => n.id === id);
    return i < 0 ? -1 : i;
  }
  function barycenter(id: string, neighbourCol: LayoutNode[], edges: Map<string, string[]>): number {
    const out = edges.get(id) ?? [];
    if (out.length === 0 || neighbourCol.length === 0) return Number.POSITIVE_INFINITY;
    let acc = 0;
    let n = 0;
    for (const t of out) {
      const r = rowOf(t, neighbourCol);
      if (r >= 0) { acc += r; n++; }
    }
    return n === 0 ? Number.POSITIVE_INFINITY : acc / n;
  }
  for (let pass = 0; pass < 3; pass++) {
    // Forward sweep — column i ordered by its left neighbour (i-1).
    for (let i = 1; i < buckets.length; i++) {
      const left = buckets[i - 1].keep;
      buckets[i].keep = buckets[i].keep.slice().sort((a, b) => {
        return barycenter(a.id, left, callsByTarget) - barycenter(b.id, left, callsByTarget);
      });
    }
    // Backward sweep — column i ordered by its right neighbour (i+1).
    for (let i = buckets.length - 2; i >= 0; i--) {
      const right = buckets[i + 1].keep;
      buckets[i].keep = buckets[i].keep.slice().sort((a, b) => {
        return barycenter(a.id, right, callsBySource) - barycenter(b.id, right, callsBySource);
      });
    }
  }

  return indices.map((i, idx) => {
    const label = i === 0 ? 'L0 · Entry' : `L${i} · Tier ${i}`;
    return { index: i, label, visible: buckets[idx].keep, hidden: buckets[idx].hidden };
  });
});

// ── SVG layout math (circles).
/**
 * Node geometry — radius drives the cube/icon size and the column
 * spacing. Sized smaller than the design's r=42 so a chain reads
 * comfortably on a 12" laptop without horizontal scroll; metrics
 * text sits beneath the node with a larger size to compensate.
 */
const NODE_R = 32;
const COL_GAP = 240;
const ROW_GAP = NODE_R * 2 + 90;
const W = computed(() => Math.max(820, layerColumns.value.length * COL_GAP + 80));
const H = computed(() => {
  const maxNodes = Math.max(1, ...layerColumns.value.map((c) => c.visible.length));
  return 90 + maxNodes * ROW_GAP + 40;
});

/**
 * Card height adapts to the graph's actual size with a 60% floor of
 * the operator-friendly minimum, capped above to keep the screen
 * tidy on huge graphs. The floor is 60% of `780px` so a 1-row chain
 * doesn't shrink to a sliver, while a 4-row fan-out gets the full
 * `780px+` envelope automatically.
 */
const CARD_BASELINE = 780;
const CARD_MIN = Math.round(CARD_BASELINE * 0.6); // 468px
const CARD_MAX = 1100;
const cardHeightPx = computed<number>(() => {
  // Add chrome (toolbar header, the inner 90+40 already inside H,
  // small margin). The SVG content dictates the rest.
  const ideal = H.value + 80;
  return Math.max(CARD_MIN, Math.min(CARD_MAX, ideal));
});
interface Pos { cx: number; cy: number }

// Drag overrides — populated by d3.drag on each node. Once a user
// drops a node anywhere on the canvas, its (cx, cy) is pinned here and
// `nodePos` uses the override instead of the column layout. Dragging
// re-routes every connected edge automatically because `callPathD`
// pulls live coordinates from `nodePos`. The map is keyed by service
// id so it survives layer re-render as long as the same services come
// back. Cleared whenever the underlying node set changes meaningfully
// (different layer / refresh blowing away the topology).
const dragOverrides = ref<Map<string, Pos>>(new Map());
watch(
  () => layoutNodes.value.map((n) => n.id).sort().join('|'),
  (curr, prev) => {
    if (prev !== undefined && curr !== prev) dragOverrides.value = new Map();
  },
);

const nodePos = computed<Map<string, Pos>>(() => {
  const map = new Map<string, Pos>();
  layerColumns.value.forEach((col, colIdx) => {
    const cx = 40 + colIdx * COL_GAP + NODE_R + 4;
    col.visible.forEach((n, rowIdx) => {
      const cy = 110 + rowIdx * ROW_GAP + NODE_R;
      map.set(n.id, { cx, cy });
    });
  });
  // Drag overrides win — but only when the node is still in the
  // visible set, so a stale id from a previous layer doesn't bleed.
  for (const [id, p] of dragOverrides.value) {
    if (map.has(id)) map.set(id, p);
  }
  return map;
});
const visibleCalls = computed<TopologyCall[]>(() => {
  const ids = new Set(nodePos.value.keys());
  return calls.value.filter((c) => ids.has(c.source) && ids.has(c.target));
});
const elidedTotal = computed(() =>
  layerColumns.value.reduce((acc, c) => acc + c.hidden, 0),
);

/**
 * Resolve the 4-band colour for a node from the ring-metric value.
 * Operator-configured thresholds (in the metric def's `thresholds`
 * block) win when present; otherwise falls back to the historical
 * heuristic (error % at 0.1 / 1 / 5).
 */
function bandColor(value: number, t: NonNullable<TopologyMetricDef['thresholds']>): string {
  const invertBase = t.invertBase ?? 100;
  const v = t.invertHealth ? Math.max(0, invertBase - value) : value;
  const ok = t.ok ?? 0.1;
  const warn = t.warn ?? 1;
  const danger = t.danger ?? 5;
  if (v > danger) return 'var(--sw-err)';
  if (v > warn) return 'var(--sw-warn)';
  if (v > ok) return '#fbbf24';
  return 'var(--sw-ok)';
}
function ringColor(n: TopologyNode): string {
  const def = ringDef.value;
  if (!def) return 'var(--sw-line-2)';
  const v = nodeVal(n, def);
  if (v === null) return 'var(--sw-fg-3)';
  if (def.thresholds) return bandColor(v, def.thresholds);
  // Legacy heuristic — for "higher is healthier" metrics (SLA /
  // apdex / success rate) we invert; otherwise treat higher as worse.
  const isHealthHigh = /sla|success|apdex/i.test(def.id) || /sla|apdex|success/i.test(def.label);
  const errPct = isHealthHigh ? Math.max(0, 100 - v) : v;
  if (errPct > 5) return 'var(--sw-err)';
  if (errPct > 1) return 'var(--sw-warn)';
  if (errPct > 0.1) return '#fbbf24';
  return 'var(--sw-ok)';
}
/**
 * Node kind — drives the icon shape rendered inside the ring. We map
 * each topology node to one of three SVG icon families, matching the
 * polished linear-chain design spec:
 *
 *   - `client`   — entry caller (literal `User` node OAP emits).
 *                  Drawn as a stylised user silhouette pair.
 *   - `external` — synthetic non-real callee (localhost:-1 / external
 *                  endpoint). Drawn as a cloud with a `?` glyph.
 *   - `service`  — every other real node. Drawn as a 3D box made of
 *                  three polygons to keep the booster-ui feel.
 */
function nodeKind(n: TopologyNode): 'client' | 'service' | 'external' {
  if (n.name === 'User') return 'client';
  if (!n.isReal) return 'external';
  return 'service';
}
/** Pick the edge metric to surface as a label. RPM-only by design —
 *  the canvas chip stays compact and consistent across layers. Other
 *  line metrics (latency, p95, SLA) are still available in the right
 *  sidebar's per-edge detail. Server-side wins; client falls back. */
function edgeLabel(c: TopologyCall): { value: number; unit: string; isClient: boolean } | null {
  const sList = cfg.value.linkServerMetrics ?? [];
  const cList = cfg.value.linkClientMetrics ?? [];
  const sRpm = sList.find((m) => m.id === 'cpm') ?? null;
  const cRpm = cList.find((m) => m.id === 'cpm') ?? null;
  if (sRpm) {
    const v = edgeVal(c, 'server', sRpm);
    if (v !== null) return { value: v, unit: sRpm.unit ?? 'rpm', isClient: false };
  }
  if (cRpm) {
    const v = edgeVal(c, 'client', cRpm);
    if (v !== null) return { value: v, unit: cRpm.unit ?? 'rpm', isClient: true };
  }
  return null;
}
/**
 * True when this call has a mirror in the opposite direction. We
 * use a deterministic offset sign (`source < target` ? +1 : -1) so
 * the two arcs of a bi-directional pair always go to opposite sides
 * of the midline regardless of iteration order.
 */
function hasReverse(c: TopologyCall): boolean {
  return calls.value.some((x) => x.source === c.target && x.target === c.source);
}
function bowSign(c: TopologyCall): number {
  if (!hasReverse(c)) return 0;
  return c.source < c.target ? 1 : -1;
}
/**
 * Curved edge between two node circles. The bow keeps the line from
 * disappearing into a straight pipe between adjacent columns; for
 * bi-directional pairs the two arcs bow to opposite sides so both
 * lines are visible. Arrow heads are deliberately omitted — the
 * animated traffic dots already advertise direction.
 */
function callPathD(c: TopologyCall): string {
  const a = nodePos.value.get(c.source);
  const b = nodePos.value.get(c.target);
  if (!a || !b) return '';
  const dx = b.cx - a.cx;
  const dy = b.cy - a.cy;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const x1 = a.cx + ux * NODE_R;
  const y1 = a.cy + uy * NODE_R;
  const x2 = b.cx - ux * NODE_R;
  const y2 = b.cy - uy * NODE_R;
  const perpX = -uy;
  const perpY = ux;
  const bow = Math.min(30, Math.max(14, len * 0.10));
  const sign = bowSign(c);
  // Pure-arc curves are flat for non-reversed edges; the sign === 0
  // case still bows a touch (12px) so adjacent columns don't read as
  // a straight pipe.
  const amplitude = sign === 0 ? 12 : bow;
  const signed = sign === 0 ? -1 : sign;
  const cx = (x1 + x2) / 2 + perpX * amplitude * signed;
  const cy = (y1 + y2) / 2 + perpY * amplitude * signed;
  return `M ${x1} ${y1} Q ${cx} ${cy} ${x2} ${y2}`;
}
function edgeMidpoint(c: TopologyCall): { x: number; y: number } | null {
  const a = nodePos.value.get(c.source);
  const b = nodePos.value.get(c.target);
  if (!a || !b) return null;
  const dx = b.cx - a.cx;
  const dy = b.cy - a.cy;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const perpX = -uy;
  const perpY = ux;
  const bow = Math.min(30, Math.max(14, len * 0.10));
  const sign = bowSign(c);
  const amplitude = sign === 0 ? 12 : bow;
  const signed = sign === 0 ? -1 : sign;
  // Midpoint along the arc — using 0.5 along the quadratic
  // approximates as the control point's reflection of the chord
  // mid; close enough for placing the metric chip.
  return {
    x: (a.cx + b.cx) / 2 + perpX * amplitude * signed * 0.55,
    y: (a.cy + b.cy) / 2 + perpY * amplitude * signed * 0.55,
  };
}

// Detail-panel selection. Node and edge selections are INDEPENDENT —
// both can be active at once, surfacing the two detail cards
// side-by-side below the map. The polished linear-chain design
// (`docs/design/.../screens/topology-chain.jsx`) lays them out that
// way so the operator can compare a service's metrics against the
// call edge's metrics in one glance without toggling between them.
const selectedNodeId = ref<string | null>(null);
const selectedCallId = ref<string | null>(null);
function selectNode(id: string | null): void {
  selectedNodeId.value = selectedNodeId.value === id ? null : id;
}
function selectCall(id: string | null): void {
  selectedCallId.value = selectedCallId.value === id ? null : id;
}
const selectedNode = computed<LayoutNode | null>(() => {
  const id = selectedNodeId.value;
  if (!id) return null;
  return layoutNodes.value.find((n) => n.id === id) ?? null;
});
const selectedCall = computed<TopologyCall | null>(() => {
  const id = selectedCallId.value;
  if (!id) return null;
  return calls.value.find((c) => c.id === id) ?? null;
});
const selectedCallSource = computed<LayoutNode | null>(() => {
  const c = selectedCall.value;
  if (!c) return null;
  return layoutNodes.value.find((n) => n.id === c.source) ?? null;
});
const selectedCallTarget = computed<LayoutNode | null>(() => {
  const c = selectedCall.value;
  if (!c) return null;
  return layoutNodes.value.find((n) => n.id === c.target) ?? null;
});

/**
 * Build a row per metric for the edge-detail sidebar. We pair up the
 * server + client metric defs by `id`, so a metric defined on only
 * one side renders as that side only. The row always carries the
 * label + unit so the y-axis stays aligned across rows.
 */
interface EdgeRow {
  id: string;
  label: string;
  unit: string;
  serverDef: TopologyMetricDef | null;
  clientDef: TopologyMetricDef | null;
}
const edgeRows = computed<EdgeRow[]>(() => {
  const map = new Map<string, EdgeRow>();
  for (const m of cfg.value.linkServerMetrics ?? []) {
    const row: EdgeRow =
      map.get(m.id) ??
      ({ id: m.id, label: m.label, unit: m.unit ?? '', serverDef: null, clientDef: null } as EdgeRow);
    row.serverDef = m;
    if (!map.has(m.id)) {
      row.label = m.label;
      row.unit = m.unit ?? '';
    }
    map.set(m.id, row);
  }
  for (const m of cfg.value.linkClientMetrics ?? []) {
    const row: EdgeRow =
      map.get(m.id) ??
      ({ id: m.id, label: m.label, unit: m.unit ?? '', serverDef: null, clientDef: null } as EdgeRow);
    row.clientDef = m;
    if (!map.has(m.id)) {
      row.label = m.label;
      row.unit = m.unit ?? '';
    }
    map.set(m.id, row);
  }
  return [...map.values()];
});
/**
 * Resolve a row's display state. The kind is determined by VALUE
 * availability, not just metric-def presence: an edge with only a
 * server reading (e.g. `User → consumer` — client side has no agent)
 * collapses to `server-only`, even though both metric defs exist on
 * the layer config.
 *
 *   - `both`        — both sides have non-null values.
 *   - `client-only` — only client has a value.
 *   - `server-only` — only server has a value.
 *   - `none`        — neither side has a value (or no def at all).
 */
type EdgeRowKind = 'both' | 'client-only' | 'server-only' | 'none';
function edgeRowValues(c: TopologyCall, row: EdgeRow): {
  kind: EdgeRowKind;
  clientV: number | null;
  serverV: number | null;
} {
  const clientV = row.clientDef ? edgeVal(c, 'client', row.clientDef) : null;
  const serverV = row.serverDef ? edgeVal(c, 'server', row.serverDef) : null;
  const hasClientV = clientV !== null;
  const hasServerV = serverV !== null;
  if (hasClientV && hasServerV) return { kind: 'both', clientV, serverV };
  if (hasClientV) return { kind: 'client-only', clientV, serverV };
  if (hasServerV) return { kind: 'server-only', clientV, serverV };
  return { kind: 'none', clientV, serverV };
}
const upstream = computed<LayoutNode[]>(() => {
  const sel = selectedNode.value;
  if (!sel) return [];
  const ids = new Set(calls.value.filter((c) => c.target === sel.id).map((c) => c.source));
  return layoutNodes.value.filter((n) => ids.has(n.id));
});
const downstream = computed<LayoutNode[]>(() => {
  const sel = selectedNode.value;
  if (!sel) return [];
  const ids = new Set(calls.value.filter((c) => c.source === sel.id).map((c) => c.target));
  return layoutNodes.value.filter((n) => ids.has(n.id));
});

/**
 * Resolve the layer key we should jump into for the selected node.
 * A service may belong to multiple OAP layers (e.g. a Java service
 * tagged `general` AND `k8s-service`); OAP returns the complete list
 * on `node.layers`. Stay in the current layer when it's in that list,
 * else fall back to the first one — landing on a layer that doesn't
 * contain the service produces a confusing empty page.
 */
function targetLayerFor(n: TopologyNode): string {
  const current = layerKey.value.toUpperCase();
  const layers = n.layers ?? [];
  const pick = layers.includes(current) ? current : (layers[0] ?? current);
  return pick.toLowerCase();
}
function jumpToService(): void {
  const sel = selectedNode.value;
  if (!sel) return;
  void router.push({
    path: `/layer/${targetLayerFor(sel)}/service`,
    query: { service: sel.id },
  });
}
function jumpToEndpointDependency(): void {
  const sel = selectedNode.value;
  if (!sel) return;
  void router.push({
    path: `/layer/${targetLayerFor(sel)}/dependency`,
    query: { service: sel.id },
  });
}

// ────────────────────────────────────────────────────────────────────
// Pan + zoom via d3.zoom. Wheel scrolls in/out, trackpad pinch
// zooms, drag pans. Browser-level Ctrl+/- still works for whole-page
// zoom; this is the in-canvas equivalent operators expect on a
// service-map. The transform applies to a `<g class="zoom-layer">`
// inside the SVG, so the gradient, baselines, edges, and nodes all
// transform together.
//
// We auto-fit on mount and on graph-shape changes so the operator
// lands on a sensible default no matter how wide the chain is.
// ────────────────────────────────────────────────────────────────────
const svgEl = ref<SVGSVGElement | null>(null);
const zoomLayerEl = ref<SVGGElement | null>(null);
const containerEl = ref<HTMLDivElement | null>(null);
let zoomBehaviour: d3.ZoomBehavior<SVGSVGElement, unknown> | null = null;
const zoomT = ref<{ k: number; x: number; y: number }>({ k: 1, x: 0, y: 0 });

function viewportSize(): { width: number; height: number } {
  const el = containerEl.value;
  if (!el) return { width: W.value, height: H.value };
  const rect = el.getBoundingClientRect();
  return { width: rect.width || W.value, height: rect.height || H.value };
}

/** Fit the graph's bounding box into the visible canvas, leaving a
 *  little padding. Called on mount + when the graph shape changes
 *  + when the operator hits the Fit button. */
function fitToScreen(animate = true): void {
  if (!svgEl.value || !zoomBehaviour) return;
  const vp = viewportSize();
  const pad = 24;
  const scale = Math.min(
    (vp.width - pad * 2) / W.value,
    (vp.height - pad * 2) / H.value,
    1.5, // never overshoot too far
  );
  const k = Math.max(0.15, scale);
  const tx = (vp.width - W.value * k) / 2;
  const ty = (vp.height - H.value * k) / 2;
  const sel = d3.select(svgEl.value);
  const transform = d3.zoomIdentity.translate(tx, ty).scale(k);
  if (animate) {
    sel.transition().duration(220).call(zoomBehaviour.transform, transform);
  } else {
    sel.call(zoomBehaviour.transform, transform);
  }
}
function zoomBy(factor: number): void {
  if (!svgEl.value || !zoomBehaviour) return;
  d3.select(svgEl.value).transition().duration(160).call(zoomBehaviour.scaleBy, factor);
}

function installZoom(): void {
  if (!svgEl.value || !zoomLayerEl.value) return;
  const sel = d3.select(svgEl.value);
  zoomBehaviour = d3
    .zoom<SVGSVGElement, unknown>()
    .scaleExtent([0.15, 5])
    .filter((event) => {
      // Ignore zoom on right-click — leaves the context menu usable.
      // Wheel + dblclick + drag all proceed normally; pinch on
      // trackpads fires `wheel` with ctrlKey=true which d3 handles.
      if (event.type === 'mousedown' && (event as MouseEvent).button !== 0) return false;
      // Skip when the pointer started on a node — that's a node-drag,
      // not a canvas pan. The `data-node-id` attribute identifies the
      // node-group target; bubbles up through SVG groups.
      const t = event.target as Element | null;
      if (t && t.closest && t.closest('[data-node-id]')) return false;
      return !(event as MouseEvent).button;
    })
    .on('zoom', (ev) => {
      zoomT.value = { k: ev.transform.k, x: ev.transform.x, y: ev.transform.y };
      d3.select(zoomLayerEl.value).attr('transform', ev.transform.toString());
    });
  sel.call(zoomBehaviour);
  // Double-click resets to fit — friendlier than d3's default
  // "double-click to zoom in by 2x" which often takes the operator
  // by surprise.
  sel.on('dblclick.zoom', null);
  sel.on('dblclick', () => fitToScreen(true));
}

// Node drag: pointer-drives the (cx, cy) override for the dragged
// service. The whole edge set re-routes live because every edge's
// `d` attribute reads from `nodePos`, which surfaces the override.
// Drop = commit position. We don't fight the user with a snap-back.
function installNodeDrag(): void {
  if (!zoomLayerEl.value) return;
  const sel = d3.select(zoomLayerEl.value).selectAll<SVGGElement, unknown>('g.sm-node');
  sel.on('.drag', null);
  sel.call(
    d3
      .drag<SVGGElement, unknown>()
      .clickDistance(4)
      .on('start', function (event) {
        // Mark which node is being dragged so the zoom filter knows
        // to bow out for this pointer sequence.
        (event.sourceEvent as MouseEvent).stopPropagation();
      })
      .on('drag', function (event) {
        const el = this as SVGGElement;
        const id = el.getAttribute('data-node-id');
        if (!id) return;
        const cur = nodePos.value.get(id);
        if (!cur) return;
        // event.dx / event.dy are post-transform deltas (d3.drag does
        // the math on the parent's CTM internally), so we can add them
        // directly to the override coordinates without unzooming.
        const next = { cx: cur.cx + event.dx, cy: cur.cy + event.dy };
        const m = new Map(dragOverrides.value);
        m.set(id, next);
        dragOverrides.value = m;
      }),
  );
}

onMounted(() => {
  // Defer one tick so the SVG has been rendered (layoutNodes drives
  // its mount through v-if).
  void nextTick(() => {
    installZoom();
    installNodeDrag();
    if (svgEl.value) fitToScreen(false);
  });
});
onBeforeUnmount(() => {
  if (svgEl.value) d3.select(svgEl.value).on('.zoom', null).on('dblclick', null);
  zoomBehaviour = null;
});
// Re-fit when the graph's shape changes substantially (depth toggle,
// data refresh that adds/removes nodes). Layout-dependent dims (W/H)
// are the cheapest signal that something visible changed.
watch(
  () => `${W.value}x${H.value}x${layoutNodes.value.length}`,
  () => {
    // If the SVG remounts (v-if), we need to re-install zoom. Defer.
    // Also re-bind drag — `selectAll('g.sm-node')` is bound to the
    // current DOM nodes, so a remount drops the handlers.
    void nextTick(() => {
      installNodeDrag();
      if (!zoomBehaviour) installZoom();
      fitToScreen(false);
    });
  },
);

/**
 * Render a metric label for the edge-panel card. Suppresses the unit
 * suffix when the operator-set label and unit are the same word
 * (e.g. label="RPM", unit="rpm" → just "RPM" instead of "RPM (RPM)").
 * Units are always rendered UPPERCASE per the design rule.
 */
function formatRowLabel(row: { label: string; unit?: string | null }): string {
  const lab = (row.label ?? '').trim();
  const u = (row.unit ?? '').trim();
  if (!u) return lab;
  if (lab.toLowerCase() === u.toLowerCase()) return lab.toUpperCase();
  return `${lab} (${u.toUpperCase()})`;
}

function fmtWithUnit(v: number | null | undefined, unit: string | undefined): string {
  if (v === null || v === undefined) return '—';
  const s = fmtMetric(v);
  return unit ? `${s} ${unit}` : s;
}
</script>

<template>
  <div class="sm-tab">
    <header class="sm-toolbar sw-card">
      <div class="left">
        <span class="kicker">Topology</span>
        <span v-if="focusServiceNames.length === 0" class="for-svc">layer overview · all services</span>
        <span v-else class="for-svc">
          focused on
          <b>{{ focusServiceNames.length === 1 ? serviceBaseName(focusServiceNames[0]) : `${focusServiceNames.length} services` }}</b>
        </span>
        <span v-if="isFetching" class="hint">refreshing…</span>
      </div>
      <div class="right">
        <!-- Focus picker — lives INSIDE the topology box so the
             header service picker stays out of the layer-wide map.
             Supports multi-select + search. Closes by clicking outside
             the chips (via the wrapper @click.stop). -->
        <div class="focus-wrap" @click.stop>
          <button class="focus-btn sw-btn small" type="button" @click="toggleFocusPicker">
            <span class="focus-btn-label">
              {{ focusServiceNames.length === 0 ? 'All services' : focusServiceNames.length + ' selected' }}
            </span>
            <span class="caret" :class="{ open: focusPickerOpen }">▾</span>
          </button>
          <div v-if="focusPickerOpen" class="focus-pop sw-card">
            <input
              v-model="focusSearch"
              class="focus-search"
              type="text"
              placeholder="Search services…"
              autofocus
            />
            <div class="focus-list">
              <button
                class="focus-row clear"
                :class="{ selected: focusServiceNames.length === 0 }"
                type="button"
                @click="clearFocus"
              >
                <span class="focus-check">{{ focusServiceNames.length === 0 ? '●' : '○' }}</span>
                <span class="focus-name">All services</span>
                <span class="focus-aside">{{ landingRows.length }} total</span>
              </button>
              <template v-for="[gkey, rows] in groupedRows" :key="gkey">
                <div v-if="gkey" class="focus-group-head">{{ gkey }}</div>
                <button
                  v-for="r in rows"
                  :key="r.id"
                  class="focus-row"
                  :class="{ selected: focusServiceNames.includes((r.group ? r.group + '::' : '') + r.name) }"
                  type="button"
                  @click="toggleService((r.group ? r.group + '::' : '') + r.name)"
                >
                  <span class="focus-check">{{ focusServiceNames.includes((r.group ? r.group + '::' : '') + r.name) ? '●' : '○' }}</span>
                  <span class="focus-name">{{ r.name }}</span>
                </button>
              </template>
              <div v-if="groupedRows.size === 0" class="focus-empty">no matches</div>
            </div>
          </div>
        </div>
        <!-- Depth is only meaningful when a focus seed is picked —
             "All services" already seeds from up to 30 layer services
             so a BFS-depth control would either be redundant or
             explode the graph. -->
        <label v-if="focusServiceNames.length > 0" class="depth-pick">
          <span>Depth</span>
          <select v-model.number="depth">
            <option :value="1">1 hop</option>
            <option :value="2">2 hops</option>
            <option :value="3">3 hops</option>
          </select>
        </label>
        <button class="sw-btn small" type="button" @click="() => refetch()">Refresh</button>
      </div>
    </header>

    <div v-if="!reachable" class="banner err">
      <strong>OAP unreachable.</strong>
      {{ errorText ?? 'Topology feed failed — check the BFF and OAP.' }}
    </div>

    <section class="sm-card sw-card" :style="{ height: cardHeightPx + 'px' }">
      <div ref="containerEl" class="sm-graph">
        <!-- Single SVG that fills the container; pan/zoom transforms
             apply to the inner `<g class="zoom-layer">`. No scroll
             wrapper — wheel + pinch + drag handle navigation. -->
        <svg
          v-if="layoutNodes.length > 0"
          ref="svgEl"
          class="sm-svg"
          width="100%"
          height="100%"
          preserveAspectRatio="xMidYMid meet"
        >
          <defs>
            <radialGradient id="sm-bg-glow" cx="50%" cy="50%" r="60%">
              <stop offset="0%" stop-color="rgba(249,115,22,0.05)" />
              <stop offset="100%" stop-color="transparent" />
            </radialGradient>
          </defs>
          <g ref="zoomLayerEl" class="zoom-layer">
            <!-- Soft radial glow behind the chain — pure decoration. -->
            <rect :width="W" :height="H" fill="url(#sm-bg-glow)" />

            <!-- Single-baseline guide along the median row (single-row
                 chains) or one guide per row (fan-out columns). The
                 linear-chain design uses a single horizontal dashed
                 line through every node. -->
            <line
              v-for="r in Array.from({ length: Math.max(1, ...layerColumns.map((c) => c.visible.length)) }, (_, i) => i)"
              :key="`baseline-${r}`"
              x1="40"
              :x2="W - 40"
              :y1="110 + r * ROW_GAP + NODE_R"
              :y2="110 + r * ROW_GAP + NODE_R"
              stroke="var(--sw-line)"
              stroke-dasharray="2 6"
              opacity="0.4"
            />

            <g
              v-for="c in visibleCalls"
              :key="c.id"
              class="sm-edge"
              @click.stop="selectCall(c.id)"
            >
              <!-- Invisible wide hit-path: gives the operator a
                   ~14px-wide clickable corridor along the edge so
                   landing the cursor on a 2px line isn't fiddly. The
                   visible path on top draws the actual edge. -->
              <path
                :d="callPathD(c)"
                fill="none"
                stroke="transparent"
                stroke-width="14"
                style="cursor: pointer"
              />
              <!-- Base edge line. Uniform width across the canvas now
                   that heaviest-path is gone — every edge is visually
                   peer; selection brightens. -->
              <path
                :d="callPathD(c)"
                fill="none"
                :stroke="selectedCallId === c.id ? 'var(--sw-accent-2)' : 'var(--sw-accent)'"
                :stroke-width="selectedCallId === c.id ? 3.2 : 1.8"
                :opacity="selectedCallId === c.id ? 1 : 0.7"
                stroke-linecap="round"
                style="pointer-events: none"
              />
              <!-- Direction overlay: a dashed stroke that scrolls along
                   the path from source → target. Same stroke colour but
                   higher-frequency dashes so the motion reads even on
                   dense graphs without competing with the base line. -->
              <path
                :d="callPathD(c)"
                fill="none"
                :stroke="selectedCallId === c.id ? 'var(--sw-accent-2)' : 'var(--sw-accent)'"
                :stroke-width="selectedCallId === c.id ? 3.2 : 1.8"
                stroke-linecap="round"
                stroke-dasharray="6 10"
                opacity="0.9"
                style="pointer-events: none"
              >
                <animate
                  attributeName="stroke-dashoffset"
                  from="16"
                  to="0"
                  dur="1.2s"
                  repeatCount="indefinite"
                />
              </path>
              <!-- Edge metric chip — sits on the line midpoint with a
                   pill background. Compact by design (edge metrics
                   aren't the headline signal; they ride alongside the
                   line). The chip shows the configured line metric
                   value + unit; `(C)` marker when only client-side
                   data was available. -->
              <!-- Edge metric chip — bigger + higher-contrast text so
                   the unit reads even on dense lines. Units are
                   always displayed UPPERCASE. -->
              <template v-if="edgeLabel(c) && edgeMidpoint(c)">
                <g
                  :transform="`translate(${edgeMidpoint(c)!.x - 44}, ${edgeMidpoint(c)!.y - 13})`"
                  style="pointer-events: none"
                >
                  <rect
                    x="0"
                    y="0"
                    width="88"
                    height="24"
                    rx="12"
                    fill="var(--sw-bg-1)"
                    :stroke="selectedCallId === c.id ? 'var(--sw-accent-2)' : 'var(--sw-line-2)'"
                    :stroke-width="selectedCallId === c.id ? 1.4 : 1"
                  />
                  <text
                    x="44"
                    y="17"
                    text-anchor="middle"
                    :fill="selectedCallId === c.id ? 'var(--sw-accent-2)' : 'var(--sw-fg-1)'"
                    font-size="13"
                    font-family="var(--sw-mono)"
                    font-weight="700"
                  >
                    {{ fmtMetric(edgeLabel(c)!.value) }}<tspan
                      v-if="edgeLabel(c)!.unit"
                      :dx="3"
                      fill="var(--sw-fg-2)"
                      font-weight="600"
                    >{{ edgeLabel(c)!.unit.toUpperCase() }}</tspan><tspan
                      v-if="edgeLabel(c)!.isClient"
                      :dx="3"
                      fill="var(--sw-fg-3)"
                      font-weight="600"
                    >·C</tspan>
                  </text>
                </g>
              </template>
            </g>

            <!-- Polished linear-chain node — pure SVG, no PNGs. Three
                 concentric circles + a kind-specific icon + agent
                 badge top-right + name/metric text below. Mirrors
                 docs/.../screens/topology-chain.jsx. -->
            <g
              v-for="n in layoutNodes.filter((nn) => nodePos.get(nn.id))"
              :key="n.id"
              :data-node-id="n.id"
              :transform="`translate(${nodePos.get(n.id)!.cx}, ${nodePos.get(n.id)!.cy})`"
              class="sm-node"
              style="cursor: grab"
              @click.stop="selectNode(n.id)"
            >
              <!-- Selection halo: tinted fill at r=56 + dashed ring at
                   r=50 (design spec). -->
              <template v-if="selectedNodeId === n.id">
                <circle r="56" :fill="ringColor(n)" opacity="0.10" />
                <circle
                  r="50"
                  fill="none"
                  :stroke="ringColor(n)"
                  stroke-width="1.2"
                  stroke-dasharray="3 4"
                  opacity="0.7"
                />
              </template>
              <!-- Outer ring (health). Dashed for client / external
                   to signal "untraced" (no agent here). Solid stroke
                   for real services. -->
              <circle
                r="42"
                fill="var(--sw-bg-1)"
                :stroke="ringColor(n)"
                :stroke-width="nodeKind(n) === 'service' ? 2.5 : 1.2"
                :stroke-dasharray="nodeKind(n) === 'service' ? '0' : '4 4'"
                :style="{
                  filter: selectedNodeId === n.id
                    ? `drop-shadow(0 0 12px ${ringColor(n)})`
                    : 'none',
                }"
              />
              <!-- Inner disc — slightly darker for services to push
                   the icon forward; matches the design's two-tone
                   readout. -->
              <circle
                r="32"
                :fill="nodeKind(n) === 'service' ? 'var(--sw-bg-2)' : 'var(--sw-bg-1)'"
                stroke="var(--sw-line-2)"
                stroke-width="1"
              />

              <!-- Kind icon: client = user silhouette, service = 3D
                   box, external = cloud with `?`. SVG-only, per
                   design. -->
              <g v-if="nodeKind(n) === 'client'" transform="translate(-14, -12)" fill="var(--sw-info)">
                <circle cx="9" cy="6" r="4" />
                <circle cx="20" cy="6" r="4" />
                <path d="M2 24 c0 -6 5 -10 10 -10 c5 0 10 4 10 10 z" />
                <path d="M14 24 c0 -6 5 -10 10 -10 c5 0 10 4 10 10 z" opacity="0.7" />
              </g>
              <g v-else-if="nodeKind(n) === 'service'" transform="translate(-14, -14)">
                <polygon points="14,0 28,7 14,14 0,7" fill="#94a3b8" />
                <polygon points="0,7 14,14 14,28 0,21" fill="#5b6373" />
                <polygon points="28,7 14,14 14,28 28,21" fill="#3a4456" />
              </g>
              <g v-else transform="translate(-14, -10)" fill="var(--sw-info)">
                <path d="M6 14 a8 8 0 0 1 8 -8 a7 7 0 0 1 7 5 a6 6 0 0 1 1 12 H6 a6 6 0 0 1 -2 -9 z" />
                <text
                  x="14"
                  y="16"
                  text-anchor="middle"
                  font-size="10"
                  font-weight="700"
                  fill="var(--sw-bg-2)"
                >?</text>
              </g>

              <!-- Agent badge — top-right of the ring. Apache-feather
                   mark inside an accent halo. Only real services
                   advertise an agent (synthetic User / external have
                   no detector). -->
              <g v-if="n.isReal" transform="translate(26, -26)">
                <circle r="10" fill="var(--sw-bg-0)" stroke="var(--sw-accent-line)" stroke-width="1" />
                <circle r="8.5" fill="var(--sw-accent)" opacity="0.18" />
                <g transform="translate(-7, -7) scale(0.6)" fill="var(--sw-accent-2)">
                  <path d="M3 14c4-3 8-3 12-1 3 1.4 5 .5 6-1-1 5-4 8-9 8-4 0-7-2-9-6z" />
                  <path
                    d="M5 10c3-2 7-2 11 0 3 1.3 5 .6 6-1-1 3.6-4 6-8 6-4 0-7-1.6-9-5z"
                    fill="#fff"
                    opacity="0.25"
                  />
                </g>
              </g>

              <!-- Pulsing health dot bottom-right of selected node. -->
              <circle
                v-if="selectedNodeId === n.id"
                cx="22"
                cy="26"
                r="5"
                fill="var(--sw-bg-0)"
                :stroke="ringColor(n)"
                stroke-width="1"
              >
                <animate attributeName="r" values="5;9;5" dur="2s" repeatCount="indefinite" />
                <animate attributeName="opacity" values="1;0.2;1" dur="2s" repeatCount="indefinite" />
              </circle>

              <!-- Name below the node. Slightly larger now that the
                   circle radius is smaller — keeps the label as the
                   readable anchor for the node. -->
              <!-- Node label = base name only. The group prefix
                   (`<group>::base`) appears as a chip in the right
                   sidebar; jamming it into the canvas label competes
                   with the metric line below. -->
              <text
                text-anchor="middle"
                y="58"
                :fill="selectedNodeId === n.id ? 'var(--sw-fg-0)' : 'var(--sw-fg-1)'"
                font-size="16"
                font-family="var(--sw-mono)"
                :font-weight="selectedNodeId === n.id ? 700 : 600"
              >
                {{ truncateLabel(serviceBaseName(n.name), 22) }}
              </text>
              <!-- Metric line. Operator-configured `center` metric
                   in the ring colour; `secondary` next to it muted.
                   Units always UPPERCASE per design rule. Bumped
                   font size since the node radius shrunk. -->
              <text
                text-anchor="middle"
                y="76"
                :fill="centerDef && nodeVal(n, centerDef) !== null ? ringColor(n) : 'var(--sw-fg-3)'"
                font-size="14"
                font-family="var(--sw-mono)"
                font-weight="700"
              >
                {{
                  centerDef
                    ? (nodeVal(n, centerDef) === null
                        ? `— ${(centerDef.unit ?? '').toUpperCase()}`
                        : `${fmtMetric(nodeVal(n, centerDef))}${centerDef.unit ? ' ' + centerDef.unit.toUpperCase() : ''}`)
                    : ''
                }}<template v-if="secondaryDef && nodeVal(n, secondaryDef) !== null"><tspan fill="var(--sw-fg-3)"> · </tspan><tspan fill="var(--sw-fg-2)" font-weight="500">{{ secondaryDef.label }} {{ fmtMetric(nodeVal(n, secondaryDef)) }}{{ secondaryDef.unit ? ' ' + secondaryDef.unit.toUpperCase() : '' }}</tspan></template>
              </text>
            </g>
          </g>
        </svg>
        <div v-else-if="isLoading" class="loader">loading…</div>
        <div v-else class="loader">
          No services with metric data in this layer for the last 15 minutes.
        </div>

        <!-- Floating zoom controls — top-right, mirror the map
             toolbar's affordance vocabulary (small ghost buttons). -->
        <div v-if="layoutNodes.length > 0" class="sm-zoom-ctrls">
          <button class="sw-btn small" type="button" title="Zoom in (wheel up)" @click="zoomBy(1.25)">+</button>
          <button class="sw-btn small" type="button" title="Zoom out (wheel down)" @click="zoomBy(1 / 1.25)">−</button>
          <button class="sw-btn small" type="button" title="Fit to screen (double-click canvas)" @click="fitToScreen(true)">Fit</button>
          <span class="sm-zoom-pct" :title="`Scale ${(zoomT.k * 100).toFixed(0)}%`">{{ Math.round(zoomT.k * 100) }}%</span>
        </div>

        <div class="legend">
          <div v-if="ringDef" class="lg-label">{{ ringDef.label }}</div>
          <div v-if="ringDef" class="lg-ramp">
            <span style="background: var(--sw-ok)" />
            <span style="background: #fbbf24" />
            <span style="background: var(--sw-warn)" />
            <span style="background: var(--sw-err)" />
          </div>
          <div v-if="ringDef" class="lg-scale">
            <span>0%</span><span>0.1%</span><span>1%</span><span>5%+</span>
          </div>
          <div class="lg-rule" />
          <div class="lg-row">
            <span class="lg-swatch" style="background: var(--sw-accent)" />
            <span>Calls</span>
            <span class="lg-aside">direction shown by flow animation</span>
          </div>
        </div>
        <div v-if="elidedTotal > 0" class="cap-chip">
          {{ elidedTotal }} node{{ elidedTotal === 1 ? '' : 's' }} elided across columns
        </div>
      </div>

      <!-- Right sidebar — node panel on top, edge panel underneath.
           Both selections are independent so the two stay open in
           parallel; empty slots prompt the operator to pick the
           missing side. Edges DO NOT open a dashboard page — metrics
           live here and on the canvas, that's the full extent of
           edge drill-in. -->
      <aside class="sm-panels">
      <!-- ── Top slot: node panel (or empty prompt). ── -->
      <article v-if="selectedNode" class="sm-panel">
        <header class="sp-head">
          <div class="sp-id">
            <div class="sp-mono">{{ selectedNode.name }}</div>
            <div class="sp-tags">
              <span v-if="parseServiceName(selectedNode.name).group" class="sw-tag accent">{{ parseServiceName(selectedNode.name).group }}</span>
              <span v-for="l in selectedNode.layers" :key="l" class="sw-tag">{{ l }}</span>
              <span v-if="!selectedNode.isReal" class="sw-tag">virtual</span>
            </div>
          </div>
          <button class="sw-btn small" type="button" @click="selectedNodeId = null">×</button>
        </header>
        <div class="sp-kpis">
          <div v-for="m in cfg.nodeMetrics" :key="m.id" class="sp-kpi">
            <div class="sp-kpi-label">{{ formatRowLabel(m) }}</div>
            <div class="sp-kpi-value" :style="{ color: m.role === 'ring' ? ringColor(selectedNode) : m.role === 'center' ? 'var(--sw-accent)' : 'var(--sw-fg-0)' }">
              {{ fmtMetric(nodeVal(selectedNode, m)) }}
            </div>
          </div>
        </div>
        <div class="sp-section">
          <div class="sp-section-title">Upstream callers ({{ upstream.length }})</div>
          <ul class="sp-list">
            <li v-for="u in upstream" :key="u.id">
              <span class="sp-pulse" :style="{ color: ringColor(u) }">●</span>
              <span class="sp-mono small">{{ u.name }}</span>
              <span class="sp-cpm">{{ fmtWithUnit(nodeVal(u, centerDef), centerDef?.unit) }}</span>
            </li>
            <li v-if="upstream.length === 0" class="sp-empty">no upstream callers in window</li>
          </ul>
        </div>
        <div class="sp-section">
          <div class="sp-section-title">Downstream deps ({{ downstream.length }})</div>
          <ul class="sp-list">
            <li v-for="d in downstream" :key="d.id">
              <span class="sp-pulse" :style="{ color: ringColor(d) }">●</span>
              <span class="sp-mono small">{{ d.name }}</span>
              <span class="sp-cpm">{{ fmtWithUnit(nodeVal(d, secondaryDef), secondaryDef?.unit) }}</span>
            </li>
            <li v-if="downstream.length === 0" class="sp-empty">no downstream deps in window</li>
          </ul>
        </div>
        <!-- Node-only dashboard jumps. Edges deliberately have no
             corresponding affordance — we keep their detail inline. -->
        <div class="sp-actions">
          <button class="sw-btn small primary" type="button" @click="jumpToService">Open service</button>
          <button class="sw-btn small" type="button" @click="jumpToEndpointDependency">API map →</button>
        </div>
      </article>

      <!-- Top-slot empty when no node is selected. -->
      <article v-if="!selectedNode" class="sm-panel sm-panel-empty">
        <span>Click a node to inspect a service</span>
      </article>

      <!-- ── Bottom slot: edge panel (or empty prompt). ── -->
      <article v-if="selectedCall && selectedCallSource && selectedCallTarget" class="sm-panel">
        <header class="sp-head">
          <div class="sp-id">
            <div class="sp-edge-row">
              <span class="sp-mono small">{{ selectedCallSource.name }}</span>
              <span class="sp-edge-arrow">→</span>
              <span class="sp-mono small">{{ selectedCallTarget.name }}</span>
            </div>
            <div class="sp-tags">
              <span class="sw-tag">{{ selectedCall.detectPoints.join(' · ') || 'relation' }}</span>
            </div>
          </div>
          <button class="sw-btn small" type="button" @click="selectedCallId = null">×</button>
        </header>
        <!-- Edge line metrics — one card per metric. Inside, client
             and server cells sit SIDE-BY-SIDE (left | right) and each
             sparkline stretches via `fluid` to fill its cell. Single-
             side metrics span the full row; "no value" appears only
             when neither side has data. -->
        <div class="sp-section">
          <div class="sp-section-title">Line metrics</div>
          <div v-if="edgeRows.length > 0" class="sp-edge-rows">
            <div v-for="row in edgeRows" :key="row.id" class="sp-edge-row-card">
              <div class="sp-edge-row-head">
                <span class="sp-edge-row-label">{{ formatRowLabel(row) }}</span>
                <!-- Hover tooltip — at-bucket values + diff. Surfaced
                     inline at the top-right of the row so it
                     doesn't overflow the sidebar. -->
                <span
                  v-if="hoveredEdgeRowId === row.id && hoveredEdgeBucket !== null"
                  class="sp-edge-tip"
                >
                  <template v-if="row.clientDef">
                    <span class="tip-tag" style="color: var(--sw-info)">C</span>
                    <span class="tip-val">{{ fmtMetric(seriesAt(edgeSeries(selectedCall, 'client', row.clientDef), hoveredEdgeBucket)) }}</span>
                  </template>
                  <template v-if="row.serverDef">
                    <span class="tip-sep">·</span>
                    <span class="tip-tag" style="color: var(--sw-accent)">S</span>
                    <span class="tip-val">{{ fmtMetric(seriesAt(edgeSeries(selectedCall, 'server', row.serverDef), hoveredEdgeBucket)) }}</span>
                  </template>
                  <template v-if="row.clientDef && row.serverDef">
                    <span class="tip-sep">·</span>
                    <span class="tip-tag">Δ</span>
                    <span
                      class="tip-val"
                      :style="{ color: diffColor(diffAt(row, hoveredEdgeBucket)) }"
                    >{{ diffText(diffAt(row, hoveredEdgeBucket)) }}</span>
                  </template>
                </span>
              </div>
              <template v-if="edgeRowValues(selectedCall, row).kind === 'both'">
                <div class="sp-edge-pair">
                  <div class="sp-edge-cell">
                    <div class="sp-edge-cell-head">
                      <span class="sp-edge-cell-tag">Client</span>
                      <span class="sp-edge-cell-num">{{ fmtMetric(edgeRowValues(selectedCall, row).clientV) }}</span>
                    </div>
                    <Sparkline
                      :values="edgeSeries(selectedCall, 'client', row.clientDef)"
                      color="var(--sw-info)"
                      :height="36"
                      :stroke="1.4"
                      fluid
                      :crosshair-bucket="rowCrosshair(row.id)"
                      @bucket-hover="(b: number) => onEdgeBucketHover(row.id, b)"
                      @bucket-leave="onEdgeBucketLeave"
                    />
                  </div>
                  <div class="sp-edge-cell">
                    <div class="sp-edge-cell-head">
                      <span class="sp-edge-cell-tag">Server</span>
                      <span class="sp-edge-cell-num">{{ fmtMetric(edgeRowValues(selectedCall, row).serverV) }}</span>
                    </div>
                    <Sparkline
                      :values="edgeSeries(selectedCall, 'server', row.serverDef)"
                      color="var(--sw-accent)"
                      :height="36"
                      :stroke="1.4"
                      fluid
                      :crosshair-bucket="rowCrosshair(row.id)"
                      @bucket-hover="(b: number) => onEdgeBucketHover(row.id, b)"
                      @bucket-leave="onEdgeBucketLeave"
                    />
                  </div>
                </div>
              </template>
              <template v-else-if="edgeRowValues(selectedCall, row).kind === 'client-only'">
                <div class="sp-edge-cell">
                  <div class="sp-edge-cell-head">
                    <span class="sp-edge-cell-tag">Client</span>
                    <span class="sp-edge-cell-num">{{ fmtMetric(edgeRowValues(selectedCall, row).clientV) }}</span>
                    <span class="sp-side-note">client only</span>
                  </div>
                  <Sparkline
                    :values="edgeSeries(selectedCall, 'client', row.clientDef)"
                    color="var(--sw-info)"
                    :height="36"
                    :stroke="1.4"
                    fluid
                    :crosshair-bucket="rowCrosshair(row.id)"
                    @bucket-hover="(b: number) => onEdgeBucketHover(row.id, b)"
                    @bucket-leave="onEdgeBucketLeave"
                  />
                </div>
              </template>
              <template v-else-if="edgeRowValues(selectedCall, row).kind === 'server-only'">
                <div class="sp-edge-cell">
                  <div class="sp-edge-cell-head">
                    <span class="sp-edge-cell-tag">Server</span>
                    <span class="sp-edge-cell-num">{{ fmtMetric(edgeRowValues(selectedCall, row).serverV) }}</span>
                    <span class="sp-side-note">server only</span>
                  </div>
                  <Sparkline
                    :values="edgeSeries(selectedCall, 'server', row.serverDef)"
                    color="var(--sw-accent)"
                    :height="36"
                    :stroke="1.4"
                    fluid
                    :crosshair-bucket="rowCrosshair(row.id)"
                    @bucket-hover="(b: number) => onEdgeBucketHover(row.id, b)"
                    @bucket-leave="onEdgeBucketLeave"
                  />
                </div>
              </template>
              <template v-else>
                <div class="sp-edge-none">no value</div>
              </template>
            </div>
          </div>
          <div v-else class="sp-empty">no line metrics configured</div>
        </div>
      </article>

      <!-- Bottom-slot empty when no edge is selected. -->
      <article
        v-if="!(selectedCall && selectedCallSource && selectedCallTarget)"
        class="sm-panel sm-panel-empty"
      >
        <span>Click an edge to inspect a call</span>
      </article>
      </aside>
    </section>
  </div>
</template>

<style scoped>
.sm-tab {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 4px 0 0;
}
.sm-toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 12px;
}
.sm-toolbar .left {
  display: inline-flex;
  align-items: baseline;
  gap: 10px;
  min-width: 0;
}
.sm-toolbar .right {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.kicker {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--sw-accent);
  font-weight: 600;
}
.for-svc {
  font-size: 11.5px;
  color: var(--sw-fg-3);
}
.for-svc b {
  color: var(--sw-fg-1);
  font-family: var(--sw-mono);
  font-weight: 500;
}
.hint { font-size: 10.5px; color: var(--sw-fg-3); }
.depth-pick {
  display: inline-flex;
  align-items: baseline;
  gap: 5px;
  font-size: 10.5px;
  color: var(--sw-fg-3);
}
.depth-pick select {
  height: 24px;
  padding: 0 6px;
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line-2);
  border-radius: 4px;
  color: var(--sw-fg-0);
  font: inherit;
  font-size: 11px;
}
/* Focus selector — opens a search-driven multi-select panel anchored
   to the button. Wide enough to read group + name in one row even on
   long k8s service names. */
.focus-wrap { position: relative; }
.focus-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 160px;
  justify-content: space-between;
}
.focus-btn .caret { font-size: 9px; color: var(--sw-fg-3); transition: transform 0.12s; }
.focus-btn .caret.open { transform: rotate(180deg); }
.focus-pop {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  width: 360px;
  max-height: 380px;
  display: flex;
  flex-direction: column;
  padding: 8px;
  z-index: 30;
}
.focus-search {
  height: 32px;
  padding: 0 10px;
  margin-bottom: 6px;
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line-2);
  border-radius: 6px;
  color: var(--sw-fg-0);
  font: inherit;
  font-size: 13px;
  outline: none;
}
.focus-search:focus { border-color: var(--sw-accent-line); }
.focus-list { overflow-y: auto; flex: 1 1 auto; }
.focus-group-head {
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--sw-fg-3);
  padding: 6px 8px 4px;
}
.focus-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 8px;
  background: transparent;
  border: 0;
  border-radius: 4px;
  color: var(--sw-fg-1);
  font: inherit;
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}
.focus-row:hover { background: var(--sw-bg-2); color: var(--sw-fg-0); }
.focus-row.selected { color: var(--sw-accent-2); }
.focus-row .focus-check { width: 12px; text-align: center; color: var(--sw-accent); }
.focus-row .focus-name { flex: 1; font-family: var(--sw-mono); }
.focus-row .focus-aside { font-size: 10.5px; color: var(--sw-fg-3); }
.focus-row.clear { border-bottom: 1px dashed var(--sw-line); padding-bottom: 8px; margin-bottom: 4px; }
.focus-empty { padding: 16px; text-align: center; color: var(--sw-fg-3); font-size: 11.5px; }
.banner.err {
  padding: 8px 12px;
  background: var(--sw-err-soft);
  border: 1px solid rgba(239, 68, 68, 0.3);
  border-radius: 6px;
  color: #f87171;
  font-size: 11.5px;
}
.sm-card {
  /* Map card — graph on the left, dual-stack sidebar on the right.
     Height is driven by the `cardHeightPx` computed in the script:
     adapts to the graph's actual content with a 60% floor of the
     780px baseline and a 1100px cap. See `cardHeightPx` for the
     reasoning; the inline `style="height: …px"` on the section
     wins over this declaration. */
  padding: 0;
  overflow: hidden;
  display: grid;
  grid-template-columns: 1fr 360px;
}
.sm-panels {
  /* The whole sidebar is one scroll container. Each panel sizes to
     its content (upstream / downstream lists are dynamic, so a
     fixed 50/50 split makes one panel too tall and the other too
     short). When total content exceeds the card height, the box
     scrolls as a single unit so the operator never has to chase a
     scrollbar inside a sub-panel. */
  border-left: 1px solid var(--sw-line);
  background: var(--sw-bg-1);
  display: flex;
  flex-direction: column;
  overflow-y: auto;
  min-height: 0;
}
.sm-panel {
  padding: 0;
  display: flex;
  flex-direction: column;
  min-width: 0;
  /* Content-driven height. `flex-shrink: 0` so the panels keep their
     natural size; overflow is handled by the parent scroll. */
  flex: 0 0 auto;
  overflow: visible;
}
.sm-panel + .sm-panel {
  border-top: 1px solid var(--sw-line);
}
.sm-panel-empty {
  border: 1px dashed var(--sw-line-2);
  margin: 8px;
  border-radius: 6px;
  background: transparent;
  color: var(--sw-fg-3);
  font-size: 11.5px;
  display: grid;
  place-items: center;
  /* Empty prompts stay compact so they don't push the populated
     panel out of view. */
  min-height: 64px;
  flex: 0 0 auto;
}
.sm-graph {
  /* Fill the card — the parent `.sm-card` is `display: flex` since the
     2-col-with-sidebar layout went away; without an explicit `flex: 1`
     the graph collapsed to its intrinsic height and the map showed
     stale. */
  flex: 1;
  position: relative;
  min-width: 0;
  display: flex;
  flex-direction: column;
  background: radial-gradient(900px 540px at 30% 40%, rgba(56, 189, 248, 0.04), transparent 60%), var(--sw-bg-0);
}
.layer-hdr-row {
  position: relative;
  height: 34px;
  flex: 0 0 auto;
  border-bottom: 1px solid var(--sw-line);
  background: var(--sw-bg-1);
}
.layer-hdr {
  position: absolute;
  top: 10px;
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: 9.5px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--sw-fg-3);
  font-weight: 700;
  justify-content: center;
}
.hdr-overflow {
  font-size: 9px;
  color: var(--sw-fg-2);
  padding: 1px 5px;
  background: var(--sw-bg-2);
  border-radius: 3px;
  text-transform: none;
  letter-spacing: 0;
  font-weight: 500;
}
.sm-scroll {
  flex: 1;
  overflow: auto;
  min-height: 0;
}
.sm-node { cursor: pointer; }
.sm-node { cursor: pointer; }
.sm-node:hover image {
  /* Subtle pop on hover — the cube image gets a slight scale via
     filter rather than a CSS transform so the SVG transform-origin
     stays at the node's geometric centre. */
  filter: drop-shadow(0 0 4px rgba(249, 115, 22, 0.45));
}
.sm-edge { cursor: pointer; }
.sm-edge:hover path:nth-of-type(2) {
  stroke: var(--sw-accent-2) !important;
  opacity: 1 !important;
}
.sp-edge-row {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.sp-edge-arrow {
  color: var(--sw-fg-3);
  font-size: 11px;
}
/* Edge line-metric cards. One card per metric, two sparkline cells
   per card (client | server). The pair grid stays 1:1 even when
   only one side has data — the empty side renders a full-width cell
   in those rows so the label is left-aligned consistently. */
.sp-edge-rows {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 0;
}
.sp-edge-row-card {
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line);
  border-radius: 4px;
  padding: 6px 8px;
}
/* Crosshair hover tooltip (per edge-metric row). Compact inline
   chip at the right side of the row head showing the value at the
   hovered bucket on each side plus the diff (Δ = server − client). */
.sp-edge-tip {
  display: inline-flex;
  align-items: baseline;
  gap: 4px;
  margin-left: auto;
  font-family: var(--sw-mono);
  font-size: 10.5px;
  padding: 1px 6px;
  background: var(--sw-bg-0);
  border: 1px solid var(--sw-line);
  border-radius: 4px;
}
.sp-edge-tip .tip-tag {
  font-size: 9.5px;
  font-weight: 700;
  letter-spacing: 0.04em;
}
.sp-edge-tip .tip-val {
  color: var(--sw-fg-0);
  font-weight: 600;
}
.sp-edge-tip .tip-sep {
  color: var(--sw-fg-3);
}
.sp-edge-row-head {
  display: flex;
  align-items: baseline;
  gap: 6px;
  padding: 0 2px 4px;
}
.sp-edge-row-label {
  font-family: var(--sw-mono);
  font-size: 11px;
  color: var(--sw-fg-1);
  font-weight: 600;
}
.sp-edge-row-label .unit {
  color: var(--sw-fg-3);
  font-size: 10px;
  font-weight: 500;
}
.sp-edge-pair {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px;
}
.sp-edge-cell {
  background: var(--sw-bg-1);
  border: 1px solid var(--sw-line);
  border-radius: 3px;
  padding: 4px 6px;
  min-width: 0;
}
/* Inside an edge cell the Sparkline should fill the cell — the
   `fluid` prop on the component sets svg width=100% but the parent
   must allow shrinking, hence `min-width: 0` above. */
.sp-edge-cell :deep(.sparkline) {
  display: block;
  width: 100%;
}
.sp-edge-cell-head {
  display: flex;
  align-items: baseline;
  gap: 6px;
  margin-bottom: 2px;
}
.sp-edge-cell-tag {
  font-size: 9px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--sw-fg-3);
  font-weight: 700;
}
.sp-edge-cell-num {
  font-family: var(--sw-mono);
  font-size: 12px;
  color: var(--sw-fg-0);
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  margin-left: auto;
}
.sp-side-note {
  margin-left: auto;
  color: var(--sw-fg-3);
  font-size: 9.5px;
  font-weight: 500;
}
.sp-edge-none {
  color: var(--sw-fg-3);
  font-style: italic;
  text-align: center;
  padding: 6px;
}
.loader {
  padding: 60px;
  text-align: center;
  color: var(--sw-fg-3);
  font-size: 11.5px;
}
.legend {
  position: absolute;
  left: 12px;
  bottom: 12px;
  padding: 8px 10px;
  font-size: 10.5px;
  min-width: 180px;
  background: rgba(15, 19, 26, 0.92);
  backdrop-filter: blur(8px);
  border: 1px solid var(--sw-line);
  border-radius: 6px;
}
.lg-label {
  font-size: 9.5px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--sw-fg-3);
  margin-bottom: 4px;
}
.lg-ramp {
  display: flex;
  gap: 4px;
  margin-bottom: 4px;
}
.lg-ramp span { width: 22px; height: 8px; border-radius: 2px; display: block; }
.lg-scale {
  display: flex;
  justify-content: space-between;
  color: var(--sw-fg-3);
  font-size: 9.5px;
}
.lg-rule {
  height: 1px;
  background: var(--sw-line);
  margin: 6px 0;
}
.lg-row {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 10.5px;
  color: var(--sw-fg-2);
}
.lg-swatch { width: 18px; height: 3px; border-radius: 1px; display: block; }
.lg-aside { color: var(--sw-fg-3); font-size: 9.5px; }
.lg-swatch-other { background: var(--sw-line-3); }
/* Floating zoom + fit controls at the top-right of the map area.
   Absolute-positioned over the SVG so they ride above any node /
   edge without taking layout space. */
.sm-zoom-ctrls {
  position: absolute;
  top: 12px;
  right: 12px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 6px;
  background: rgba(15, 19, 26, 0.92);
  backdrop-filter: blur(8px);
  border: 1px solid var(--sw-line);
  border-radius: 6px;
  z-index: 4;
}
.sm-zoom-ctrls .sw-btn.small {
  height: 22px;
  min-width: 26px;
  padding: 0 8px;
  font-size: 11px;
}
.sm-zoom-pct {
  font-family: var(--sw-mono);
  font-size: 10.5px;
  color: var(--sw-fg-3);
  padding-left: 4px;
  min-width: 38px;
  text-align: right;
}
.cap-chip {
  position: absolute;
  right: 12px;
  top: 44px;
  background: rgba(15, 19, 26, 0.92);
  border: 1px solid var(--sw-line);
  padding: 4px 8px;
  border-radius: 4px;
  font-size: 10px;
  color: var(--sw-fg-3);
}
/* `.sm-detail` was the legacy right-side sidebar; replaced by
   `.sm-panels` below the map. Kept the class deleted intentionally. */
.sp-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px;
  border-bottom: 1px solid var(--sw-line);
}
.sp-id { min-width: 0; flex: 1; }
.sp-mono {
  font-family: var(--sw-mono);
  font-size: 12.5px;
  font-weight: 600;
  color: var(--sw-fg-0);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sp-tags { margin-top: 4px; display: flex; gap: 4px; flex-wrap: wrap; }
.sw-tag.accent {
  background: var(--sw-accent-soft);
  color: var(--sw-accent-2);
  border-color: var(--sw-accent-line);
}
.sp-kpis {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(100px, 1fr));
  gap: 8px;
  padding: 12px;
}
.sp-kpi {
  padding: 6px 8px;
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line);
  border-radius: 4px;
}
.sp-kpi-label {
  font-size: 9.5px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--sw-fg-3);
}
.sp-kpi-value {
  font-size: 16px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.sp-section { padding: 8px 12px 4px; border-top: 1px solid var(--sw-line); }
.sp-section-title {
  font-size: 9.5px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--sw-fg-3);
  margin-bottom: 6px;
}
.sp-list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.sp-list li {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 0;
  border-bottom: 1px solid var(--sw-line);
  font-size: 11px;
}
.sp-list li:last-child { border-bottom: none; }
.sp-mono.small { font-family: var(--sw-mono); font-size: 11px; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--sw-fg-1); }
.sp-pulse { font-size: 8px; }
.sp-cpm { font-family: var(--sw-mono); font-size: 10.5px; color: var(--sw-fg-3); }
.sp-empty { color: var(--sw-fg-3); font-style: italic; }
.sp-actions {
  display: flex;
  gap: 8px;
  padding: 12px;
  border-top: 1px solid var(--sw-line);
}
.sw-btn.small {
  height: 24px;
  padding: 0 10px;
  font-size: 11px;
}
.sw-btn.small.primary {
  background: var(--sw-accent-soft);
  color: var(--sw-accent-2);
  border-color: var(--sw-accent-line);
}

@media (max-width: 1100px) {
  .sm-card { height: auto; }
  .sm-graph { height: 460px; }
  .sm-panels { grid-template-columns: 1fr; }
}
</style>
