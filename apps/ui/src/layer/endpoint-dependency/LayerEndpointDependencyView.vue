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
  Per-layer API dependency tab — design "Endpoint / API dependency".

  Layout strategy for large graphs:
    - The focused endpoint is anchored at layer index 0. Upstream
      callers go to negative indices, downstream callees to positive
      indices. We BFS in each direction; indices outside the rendered
      window are collapsed into a single "+N more" chip.
    - Per layer we cap the visible node count (NODES_PER_LAYER) by
      ranking on call rate; overflow is summarised in a chip.
    - The whole SVG sits inside a scroll container so wide graphs
      don't blow up the layer shell card; an outer pan handle lets
      the operator scrub.
    - Clicking a node opens an inline popout (the design's tail
      callout). Only one popout open at a time.
-->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watchEffect } from 'vue';
import { useRoute, useRouter, type RouteLocationRaw } from 'vue-router';
import { useI18n } from 'vue-i18n';
import type {
  EndpointDependencyCall,
  EndpointDependencyNode,
  EndpointDependencyResponse,
  LayerDef,
  TopologyMetricDef,
} from '@/api/client';
import { bffClient } from '@/api/client';
import { useLayerEndpointDependency } from '@/layer/endpoint-dependency/useLayerEndpointDependency';
import { useTimeRangeStore } from '@/controls/timeRange';
import { useLayerEndpoints } from '@/layer/useLayerEndpoints';
import { useLayerLanding } from '@/layer/useLayerLanding';
import { useLayers } from '@/shell/useLayers';
import { useSelectedEndpoint } from '@/layer/useSelectedEndpoint';
import { useSelectedService } from '@/layer/useSelectedService';
import { useLayerServiceName } from '@/layer/useLayerServiceName';
import { useSetupStore } from '@/state/setup';
import { fmtMetric } from '@/utils/formatters';
import { resolveServiceIdentity, type ServiceIdentity } from '@/utils/serviceName';
import { watch } from 'vue';
import Sparkline from '@/components/charts/Sparkline.vue';

const route = useRoute();
const router = useRouter();
const { t } = useI18n({ useScope: 'global' });
const timeRange = useTimeRangeStore();
const layerKey = computed(() => String(route.params.layerKey ?? ''));

const { selectedId, setSelected: setSelectedService } = useSelectedService();
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
// Layer-aware identity resolver — mirrors the topology view. Endpoint
// dependency nodes carry a `serviceName` field; we render it through
// the rule so k8s/mesh endpoints get a namespace chip.
const namingRule = computed(() => layer.value?.naming ?? null);
function identity(name: string | null | undefined): ServiceIdentity {
  return resolveServiceIdentity(name, namingRule.value);
}
const landing = useLayerLanding(safeLayer, safeCfg);
const serviceName = useLayerServiceName(layerKey, landing);
const landingRows = computed(() => landing.data.value?.sampledRows ?? landing.rows.value ?? []);
// Loading-sequence orchestration. The per-step waits keep this
// deterministic: service first, then the endpoint query (empty
// keyword → top-N), then the first-endpoint pick. See the matching
// `watchEffect` in LayerDashboardsView for the rationale.
// Defined further below once `endpointList` / `endpointsLoading` are
// in scope.

// ── Endpoint picker (same shape as Endpoint tab).
const { selectedEndpoint, setSelectedEndpoint } = useSelectedEndpoint();
const endpointSearchInput = ref('');
const endpointQuery = ref('');
const endpointLimit = ref(30);
function submitEndpointSearch(): void {
  endpointQuery.value = endpointSearchInput.value.trim();
}
function clearEndpointSearch(): void {
  endpointSearchInput.value = '';
  endpointQuery.value = '';
}
const { endpoints: endpointList, isFetching: endpointsLoading } = useLayerEndpoints(
  layerKey,
  serviceName,
  endpointQuery,
  endpointLimit,
);
// Drop stale endpoint when service changes.
watch(serviceName, (next, prev) => {
  if (prev !== undefined && next !== prev && selectedEndpoint.value) {
    setSelectedEndpoint(null);
  }
});
// Strict loading sequence (service → endpoint list → first-endpoint
// pick). `watchEffect` cascades naturally through the dependency
// updates; the `return` after step 1 prevents racing the endpoint
// pick before `serviceName` has propagated and the endpoint list
// has refreshed.
watchEffect(() => {
  if (!selectedId.value) {
    const first = landingRows.value[0];
    if (first) setSelectedService(first.serviceId);
    return;
  }
  if (selectedEndpoint.value) return;
  if (endpointsLoading.value) return;
  const first = endpointList.value[0];
  if (first) setSelectedEndpoint(first.name);
});

const { nodes: baseNodes, calls: baseCalls, isLoading, isFetching, data } = useLayerEndpointDependency(
  layerKey,
  serviceName,
  selectedEndpoint,
);
const reachable = computed(() => data.value?.reachable !== false);
const errorText = computed(() => data.value?.error ?? null);

// ── Interactive expansion ─────────────────────────────────────────
// `getEndpointDependencies` returns a node's WHOLE neighbourhood (both
// directions in ONE response — OAP has no directional endpoint query),
// so there is ONE expand per node, not a left/right pair. New callers
// land left, callees right via the BFS layout. The handle lives on the
// node's OUTWARD edge (the way the chain extends); keyed by node id so a
// repeat click is a no-op. A click that surfaces nothing new marks the
// node exhausted, fading the handle so it isn't a dead control.
const expansions = ref<Map<string, EndpointDependencyResponse>>(new Map());
const expansionsLoading = ref<Set<string>>(new Set());
const exhausted = ref<Set<string>>(new Set());
function hasExpansion(node: EndpointDependencyNode): boolean {
  return expansions.value.has(node.id);
}
function isExhausted(node: EndpointDependencyNode): boolean {
  return exhausted.value.has(node.id);
}
function isLoadingExpansion(node: EndpointDependencyNode): boolean {
  return expansionsLoading.value.has(node.id);
}
// Transient banner when an expand returns no NEW neighbour, so a leaf-node
// expand gives explicit feedback ("loaded, but nothing more") instead of
// the easily-missed handle fade. Auto-clears after a few seconds.
const noDepFlash = ref<string | null>(null);
let noDepFlashTimer: ReturnType<typeof setTimeout> | null = null;
function flashNoDep(name: string): void {
  noDepFlash.value = name;
  if (noDepFlashTimer) clearTimeout(noDepFlashTimer);
  noDepFlashTimer = setTimeout(() => {
    noDepFlash.value = null;
    noDepFlashTimer = null;
  }, 3200);
}
async function expandNode(node: EndpointDependencyNode): Promise<void> {
  const key = node.id;
  if (expansions.value.has(key) || expansionsLoading.value.has(key)) return;
  const loading = new Set(expansionsLoading.value);
  loading.add(key);
  expansionsLoading.value = loading;
  try {
    const before = new Set(nodes.value.map((n) => n.id));
    const resp = await bffClient.layer.endpointDependency(
      layerKey.value,
      node.serviceName,
      node.name,
      { step: timeRange.step, startMs: timeRange.range.startMs, endMs: timeRange.range.endMs },
    );
    const next = new Map(expansions.value);
    next.set(key, resp);
    expansions.value = next;
    // No new neighbour surfaced (chain leaf / all already shown) — fade
    // the handle AND flash an explicit "nothing more" banner.
    if (!resp.nodes.some((n) => !before.has(n.id))) {
      const e = new Set(exhausted.value);
      e.add(key);
      exhausted.value = e;
      flashNoDep(node.name);
    }
  } catch {
    // Soft-fail — the operator can click again to retry.
  } finally {
    const done = new Set(expansionsLoading.value);
    done.delete(key);
    expansionsLoading.value = done;
  }
}
// Reset expansions whenever the focus endpoint changes — the previous
// expansion graph is irrelevant against a new focus.
watch(selectedEndpoint, () => {
  expansions.value = new Map();
  expansionsLoading.value = new Set();
  exhausted.value = new Set();
  dragOffsets.value = new Map();
  // Cascade-clear the per-graph view state too. Endpoint ids are stable
  // across focuses, so without this a node/edge selected under the old
  // focus keeps the detail sidebar open against the new graph.
  selectedNodeId.value = null;
  selectedCallId.value = null;
  noDepFlash.value = null;
});

