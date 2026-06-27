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
  Service-map detail sidebar — node panel on top, edge panel underneath.
  Node and edge selections are INDEPENDENT (the owner keeps both refs);
  the two cards stay open in parallel so the operator can compare a
  service's metrics against the call edge's metrics in one glance. Empty
  slots prompt for the missing side. Edges DO NOT open a dashboard page —
  metrics live here and on the canvas, that's the full extent of edge
  drill-in.
-->
<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type {
  TopologyCall,
  TopologyConfig,
  TopologyMetricDef,
} from '@/api/client';
import type { ServiceNamingRule } from '@skywalking-horizon-ui/api-client';
import type { LayoutNode } from '@/layer/service-map/useTopologyLayout';
import {
  resolveServiceIdentity,
  type ServiceIdentity,
} from '@/utils/serviceName';
import { fmtMetric } from '@/utils/formatters';
import Sparkline from '@/components/charts/Sparkline.vue';

const props = defineProps<{
  selectedNode: LayoutNode | null;
  selectedCall: TopologyCall | null;
  selectedCallSource: LayoutNode | null;
  selectedCallTarget: LayoutNode | null;
  calls: TopologyCall[];
  layoutNodes: LayoutNode[];
  cfg: TopologyConfig;
  ringDef: TopologyMetricDef | null;
  centerDef: TopologyMetricDef | null;
  secondaryDef: TopologyMetricDef | null;
  namingRule: ServiceNamingRule | null;
  showLegacyGroup: boolean;
  canDrillInstance: boolean;
}>();
const emit = defineEmits<{
  clearNode: [];
  clearCall: [];
  jumpToService: [];
  jumpToEndpointDependency: [];
  openInstanceTopology: [];
}>();

const { t } = useI18n({ useScope: 'global' });

function identity(name: string | null | undefined): ServiceIdentity {
  return resolveServiceIdentity(name, props.namingRule);
}

