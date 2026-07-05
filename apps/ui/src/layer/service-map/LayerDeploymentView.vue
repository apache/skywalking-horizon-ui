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
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
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
import {
  MAIN_R,
  BOX_HEAD_BAND,
  BOX_PAD_TOP,
  BOX_PAD_BOTTOM,
  clusterBoxX,
  computeLayout,
  type Pos,
  type ClusterRect,
  type Layout,
  type Pod,
  type ClusterBucket,
} from '@/layer/service-map/useDeploymentLayout';
import { useDeploymentPanZoom } from '@/layer/service-map/useDeploymentPanZoom';
import DeploymentFlowsTable, { type FlowGroup } from '@/layer/service-map/DeploymentFlowsTable.vue';
import DeploymentEdgePanel, { type EdgeRow } from '@/layer/service-map/DeploymentEdgePanel.vue';
import DeploymentNodePopover from '@/layer/service-map/DeploymentNodePopover.vue';
import { useSelectedService } from '@/layer/useSelectedService';
import { useLayers } from '@/shell/useLayers';
import { fmtMetric, fmtMetricAs, formatDuration } from '@/utils/formatters';
import { resolveServiceIdentity } from '@/utils/serviceName';

// The AI chat mounts this view embedded (read-only, focused on one service). The
// props are additive + default-off: the interactive route passes none and keeps
// reading the route param + the shell header's useSelectedService store. Embedded
// mode drives the layer/service from props and NEVER writes the shared store.
const props = defineProps<{
  layerKey?: string;
  embedded?: boolean;
  /** Focus service id (embedded): drives the deployment query directly. */
  focusServiceId?: string;
  /** Embedded look-back window (minutes); the query owns it and skips the global
   *  topbar picker + auto-refresh ticker, like the topology block. */
  focusWindowMinutes?: number;
}>();

const route = useRoute();
const router = useRouter();
const { t } = useI18n({ useScope: 'global' });

const { layers } = useLayers();
const embedded = computed(() => Boolean(props.embedded));
const layerKey = computed(() =>
  props.layerKey && props.layerKey.length > 0 ? props.layerKey : String(route.params.layerKey ?? ''),
);
const layer = computed<LayerDef | null>(
  () => layers.value.find((l) => l.key.toUpperCase() === layerKey.value.toUpperCase()) ?? null,
);
const instanceWord = computed(() => layer.value?.slots?.instances ?? 'Instances');
const title = computed(() => layer.value?.slots?.deployment || t('Deployment'));
const namingRule = computed(() => layer.value?.naming ?? null);
function displayServiceName(name: string | null | undefined): string {
  return resolveServiceIdentity(name, namingRule.value).display;
}

// ── Selected service comes from the shell header (useSelectedService) on the
// interactive route — this view owns no service picker. Embedded (chat) mode
// drives it from focusServiceId and never touches the shared store.
const { selectedId: headerSelectedId } = useSelectedService();
const selectedId = computed<string | null>(() =>
  embedded.value ? (props.focusServiceId ?? null) : headerSelectedId.value,
);
const enabled = computed(() => !!selectedId.value);
// Embedded mode is chat-only, so it ALWAYS owns a frozen window (default 60m)
// even if the spec omits windowMinutes — never silently rides the global ticker.
const focusWindowMinutes = computed<number | null>(() =>
  embedded.value ? (props.focusWindowMinutes ?? 60) : null,
);
const { data, nodes, calls, isFetching } = useDeployment(layerKey, selectedId, enabled, focusWindowMinutes);
const serviceName = computed(() => displayServiceName(data.value?.serviceName) || '');
const metricsPartial = computed(() => data.value?.metricsPartial ?? null);

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

// ── Layout: the pure packer lives in useDeploymentLayout (rankPods Tarjan-SCC
// + Kahn ranking, clusterBoxX, computeLayout). Here we only supply the live
// header-width measurement (depends on the reactive cluster alias + instance
// word) and thread the reactive cluster/call data through.

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