// ── Merged graph = focus response ∪ all expansion responses.
//    Deduplicate by node id and call id; later expansions don't
//    overwrite earlier metric values, which keeps the first-seen
//    snapshot stable while the operator browses. -------------------
const nodes = computed<EndpointDependencyNode[]>(() => {
  const map = new Map<string, EndpointDependencyNode>();
  for (const n of baseNodes.value) map.set(n.id, n);
  for (const exp of expansions.value.values()) {
    for (const n of exp.nodes) if (!map.has(n.id)) map.set(n.id, n);
  }
  return [...map.values()];
});
/** True when the call carries at least one resolved metric value. */
function callHasMetrics(c: EndpointDependencyCall): boolean {
  for (const v of Object.values(c.metrics ?? {})) if (v !== null) return true;
  return false;
}
const calls = computed<EndpointDependencyCall[]>(() => {
  // Merge with "prefer-metrics-populated" semantics: a later
  // expansion's view of the same edge wins when it has actual
  // metric values while the earlier copy was a null shell. Without
  // this, the very first fetch (which might have been served before
  // the BFF's virtual-source filter relaxation) keeps null-metric
  // edges in place even after the operator expanded a neighbour
  // that returns the correctly-populated row.
  const map = new Map<string, EndpointDependencyCall>();
  function consider(c: EndpointDependencyCall): void {
    const existing = map.get(c.id);
    if (!existing) {
      map.set(c.id, c);
      return;
    }
    if (!callHasMetrics(existing) && callHasMetrics(c)) {
      map.set(c.id, c);
    }
  }
  for (const c of baseCalls.value) consider(c);
  for (const exp of expansions.value.values()) {
    for (const c of exp.calls) consider(c);
  }
  return [...map.values()];
});

// ── Config from response (operator-edited layer JSON). Mirrors the
// service-map view's binding pattern: a role → metric def lookup
// drives every visual channel.
const cfg = computed(() => data.value?.config ?? {
  nodeMetrics: [] as TopologyMetricDef[],
  linkMetrics: [] as TopologyMetricDef[],
});
const showLegacyGroup = computed<boolean>(() => Boolean(cfg.value?.showGroup));
function pickByRole(defs: TopologyMetricDef[], role: TopologyMetricDef['role']): TopologyMetricDef | null {
  return defs.find((d) => d.role === role) ?? null;
}
const centerDef = computed(() => pickByRole(cfg.value.nodeMetrics, 'center'));
/**
 * Per-user threshold overrides take precedence over the template's
 * defaults. Setup store keys them by `<scope>.<metricId>` —
 * the API-dependency view uses scope `dependency`.
 */
const setupCfg = computed(() => store.ensure(layerKey.value, {
  slots: safeLayer.value.slots,
  caps: safeLayer.value.caps,
  metrics: safeLayer.value.metrics,
  overview: safeLayer.value.overview,
}));
function mergeThresholdOverride(def: TopologyMetricDef): TopologyMetricDef {
  const ov = setupCfg.value.landing.thresholdOverrides?.[`dependency.${def.id}`];
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
  return def ? mergeThresholdOverride(def) : null;
});
const secondaryDef = computed(() => pickByRole(cfg.value.nodeMetrics, 'secondary'));
const lineDef = computed(() => pickByRole(cfg.value.linkMetrics ?? [], 'lineServer'));

function nodeVal(n: EndpointDependencyNode, def: TopologyMetricDef | null): number | null {
  if (!def) return null;
  const v = n.metrics?.[def.id];
  return v ?? null;
}
function edgeVal(c: EndpointDependencyCall, def: TopologyMetricDef | null): number | null {
  if (!def) return null;
  const v = c.metrics?.[def.id];
  return v ?? null;
}

// ── Focused endpoint id (resolved by BFF; we surface the same id
// that came back so highlighting stays consistent even if the BFF
// picked the closest fuzzy match).
const focusedId = computed<string | null>(() => data.value?.endpointId ?? null);

