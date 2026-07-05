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
  Instance map — the "Instance topology" sub-tab of the per-layer Topology
  page. Renders the instance-to-instance topology between two chosen
  services as two columns (client instances | server instances).

  The service pair is URL-driven (?client=&server=): the in-toolbar
  pickers write it, and the Service-map tab's edge drill-down navigates
  here pre-filled. Pan/zoom, animated client→server flow, node popover
  (with "Open instance dashboard"), and the aligned client|server edge
  sidebar all match the service map's vocabulary.
-->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import * as d3 from 'd3';
import { useI18n } from 'vue-i18n';
import { useRoute, useRouter } from 'vue-router';
import type {
  InstanceTopologyCall,
  InstanceTopologyNode,
  LayerDef,
  TopologyMetricDef,
} from '@/api/client';
import { useInstanceTopology } from '@/layer/service-map/useInstanceTopology';
import { useLayerTopology } from '@/layer/service-map/useLayerTopology';
import { useLayerServices } from '@/layer/useLayerServices';
import { useLayers } from '@/shell/useLayers';
import { fmtMetric, fmtMetricAs, formatDuration } from '@/utils/formatters';
import { resolveServiceIdentity } from '@/utils/serviceName';
import Sparkline from '@/components/charts/Sparkline.vue';
import TypeaheadSelect from '@/components/primitives/TypeaheadSelect.vue';

// The AI chat mounts this view embedded (read-only) for a source→dest service
// pair. The props are additive + default-off: the interactive route passes none
// and stays URL-driven (?client=&server=). Embedded mode seeds the pair from
// props, keeps any in-view swap LOCAL, and NEVER navigates the app route.
const props = defineProps<{
  layerKey?: string;
  embedded?: boolean;
  /** Source (client) + destination (server) service ids to seed the pair. */
  focusClientServiceId?: string;
  focusServerServiceId?: string;
  /** Embedded look-back window (minutes); the query owns it and skips the global
   *  topbar picker + auto-refresh ticker, like the topology / deployment blocks. */
  focusWindowMinutes?: number;
}>();

const route = useRoute();
const router = useRouter();
const { t } = useI18n({ useScope: 'global' });

const embedded = computed(() => Boolean(props.embedded));
const layerKey = computed(() =>
  props.layerKey && props.layerKey.length > 0 ? props.layerKey : String(route.params.layerKey ?? ''),
);
// Embedded (chat) look-back window — threaded into BOTH the picker's layer-graph
// query and the instance-topology query so the whole block owns its own frozen
// window and nothing in it rides the global auto-refresh ticker. Embedded mode is
// chat-only here, so it ALWAYS owns a window (default 60m = the chat default) even
// if the spec omits windowMinutes — the frozen-window/ticker-skip contract can't
// be silently bypassed by an absent optional field.
const focusWindowMinutes = computed<number | null>(() =>
  embedded.value ? (props.focusWindowMinutes ?? 60) : null,
);
const { layers } = useLayers();
// Case-insensitive: layer defs key on the uppercase OAP enum, but layerKey can
// arrive lowercased (the AI chat block passes spec.layer.toLowerCase()).
const layer = computed<LayerDef | null>(() => layers.value.find((l) => l.key.toUpperCase() === layerKey.value.toUpperCase()) ?? null);
const instanceWord = computed(() => layer.value?.slots?.instances ?? 'Instances');
const serviceWord = computed(() => layer.value?.slots?.services ?? 'Services');
const instanceMapLabel = computed(() => layer.value?.slots?.instanceTopology || t('Instance map'));
// Back to the service map — the instance map is a drill-down, not a tab,
// so it carries its own return affordance. Drops the instance-only query
// (view / client / server) so the topology page lands on the service map.
function backToServiceMap(): void {
  const q = { ...route.query };
  delete q.view;
  delete q.client;
  delete q.server;
  void router.push({ path: `/layer/${layerKey.value}/topology`, query: q });
}
const namingRule = computed(() => layer.value?.naming ?? null);
function displayName(name: string | null | undefined): string {
  return resolveServiceIdentity(name, namingRule.value).display;
}

// ── Picker candidates come from the SERVICE TOPOLOGY (the call graph) —
// not just the layer roster — so they include conjectured / cross-layer
// callees (e.g. `rcmd:80`) exactly as the service map shows them, and the
// two selectors stay relationship-aware: the SERVER list is the selected
// client's callees, the CLIENT list is the selected server's callers. We
// fetch the layer-wide graph (the service map's default; usually already
// cached from the drill-down). The roster is kept only for the name
// fallback on a selection the graph hasn't loaded yet.
// Embedded blocks own a frozen window, so the roster (name fallback for the
// pickers) must not ride the global ticker either.
const roster = useLayerServices(layerKey, { rideTicker: !props.embedded });
const topoFocus = ref<string | null>(null);
const topoDepth = ref(2);
const { nodes: topoNodes, calls: topoCalls } = useLayerTopology(
  layerKey,
  topoFocus,
  topoDepth,
  focusWindowMinutes,
);

const topoNameById = computed<Map<string, string>>(() => {
  const m = new Map<string, string>();
  for (const n of topoNodes.value) m.set(n.id, n.name);
  return m;
});
/** Services related to `anchorId` along the call graph: its callees
 *  (outbound) or callers (inbound). No anchor yet ⇒ the whole graph. */
