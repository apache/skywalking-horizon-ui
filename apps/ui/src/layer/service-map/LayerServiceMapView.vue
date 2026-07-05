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
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useEscapeToClose } from '@/components/primitives/useEscapeToClose';
import { useRoute, useRouter, type RouteLocationRaw } from 'vue-router';
import type {
  LayerDef,
  TopologyCall,
  TopologyMetricDef,
  TopologyNode,
} from '@/api/client';
import { useLayerTopology } from '@/layer/service-map/useLayerTopology';
import { useLayerLanding } from '@/layer/useLayerLanding';
import { useLayers } from '@/shell/useLayers';
import { useSetupStore } from '@/state/setup';
import { fmtMetric } from '@/utils/formatters';
import {
  resolveServiceIdentity,
  type ServiceIdentity,
} from '@/utils/serviceName';
import { componentIconOrNull, isUserNode } from '@/layer/service-map/useTopologyIcons';
import ServiceHierarchyOverlay from '@/layer/service-map/ServiceHierarchyOverlay.vue';
import { useHierarchyOverlayStore } from '@/layer/service-map/hierarchyStore';
import { useServiceHierarchy } from '@/layer/service-map/useServiceHierarchy';
import TopologyFocusPicker from '@/layer/service-map/TopologyFocusPicker.vue';
import TopologyNodeFilter from '@/layer/service-map/TopologyNodeFilter.vue';
import TopologyDetailPanels from '@/layer/service-map/TopologyDetailPanels.vue';
import { useTopologyCanvas } from '@/layer/service-map/useTopologyCanvas';
import {
  clusterBuckets as buildClusterBuckets,
  clusterRects as buildClusterRects,
  nodePositions,
  NODE_R,
  type ClusterResolver,
  type LayoutNode,
  type Pos,
} from '@/layer/service-map/useTopologyLayout';

/** When embedded as a widget (e.g. inside the Services / Mesh overview
 *  dashboards) the host passes the layer key directly and asks for the
 *  read-only variant. In the normal `/layer/:key/topology` route, both
 *  props are absent and we fall back to the route param + full
 *  interactive UI. */
const props = defineProps<{
  layerKey?: string;
  embedded?: boolean;
  /** Seed the focus service(s) + BFS depth (e.g. the AI chat mounts this
   *  embedded, focused on one service at depth 1 for a one-hop map). Absent on
   *  the interactive route + the overview widget, which start layer-wide. */
  focusServices?: string[];
  focusDepth?: number;
  /** Fit-to-screen scale cap. Omit for the readable 0.79 default; a small
   *  embedded stage (chat) raises it so a small graph fills its box. */
  fitScale?: number;
  /** Keep the zoom in/out/fit controls in embedded mode (the chat wants them;
   *  the dashboard-widget snapshot does not). Ignored on the full route, which
   *  always shows them. */
  zoomControls?: boolean;
  /** Embedded (chat) look-back window in minutes. When set, the topology query
   *  owns this window and ignores the global topbar picker + auto-refresh
   *  ticker — the chat block owns its time like the traces/logs blocks. */
  focusWindowMinutes?: number;
}>();
const route = useRoute();
const router = useRouter();
const layerKey = computed(() =>
  props.layerKey && props.layerKey.length > 0 ? props.layerKey : String(route.params.layerKey ?? ''),
);
const embedded = computed(() => Boolean(props.embedded));

const { layers } = useLayers();
const layer = computed<LayerDef | null>(
  // Case-insensitive: layer defs key on the uppercase OAP enum, but layerKey can
  // arrive lowercased (e.g. the AI chat block passes spec.layer.toLowerCase()).
  () => layers.value.find((l) => l.key.toUpperCase() === layerKey.value.toUpperCase()) ?? null,
);
const store = useSetupStore();
const safeLayer = computed<LayerDef>(() => layer.value ?? {
  key: layerKey.value, name: layerKey.value, color: 'var(--sw-fg-2)',
  serviceCount: -1, active: false, level: null, slots: {}, caps: {},
});
// Per-layer topology-cluster rule (k8s/mesh ⇒ namespace) + label policy
// for OAP's `<group>::<base>` prefix. `identity()` is the single read-
// side helper: every display site goes through it so the chip alias +
// group value stay consistent across the focus picker, node label,
// detail panels, and the cluster bounding box.
const namingRule = computed(() => layer.value?.naming ?? null);
function identity(name: string | null | undefined): ServiceIdentity {
  return resolveServiceIdentity(name, namingRule.value);
}
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
//   - empty array = no focus, BFF seeds from the layer's services for a
//     layer-overview graph
//   - one or more entries = comma-joined and passed as `?service=` so the
//     BFF seeds BFS from each selected service (multi-select)
const focusServiceNames = ref<string[]>(props.focusServices ?? []);
const serviceName = computed<string | null>(() =>
  focusServiceNames.value.length === 0 ? null : focusServiceNames.value.join(','),
);

/**
 * Build SVG `points=` for a flat-top regular hexagon centred at (0,0)
 * with circumradius `r`. Same outer envelope as a circle of the same
 * radius, but with the six-sided silhouette. Vertices go clockwise
 * starting from the right tip.
 */
function hexPoints(r: number): string {
  const s = r * 0.8660254037844386; // r * sin(60°)
  const h = r * 0.5;                // r * cos(60°)
  // (r, 0) → (h, s) → (-h, s) → (-r, 0) → (-h, -s) → (h, -s)
  return [
    `${r},0`,
    `${h},${s}`,
    `${-h},${s}`,
    `${-r},0`,
    `${-h},${-s}`,
    `${h},${-s}`,
  ].join(' ');
}

