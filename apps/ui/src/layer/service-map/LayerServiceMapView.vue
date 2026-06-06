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
import { useI18n } from 'vue-i18n';
import { useRoute, useRouter } from 'vue-router';
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
import Sparkline from '@/components/charts/Sparkline.vue';
import { isUserNode } from '@/layer/service-map/useTopologyIcons';
import ServiceHierarchyOverlay from '@/layer/service-map/ServiceHierarchyOverlay.vue';
import { useHierarchyOverlayStore } from '@/layer/service-map/hierarchyStore';
import { useServiceHierarchy } from '@/layer/service-map/useServiceHierarchy';

/** When embedded as a widget (e.g. inside the Services / Mesh overview
 *  dashboards) the host passes the layer key directly and asks for the
 *  read-only variant. In the normal `/layer/:key/topology` route, both
 *  props are absent and we fall back to the route param + full
 *  interactive UI. */
const props = defineProps<{ layerKey?: string; embedded?: boolean }>();
const route = useRoute();
const router = useRouter();
const { t } = useI18n({ useScope: 'global' });
const layerKey = computed(() =>
  props.layerKey && props.layerKey.length > 0 ? props.layerKey : String(route.params.layerKey ?? ''),
);
const embedded = computed(() => Boolean(props.embedded));

const { layers } = useLayers();
const layer = computed<LayerDef | null>(
  () => layers.value.find((l) => l.key === layerKey.value) ?? null,
);
const store = useSetupStore();
const safeLayer = computed<LayerDef>(() => layer.value ?? {
  key: layerKey.value, name: layerKey.value, color: 'var(--sw-fg-2)',
  serviceCount: -1, active: false, level: null, slots: {}, caps: {},
});
// Per-layer topology-cluster rule (k8s/mesh ⇒ namespace) + label
// policy for OAP's `<group>::<base>` prefix. `identity()` is the
// single read-side helper: every display site goes through it so the
// chip alias + group value stay consistent across the focus picker,
// node label, detail panels, and the cluster bounding box.
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

// Service-list rows grouped by the layer-resolved group value (k8s/mesh
// ⇒ namespace; generic ⇒ legacy `::` prefix). The search panel renders
// one section per group; the section heading shows the alias·value
// (e.g. `namespace · sample`).
interface GroupedRow { group: string | null; name: string; id: string; raw: string }
const groupedRows = computed<Map<string, GroupedRow[]>>(() => {
  const map = new Map<string, GroupedRow[]>();
  const term = focusSearch.value.trim().toLowerCase();
  for (const r of landingRows.value) {
    const id = identity(r.serviceName);
    if (term && !r.serviceName.toLowerCase().includes(term)) continue;
    const key = id.cluster ?? '';
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push({ group: id.cluster, name: id.display, id: r.serviceId, raw: r.serviceName });
  }
  return map;
});
const groupAliasLabel = computed<string>(() => namingRule.value?.alias ?? 'group');

// Defensive truncate for long node labels — preserves the head + an
// ellipsis so cluster IDs that share a long prefix still distinguish.
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
// Per-topology-config flag: render the legacy `<group>::` prefix as a
// SEPARATE chip in the node detail panel. Default off — by default
// the prefix never appears in the UI; opting in surfaces it in the
// panel only (topology node labels stay clean either way).
const showLegacyGroup = computed<boolean>(() => Boolean(cfg.value?.showGroup));
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

/**
 * Legend rendering for the ring colour band.
 *
 * Earlier the legend hard-coded `0% / 0.1% / 1% / 5%+` — that's
 * accurate for an error-rate ring (lower = healthier ⇒ left=green) but
 * wildly wrong for SLA / Apdex / Success Rate, which are inverted
 * (higher = healthier). On a layer with `service_sla/100` the
 * renderer correctly inverts via `invertHealth`, but the legend was
 * still claiming `0% / 0.1% / 1% / 5%+` next to a green→red ramp that
 * actually pivots at 100% / 99.9% / 99% / 95%.
 *
 * `ringScaleLabels` derives the four break-point labels from the
 * metric's own thresholds, transforming them back into user-space
 * when the metric is inverted. The order stays green→red (left→right)
 * so the ramp visual reads the same; only the numbers change.
 *
 * `ringDirectionHint` adds a small "higher = better" / "lower = better"
 * tag so the operator can sanity-check the colour mapping at a glance.
 */