// ── Compute layer index per node by BFS from focus, then bucket.
interface LayoutNode extends EndpointDependencyNode {
  layerIdx: number;
}
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
      for (const t of downstream.get(id) ?? []) {
        if (!layerOf.has(t)) {
          layerOf.set(t, cur + 1);
          queue.push(t);
        }
      }
      for (const s of upstream.get(id) ?? []) {
        if (!layerOf.has(s)) {
          layerOf.set(s, cur - 1);
          queue.push(s);
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

// ── Group nodes by layer index, cap each layer at NODES_PER_LAYER by
// CPM, and bucket the rest into a "+N more" pseudo-row.
const NODES_PER_LAYER = 8;
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

// ── SVG layout math. The template binds NW / COL_GAP via the same
// names; exposing them on a const-bag keeps Vue's setup-script
// auto-binding happy without resorting to `defineExpose`.
const NW = 152;
// Compact box: 3 tight stacked rows (service name / API name / RPM).
const NH = 56;
// Gap between columns leaves room for the curved edge's line-metric
// chip (60-80px) without colliding with adjacent node boxes.
const COL_GAP = 300;
const ROW_GAP = 80;
const W = computed(() => Math.max(800, layerColumns.value.length * COL_GAP + 80));
const H = computed(() => {
  const maxNodes = Math.max(1, ...layerColumns.value.map((c) => c.visible.length));
  return 80 + maxNodes * ROW_GAP + 40;
});

/**
 * Card height adapts to the graph the same way the topology view
 * does: 60% floor of a 780px baseline, capped at 1100px. Operators
 * get a consistent envelope across both dependency tabs.
 */
const CARD_BASELINE = 780;
const CARD_MIN = Math.round(CARD_BASELINE * 0.6);
const CARD_MAX = 1100;
const cardHeightPx = computed<number>(() => {
  const ideal = H.value + 80;
  return Math.max(CARD_MIN, Math.min(CARD_MAX, ideal));
});

interface Pos { x: number; y: number; col: number; row: number }
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

// ── Manual node drag. The operator can drag a box to declutter a dense
// graph; the offset layers on the BFS layout so edges (which read
// displayPos) follow. Cleared when a new focus endpoint rebuilds the graph.
const dragOffsets = ref<Map<string, { dx: number; dy: number }>>(new Map());
const displayPos = computed<Map<string, Pos>>(() => {
  if (dragOffsets.value.size === 0) return nodePos.value;
  const out = new Map<string, Pos>();
  for (const [id, p] of nodePos.value) {
    const off = dragOffsets.value.get(id);
    out.set(id, off ? { ...p, x: p.x + off.dx, y: p.y + off.dy } : p);
  }
  return out;
});

// Filter calls whose endpoints survived the per-layer cap.
const visibleCalls = computed<EndpointDependencyCall[]>(() => {
  const ids = new Set(nodePos.value.keys());
  return calls.value.filter((c) => ids.has(c.source) && ids.has(c.target));
});

// ── Pan / zoom. The SVG fits the whole graph by default (viewBox = full
// extent, aspect-preserved), so every column is visible — no edge dangles
// off a clipped column. Wheel + ＋/−/fit buttons zoom; drag pans.
const svgRef = ref<SVGSVGElement | null>(null);
const viewBox = ref<{ x: number; y: number; w: number; h: number } | null>(null);
// Set once the operator wheels / pans / zooms — an automatic refit
// (canvas resize, sidebar open/close) must not stomp a deliberate viewport.
const userAdjusted = ref(false);
const viewBoxStr = computed(() => {
  const v = viewBox.value ?? { x: 0, y: 0, w: W.value, h: H.value };
  return `${v.x} ${v.y} ${v.w} ${v.h}`;
});
// On-screen px per graph unit cap. A sparse graph (2-3 nodes) in a wide
// canvas would otherwise scale up under `meet` until the text balloons —
// most visible when nothing is selected and the graph spans full width
// (no detail sidebar). Capping holds node text at the same size whether
// or not the sidebar is open; the surplus room becomes centered padding.
const MAX_FIT_SCALE = 1.15;
function fitView(): void {
  userAdjusted.value = false;
  const r = svgRef.value?.getBoundingClientRect();
  if (!r || !r.width || !r.height) {
    viewBox.value = { x: 0, y: 0, w: W.value, h: H.value };
    return;
  }
  const scale = Math.min(r.width / W.value, r.height / H.value, MAX_FIT_SCALE);
  const vw = r.width / scale;
  const vh = r.height / scale;
  viewBox.value = { x: (W.value - vw) / 2, y: (H.value - vh) / 2, w: vw, h: vh };
}
// A new focus endpoint rebuilds the graph from scratch — always refit
// (this also clears userAdjusted). nextTick so the canvas has its
// post-change size.
watch(focusedId, () => void nextTick(fitView), { immediate: true });
// Column count changes mid-exploration (expanding a node adds a caller /
// callee layer). Refit so the new column is in view — unless the operator
// has zoomed/panned, in which case keep their viewport.
watch(
  () => layerColumns.value.length,
  () => {
    if (!userAdjusted.value) void nextTick(fitView);
  },
);

/** Rendered scale + letterbox offset for the current viewBox under
 *  preserveAspectRatio="xMidYMid meet" — so cursor zoom + drag pan map
 *  screen pixels to graph coordinates exactly. */
function viewMetrics() {
  const v = viewBox.value ?? { x: 0, y: 0, w: W.value, h: H.value };
  const r = svgRef.value?.getBoundingClientRect();
  const rw = r?.width || v.w;
  const rh = r?.height || v.h;
  const scale = Math.min(rw / v.w, rh / v.h) || 1;
  return { v, left: r?.left ?? 0, top: r?.top ?? 0, scale, offX: (rw - v.w * scale) / 2, offY: (rh - v.h * scale) / 2 };
}
function clientToView(clientX: number, clientY: number): { x: number; y: number } {
  const { v, left, top, scale, offX, offY } = viewMetrics();
  return { x: v.x + (clientX - left - offX) / scale, y: v.y + (clientY - top - offY) / scale };
}
function zoomAround(factor: number, cx: number, cy: number): void {
  userAdjusted.value = true;
  const v = viewBox.value ?? { x: 0, y: 0, w: W.value, h: H.value };
  // viewBox width bounded to [30%, 160%] of the full graph (zoom-in / out caps).
  const newW = Math.min(W.value * 1.6, Math.max(W.value * 0.3, v.w * factor));
  const k = newW / v.w;
  viewBox.value = { x: cx - (cx - v.x) * k, y: cy - (cy - v.y) * k, w: newW, h: v.h * k };
}
function onWheel(e: WheelEvent): void {
  e.preventDefault();
  const p = clientToView(e.clientX, e.clientY);
  zoomAround(e.deltaY > 0 ? 1.12 : 0.89, p.x, p.y);
}
function zoomBtn(factor: number): void {
  const v = viewBox.value ?? { x: 0, y: 0, w: W.value, h: H.value };
  zoomAround(factor, v.x + v.w / 2, v.y + v.h / 2);
}
// Drag-pan from the background (node/edge clicks keep their own handlers).
let panning = false;
let panStart = { cx: 0, cy: 0, vx: 0, vy: 0 };
function onPanStart(e: PointerEvent): void {
  panning = true;
  const v = viewBox.value ?? { x: 0, y: 0, w: W.value, h: H.value };
  panStart = { cx: e.clientX, cy: e.clientY, vx: v.x, vy: v.y };
  (e.target as Element).setPointerCapture?.(e.pointerId);
}
function onPanMove(e: PointerEvent): void {
  if (!panning) return;
  userAdjusted.value = true;
  const { v, scale } = viewMetrics();
  viewBox.value = { ...v, x: panStart.vx - (e.clientX - panStart.cx) / scale, y: panStart.vy - (e.clientY - panStart.cy) / scale };
}
function onPanEnd(): void {
  panning = false;
}

// Kind colour band — uses the endpoint's `type` field, then service
// name fallbacks (db/cache/mq/ext).
/**
 * Health-band colour from the configured ring metric. Reads the
 * operator's explicit `thresholds` block when present; otherwise
 * falls back to the historical err-% heuristic.
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
function ringColor(n: EndpointDependencyNode): string {
  const def = ringDef.value;
  if (!def) return 'var(--sw-line-2)';
  const v = nodeVal(n, def);
  if (v === null) return 'var(--sw-fg-3)';
  if (def.thresholds) return bandColor(v, def.thresholds);
  const isHealthHigh = /sla|success|apdex/i.test(def.id) || /sla|apdex|success/i.test(def.label);
  const errPct = isHealthHigh ? Math.max(0, 100 - v) : v;
  if (errPct > 5) return 'var(--sw-err)';
  if (errPct > 1) return 'var(--sw-warn)';
  if (errPct > 0.1) return '#fbbf24';
  return 'var(--sw-ok)';
}

/* `kindColor` / `kindLabel` were removed — endpoint nodes don't
 * carry meaningful component classification at the OAP wire level,
 * so the visual cue was unreliable. SLA-band border + focus star
 * carry all the per-node signal. */

// ── Selected node popout state. Anchors the design's tail callout
// just right of the clicked node.
const selectedNodeId = ref<string | null>(null);

// Per-node drag (distinct from the background pan). Pointer-captured on
// the box so move/up land here even off-box; screen pixels → graph units
// via the view scale. Under the 3px threshold it's a click → toggle
// selection (the box has no @click any more).
const nodeDragId = ref<string | null>(null);
let nodeDragStart = { x: 0, y: 0, baseDx: 0, baseDy: 0, moved: false };
function onNodePointerDown(e: PointerEvent, id: string): void {
  if (e.button !== 0) return;
  e.stopPropagation(); // don't also start a background pan
  const off = dragOffsets.value.get(id) ?? { dx: 0, dy: 0 };
  nodeDragId.value = id;
  nodeDragStart = { x: e.clientX, y: e.clientY, baseDx: off.dx, baseDy: off.dy, moved: false };
  (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
}
function onNodePointerMove(e: PointerEvent): void {
  if (nodeDragId.value === null) return;
  const dxs = e.clientX - nodeDragStart.x;
  const dys = e.clientY - nodeDragStart.y;
  if (!nodeDragStart.moved && Math.hypot(dxs, dys) > 3) nodeDragStart.moved = true;
  if (!nodeDragStart.moved) return;
  const { scale } = viewMetrics();
  const next = new Map(dragOffsets.value);
  next.set(nodeDragId.value, { dx: nodeDragStart.baseDx + dxs / scale, dy: nodeDragStart.baseDy + dys / scale });
  dragOffsets.value = next;
}
function onNodePointerUp(e: PointerEvent, id: string): void {
  const el = e.currentTarget as Element;
  if (el.hasPointerCapture?.(e.pointerId)) el.releasePointerCapture(e.pointerId);
  const downOnThis = nodeDragId.value === id;
  const moved = nodeDragStart.moved;
  nodeDragId.value = null;
  if (downOnThis && !moved) {
    selectedNodeId.value = selectedNodeId.value === id ? null : id;
  }
}
const selectedNode = computed<EndpointDependencyNode | null>(() => {
  const id = selectedNodeId.value;
  if (!id) return null;
  return nodes.value.find((n) => n.id === id) ?? null;
});
const popoutUpstream = computed(() => {
  const sel = selectedNode.value;
  if (!sel) return [];
  return visibleCalls.value
    .filter((c) => c.target === sel.id)
    .map((c) => nodes.value.find((n) => n.id === c.source))
    .filter((n): n is EndpointDependencyNode => !!n);
});
const popoutDownstream = computed(() => {
  const sel = selectedNode.value;
  if (!sel) return [];
  return visibleCalls.value
    .filter((c) => c.source === sel.id)
    .map((c) => nodes.value.find((n) => n.id === c.target))
    .filter((n): n is EndpointDependencyNode => !!n);
});

/**
 * Mirror of the topology view's row-label formatter — collapses the
 * redundant unit suffix (e.g. label="RPM" + unit="rpm" → "RPM") and
 * uppercases units per the design rule.
 */
function formatEdgeRowLabel(row: { label: string; unit?: string | null }): string {
  const lab = (row.label ?? '').trim();
  const u = (row.unit ?? '').trim();
  if (!u) return lab;
  if (lab.toLowerCase() === u.toLowerCase()) return lab.toUpperCase();
  return `${lab} (${u.toUpperCase()})`;
}

/** Open a route in a fresh browser tab — the graph stays put so the
 *  operator can fan out to several services/endpoints without losing
 *  their place. History mode means `resolve(...).href` is a real URL. */
function openRouteInNewTab(to: RouteLocationRaw): void {
  const href = router.resolve(to).href;
  window.open(href, '_blank', 'noopener');
}

function jumpToService(): void {
  const sel = selectedNode.value;
  if (!sel) return;
  openRouteInNewTab({
    path: `/layer/${layerKey.value}/service`,
    query: { service: sel.serviceId },
  });
}
/**
 * Open the Endpoint dashboard for the clicked node in a new tab — same
 * pattern as topology's "Open service" jump. No client-side keyword
 * search: we hand the endpoint name + service id to the page via the
 * URL, and the Endpoint view's own auto-pick effect resolves it.
 */
function jumpToEndpointDashboard(): void {
  const sel = selectedNode.value;
  if (!sel) return;
  openRouteInNewTab({
    path: `/layer/${layerKey.value}/endpoint`,
    query: {
      service: sel.serviceId,
      endpoint: sel.name,
    },
  });
}

/** Bi-direction-aware curved path. Same rule as the service map's
 *  `callPathD`: bow the arc to one side of the chord; for the
 *  matching reverse call we bow the other side so both lines stay
 *  visible. No arrowhead — animated traffic dots advertise direction. */
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

// Edge selection — same independent-from-node model as the service
// map. Edge panel surfaces server-side line metrics only (OAP doesn't
// expose a client family for endpoint relations).
const selectedCallId = ref<string | null>(null);
function selectCall(id: string | null): void {
  selectedCallId.value = selectedCallId.value === id ? null : id;
}
const selectedCall = computed<EndpointDependencyCall | null>(() => {
  const id = selectedCallId.value;
  if (!id) return null;
  return calls.value.find((c) => c.id === id) ?? null;
});
const selectedCallSource = computed<EndpointDependencyNode | null>(() => {
  const c = selectedCall.value;
  if (!c) return null;
  return nodes.value.find((n) => n.id === c.source) ?? null;
});
const selectedCallTarget = computed<EndpointDependencyNode | null>(() => {
  const c = selectedCall.value;
  if (!c) return null;
  return nodes.value.find((n) => n.id === c.target) ?? null;
});

// The detail sidebar appears only when a node or edge is selected, and its
// presence changes the canvas width — which would otherwise rescale the
// viewBox and resize node text. Refit on that toggle (and on window
// resize) so the capped scale recomputes for the new width, unless the
// operator has taken manual control of the viewport.
watch(
  () => Boolean(selectedNode.value || selectedCall.value),
  () => {
    if (!userAdjusted.value) void nextTick(fitView);
  },
);
function onWindowResize(): void {
  if (!userAdjusted.value) fitView();
}
onMounted(() => {
  fitView();
  window.addEventListener('resize', onWindowResize);
});
onBeforeUnmount(() => {
  window.removeEventListener('resize', onWindowResize);
  if (noDepFlashTimer) clearTimeout(noDepFlashTimer);
});
function edgeSeries(c: EndpointDependencyCall, def: TopologyMetricDef): Array<number | null> {
  return c.metricSeries?.[def.id] ?? [];
}
function seriesAt(arr: Array<number | null>, idx: number): number | null {
  if (idx < 0 || idx >= arr.length) return null;
  return arr[idx];
}

// Same synced-cursor model as the topology view — single hovered
// row at a time, both the chart and the value tip update together.
// API-dep is server-side only so there's no diff to show, just the
// value at the hovered bucket.
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
function edgeRowCrosshair(rowId: string): number | null {
  return hoveredEdgeRowId.value === rowId ? hoveredEdgeBucket.value : null;
}
</script>

<template>
  <div class="ep-tab">
    <!-- Endpoint picker — search-on-Enter (mirrors the Endpoint tab). -->
    <section class="ep-picker sw-card">
      <header class="picker-head">
        <span class="kicker">{{ t('API dependency') }}</span>
        <span v-if="serviceName" class="for-svc">
          on
          <span v-if="identity(serviceName).cluster" class="sw-tag accent tiny inline-tag">
            <span class="tag-alias">{{ identity(serviceName).clusterAlias }}</span>
            <span class="tag-val">{{ identity(serviceName).cluster }}</span>
          </span>
          <span v-if="showLegacyGroup && identity(serviceName).legacyGroup" class="sw-tag tiny inline-tag">
            <span class="tag-alias">group</span>
            <span class="tag-val">{{ identity(serviceName).legacyGroup }}</span>
          </span>
          <b>{{ identity(serviceName).display }}</b>
        </span>
        <span v-if="isFetching" class="hint">{{ t('refreshing…') }}</span>
      </header>
      <div v-if="!serviceName" class="empty inline">
        {{ t('Pick a service in the header above to search its endpoints.') }}
      </div>
      <template v-else>
        <div class="ep-controls">
          <input
            class="ep-search"
            type="search"
            :placeholder="t('Search endpoints, press Enter…')"
            v-model="endpointSearchInput"
            @keydown.enter.prevent="submitEndpointSearch"
            @search="submitEndpointSearch"
          />
          <button class="sw-btn small" type="button" @click="submitEndpointSearch">{{ t('Search') }}</button>
          <button v-if="endpointQuery" class="sw-btn ghost small" type="button" @click="clearEndpointSearch">
            {{ t('Clear') }}
          </button>
          <label class="ep-limit">
            <span>{{ t('Top') }}</span>
            <select v-model.number="endpointLimit">
              <option :value="20">20</option>
              <option :value="30">30</option>
              <option :value="50">50</option>
            </select>
          </label>
        </div>
        <ul v-if="!endpointsLoading && endpointList.length > 0" class="ep-list">
          <li
            v-for="e in endpointList"
            :key="e.id"
            class="ep-row"
            :class="{ on: selectedEndpoint === e.name }"
          >
            <button class="ep-pick" type="button" @click="setSelectedEndpoint(e.name)">
              {{ e.name }}
            </button>
          </li>
        </ul>
        <div v-else-if="!endpointsLoading" class="empty inline">
          {{ t('No endpoints found.') }}
        </div>
      </template>
    </section>

    <div v-if="!reachable" class="banner err">
      <strong>{{ t('OAP unreachable.') }}</strong>
      {{ errorText ?? t('API dependency feed failed — check the BFF and OAP.') }}
    </div>

    <section v-if="selectedEndpoint" class="ep-graph-card sw-card" :class="{ 'has-detail': selectedNode || selectedCall }" :style="{ height: cardHeightPx + 'px' }">
      <!-- Two-column layout: graph on the left, selection detail
           panel on the right. Mirrors the topology view's sidebar so
           operators get the same interaction pattern across the two
           dependency tabs. -->
      <div class="ep-graph">
        <header class="graph-head">
          <h4>{{ t('API dependency chain') }}</h4>
          <span class="hint">
            {{ t('{cols} columns · {eps} endpoints · click a node or edge for details', { cols: layerColumns.length, eps: nodes.length }) }}
          </span>
        </header>

        <div class="ep-scroll">
        <!-- Transient feedback when an expand returns no new dependency. -->
        <transition name="ep-flash">
          <div v-if="noDepFlash" class="ep-nodep-flash">
            <span>{{ t('No further callers or callees for {name}', { name: noDepFlash }) }}</span>
          </div>
        </transition>
        <!-- Zoom toolbar — over the canvas (not the header); wheel + drag
             also work directly on the graph. -->
        <div v-if="layoutNodes.length > 0" class="ep-zoom">
          <button type="button" :title="t('Zoom in')" @click="zoomBtn(0.8)">＋</button>
          <button type="button" :title="t('Zoom out')" @click="zoomBtn(1.25)">−</button>
          <button type="button" :title="t('Fit to view')" @click="fitView">⤢</button>
        </div>
        <svg
          v-if="layoutNodes.length > 0"
          ref="svgRef"
          class="ep-svg"
          :viewBox="viewBoxStr"
          preserveAspectRatio="xMidYMid meet"
          @wheel="onWheel"
        >
          <!-- No arrow markers — the animated dots advertise direction. -->
          <defs>
            <!-- Clip node text to the box interior so long endpoint names
                 are cut at the boundary instead of overflowing it. Evaluated
                 in each node's local space, so one def clips every node. -->
            <clipPath id="ep-node-text-clip">
              <rect :x="8" :y="0" :width="NW - 16" :height="NH" />
            </clipPath>
          </defs>
          <!-- Background pan target. Behind everything; node / edge clicks
               keep their own handlers. -->
          <rect
            class="ep-pan-bg"
            :x="-W"
            :y="-H"
            :width="W * 3"
            :height="H * 3"
            fill="transparent"
            @pointerdown="onPanStart"
            @pointermove="onPanMove"
            @pointerup="onPanEnd"
            @pointerleave="onPanEnd"
          />

          <!-- column guide lines -->
          <line
            v-for="(col, i) in layerColumns"
            :key="`g-${col.index}`"
            :x1="40 + i * COL_GAP + NW / 2"
            :x2="40 + i * COL_GAP + NW / 2"
            :y1="40"
            :y2="H - 12"
            stroke="var(--sw-line)"
            stroke-dasharray="2 6"
            opacity="0.4"
          />

          <!-- edges. Curved, bi-direction-aware, no arrowhead. Clickable
               so the operator can open the edge sidebar with the
               configured server-side line metrics. Traffic dots flow
               along the focus + heaviest edges. -->
          <g
            v-for="c in visibleCalls"
            :key="c.id"
            class="ep-edge"
            @click.stop="selectCall(c.id)"
          >
            <path
              :d="callPathD(c)"
              fill="none"
              stroke="transparent"
              stroke-width="14"
              style="cursor: pointer"
            />
            <path
              :d="callPathD(c)"
              fill="none"
              :stroke="selectedCallId === c.id ? 'var(--sw-accent-2)' : 'var(--sw-accent)'"
              :stroke-width="(() => {
                if (selectedCallId === c.id) return 3.4;
                if (c.source === focusedId || c.target === focusedId) return 2.8;
                const v = edgeVal(c, lineDef);
                if (v === null) return 1.4;
                if (v > 5000) return 2.4;
                if (v > 500) return 2;
                return 1.4;
              })()"
              :opacity="selectedCallId === c.id ? 1 : c.source === focusedId || c.target === focusedId ? 0.95 : 0.6"
              stroke-linecap="round"
              style="pointer-events: none"
            >
              <title v-if="lineDef">{{ lineDef.label }}: {{ fmtMetric(edgeVal(c, lineDef)) }} {{ lineDef.unit ?? '' }}</title>
            </path>
            <!-- Animated traffic dots on EVERY edge — they advertise call
                 direction (source→target) in place of arrowheads, so an
                 expanded edge that doesn't touch the focus still shows
                 which way the call flows. Selected edge dots brighten. -->
            <circle
              v-for="off in [0, 0.5, 1.0]"
              :key="off"
              r="2.2"
              :fill="selectedCallId === c.id ? 'var(--sw-accent-2)' : 'var(--sw-accent)'"
              :opacity="selectedCallId === c.id || c.source === focusedId || c.target === focusedId ? 0.9 : 0.6"
              style="pointer-events: none"
            >
              <animateMotion
                :dur="`${2.4 + (off * 0.4)}s`"
                :begin="`${off}s`"
                repeatCount="indefinite"
                :path="callPathD(c)"
              />
            </circle>
            <!-- Compact metric chip at the curve midpoint. -->
            <template v-if="lineDef && edgeVal(c, lineDef) !== null && callMidpoint(c)">
              <g
                :transform="`translate(${callMidpoint(c)!.x - 30}, ${callMidpoint(c)!.y - 9})`"
                style="pointer-events: none"
              >
                <rect
                  x="0"
                  y="0"
                  width="60"
                  height="16"
                  rx="8"
                  fill="var(--sw-bg-1)"
                  :stroke="selectedCallId === c.id ? 'var(--sw-accent-2)' : c.source === focusedId || c.target === focusedId ? 'var(--sw-accent)' : 'var(--sw-line-2)'"
                  :stroke-width="selectedCallId === c.id ? 1.4 : 1"
                />
                <text
                  x="30"
                  y="11"
                  text-anchor="middle"
                  :fill="selectedCallId === c.id ? 'var(--sw-accent-2)' : c.source === focusedId || c.target === focusedId ? 'var(--sw-accent-2)' : 'var(--sw-fg-2)'"
                  font-size="9"
                  font-family="var(--sw-mono)"
                  font-weight="700"
                >
                  {{ fmtMetric(edgeVal(c, lineDef)) }}<tspan v-if="lineDef.unit" :dx="2" fill="var(--sw-fg-3)" font-weight="500">{{ lineDef.unit }}</tspan>
                </text>
              </g>
            </template>
          </g>

          <!-- nodes -->
          <g
            v-for="n in layoutNodes.filter((nn) => nodePos.get(nn.id))"
            :key="n.id"
            :transform="`translate(${displayPos.get(n.id)!.x}, ${displayPos.get(n.id)!.y})`"
            class="ep-node"
            :class="{ dragging: nodeDragId === n.id }"
            role="button"
            tabindex="0"
            :aria-label="`${n.name} — ${identity(n.serviceName).display}`"
            @pointerdown="onNodePointerDown($event, n.id)"
            @pointermove="onNodePointerMove($event)"
            @pointerup="onNodePointerUp($event, n.id)"
            @keydown.enter.prevent="selectedNodeId = selectedNodeId === n.id ? null : n.id"
            @keydown.space.prevent="selectedNodeId = selectedNodeId === n.id ? null : n.id"
          >
            <!-- Selection halo only — the FOCUS node is identifiable
                 by its column header (`L0 · Focus`) and an inset
                 "★" badge below; no orange halo (was too easily
                 confused with the operator-selected node). -->
            <rect
              v-if="n.id === selectedNodeId"
              x="-4"
              y="-4"
              :width="NW + 8"
              :height="NH + 8"
              rx="10"
              fill="var(--sw-accent)"
              opacity="0.18"
            />
            <!-- Body fill. Border colour follows the ring metric
                 (SLA band). Selected node gets the accent border;
                 focus keeps its ring border — distinct treatments. -->
            <rect
              x="0"
              y="0"
              :width="NW"
              :height="NH"
              rx="6"
              :fill="n.id === selectedNodeId ? 'rgba(249,115,22,0.10)' : 'var(--sw-bg-2)'"
              :stroke="n.id === selectedNodeId ? 'var(--sw-accent)' : ringColor(n)"
              :stroke-width="n.id === selectedNodeId ? 2 : 1.8"
            />
            <!-- Focus marker — small star bottom-right. Operator's
                 mental cue: "this is the endpoint I clicked into",
                 without sharing the orange halo with selection. -->
            <g v-if="n.id === focusedId" :transform="`translate(${NW - 12}, ${NH - 12})`">
              <circle r="7" fill="var(--sw-bg-0)" stroke="var(--sw-accent-line)" stroke-width="1" />
              <text
                text-anchor="middle"
                y="3"
                font-size="9"
                font-weight="700"
                fill="var(--sw-accent-2)"
              >★</text>
              <title>{{ t('Focus endpoint') }}</title>
            </g>
            <!-- Agent badge — straddles the top-left corner the way the
                 service-map hexagon's does (top-right is the expand
                 handle, bottom-right the focus star). Marks an endpoint
                 on an instrumented (real) service; the synthetic User and
                 external callees carry none. Shares the Topology node
                 vocabulary. No kind icon — endpoint nodes don't carry a
                 component classification on the OAP wire. -->
            <g v-if="n.isReal" transform="translate(0, 0)">
              <circle r="8" fill="var(--sw-bg-0)" stroke="var(--sw-accent-line)" stroke-width="1" />
              <circle r="6.8" fill="var(--sw-accent)" opacity="0.18" />
              <g transform="translate(-5.4, -5.4) scale(0.48)" fill="var(--sw-accent-2)">
                <path d="M3 14c4-3 8-3 12-1 3 1.4 5 .5 6-1-1 5-4 8-9 8-4 0-7-2-9-6z" />
                <path
                  d="M5 10c3-2 7-2 11 0 3 1.3 5 .6 6-1-1 3.6-4 6-8 6-4 0-7-1.6-9-5z"
                  fill="#fff"
                  opacity="0.25"
                />
              </g>
            </g>
            <!-- Row 1: full service name (small, fg-3 mono). -->
            <text
              x="11"
              y="16"
              fill="var(--sw-fg-3)"
              font-size="9"
              font-family="var(--sw-mono)"
              clip-path="url(#ep-node-text-clip)"
            >
              <title>{{ n.serviceName }}</title>
              {{ identity(n.serviceName).display.length > 21 ? identity(n.serviceName).display.slice(0, 19) + '…' : identity(n.serviceName).display }}
            </text>
            <!-- Row 2: API (endpoint) name — the headline. -->
            <text
              x="11"
              y="31"
              fill="var(--sw-fg-0)"
              font-size="11.5"
              font-family="var(--sw-mono)"
              :font-weight="n.id === focusedId ? 700 : 600"
              clip-path="url(#ep-node-text-clip)"
            >
              <title>{{ n.name }}</title>
              {{ n.name.length > 18 ? n.name.slice(0, 16) + '…' : n.name }}
            </text>
            <!-- Row 3: configured `center` metric (typically RPM).
                 Coloured in the ring band so the visual signal
                 reinforces the border. -->
            <text
              x="11"
              y="45"
              :fill="centerDef && nodeVal(n, centerDef) !== null ? ringColor(n) : 'var(--sw-fg-3)'"
              font-size="10"
              font-family="var(--sw-mono)"
              font-weight="700"
            >
              {{
                centerDef
                  ? (nodeVal(n, centerDef) === null
                      ? `— ${(centerDef.unit ?? '').toUpperCase()}`
                      : `${fmtMetric(nodeVal(n, centerDef))}${centerDef.unit ? ' ' + centerDef.unit.toUpperCase() : ''}`)
                  : ''
              }}<template v-if="secondaryDef && nodeVal(n, secondaryDef) !== null"><tspan fill="var(--sw-fg-3)"> · </tspan><tspan fill="var(--sw-fg-2)" font-weight="500">{{ fmtMetric(nodeVal(n, secondaryDef)) }}{{ secondaryDef.unit ? ' ' + secondaryDef.unit.toUpperCase() : '' }}</tspan></template>
            </text>
            <!-- One neutral expand handle (top-right corner) on the
                 SELECTED non-focus node. A single `getEndpointDependencies`
                 call returns the node's WHOLE neighbourhood, so one click
                 expands BOTH directions — new callers land left, callees
                 right via the layout. States: `+` (expandable) → spinner
                 (loading callers & callees) → `+` accent (expanded) or a
                 faded `·` (no further dependency). -->
            <g
              v-if="selectedNodeId === n.id && n.id !== focusedId"
              class="ep-expand"
              :class="{ exhausted: isExhausted(n), loading: isLoadingExpansion(n) }"
              :transform="`translate(${NW - 9}, -9)`"
              role="button"
              tabindex="0"
              :aria-label="t('Expand {name} — show its callers and callees', { name: n.name })"
              @pointerdown.stop
              @click.stop="expandNode(n)"
              @keydown.enter.prevent="expandNode(n)"
              @keydown.space.prevent="expandNode(n)"
            >
              <circle r="9" cx="9" cy="9" fill="var(--sw-bg-0)" :stroke="hasExpansion(n) || isLoadingExpansion(n) ? 'var(--sw-accent-2)' : 'var(--sw-line-2)'" stroke-width="1" />
              <!-- loading spinner: a spinning arc while the dependency query is in flight -->
              <circle
                v-if="isLoadingExpansion(n)"
                cx="9"
                cy="9"
                r="6"
                fill="none"
                stroke="var(--sw-accent-2)"
                stroke-width="2"
                stroke-dasharray="11 30"
                stroke-linecap="round"
              >
                <animateTransform attributeName="transform" type="rotate" from="0 9 9" to="360 9 9" dur="0.7s" repeatCount="indefinite" />
              </circle>
              <text
                v-else
                x="9"
                y="13"
                text-anchor="middle"
                font-size="14"
                font-weight="600"
                :fill="isExhausted(n) ? 'var(--sw-fg-3)' : hasExpansion(n) ? 'var(--sw-accent-2)' : 'var(--sw-fg-1)'"
              >{{ isExhausted(n) ? '·' : '+' }}</text>
              <title>{{ isLoadingExpansion(n) ? t('Loading callers and callees of {name}…', { name: n.name }) : isExhausted(n) ? t('No further callers or callees for {name}', { name: n.name }) : t('Expand {name} — show its callers and callees', { name: n.name }) }}</title>
            </g>
          </g>
        </svg>

          <div v-else-if="isLoading" class="loader">{{ t('loading…') }}</div>
          <div v-else class="loader">
            {{ t('No dependency graph available for this endpoint in the selected time range.') }}
          </div>
        </div>

        <!-- Legend strip at the bottom of the graph card — mirrors
             the topology view's legend, with kind colour chips for
             the left-stripe of each node + the call line treatment. -->
        <div class="ep-legend">
          <div v-if="ringDef" class="lg-block">
            <span class="lg-lbl">{{ ringDef.label }}</span>
            <span class="lg-band">
              <span style="background: var(--sw-ok)" />
              <span style="background: #fbbf24" />
              <span style="background: var(--sw-warn)" />
              <span style="background: var(--sw-err)" />
            </span>
          </div>
          <div class="lg-block">
            <span class="lg-lbl">{{ t('Calls') }}</span>
            <span class="lg-aside">
              {{ t('thicker = heaviest (by {metric})', { metric: lineDef?.label ?? 'RPM' }) }}
            </span>
          </div>
          <div class="lg-block">
            <span class="lg-lbl">★</span>
            <span class="lg-aside">{{ t('Focus endpoint') }}</span>
          </div>
        </div>
      </div>

      <!-- Sidebar — node panel on top, edge panel underneath (mirrors
           the service topology layout). Both selections are
           independent so they stay open in parallel. -->
      <aside v-if="selectedNode || selectedCall" class="ep-detail">
      <!-- Top slot: node panel (when selected). -->
      <section v-if="selectedNode" class="ep-detail-block">
        <header class="ed-head">
          <div class="ed-id">
            <div class="ed-kind-row">
              <span v-if="identity(selectedNode.serviceName).cluster" class="sw-tag accent tiny">
                <span class="tag-alias">{{ identity(selectedNode.serviceName).clusterAlias }}</span>
                <span class="tag-val">{{ identity(selectedNode.serviceName).cluster }}</span>
              </span>
              <span v-if="showLegacyGroup && identity(selectedNode.serviceName).legacyGroup" class="sw-tag tiny">
                <span class="tag-alias">group</span>
                <span class="tag-val">{{ identity(selectedNode.serviceName).legacyGroup }}</span>
              </span>
              <span class="ed-svc">{{ identity(selectedNode.serviceName).display }}</span>
              <span v-if="selectedNode.id === focusedId" class="sw-tag accent">{{ t('focus') }}</span>
            </div>
            <div class="ed-name">{{ selectedNode.name }}</div>
          </div>
          <button class="sw-btn small" type="button" @click="selectedNodeId = null">×</button>
        </header>
        <div class="ed-kpis">
          <div v-for="m in cfg.nodeMetrics" :key="m.id" class="ed-kpi">
            <div class="ed-kpi-label">{{ m.label }}<span v-if="m.unit"> ({{ m.unit }})</span></div>
            <div
              class="ed-kpi-value"
              :style="{ color: m.role === 'center' ? 'var(--sw-accent)' : m.role === 'ring' ? 'var(--sw-warn)' : 'var(--sw-fg-0)' }"
            >
              {{ fmtMetric(nodeVal(selectedNode, m)) }}
            </div>
          </div>
        </div>
        <div class="ed-section">
          <div class="ed-section-title">{{ t('Callers ({n})', { n: popoutUpstream.length }) }}</div>
          <ul class="ed-list">
            <li v-for="u in popoutUpstream" :key="u.id">
              <span class="ed-mono small">{{ u.name }}</span>
              <span class="ed-arrow">→</span>
              <span class="ed-mono small accent">{{ selectedNode.name }}</span>
            </li>
            <li v-if="popoutUpstream.length === 0" class="ed-empty">{{ t('no callers in this window') }}</li>
          </ul>
        </div>
        <div class="ed-section">
          <div class="ed-section-title">{{ t('Callees ({n})', { n: popoutDownstream.length }) }}</div>
          <ul class="ed-list">
            <li v-for="d in popoutDownstream" :key="d.id">
              <span class="ed-mono small accent">{{ selectedNode.name }}</span>
              <span class="ed-arrow">→</span>
              <span class="ed-mono small">{{ d.name }}</span>
            </li>
            <li v-if="popoutDownstream.length === 0" class="ed-empty">{{ t('no callees in this window') }}</li>
          </ul>
        </div>
        <div class="ed-actions">
          <button class="sw-btn small primary" type="button" @click="jumpToEndpointDashboard">
            {{ t('Open endpoint') }}
          </button>
          <button class="sw-btn small" type="button" @click="jumpToService">{{ t('Service →') }}</button>
        </div>
      </section>

      <!-- Bottom slot: edge panel. Endpoint relations are server-side
           only; each metric row carries a single line chart (no
           client column) plus the live aggregated value. -->
      <section v-if="selectedCall && selectedCallSource && selectedCallTarget" class="ep-detail-block">
        <header class="ed-head">
          <div class="ed-id">
            <div class="ed-edge-row">
              <span class="ed-mono small">{{ selectedCallSource.name }}</span>
              <span class="ed-arrow">→</span>
              <span class="ed-mono small">{{ selectedCallTarget.name }}</span>
            </div>
            <div class="ed-edge-svc">
              {{ identity(selectedCallSource.serviceName).display }} → {{ identity(selectedCallTarget.serviceName).display }}
            </div>
          </div>
          <button class="sw-btn small" type="button" @click="selectedCallId = null">×</button>
        </header>
        <div class="ed-section">
          <div class="ed-section-title">{{ t('Line metrics (server-side)') }}</div>
          <div v-if="(cfg.linkMetrics ?? []).length > 0" class="ed-edge-rows">
            <div
              v-for="m in (cfg.linkMetrics ?? [])"
              :key="m.id"
              class="ed-edge-row-card"
            >
              <div class="ed-edge-row-head">
                <span class="ed-edge-row-label">{{ formatEdgeRowLabel(m) }}</span>
                <!-- Hover crosshair value at the bucket — server-side
                     only so there's no diff column. -->
                <span
                  v-if="hoveredEdgeRowId === m.id && hoveredEdgeBucket !== null"
                  class="ed-edge-tip"
                >{{ fmtMetric(seriesAt(edgeSeries(selectedCall, m), hoveredEdgeBucket)) }}<template v-if="m.unit"> {{ m.unit.toUpperCase() }}</template></span>
                <span class="ed-edge-row-num">{{ fmtMetric(edgeVal(selectedCall, m)) }}</span>
              </div>
              <Sparkline
                :values="edgeSeries(selectedCall, m)"
                color="var(--sw-accent)"
                :height="38"
                :stroke="1.4"
                fluid
                :crosshair-bucket="edgeRowCrosshair(m.id)"
                @bucket-hover="(b: number) => onEdgeBucketHover(m.id, b)"
                @bucket-leave="onEdgeBucketLeave"
              />
            </div>
          </div>
          <div v-else class="ed-empty">{{ t('no line metrics configured') }}</div>
        </div>
      </section>

      <!-- Empty prompts. -->
      <section v-if="!selectedNode" class="ep-detail-empty">
        <span>{{ t('Click an endpoint node to inspect it') }}</span>
      </section>
      <section v-if="!(selectedCall && selectedCallSource && selectedCallTarget)" class="ep-detail-empty">
        <span>{{ t('Click an edge to inspect the call') }}</span>
      </section>
      </aside>
    </section>

    <section v-else-if="serviceName" class="empty">
      Select an endpoint above to see its dependency chain.
    </section>
  </div>