// Defensive truncate for long node labels — preserves the head + an
// ellipsis so cluster IDs that share a long prefix still distinguish.
function truncateLabel(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 2) + '…' : s;
}

const depth = ref<number>(props.focusDepth ?? 2);
const focusWindowMinutes = computed<number | null>(() => props.focusWindowMinutes ?? null);
const { nodes, calls, isLoading, isFetching, data, refetch } = useLayerTopology(
  layerKey,
  serviceName,
  depth,
  focusWindowMinutes,
);
const reachable = computed(() => data.value?.reachable !== false);
const errorText = computed(() => data.value?.error ?? null);
const tooLarge = computed(() => data.value?.tooLarge ?? null);
const metricsPartial = computed(() => data.value?.metricsPartial ?? null);

// ── Node visibility filter. Buckets store EXCLUSIONS (a node is hidden
// when its layer is in the set), so a freshly-appearing layer defaults
// visible. The TopologyNodeFilter overlay owns the facet derivation +
// popover; the view keeps the exclusion sets here so it can compute the
// filtered node set that drives the layout. -------------------------
const OTHERS_TOKEN = 'UNDEFINED'; // OAP's no-layer fallback, shown as "Others"
const hiddenLayers = ref<Set<string>>(new Set());
const hideUser = ref(false);

function layerTokens(n: TopologyNode): string[] {
  const ls = (n.layers ?? []).filter((l) => l && l.length > 0);
  return ls.length > 0 ? ls : [OTHERS_TOKEN];
}
function nodeVisible(n: TopologyNode): boolean {
  if (isUserNode(n)) return !hideUser.value;
  // Layer is any-match: a node stays as long as at least one of its
  // layers is still shown.
  return layerTokens(n).some((tok) => !hiddenLayers.value.has(tok));
}
const filteredNodes = computed<TopologyNode[]>(() => nodes.value.filter(nodeVisible));
const filterActive = computed<boolean>(
  () => hideUser.value || hiddenLayers.value.size > 0,
);
function resetFilter(): void {
  hiddenLayers.value = new Set();
  hideUser.value = false;
}

// ── Config from response (operator-edited layer JSON). Falls back to an
// empty config when the BFF hasn't responded yet — the renderer degrades
// gracefully to neutral colours / no number.
const cfg = computed(() => data.value?.config ?? {
  nodeMetrics: [] as TopologyMetricDef[],
  linkServerMetrics: [] as TopologyMetricDef[],
  linkClientMetrics: [] as TopologyMetricDef[],
});
// Per-topology-config flag: render the legacy `<group>::` prefix as a
// SEPARATE chip in the node detail panel. Default off.
const showLegacyGroup = computed<boolean>(() => Boolean(cfg.value?.showGroup));
function pickByRole(defs: TopologyMetricDef[], role: TopologyMetricDef['role']): TopologyMetricDef | null {
  return defs.find((d) => d.role === role) ?? null;
}
/**
 * Per-user threshold overrides take precedence over the template's
 * defaults. The setup store keys them by `<scope>.<metricId>`. We patch
 * the `thresholds` block on a copy of the metric def before any
 * threshold-driven colour band is computed.
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

/**
 * Legend rendering for the ring colour band. `ringScaleLabels` derives
 * the four break-point labels from the metric's own thresholds,
 * transforming them back into user-space when the metric is inverted
 * (SLA / Apdex / Success Rate). The order stays green→red (left→right)
 * so the ramp visual reads the same; only the numbers change.
 * `ringDirectionHint` adds a "higher = better" / "lower = better" tag.
 */
const ringScaleLabels = computed<string[]>(() => {
  const def = ringDef.value;
  if (!def) return [];
  const th = def.thresholds ?? { ok: 0.1, warn: 1, danger: 5 };
  // When thresholds don't carry an explicit `invertHealth`, fall back to
  // the legacy id/label heuristic that `ringColor()` already uses for
  // SLA / Apdex / Success-Rate metrics.
  const heuristicInvert =
    /sla|success|apdex/i.test(def.id) || /sla|apdex|success/i.test(def.label);
  const invert = th.invertHealth === undefined ? heuristicInvert : Boolean(th.invertHealth);
  const base = th.invertBase ?? 100;
  const ok = th.ok ?? 0.1;
  const warn = th.warn ?? 1;
  const danger = th.danger ?? 5;
  // Respect the metric's own unit verbatim — most ring metrics carry
  // `%`, but Apdex is unitless on 0-1 and a custom layer may use a raw
  // count. Defaulting to `%` here would print a misleading suffix.
  const unit = def.unit ?? '';
  const breaks = invert
    ? [base, base - ok, base - warn, base - danger]
    : [0, ok, warn, danger];
  const fmt = (n: number): string => {
    // Drop trailing zeros, but keep up to 2 decimal places for sub-1
    // values. `99.9` and `100` both look cleaner than `99.90` / `100.00`.
    const s = Number.isInteger(n) ? n.toString() : n.toFixed(2).replace(/\.?0+$/, '');
    return `${s}${unit ?? ''}`;
  };
  const out = breaks.map(fmt);
  // Decorate the END label with a trailing `+` / `-` so the reader knows
  // that band is "values past this boundary".
  if (out.length > 0) {
    out[out.length - 1] = out[out.length - 1] + (invert ? '-' : '+');
  }
  return out;
});
const ringDirectionHint = computed<string>(() => {
  const def = ringDef.value;
  if (!def) return '';
  const th = def.thresholds;
  if (th?.invertHealth) return 'higher = better';
  // Without an explicit `invertHealth`, fall back to the legacy heuristic
  // on the metric id/label so SLA-style metrics that haven't migrated to
  // thresholds still read correctly.
  if (/sla|success|apdex/i.test(def.id) || /sla|apdex|success/i.test(def.label)) {
    return 'higher = better';
  }
  return 'lower = better';
});
const centerDef = computed(() => pickByRole(cfg.value.nodeMetrics, 'center'));
const secondaryDef = computed(() => pickByRole(cfg.value.nodeMetrics, 'secondary'));

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

