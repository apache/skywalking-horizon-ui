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
  Deployment — the per-layer "Deployment" tab.
  Renders the instance-to-instance call graph WITHIN one service (OAP's
  getServiceInstanceTopology(svc, svc)). The selected service comes from the
  shell header picker (useSelectedService) — this view owns no service
  picker, so the shell's Service header shows above it like any service-
  scoped tab.

  Nodes are the service's instances; edges are intra-service instance
  relations. Nodes optionally CLUSTER into dashed boxes by the layer's
  `deployment.clusterBy` rule — either a name regex on the
  instance name (service-topology style) or an instance attribute value
  (node_role / node_type). Pan/zoom, animated edge flow, node popover (with
  "Open instance dashboard") and the client|server edge sidebar match the
  service map's vocabulary.
-->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import * as d3 from 'd3';
import { useI18n } from 'vue-i18n';
import { useRoute, useRouter } from 'vue-router';
import type {
  ClusterByRule,
  LayerDef,
  DeploymentCall,
  DeploymentConfig,
  DeploymentNode,
  DeploymentMetricDef,
  RolePairMetrics,
} from '@/api/client';
import { useDeployment } from '@/layer/service-map/useDeployment';
import { useSelectedService } from '@/layer/useSelectedService';
import { useLayers } from '@/shell/useLayers';
import { fmtMetric, fmtMetricAs, formatDuration } from '@/utils/formatters';
import { resolveServiceIdentity } from '@/utils/serviceName';
import Sparkline from '@/components/charts/Sparkline.vue';

const route = useRoute();
const router = useRouter();
const { t } = useI18n({ useScope: 'global' });

const { layers } = useLayers();
const layerKey = computed(() => String(route.params.layerKey ?? ''));
const layer = computed<LayerDef | null>(
  () => layers.value.find((l) => l.key.toUpperCase() === layerKey.value.toUpperCase()) ?? null,
);
const instanceWord = computed(() => layer.value?.slots?.instances ?? 'Instances');
const title = computed(() => layer.value?.slots?.deployment || t('Deployment'));
const namingRule = computed(() => layer.value?.naming ?? null);
function displayServiceName(name: string | null | undefined): string {
  return resolveServiceIdentity(name, namingRule.value).display;
}

// ── Selected service comes from the shell header (useSelectedService) —
// this view is service-scoped, so it does NOT own a service picker.
const { selectedId } = useSelectedService();
const enabled = computed(() => !!selectedId.value);
const { data, nodes, calls, isFetching } = useDeployment(layerKey, selectedId, enabled);
const serviceName = computed(() => displayServiceName(data.value?.serviceName) || '');

const cfg = computed<DeploymentConfig>(
  () => data.value?.config ?? { nodeMetrics: [] },
);
function pickByRole(defs: DeploymentMetricDef[], role: DeploymentMetricDef['role']): DeploymentMetricDef | null {
  return defs.find((d) => d.role === role) ?? null;
}
// Per-node metric defs: a node's role (from `roleBy`, set by the BFF)
// selects its metric set; falls back to the default `nodeMetrics`.
function roleConfigFor(n: DeploymentNode) {
  const want = (n.role ?? '').toLowerCase();
  if (!want) return null;
  return cfg.value.roles?.find((r) => r.key.toLowerCase() === want) ?? null;
}
function metricDefsFor(n: DeploymentNode): DeploymentMetricDef[] {
  return roleConfigFor(n)?.nodeMetrics ?? cfg.value.nodeMetrics ?? [];
}
function centerDefFor(n: DeploymentNode): DeploymentMetricDef | null {
  return pickByRole(metricDefsFor(n), 'center');
}
function ringDefFor(n: DeploymentNode): DeploymentMetricDef | null {
  return pickByRole(metricDefsFor(n), 'ring');
}
// The ring metric is PER-ROLE, so the legend is built ENTIRELY from config —
// each entry's role name + metric label come from the layer template, and the
// direction is derived ONLY from the config threshold flag `invertHealth` (no
// hard-coded metric name/word).
// Band-edge colors (green / light-yellow / dark-yellow); red has no upper edge.
const RING_BAND_COLORS = ['var(--sw-ok)', '#fbbf24', 'var(--sw-warn)'];
const ringByRole = computed<Array<{ role: string; metric: string; bounds: Array<{ v: string; color: string }> }>>(() => {
  const out: Array<{ role: string; metric: string; bounds: Array<{ v: string; color: string }> }> = [];
  const num = (n: number): string => String(Math.round(n * 100) / 100);
  const add = (label: string, ring: DeploymentMetricDef | null): void => {
    if (!ring) return;
    const th = ring.thresholds;
    const inv = !!th?.invertHealth;
    let bounds: Array<{ v: string; color: string }> = [];
    if (th && th.ok != null && th.warn != null && th.danger != null) {
      // Boundaries in the metric's own value space: lower-is-better caps each
      // band at ok/warn/danger; inverted reads in `invertBase - value`, so the
      // value-space edges are invertBase − threshold.
      const B = th.invertBase ?? 100;
      const vals = inv ? [B - th.ok, B - th.warn, B - th.danger] : [th.ok, th.warn, th.danger];
      bounds = vals.map((v, i) => ({ v: (inv ? '≥' : '≤') + num(v), color: RING_BAND_COLORS[i] ?? 'var(--sw-fg-3)' }));
    }
    out.push({ role: label, metric: ring.label, bounds });
  };
  const roles = cfg.value.roles ?? [];
  if (roles.length > 0) {
    for (const r of roles) add(r.label || r.key, pickByRole(r.nodeMetrics ?? cfg.value.nodeMetrics ?? [], 'ring'));
  } else {
    add('', pickByRole(cfg.value.nodeMetrics ?? [], 'ring'));
  }
  return out;
});

function nodeVal(n: DeploymentNode, def: DeploymentMetricDef | null): number | null {
  return def ? (n.metrics?.[def.id] ?? null) : null;
}
// Format a node/edge metric value honoring the def's `format`. `compact` keeps
// it tight for the node hex (`5m`); the full form ("5m 20s ago") is for the
// popover + edge panel. A `duration` value self-describes, so no unit suffix.
function fmtVal(v: number | null, unit?: string, format?: DeploymentMetricDef['format'], compact = false): string {
  if (v === null) return '—';
  if (format === 'duration') return compact ? formatDuration(v, true) : `${formatDuration(v)} ago`;
  const body = format ? fmtMetricAs(v, format) : fmtMetric(v);
  return unit ? `${body}${unit === '%' ? '' : ' '}${unit}` : body;
}
function fmtEdge(v: number | null, def: DeploymentMetricDef | null): string {
  return fmtVal(v, undefined, def?.format);
}
function bandColor(value: number, th: NonNullable<DeploymentMetricDef['thresholds']>): string {
  const base = th.invertBase ?? 100;
  const v = th.invertHealth ? Math.max(0, base - value) : value;
  if (v > (th.danger ?? 5)) return 'var(--sw-err)';
  if (v > (th.warn ?? 1)) return 'var(--sw-warn)';
  if (v > (th.ok ?? 0.1)) return '#fbbf24';
  return 'var(--sw-ok)';
}
function ringColor(n: DeploymentNode): string {
  const def = ringDefFor(n);
  if (!def) return 'var(--sw-line-2)';
  const v = nodeVal(n, def);
  if (v === null) return 'var(--sw-fg-3)';
  if (def.thresholds) return bandColor(v, def.thresholds);
  const healthHigh = /sla|success|apdex/i.test(def.id) || /sla|apdex|success/i.test(def.label);
  const errPct = healthHigh ? Math.max(0, 100 - v) : v;
  if (errPct > 5) return 'var(--sw-err)';
  if (errPct > 1) return 'var(--sw-warn)';
  if (errPct > 0.1) return '#fbbf24';
  return 'var(--sw-ok)';
}
/** Flat-top hexagon `points=` for circumradius `r`, centred at (0,0). */
function hexPoints(r: number): string {
  const h = r * 0.5;
  const s = r * 0.8660254037844386;
  return `${r},0 ${h},${s} ${-h},${s} ${-r},0 ${-h},${-s} ${h},${-s}`;
}


// ── Three independent rules, each keyed off an instance's name + attributes:
//   clusterBy → which dashed box (separates pod-groups)
//   siblingBy → which POD (bundles a pod's containers into one hex group)
//   roleBy    → set by the BFF as node.role (drives main-hex + per-role MQE)
// `attribute` matches the instance attribute bag case-insensitively;
// `nameRegex` reuses the service-naming resolver on the INSTANCE name.
const clusterBy = computed<ClusterByRule | null>(() => cfg.value.clusterBy ?? null);
const siblingBy = computed<ClusterByRule | null>(() => cfg.value.siblingBy ?? null);
function ruleAlias(r: ClusterByRule | null): string {
  if (!r) return '';
  if (r.kind === 'attribute') return r.alias || r.attribute;
  if (r.kind === 'attributes') return r.alias || r.attributes.join(' + ');
  return r.alias;
}
const clusterAlias = computed<string>(() => ruleAlias(clusterBy.value));
function attrVal(n: DeploymentNode, name: string): string | undefined {
  const want = name.toLowerCase();
  return n.attributes.find((a) => a.name.toLowerCase() === want)?.value || undefined;
}
function keyFromRule(rule: ClusterByRule | null, n: DeploymentNode): string | null {
  if (!rule) return null;
  if (rule.kind === 'attribute') return attrVal(n, rule.attribute) ?? null;
  // Composite: join the present attribute values; absent dimensions drop out
  // (e.g. node_type is missing on liaison nodes → cluster collapses to its
  // node_role alone).
  if (rule.kind === 'attributes') {
    const parts = rule.attributes.map((a) => attrVal(n, a)).filter((v): v is string => !!v);
    return parts.length ? parts.join(rule.separator ?? ' / ') : null;
  }
  return resolveServiceIdentity(n.name, {
    pattern: rule.pattern, flags: rule.flags,
    displayGroup: rule.displayGroup, valueGroup: rule.valueGroup, alias: rule.alias,
  }).cluster;
}
const clusterKeyOf = (n: DeploymentNode): string | null => keyFromRule(clusterBy.value, n);
// A pod = instances sharing the sibling key. No siblingBy ⇒ each instance is
// its own single-hex pod.
const siblingKeyOf = (n: DeploymentNode): string => keyFromRule(siblingBy.value, n) ?? n.id;
const isMainRole = (n: DeploymentNode): boolean => !!roleConfigFor(n)?.main;