function relatedIds(anchorId: string | null, dir: 'callees' | 'callers'): string[] {
  if (!anchorId) return topoNodes.value.map((n) => n.id);
  return topoCalls.value
    .filter((c) => (dir === 'callees' ? c.source === anchorId : c.target === anchorId))
    .map((c) => (dir === 'callees' ? c.target : c.source));
}
function toOptions(ids: string[], excludeId: string | null): Array<{ value: string; label: string }> {
  const seen = new Set<string>();
  const out: Array<{ value: string; label: string }> = [];
  for (const id of ids) {
    if (!id || id === excludeId || seen.has(id)) continue;
    seen.add(id);
    out.push({ value: id, label: displayName(topoNameById.value.get(id) ?? id) });
  }
  return out;
}
// Force-add the current selection even when the graph doesn't (yet) carry
// it, so the live value always shows AND the picker never auto-resets it
// when the OTHER selector changes the option set. That injection is what
// keeps "update the other's list" from ever writing back the value the
// operator just set — both lists are pure computeds, so neither triggers
// the other.
function withCurrent(
  base: Array<{ value: string; label: string }>,
  id: string | null,
  label: string,
): Array<{ value: string; label: string }> {
  if (id && !base.some((o) => o.value === id)) {
    return [{ value: id, label: label || displayName(id) }, ...base];
  }
  return base;
}
const clientOptions = computed(() =>
  withCurrent(toOptions(relatedIds(serverId.value, 'callers'), serverId.value), clientId.value, clientName.value),
);
const serverOptions = computed(() =>
  withCurrent(toOptions(relatedIds(clientId.value, 'callees'), clientId.value), serverId.value, serverName.value),
);
function nameOf(id: string | null): string {
  if (!id) return '';
  return displayName(
    topoNameById.value.get(id) ?? roster.services.value.find((s) => s.id === id)?.name ?? id,
  );
}

// ── Service pair. On the interactive route it is URL-driven (?client=&server=)
// — the pickers + the Service-map drill-down write it and the watch mirrors it.
// Embedded mode seeds the pair from props and keeps any in-view swap LOCAL (the
// query watch is skipped, pick() writes the refs) so a chat block never touches
// the app URL.
const clientId = ref<string | null>(
  props.embedded ? (props.focusClientServiceId ?? null) : ((route.query.client as string) || null),
);
const serverId = ref<string | null>(
  props.embedded ? (props.focusServerServiceId ?? null) : ((route.query.server as string) || null),
);
watch(
  () => [route.query.client, route.query.server] as const,
  ([c, s]) => {
    if (embedded.value) return; // seeded from props; ignore the app URL
    clientId.value = (c as string) || null;
    serverId.value = (s as string) || null;
  },
);
function pick(which: 'client' | 'server', val: string): void {
  if (embedded.value) {
    // Keep the swap LOCAL — never navigate the app route from a chat block.
    if (which === 'client') clientId.value = val;
    else serverId.value = val;
    return;
  }
  void router.replace({ query: { ...route.query, view: 'instance', [which]: val } });
}

const enabled = computed(() => !!clientId.value && !!serverId.value);
const { data, nodes, calls, isFetching } = useInstanceTopology(
  layerKey,
  clientId,
  serverId,
  enabled,
  focusWindowMinutes,
);
const metricsPartial = computed(() => data.value?.metricsPartial ?? null);

// Resolve both names through the SAME layer naming rule the service map
// uses (`resolveServiceIdentity` → `display`), so the `<group>::` prefix
// is stripped here exactly as it is on the service-topology nodes — an
// edge between `agent::app` and `agent::gateway` shows `app` / `gateway`
// in both maps, not raw on one and stripped on the other.
const clientName = computed(() => displayName(data.value?.clientServiceName) || nameOf(clientId.value));
const serverName = computed(() => displayName(data.value?.serverServiceName) || nameOf(serverId.value));

const cfg = computed(() => data.value?.config ?? { nodeMetrics: [] as TopologyMetricDef[] });
function pickByRole(defs: TopologyMetricDef[], role: TopologyMetricDef['role']): TopologyMetricDef | null {
  return defs.find((d) => d.role === role) ?? null;
}
const centerDef = computed(() => pickByRole(cfg.value.nodeMetrics, 'center'));
const ringDef = computed(() => pickByRole(cfg.value.nodeMetrics, 'ring'));