// ── Two-level booster-ported layout. The pure geometry lives in
// `useTopologyLayout`; here we wire it to the reactive node/call set +
// the layer's cluster naming rule.
const clusterResolver = computed<ClusterResolver>(() => ({
  cluster: (name) => identity(name).cluster,
  alias: namingRule.value?.alias ?? null,
}));
const clusterBuckets = computed(() =>
  buildClusterBuckets(filteredNodes.value, calls.value, clusterResolver.value),
);

// `layoutNodes` survives only as the flat list the rest of the view
// (drag, selection, edges) reads. Order doesn't matter for them; the
// per-bucket geometry is read off `clusterBuckets`.
const layoutNodes = computed<LayoutNode[]>(() => {
  const out: LayoutNode[] = [];
  for (const b of clusterBuckets.value) for (const n of b.nodes) out.push(n);
  return out;
});

// Drag overrides — populated by d3.drag on each node. Once a user drops a
// node anywhere on the canvas, its (cx, cy) is pinned here and the layout
// uses the override instead of the column layout. The map is keyed by
// service id so it survives layer re-render as long as the same services
// come back. Cleared whenever the underlying node set changes
// meaningfully (different layer / refresh blowing away the topology).
const dragOverrides = ref<Map<string, Pos>>(new Map());
watch(
  () => layoutNodes.value.map((n) => n.id).sort().join('|'),
  (curr, prev) => {
    if (prev !== undefined && curr !== prev) dragOverrides.value = new Map();
  },
);

const nodePos = computed<Map<string, Pos>>(() =>
  nodePositions(clusterBuckets.value, dragOverrides.value),
);
const visibleCalls = computed<TopologyCall[]>(() => {
  const ids = new Set(nodePos.value.keys());
  return calls.value.filter((c) => ids.has(c.source) && ids.has(c.target));
});
const clusterRects = computed(() => buildClusterRects(clusterBuckets.value, nodePos.value));

const W = computed(() => {
  const b = clusterBuckets.value;
  if (b.length === 0) return 820;
  const last = b[b.length - 1];
  const anchorRight = last.rect.x + last.rect.w + 40;
  // Cluster rects can extend beyond their BFS anchor once nodes are
  // dragged; widen the canvas to accommodate the live boxes.
  const clusterRight = clusterRects.value.reduce(
    (m, c) => Math.max(m, c.rect.x + c.rect.w + 40),
    0,
  );
  return Math.max(820, anchorRight, clusterRight);
});
const H = computed(() => {
  const b = clusterBuckets.value;
  if (b.length === 0) return 360;
  const anchorBottom = Math.max(...b.map((x) => x.rect.y + x.rect.h));
  const clusterBottom = clusterRects.value.reduce(
    (m, c) => Math.max(m, c.rect.y + c.rect.h),
    0,
  );
  return Math.max(anchorBottom, clusterBottom) + 60;
});

/**
 * Card height adapts to the graph's actual size with a 60% floor of the
 * operator-friendly minimum, capped above to keep the screen tidy on
 * huge graphs.
 */
const CARD_BASELINE = 780;
const CARD_MIN = Math.round(CARD_BASELINE * 0.6); // 468px
const CARD_MAX = 1100;
const cardHeightPx = computed<number>(() => {
  // Add chrome (toolbar header, the inner 90+40 already inside H, small
  // margin). The SVG content dictates the rest.
  const ideal = H.value + 80;
  return Math.max(CARD_MIN, Math.min(CARD_MAX, ideal));
});

/**
 * Resolve the 4-band colour for a node from the ring-metric value.
 * Operator-configured thresholds win when present; otherwise falls back
 * to the historical heuristic (error % at 0.1 / 1 / 5).
 */
function bandColor(value: number, th: NonNullable<TopologyMetricDef['thresholds']>): string {
  const invertBase = th.invertBase ?? 100;
  const v = th.invertHealth ? Math.max(0, invertBase - value) : value;
  const ok = th.ok ?? 0.1;
  const warn = th.warn ?? 1;
  const danger = th.danger ?? 5;
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
  // Legacy heuristic — for "higher is healthier" metrics (SLA / apdex /
  // success rate) we invert; otherwise treat higher as worse.
  const isHealthHigh = /sla|success|apdex/i.test(def.id) || /sla|apdex|success/i.test(def.label);
  const errPct = isHealthHigh ? Math.max(0, 100 - v) : v;
  if (errPct > 5) return 'var(--sw-err)';
  if (errPct > 1) return 'var(--sw-warn)';
  if (errPct > 0.1) return '#fbbf24';
  return 'var(--sw-ok)';
}
/**
 * Node kind — drives the icon shape rendered inside the ring.
 *   - `client`   — entry caller (literal `User` node OAP emits).
 *   - `external` — synthetic non-real callee (localhost:-1 / external).
 *   - `service`  — every other real node.
 */
function nodeKind(n: TopologyNode): 'client' | 'service' | 'external' {
  if (n.name === 'User') return 'client';
  if (!n.isReal) return 'external';
  return 'service';
}
/** Technology badge PNG for the node body, resolved from the node's
 *  `type` (the OAP component). Returns `null` for the User node (keeps
 *  its silhouette) and for any node whose component doesn't map to a
 *  shipped icon — those fall back to the hand-drawn kind glyph. */