const ringScaleLabels = computed<string[]>(() => {
  const def = ringDef.value;
  if (!def) return [];
  const t = def.thresholds ?? { ok: 0.1, warn: 1, danger: 5 };
  // When thresholds don't carry an explicit `invertHealth`, fall back
  // to the legacy id/label heuristic that `ringColor()` already uses
  // for SLA / Apdex / Success-Rate metrics. Without this, an
  // unmigrated `sla` template would render a green-at-100% ramp but
  // print `0% / 0.1% / 1% / 5%+` labels next to it.
  const heuristicInvert =
    /sla|success|apdex/i.test(def.id) || /sla|apdex|success/i.test(def.label);
  const invert = t.invertHealth === undefined ? heuristicInvert : Boolean(t.invertHealth);
  const base = t.invertBase ?? 100;
  const ok = t.ok ?? 0.1;
  const warn = t.warn ?? 1;
  const danger = t.danger ?? 5;
  // Respect the metric's own unit verbatim — most ring metrics carry
  // `%`, but Apdex is unitless on 0-1 and a custom layer may use a
  // raw count. Defaulting to `%` here would print a misleading suffix.
  const unit = def.unit ?? '';
  // The colour ramp is rendered green → yellow → warn → red, four
  // bands. The three breakpoints sit at the band edges. For a
  // non-inverted metric (error-rate style), the breakpoints already
  // describe value boundaries left→right (low→high).
  //
  // For an inverted metric (SLA-style), the colour ramp's left edge
  // corresponds to value=base (healthiest), and each subsequent
  // boundary is `base - threshold`. The numbers naturally come out
  // descending, which is the user-facing reading direction.
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
  // Decorate the END label with a trailing `+` / `-` so the reader
  // knows that band is "values past this boundary":
  //   - non-invert (left=low good): the LAST band continues to `+∞`,
  //     so suffix with `+`.
  //   - invert (left=high good):   the LAST band continues to `-∞`
  //     (or 0), so suffix with `-`.
  if (out.length > 0) {
    out[out.length - 1] = out[out.length - 1] + (invert ? '-' : '+');
  }
  return out;
});
const ringDirectionHint = computed<string>(() => {
  const def = ringDef.value;
  if (!def) return '';
  const t = def.thresholds;
  if (t?.invertHealth) return 'higher = better';
  // Without an explicit `invertHealth`, fall back to the legacy
  // heuristic on the metric id/label so SLA-style metrics that
  // haven't migrated to thresholds still read correctly.
  if (/sla|success|apdex/i.test(def.id) || /sla|apdex|success/i.test(def.label)) {
    return 'higher = better';
  }
  return 'lower = better';
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

// ── Layered layout (port of booster-ui `computeLevels`).
//
// The upstream/downstream BFS-from-many-roots layout we used to run
// produced a multi-spine grid that didn't read as well as booster-ui's
// "horizontal main chain + branches drop down" feel (see ui-5.png). So
// this is a faithful port of booster-ui's `computeLevels` / `layout`:
//
//   1. Pick ONE seed — the literal `User` node if present, else the
//      node that appears most often as either source or target.
//   2. BFS walks BOTH directions (upstream + downstream) from the
//      seed. The insertion order is preserved: whichever node enters
//      level N first sits at the top row of that column, so the
//      dominant call chain naturally rises to the top.
//   3. Disconnected subgraphs are processed recursively and their
//      levels are merged by index — subgraph node #2 at level 3 lines
//      up with the main spine's level-3 column.
//   4. No barycentric reorder, no metric-based sort: a node's row
//      within a column is exactly the order BFS reached it.
interface LayoutNode extends TopologyNode {
  layerIdx: number;
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
function computeBoosterLevels(
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
  // Walk levels — new levels get appended inside the loop, so this is
  // an index-based for so the freshly-pushed levels are visited too.
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
  // Merge this subgraph's levels into the running accumulator by
  // index: subgraph level-K nodes append to acc[K]. Booster's exact
  // shape — keeps disconnected subgraphs aligned to the same columns.
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
// Sentinel encoding for the cluster key — `null` (unclustered) gets
// pinned to a stable string so it can serve as a Map key alongside
// real cluster values. Decoded back on the read side.
const UNCLUSTERED = '\u0000__ungrouped__';
function ckeyEnc(k: string | null): string { return k ?? UNCLUSTERED; }
function ckeyDec(s: string): string | null { return s === UNCLUSTERED ? null : s; }

/**
 * One topology-cluster bucket. Each bucket runs its own internal BFS
 * column layout (mirroring the legacy single-graph layout) and is
 * positioned into a row of bucket regions whose order is decided by
 * an inter-cluster BFS over cross-cluster calls.
 */
interface ClusterBucket {
  key: string | null;
  alias: string | null;
  nodes: LayoutNode[];        // intra-bucket BFS-ordered nodes with `layerIdx`
  cols: number;               // internal BFS columns
  maxRowsPerCol: number;      // tallest column in this bucket
  rect: { x: number; y: number; w: number; h: number };
}

// Group bounding-box paddings. Top padding is bigger so the alias chip
// (`namespace · sample`) has room to live above the inner column area.
const GROUP_PAD_X = 36;
const GROUP_PAD_TOP = 38;
const GROUP_PAD_BOTTOM = 28;
const GROUP_GAP_X = 80;

/**
 * Two-level layout: bucket by the layer-resolved topology cluster,
 * BFS each bucket internally, then BFS the inter-cluster call graph
 * to decide bucket order along the X axis. Returns the buckets in
 * render order with each bucket's anchor rect already positioned.
 *
 * Unclustered nodes (layer has no topology-cluster rule, or the rule
 * didn't match — synthetic User, external endpoints, …) collapse
 * into a single null-key bucket that renders WITHOUT a bounding box,
 * preserving the look of layers that haven't opted in to clustering.
 */
const clusterBuckets = computed<ClusterBucket[]>(() => {
  const all = nodes.value;
  if (all.length === 0) return [];
  // 1. Bucket nodes by resolved group key.
  const byGroup = new Map<string, TopologyNode[]>();
  for (const n of all) {
    const id = identity(n.name);
    const k = ckeyEnc(id.cluster);
    if (!byGroup.has(k)) byGroup.set(k, []);
    byGroup.get(k)!.push(n);
  }
  // 2. Run BFS on the inter-group meta-graph to decide bucket order.
  //    Each group becomes a meta-node; cross-group calls become meta-
  //    edges. `computeBoosterLevels` is reused with synthesised
  //    TopologyNode / TopologyCall shells.
  const clusterOfId = new Map<string, string>();
  for (const n of all) clusterOfId.set(n.id, ckeyEnc(identity(n.name).cluster));
  const interGroupCalls: TopologyCall[] = [];
  for (const c of calls.value) {
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
  // 3. Internal BFS per bucket — restrict the call graph to the
  //    bucket's own ids so the seed-pick + traversal don't leak.
  const buckets: ClusterBucket[] = [];
  for (const k of ordered) {
    const groupNodes = byGroup.get(k) ?? [];
    if (groupNodes.length === 0) continue;
    const ids = new Set(groupNodes.map((n) => n.id));
    const internalCalls = calls.value.filter((c) => ids.has(c.source) && ids.has(c.target));
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
      // Cluster boxes / alias chips only render when the layer carries
      // an explicit topology-cluster rule. Layers without one have all
      // nodes in the null-key bucket and never reach this branch with
      // a non-null key.
      alias: namingRule.value?.alias ?? null,
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
    // y=110 gives ~40px headroom above the cluster boxes so the
    // floating alias·value chip (which extends ~30px above each
    // cluster's top edge) has room without clipping at the SVG top.
    b.rect = { x: cursorX, y: 110, w, h };
    cursorX += w + GROUP_GAP_X;
  }
  return buckets;
});

// `layoutNodes` survives only as the flat list the rest of the view
// (drag, selection, edges) reads. Order doesn't matter for them; the
// per-bucket geometry is read off `clusterBuckets`.
const layoutNodes = computed<LayoutNode[]>(() => {
  const out: LayoutNode[] = [];
  for (const b of clusterBuckets.value) for (const n of b.nodes) out.push(n);
  return out;
});

// (Heaviest-path overlay removed — every edge now reads as equally
// important. The line is constant-weight; direction is conveyed by an
// animated dashed flow on every edge.)

// ── SVG layout math (circles + group bounding boxes).
/**
 * Node geometry — radius drives the cube/icon size and the column
 * spacing. Sized smaller than the design's r=42 so a chain reads
 * comfortably on a 12" laptop without horizontal scroll; metrics
 * text sits beneath the node with a larger size to compensate.
 */
const NODE_R = 32;
const COL_GAP = 220;
// Each row used to be NODE_R*2 + 90 = 154px tall; bump ~20% so the
// secondary node beneath a spine node (e.g. `agent::rating` under
// `agent::songs`) has more breathing room and the diagonal calls
// reach a clearly distinct row instead of crowding the spine.
const ROW_GAP = Math.round((NODE_R * 2 + 90) * 1.2);
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
  for (const b of clusterBuckets.value) {
    // Bucket-local column buckets — needed to place each node at its
    // row index *within its column*. The internal BFS already assigns
    // each node a `layerIdx`; the row is the node's position in the
    // column-bucket order, mirroring the legacy single-graph layout.
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

/**
 * Live cluster bounding rects — derived from the actual `nodePos` map
 * (which already folds in drag overrides) rather than the BFS-anchor
 * `bucket.rect`. As soon as a node is dragged, the cluster box grows
 * or shrinks to keep it enclosed. Only buckets with a non-null key
 * render — layers without a topology-cluster rule never enter here.
 */
interface ClusterRect {
  key: string;
  alias: string | null;
  rect: { x: number; y: number; w: number; h: number };
}
const CLUSTER_MARGIN = 36; // breathing room around the outermost node centres
const CLUSTER_HEAD_HEIGHT = 32; // space reserved above the topmost node for the chip
const clusterRects = computed<ClusterRect[]>(() => {
  const out: ClusterRect[] = [];
  for (const b of clusterBuckets.value) {
    if (!b.key) continue;
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    let count = 0;
    for (const n of b.nodes) {
      const p = nodePos.value.get(n.id);
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
    // the alias·value chip — which now renders INSIDE the cluster top
    // (see the chip template below). Drawing the chip inside removes
    // the prior CHIP_HEADROOM floor: the cluster top can now follow a
    // dragged node freely (even off the visible canvas top), and the
    // node stays visually enclosed because `y` is derived purely from
    // node positions instead of being clamped to a constant.
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
});

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
  // Embedded snapshot mode renders the same map but with no detail
  // sidebar — click is therefore a no-op.
  if (embedded.value) return;
  selectedNodeId.value = selectedNodeId.value === id ? null : id;
}
function selectCall(id: string | null): void {
  if (embedded.value) return;
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

// ── Instance-topology drill-down. Offered on an edge only when the
// layer ships an `instanceTopology` config (echoed in `cfg`) AND both
// endpoints are real services — OAP's getServiceInstanceTopology needs
// two real services. Clicking it switches the Topology tab to the
// Instance map sub-tab, pre-filled with this edge's client/server pair
// (edge source = client, target = server).
const hasInstanceTopology = computed<boolean>(() => Boolean(cfg.value?.instanceTopology));
const canDrillInstance = computed<boolean>(
  () =>
    !embedded.value &&
    hasInstanceTopology.value &&
    Boolean(selectedCallSource.value?.isReal && selectedCallTarget.value?.isReal),
);
function openInstanceTopology(): void {
  const c = selectedCall.value;
  const src = selectedCallSource.value;
  const dst = selectedCallTarget.value;
  if (!c || !src || !dst || !src.isReal || !dst.isReal) return;
  void router.push({
    path: `/layer/${layerKey.value}/topology`,
    query: { ...route.query, view: 'instance', client: c.source, server: c.target },
  });
}

/**
 * Visual focus sets. When a node OR an edge is selected, we keep the
 * "related" subgraph at full opacity and dim everything else, so the
 * operator's eye lands on the conversation they're inspecting:
 *
 *   - selected NODE      ⇒ keep selected + its upstream + downstream +
 *                          the edges joining them.
 *   - selected EDGE      ⇒ keep edge + both endpoints.
 *   - BOTH selected      ⇒ union of the two sets (drag-select effect).
 *   - nothing selected   ⇒ everything renders at full opacity (sets are
 *                          empty; `hasSelection` is false; the dim
 *                          branch never fires).
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
// Convention used across the detail panel: the call CHAIN is read
// from selected service outward.
//   - `upstream`   = services the selected service depends on (calls
//                    flow OUTBOUND: sel → X). They sit "earlier" in
//                    the chain that the selected service is part of.
//   - `downstream` = services that call the selected service (calls
//                    flow INBOUND: X → sel). They sit "later" in the
//                    chain (their request reaches sel as a hop).
// This matches the user's mental model: "something calling current
// service ⇒ downstream".
const upstream = computed<LayoutNode[]>(() => {
  const sel = selectedNode.value;
  if (!sel) return [];
  const ids = new Set(calls.value.filter((c) => c.source === sel.id).map((c) => c.target));
  return layoutNodes.value.filter((n) => ids.has(n.id));
});
const downstream = computed<LayoutNode[]>(() => {
  const sel = selectedNode.value;
  if (!sel) return [];
  const ids = new Set(calls.value.filter((c) => c.target === sel.id).map((c) => c.source));
  return layoutNodes.value.filter((n) => ids.has(n.id));
});

/**
 * Sub-bucket a related-services list (upstream / downstream) by the
 * identity group of each row. When the layer has a topology-cluster
 * rule, the detail-panel reader can scan namespace-by-namespace; when
 * the rule isn't configured (or no row has a group) everything
 * collapses to a single null-key bucket and renders unchanged.
 *
 * The output preserves the natural BFS order within each bucket and
 * orders buckets by first appearance.
 */
interface RelatedGroup {
  key: string | null;
  alias: string | null;
  rows: LayoutNode[];
}
function bucketRelated(list: LayoutNode[]): RelatedGroup[] {
  const map = new Map<string, RelatedGroup>();
  const order: string[] = [];
  for (const n of list) {
    const id = identity(n.name);
    const k = id.cluster ?? '';
    if (!map.has(k)) {
      map.set(k, { key: id.cluster, alias: id.clusterAlias, rows: [] });
      order.push(k);
    }
    map.get(k)!.rows.push(n);
  }
  return order.map((k) => map.get(k)!);
}
const upstreamByNs = computed<RelatedGroup[]>(() => bucketRelated(upstream.value));
const downstreamByNs = computed<RelatedGroup[]>(() => bucketRelated(downstream.value));

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
  const fit = Math.min(
    (vp.width - pad * 2) / W.value,
    (vp.height - pad * 2) / H.value,
  );
  // Operator-validated readable scale: at ~79% the node labels +
  // metric line both stay legible. Default to that unless the graph
  // is so wide / tall it forces a smaller fit. Never overshoot above
  // 79% — blowing the canvas up past that just wastes pixels.
  const READABLE_K = 0.79;
  const k = Math.max(0.15, Math.min(fit, READABLE_K));
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

// ────────────────────────────────────────────────────────────────────
// Smartscape hierarchy overlay — lazy-probed on node-select; chip on
// the focused hex's right edge opens the focus+context+suggestions
// overlay. The store gates the global auto-refresh ticker so the
// background topology doesn't shift while the operator pans through
// peers. Disabled in embedded (widget) mode — the snapshot widget is
// intentionally non-interactive.
// ────────────────────────────────────────────────────────────────────
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

/** Resolver passed to the overlay so it can place peers relative to
 *  the focused node's current topology coords. */
function resolveNodePos(id: string): { cx: number; cy: number } | null {
  const p = nodePos.value.get(id);
  return p ? { cx: p.cx, cy: p.cy } : null;
}

// Peer clicks in the overlay open the destination layer in a NEW
// BROWSER TAB (so the source tab keeps its overlay state), which means
// no `?hierarchy=1` URL coordination is needed here.

// Mirror live pan/zoom into the overlay's snapshot — the overlay
// re-draws the focused hex at its underlying topology position +
// scale, so it must follow whatever pan/zoom the operator does
// while the overlay is up (otherwise the "focus" hex drifts away
// from the hex it's supposed to overlap).
watch(zoomT, (z) => {
  if (hierarchy.isOpen) hierarchy.updateZoom({ k: z.k, x: z.x, y: z.y });
});

// Tear down the overlay (and re-enable the ticker) on unmount —
// otherwise leaving the tab while open would freeze refresh
// indefinitely.
onBeforeUnmount(() => {
  if (hierarchy.isOpen) hierarchy.close();
});

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
                <div v-if="gkey" class="focus-group-head">
                  <span class="focus-group-alias">{{ groupAliasLabel }}</span>
                  <span class="focus-group-val">{{ gkey }}</span>
                </div>
                <button
                  v-for="r in rows"
                  :key="r.id"
                  class="focus-row"
                  :class="{ selected: focusServiceNames.includes(r.raw) }"
                  type="button"
                  @click="toggleService(r.raw)"
                >
                  <span class="focus-check">{{ focusServiceNames.includes(r.raw) ? '●' : '○' }}</span>
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
                  <rect
                    :width="c.rect.w"
                    :height="c.rect.h"
                    rx="14"
                    ry="14"
                    fill="var(--sw-bg-1)"
                    fill-opacity="0.35"
                    stroke="var(--sw-line-2)"
                    stroke-width="1"
                    stroke-dasharray="4 5"
                  />
                  <!-- Header chip rendered INSIDE the cluster top
                       (in the CLUSTER_HEAD_HEIGHT padding above the
                       topmost node, reserved by the rect math above).
                       Previously this chip floated above the box top,
                       which forced a CHIP_HEADROOM floor on the rect
                       y that broke encompass when a node was dragged
                       above the floor. Drawing inside the cluster
                       removes that constraint entirely. The cluster
                       *value* is rendered noticeably larger than the
                       alias label — the name is the signal, the
                       alias is just a qualifier. -->
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
              <!-- Direction overlay: short dot-like dashes that drift
                   from source → target. Spacing + speed are tuned for
                   readability — earlier the dashes were dense (6-on /
                   10-off, 1.2s) and read as a fast-scrolling solid
                   line. Now they're discrete particles (4-on / 28-off,
                   3s) so the eye can track a single dot along the
                   path. Stroke is slightly thicker + round-capped so
                   each dot reads as a circle rather than a tick. -->
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
                <!-- Stacked-layers glyph — three offset chevrons -->
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
        <div v-else class="loader">
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
             Hidden in embedded (dashboard widget) mode — the snapshot
             is non-interactive. -->
        <div v-if="!embedded && layoutNodes.length > 0" class="sm-zoom-ctrls">
          <button class="sw-btn small" type="button" title="Zoom in (wheel up)" @click="zoomBy(1.25)">+</button>
          <button class="sw-btn small" type="button" title="Zoom out (wheel down)" @click="zoomBy(1 / 1.25)">−</button>
          <button class="sw-btn small" type="button" title="Fit to screen (double-click canvas)" @click="fitToScreen(true)">Fit</button>
          <span class="sm-zoom-pct" :title="`Scale ${(zoomT.k * 100).toFixed(0)}%`">{{ Math.round(zoomT.k * 100) }}%</span>
        </div>

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
      <aside v-if="selectedNode || selectedCall" class="sm-panels">
      <!-- ── Top slot: node panel (or empty prompt). ── -->
      <article v-if="selectedNode" class="sm-panel">
        <header class="sp-head">
          <div class="sp-id">
            <div class="sp-mono">{{ identity(selectedNode.name).display }}</div>
            <div class="sp-tags">
              <span v-if="identity(selectedNode.name).cluster" class="sw-tag accent">
                <span class="tag-alias">{{ identity(selectedNode.name).clusterAlias }}</span>
                <span class="tag-val">{{ identity(selectedNode.name).cluster }}</span>
              </span>
              <span v-if="showLegacyGroup && identity(selectedNode.name).legacyGroup" class="sw-tag">
                <span class="tag-alias">group</span>
                <span class="tag-val">{{ identity(selectedNode.name).legacyGroup }}</span>
              </span>
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
          <div class="sp-section-title">Upstream — services this one calls ({{ upstream.length }})</div>
          <ul class="sp-list">
            <template v-for="(g, gi) in upstreamByNs" :key="gi">
              <li v-if="g.key" class="sp-ns-head">
                <span class="sp-ns-alias">{{ g.alias }}</span>
                <span class="sp-ns-val">{{ g.key }}</span>
                <span class="sp-ns-count">{{ g.rows.length }}</span>
              </li>
              <li v-for="u in g.rows" :key="u.id">
                <span class="sp-pulse" :style="{ color: ringColor(u) }">●</span>
                <span class="sp-mono small">{{ identity(u.name).display }}</span>
                <span class="sp-cpm">{{ fmtWithUnit(nodeVal(u, centerDef), centerDef?.unit) }}</span>
              </li>
            </template>
            <li v-if="upstream.length === 0" class="sp-empty">no outbound calls in window</li>
          </ul>
        </div>
        <div class="sp-section">
          <div class="sp-section-title">Downstream — services calling this one ({{ downstream.length }})</div>
          <ul class="sp-list">
            <template v-for="(g, gi) in downstreamByNs" :key="gi">
              <li v-if="g.key" class="sp-ns-head">
                <span class="sp-ns-alias">{{ g.alias }}</span>
                <span class="sp-ns-val">{{ g.key }}</span>
                <span class="sp-ns-count">{{ g.rows.length }}</span>
              </li>
              <li v-for="d in g.rows" :key="d.id">
                <span class="sp-pulse" :style="{ color: ringColor(d) }">●</span>
                <span class="sp-mono small">{{ identity(d.name).display }}</span>
                <span class="sp-cpm">{{ fmtWithUnit(nodeVal(d, secondaryDef), secondaryDef?.unit) }}</span>
              </li>
            </template>
            <li v-if="downstream.length === 0" class="sp-empty">no inbound callers in window</li>
          </ul>
        </div>
        <!-- Node-only dashboard jumps. Edges deliberately have no
             corresponding affordance — we keep their detail inline. -->
        <div class="sp-actions">
          <button class="sw-btn small primary" type="button" @click="jumpToService">Open service</button>
          <button class="sw-btn small" type="button" @click="jumpToEndpointDependency">API map →</button>
        </div>
      </article>

      <!-- Top-slot placeholder when only an edge is selected — keeps
           the layout balanced (otherwise the edge panel would jump up
           to the top). When NEITHER node nor edge is selected the
           whole `aside` is hidden, so the SVG claims full width. -->
      <article v-if="!selectedNode && selectedCall" class="sm-panel sm-panel-empty">
        <span>Click a node to inspect a service</span>
      </article>

      <!-- ── Bottom slot: edge panel (or empty prompt). ── -->
      <article v-if="selectedCall && selectedCallSource && selectedCallTarget" class="sm-panel">
        <header class="sp-head">
          <div class="sp-id">
            <div class="sp-edge-row">
              <span class="sp-svc">
                <span v-if="identity(selectedCallSource.name).cluster" class="sw-tag accent tiny">
                  <span class="tag-alias">{{ identity(selectedCallSource.name).clusterAlias }}</span>
                  <span class="tag-val">{{ identity(selectedCallSource.name).cluster }}</span>
                </span>
                <span v-if="showLegacyGroup && identity(selectedCallSource.name).legacyGroup" class="sw-tag tiny">
                  <span class="tag-alias">group</span>
                  <span class="tag-val">{{ identity(selectedCallSource.name).legacyGroup }}</span>
                </span>
                <span class="sp-mono small">{{ identity(selectedCallSource.name).display }}</span>
              </span>
              <span class="sp-edge-arrow">→</span>
              <span class="sp-svc">
                <span v-if="identity(selectedCallTarget.name).cluster" class="sw-tag accent tiny">
                  <span class="tag-alias">{{ identity(selectedCallTarget.name).clusterAlias }}</span>
                  <span class="tag-val">{{ identity(selectedCallTarget.name).cluster }}</span>
                </span>
                <span v-if="showLegacyGroup && identity(selectedCallTarget.name).legacyGroup" class="sw-tag tiny">
                  <span class="tag-alias">group</span>
                  <span class="tag-val">{{ identity(selectedCallTarget.name).legacyGroup }}</span>
                </span>
                <span class="sp-mono small">{{ identity(selectedCallTarget.name).display }}</span>
              </span>
            </div>
            <div class="sp-tags">
              <span class="sw-tag">{{ selectedCall.detectPoints.join(' · ') || 'relation' }}</span>
            </div>
          </div>
          <div class="sp-head-actions">
            <button
              v-if="canDrillInstance"
              class="sw-btn small primary"
              type="button"
              @click="openInstanceTopology"
            >{{ t('Instance map') }} →</button>
            <button class="sw-btn small" type="button" @click="selectedCallId = null">×</button>
          </div>
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

      <!-- Bottom-slot placeholder when only a node is selected — keeps
           the column the same height as it would be with both panels
           filled. Whole `aside` is hidden when neither side is
           selected (see the `v-if` on it). -->
      <article
        v-if="selectedNode && !(selectedCall && selectedCallSource && selectedCallTarget)"
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
  display: inline-flex;
  align-items: baseline;
  gap: 6px;
}
.focus-group-alias { color: var(--sw-fg-3); }
.focus-group-alias::after { content: '·'; margin-left: 4px; color: var(--sw-fg-3); }
.focus-group-val {
  color: var(--sw-accent-2);
  font-family: var(--sw-mono);
  text-transform: none;
  letter-spacing: 0;
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
.sp-edge-row {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.sp-edge-arrow {
  color: var(--sw-fg-3);
  font-size: 11px;
}
.sp-svc {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
}
.sw-tag.tiny {
  font-size: 9.5px;
  padding: 0 5px;
  line-height: 14px;
  height: 14px;
}
/* `<alias · value>` chip layout — used by node / edge / list / group
   bounding-box title rows so the dimension label (e.g. `namespace`)
   reads as a subdued prefix and the value pops in accent colour. */
.sw-tag .tag-alias {
  opacity: 0.7;
  font-weight: 500;
  margin-right: 4px;
}
.sw-tag .tag-alias::after { content: '·'; margin-left: 4px; }
.sw-tag .tag-val { font-family: var(--sw-mono); font-weight: 600; }
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
.lg-swatch-other { background: var(--sw-line-3); }

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
.sp-head-actions { display: flex; align-items: center; gap: 6px; flex: 0 0 auto; }
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
/* Sub-header for related-service lists when grouped by cluster (k8s
   namespace / mesh namespace). Shows the alias·value chip + the row
   count for that bucket and visually separates the rows beneath. */
.sp-ns-head {
  font-size: 9.5px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--sw-fg-3);
  background: var(--sw-bg-2);
  padding: 4px 8px !important;
  margin-top: 4px;
  border-radius: 4px;
  border-bottom: 1px solid var(--sw-line) !important;
  display: flex;
  align-items: center;
  gap: 6px;
}
.sp-ns-head:first-child { margin-top: 0; }
.sp-ns-alias { color: var(--sw-fg-3); }
.sp-ns-alias::after { content: '·'; margin-left: 4px; }
.sp-ns-val {
  color: var(--sw-accent-2);
  font-family: var(--sw-mono);
  text-transform: none;
  letter-spacing: 0;
  font-weight: 700;
}
.sp-ns-count {
  margin-left: auto;
  color: var(--sw-fg-3);
  font-family: var(--sw-mono);
  font-weight: 500;
}
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