function nodeVal(n: InstanceTopologyNode, def: TopologyMetricDef | null): number | null {
  return def ? (n.metrics?.[def.id] ?? null) : null;
}
function fmtVal(v: number | null, unit?: string, format?: TopologyMetricDef['format'], compact = false): string {
  if (v === null) return '—';
  if (format === 'duration') return compact ? formatDuration(v, true) : `${formatDuration(v)} ago`;
  const body = format ? fmtMetricAs(v, format) : fmtMetric(v);
  return unit ? `${body}${unit === '%' ? '' : ' '}${unit}` : body;
}
function fmtEdge(v: number | null, def: TopologyMetricDef | null): string {
  return fmtVal(v, undefined, def?.format);
}
function bandColor(value: number, th: NonNullable<TopologyMetricDef['thresholds']>): string {
  const base = th.invertBase ?? 100;
  const v = th.invertHealth ? Math.max(0, base - value) : value;
  if (v > (th.danger ?? 5)) return 'var(--sw-err)';
  if (v > (th.warn ?? 1)) return 'var(--sw-warn)';
  if (v > (th.ok ?? 0.1)) return '#fbbf24';
  return 'var(--sw-ok)';
}
function ringColor(n: InstanceTopologyNode): string {
  const def = ringDef.value;
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

// ── Ring-colour legend. Mirrors the service map: the four break-point
// labels come from the ring metric's own `thresholds` block, mapped
// back to user-space when the metric is "higher = better" (SLA / apdex /
// success rate). That keeps the green→amber→warn→red ramp reading
// correctly instead of a hard-coded error-rate scale — answering "what
// does green / red mean here?" straight from the config.
const ringScaleLabels = computed<string[]>(() => {
  const def = ringDef.value;
  if (!def) return [];
  const th = def.thresholds ?? { ok: 0.1, warn: 1, danger: 5 };
  const heuristicInvert = /sla|success|apdex/i.test(def.id) || /sla|apdex|success/i.test(def.label);
  const invert = th.invertHealth === undefined ? heuristicInvert : Boolean(th.invertHealth);
  const base = th.invertBase ?? 100;
  const ok = th.ok ?? 0.1;
  const warn = th.warn ?? 1;
  const danger = th.danger ?? 5;
  const unit = def.unit ?? '';
  const breaks = invert ? [base, base - ok, base - warn, base - danger] : [0, ok, warn, danger];
  const fmt = (n: number): string => {
    const s = Number.isInteger(n) ? n.toString() : n.toFixed(2).replace(/\.?0+$/, '');
    return `${s}${unit}`;
  };
  const out = breaks.map(fmt);
  if (out.length > 0) out[out.length - 1] = out[out.length - 1] + (invert ? '-' : '+');
  return out;
});
const ringDirectionHint = computed<string>(() => {
  const def = ringDef.value;
  if (!def) return '';
  if (def.thresholds?.invertHealth) return t('higher = better');
  if (/sla|success|apdex/i.test(def.id) || /sla|apdex|success/i.test(def.label)) return t('higher = better');
  return t('lower = better');
});

// ── Two-column layout.
const NODE_R = 26;
const ROW_GAP = 92;
const TOP = 56;
const LEFT_X = 150;
const VIEW_W = 760;
const RIGHT_X = VIEW_W - 150;
const clientNodes = computed<InstanceTopologyNode[]>(() => nodes.value.filter((n) => n.serviceId === clientId.value));
const serverNodes = computed<InstanceTopologyNode[]>(() => nodes.value.filter((n) => n.serviceId !== clientId.value));
interface Pos { cx: number; cy: number }
const pos = computed<Map<string, Pos>>(() => {
  const m = new Map<string, Pos>();
  clientNodes.value.forEach((n, i) => m.set(n.id, { cx: LEFT_X, cy: TOP + i * ROW_GAP }));
  serverNodes.value.forEach((n, i) => m.set(n.id, { cx: RIGHT_X, cy: TOP + i * ROW_GAP }));
  return m;
});
const W = VIEW_W;
const H = computed(() => {
  const rows = Math.max(1, clientNodes.value.length, serverNodes.value.length);
  return TOP + (rows - 1) * ROW_GAP + NODE_R + 36;
});
// ── Per-service grouping box (the "cluster group" container). One
// rounded box per column, headed with the service name + side, so it's
// obvious which instances belong to the client vs the server service.
// Drawn inside the zoom layer so it pans / zooms with the nodes.
interface GroupBox { side: 'client' | 'server'; name: string; role: string; x: number; y: number; w: number; h: number }
const GROUP_HEAD_H = 26;   // band above the topmost node, holds the header
const GROUP_LABEL_H = 22;  // the pod-name label rendered beneath each node
const GROUP_PAD_X = 18;
const GROUP_CHAR_W = 6.3;  // ~width of one mono char at the node-label size
function colBox(colNodes: InstanceTopologyNode[], cx: number, name: string, side: 'client' | 'server', role: string): GroupBox | null {
  if (colNodes.length === 0) return null;
  const ys = colNodes.map((n) => pos.value.get(n.id)?.cy ?? 0);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  // The box must hold the WIDER of two things, or its dashed border clips
  // one of them:
  //   - node labels (pod names), CENTRED on the column ⇒ need labelW/2 each side;
  //   - the header "<name> <instances> · <role>", LEFT-aligned from x=16 ⇒
  //     need (16 + headerW + right-pad) total. Short pod labels (e.g.
  //     `v1.0.0`) used to under-size the box and the header spilled out.
  const nodeLabelW = Math.max(NODE_R * 2, ...colNodes.map((n) => n.name.length * GROUP_CHAR_W));
  // name renders @12px bold (~7.5px/char), the role tail @9px uppercase
  // with letter-spacing (~6.2px/char), separated by the tspan's dx=8.
  const headerW = name.length * 7.5 + 8 + `${instanceWord.value} · ${role}`.length * 6.2;
  // Cap the half-width so the two columns never collide or run off-canvas
  // (LEFT_X=150 / RIGHT_X=610 / VIEW_W=760 ⇒ cap 150 keeps both inside + a gap).
  const halfW = Math.min(
    150,
    Math.max(NODE_R + 14, nodeLabelW / 2 + GROUP_PAD_X, (16 + headerW + 14) / 2),
  );
  return {
    side,
    name,
    role,
    x: cx - halfW,
    y: minY - NODE_R - GROUP_HEAD_H,
    w: halfW * 2,
    h: (maxY - minY) + NODE_R * 2 + GROUP_HEAD_H + GROUP_LABEL_H,
  };
}
const groupBoxes = computed<GroupBox[]>(() => {
  const out: GroupBox[] = [];
  const c = colBox(clientNodes.value, LEFT_X, clientName.value, 'client', t('client'));
  const s = colBox(serverNodes.value, RIGHT_X, serverName.value, 'server', t('server'));
  if (c) out.push(c);
  if (s) out.push(s);
  return out;
});

const visibleCalls = computed<InstanceTopologyCall[]>(() =>
  calls.value.filter((c) => pos.value.has(c.source) && pos.value.has(c.target)),
);
function edgePathD(c: InstanceTopologyCall): string {
  const a = pos.value.get(c.source);
  const b = pos.value.get(c.target);
  if (!a || !b) return '';
  const dir = a.cx <= b.cx ? 1 : -1;
  const x1 = a.cx + dir * NODE_R;
  const x2 = b.cx - dir * NODE_R;
  const mx = (x1 + x2) / 2;
  return `M ${x1} ${a.cy} C ${mx} ${a.cy} ${mx} ${b.cy} ${x2} ${b.cy}`;
}

const svgEl = ref<SVGSVGElement | null>(null);
const zoomLayerEl = ref<SVGGElement | null>(null);
const containerEl = ref<HTMLDivElement | null>(null);
let zoomBehaviour: d3.ZoomBehavior<SVGSVGElement, unknown> | null = null;
const zoomT = ref<{ k: number; x: number; y: number }>({ k: 1, x: 0, y: 0 });
function viewportSize(): { width: number; height: number } {
  const el = containerEl.value;
  if (!el) return { width: W, height: H.value };
  const r = el.getBoundingClientRect();
  return { width: r.width || W, height: r.height || H.value };
}
function fitToScreen(animate = true): void {
  if (!svgEl.value || !zoomBehaviour) return;
  const vp = viewportSize();
  const pad = 28;
  const fit = Math.min((vp.width - pad * 2) / W, (vp.height - pad * 2) / H.value);
  const k = Math.max(0.2, Math.min(fit, 1));
  const tx = (vp.width - W * k) / 2;
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
    .scaleExtent([0.2, 5])
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
function installZoomAndFit(): void {
  if (!svgEl.value || !zoomLayerEl.value) return;
  installZoom();
  void nextTick(() => fitToScreen(false));
}
// The <svg> lives behind a v-else and unmounts whenever a new pair's data
// is in flight (the query key changes → data drops → "Reading data…"),
// then remounts when it lands. d3.zoom listeners bind to the specific
// element, so we must re-bind on every (re)mount — a one-shot latch would
// leave drag-pan / wheel-zoom / dblclick-fit dead after the first pair
// switch (the +/−/Fit buttons would still work, masking the bug).
watch(svgEl, (el) => { if (el && zoomLayerEl.value) installZoomAndFit(); }, { flush: 'post' });
// Re-fit when the graph shape changes while the element persists (e.g.
// auto-refresh keeps the SVG mounted but the instance set shifts).
watch(
  () => `${nodes.value.length}|${visibleCalls.value.length}`,
  () => { if (svgEl.value && zoomBehaviour) void nextTick(() => fitToScreen(false)); },
);

// ── Selection (edge → sidebar, node → popover). Reset on pair change.
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
watch([clientId, serverId], () => { selectedCallId.value = null; popoverNodeId.value = null; });
const selectedCall = computed<InstanceTopologyCall | null>(() => calls.value.find((c) => c.id === selectedCallId.value) ?? null);
const popoverNode = computed<InstanceTopologyNode | null>(() => nodes.value.find((n) => n.id === popoverNodeId.value) ?? null);
function instById(id: string): InstanceTopologyNode | null {
  return nodes.value.find((n) => n.id === id) ?? null;
}
const POP_W = 210;
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
  const r = NODE_R * z.k;
  const openRight = p.cx > VIEW_W / 2;
  let left = openRight ? nx + r + 10 : nx - r - 10 - POP_W;
  left = Math.max(8, Math.min(left, cw - POP_W - 8));
  const top = Math.max(72, Math.min(ny, ch - 72));
  const style: Record<string, string> = { left: `${left}px`, top: `${top}px`, width: `${POP_W}px`, transform: 'translateY(-50%)' };
  return style;
});
// A node's service is part of THIS layer only when it's a `getAllServices`
// entry. Conjectured / cross-layer callees (e.g. `rcmd:80`, surfaced only
// because a layer service calls them) are NOT — they have no instance
// dashboard in this layer, so we don't offer to open one. The check is
// per-node, so it gates both the client and the server side.
const layerServiceIds = computed<Set<string>>(
  () => new Set(roster.services.value.map((s) => s.id)),
);
function nodeInLayer(n: InstanceTopologyNode): boolean {
  return layerServiceIds.value.has(n.serviceId);
}
function openInstanceDashboard(n: InstanceTopologyNode): void {
  if (!nodeInLayer(n)) return; // defensive — the button is hidden for these
  const href = router.resolve({
    path: `/layer/${layerKey.value}/instance`,
    query: { service: n.serviceId, instance: n.name },
  }).href;
  window.open(href, '_blank', 'noopener');
}