function nodeIconUrl(n: TopologyNode): string | null {
  if (isUserNode(n)) return null;
  return componentIconOrNull(n.type);
}
/** Pick the edge metric to surface as a label. RPM-only by design — the
 *  canvas chip stays compact and consistent across layers. Other line
 *  metrics are still available in the right sidebar's per-edge detail.
 *  Server-side wins; client falls back. */
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
 * True when this call has a mirror in the opposite direction. We use a
 * deterministic offset sign (`source < target` ? +1 : -1) so the two
 * arcs of a bi-directional pair always go to opposite sides of the
 * midline regardless of iteration order.
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
 * disappearing into a straight pipe between adjacent columns; for bi-
 * directional pairs the two arcs bow to opposite sides so both lines are
 * visible. Arrow heads are deliberately omitted — the animated traffic
 * dots already advertise direction.
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
  // Pure-arc curves are flat for non-reversed edges; the sign === 0 case
  // still bows a touch (12px) so adjacent columns don't read as a
  // straight pipe.
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
  // Midpoint along the arc — using 0.5 along the quadratic approximates
  // as the control point's reflection of the chord mid; close enough for
  // placing the metric chip.
  return {
    x: (a.cx + b.cx) / 2 + perpX * amplitude * signed * 0.55,
    y: (a.cy + b.cy) / 2 + perpY * amplitude * signed * 0.55,
  };
}

// Detail-panel selection. Node and edge selections are INDEPENDENT —
// both can be active at once, surfacing the two detail cards in the
// right sidebar (see TopologyDetailPanels).
const selectedNodeId = ref<string | null>(null);
const selectedCallId = ref<string | null>(null);
function selectNode(id: string | null): void {
  // Embedded snapshot mode renders the same map but with no detail
  // sidebar — click is therefore a no-op.
  if (embedded.value) return;
  selectedNodeId.value = selectedNodeId.value === id ? null : id;
}
function selectCall(id: string | null): void {
  if (embedded.value) return;
  selectedCallId.value = selectedCallId.value === id ? null : id;
}
// Escape closes whichever detail panel (node or edge) is open.
useEscapeToClose(
  () => Boolean(selectedNodeId.value || selectedCallId.value),
  () => {
    selectedNodeId.value = null;
    selectedCallId.value = null;
  },
);
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

// ── Instance-topology drill-down. Offered on an edge only when the layer
// ships an `instanceTopology` config (echoed in `cfg`) AND both endpoints
// are real services — OAP's getServiceInstanceTopology needs two real
// services. Clicking it switches the Topology tab to the Instance map
// sub-tab, pre-filled with this edge's client/server pair (edge source =
// client, target = server).
const hasInstanceTopology = computed<boolean>(() => Boolean(cfg.value?.instanceTopology));
const canDrillInstance = computed<boolean>(
  () =>
    !embedded.value &&
    hasInstanceTopology.value &&
    Boolean(selectedCallSource.value?.isReal && selectedCallTarget.value?.isReal),
);
/** Open a route in a fresh browser tab — the operator keeps the service
 *  map they're exploring while the drill-down opens alongside it. History
 *  mode means `resolve(...).href` is a real URL. */
function openRouteInNewTab(to: RouteLocationRaw): void {
  const href = router.resolve(to).href;
  window.open(href, '_blank', 'noopener');
}
function openInstanceTopology(): void {
  const c = selectedCall.value;
  const src = selectedCallSource.value;
  const dst = selectedCallTarget.value;
  if (!c || !src || !dst || !src.isReal || !dst.isReal) return;
  openRouteInNewTab({
    path: `/layer/${layerKey.value}/topology`,
    query: { ...route.query, view: 'instance', client: c.source, server: c.target },
  });
}

/**
 * Visual focus sets. When a node OR an edge is selected, we keep the
 * "related" subgraph at full opacity and dim everything else.
 *   - selected NODE   ⇒ keep selected + its upstream + downstream + the
 *                       edges joining them.
 *   - selected EDGE   ⇒ keep edge + both endpoints.
 *   - BOTH selected   ⇒ union of the two sets.
 *   - nothing selected⇒ everything renders at full opacity.
 */
const hasSelection = computed<boolean>(
  () => Boolean(selectedNode.value) || Boolean(selectedCall.value),
);
const highlightedNodeIds = computed<Set<string>>(() => {
  const out = new Set<string>();
  const selN = selectedNode.value;
  if (selN) {
    out.add(selN.id);
    for (const c of calls.value) {
      if (c.source === selN.id) out.add(c.target);
      if (c.target === selN.id) out.add(c.source);
    }
  }
  const selC = selectedCall.value;
  if (selC) {
    out.add(selC.source);
    out.add(selC.target);
  }
  return out;
});
const highlightedCallIds = computed<Set<string>>(() => {
  const out = new Set<string>();
  const selN = selectedNode.value;
  if (selN) {
    for (const c of calls.value) {
      if (c.source === selN.id || c.target === selN.id) out.add(c.id);
    }
  }
  const selC = selectedCall.value;
  if (selC) out.add(selC.id);
  return out;
});
function isNodeFocused(id: string): boolean {
  return !hasSelection.value || highlightedNodeIds.value.has(id);
}
function isCallFocused(id: string): boolean {
  return !hasSelection.value || highlightedCallIds.value.has(id);
}

/**
 * Resolve the layer key we should jump into for the selected node. A
 * service may belong to multiple OAP layers; OAP returns the complete
 * list on `node.layers`. Stay in the current layer when it's in that
 * list, else fall back to the first one.
 */