</template>

<style scoped>
.ep-tab {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 4px 0 0;
}
/* Per-node outward expand handle. */
.ep-expand {
  cursor: pointer;
}
/* Only the actionable (expandable) handle brightens on hover. */
.ep-expand:not(.exhausted):not(.loading):hover circle {
  stroke: var(--sw-accent);
}
.ep-expand:not(.exhausted):not(.loading):hover text {
  fill: var(--sw-accent);
}
/* No-dependency = a click revealed nothing new (chain leaf): faded `·`,
   not clickable-feeling, but still hoverable so the tooltip explains it
   (the click handler is already a no-op once expanded). */
.ep-expand.exhausted {
  opacity: 0.5;
  cursor: default;
}
.ep-expand.loading {
  cursor: progress;
}
.ep-picker { padding: 0; }
.picker-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--sw-line);
}
.kicker {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--sw-accent);
  font-weight: 600;
}
.for-svc { font-size: 11px; color: var(--sw-fg-3); display: inline-flex; align-items: center; gap: 6px; }
.for-svc b { color: var(--sw-fg-1); font-family: var(--sw-mono); font-weight: 500; }
.sw-tag.tiny {
  font-size: 9.5px;
  padding: 0 5px;
  line-height: 14px;
  height: 14px;
}
.sw-tag .tag-alias { opacity: 0.7; font-weight: 500; margin-right: 4px; }
.sw-tag .tag-alias::after { content: '·'; margin-left: 4px; }
.sw-tag .tag-val { font-family: var(--sw-mono); font-weight: 600; }
.hint { font-size: 10.5px; color: var(--sw-fg-3); margin-left: auto; }
.ep-controls {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--sw-line);
}
.ep-search {
  flex: 1;
  height: 26px;
  padding: 0 8px;
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line-2);
  border-radius: 4px;
  color: var(--sw-fg-0);
  font: inherit;
  font-size: 11.5px;
}
.ep-search:focus { outline: none; border-color: var(--sw-accent-line); }
.ep-limit {
  display: inline-flex;
  align-items: baseline;
  gap: 5px;
  font-size: 10.5px;
  color: var(--sw-fg-3);
}
.ep-limit select {
  height: 26px;
  padding: 0 6px;
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line-2);
  border-radius: 4px;
  color: var(--sw-fg-0);
  font: inherit;
  font-size: 11.5px;
}
.ep-list {
  list-style: none;
  margin: 0;
  padding: 4px 0;
  max-height: 220px;
  overflow-y: auto;
}
.ep-row {
  padding: 2px 10px;
  border-bottom: 1px solid var(--sw-line);
}
.ep-row:last-child { border-bottom: none; }
.ep-row.on { background: var(--sw-accent-soft); }
.ep-pick {
  display: block;
  width: 100%;
  padding: 6px 8px;
  background: transparent;
  border: none;
  color: var(--sw-fg-1);
  font: inherit;
  font-family: var(--sw-mono);
  font-size: 11.5px;
  text-align: left;
  cursor: pointer;
}
.ep-pick:hover { background: var(--sw-bg-2); color: var(--sw-fg-0); }
.ep-row.on .ep-pick { color: var(--sw-accent-2); font-weight: 600; }
.empty.inline { padding: 18px; font-size: 11px; color: var(--sw-fg-3); }
.empty {
  padding: 32px;
  text-align: center;
  color: var(--sw-fg-3);
  font-size: 12px;
}
.banner.err {
  padding: 8px 12px;
  background: var(--sw-err-soft);
  border: 1px solid rgba(239, 68, 68, 0.3);
  border-radius: 6px;
  color: #f87171;
  font-size: 11.5px;
}
.ep-graph-card {
  /* Height comes from the script's `cardHeightPx` computed — same
     adapter as the topology card: 60% floor + 1100px cap, scaled by
     the graph's actual content. The inline `style="height: …"` on
     the section wins over this declaration. */
  padding: 0;
  display: grid;
  /* Single column by default; the 320px detail sidebar only takes space
     once a node/edge is selected, so the graph fills the full width on
     the default page instead of reserving an empty panel. */
  grid-template-columns: 1fr;
  overflow: hidden;
}
.ep-graph-card.has-detail {
  grid-template-columns: 1fr 320px;
}
/* Legend strip at the bottom of the graph column. Sits inside
   `.ep-graph` so it shares the card height with the SVG scroll. */