function nodeVal(n: LayoutNode, def: TopologyMetricDef | null): number | null {
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
function ringColor(n: LayoutNode): string {
  const def = props.ringDef;
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

// ── Synced crosshair across the client + server sparklines of one
// edge-metric row. Hovering either chart drives a hairline + dot on BOTH
// charts; a small tooltip surfaces the per-bucket values plus the
// client/server diff. Single-row scope: only one row can be hovered at a
// time. ----------------------------------------------------------------
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
  if (bucket === null || !row.clientDef || !row.serverDef || !props.selectedCall) return null;
  const c = seriesAt(edgeSeries(props.selectedCall, 'client', row.clientDef), bucket);
  const s = seriesAt(edgeSeries(props.selectedCall, 'server', row.serverDef), bucket);
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

// Convention used across the detail panel: the call CHAIN is read from
// the selected service outward.
//   - `upstream`   = services the selected service depends on (calls flow
//                    OUTBOUND: sel → X).
//   - `downstream` = services that call the selected service (calls flow
//                    INBOUND: X → sel).
// This matches the user's mental model: "something calling current
// service ⇒ downstream".
const upstream = computed<LayoutNode[]>(() => {
  const sel = props.selectedNode;
  if (!sel) return [];
  const ids = new Set(props.calls.filter((c) => c.source === sel.id).map((c) => c.target));
  return props.layoutNodes.filter((n) => ids.has(n.id));
});
const downstream = computed<LayoutNode[]>(() => {
  const sel = props.selectedNode;
  if (!sel) return [];
  const ids = new Set(props.calls.filter((c) => c.target === sel.id).map((c) => c.source));
  return props.layoutNodes.filter((n) => ids.has(n.id));
});

/**
 * Sub-bucket a related-services list (upstream / downstream) by the
 * identity group of each row. When the layer has a topology-cluster rule
 * the reader can scan namespace-by-namespace; otherwise everything
 * collapses to a single null-key bucket and renders unchanged. The output
 * preserves the natural BFS order within each bucket and orders buckets
 * by first appearance.
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
 * Build a row per metric for the edge-detail sidebar. We pair up the
 * server + client metric defs by `id`, so a metric defined on only one
 * side renders as that side only. The row always carries the label + unit
 * so the y-axis stays aligned across rows.
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
  for (const m of props.cfg.linkServerMetrics ?? []) {
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
  for (const m of props.cfg.linkClientMetrics ?? []) {
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
 * availability, not just metric-def presence: an edge with only a server
 * reading collapses to `server-only`, even though both metric defs exist
 * on the layer config.
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

/**
 * Render a metric label for the edge-panel card. Suppresses the unit
 * suffix when the operator-set label and unit are the same word (e.g.
 * label="RPM", unit="rpm" → just "RPM"). Units are always UPPERCASE.
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
  <!-- Right sidebar — node panel on top, edge panel underneath. Both
       selections are independent so the two stay open in parallel; empty
       slots prompt the operator to pick the missing side. -->
  <aside class="sm-panels">
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
        <button class="sw-btn small" type="button" @click="emit('clearNode')">×</button>
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
        <button class="sw-btn small primary" type="button" @click="emit('jumpToService')">Open service</button>
        <button class="sw-btn small" type="button" @click="emit('jumpToEndpointDependency')">API map →</button>
      </div>
    </article>

    <!-- Top-slot placeholder when only an edge is selected — keeps the
         layout balanced. -->
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
            @click="emit('openInstanceTopology')"
          >{{ t('Instance map') }} →</button>
          <button class="sw-btn small" type="button" @click="emit('clearCall')">×</button>
        </div>
      </header>
      <!-- Edge line metrics — one card per metric. Inside, client and
           server cells sit SIDE-BY-SIDE and each sparkline stretches via
           `fluid` to fill its cell. -->
      <div class="sp-section">
        <div class="sp-section-title">Line metrics</div>
        <div v-if="edgeRows.length > 0" class="sp-edge-rows">
          <div v-for="row in edgeRows" :key="row.id" class="sp-edge-row-card">
            <div class="sp-edge-row-head">
              <span class="sp-edge-row-label">{{ formatRowLabel(row) }}</span>
              <!-- Hover tooltip — at-bucket values + diff. -->
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

    <!-- Bottom-slot placeholder when only a node is selected. -->
    <article
      v-if="selectedNode && !(selectedCall && selectedCallSource && selectedCallTarget)"
      class="sm-panel sm-panel-empty"
    >
      <span>Click an edge to inspect a call</span>
    </article>
  </aside>
</template>

<style scoped>
.sm-panels {
  /* The whole sidebar is one scroll container. Each panel sizes to its
     content (upstream / downstream lists are dynamic, so a fixed 50/50
     split makes one panel too tall and the other too short). When total
     content exceeds the card height, the box scrolls as a single unit. */
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
  /* Empty prompts stay compact so they don't push the populated panel
     out of view. */
  min-height: 64px;
  flex: 0 0 auto;
}
.sp-edge-row {
  /* Block-level (not inline-flex) so it fills `.sp-id`'s column and wraps
     WITHIN it — inline-flex shrink-to-fit let long source→target names
     overflow rightward under the header action buttons. */
  display: flex;
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
/* `<alias · value>` chip layout — the dimension label (e.g. `namespace`)
   reads as a subdued prefix and the value pops in accent colour. */
.sw-tag .tag-alias {
  opacity: 0.7;
  font-weight: 500;
  margin-right: 4px;
}
.sw-tag .tag-alias::after { content: '·'; margin-left: 4px; }
.sw-tag .tag-val { font-family: var(--sw-mono); font-weight: 600; }
/* Edge line-metric cards. One card per metric, two sparkline cells per
   card (client | server). */
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
/* Crosshair hover tooltip (per edge-metric row). Compact inline chip at
   the right side of the row head showing the value at the hovered bucket
   on each side plus the diff (Δ = server − client). */
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
/* Inside an edge cell the Sparkline should fill the cell — the `fluid`
   prop on the component sets svg width=100% but the parent must allow
   shrinking, hence `min-width: 0` above. */
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
</style>