function targetLayerFor(n: TopologyNode): string {
  const current = layerKey.value.toUpperCase();
  const ls = n.layers ?? [];
  const pick = ls.includes(current) ? current : (ls[0] ?? current);
  return pick.toLowerCase();
}
function jumpToService(): void {
  const sel = selectedNode.value;
  if (!sel) return;
  openRouteInNewTab({
    path: `/layer/${targetLayerFor(sel)}/service`,
    query: { service: sel.id },
  });
}
function jumpToEndpointDependency(): void {
  const sel = selectedNode.value;
  if (!sel) return;
  openRouteInNewTab({
    path: `/layer/${targetLayerFor(sel)}/dependency`,
    query: { service: sel.id },
  });
}

// ── d3 pan / zoom / node-drag lifecycle (owns its own teardown).
const svgEl = ref<SVGSVGElement | null>(null);
const zoomLayerEl = ref<SVGGElement | null>(null);
const containerEl = ref<HTMLDivElement | null>(null);
const nodeCount = computed(() => layoutNodes.value.length);
const { zoomT, fitToScreen, zoomBy } = useTopologyCanvas({
  svgEl,
  zoomLayerEl,
  containerEl,
  W,
  H,
  nodeCount,
  nodePos,
  dragOverrides,
  maxFitScale: props.fitScale,
});

// ── Smartscape hierarchy overlay — lazy-probed on node-select; chip on
// the focused hex's right edge opens the focus+context+suggestions
// overlay. The store gates the global auto-refresh ticker so the
// background topology doesn't shift while the operator pans through
// peers. Disabled in embedded (widget) mode.
const hierarchy = useHierarchyOverlayStore();
const { hasPeers: hierarchyHasPeers } = useServiceHierarchy(layerKey, selectedNodeId);

function openHierarchy(): void {
  if (embedded.value) return;
  const sel = selectedNode.value;
  if (!sel) return;
  // Snapshot the live zoom so the overlay anchors peers on the same
  // screen position as the focused hex underneath.
  hierarchy.open({
    serviceId: sel.id,
    serviceName: identity(sel.name).display,
    layer: layerKey.value,
    zoom: { k: zoomT.value.k, x: zoomT.value.x, y: zoomT.value.y },
  });
}
/** Resolver passed to the overlay so it can place peers relative to the
 *  focused node's current topology coords. */
function resolveNodePos(id: string): { cx: number; cy: number } | null {
  const p = nodePos.value.get(id);
  return p ? { cx: p.cx, cy: p.cy } : null;
}
// Mirror live pan/zoom into the overlay's snapshot — the overlay re-draws
// the focused hex at its underlying topology position + scale, so it must
// follow whatever pan/zoom the operator does while the overlay is up. The
// !embedded guard is load-bearing: the store is a singleton, so an embedded
// (chat) map's own fit/pan would otherwise yank a real page's open overlay.
watch(zoomT, (z) => {
  if (!embedded.value && hierarchy.isOpen) hierarchy.updateZoom({ k: z.k, x: z.x, y: z.y });
});
// Tear down the overlay (and re-enable the ticker) on unmount — otherwise
// leaving the tab while open would freeze refresh indefinitely. Guarded on
// !embedded so dismissing a chat block never closes a real page's overlay.
onBeforeUnmount(() => {
  if (!embedded.value && hierarchy.isOpen) hierarchy.close();
});
</script>