.ep-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 18px;
  padding: 8px 14px;
  border-top: 1px solid var(--sw-line);
  background: var(--sw-bg-1);
  flex: 0 0 auto;
}
.lg-block {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 10.5px;
}
.lg-lbl {
  font-size: 9.5px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--sw-fg-3);
  font-weight: 700;
}
.lg-band {
  display: inline-flex;
  gap: 2px;
}
.lg-band span {
  width: 18px;
  height: 6px;
  border-radius: 1px;
  display: inline-block;
}
.lg-aside {
  color: var(--sw-fg-2);
  font-size: 10px;
}
.lg-kind-row {
  display: inline-flex;
  gap: 4px;
}
.kind-chip {
  display: inline-flex;
  align-items: center;
  padding: 1px 5px;
  font-size: 8.5px;
  font-weight: 700;
  letter-spacing: 0.04em;
  color: var(--sw-bg-0);
  border-radius: 2px;
}
.ep-graph {
  position: relative;
  min-width: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.ep-detail {
  /* Whole-sidebar scroll. Each block sizes to its content (inbound /
     outbound lists are dynamic) and overflows the parent if the
     combined height exceeds the card. Mirrors the topology sidebar. */
  border-left: 1px solid var(--sw-line);
  background: var(--sw-bg-1);
  font-size: 11.5px;
  display: flex;
  flex-direction: column;
  overflow-y: auto;
  min-height: 0;
}
.ep-detail-block {
  display: flex;
  flex-direction: column;
  flex: 0 0 auto;
  overflow: visible;
}
.ep-detail-block + .ep-detail-block {
  border-top: 1px solid var(--sw-line);
}
.ep-detail-empty {
  border: 1px dashed var(--sw-line-2);
  margin: 8px;
  border-radius: 6px;
  color: var(--sw-fg-3);
  font-size: 11px;
  display: grid;
  place-items: center;
  min-height: 64px;
  flex: 0 0 auto;
}
/* Edge-row line chart cards inside the endpoint-dep edge panel. */
.ed-edge-rows {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.ed-edge-row-card {
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line);
  border-radius: 4px;
  padding: 6px 8px;
  min-width: 0;
}
.ed-edge-row-card :deep(.sparkline) {
  display: block;
  width: 100%;
}
.ed-edge-tip {
  margin-left: auto;
  display: inline-flex;
  align-items: baseline;
  font-family: var(--sw-mono);
  font-size: 10.5px;
  padding: 1px 6px;
  background: var(--sw-bg-0);
  border: 1px solid var(--sw-line);
  border-radius: 4px;
  color: var(--sw-accent-2);
  font-weight: 600;
}
.ed-edge-row-head {
  display: flex;
  align-items: baseline;
  gap: 6px;
  margin-bottom: 2px;
}
.ed-edge-row-label {
  font-family: var(--sw-mono);
  font-size: 11px;
  color: var(--sw-fg-1);
  font-weight: 600;
}
.ed-edge-row-label .unit {
  color: var(--sw-fg-3);
  font-size: 10px;
  font-weight: 500;
}
.ed-edge-row-num {
  margin-left: auto;
  font-family: var(--sw-mono);
  font-size: 12px;
  color: var(--sw-fg-0);
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}
.ed-edge-row {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.ed-edge-svc {
  margin-top: 4px;
  font-size: 10.5px;
  color: var(--sw-fg-3);
}
.ep-edge { cursor: pointer; }
.ep-edge:hover path:nth-of-type(2) {
  stroke: var(--sw-accent-2) !important;
  opacity: 1 !important;
}
.ed-head {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 12px;
  border-bottom: 1px solid var(--sw-line);
}
.ed-id { min-width: 0; flex: 1; }
.ed-kind-row { display: inline-flex; gap: 6px; align-items: center; margin-bottom: 6px; }
.ed-svc {
  font-family: var(--sw-mono);
  font-size: 11px;
  color: var(--sw-fg-1);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ed-name {
  font-family: var(--sw-mono);
  font-size: 12.5px;
  font-weight: 600;
  color: var(--sw-fg-0);
  word-break: break-all;
}
.ed-kpis {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(90px, 1fr));
  gap: 8px;
  padding: 12px;
}
.ed-kpi {
  padding: 6px 8px;
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line);
  border-radius: 4px;
}
.ed-kpi-label {
  font-size: 9.5px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--sw-fg-3);
}
.ed-kpi-value {
  font-size: 16px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.ed-section { padding: 8px 12px 4px; border-top: 1px solid var(--sw-line); }
.ed-section-title {
  font-size: 9.5px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--sw-fg-3);
  margin-bottom: 6px;
}
.ed-list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.ed-list li {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 0;
  border-bottom: 1px solid var(--sw-line);
  font-size: 11px;
}
.ed-list li:last-child { border-bottom: none; }
.ed-mono.small {
  font-family: var(--sw-mono);
  font-size: 10.5px;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--sw-fg-1);
}
.ed-mono.accent { color: var(--sw-accent-2); }
.ed-arrow { color: var(--sw-fg-3); font-size: 10px; }
.ed-empty { color: var(--sw-fg-3); font-style: italic; }
.ed-actions {
  display: flex;
  gap: 8px;
  padding: 12px;
  border-top: 1px solid var(--sw-line);
}
@media (max-width: 1100px) {
  .ep-graph-card {
    grid-template-columns: 1fr;
    height: auto;
  }
  .ep-detail {
    border-left: none;
    border-top: 1px solid var(--sw-line);
    max-height: 460px;
  }
}
.graph-head {
  display: flex;
  align-items: baseline;
  gap: 12px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--sw-line);
}
.graph-head h4 {
  margin: 0;
  font-size: 12px;
  font-weight: 600;
  color: var(--sw-fg-0);
}
/* The graph fits-to-view by default and zooms via the viewBox, so the
   container no longer scrolls — it just gives the SVG its height. */