interface Pod {
  clusterKey: string | null;
  siblingKey: string;
  main: DeploymentNode;
  siblings: DeploymentNode[];
}
interface ClusterBucket { key: string | null; label: string; pods: Pod[] }
const clusters = computed<ClusterBucket[]>(() => {
  const UNGROUPED = '__ungrouped__';
  const byCluster = new Map<string, Map<string, DeploymentNode[]>>();
  for (const n of nodes.value) {
    const cmk = clusterKeyOf(n) ?? UNGROUPED;
    if (!byCluster.has(cmk)) byCluster.set(cmk, new Map());
    const pods = byCluster.get(cmk)!;
    const sk = siblingKeyOf(n);
    if (!pods.has(sk)) pods.set(sk, []);
    pods.get(sk)!.push(n);
  }
  const out: ClusterBucket[] = [];
  for (const [cmk, podMap] of byCluster) {
    const ck = cmk === UNGROUPED ? null : cmk;
    const pods: Pod[] = [];
    for (const [sk, members] of podMap) {
      const sorted = [...members].sort((a, b) => a.name.localeCompare(b.name));
      const mainIdx = sorted.findIndex(isMainRole);
      const main = sorted[mainIdx >= 0 ? mainIdx : 0];
      pods.push({ clusterKey: ck, siblingKey: sk, main, siblings: sorted.filter((m) => m !== main) });
    }
    pods.sort((a, b) => a.main.name.localeCompare(b.main.name));
    out.push({ key: ck, label: ck ?? t('ungrouped'), pods });
  }
  return out.sort((a, b) => {
    if (a.key === null) return 1;
    if (b.key === null) return -1;
    return a.key.localeCompare(b.key);
  });
});

// ── Layout: pods tile in a near-square grid per cluster box; each pod = a
// main hex with up to 6 siblings attached at its edge midpoints (order:
// lower-right, lower-left, upper-right, upper-left, bottom, top — extras
// hidden). `pos` carries a per-node radius so edges trim correctly and the
// renderer sizes each hex.
// Sizing tracks the service map (NODE_R 32 / COL_GAP 220 / ROW_GAP 185) so the
// two topologies read at the same scale + zoom. Siblings are half the main hex.
const MAIN_R = 32;
const SIB_R = 16;
const SIB_DIST = 48; // main centre -> sibling centre
// Edge-midpoint directions (SVG y-down), in attach order.
const SIB_ANGLES = [30, 150, 330, 210, 90, 270].map((d) => (d * Math.PI) / 180);
const POD_DX = 210;
const POD_DY = 190;
const CLUSTER_GAP_X = 60;
const CLUSTER_PAD = 24;
const HEAD_H = 30;
interface Pos { cx: number; cy: number; r: number }
interface ClusterRect { key: string | null; label: string; x: number; y: number; w: number; h: number; boxed: boolean }
interface Layout { pos: Map<string, Pos>; w: number; h: number; nodeToPod: Map<string, string> }