<template>
  <div class="sm-tab" :class="{ 'is-embedded': embedded }">
    <header v-if="!embedded" class="sm-toolbar sw-card">
      <div class="left">
        <span class="kicker">Topology</span>
        <span v-if="focusServiceNames.length === 0" class="for-svc">layer overview · all services</span>
        <span v-else class="for-svc">
          focused on
          <b>{{ focusServiceNames.length === 1 ? identity(focusServiceNames[0]).display : `${focusServiceNames.length} services` }}</b>
        </span>
        <span v-if="isFetching" class="hint">refreshing…</span>
      </div>
      <div class="right">
        <TopologyFocusPicker
          v-model:selected="focusServiceNames"
          :landing-rows="landingRows"
          :naming-rule="namingRule"
        />
        <!-- Depth is only meaningful when a focus seed is picked —
             "All services" already seeds from the whole layer, so a
             BFS-depth control would explode the graph. -->
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
    <div v-if="tooLarge" class="banner warn">
      <strong>Topology too large to render</strong> — {{ tooLarge.nodes.toLocaleString() }} services · {{ tooLarge.edges.toLocaleString() }} calls.
      {{ embedded ? 'Open the Topology tab and narrow the scope to see a complete map.' : 'Pick a specific service above, or lower the depth, to see a complete map.' }}
    </div>
    <div v-if="metricsPartial" class="banner warn">
      Some metrics could not be loaded ({{ metricsPartial.failedChunks }} of {{ metricsPartial.totalChunks }} batches failed) — blank values may be unavailable, not zero.
    </div>

    <section class="sm-card sw-card" :class="{ 'has-selection': selectedNode || selectedCall }" :style="{ height: cardHeightPx + 'px' }">
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

            <!-- Topology cluster bounding boxes — one rounded-rect per
                 cluster value (e.g. k8s namespace) with a dashed
                 border. Rects are derived live from current node
                 positions so dragging a node grows / shrinks the box
                 to keep it enclosed. The alias·value chip floats
                 ABOVE the box top so the rounded border reads
                 unbroken. Layers without a topology-cluster rule
                 produce zero entries here ⇒ no box renders. -->
            <g class="sm-cluster-layer">
              <template v-for="c in clusterRects" :key="c.key">
                <g :transform="`translate(${c.rect.x}, ${c.rect.y})`">
                  <!-- Clear fill + bold fg-token dashed stroke so the
                       boundary reads on any theme (a bg-tinted fill is
                       near-invisible on dark themes, a haze on light). -->
                  <rect
                    :width="c.rect.w"
                    :height="c.rect.h"
                    rx="14"
                    ry="14"
                    fill="none"
                    stroke="var(--sw-fg-3)"
                    stroke-width="1.5"
                    stroke-dasharray="7 5"
                  />
                  <!-- Header chip rendered INSIDE the cluster top (in the
                       CLUSTER_HEAD_HEIGHT padding above the topmost node,
                       reserved by the rect math above) so dragging a node
                       above the box top can't break encompass. Cluster
                       *value* is larger than the alias label — the name is
                       the signal, the alias just a qualifier. -->
                  <g transform="translate(20, 22)">
                    <rect
                      x="0"
                      y="-19"
                      :width="14 + (c.alias ?? '').length * 7.5 + 12 + (c.key ?? '').length * 11 + 18"
                      height="32"
                      rx="16"
                      ry="16"
                      fill="var(--sw-bg-0)"
                      stroke="var(--sw-accent-line)"
                      stroke-width="1.2"
                    />
                    <text
                      x="14"
                      y="4"
                      fill="var(--sw-fg-3)"
                      font-size="12"
                      font-family="var(--sw-mono)"
                      font-weight="500"
                    >{{ c.alias }} ·</text>
                    <text
                      :x="14 + (c.alias ?? '').length * 7.5 + 12"
                      y="5"
                      fill="var(--sw-accent-2)"
                      font-size="18"
                      font-family="var(--sw-mono)"
                      font-weight="700"
                    >{{ c.key }}</text>
                  </g>
                </g>
              </template>
            </g>

            <g
              v-for="c in visibleCalls"
              :key="c.id"
              class="sm-edge"
              :class="{ 'sm-dim': !isCallFocused(c.id) }"
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
              <!-- Base edge line. Uniform width across the canvas —
                   every edge is visually peer; selection brightens. -->
              <path
                :d="callPathD(c)"
                fill="none"
                :stroke="selectedCallId === c.id ? 'var(--sw-accent-2)' : 'var(--sw-accent)'"
                :stroke-width="selectedCallId === c.id ? 3.2 : 1.8"
                :opacity="selectedCallId === c.id ? 1 : 0.7"
                stroke-linecap="round"
                style="pointer-events: none"
              />
              <!-- Direction overlay: discrete dot-like dashes (4-on /
                   28-off, 3s) that drift from source → target, so the
                   eye can track a single dot along the path. Round-capped
                   so each dot reads as a circle rather than a tick. -->
              <path
                :d="callPathD(c)"
                fill="none"
                :stroke="selectedCallId === c.id ? 'var(--sw-accent-2)' : 'var(--sw-accent)'"
                :stroke-width="selectedCallId === c.id ? 4 : 3"
                stroke-linecap="round"
                stroke-dasharray="4 28"
                opacity="0.95"
                style="pointer-events: none"
              >
                <animate
                  attributeName="stroke-dashoffset"
                  from="32"
                  to="0"
                  dur="3s"
                  repeatCount="indefinite"
                />
              </path>
              <!-- Edge metric chip on the line midpoint. Shows the
                   configured line metric value + unit (uppercased);
                   `·C` marker when only client-side data was available. -->
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
                 badge top-right + name/metric text below. -->
            <g
              v-for="n in layoutNodes.filter((nn) => nodePos.get(nn.id))"
              :key="n.id"
              :data-node-id="n.id"
              :transform="`translate(${nodePos.get(n.id)!.cx}, ${nodePos.get(n.id)!.cy})`"
              class="sm-node"
              :class="{ 'sm-dim': !isNodeFocused(n.id) }"
              style="cursor: grab"
              @click.stop="selectNode(n.id)"
            >
              <!-- Selection halo: tinted hex at r=56 + dashed hex at
                   r=50 (design spec; circles swapped for flat-top
                   hexagons so the silhouette reads like a service-
                   chip while keeping the same two-tone halo + ring
                   layering). -->
              <template v-if="selectedNodeId === n.id">
                <polygon :points="hexPoints(56)" :fill="ringColor(n)" opacity="0.10" stroke-linejoin="round" />
                <polygon
                  :points="hexPoints(50)"
                  fill="none"
                  :stroke="ringColor(n)"
                  stroke-width="1.2"
                  stroke-dasharray="3 4"
                  stroke-linejoin="round"
                  opacity="0.7"
                />
              </template>
              <!-- Outer ring (health). Dashed for client / external
                   to signal "untraced" (no agent here). Solid stroke
                   for real services. -->
              <polygon
                :points="hexPoints(42)"
                fill="var(--sw-bg-1)"
                :stroke="ringColor(n)"
                :stroke-width="nodeKind(n) === 'service' ? 2.5 : 1.2"
                :stroke-dasharray="nodeKind(n) === 'service' ? '0' : '4 4'"
                stroke-linejoin="round"
                :style="{
                  filter: selectedNodeId === n.id
                    ? `drop-shadow(0 0 12px ${ringColor(n)})`
                    : 'none',
                }"
              />
              <!-- Inner disc — slightly darker for services to push
                   the icon forward; matches the design's two-tone
                   readout. -->
              <polygon
                :points="hexPoints(32)"
                :fill="nodeKind(n) === 'service' ? 'var(--sw-bg-2)' : 'var(--sw-bg-1)'"
                stroke="var(--sw-line-2)"
                stroke-width="1"
                stroke-linejoin="round"
              />

              <!-- Node body: the technology component icon resolved
                   from the node's `type` (same PNG set the native
                   trace uses) when one exists; otherwise the hand-drawn
                   kind glyph — User = silhouette, real service = 3D
                   box, unresolved peer = cloud with `?`. -->
              <image
                v-if="nodeIconUrl(n)"
                :href="nodeIconUrl(n)!"
                x="-15"
                y="-15"
                width="30"
                height="30"
                preserveAspectRatio="xMidYMid meet"
              />
              <template v-else>
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
              </template>

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

              <!-- Smartscape hierarchy chip — anchored on the right
                   vertex of the selected hex. Visible only once the
                   lazy probe confirms cross-layer peers exist; click
                   opens the focus+context+suggestions overlay. -->
              <g
                v-if="selectedNodeId === n.id && hierarchyHasPeers && !embedded"
                transform="translate(48, 0)"
                class="sm-h-chip"
                @click.stop="openHierarchy()"
              >
                <title>Show service hierarchy (cross-layer peers)</title>
                <circle r="11" fill="var(--sw-accent)" />
                <circle r="11" fill="none" stroke="var(--sw-bg-0)" stroke-width="2" />
                <g stroke="var(--sw-bg-0)" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M-4 -3 L0 -1 L4 -3" />
                  <path d="M-4 0 L0 2 L4 0" />
                  <path d="M-4 3 L0 5 L4 3" />
                </g>
              </g>

              <!-- RPM (center metric) above the hex body. No label —
                   the unit chip on the right is enough to disambiguate
                   it from the latency line beneath the name. Hidden
                   when the node reports no RPM so silent nodes don't
                   carry an empty placeholder. -->
              <text
                v-if="centerDef && nodeVal(n, centerDef) !== null"
                text-anchor="middle"
                y="-50"
                :fill="ringColor(n)"
                font-size="14"
                font-family="var(--sw-mono)"
                font-weight="700"
              >
                {{ fmtMetric(nodeVal(n, centerDef)) }}{{ centerDef.unit ? ' ' + centerDef.unit.toUpperCase() : '' }}
              </text>

              <!-- Name below the node — base only. The group prefix
                   (`<group>::base`) appears as a chip in the right
                   sidebar. -->
              <text
                text-anchor="middle"
                y="58"
                :fill="selectedNodeId === n.id ? 'var(--sw-fg-0)' : 'var(--sw-fg-1)'"
                font-size="16"
                font-family="var(--sw-mono)"
                :font-weight="selectedNodeId === n.id ? 700 : 600"
              >
                {{ truncateLabel(identity(n.name).display, 22) }}
              </text>
              <!-- Latency (secondary metric) below the name. No label
                   — the unit chip disambiguates from RPM. Hidden when
                   the node has no latency reading. -->
              <text
                v-if="secondaryDef && nodeVal(n, secondaryDef) !== null"
                text-anchor="middle"
                y="78"
                fill="var(--sw-fg-2)"
                font-size="13"
                font-family="var(--sw-mono)"
                font-weight="600"
              >
                {{ fmtMetric(nodeVal(n, secondaryDef)) }}{{ secondaryDef.unit ? ' ' + secondaryDef.unit.toUpperCase() : '' }}
              </text>
            </g>
          </g>
        </svg>
        <div v-else-if="isLoading" class="loader">loading…</div>
        <div v-else-if="filterActive && nodes.length > 0" class="loader">
          All nodes are hidden by the current filter.
          <button class="sw-btn small" type="button" @click="resetFilter">Reset filter</button>
        </div>
        <div v-else-if="!tooLarge" class="loader">
          No services with metric data in this layer for the last 15 minutes.
        </div>

        <!-- Smartscape hierarchy overlay — focus + context + suggestions.
             Mounted inside .sm-graph so it overlays the topology
             container exactly; gated on `embedded` so the widget
             snapshot view never grows a dimmed canvas. -->
        <ServiceHierarchyOverlay
          v-if="!embedded"
          :view-box-w="W"
          :view-box-h="H"
          :resolve-node-pos="resolveNodePos"
          :show-legacy-group="showLegacyGroup"
        />

        <!-- Floating zoom controls — top-right, mirror the map
             toolbar's affordance vocabulary (small ghost buttons).
             Hidden in embedded dashboard-widget mode (non-interactive
             snapshot); the chat opts back in via `zoomControls`. -->
        <div v-if="(!embedded || zoomControls) && layoutNodes.length > 0" class="sm-zoom-ctrls">
          <button class="sw-btn small" type="button" title="Zoom in (wheel up)" @click="zoomBy(1.25)">+</button>
          <button class="sw-btn small" type="button" title="Zoom out (wheel down)" @click="zoomBy(1 / 1.25)">−</button>
          <button class="sw-btn small" type="button" title="Fit to screen (double-click canvas)" @click="fitToScreen(true)">Fit</button>
          <span class="sm-zoom-pct" :title="`Scale ${(zoomT.k * 100).toFixed(0)}%`">{{ Math.round(zoomT.k * 100) }}%</span>
        </div>

        <!-- Node filter — floating overlay (top-left) in BOTH the full
             Topology tab and the embedded overview widget. Owns its facet
             derivation + popover; the view reads back the exclusion sets
             (v-model) to compute the filtered node set. -->
        <TopologyNodeFilter
          v-if="layoutNodes.length > 0 || filterActive"
          v-model:hidden-layers="hiddenLayers"
          v-model:hide-user="hideUser"
          :nodes="nodes"
          :layers="layers"
          :embedded="embedded"
        />

        <div class="legend">
          <div v-if="ringDef" class="lg-label">
            {{ ringDef.label }}
            <span class="lg-direction">{{ ringDirectionHint }}</span>
          </div>
          <div v-if="ringDef" class="lg-ramp">
            <span style="background: var(--sw-ok)" />
            <span style="background: #fbbf24" />
            <span style="background: var(--sw-warn)" />
            <span style="background: var(--sw-err)" />
          </div>
          <div v-if="ringDef" class="lg-scale">
            <span v-for="(lbl, i) in ringScaleLabels" :key="i">{{ lbl }}</span>
          </div>
          <div class="lg-rule" />
          <div class="lg-row">
            <span class="lg-swatch" style="background: var(--sw-accent)" />
            <span>Calls</span>
            <span class="lg-aside">direction shown by flow animation</span>
          </div>
        </div>
      </div>

      <!-- Right sidebar — node panel on top, edge panel underneath.
           Both selections are independent so the two stay open in
           parallel; empty slots prompt the operator to pick the
           missing side. Edges DO NOT open a dashboard page — metrics
           live here and on the canvas, that's the full extent of
           edge drill-in. -->
      <TopologyDetailPanels
        v-if="selectedNode || selectedCall"
        :selected-node="selectedNode"
        :selected-call="selectedCall"
        :selected-call-source="selectedCallSource"
        :selected-call-target="selectedCallTarget"
        :calls="calls"
        :layout-nodes="layoutNodes"
        :cfg="cfg"
        :ring-def="ringDef"
        :center-def="centerDef"
        :secondary-def="secondaryDef"
        :naming-rule="namingRule"
        :show-legacy-group="showLegacyGroup"
        :can-drill-instance="canDrillInstance"
        @clear-node="selectedNodeId = null"
        @clear-call="selectedCallId = null"
        @jump-to-service="jumpToService"
        @jump-to-endpoint-dependency="jumpToEndpointDependency"
        @open-instance-topology="openInstanceTopology"
      />
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
/* Embedded (dashboard-widget) mode — toolbar / detail sidebar / zoom
 * controls are already gated off in the template; this just tightens
 * paddings and lets the SVG fill its host grid cell so the map reads
 * as a card body, not a standalone page. */