.ep-scroll {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}
/* Transient "no further dependency" banner over the canvas. */
.ep-nodep-flash {
  position: absolute;
  top: 10px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 5;
  max-width: 90%;
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 6px 14px;
  background: var(--sw-info-soft);
  border: 1px solid var(--sw-info);
  border-radius: 999px;
  font-size: 11.5px;
  font-weight: 600;
  color: var(--sw-fg-0);
  pointer-events: none;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.45);
}
.ep-nodep-flash::before {
  content: 'ⓘ';
  flex: 0 0 auto;
  font-size: 13px;
  line-height: 1;
  color: var(--sw-info);
}
.ep-nodep-flash span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ep-flash-enter-active,
.ep-flash-leave-active {
  transition: opacity 0.25s ease;
}
.ep-flash-enter-from,
.ep-flash-leave-to {
  opacity: 0;
}
.ep-svg {
  width: 100%;
  height: 100%;
  display: block;
  /* Stop the page from scrolling while wheel-zooming / dragging. */
  touch-action: none;
}
.ep-pan-bg {
  cursor: grab;
}
.ep-pan-bg:active {
  cursor: grabbing;
}
/* Zoom toolbar — top-right of the graph column. */
.ep-zoom {
  position: absolute;
  top: 8px;
  right: 8px;
  z-index: 2;
  display: flex;
  gap: 4px;
}
.ep-zoom button {
  width: 24px;
  height: 24px;
  display: grid;
  place-items: center;
  font-size: 13px;
  line-height: 1;
  color: var(--sw-fg-1);
  background: var(--sw-bg-1);
  border: 1px solid var(--sw-line);
  border-radius: 6px;
  cursor: pointer;
}
.ep-zoom button:hover {
  border-color: var(--sw-accent);
  color: var(--sw-fg-0);
}
.ep-node { cursor: grab; }
.ep-node.dragging { cursor: grabbing; }
.ep-node.dragging rect { stroke: var(--sw-accent-2); }
.ep-node:hover rect { stroke: var(--sw-accent-2); }
/* The node + expand handle are focusable for keyboard a11y (tabindex).
   Suppress the browser's default (blue) focus ring on pointer focus —
   the orange selection border already shows state — but keep a
   design-consistent accent ring for keyboard focus. */