const layout = computed<Layout>(() =>
  computeLayout(clusters.value, calls.value, !!clusterBy.value, clusterHeaderMinW),
);
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
// Embedded (chat) mode uses a fixed, bounded stage so a focused graph fills its
// block; fit-to-screen + the zoom controls handle exploration (like the topology
// block). The interactive route sizes to the graph, clamped + scaled up.
const canvasHeightPx = computed<number>(() =>
  embedded.value
    ? 460
    : Math.round(Math.max(CARD_MIN, Math.min(CARD_MAX, H.value + 80)) * HEIGHT_SCALE),
);
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
    const box = clusterBoxX(minX, maxX, cl.label, clusterHeaderMinW);
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

// ── Pan + zoom (same lifecycle as the instance map) — owned by the composable.
// The dataset-identity signal folds in selectedId so a service switch that
// lands on cached data with identical counts still re-keys every v-for node
// element (which kills the per-element d3 drag listeners) → rebind + refit.
const svgEl = ref<SVGSVGElement | null>(null);
const zoomLayerEl = ref<SVGGElement | null>(null);
const containerEl = ref<HTMLDivElement | null>(null);
const datasetKey = computed(
  () => `${selectedId.value}|${nodes.value.length}|${visibleCalls.value.length}|${clusters.value.length}`,
);
const { zoomT, fitToScreen, zoomBy } = useDeploymentPanZoom({
  svgEl,
  zoomLayerEl,
  containerEl,
  W,
  H,
  nodeToPod,
  podDelta,
  datasetKey,
});

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
// The rows + their value/series accessors are built here (config-aware) and
// handed to DeploymentEdgePanel, which owns the crosshair-hover state.
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
// at least the '*' fallback. The grid itself lives in DeploymentFlowsTable.
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
  <div class="sit" :class="{ 'is-embedded': embedded }">
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

    <div v-if="metricsPartial" class="banner warn">
      {{ t('Some metrics could not be loaded ({failed} of {total} batches failed) — blank values may be unavailable, not zero.', { failed: metricsPartial.failedChunks, total: metricsPartial.totalChunks }) }}
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

          <DeploymentNodePopover
            v-if="popoverNode"
            :node="popoverNode"
            :popover-style="popoverStyle"
            :metric-defs-for="metricDefsFor"
            :node-val="nodeVal"
            :fmt-val="fmtVal"
            @close="popoverNodeId = null"
            @open-dashboard="openInstanceDashboard"
          />

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

      <DeploymentFlowsTable
        v-if="mapTab === 'flows'"
        :show-pick-prompt="showPickPrompt"
        :flow-groups="flowGroups"
        :min-height-px="canvasHeightPx"
        :inst-by-id="instById"
        :flow-cell="flowCell"
        :primary-ids="primaryIds"
        @select-edge="selectEdgeFromFlows"
      />

      <DeploymentEdgePanel
        v-if="selectedCall && mapTab === 'topology'"
        :selected-call="selectedCall"
        :edge-rows="edgeRows"
        :selected-primary-ids="selectedPrimaryIds"
        :inst-by-id="instById"
        :edge-row-values="edgeRowValues"
        :edge-series="edgeSeries"
        :fmt-edge="fmtEdge"
        :series-at="seriesAt"
        @close="selectedCallId = null"
      />
    </div>
  </div>
</template>

<style scoped>
.sit { display: flex; flex-direction: column; gap: 10px; height: 100%; min-height: 0; }
/* Embedded (chat) mode: the block is content-sized, so the canvas' explicit
   pixel height drives layout — a height:100% flex column would collapse here. */
.sit.is-embedded { height: auto; }
.banner.warn { padding: 8px 12px; background: var(--sw-warn-soft); border: 1px solid var(--sw-warn); border-radius: 6px; color: var(--sw-warn); font-size: 11.5px; }
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
/* Embedded (chat): a 380px detail column would crush the canvas at a narrow chat
   width, so keep the body single-column and float the edge panel as an overlay
   drawer over the graph — the click-edge-for-detail interaction is preserved. */
.sit.is-embedded .sit-body { grid-template-columns: 1fr; position: relative; }
.sit.is-embedded .sit-panel {
  position: absolute; inset: 0 0 0 auto; width: min(340px, 85%); z-index: 6;
  box-shadow: -8px 0 22px rgba(0, 0, 0, 0.4);
}
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

.mono { font-family: var(--sw-mono); }
.sw-btn.small { height: 24px; padding: 0 10px; font-size: 11px; }
.sw-btn.ghost { background: transparent; border: 1px solid var(--sw-line-2); color: var(--sw-fg-2); cursor: pointer; }
</style>