.sm-tab.is-embedded {
  padding: 0;
  gap: 0;
  height: 100%;
}
.sm-toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 12px;
  /* `.sw-card` ships with `overflow: hidden` to clip rounded corners
   *  on its child content. The focus picker's absolute-positioned
   *  dropdown lives inside this toolbar, though, and getting clipped
   *  by the card boundary blocks the operator from scrolling the
   *  service list. Override here so the popup can spill beneath the
   *  toolbar. Rounded corners are preserved by the children
   *  themselves not bleeding into the corner. */
  overflow: visible;
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
.banner.err {
  padding: 8px 12px;
  background: var(--sw-err-soft);
  border: 1px solid rgba(239, 68, 68, 0.3);
  border-radius: 6px;
  color: #f87171;
  font-size: 11.5px;
}
.banner.warn {
  padding: 8px 12px;
  background: var(--sw-warn-soft);
  border: 1px solid var(--sw-warn);
  border-radius: 6px;
  color: var(--sw-warn);
  font-size: 11.5px;
}
.sm-card {
  /* Map card — graph on the left, dual-stack sidebar on the right
     when a node / edge is selected; otherwise the card collapses to
     a single full-width column so the canvas isn't squished by an
     empty placeholder rail. Height is driven by `cardHeightPx`. */
  padding: 0;
  overflow: hidden;
  display: grid;
  grid-template-columns: 1fr;
}
.sm-card.has-selection {
  grid-template-columns: 1fr 360px;
}
.sm-graph {
  /* `flex: 1` is required — without it the graph collapses to its
     intrinsic height inside the flex `.sm-card` and shows stale. */
  flex: 1;
  position: relative;
  min-width: 0;
  display: flex;
  flex-direction: column;
  background: radial-gradient(900px 540px at 30% 40%, rgba(56, 189, 248, 0.04), transparent 60%), var(--sw-bg-0);
}
.sm-node { cursor: pointer; }
.sm-node:hover image {
  /* Subtle pop on hover — the cube image gets a slight scale via
     filter rather than a CSS transform so the SVG transform-origin
     stays at the node's geometric centre. */
  filter: drop-shadow(0 0 4px rgba(249, 115, 22, 0.45));
}
.sm-edge { cursor: pointer; }
/* Selection focus: when ANY node or edge is selected, every node /
   edge that's NOT part of the related subgraph (selected node + its
   upstream + downstream + their joining edges; or selected edge +
   both endpoints) gets the `.sm-dim` class. The dimmed treatment
   keeps the canvas readable as context without competing for the
   eye. Opacity is animated so quick selection cycling reads as a
   smooth focus pull, not a flash. */