// ── Edge detail rows (aligned client | server) — same as the service map.
interface EdgeRow { id: string; label: string; unit: string; serverDef: TopologyMetricDef | null; clientDef: TopologyMetricDef | null }
const edgeRows = computed<EdgeRow[]>(() => {
  const map = new Map<string, EdgeRow>();
  for (const m of cfg.value.linkServerMetrics ?? []) {
    const row = map.get(m.id) ?? { id: m.id, label: m.label, unit: m.unit ?? '', serverDef: null, clientDef: null };
    row.serverDef = m;
    map.set(m.id, row);
  }
  for (const m of cfg.value.linkClientMetrics ?? []) {
    const row = map.get(m.id) ?? { id: m.id, label: m.label, unit: m.unit ?? '', serverDef: null, clientDef: null };
    row.clientDef = m;
    if (!row.label) row.label = m.label;
    if (!row.unit) row.unit = m.unit ?? '';
    map.set(m.id, row);
  }
  return [...map.values()];
});
function edgeVal(c: InstanceTopologyCall, side: 'server' | 'client', def: TopologyMetricDef | null): number | null {
  if (!def) return null;
  const b = side === 'server' ? c.serverMetrics : c.clientMetrics;
  return b?.[def.id] ?? null;
}
function edgeSeries(c: InstanceTopologyCall, side: 'server' | 'client', def: TopologyMetricDef | null): Array<number | null> {
  if (!def) return [];
  const b = side === 'server' ? c.serverMetricSeries : c.clientMetricSeries;
  return b?.[def.id] ?? [];
}
function seriesAt(arr: Array<number | null>, idx: number | null): number | null {
  if (idx === null || idx < 0 || idx >= arr.length) return null;
  return arr[idx];
}
type EdgeRowKind = 'both' | 'client-only' | 'server-only' | 'none';
function edgeRowValues(c: InstanceTopologyCall, row: EdgeRow): { kind: EdgeRowKind; clientV: number | null; serverV: number | null } {
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
function diffAt(row: EdgeRow, bucket: number | null): number | null {
  const c = selectedCall.value;
  if (bucket === null || !row.clientDef || !row.serverDef || !c) return null;
  const cv = seriesAt(edgeSeries(c, 'client', row.clientDef), bucket);
  const sv = seriesAt(edgeSeries(c, 'server', row.serverDef), bucket);
  if (cv === null || sv === null) return null;
  return sv - cv;
}
function diffColor(d: number | null): string {
  if (d === null || Math.abs(d) < 0.001) return 'var(--sw-fg-3)';
  return d > 0 ? 'var(--sw-warn)' : 'var(--sw-ok)';
}
function diffText(d: number | null): string {
  if (d === null) return '—';
  return (d >= 0 ? '+' : '') + fmtMetric(d);
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
  <div class="imv" :class="{ 'is-embedded': embedded }">
    <div class="imv-toolbar">
      <!-- The back-to-service-map affordance navigates the app route, so it is
           hidden in embedded (chat) mode — the pair pickers stay for in-view swap. -->
      <button v-if="!embedded" class="sw-btn small ghost imv-back" type="button" @click="backToServiceMap">← {{ t('Service map') }}</button>
      <span class="imv-title">{{ instanceMapLabel }}</span>
      <span class="imv-divider" />
      <span class="imv-pick-label">{{ serviceWord }}:</span>
      <!-- A picker collapses to plain text when the call graph leaves no
           real choice (e.g. the server has a single caller) — a one-option
           dropdown is just noise. Switch the other side, or use the back
           button, to reach a different pair. -->
      <TypeaheadSelect
        v-if="clientOptions.length > 1"
        :model-value="clientId"
        :options="clientOptions"
        :placeholder="t('Client service…')"
        :min-panel-width="260"
        @update:model-value="(v: string) => pick('client', v)"
      />
      <span v-else class="imv-fixed-svc mono">{{ clientName }}</span>
      <span class="imv-arrow">→</span>
      <TypeaheadSelect
        v-if="serverOptions.length > 1"
        :model-value="serverId"
        :options="serverOptions"
        :placeholder="t('Server service…')"
        :min-panel-width="260"
        @update:model-value="(v: string) => pick('server', v)"
      />
      <span v-else class="imv-fixed-svc mono">{{ serverName }}</span>
      <span v-if="isFetching" class="imv-hint">{{ t('Reading data…') }}</span>
      <div class="imv-spacer" />
      <!-- The node-metric legend is dropped in embedded (chat) mode to save the
           bounded stage's width; the in-canvas ring legend still explains colour. -->
      <div v-if="cfg.nodeMetrics.length > 0 && !embedded" class="imv-legend">
        <span v-for="def in cfg.nodeMetrics" :key="def.id" class="lg-item">
          <span class="lg-dot" :class="def.role || 'plain'" />{{ def.label }}<span v-if="def.unit" class="lg-unit"> ({{ def.unit }})</span>
        </span>
      </div>
    </div>

    <div v-if="metricsPartial" class="banner warn">{{ t('Some metrics could not be loaded ({failed} of {total} batches failed) — blank values may be unavailable, not zero.', { failed: metricsPartial.failedChunks, total: metricsPartial.totalChunks }) }}</div>

    <div class="imv-body" :class="{ 'no-selection': !selectedCall }">
      <div ref="containerEl" class="imv-canvas">
        <div v-if="showPickPrompt" class="imv-state">{{ t('Pick a client and server service to see their instance topology.') }}</div>
        <div v-else-if="showLoading" class="imv-state">{{ t('Reading data…') }}</div>
        <div v-else-if="isEmpty" class="imv-state">{{ t('No instance topology in this window.') }}</div>
        <template v-else>
          <svg ref="svgEl" class="imv-svg" width="100%" height="100%">
            <g ref="zoomLayerEl" :class="{ 'has-pop': !!popoverNodeId }">
              <g class="imv-groups">
                <g v-for="g in groupBoxes" :key="g.side" :transform="`translate(${g.x}, ${g.y})`">
                  <rect :width="g.w" :height="g.h" rx="14" ry="14" class="imv-grp-rect" />
                  <text x="16" y="18" class="imv-grp-head">
                    <tspan class="imv-grp-name mono">{{ g.name }}</tspan>
                    <tspan class="imv-grp-role" dx="8">{{ instanceWord }} · {{ g.role }}</tspan>
                  </text>
                </g>
              </g>
              <g v-for="c in visibleCalls" :key="c.id" class="imv-edge" :data-edge-id="c.id" @click.stop="selectEdge(c.id)">
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
                v-for="n in nodes" :key="n.id" class="imv-node"
                :class="{ sel: popoverNodeId === n.id }" :data-node-id="n.id"
                :transform="`translate(${pos.get(n.id)?.cx ?? 0}, ${pos.get(n.id)?.cy ?? 0})`"
                @click.stop="selectNode(n.id)"
              >
                <circle :r="NODE_R" class="node-bg" :stroke="ringColor(n)" :stroke-width="popoverNodeId === n.id ? 4 : 3" />
                <text class="node-center" text-anchor="middle" :dy="centerDef?.unit ? '-1' : '0.36em'">{{ fmtVal(nodeVal(n, centerDef), undefined, centerDef?.format, true) }}</text>
                <text v-if="centerDef?.unit" class="node-unit" text-anchor="middle" dy="12">{{ centerDef.unit }}</text>
                <text class="node-label mono" text-anchor="middle" :y="NODE_R + 15">{{ n.name }}</text>
              </g>
            </g>
          </svg>

          <div v-if="popoverNode" class="imv-node-pop sw-card" :style="popoverStyle">
            <header class="np-head">
              <span class="np-name mono">{{ popoverNode.name }}</span>
              <button class="sw-btn small ghost" type="button" @click="popoverNodeId = null">×</button>
            </header>
            <div class="np-svc mono dim">{{ displayName(popoverNode.serviceName) }}</div>
            <dl class="np-kv">
              <template v-for="def in cfg.nodeMetrics" :key="def.id">
                <dt>{{ def.label }}</dt>
                <dd class="mono">{{ fmtVal(nodeVal(popoverNode, def), def.unit, def.format) }}</dd>
              </template>
            </dl>
            <button
              v-if="nodeInLayer(popoverNode)"
              class="sw-btn small primary np-open"
              type="button"
              @click="openInstanceDashboard(popoverNode)"
            >
              {{ t('Open instance dashboard') }} ↗
            </button>
            <p v-else class="np-note">{{ t('Callee outside this layer — no instance dashboard here.') }}</p>
          </div>

          <div class="imv-zoom">
            <button class="sw-btn small" type="button" :title="t('Zoom in')" @click="zoomBy(1.25)">+</button>
            <button class="sw-btn small" type="button" :title="t('Zoom out')" @click="zoomBy(1 / 1.25)">−</button>
            <button class="sw-btn small" type="button" :title="t('Fit to screen')" @click="fitToScreen(true)">{{ t('Fit') }}</button>
          </div>

          <!-- Ring-colour ramp: what the node-circle BORDER colour means
               for the configured ring metric (green = healthy → red). The
               break labels sit at the band boundaries (read from the
               metric's thresholds), so e.g. red begins exactly at the
               configured danger value. -->
          <div v-if="ringDef" class="imv-ring-legend">
            <div class="lg-label">
              {{ t('Node ring') }} · {{ ringDef.label }}
              <span class="lg-direction">{{ ringDirectionHint }}</span>
            </div>
            <div class="lg-ramp">
              <span style="background: var(--sw-ok)" />
              <span style="background: #fbbf24" />
              <span style="background: var(--sw-warn)" />
              <span style="background: var(--sw-err)" />
            </div>
            <div class="lg-scale">
              <span v-for="(lbl, i) in ringScaleLabels" :key="i">{{ lbl }}</span>
            </div>
          </div>
        </template>
      </div>

      <aside v-if="selectedCall" class="imv-panel">
        <header class="imv-panel-head">
          <div class="ip-edge mono">
            <span>{{ instById(selectedCall.source)?.name }}</span>
            <span class="imv-arrow">→</span>
            <span>{{ instById(selectedCall.target)?.name }}</span>
          </div>
          <button class="sw-btn small ghost" type="button" @click="selectedCallId = null">×</button>
        </header>
        <div class="ip-tags">
          <span class="sw-tag">{{ selectedCall.detectPoints.join(' · ') || t('relation') }}</span>
        </div>
        <div class="imv-panel-body">
          <div v-if="edgeRows.length > 0" class="ip-edge-rows">
            <div v-for="row in edgeRows" :key="row.id" class="ip-edge-row">
              <div class="ip-edge-row-head">
                <span class="ip-edge-row-label">{{ row.label }}<span v-if="row.unit" class="ru"> ({{ row.unit }})</span></span>
                <span v-if="hoveredEdgeRowId === row.id && hoveredEdgeBucket !== null" class="ip-edge-tip">
                  <template v-if="row.clientDef"><span class="tip-tag" style="color: var(--sw-info)">C</span><span class="tip-val">{{ fmtEdge(seriesAt(edgeSeries(selectedCall, 'client', row.clientDef), hoveredEdgeBucket), row.clientDef) }}</span></template>
                  <template v-if="row.serverDef"><span class="tip-sep">·</span><span class="tip-tag" style="color: var(--sw-accent)">S</span><span class="tip-val">{{ fmtEdge(seriesAt(edgeSeries(selectedCall, 'server', row.serverDef), hoveredEdgeBucket), row.serverDef) }}</span></template>
                  <template v-if="row.clientDef && row.serverDef"><span class="tip-sep">·</span><span class="tip-tag">Δ</span><span class="tip-val" :style="{ color: diffColor(diffAt(row, hoveredEdgeBucket)) }">{{ diffText(diffAt(row, hoveredEdgeBucket)) }}</span></template>
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
                  <div class="ip-edge-cell-head"><span class="tag c">{{ t('Client') }}</span><span class="num">{{ fmtEdge(edgeRowValues(selectedCall, row).clientV, row.clientDef) }}</span><span class="side-note">{{ t('client') }}</span></div>
                  <Sparkline :values="edgeSeries(selectedCall, 'client', row.clientDef)" color="var(--sw-info)" :height="36" :stroke="1.4" fluid :crosshair-bucket="rowCrosshair(row.id)" @bucket-hover="(b: number) => onEdgeBucketHover(row.id, b)" @bucket-leave="onEdgeBucketLeave" />
                </div>
              </template>
              <template v-else-if="edgeRowValues(selectedCall, row).kind === 'server-only'">
                <div class="ip-edge-cell">
                  <div class="ip-edge-cell-head"><span class="tag s">{{ t('Server') }}</span><span class="num">{{ fmtEdge(edgeRowValues(selectedCall, row).serverV, row.serverDef) }}</span><span class="side-note">{{ t('server') }}</span></div>
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
.imv { display: flex; flex-direction: column; gap: 10px; height: 100%; min-height: 0; }
.imv-toolbar {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  padding: 8px 10px; border: 1px solid var(--sw-line); border-radius: 6px; background: var(--sw-bg-1);
}
.imv-back { flex: 0 0 auto; }
.imv-title { font-size: 12px; font-weight: 700; color: var(--sw-fg-0); }
.imv-divider { width: 1px; height: 18px; background: var(--sw-line-2); margin: 0 2px; }
.imv-pick-label { font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--sw-fg-3); }
.imv-fixed-svc {
  font-size: 12px; color: var(--sw-fg-1);
  padding: 4px 9px; border-radius: 5px;
  border: 1px solid var(--sw-line); background: var(--sw-bg-2);
}
.imv-arrow { color: var(--sw-accent); font-weight: 700; }
.imv-hint { font-size: 10.5px; color: var(--sw-fg-3); }
.imv-spacer { flex: 1; }
.imv-legend { display: flex; gap: 14px; align-items: center; }
.lg-item { display: inline-flex; align-items: center; gap: 5px; font-size: 10px; color: var(--sw-fg-2); }
.lg-dot { width: 11px; height: 11px; border-radius: 50%; flex: 0 0 auto; }
.lg-dot.center { background: var(--sw-bg-3); border: 1.5px solid var(--sw-fg-1); }
.lg-dot.ring { background: transparent; border: 2px solid var(--sw-fg-2); }
.lg-dot.secondary { width: 8px; height: 8px; background: var(--sw-fg-3); }
.lg-dot.lineServer, .lg-dot.lineClient, .lg-dot.plain { width: 8px; height: 8px; background: var(--sw-fg-3); border-radius: 2px; }
.lg-unit { color: var(--sw-fg-3); }

.imv-body { flex: 1; min-height: 0; display: grid; grid-template-columns: 1fr 380px; gap: 10px; }
.imv-body.no-selection { grid-template-columns: 1fr; }
/* Embedded (chat): a 380px detail column would crush the canvas at a narrow chat
   width, so keep the body single-column and float the edge panel as an overlay
   drawer over the graph — the click-edge-for-detail interaction is preserved. */
.imv.is-embedded .imv-body { grid-template-columns: 1fr; position: relative; }
.imv.is-embedded .imv-panel {
  position: absolute; inset: 0 0 0 auto; width: min(340px, 85%); z-index: 6;
  box-shadow: -8px 0 22px rgba(0, 0, 0, 0.4);
}
/* Drop the 420px canvas floor in embedded: in a narrow chat drawer the toolbar
   wraps and would push the canvas past the bounded stage, clipping the bottom-
   anchored zoom controls + ring legend. Let the canvas fit the stage instead
   (fit-to-screen + zoom handle a smaller graph). */
.imv.is-embedded .imv-canvas { min-height: 0; }
.imv-canvas {
  position: relative; overflow: hidden; min-width: 0; min-height: 420px;
  border: 1px solid var(--sw-line); border-radius: 6px;
  background: radial-gradient(circle at center, var(--sw-bg-1) 0%, var(--sw-bg-0) 100%);
}
.imv-state { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: var(--sw-fg-3); font-size: 12px; text-align: center; padding: 24px; }
.imv-grp-rect { fill: none; stroke: var(--sw-fg-3); stroke-width: 1.5; stroke-dasharray: 7 5; }
.imv-grp-name { fill: var(--sw-fg-1); font-size: 12px; font-weight: 700; }
.imv-grp-role { fill: var(--sw-fg-3); font-size: 9px; text-transform: uppercase; letter-spacing: 0.06em; }
.imv-svg { width: 100%; height: 100%; display: block; cursor: grab; }
.imv-svg:active { cursor: grabbing; }
.imv-node { cursor: pointer; }
.node-bg { fill: var(--sw-bg-2); transition: stroke-width 0.1s ease; }
.imv-node:hover .node-bg { fill: var(--sw-bg-3); }
.node-center { fill: var(--sw-fg-0); font-size: 12px; font-weight: 700; font-family: var(--sw-mono); }
.node-unit { fill: var(--sw-fg-3); font-size: 8px; font-family: var(--sw-mono); text-transform: uppercase; letter-spacing: 0.04em; }
.node-label { fill: var(--sw-fg-2); font-size: 10.5px; }
.has-pop .imv-edge { opacity: 0.16; transition: opacity 0.12s ease; }
.has-pop .imv-node:not(.sel) { opacity: 0.3; transition: opacity 0.12s ease; }

.imv-node-pop { position: absolute; z-index: 5; padding: 8px 10px 10px; box-shadow: 0 6px 22px rgba(0,0,0,0.4); }
.np-head { display: flex; align-items: center; gap: 6px; }
.np-name { font-size: 11.5px; color: var(--sw-fg-0); flex: 1; word-break: break-all; }
.np-svc { font-size: 10px; margin-top: 2px; word-break: break-all; }
.np-kv { display: grid; grid-template-columns: 1fr auto; gap: 3px 10px; margin: 8px 0; font-size: 11px; }
.np-kv dt { color: var(--sw-fg-3); }
.np-kv dd { margin: 0; color: var(--sw-fg-1); text-align: right; }
.np-open { width: 100%; justify-content: center; }
.np-note { margin: 6px 0 0; font-size: 10.5px; line-height: 1.4; color: var(--sw-fg-3); }

.imv-zoom { position: absolute; right: 12px; bottom: 12px; display: flex; flex-direction: column; gap: 4px; z-index: 3; }
.imv-zoom .sw-btn.small { width: 28px; height: 26px; padding: 0; justify-content: center; }

.imv-ring-legend {
  position: absolute; left: 12px; bottom: 12px; z-index: 3;
  padding: 8px 10px; min-width: 170px; font-size: 10.5px;
  background: rgba(15, 19, 26, 0.92); backdrop-filter: blur(8px);
  border: 1px solid var(--sw-line); border-radius: 6px;
}
.imv-ring-legend .lg-label {
  font-size: 9.5px; text-transform: uppercase; letter-spacing: 0.08em;
  color: var(--sw-fg-3); margin-bottom: 4px; display: flex; align-items: baseline; gap: 6px;
}
.imv-ring-legend .lg-direction {
  font-size: 9px; letter-spacing: 0.04em; text-transform: none;
  color: var(--sw-fg-3); font-style: italic; opacity: 0.85;
}
/* Ramp + scale share one 4-column grid so every break label sits at its
 * band's left (healthy) edge — the boundary between two swatches — instead
 * of drifting across a wider row. So `95%-` lands exactly where red starts. */
.imv-ring-legend .lg-ramp { display: grid; grid-template-columns: repeat(4, 1fr); gap: 2px; margin-bottom: 3px; }
.imv-ring-legend .lg-ramp span { height: 8px; border-radius: 2px; display: block; }
.imv-ring-legend .lg-scale { display: grid; grid-template-columns: repeat(4, 1fr); color: var(--sw-fg-3); font-size: 9px; }
.imv-ring-legend .lg-scale span { text-align: left; }

.imv-panel { border: 1px solid var(--sw-line); border-radius: 6px; background: var(--sw-bg-1); display: flex; flex-direction: column; min-width: 0; overflow: hidden; }
.imv-panel-head { display: flex; align-items: flex-start; gap: 8px; padding: 8px 12px; border-bottom: 1px solid var(--sw-line); flex: 0 0 auto; }
.ip-edge { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; flex: 1; font-size: 11px; color: var(--sw-fg-0); word-break: break-all; }
.ip-tags { padding: 6px 12px 0; }
.imv-panel-body { flex: 1; overflow-y: auto; padding: 10px 12px 16px; }
.ip-edge-rows { display: flex; flex-direction: column; gap: 10px; }
.ip-edge-row { border: 1px solid var(--sw-line); border-radius: 4px; padding: 6px 8px; background: var(--sw-bg-0); }
.ip-edge-row-head { display: flex; align-items: baseline; justify-content: space-between; gap: 6px; margin-bottom: 4px; }
.ip-edge-row-label { font-size: 10.5px; color: var(--sw-fg-2); }
.ip-edge-row-label .ru { color: var(--sw-fg-3); }
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
.ip-edge-cell-head .side-note { font-size: 8.5px; color: var(--sw-fg-3); margin-left: auto; }
.ip-edge-none, .ip-empty { color: var(--sw-fg-3); font-size: 11px; padding: 6px 0; }
.dim { color: var(--sw-fg-3); }
.mono { font-family: var(--sw-mono); }
.sw-btn.small { height: 24px; padding: 0 10px; font-size: 11px; }
.sw-btn.ghost { background: transparent; border: 1px solid var(--sw-line-2); color: var(--sw-fg-2); cursor: pointer; }
.banner.warn { padding: 8px 12px; background: var(--sw-warn-soft); border: 1px solid var(--sw-warn); border-radius: 6px; color: var(--sw-warn); font-size: 11.5px; }
</style>