const podIdOf = (clusterKey: string | null, siblingKey: string): string => `${clusterKey ?? ''}␟${siblingKey}`;

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
function rankPods(podIds: string[], edges: Array<[string, string]>): Map<string, number> {
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

// A cluster box must be wide enough to hold its header
// ("<name>  <ALIAS · INSTANCES>"); the dashed box is otherwise sized from the
// node bbox, which for a narrow single-column cluster (e.g. one liaison pod) is
// far thinner than the title, spilling it past the right edge. Estimated from
// glyph advance — no DOM measurement inside a computed: mono name ≈7.3px/char
// @12px bold, the uppercase alias ≈6.5px/char @9px with tracking.
function clusterHeaderMinW(label: string): number {
  const alias = `${clusterAlias.value} · ${instanceWord.value}`;
  return 16 + (label?.length ?? 0) * 7.3 + 8 + alias.length * 6.5 + 16;
}

// Cluster boxes are derived from the LIVE node positions (which include drag
// deltas), not the base grid — so a box always wraps its content and grows /
// moves when a pod inside it is dragged. Padding leaves room for the header
// band (top) and the sibling labels (bottom).
const BOX_HEAD_BAND = 34;
const BOX_PAD_X = 22;
const BOX_PAD_TOP = 10;
const BOX_PAD_BOTTOM = 28;
/** Horizontal box geometry shared by the layout packer and the live rect
 *  renderer (they MUST agree, or packing gaps drift): node extents + side
 *  padding, grown — centred — to the header width so a narrow cluster
 *  neither hangs its title off the right edge nor huddles its pods left.
 *  `label === null` ⇒ unboxed layer (no clusterBy): plain padded extents. */
function clusterBoxX(minX: number, maxX: number, label: string | null): { x: number; w: number } {
  const contentW = maxX - minX + BOX_PAD_X * 2;
  const w = label === null ? contentW : Math.max(contentW, clusterHeaderMinW(label));
  return { x: minX - BOX_PAD_X - (w - contentW) / 2, w };
}

const layout = computed<Layout>(() => {
  const pos = new Map<string, Pos>();
  const nodeToPod = new Map<string, string>();
  const showBoxes = !!clusterBy.value;

  // node → podId, podId → clusterKey
  const podCluster = new Map<string, string | null>();
  for (const cl of clusters.value) {
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
  for (const c of calls.value) {
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
  const clusterRank = rankPods(clusters.value.map((cl) => cl.key ?? ''), interEdges);
  const orderedClusters = [...clusters.value].sort((a, b) => {
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
    const box = clusterBoxX(minX, maxX, showBoxes ? cl.label : null);
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
});
const basePos = computed(() => layout.value.pos);
const nodeToPod = computed(() => layout.value.nodeToPod);
// Per-pod drag offsets (move a whole pod — main + its siblings — as a unit).
// Keyed by podId; reset when the selected service changes.
const podDelta = ref<Map<string, { dx: number; dy: number }>>(new Map());
const pos = computed<Map<string, Pos>>(() => {
  if (podDelta.value.size === 0) return basePos.value;
  const m = new Map<string, Pos>();
  for (const [id, p] of basePos.value) {
    const d = podDelta.value.get(nodeToPod.value.get(id) ?? '');
    m.set(id, d ? { cx: p.cx + d.dx, cy: p.cy + d.dy, r: p.r } : p);
  }
  return m;
});
const W = computed(() => layout.value.w);
const H = computed(() => layout.value.h);
// The canvas needs a CONCRETE height — the tab outlet sizes by content, so a
// flex/`height:100%` canvas would collapse to its min and starve the fit to a
// tiny zoom. Size to the graph (+ chrome), clamped to the service-map card's
// range, then scaled up: deployment graphs are wide + sparse, so HEIGHT_SCALE
// gives 50% more vertical room (effective ~702–1650px) than the flat map.
const CARD_MIN = 468;
const CARD_MAX = 1100;
const HEIGHT_SCALE = 1.5;
const canvasHeightPx = computed<number>(() => Math.round(Math.max(CARD_MIN, Math.min(CARD_MAX, H.value + 80)) * HEIGHT_SCALE));
function posR(id: string): number {
  return pos.value.get(id)?.r ?? MAIN_R;
}
const clusterRects = computed<ClusterRect[]>(() => {
  if (!clusterBy.value) return [];
  const out: ClusterRect[] = [];
  for (const cl of clusters.value) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, any = false;
    for (const pod of cl.pods) {
      for (const node of [pod.main, ...pod.siblings]) {
        const p = pos.value.get(node.id);
        if (!p) continue;
        any = true;
        minX = Math.min(minX, p.cx - p.r);
        maxX = Math.max(maxX, p.cx + p.r);
        minY = Math.min(minY, p.cy - p.r);
        maxY = Math.max(maxY, p.cy + p.r);
      }
    }
    if (!any) continue;
    const box = clusterBoxX(minX, maxX, cl.label);
    out.push({
      key: cl.key,
      label: cl.label,
      x: box.x,
      y: minY - BOX_HEAD_BAND - BOX_PAD_TOP,
      w: box.w,
      h: maxY - minY + BOX_HEAD_BAND + BOX_PAD_TOP + BOX_PAD_BOTTOM,
      boxed: true,
    });
  }
  return out;
});
function isSiblingNode(n: DeploymentNode): boolean {
  return posR(n.id) < MAIN_R - 6;
}
/** Single-letter glyph for a small sibling hex (role / last name segment). */
function siblingGlyph(n: DeploymentNode): string {
  return (n.role || n.name).charAt(0).toUpperCase();
}
function mainLabelRaw(n: DeploymentNode): string {
  return siblingBy.value ? siblingKeyOf(n) : n.name;
}
// The cluster box header already carries the role/tier, so the pod label only
// needs the part that distinguishes pods. Strip the longest shared
// '-'-segment prefix across all pods (e.g. `demo-banyandb-data-hot-0` →
// `data-hot-0`), never the last segment — keeps labels short so they don't
// collide with neighbours or the cross-tier edges.
const podLabelPrefix = computed<string>(() => {
  const names = clusters.value.flatMap((cl) => cl.pods.map((p) => mainLabelRaw(p.main)));
  if (names.length < 2) return '';
  const parts = names.map((s) => s.split('-'));
  const first = parts[0];
  let i = 0;
  while (i < first.length - 1 && parts.every((p) => i < p.length - 1 && p[i] === first[i])) i++;
  return i > 0 ? first.slice(0, i).join('-') + '-' : '';
});
/** Label under a MAIN hex — the pod identity, shared prefix stripped. (Sibling
 *  hexes show only their glyph; their role is in the popover.) */
function nodeLabel(n: DeploymentNode): string {
  const raw = mainLabelRaw(n);
  const p = podLabelPrefix.value;
  return p && raw.startsWith(p) ? raw.slice(p.length) : raw;
}

// ── Edges. Resolve to each instance's actual hex (main OR sibling) so
// cross-tier sibling edges connect the small attached hexes. Self-loops draw
// a teardrop; bidirectional pairs bow apart.
const callKeys = computed<Set<string>>(() => {
  const s = new Set<string>();
  for (const c of calls.value) s.add(`${c.source}|${c.target}`);
  return s;
});
const visibleCalls = computed<DeploymentCall[]>(() =>
  calls.value.filter((c) => pos.value.has(c.source) && pos.value.has(c.target)),
);
// Nodes the layout actually placed. Siblings beyond the attach-angle budget
// get no `pos` entry; rendering them anyway would pile full-size hexes at
// the origin (the template's `?? 0` translate fallback).
const visibleNodes = computed<DeploymentNode[]>(() => nodes.value.filter((n) => pos.value.has(n.id)));
function edgePathD(c: DeploymentCall): string {
  const a = pos.value.get(c.source);
  const b = pos.value.get(c.target);
  if (!a || !b) return '';
  if (c.source === c.target) {
    const x = a.cx;
    const y = a.cy - a.r;
    return `M ${x - 6} ${y} C ${x - 22} ${y - 30} ${x + 22} ${y - 30} ${x + 6} ${y}`;
  }
  const len = Math.hypot(b.cx - a.cx, b.cy - a.cy) || 1;
  const nx = -(b.cy - a.cy) / len;
  const ny = (b.cx - a.cx) / len;
  const bidirectional = callKeys.value.has(`${c.target}|${c.source}`);
  const sign = c.source < c.target ? 1 : -1;
  const bow = bidirectional ? 16 : 0;
  const mx = (a.cx + b.cx) / 2 + nx * bow * sign;
  const my = (a.cy + b.cy) / 2 + ny * bow * sign;
  const sa = Math.hypot(mx - a.cx, my - a.cy) || 1;
  const sb = Math.hypot(mx - b.cx, my - b.cy) || 1;
  const x1 = a.cx + ((mx - a.cx) / sa) * a.r;
  const y1 = a.cy + ((my - a.cy) / sa) * a.r;
  const x2 = b.cx + ((mx - b.cx) / sb) * b.r;
  const y2 = b.cy + ((my - b.cy) / sb) * b.r;
  return `M ${x1} ${y1} Q ${mx} ${my} ${x2} ${y2}`;
}

// ── Pan + zoom (same lifecycle as the instance map).
const svgEl = ref<SVGSVGElement | null>(null);
const zoomLayerEl = ref<SVGGElement | null>(null);
const containerEl = ref<HTMLDivElement | null>(null);
let zoomBehaviour: d3.ZoomBehavior<SVGSVGElement, unknown> | null = null;
const zoomT = ref<{ k: number; x: number; y: number }>({ k: 1, x: 0, y: 0 });
function viewportSize(): { width: number; height: number } {
  const el = containerEl.value;
  if (!el) return { width: W.value, height: H.value };
  const r = el.getBoundingClientRect();
  return { width: r.width || W.value, height: r.height || H.value };
}
function fitToScreen(animate = true): void {
  if (!svgEl.value || !zoomBehaviour) return;
  const vp = viewportSize();
  const pad = 24;
  const fit = Math.min((vp.width - pad * 2) / W.value, (vp.height - pad * 2) / H.value);
  // Same readable cap as the service map (0.79) so the hexes + fonts render at
  // the SAME on-screen scale across the two topologies. The canvas now has a
  // concrete height, so the fit actually reaches this cap instead of starving.
  const k = Math.max(0.15, Math.min(fit, 0.79));
  const tx = (vp.width - W.value * k) / 2;
  const ty = (vp.height - H.value * k) / 2;
  const transform = d3.zoomIdentity.translate(tx, ty).scale(k);
  const sel = d3.select(svgEl.value);
  if (animate) sel.transition().duration(200).call(zoomBehaviour.transform, transform);
  else sel.call(zoomBehaviour.transform, transform);
}
function zoomBy(factor: number): void {
  if (!svgEl.value || !zoomBehaviour) return;
  d3.select(svgEl.value).transition().duration(150).call(zoomBehaviour.scaleBy, factor);
}
function installZoom(): void {
  if (!svgEl.value || !zoomLayerEl.value) return;
  const sel = d3.select(svgEl.value);
  zoomBehaviour = d3
    .zoom<SVGSVGElement, unknown>()
    .scaleExtent([0.15, 5])
    .filter((event) => {
      if (event.type === 'mousedown' && (event as MouseEvent).button !== 0) return false;
      const target = event.target as Element | null;
      if (target?.closest?.('[data-node-id], [data-edge-id]')) return false;
      return !(event as MouseEvent).button;
    })
    .on('zoom', (ev) => {
      zoomT.value = { k: ev.transform.k, x: ev.transform.x, y: ev.transform.y };
      d3.select(zoomLayerEl.value).attr('transform', ev.transform.toString());
    });
  sel.call(zoomBehaviour);
  sel.on('dblclick.zoom', null);
  sel.on('dblclick', () => fitToScreen(true));
}
// Drag a pod (any hex in it) to reposition the whole pod — main + its
// siblings move together. The zoom filter bows out for `[data-node-id]`
// targets, so dragging never pans. d3.drag's event.dx/dy are post-transform
// (zoom-aware), so they apply straight to the pod delta. Re-bound on every
// (re)render since Vue recreates the node `<g>` elements.
function installNodeDrag(): void {
  if (!zoomLayerEl.value) return;
  const sel = d3.select(zoomLayerEl.value).selectAll<SVGGElement, unknown>('g.sit-node');
  sel.on('.drag', null);
  sel.call(
    d3
      .drag<SVGGElement, unknown>()
      .clickDistance(4)
      .on('start', (event) => { (event.sourceEvent as MouseEvent).stopPropagation(); })
      .on('drag', function (event) {
        const id = (this as SVGGElement).getAttribute('data-node-id');
        if (!id) return;
        const pid = nodeToPod.value.get(id);
        if (!pid) return;
        const cur = podDelta.value.get(pid) ?? { dx: 0, dy: 0 };
        const m = new Map(podDelta.value);
        m.set(pid, { dx: cur.dx + event.dx, dy: cur.dy + event.dy });
        podDelta.value = m;
      }),
  );
}
function installZoomAndFit(): void {
  if (!svgEl.value || !zoomLayerEl.value) return;
  installZoom();
  void nextTick(() => { installNodeDrag(); fitToScreen(false); });
}
// The <svg> lives behind a v-else and unmounts whenever a new service's
// data is in flight, then remounts when it lands — so re-bind zoom on every
// (re)mount (a one-shot latch would leave pan/zoom dead after the first
// service switch).
watch(svgEl, (el) => { if (el && zoomLayerEl.value) installZoomAndFit(); }, { flush: 'post' });
// selectedId is part of the key: a service switch that lands on cached data
// with identical counts still re-keys every v-for node element, which kills
// the per-element d3 drag listeners — rebind + refit on dataset identity,
// not just shape.
watch(
  () => `${selectedId.value}|${nodes.value.length}|${visibleCalls.value.length}|${clusters.value.length}`,
  () => { if (svgEl.value && zoomBehaviour) void nextTick(() => { installNodeDrag(); fitToScreen(false); }); },
);

// ── Selection (edge → sidebar, node → popover). Reset on service change.
const selectedCallId = ref<string | null>(null);
const popoverNodeId = ref<string | null>(null);
function selectEdge(id: string): void {
  popoverNodeId.value = null;
  selectedCallId.value = selectedCallId.value === id ? null : id;
}
function selectNode(id: string): void {
  selectedCallId.value = null;
  popoverNodeId.value = popoverNodeId.value === id ? null : id;
}
watch(selectedId, () => { selectedCallId.value = null; popoverNodeId.value = null; podDelta.value = new Map(); mapTab.value = 'topology'; });
const selectedCall = computed<DeploymentCall | null>(
  () => calls.value.find((c) => c.id === selectedCallId.value) ?? null,
);
const popoverNode = computed<DeploymentNode | null>(
  () => nodes.value.find((n) => n.id === popoverNodeId.value) ?? null,
);
function instById(id: string): DeploymentNode | null {
  return nodes.value.find((n) => n.id === id) ?? null;
}
// Popover attribute search — the FODC proxy stamps many labels onto each
// instance (k8s_*, net_*, …), so the list is long; filter + scroll it.
const attrFilter = ref('');
watch(popoverNodeId, () => { attrFilter.value = ''; });
const filteredAttrs = computed(() => {
  const n = popoverNode.value;
  if (!n) return [];
  const query = attrFilter.value.trim().toLowerCase();
  if (!query) return n.attributes;
  return n.attributes.filter(
    (a) => a.name.toLowerCase().includes(query) || a.value.toLowerCase().includes(query),
  );
});
const POP_W = 320;
const popoverStyle = computed<Record<string, string>>(() => {
  const n = popoverNode.value;
  const p = n ? pos.value.get(n.id) : null;
  const el = containerEl.value;
  if (!p || !el) return { display: 'none' };
  const z = zoomT.value;
  const cw = el.clientWidth;
  const ch = el.clientHeight;
  const nx = z.x + p.cx * z.k;
  const ny = z.y + p.cy * z.k;
  const r = p.r * z.k;
  const openRight = nx < cw / 2;
  let left = openRight ? nx + r + 10 : nx - r - 10 - POP_W;
  left = Math.max(8, Math.min(left, cw - POP_W - 8));
  // Keep the WHOLE popover inside the canvas, clear of the toolbar header at
  // the top. The box is centred on `top` (translateY(-50%)), so it extends
  // half its height up AND down — clamp the centre by half the (bounded)
  // height so neither edge is clipped. The attr list scrolls within `maxH`.
  const HEAD = 72; // toolbar header height to clear at the top
  const FOOT = 12; // bottom margin
  const maxH = Math.max(140, Math.min(440, ch - HEAD - FOOT));
  const half = maxH / 2;
  const top = Math.max(HEAD + half, Math.min(ny, ch - FOOT - half));
  const style: Record<string, string> = {
    left: `${left}px`,
    top: `${top}px`,
    width: `${POP_W}px`,
    maxHeight: `${maxH}px`,
    transform: 'translateY(-50%)',
  };
  return style;
});
function openInstanceDashboard(n: DeploymentNode): void {
  const href = router.resolve({
    path: `/layer/${layerKey.value}/instance`,
    query: { service: n.serviceId, instance: n.name },
  }).href;
  window.open(href, '_blank', 'noopener');
}

// ── Role-to-role edge metrics. An edge's role-pair (source role → target role,
// from `roleBy`) selects a `roleToRole` entry; most-specific wins (an exact
// from/to beats a `'*'` wildcard). The pair's metrics drive the inline `primary`
// number on the edge, the edge panel, and the Flows table; an edge matching no
// pair falls back to the flat linkServer/linkClient defs.
const roleToRole = computed<RolePairMetrics[]>(() => cfg.value.roleToRole ?? []);
function roleOfNode(n: DeploymentNode | null): string {
  return (n?.role ?? '').toLowerCase();
}
function pairForCall(c: DeploymentCall | null): RolePairMetrics | null {
  if (!c || roleToRole.value.length === 0) return null;
  const s = roleOfNode(instById(c.source));
  const d = roleOfNode(instById(c.target));
  const hit = (pat: string, v: string): boolean => pat === '*' || pat.toLowerCase() === v;
  const score = (p: RolePairMetrics): number => (p.from === '*' ? 0 : 1) + (p.to === '*' ? 0 : 1);
  let best: RolePairMetrics | null = null;
  let bestScore = -1;
  for (const p of roleToRole.value) {
    if (hit(p.from, s) && hit(p.to, d) && score(p) > bestScore) { best = p; bestScore = score(p); }
  }
  return best;
}
/** Edge metric value, side derived from the def's `role` (lineServer/lineClient). */
function edgeMetricVal(c: DeploymentCall, def: DeploymentMetricDef): number | null {
  return edgeVal(c, def.role === 'lineServer' ? 'server' : 'client', def);
}
// Up to 3 primary metric ids (single string or array), in order.
function primaryIds(pair: RolePairMetrics): string[] {
  const p = pair.primary;
  return (Array.isArray(p) ? p : p ? [p] : []).slice(0, 3);
}
function primaryDefsFor(c: DeploymentCall): DeploymentMetricDef[] {
  const pair = pairForCall(c);
  if (!pair) return [];
  // If an id has both sides, the inline value prefers the CLIENT metric.
  return primaryIds(pair)
    .map((id) => pair.metrics.find((m) => m.id === id && m.role === 'lineClient') ?? pair.metrics.find((m) => m.id === id))
    .filter((d): d is DeploymentMetricDef => !!d);
}
// The selected edge's primary metric ids — the popout flags these rows so it's
// clear which metrics drive the inline numbers on the edge.
const selectedPrimaryIds = computed<Set<string>>(() => {
  const pair = pairForCall(selectedCall.value);
  return new Set(pair ? primaryIds(pair) : []);
});
// ── Edge labels: one pill per edge at its midpoint showing the role-pair's
// `primary` metric(s). Up to 3 values flow into lines sized to the EDGE LENGTH
// (drag-reactive via `pos`): a long edge keeps them on one line, a short edge
// wraps toward one value per line. Width is estimated from the glyph count
// (mono ≈7.4px/char @13px) since SVG can't auto-size a rect.
const SEP_W = 12;
type EdgeItem = { alias: string; value: string; unit: string };
function edgeItemW(it: EdgeItem): number {
  return Math.round(((it.alias ? it.alias.length + 1 : 0) + it.value.length + (it.unit ? it.unit.length + 1 : 0)) * 7.4 + 12);
}
const edgeLabels = computed<Array<{ id: string; x: number; y: number; lines: EdgeItem[][]; w: number; h: number }>>(() => {
  const out: Array<{ id: string; x: number; y: number; lines: EdgeItem[][]; w: number; h: number }> = [];
  for (const c of visibleCalls.value) {
    const items: EdgeItem[] = [];
    for (const def of primaryDefsFor(c)) {
      const v = edgeMetricVal(c, def);
      if (v === null) continue;
      items.push({ alias: def.alias ?? '', value: fmtVal(v, undefined, def.format, true), unit: def.unit ?? '' });
    }
    if (items.length === 0) continue;
    const mid = edgeMid(c);
    if (!mid) continue;
    const a = pos.value.get(c.source);
    const b = pos.value.get(c.target);
    const edgeLen = a && b && c.source !== c.target ? Math.hypot(b.cx - a.cx, b.cy - a.cy) : 130;
    const budget = Math.max(56, Math.min(edgeLen * 0.7, 260));
    const lines: EdgeItem[][] = [];
    let cur: EdgeItem[] = [];
    let curW = 0;
    for (const it of items) {
      const add = (cur.length ? SEP_W : 0) + edgeItemW(it);
      if (cur.length && curW + add > budget) { lines.push(cur); cur = []; curW = 0; }
      cur.push(it);
      curW += (cur.length > 1 ? SEP_W : 0) + edgeItemW(it);
    }
    if (cur.length) lines.push(cur);
    const w = Math.max(44, ...lines.map((line) => line.reduce((s, it, j) => s + (j ? SEP_W : 0) + edgeItemW(it), 0) + 14));
    out.push({ id: c.id, x: mid.x, y: mid.y, lines, w, h: lines.length * 16 + 8 });
  }
  return out;
});

// ── Edge detail rows (aligned client | server) — same as the instance map.
interface EdgeRow { id: string; label: string; unit: string; serverDef: DeploymentMetricDef | null; clientDef: DeploymentMetricDef | null }
function buildEdgeRows(srv: DeploymentMetricDef[], cli: DeploymentMetricDef[]): EdgeRow[] {
  const map = new Map<string, EdgeRow>();
  for (const m of srv) {
    const row = map.get(m.id) ?? { id: m.id, label: m.label, unit: m.unit ?? '', serverDef: null, clientDef: null };
    row.serverDef = m;
    map.set(m.id, row);
  }
  for (const m of cli) {
    const row = map.get(m.id) ?? { id: m.id, label: m.label, unit: m.unit ?? '', serverDef: null, clientDef: null };
    row.clientDef = m;
    if (!row.label) row.label = m.label;
    if (!row.unit) row.unit = m.unit ?? '';
    map.set(m.id, row);
  }
  return [...map.values()];
}
// Pair-aware: the selected edge's role-pair metrics (split by side), else the
// flat link defs. pub/sub metrics carry DIFFERENT ids, so they render as
// separate client-only / server-only rows (one per Grafana "Flows" column).
const edgeRows = computed<EdgeRow[]>(() => {
  const pair = pairForCall(selectedCall.value);
  if (pair) {
    return buildEdgeRows(
      pair.metrics.filter((m) => m.role === 'lineServer'),
      pair.metrics.filter((m) => m.role === 'lineClient'),
    );
  }
  return buildEdgeRows(cfg.value.linkServerMetrics ?? [], cfg.value.linkClientMetrics ?? []);
});
function edgeVal(c: DeploymentCall, side: 'server' | 'client', def: DeploymentMetricDef | null): number | null {
  if (!def) return null;
  const b = side === 'server' ? c.serverMetrics : c.clientMetrics;
  return b?.[def.id] ?? null;
}
function edgeSeries(c: DeploymentCall, side: 'server' | 'client', def: DeploymentMetricDef | null): Array<number | null> {
  if (!def) return [];
  const b = side === 'server' ? c.serverMetricSeries : c.clientMetricSeries;
  return b?.[def.id] ?? [];
}
function seriesAt(arr: Array<number | null>, idx: number | null): number | null {
  if (idx === null || idx < 0 || idx >= arr.length) return null;
  return arr[idx];
}
type EdgeRowKind = 'both' | 'client-only' | 'server-only' | 'none';
function edgeRowValues(c: DeploymentCall, row: EdgeRow): { kind: EdgeRowKind; clientV: number | null; serverV: number | null } {
  const clientV = row.clientDef ? edgeVal(c, 'client', row.clientDef) : null;
  const serverV = row.serverDef ? edgeVal(c, 'server', row.serverDef) : null;
  if (clientV !== null && serverV !== null) return { kind: 'both', clientV, serverV };
  if (clientV !== null) return { kind: 'client-only', clientV, serverV };
  if (serverV !== null) return { kind: 'server-only', clientV, serverV };
  return { kind: 'none', clientV, serverV };
}
const hoveredEdgeRowId = ref<string | null>(null);
const hoveredEdgeBucket = ref<number | null>(null);
function onEdgeBucketHover(rowId: string, bucket: number): void { hoveredEdgeRowId.value = rowId; hoveredEdgeBucket.value = bucket; }
function onEdgeBucketLeave(): void { hoveredEdgeRowId.value = null; hoveredEdgeBucket.value = null; }
function rowCrosshair(rowId: string): number | null { return hoveredEdgeRowId.value === rowId ? hoveredEdgeBucket.value : null; }

// ── Edge midpoint for the inline primary label — mirrors edgePathD's control
// point (quadratic Bézier at t=0.5). Self-loops sit above the node; bidirectional
// pairs bow apart by `sign`, so their two labels never collide.
function edgeMid(c: DeploymentCall): { x: number; y: number } | null {
  const a = pos.value.get(c.source);
  const b = pos.value.get(c.target);
  if (!a || !b) return null;
  if (c.source === c.target) return { x: a.cx, y: a.cy - a.r - 30 };
  const len = Math.hypot(b.cx - a.cx, b.cy - a.cy) || 1;
  const nx = -(b.cy - a.cy) / len;
  const ny = (b.cx - a.cx) / len;
  const bidirectional = callKeys.value.has(`${c.target}|${c.source}`);
  const sign = c.source < c.target ? 1 : -1;
  const bow = bidirectional ? 16 : 0;
  const mx = (a.cx + b.cx) / 2 + nx * bow * sign;
  const my = (a.cy + b.cy) / 2 + ny * bow * sign;
  return { x: (a.cx + 2 * mx + b.cx) / 4, y: (a.cy + 2 * my + b.cy) / 4 };
}

// ── Map sub-tab: the topology graph, or the role-to-role "Flows" table — every
// edge's pair metrics in one grid (the Grafana FODC "Flows" board). The tab only
// appears when the layer configures `roleToRole`.
const mapTab = ref<'topology' | 'flows'>('topology');
const hasFlows = computed(() => roleToRole.value.length > 0);
// Flows grouped BY role-pair: each pair renders as one aligned sub-table with
// its OWN metric columns, so heterogeneous pairs (liaison→data's write/query/
// sync set vs lifecycle→data's migration set) never collapse into one sparse
// 20-column grid. Group order follows the roleToRole config; every edge matches
// at least the '*' fallback.
interface FlowGroup { key: string; label: string; pair: RolePairMetrics; calls: DeploymentCall[] }
function pairLabel(p: RolePairMetrics): string {
  const f = p.from === '*' ? '·' : p.from;
  const tt = p.to === '*' ? '·' : p.to;
  return `${f} → ${tt}`;
}
const flowGroups = computed<FlowGroup[]>(() => {
  const groups = new Map<string, FlowGroup>();
  for (const c of calls.value) {
    const pair = pairForCall(c);
    if (!pair) continue;
    const key = `${pair.from}␟${pair.to}`;
    let g = groups.get(key);
    if (!g) { g = { key, label: pairLabel(pair), pair, calls: [] }; groups.set(key, g); }
    g.calls.push(c);
  }
  return [...groups.values()].sort((a, b) => roleToRole.value.indexOf(a.pair) - roleToRole.value.indexOf(b.pair));
});
function flowCell(c: DeploymentCall, def: DeploymentMetricDef): string {
  return fmtVal(edgeMetricVal(c, def), def.unit, def.format);
}
function selectEdgeFromFlows(id: string): void {
  selectedCallId.value = id;
  popoverNodeId.value = null;
  mapTab.value = 'topology';
}

const showPickPrompt = computed(() => !enabled.value);
const showLoading = computed(() => enabled.value && isFetching.value && nodes.value.length === 0);
const isEmpty = computed(() => enabled.value && !isFetching.value && nodes.value.length === 0);

function onKeyDown(e: KeyboardEvent): void {
  if (e.key !== 'Escape') return;
  if (popoverNodeId.value) popoverNodeId.value = null;
  else if (selectedCallId.value) selectedCallId.value = null;
  else return;
  e.preventDefault();
}
onMounted(() => window.addEventListener('keydown', onKeyDown, true));
onBeforeUnmount(() => window.removeEventListener('keydown', onKeyDown, true));
</script>

<template>
  <div class="sit">
    <div class="sit-toolbar">
      <span class="sit-title">{{ title }}</span>
      <span v-if="serviceName" class="sit-divider" />
      <span v-if="serviceName" class="sit-svc mono">{{ serviceName }}</span>
      <span v-if="clusterAlias" class="sit-cluster-chip">{{ t('clustered by') }} · {{ clusterAlias }}</span>
      <span v-if="isFetching" class="sit-hint">{{ t('Reading data…') }}</span>
      <div class="sit-spacer" />
      <div v-if="hasFlows" class="sit-tabs" role="tablist">
        <button class="sit-tab" :class="{ active: mapTab === 'topology' }" type="button" @click="mapTab = 'topology'">{{ t('Topology') }}</button>
        <button class="sit-tab" :class="{ active: mapTab === 'flows' }" type="button" @click="mapTab = 'flows'">{{ t('Flows') }}</button>
      </div>
    </div>

    <div class="sit-body" :class="{ 'no-selection': !selectedCall || mapTab === 'flows' }">
      <div v-show="mapTab === 'topology'" ref="containerEl" class="sit-canvas" :style="{ height: canvasHeightPx + 'px' }">
        <div v-if="showPickPrompt" class="sit-state">{{ t('Pick a service to see its deployment topology.') }}</div>
        <div v-else-if="showLoading" class="sit-state">{{ t('Reading data…') }}</div>
        <div v-else-if="isEmpty" class="sit-state">{{ t('No deployment topology in this window.') }}</div>
        <template v-else>
          <svg ref="svgEl" class="sit-svg" width="100%" height="100%">
            <g ref="zoomLayerEl" :class="{ 'has-pop': !!popoverNodeId }">
              <g class="sit-groups">
                <g v-for="(g, gi) in clusterRects" :key="g.key ?? `__${gi}`" :transform="`translate(${g.x}, ${g.y})`">
                  <template v-if="g.boxed">
                    <rect :width="g.w" :height="g.h" rx="14" ry="14" class="sit-grp-rect" />
                    <text x="16" y="20" class="sit-grp-head">
                      <tspan class="sit-grp-name mono">{{ g.label }}</tspan>
                      <tspan class="sit-grp-alias" dx="8">{{ clusterAlias }} · {{ instanceWord }}</tspan>
                    </text>
                  </template>
                </g>
              </g>
              <g v-for="c in visibleCalls" :key="c.id" class="sit-edge" :data-edge-id="c.id" @click.stop="selectEdge(c.id)">
                <path :d="edgePathD(c)" fill="none" stroke="transparent" stroke-width="14" style="cursor: pointer" />
                <path
                  :d="edgePathD(c)" fill="none"
                  :stroke="selectedCallId === c.id ? 'var(--sw-accent-2)' : 'var(--sw-accent)'"
                  :stroke-width="selectedCallId === c.id ? 3 : 1.6"
                  :opacity="selectedCallId === c.id ? 1 : 0.6"
                  stroke-linecap="round" style="pointer-events: none"
                />
                <path
                  :d="edgePathD(c)" fill="none"
                  :stroke="selectedCallId === c.id ? 'var(--sw-accent-2)' : 'var(--sw-accent)'"
                  :stroke-width="selectedCallId === c.id ? 4 : 3"
                  stroke-linecap="round" stroke-dasharray="4 28" opacity="0.95" style="pointer-events: none"
                >
                  <animate attributeName="stroke-dashoffset" from="32" to="0" dur="3s" repeatCount="indefinite" />
                </path>
              </g>
              <g
                v-for="n in visibleNodes" :key="n.id" class="sit-node"
                :class="{ sel: popoverNodeId === n.id, sibling: isSiblingNode(n) }" :data-node-id="n.id"
                :transform="`translate(${pos.get(n.id)?.cx ?? 0}, ${pos.get(n.id)?.cy ?? 0})`"
                @click.stop="selectNode(n.id)"
              >
                <polygon
                  :points="hexPoints(posR(n.id))" class="node-bg"
                  :stroke="ringColor(n)" :stroke-width="popoverNodeId === n.id ? 4 : 2.5"
                  stroke-linejoin="round"
                />
                <template v-if="!isSiblingNode(n)">
                  <text class="node-center" text-anchor="middle" :dy="centerDefFor(n)?.unit ? '-1' : '0.36em'">{{ fmtVal(nodeVal(n, centerDefFor(n)), undefined, centerDefFor(n)?.format, true) }}</text>
                  <text v-if="centerDefFor(n)?.unit" class="node-unit" text-anchor="middle" dy="12">{{ centerDefFor(n)?.unit }}</text>
                </template>
                <text v-else class="node-sib-glyph" text-anchor="middle" dy="0.34em">{{ siblingGlyph(n) }}</text>
                <!-- Label only on the MAIN hex, dropped clear below the sibling
                     hexes; siblings carry just their glyph (role in the popover). -->
                <text v-if="!isSiblingNode(n)" class="node-label mono" text-anchor="middle" :y="MAIN_R + 24">{{ nodeLabel(n) }}</text>
              </g>
              <g class="sit-edge-labels">
                <g
                  v-for="l in edgeLabels" :key="l.id"
                  :transform="`translate(${l.x - l.w / 2}, ${l.y - l.h / 2})`"
                  style="pointer-events: none"
                >
                  <rect
                    x="0" y="0" :width="l.w" :height="l.h" :rx="l.lines.length === 1 ? 12 : 9"
                    fill="var(--sw-bg-1)"
                    :stroke="selectedCallId === l.id ? 'var(--sw-accent-2)' : 'var(--sw-line-2)'"
                    :stroke-width="selectedCallId === l.id ? 1.4 : 1"
                  />
                  <text text-anchor="middle" class="sit-edge-lbl" :class="{ sel: selectedCallId === l.id }"><tspan v-for="(line, li) in l.lines" :key="li" :x="l.w / 2" dy="16"><template v-for="(it, j) in line" :key="j"><tspan v-if="j > 0" class="sit-edge-sep"> · </tspan><tspan v-if="it.alias" class="sit-edge-alias">{{ it.alias }}</tspan><tspan :dx="it.alias ? 5 : 0">{{ it.value }}</tspan><tspan v-if="it.unit" dx="2" class="sit-edge-unit">{{ it.unit }}</tspan></template></tspan></text>
                </g>
              </g>
            </g>
          </svg>

          <div v-if="popoverNode" class="sit-node-pop sw-card" :style="popoverStyle">
            <header class="np-head">
              <span class="np-name mono">{{ popoverNode.name }}</span>
              <button class="sw-btn small ghost" type="button" @click="popoverNodeId = null">×</button>
            </header>
            <section v-if="metricDefsFor(popoverNode).length > 0" class="np-metrics">
              <div class="np-section-label">{{ t('Key metrics') }}</div>
              <dl class="np-kv">
                <template v-for="def in metricDefsFor(popoverNode)" :key="def.id">
                  <dt>{{ def.label }}</dt>
                  <dd class="mono">{{ fmtVal(nodeVal(popoverNode, def), def.unit, def.format) }}</dd>
                </template>
              </dl>
            </section>

            <section v-if="popoverNode.attributes.length > 0" class="np-props">
              <div class="np-section-label">
                {{ t('Properties') }}
                <span class="np-count">{{ popoverNode.attributes.length }}</span>
              </div>
              <input
                v-if="popoverNode.attributes.length > 6"
                v-model="attrFilter"
                class="np-search"
                type="text"
                :placeholder="t('Filter attributes…')"
              />
              <div class="np-attrs-scroll">
                <dl class="np-attrs">
                  <template v-for="a in filteredAttrs" :key="a.name">
                    <dt>{{ a.name }}</dt>
                    <dd class="mono">{{ a.value }}</dd>
                  </template>
                </dl>
                <div v-if="filteredAttrs.length === 0" class="np-empty">{{ t('No matching attributes') }}</div>
              </div>
            </section>

            <button class="sw-btn small np-open" type="button" @click="openInstanceDashboard(popoverNode)">
              {{ t('Open instance dashboard') }} ↗
            </button>
          </div>

          <div class="sit-zoom">
            <button class="sw-btn small" type="button" :title="t('Zoom in')" @click="zoomBy(1.25)">+</button>
            <button class="sw-btn small" type="button" :title="t('Zoom out')" @click="zoomBy(1 / 1.25)">−</button>
            <button class="sw-btn small" type="button" :title="t('Fit to screen')" @click="fitToScreen(true)">{{ t('Fit') }}</button>
            <span class="sit-zoom-pct" :title="`${t('Scale')} ${Math.round(zoomT.k * 100)}%`">{{ Math.round(zoomT.k * 100) }}%</span>
          </div>

          <div v-if="ringByRole.length" class="sit-ring-legend">
            <div class="lg-title">{{ t('Node ring') }}</div>
            <div class="lg-ramp">
              <span style="background: var(--sw-ok)" />
              <span style="background: #fbbf24" />
              <span style="background: var(--sw-warn)" />
              <span style="background: var(--sw-err)" />
            </div>
            <div class="lg-roles">
              <template v-for="r in ringByRole" :key="r.role + r.metric">
                <span class="lg-role-name">{{ r.role }}</span>
                <span class="lg-role-metric">{{ r.metric }}</span>
                <span v-for="i in 3" :key="i" class="lg-b" :style="{ color: r.bounds[i - 1]?.color }">{{ r.bounds[i - 1]?.v ?? '' }}</span>
              </template>
            </div>
          </div>
        </template>
      </div>

      <div v-if="mapTab === 'flows'" class="sit-flows" :style="{ minHeight: canvasHeightPx + 'px' }">
        <div v-if="showPickPrompt" class="sit-state-inline">{{ t('Pick a service to see its deployment topology.') }}</div>
        <div v-else-if="flowGroups.length === 0" class="sit-state-inline">{{ t('No flows in this window.') }}</div>
        <div v-else class="sit-flow-groups">
          <section v-for="g in flowGroups" :key="g.key" class="sit-flow-group">
            <header class="sit-flow-group-head">
              <span class="fg-pair mono">{{ g.label }}</span>
              <span class="fg-count">{{ g.calls.length }} {{ g.calls.length === 1 ? t('edge') : t('edges') }}</span>
            </header>
            <div class="sit-flow-scroll">
              <table class="sit-flow-table">
                <thead>
                  <tr>
                    <th>{{ t('Source') }}</th>
                    <th>{{ t('Target') }}</th>
                    <th v-for="col in g.pair.metrics" :key="col.id" class="fl-num">
                      {{ col.label }}<span v-if="col.unit" class="fl-unit"> ({{ col.unit }})</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="c in g.calls" :key="c.id" @click="selectEdgeFromFlows(c.id)">
                    <td class="mono fl-ep" :title="instById(c.source)?.name">{{ instById(c.source)?.name }}</td>
                    <td class="mono fl-ep" :title="instById(c.target)?.name">{{ instById(c.target)?.name }}</td>
                    <td v-for="col in g.pair.metrics" :key="col.id" class="mono fl-num" :class="{ 'fl-primary': primaryIds(g.pair).includes(col.id) }">{{ flowCell(c, col) }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>
        </div>
      </div>

      <aside v-if="selectedCall && mapTab === 'topology'" class="sit-panel">
        <header class="sit-panel-head">
          <div class="ip-edge mono">
            <span>{{ instById(selectedCall.source)?.name }}</span>
            <span class="sit-arrow">→</span>
            <span>{{ instById(selectedCall.target)?.name }}</span>
          </div>
          <button class="sw-btn small ghost" type="button" @click="selectedCallId = null">×</button>
        </header>
        <div class="ip-tags">
          <span class="sw-tag">{{ selectedCall.detectPoints.join(' · ') || t('relation') }}</span>
        </div>
        <div class="sit-panel-body">
          <div v-if="edgeRows.length > 0" class="ip-edge-rows">
            <div v-for="row in edgeRows" :key="row.id" class="ip-edge-row">
              <div class="ip-edge-row-head">
                <span class="ip-edge-row-label">{{ row.label }}<span v-if="row.unit" class="ru"> ({{ row.unit }})</span><span v-if="selectedPrimaryIds.has(row.id)" class="ip-edge-prim" :title="t('Shown on the edge (primary)')">{{ t('★ on edge') }}</span></span>
                <span v-if="hoveredEdgeRowId === row.id && hoveredEdgeBucket !== null" class="ip-edge-tip">
                  <template v-if="row.clientDef"><span class="tip-tag" style="color: var(--sw-info)">C</span><span class="tip-val">{{ fmtEdge(seriesAt(edgeSeries(selectedCall, 'client', row.clientDef), hoveredEdgeBucket), row.clientDef) }}</span></template>
                  <template v-if="row.serverDef"><span class="tip-sep">·</span><span class="tip-tag" style="color: var(--sw-accent)">S</span><span class="tip-val">{{ fmtEdge(seriesAt(edgeSeries(selectedCall, 'server', row.serverDef), hoveredEdgeBucket), row.serverDef) }}</span></template>
                </span>
              </div>
              <template v-if="edgeRowValues(selectedCall, row).kind === 'both'">
                <div class="ip-edge-pair">
                  <div class="ip-edge-cell">
                    <div class="ip-edge-cell-head"><span class="tag c">{{ t('Client') }}</span><span class="num">{{ fmtEdge(edgeRowValues(selectedCall, row).clientV, row.clientDef) }}</span></div>
                    <Sparkline :values="edgeSeries(selectedCall, 'client', row.clientDef)" color="var(--sw-info)" :height="36" :stroke="1.4" fluid :crosshair-bucket="rowCrosshair(row.id)" @bucket-hover="(b: number) => onEdgeBucketHover(row.id, b)" @bucket-leave="onEdgeBucketLeave" />
                  </div>
                  <div class="ip-edge-cell">
                    <div class="ip-edge-cell-head"><span class="tag s">{{ t('Server') }}</span><span class="num">{{ fmtEdge(edgeRowValues(selectedCall, row).serverV, row.serverDef) }}</span></div>
                    <Sparkline :values="edgeSeries(selectedCall, 'server', row.serverDef)" color="var(--sw-accent)" :height="36" :stroke="1.4" fluid :crosshair-bucket="rowCrosshair(row.id)" @bucket-hover="(b: number) => onEdgeBucketHover(row.id, b)" @bucket-leave="onEdgeBucketLeave" />
                  </div>
                </div>
              </template>
              <template v-else-if="edgeRowValues(selectedCall, row).kind === 'client-only'">
                <div class="ip-edge-cell">
                  <div class="ip-edge-cell-head"><span class="tag c">{{ t('Client') }}</span><span class="num">{{ fmtEdge(edgeRowValues(selectedCall, row).clientV, row.clientDef) }}</span></div>
                  <Sparkline :values="edgeSeries(selectedCall, 'client', row.clientDef)" color="var(--sw-info)" :height="36" :stroke="1.4" fluid :crosshair-bucket="rowCrosshair(row.id)" @bucket-hover="(b: number) => onEdgeBucketHover(row.id, b)" @bucket-leave="onEdgeBucketLeave" />
                </div>
              </template>
              <template v-else-if="edgeRowValues(selectedCall, row).kind === 'server-only'">
                <div class="ip-edge-cell">
                  <div class="ip-edge-cell-head"><span class="tag s">{{ t('Server') }}</span><span class="num">{{ fmtEdge(edgeRowValues(selectedCall, row).serverV, row.serverDef) }}</span></div>
                  <Sparkline :values="edgeSeries(selectedCall, 'server', row.serverDef)" color="var(--sw-accent)" :height="36" :stroke="1.4" fluid :crosshair-bucket="rowCrosshair(row.id)" @bucket-hover="(b: number) => onEdgeBucketHover(row.id, b)" @bucket-leave="onEdgeBucketLeave" />
                </div>
              </template>
              <template v-else>
                <div class="ip-edge-none">{{ t('no value') }}</div>
              </template>
            </div>
          </div>
          <div v-else class="ip-empty">{{ t('no line metrics configured') }}</div>
        </div>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.sit { display: flex; flex-direction: column; gap: 10px; height: 100%; min-height: 0; }
.sit-toolbar {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  padding: 8px 10px; border: 1px solid var(--sw-line); border-radius: 6px; background: var(--sw-bg-1);
}
.sit-title { font-size: 12px; font-weight: 700; color: var(--sw-fg-0); }
.sit-divider { width: 1px; height: 18px; background: var(--sw-line-2); margin: 0 2px; }
.sit-svc { font-size: 12px; color: var(--sw-fg-1); }
.sit-cluster-chip {
  font-size: 9.5px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--sw-fg-2);
  padding: 2px 7px; border-radius: 4px; border: 1px solid var(--sw-line-2); background: var(--sw-bg-2);
}
.sit-arrow { color: var(--sw-accent); font-weight: 700; }
.sit-hint { font-size: 10.5px; color: var(--sw-fg-3); }
.sit-spacer { flex: 1; }
.sit-legend { display: flex; gap: 14px; align-items: center; }
.lg-item { display: inline-flex; align-items: center; gap: 5px; font-size: 10px; color: var(--sw-fg-2); }
.lg-dot { width: 11px; height: 11px; border-radius: 50%; flex: 0 0 auto; }
.lg-dot.center { background: var(--sw-bg-3); border: 1.5px solid var(--sw-fg-1); }
.lg-dot.ring { background: transparent; border: 2px solid var(--sw-fg-2); }
.lg-dot.secondary { width: 8px; height: 8px; background: var(--sw-fg-3); }
.lg-dot.lineServer, .lg-dot.lineClient, .lg-dot.plain { width: 8px; height: 8px; background: var(--sw-fg-3); border-radius: 2px; }
.lg-unit { color: var(--sw-fg-3); }

.sit-body { flex: 1; min-height: 0; display: grid; grid-template-columns: 1fr 380px; gap: 10px; }
.sit-body.no-selection { grid-template-columns: 1fr; }
.sit-canvas {
  position: relative; overflow: hidden; min-width: 0;
  border: 1px solid var(--sw-line); border-radius: 6px;
  background: radial-gradient(circle at center, var(--sw-bg-1) 0%, var(--sw-bg-0) 100%);
}
.sit-state { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: var(--sw-fg-3); font-size: 12px; text-align: center; padding: 24px; }
/* Boundary must read clearly on ANY theme: no bg-tinted fill (a near-invisible
   wash on dark themes, a haze on light ones) — just a bold dashed stroke in a
   fg token so it always contrasts with the page background. Matches the
   service-map / instance-topology cluster boxes. */
.sit-grp-rect { fill: none; stroke: var(--sw-fg-3); stroke-width: 1.5; stroke-dasharray: 7 5; }
.sit-grp-name { fill: var(--sw-fg-1); font-size: 12px; font-weight: 700; }
.sit-grp-alias { fill: var(--sw-fg-3); font-size: 9px; text-transform: uppercase; letter-spacing: 0.06em; }
.sit-svg { width: 100%; height: 100%; display: block; cursor: grab; }
.sit-svg:active { cursor: grabbing; }
.sit-node { cursor: pointer; }
.node-bg { fill: var(--sw-bg-2); transition: stroke-width 0.1s ease; }
.sit-node:hover .node-bg { fill: var(--sw-bg-3); }
.node-center { fill: var(--sw-fg-0); font-size: 14px; font-weight: 700; font-family: var(--sw-mono); }
.node-unit { fill: var(--sw-fg-3); font-size: 9px; font-family: var(--sw-mono); text-transform: uppercase; letter-spacing: 0.04em; }
/* Same label treatment as the service-map node names — both canvases render
   at the same 0.79 zoom cap, so size/weight must match for the fonts to look
   identical on screen. */
.node-label { fill: var(--sw-fg-1); font-size: 16px; font-weight: 600; }
.sit-node.sel .node-label { fill: var(--sw-fg-0); font-weight: 700; }
.node-sib-glyph { fill: var(--sw-fg-1); font-size: 13px; font-weight: 700; font-family: var(--sw-mono); }
.sit-node.sibling .node-bg { fill: var(--sw-bg-1); }
.has-pop .sit-edge { opacity: 0.16; transition: opacity 0.12s ease; }
.has-pop .sit-node:not(.sel) { opacity: 0.3; transition: opacity 0.12s ease; }

/* width + max-height come from `popoverStyle` (inline) so the height bound
   can account for the toolbar header; here we only set the flex column so the
   attr list (`.np-attrs-scroll`) is the one scrollable region. */
.sit-node-pop { position: absolute; z-index: 5; display: flex; flex-direction: column; padding: 8px 10px 10px; box-shadow: 0 6px 22px rgba(0,0,0,0.4); }
.np-head { display: flex; align-items: center; gap: 6px; flex: 0 0 auto; }
.np-name { font-size: 11.5px; color: var(--sw-fg-0); flex: 1; word-break: break-all; }
/* Section label shared by Key metrics + Properties — small uppercase kicker. */
.np-section-label { flex: 0 0 auto; display: flex; align-items: center; gap: 6px; margin: 9px 1px 4px; font-size: 9px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--sw-fg-3); }
.np-count { letter-spacing: 0; font-size: 9px; color: var(--sw-fg-2); background: var(--sw-bg-1); border-radius: 7px; padding: 0 6px; }
/* Key metrics — a distinct inset card so it reads apart from the properties. */
.np-metrics { flex: 0 0 auto; }
.np-kv { display: grid; grid-template-columns: 1fr auto; gap: 4px 12px; margin: 0; padding: 7px 9px; font-size: 11px; background: var(--sw-bg-1); border: 1px solid var(--sw-line-2); border-radius: 6px; }
.np-kv dt { color: var(--sw-fg-2); }
.np-kv dd { margin: 0; color: var(--sw-fg-0); font-weight: 600; text-align: right; }
/* Properties — the scrollable region; only this grows + scrolls. */
.np-props { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; }
.np-search { flex: 0 0 auto; width: 100%; box-sizing: border-box; margin: 0 0 4px; padding: 3px 7px; font-size: 10.5px; color: var(--sw-fg-1); background: var(--sw-bg-1); border: 1px solid var(--sw-line-2); border-radius: 4px; }
.np-search:focus { outline: none; border-color: var(--sw-accent); }
/* Right padding + stable gutter so the scrollbar never overlaps the
   right-aligned attribute values. */
.np-attrs-scroll { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding-right: 12px; scrollbar-gutter: stable; }
.np-attrs-scroll::-webkit-scrollbar { width: 8px; }
.np-attrs-scroll::-webkit-scrollbar-thumb { background: var(--sw-line-2); border-radius: 4px; }
.np-empty { font-size: 10.5px; color: var(--sw-fg-3); padding: 6px 2px; }
.np-attrs { display: grid; grid-template-columns: minmax(0, auto) minmax(0, 1fr); gap: 2px 10px; margin: 0; font-size: 10.5px; }
.np-attrs dt { color: var(--sw-fg-3); overflow-wrap: anywhere; }
.np-attrs dd { margin: 0; color: var(--sw-fg-1); text-align: right; overflow-wrap: anywhere; }
/* Primary action — accent (orange in the default theme), matching the app's
   accent-button convention. */
.np-open { flex: 0 0 auto; width: 100%; justify-content: center; margin-top: 9px; }
.sit-node-pop .np-open { background: var(--sw-accent); border-color: var(--sw-accent); color: #1a1106; }
.sit-node-pop .np-open:hover { filter: brightness(1.07); }

.sit-zoom {
  position: absolute; top: 12px; right: 12px;
  display: inline-flex; align-items: center; gap: 6px;
  padding: 4px 6px; background: rgba(15, 19, 26, 0.92); backdrop-filter: blur(8px);
  border: 1px solid var(--sw-line); border-radius: 6px; z-index: 4;
}
.sit-zoom .sw-btn.small { height: 22px; min-width: 26px; padding: 0 8px; font-size: 11px; justify-content: center; }
.sit-zoom-pct { font-family: var(--sw-mono); font-size: 10.5px; color: var(--sw-fg-3); padding-left: 4px; min-width: 38px; text-align: right; }

.sit-ring-legend {
  position: absolute; left: 12px; bottom: 12px; z-index: 3;
  padding: 8px 10px; min-width: 170px; font-size: 10.5px;
  background: rgba(15, 19, 26, 0.92); backdrop-filter: blur(8px);
  border: 1px solid var(--sw-line); border-radius: 6px;
}
.sit-ring-legend .lg-title {
  font-size: 9.5px; text-transform: uppercase; letter-spacing: 0.08em;
  color: var(--sw-fg-3); margin-bottom: 4px;
}
.sit-ring-legend .lg-ramp { display: grid; grid-template-columns: repeat(4, 1fr); gap: 2px; margin-bottom: 6px; }
.sit-ring-legend .lg-ramp span { height: 8px; border-radius: 2px; display: block; }
/* Roles grid — role | metric | 3 band-edge bounds; shared column tracks so the
   colored thresholds line up vertically (config-derived, no hard-coded word). */
.sit-ring-legend .lg-roles { display: grid; grid-template-columns: auto auto repeat(3, auto); column-gap: 10px; row-gap: 3px; align-items: baseline; line-height: 1.5; }
.sit-ring-legend .lg-role-name { color: var(--sw-fg-2); font-weight: 600; }
.sit-ring-legend .lg-role-metric { color: var(--sw-fg-1); }
.sit-ring-legend .lg-b { font-family: var(--sw-mono); font-size: 9.5px; white-space: nowrap; text-align: right; }

/* Topology | Flows sub-tab strip (right of the toolbar). */
.sit-tabs { display: inline-flex; gap: 2px; padding: 2px; border: 1px solid var(--sw-line-2); border-radius: 6px; background: var(--sw-bg-2); }
.sit-tab { height: 22px; padding: 0 12px; font-size: 11px; color: var(--sw-fg-2); background: transparent; border: none; border-radius: 4px; cursor: pointer; }
.sit-tab:hover { color: var(--sw-fg-0); }
.sit-tab.active { color: var(--sw-fg-0); background: var(--sw-bg-0); font-weight: 600; }

/* Edge pill — matches the service-map edge chip (rounded bg + border, mono
   13px); the dimmer unit tspan + accent text-on-select mirror that style. */
.sit-edge-lbl { fill: var(--sw-fg-1); font-size: 13px; font-weight: 700; font-family: var(--sw-mono); }
.sit-edge-lbl.sel { fill: var(--sw-accent-2); }
.sit-edge-unit { fill: var(--sw-fg-2); font-weight: 600; }
.sit-edge-sep { fill: var(--sw-fg-3); font-weight: 600; }
.sit-edge-alias { fill: var(--sw-info); font-weight: 700; }

/* Flows — one aligned sub-table PER role-pair (a "liaison → data" group, a
   "lifecycle → data" group, …), each with its own metric columns. Rows click
   through to the topology edge. Outer scrolls vertically across groups; each
   group scrolls horizontally if its columns overflow. */
.sit-flows { min-width: 0; border: 1px solid var(--sw-line); border-radius: 6px; background: var(--sw-bg-1); overflow-y: auto; padding: 10px; }
.sit-state-inline { display: flex; align-items: center; justify-content: center; min-height: 240px; color: var(--sw-fg-3); font-size: 12px; padding: 24px; text-align: center; }
.sit-flow-groups { display: flex; flex-direction: column; gap: 14px; }
.sit-flow-group { border: 1px solid var(--sw-line); border-radius: 6px; overflow: hidden; background: var(--sw-bg-0); }
.sit-flow-group-head { display: flex; align-items: baseline; gap: 8px; padding: 6px 10px; background: var(--sw-bg-2); border-bottom: 1px solid var(--sw-line); }
.fg-pair { font-size: 11px; font-weight: 700; color: var(--sw-accent); }
.fg-count { font-size: 9.5px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--sw-fg-3); }
.sit-flow-scroll { overflow-x: auto; }
.sit-flow-table { width: 100%; border-collapse: collapse; font-size: 11px; }
.sit-flow-table th, .sit-flow-table td { padding: 5px 10px; text-align: left; white-space: nowrap; border-bottom: 1px solid var(--sw-line); }
.sit-flow-table tbody tr:last-child td { border-bottom: none; }
.sit-flow-table th { background: var(--sw-bg-1); color: var(--sw-fg-2); font-weight: 600; font-size: 9.5px; text-transform: uppercase; letter-spacing: 0.04em; }
.sit-flow-table th.fl-num, .sit-flow-table td.fl-num { text-align: right; }
.sit-flow-table .fl-unit { color: var(--sw-fg-3); text-transform: none; letter-spacing: 0; }
.sit-flow-table tbody tr { cursor: pointer; }
.sit-flow-table tbody tr:hover { background: var(--sw-bg-2); }
.sit-flow-table td.fl-ep { color: var(--sw-fg-0); max-width: 240px; overflow: hidden; text-overflow: ellipsis; }
.sit-flow-table td.fl-num { color: var(--sw-fg-1); }
.sit-flow-table td.fl-primary { color: var(--sw-fg-0); font-weight: 700; }

.sit-panel { border: 1px solid var(--sw-line); border-radius: 6px; background: var(--sw-bg-1); display: flex; flex-direction: column; min-width: 0; overflow: hidden; }
.sit-panel-head { display: flex; align-items: flex-start; gap: 8px; padding: 8px 12px; border-bottom: 1px solid var(--sw-line); flex: 0 0 auto; }
.ip-edge { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; flex: 1; font-size: 11px; color: var(--sw-fg-0); word-break: break-all; }
.ip-tags { padding: 6px 12px 0; }
.sit-panel-body { flex: 1; overflow-y: auto; padding: 10px 12px 16px; }
.ip-edge-rows { display: flex; flex-direction: column; gap: 10px; }
.ip-edge-row { border: 1px solid var(--sw-line); border-radius: 4px; padding: 6px 8px; background: var(--sw-bg-0); }
.ip-edge-row-head { display: flex; align-items: baseline; justify-content: space-between; gap: 6px; margin-bottom: 4px; }
.ip-edge-row-label { font-size: 10.5px; color: var(--sw-fg-2); }
.ip-edge-row-label .ru { color: var(--sw-fg-3); }
.ip-edge-prim {
  margin-left: 6px;
  padding: 0 5px;
  border-radius: 3px;
  font-size: 9px;
  color: var(--sw-accent);
  background: color-mix(in srgb, var(--sw-accent) 14%, transparent);
}
.ip-edge-tip { display: inline-flex; align-items: baseline; gap: 4px; font-size: 10px; font-family: var(--sw-mono); }
.ip-edge-tip .tip-tag { font-weight: 700; }
.ip-edge-tip .tip-val { color: var(--sw-fg-1); }
.ip-edge-tip .tip-sep { color: var(--sw-fg-3); }
.ip-edge-pair { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.ip-edge-cell { min-width: 0; }
.ip-edge-cell-head { display: flex; align-items: baseline; gap: 6px; margin-bottom: 2px; }
.ip-edge-cell-head .tag { font-size: 8.5px; text-transform: uppercase; letter-spacing: 0.05em; font-weight: 700; }
.ip-edge-cell-head .tag.c { color: var(--sw-info); }
.ip-edge-cell-head .tag.s { color: var(--sw-accent); }
.ip-edge-cell-head .num { font-family: var(--sw-mono); font-size: 11px; color: var(--sw-fg-0); }
.ip-edge-none, .ip-empty { color: var(--sw-fg-3); font-size: 11px; padding: 6px 0; }
.mono { font-family: var(--sw-mono); }
.sw-btn.small { height: 24px; padding: 0 10px; font-size: 11px; }
.sw-btn.ghost { background: transparent; border: 1px solid var(--sw-line-2); color: var(--sw-fg-2); cursor: pointer; }
</style>