.sm-node, .sm-edge { transition: opacity 0.15s ease; }
.sm-node.sm-dim { opacity: 0.22; }
.sm-edge.sm-dim { opacity: 0.12; }
.sm-node.sm-dim:hover, .sm-edge.sm-dim:hover { opacity: 0.55; }
.sm-edge:hover path:nth-of-type(2) {
  stroke: var(--sw-accent-2) !important;
  opacity: 1 !important;
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
  display: flex;
  align-items: baseline;
  gap: 6px;
}
.lg-direction {
  font-size: 9px;
  letter-spacing: 0.04em;
  text-transform: none;
  color: var(--sw-fg-3);
  font-style: italic;
  opacity: 0.85;
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

/* Smartscape hierarchy chip — anchored on the right side of the
   selected hex. Click opens the focus+context+suggestions overlay.
   Visible only when the lazy probe found at least one cross-layer
   peer (see `hierarchyHasPeers`). */
.sm-h-chip {
  cursor: pointer;
  transition: transform 0.12s ease;
}
.sm-h-chip:hover {
  transform: translate(48px, 0) scale(1.1);
}
.sm-h-chip:hover circle:first-child {
  filter: drop-shadow(0 0 6px var(--sw-accent));
}

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
.sw-btn.small {
  height: 24px;
  padding: 0 10px;
  font-size: 11px;
}

@media (max-width: 1100px) {
  .sm-card { height: auto; }
  .sm-graph { height: 460px; }
}
</style>