.ep-node:focus,
.ep-expand:focus {
  outline: none;
}
.ep-node:focus-visible,
.ep-expand:focus-visible {
  outline: 2px solid var(--sw-accent-2);
  outline-offset: 2px;
}
.loader {
  padding: 60px;
  text-align: center;
  color: var(--sw-fg-3);
  font-size: 11.5px;
}
.ep-popout {
  position: absolute;
  width: 280px;
  background: var(--sw-bg-1);
  border: 1px solid var(--sw-accent-line);
  border-radius: 8px;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(249, 115, 22, 0.15);
  z-index: 4;
}
.po-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--sw-line);
}
.po-svc { font-weight: 600; font-size: 11.5px; color: var(--sw-fg-0); flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.po-body { padding: 10px 12px; }
.po-name {
  font-family: var(--sw-mono);
  font-size: 12px;
  color: var(--sw-fg-0);
  margin-bottom: 10px;
  word-break: break-all;
}
.po-kpis {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 6px;
  margin-bottom: 10px;
}
.po-kpis > div {
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line);
  border-radius: 6px;
  padding: 6px 8px;
}
.po-label {
  font-size: 9px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--sw-fg-3);
}
.po-val {
  font-size: 13px;
  font-weight: 700;
  font-family: var(--sw-mono);
  color: var(--sw-fg-0);
}
.po-section { margin-top: 8px; }
.po-section-title {
  font-size: 9.5px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--sw-fg-3);
  margin-bottom: 4px;
}
.po-link {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 0;
  font-size: 11px;
  color: var(--sw-fg-1);
}
.po-mono {
  font-family: var(--sw-mono);
  flex: 0 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.po-mono.accent { color: var(--sw-accent-2); }
.po-arrow { color: var(--sw-fg-3); }
.po-empty {
  color: var(--sw-fg-3);
  font-style: italic;
  font-size: 11px;
  padding: 3px 0;
}
.po-actions {
  display: flex;
  gap: 6px;
  margin-top: 12px;
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
</style>
