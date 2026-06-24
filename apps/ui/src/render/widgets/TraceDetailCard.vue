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
  Shared trace-detail card. The full SkyWalking-native trace detail
  used by BOTH the per-layer Traces tab and the cross-layer Trace
  inspect view. Given a flat NativeSpan[] it renders:
    • a header — trace-id (a select when the segment spans more than
      one trace id), copy-id / copy-url buttons, the
      Default / Tree / Statistics view toggle, and a × close,
    • KPIs (started / duration / spans / services),
    • a per-service colour legend,
    • the Default service-striped waterfall (kind glyph + component
      icon + name band with a start/duration bar + depth guides),
    • the Tree view (d3 horizontal hierarchical layout, wheel/drag
      zoom + explicit +/-/⊙ controls),
    • the Statistics view (per-span-name roll-up, sortable),
    • a span-detail modal opened by clicking a row / tree node.

  The card owns its own view-mode, sort, zoom, span-modal and
  copy-flash state — callers only feed the trace + emit the close.

  Props:
    spans     — the flat NativeSpan[] of the resolved trace.
    traceId   — the active trace id (drives the header label + url copy).
    traceIds  — every trace id carried by the selected segment; >1
                renders the trace-id select.
    loading   — show a "loading…" hint in the header while detail fetches.

  Emits:
    close            — the × was clicked.
    change-trace-id  — a different id was picked from the multi-id select.
    update:modalOpen — the span-detail modal opened / closed. Hosts use
                       this to order their own Esc cascade (close the
                       modal first, then the inline detail).
-->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import * as d3 from 'd3';
import type { NativeSpan, TraceAttachedEvent, TraceLogEntry } from '@/api/client';
import { useTracePopout } from '@/layer/traces/useTracePopout';
import { componentIconOrNull } from '@/layer/service-map/useTopologyIcons';
import { fmtMetric } from '@/utils/formatters';

const { t } = useI18n({ useScope: 'global' });

const props = withDefaults(
  defineProps<{
    spans: NativeSpan[];
    traceId: string | null;
    traceIds: string[];
    loading?: boolean;
  }>(),
  { loading: false },
);
const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'change-trace-id', id: string): void;
  (e: 'update:modalOpen', open: boolean): void;
}>();
/** Public method so a host can close the span-detail modal as the
 *  first step of its own Esc cascade. */
function closeSpanModal(): void { openSpan.value = null; }
defineExpose({ closeSpanModal });

const { openTrace } = useTracePopout();

const nativeSpans = computed<NativeSpan[]>(() => props.spans);

// ── Copy id / shareable url ───────────────────────────────────────
const copyFlash = ref<'id' | 'url' | null>(null);
let copyFlashTimer: ReturnType<typeof setTimeout> | null = null;
function flashCopy(kind: 'id' | 'url'): void {
  copyFlash.value = kind;
  if (copyFlashTimer) clearTimeout(copyFlashTimer);
  copyFlashTimer = setTimeout(() => { copyFlash.value = null; }, 1400);
}
function copyTraceId(): void {
  if (!props.traceId) return;
  navigator.clipboard?.writeText(props.traceId).then(() => flashCopy('id'), () => {});
}
function copyShareableUrl(): void {
  if (!props.traceId) return;
  // Compose a URL with `?traceId=<id>` so anyone with the link gets
  // the popout cold-load experience.
  const url = new URL(window.location.href);
  url.searchParams.set('traceId', props.traceId);
  // Tag the source so Trace inspect (one route, two sources) reopens it as
  // native rather than Zipkin.
  url.searchParams.set('source', 'native');
  navigator.clipboard?.writeText(url.toString()).then(() => flashCopy('url'), () => {});
}
onBeforeUnmount(() => { if (copyFlashTimer) clearTimeout(copyFlashTimer); });

// ── View mode ─────────────────────────────────────────────────────
type ViewMode = 'default' | 'tree' | 'statistics';
const viewMode = ref<ViewMode>('default');

// ── Statistics sort ───────────────────────────────────────────────
type StatSortKey = 'total' | 'avg' | 'max';
const statSortKey = ref<StatSortKey>('total');
const statSortDir = ref<'asc' | 'desc'>('desc');
function toggleStatSort(key: StatSortKey): void {
  if (statSortKey.value === key) {
    statSortDir.value = statSortDir.value === 'desc' ? 'asc' : 'desc';
  } else {
    statSortKey.value = key;
    statSortDir.value = 'desc';
  }
}

// ── Service color palette ─────────────────────────────────────────
const SERVICE_PALETTE = [
  'var(--sw-accent)', 'var(--sw-info)', 'var(--sw-cyan)', 'var(--sw-purple)',
  'var(--sw-ok)', 'var(--sw-warn)', 'var(--sw-pink)',
  '#a78bfa', '#fb7185', '#34d399', '#fbbf24', '#60a5fa',
];
function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0);
}
const serviceColors = computed<Map<string, string>>(() => {
  const m = new Map<string, string>();
  for (const s of nativeSpans.value) {
    if (!m.has(s.serviceCode)) {
      m.set(s.serviceCode, SERVICE_PALETTE[hashString(s.serviceCode) % SERVICE_PALETTE.length]);
    }
  }
  return m;
});
function serviceColor(c: string): string {
  return serviceColors.value.get(c) ?? 'var(--sw-fg-2)';
}
function kindColor(type: string | null | undefined): string {
  const k = (type ?? '').toUpperCase();
  if (k.includes('SERVER') || k === 'ENTRY') return 'var(--sw-accent)';
  if (k.includes('CLIENT') || k === 'EXIT') return 'var(--sw-info)';
  if (k === 'LOCAL') return 'var(--sw-purple)';
  if (k.includes('PRODUCER') || k.includes('CONSUMER')) return 'var(--sw-purple)';
  if (k.includes('DATABASE') || k.includes('SQL') || k.includes('CACHE')) return 'var(--sw-cyan)';
  return 'var(--sw-fg-2)';
}
/**
 * Span-kind family — Entry, Local, Exit, plus the GraphQL-spelled
 * Server/Client/Producer/Consumer set. Drives the inline SVG glyph.
 */
type KindFamily = 'entry' | 'local' | 'exit' | 'server' | 'client' | 'producer' | 'consumer' | 'other';
function kindFamily(type: string | null | undefined): KindFamily {
  const k = (type ?? '').toUpperCase();
  if (k === 'ENTRY' || k.includes('SERVER')) return 'entry';
  if (k === 'EXIT' || k.includes('CLIENT')) return 'exit';
  if (k === 'LOCAL') return 'local';
  if (k.includes('PRODUCER')) return 'producer';
  if (k.includes('CONSUMER')) return 'consumer';
  return 'other';
}

// ── Render helpers ────────────────────────────────────────────────
function fmtMs(v: number | null | undefined): string {
  if (v === null || v === undefined) return '—';
  return `${fmtMetric(v)} ms`;
}
function fmtDateTime(ts: number | null | undefined): string {
  if (!ts || !Number.isFinite(ts)) return '—';
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function fmtAttachedTs(at: { seconds: number; nanos: number }): string {
  const ms = at.seconds * 1000 + at.nanos / 1_000_000;
  return fmtDateTime(ms) + '.' + String(at.nanos).padStart(9, '0').slice(0, 6);
}
/**
 * Latency-band color for tree nodes. Cool-to-warm gradient topping
 * out at the accent orange — red is reserved for actual error states
 * (isError === true), not slow successful spans.
 */
function latencyColor(durationMs: number): string {
  if (durationMs >= 1000) return 'var(--sw-accent)';
  if (durationMs >= 500) return 'var(--sw-warn)';
  if (durationMs >= 100) return 'var(--sw-info)';
  return 'var(--sw-ok)';
}
function nativeSpanError(s: NativeSpan): boolean { return s.isError; }

// ── Native waterfall ──────────────────────────────────────────────
interface WaterfallRow {
  span: NativeSpan;
  depth: number;
  startOffset: number;
  duration: number;
}
const nativeWaterfall = computed<WaterfallRow[]>(() => {
  const spans = nativeSpans.value;
  if (spans.length === 0) return [];
  const minStart = Math.min(...spans.map((s) => s.startTime));
  const key = (segId: string, spanId: number) => `${segId}/${spanId}`;
  const byKey = new Map(spans.map((s) => [key(s.segmentId, s.spanId), s]));
  const childMap = new Map<string, NativeSpan[]>();
  const roots: NativeSpan[] = [];
  // Resolve parent: intra-segment via parentSpanId, cross-segment via
  // any of the span's refs. If no resolvable parent is in the response,
  // the span becomes a root (orphan -> depth 0).
  function resolveParentKey(s: NativeSpan): string | null {
    if (s.parentSpanId !== -1) {
      const k = key(s.segmentId, s.parentSpanId);
      return byKey.has(k) ? k : null;
    }
    for (const r of s.refs ?? []) {
      const k = key(r.parentSegmentId, r.parentSpanId);
      if (byKey.has(k)) return k;
    }
    return null;
  }
  for (const s of spans) {
    const parentKey = resolveParentKey(s);
    if (parentKey) {
      const arr = childMap.get(parentKey) ?? [];
      arr.push(s);
      childMap.set(parentKey, arr);
    } else {
      roots.push(s);
    }
  }
  const out: WaterfallRow[] = [];
  function walk(s: NativeSpan, depth: number): void {
    const childKey = key(s.segmentId, s.spanId);
    const children = childMap.get(childKey) ?? [];
    out.push({
      span: s,
      depth,
      startOffset: s.startTime - minStart,
      duration: Math.max(0, s.endTime - s.startTime),
    });
    for (const c of children) walk(c, depth + 1);
  }
  for (const r of roots) walk(r, 0);
  return out;
});
const nativeWaterfallDuration = computed(() => {
  const rows = nativeWaterfall.value;
  if (rows.length === 0) return 0;
  return Math.max(...rows.map((r) => r.startOffset + r.duration));
});
const nativeRootStart = computed(() => {
  const spans = nativeSpans.value;
  return spans.length > 0 ? Math.min(...spans.map((s) => s.startTime)) : null;
});

// ── Tree view — d3 horizontal hierarchical layout ─────────────────
interface TreeNode {
  span: NativeSpan;
  x: number; // horizontal coord (left-to-right)
  y: number; // vertical coord
  parent: TreeNode | null;
}
interface TreeLink {
  parent: TreeNode;
  child: TreeNode;
  d: string;
}
interface TreeLayout {
  nodes: TreeNode[];
  links: TreeLink[];
  width: number;
  height: number;
}
const NODE_W = 180;
/** Card height — three rows: service code, span name, latency. */
const NODE_H = 54;
const NODE_GAP_X = 80;
const NODE_GAP_Y = 14;
const nativeTreeLayout = computed<TreeLayout>(() => {
  const spans = nativeSpans.value;
  if (spans.length === 0) return { nodes: [], links: [], width: 0, height: 0 };
  const key = (segId: string, spanId: number) => `${segId}/${spanId}`;
  const byKey = new Map(spans.map((s) => [key(s.segmentId, s.spanId), s]));
  const childMap = new Map<string, NativeSpan[]>();
  const roots: NativeSpan[] = [];
  function resolveParentKey(s: NativeSpan): string | null {
    if (s.parentSpanId !== -1) {
      const k = key(s.segmentId, s.parentSpanId);
      return byKey.has(k) ? k : null;
    }
    for (const r of s.refs ?? []) {
      const k = key(r.parentSegmentId, r.parentSpanId);
      if (byKey.has(k)) return k;
    }
    return null;
  }
  for (const s of spans) {
    const parentKey = resolveParentKey(s);
    if (parentKey) {
      const arr = childMap.get(parentKey) ?? [];
      arr.push(s);
      childMap.set(parentKey, arr);
    } else {
      roots.push(s);
    }
  }
  interface Datum { span: NativeSpan; children: Datum[]; }
  function build(s: NativeSpan): Datum {
    const k = key(s.segmentId, s.spanId);
    const kids = childMap.get(k) ?? [];
    return { span: s, children: kids.map(build) };
  }
  // Multiple roots → wrap them in a synthetic root so the d3 layout
  // treats them as siblings. The synthetic root is filtered out at
  // render time.
  const synthRoot: Datum = roots.length === 1
    ? build(roots[0])
    : {
        span: { segmentId: '__synth__', spanId: -1 } as NativeSpan,
        children: roots.map(build),
      };
  const hierarchy = d3.hierarchy<Datum>(synthRoot, (d) => d.children);
  const layout = d3.tree<Datum>().nodeSize([NODE_H + NODE_GAP_Y, NODE_W + NODE_GAP_X])(hierarchy);
  // d3.tree() produces y for depth and x for sibling. For a
  // left-to-right tree we use d.y as horizontal and d.x as vertical.
  const nodes: TreeNode[] = [];
  const nodeMap = new Map<string, TreeNode>();
  let minY = Infinity;
  let maxY = -Infinity;
  let maxX = 0;
  layout.descendants().forEach((d) => {
    if (d.data.span.segmentId === '__synth__') return;
    const tn: TreeNode = { span: d.data.span, x: d.y, y: d.x, parent: null };
    nodes.push(tn);
    nodeMap.set(key(tn.span.segmentId, tn.span.spanId), tn);
    if (tn.y < minY) minY = tn.y;
    if (tn.y > maxY) maxY = tn.y;
    if (tn.x > maxX) maxX = tn.x;
  });
  // Re-anchor so the layout starts at (0, 0).
  const offsetX = nodes.length > 0 ? Math.min(...nodes.map((n) => n.x)) : 0;
  for (const n of nodes) {
    n.x -= offsetX;
    n.y -= minY;
  }
  const links: TreeLink[] = [];
  layout.descendants().forEach((d) => {
    if (!d.parent) return;
    if (d.parent.data.span.segmentId === '__synth__') return;
    if (d.data.span.segmentId === '__synth__') return;
    const child = nodeMap.get(key(d.data.span.segmentId, d.data.span.spanId));
    const parent = nodeMap.get(key(d.parent.data.span.segmentId, d.parent.data.span.spanId));
    if (!child || !parent) return;
    child.parent = parent;
    const x1 = parent.x + NODE_W;
    const y1 = parent.y + NODE_H / 2;
    const x2 = child.x;
    const y2 = child.y + NODE_H / 2;
    const midX = (x1 + x2) / 2;
    const d_ = `M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}`;
    links.push({ parent, child, d: d_ });
  });
  return {
    nodes,
    links,
    width: maxX - offsetX + NODE_W + 20,
    height: maxY - minY + NODE_H + 20,
  };
});

// ── Tree-view zoom/pan ────────────────────────────────────────────
// d3.zoom drives wheel + drag. Programmatic +/-/⊙ buttons call the
// same behaviour so the transform stays consistent. Re-bound whenever
// the SVG element changes so drag-pan keeps working after re-renders.
const treeSvgEl = ref<SVGSVGElement | null>(null);
const treeTransform = ref<{ x: number; y: number; k: number }>({ x: 0, y: 0, k: 1 });
let treeZoomBehavior: ReturnType<typeof d3.zoom<SVGSVGElement, unknown>> | null = null;
let treeZoomBoundEl: SVGSVGElement | null = null;
function ensureTreeZoom(): void {
  const el = treeSvgEl.value;
  if (!el) return;
  if (treeZoomBoundEl === el && treeZoomBehavior) return;
  if (treeZoomBoundEl) {
    d3.select(treeZoomBoundEl).on('.zoom', null);
  }
  treeZoomBehavior = d3.zoom<SVGSVGElement, unknown>()
    .scaleExtent([0.2, 4])
    .on('zoom', (ev) => {
      treeTransform.value = { x: ev.transform.x, y: ev.transform.y, k: ev.transform.k };
    });
  d3.select(el).call(treeZoomBehavior);
  treeZoomBoundEl = el;
}
function treeZoomBy(factor: number): void {
  const el = treeSvgEl.value;
  if (!el || !treeZoomBehavior) return;
  d3.select(el).transition().duration(180).call(treeZoomBehavior.scaleBy, factor);
}
function treeZoomReset(): void {
  const el = treeSvgEl.value;
  if (!el || !treeZoomBehavior) return;
  d3.select(el).transition().duration(180).call(treeZoomBehavior.transform, d3.zoomIdentity);
  treeTransform.value = { x: 0, y: 0, k: 1 };
}
onBeforeUnmount(() => {
  if (treeZoomBoundEl) d3.select(treeZoomBoundEl).on('.zoom', null);
  treeZoomBoundEl = null;
  treeZoomBehavior = null;
});
// Auto-attach d3.zoom when the Tree view becomes active and its SVG
// mounts. Re-attach on viewMode change so a hidden-then-shown tree
// picks the new SVG ref.
watch([viewMode, treeSvgEl], async ([m]) => {
  if (m === 'tree') {
    await nextTick();
    ensureTreeZoom();
  }
});

// ── Statistics view ───────────────────────────────────────────────
// Grouped by SPAN NAME (endpointName when set, else component/peer).
interface StatRow {
  name: string;
  service: string;
  count: number;
  total: number;
  avg: number;
  max: number;
  components: Array<{ name: string; count: number }>;
}
function spanGroupName(s: NativeSpan): string {
  return s.endpointName || s.component || s.peer || '—';
}
const nativeStats = computed<StatRow[]>(() => {
  const spans = nativeSpans.value;
  const groups = new Map<string, {
    service: string;
    name: string;
    durations: number[];
    componentCounts: Map<string, number>;
  }>();
  for (const s of spans) {
    const name = spanGroupName(s);
    const k = `${s.serviceCode}/${name}`;
    const g = groups.get(k) ?? {
      service: s.serviceCode,
      name,
      durations: [],
      componentCounts: new Map<string, number>(),
    };
    g.durations.push(Math.max(0, s.endTime - s.startTime));
    if (s.component) {
      g.componentCounts.set(s.component, (g.componentCounts.get(s.component) ?? 0) + 1);
    }
    groups.set(k, g);
  }
  const rows: StatRow[] = Array.from(groups.values()).map((g) => {
    const total = g.durations.reduce((a, b) => a + b, 0);
    const components = Array.from(g.componentCounts.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 3);
    return {
      service: g.service,
      name: g.name,
      count: g.durations.length,
      total,
      avg: total / g.durations.length,
      max: Math.max(...g.durations),
      components,
    };
  });
  const k = statSortKey.value;
  const dir = statSortDir.value === 'asc' ? 1 : -1;
  rows.sort((a, b) => (a[k] - b[k]) * dir);
  return rows;
});

// ── Span detail modal ─────────────────────────────────────────────
// The modal's open/close is surfaced to the host (`update:modalOpen`)
// so the host owns the single Esc cascade (modal first, then inline
// detail) — avoiding two competing capture-phase window listeners.
const openSpan = ref<NativeSpan | null>(null);
function openNativeSpan(s: NativeSpan): void { openSpan.value = s; }
function closeSpan(): void { openSpan.value = null; }
watch(openSpan, (s) => emit('update:modalOpen', !!s));
</script>

<template>
  <article class="tr-detail sw-card">
    <header class="tr-detail-head">
      <div class="tr-detail-title">
        <span class="dim">{{ t('trace') }}</span>
        <select v-if="traceIds.length > 1" :value="traceId ?? ''" class="trace-id-select mono" @change="emit('change-trace-id', ($event.target as HTMLSelectElement).value)">
          <option v-for="id in traceIds" :key="id" :value="id">{{ id }}</option>
        </select>
        <span v-else class="mono trace-id-text" :title="traceId ?? ''">{{ traceId }}</span>
        <button class="sw-btn small ghost copy-btn" type="button" :title="t('Copy trace id')" @click="copyTraceId">⧉ {{ t('id') }}</button>
        <button class="sw-btn small ghost copy-btn" type="button" :title="t('Copy shareable URL')" @click="copyShareableUrl">⧉ {{ t('url') }}</button>
        <transition name="copy-flash">
          <span v-if="copyFlash" class="copy-flash-chip">{{ copyFlash === 'url' ? t('url copied') : t('id copied') }}</span>
        </transition>
      </div>
      <div class="tr-detail-tools">
        <span v-if="loading" class="hint">{{ t('loading…') }}</span>
        <div class="view-toggle">
          <button :class="['vt-btn', { on: viewMode === 'default' }]" type="button" @click="viewMode = 'default'">{{ t('Default') }}</button>
          <button :class="['vt-btn', { on: viewMode === 'tree' }]" type="button" @click="viewMode = 'tree'">{{ t('Tree') }}</button>
          <button :class="['vt-btn', { on: viewMode === 'statistics' }]" type="button" @click="viewMode = 'statistics'">{{ t('Statistics') }}</button>
        </div>
        <button class="sw-btn small ghost" type="button" :title="t('Back to list')" @click="emit('close')">×</button>
      </div>
    </header>

    <div class="tr-kpis">
      <div><div class="kpi-label">{{ t('started') }}</div><div class="kpi-val">{{ fmtDateTime(nativeRootStart) }}</div></div>
      <div><div class="kpi-label">{{ t('duration') }}</div><div class="kpi-val">{{ fmtMs(nativeWaterfallDuration) }}</div></div>
      <div><div class="kpi-label">{{ t('spans') }}</div><div class="kpi-val">{{ nativeWaterfall.length }}</div></div>
      <div><div class="kpi-label">{{ t('services') }}</div><div class="kpi-val">{{ serviceColors.size }}</div></div>
    </div>

    <div v-if="serviceColors.size > 0" class="tr-svc-legend">
      <span v-for="[code, color] in serviceColors" :key="code" class="svc-chip">
        <span class="svc-swatch" :style="{ background: color }" />
        <span class="mono">{{ code }}</span>
      </span>
    </div>

    <!-- Default view — single combined row. Each row has the
         service-coloured stripe, status flag + kind glyph + component
         icon, a name band carrying the span name + peer with the
         start/duration bar as the band's BACKGROUND, and the duration
         as a suffix. Service code is colour-only — no text. -->
    <template v-if="viewMode === 'default'">
      <div v-if="nativeWaterfall.length === 0" class="tr-empty">{{ t('no span data') }}</div>
      <div v-else class="tr-default-list">
        <div
          v-for="row in nativeWaterfall"
          :key="`${row.span.segmentId}/${row.span.spanId}`"
          class="tr-default-row"
          :class="{ err: row.span.isError }"
          @click="openNativeSpan(row.span)"
        >
          <span class="svc-stripe" :style="{ background: serviceColor(row.span.serviceCode) }" />
          <span
            class="status-flag sm"
            :class="row.span.isError ? 'flag-err' : 'flag-ok'"
            :title="row.span.isError ? t('Span errored') : t('Span OK')"
          ><span class="flag-dot" /></span>
          <!-- Inline kind glyph: → (entry), ← (exit), ◯ (local),
               speech-bubble (producer/consumer), generic (other). -->
          <svg
            class="kind-glyph"
            viewBox="0 0 14 14"
            :style="{ color: kindColor(row.span.type) }"
            :aria-label="row.span.type || t('span')"
            :title="row.span.type || ''"
          >
            <template v-if="kindFamily(row.span.type) === 'entry'">
              <path d="M1 7 L9 7 M6 4 L9 7 L6 10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
              <line x1="11.5" y1="3" x2="11.5" y2="11" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
            </template>
            <template v-else-if="kindFamily(row.span.type) === 'exit'">
              <line x1="2.5" y1="3" x2="2.5" y2="11" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
              <path d="M5 7 L13 7 M10 4 L13 7 L10 10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
            </template>
            <template v-else-if="kindFamily(row.span.type) === 'local'">
              <circle cx="7" cy="7" r="4" fill="none" stroke="currentColor" stroke-width="1.6" />
              <circle cx="7" cy="7" r="1.4" fill="currentColor" />
            </template>
            <template v-else-if="kindFamily(row.span.type) === 'producer'">
              <path d="M2 4 L11 4 L11 9 L7 9 L4 11.5 L4 9 L2 9 Z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" />
              <path d="M9 7 L12.5 7 M11 5.5 L12.5 7 L11 8.5" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" />
            </template>
            <template v-else-if="kindFamily(row.span.type) === 'consumer'">
              <path d="M12 4 L3 4 L3 9 L7 9 L10 11.5 L10 9 L12 9 Z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" />
              <path d="M5 7 L1.5 7 M3 5.5 L1.5 7 L3 8.5" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" />
            </template>
            <template v-else>
              <rect x="2.5" y="2.5" width="9" height="9" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.4" />
              <circle cx="7" cy="7" r="1.6" fill="currentColor" />
            </template>
          </svg>
          <img
            v-if="componentIconOrNull(row.span.component)"
            class="comp-icon"
            :src="componentIconOrNull(row.span.component) ?? ''"
            :alt="row.span.component || ''"
            :title="row.span.component || ''"
          />
          <svg
            v-else
            class="comp-icon comp-icon-generic"
            viewBox="0 0 18 18"
            :aria-label="row.span.component || t('generic span')"
          >
            <rect x="3" y="4.5" width="12" height="3" rx="1.5" fill="currentColor" opacity="0.45" />
            <rect x="5" y="10.5" width="10" height="3" rx="1.5" fill="currentColor" opacity="0.85" />
          </svg>
          <!-- Name band — the bar is rendered as the band's background
               (absolute), so its left+width encode the span's
               start+duration on the trace timeline. Depth indent is
               rendered as faint vertical guide lines AND a flex
               spacer that shifts the text right. -->
          <div class="tr-name-band">
            <span
              class="tr-name-band-bg"
              :style="{
                left: nativeWaterfallDuration > 0 ? (row.startOffset / nativeWaterfallDuration * 100) + '%' : '0%',
                width: nativeWaterfallDuration > 0 ? Math.max(0.8, row.duration / nativeWaterfallDuration * 100) + '%' : '0%',
                background: serviceColor(row.span.serviceCode),
                outlineColor: row.span.isError ? 'var(--sw-err)' : 'transparent',
              }"
            />
            <span
              v-for="g in row.depth"
              :key="g"
              class="tr-depth-guide"
              :style="{ left: (g - 1) * 22 + 10 + 'px' }"
            />
            <span class="tr-name-indent" :style="{ width: row.depth * 22 + 'px' }" />
            <span
              class="tr-name mono"
              :title="row.span.endpointName || row.span.component || row.span.peer || '—'"
            >{{ row.span.endpointName || row.span.component || row.span.peer || '—' }}</span>
            <span
              v-if="row.span.peer"
              class="tr-peer mono"
              :title="t('peer · {peer}', { peer: row.span.peer })"
            >→ {{ row.span.peer }}</span>
            <span
              v-if="row.span.attachedEvents && row.span.attachedEvents.length > 0"
              class="evt-badge"
              :title="t('{n} attached events', { n: row.span.attachedEvents.length })"
            >
              <span class="evt-flag">⚑</span>
              <span class="evt-count">{{ row.span.attachedEvents.length }}</span>
            </span>
          </div>
          <span class="tr-row-dur mono">{{ fmtMs(row.duration) }}</span>
        </div>
      </div>
    </template>

    <!-- Tree view — d3 horizontal flowing tree. Root left, children
         to the right; cards joined by Bezier paths. Click a card to
         open the span detail modal. Wheel-zoom + drag-pan via
         d3.zoom; explicit +/-/⊙ controls top-right. -->
    <template v-else-if="viewMode === 'tree'">
      <div v-if="nativeTreeLayout.nodes.length === 0" class="tr-empty">{{ t('no span data') }}</div>
      <div v-else class="tr-tree-canvas">
        <div class="tree-zoom-ctrls">
          <button class="sw-btn small ghost" type="button" :title="t('Zoom in')" @click="treeZoomBy(1.25)">+</button>
          <button class="sw-btn small ghost" type="button" :title="t('Zoom out')" @click="treeZoomBy(1 / 1.25)">−</button>
          <button class="sw-btn small ghost" type="button" :title="t('Reset')" @click="treeZoomReset">⊙</button>
          <span class="zoom-pct mono">{{ Math.round(treeTransform.k * 100) }}%</span>
        </div>
        <svg
          ref="treeSvgEl"
          class="tree-svg"
          width="100%"
          height="100%"
          :viewBox="`0 0 ${nativeTreeLayout.width} ${nativeTreeLayout.height}`"
          preserveAspectRatio="xMidYMid meet"
        >
          <g :transform="`translate(${treeTransform.x}, ${treeTransform.y}) scale(${treeTransform.k})`">
          <path
            v-for="(lnk, i) in nativeTreeLayout.links"
            :key="`l${i}`"
            :d="lnk.d"
            class="tree-link"
            fill="none"
            stroke="var(--sw-fg-3)"
            stroke-width="1.4"
          />
          <g
            v-for="n in nativeTreeLayout.nodes"
            :key="`${n.span.segmentId}/${n.span.spanId}`"
            :transform="`translate(${n.x}, ${n.y})`"
            class="tree-node"
            :class="{ err: n.span.isError }"
            @click="openNativeSpan(n.span)"
          >
            <!-- Base plate: subtle dark fill + service-coloured
                 border so the card reads as a "container". -->
            <rect
              :width="NODE_W"
              :height="NODE_H"
              rx="4"
              fill="var(--sw-bg-2)"
              fill-opacity="0.7"
              :stroke="n.span.isError ? 'var(--sw-err)' : serviceColor(n.span.serviceCode)"
              stroke-width="1.6"
            />
            <!-- Progress fill: width proportional to this span's
                 latency vs the trace's total duration. -->
            <clipPath :id="`tree-clip-${n.span.segmentId}-${n.span.spanId}`">
              <rect :width="NODE_W" :height="NODE_H" rx="4" />
            </clipPath>
            <rect
              :clip-path="`url(#tree-clip-${n.span.segmentId}-${n.span.spanId})`"
              :width="nativeWaterfallDuration > 0
                ? Math.max(2, ((n.span.endTime - n.span.startTime) / nativeWaterfallDuration) * NODE_W)
                : 0"
              :height="NODE_H"
              :fill="latencyColor(n.span.endTime - n.span.startTime)"
              fill-opacity="0.42"
            />
            <foreignObject :x="0" :y="0" :width="NODE_W" :height="NODE_H">
              <div
                xmlns="http://www.w3.org/1999/xhtml"
                class="tree-node-body"
              >
                <span
                  class="status-flag sm"
                  :class="n.span.isError ? 'flag-err' : 'flag-ok'"
                ><span class="flag-dot" /></span>
                <img
                  v-if="componentIconOrNull(n.span.component)"
                  class="comp-icon"
                  :src="componentIconOrNull(n.span.component) ?? ''"
                  :alt="n.span.component || ''"
                />
                <svg
                  v-else
                  class="comp-icon comp-icon-generic"
                  viewBox="0 0 18 18"
                  :aria-label="n.span.component || t('generic span')"
                >
                  <rect x="3" y="4.5" width="12" height="3" rx="1.5" fill="currentColor" opacity="0.45" />
                  <rect x="5" y="10.5" width="10" height="3" rx="1.5" fill="currentColor" opacity="0.85" />
                </svg>
                <span class="tree-node-text mono">
                  <span class="tree-node-svc" :style="{ color: serviceColor(n.span.serviceCode) }">{{ n.span.serviceCode }}</span>
                  <span class="tree-node-name" :title="n.span.endpointName || n.span.component || n.span.peer || '—'">{{ n.span.endpointName || n.span.component || n.span.peer || '—' }}</span>
                  <span
                    class="tree-node-lat-text"
                    :style="{ color: latencyColor(n.span.endTime - n.span.startTime) }"
                  >{{ fmtMs(n.span.endTime - n.span.startTime) }}</span>
                </span>
              </div>
            </foreignObject>
          </g>
          </g>
        </svg>
      </div>
    </template>

    <!-- Statistics — grouped by SPAN NAME + service, sortable on
         Total / Avg / Max. Components aggregated per group; top-3
         icons render in a single cell. -->
    <template v-else>
      <div v-if="nativeStats.length === 0" class="tr-empty">{{ t('no span data') }}</div>
      <table v-else class="tr-table">
        <thead>
          <tr>
            <th class="endpoint-col">{{ t('Span name') }}</th>
            <th>{{ t('Service') }}</th>
            <th>{{ t('Components') }}</th>
            <th class="num">{{ t('Count') }}</th>
            <th
              class="num sortable"
              :class="{ on: statSortKey === 'total' }"
              @click="toggleStatSort('total')"
            >
              {{ t('Total') }}
              <span class="sort-ind">{{ statSortKey === 'total' ? (statSortDir === 'desc' ? '↓' : '↑') : '↕' }}</span>
            </th>
            <th
              class="num sortable"
              :class="{ on: statSortKey === 'avg' }"
              @click="toggleStatSort('avg')"
            >
              {{ t('Avg') }}
              <span class="sort-ind">{{ statSortKey === 'avg' ? (statSortDir === 'desc' ? '↓' : '↑') : '↕' }}</span>
            </th>
            <th
              class="num sortable"
              :class="{ on: statSortKey === 'max' }"
              @click="toggleStatSort('max')"
            >
              {{ t('Max') }}
              <span class="sort-ind">{{ statSortKey === 'max' ? (statSortDir === 'desc' ? '↓' : '↑') : '↕' }}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(r, i) in nativeStats" :key="i">
            <td class="mono endpoint-col" :title="r.name">{{ r.name }}</td>
            <td class="mono" :style="{ color: serviceColor(r.service) }" :title="r.service">
              <span class="svc-swatch inline" :style="{ background: serviceColor(r.service) }" />
              {{ r.service }}
            </td>
            <td>
              <span v-if="r.components.length === 0" class="dim">—</span>
              <span v-else class="stat-comp-stack">
                <span
                  v-for="(c, ci) in r.components"
                  :key="ci"
                  class="stat-comp"
                  :title="t('{name} · {count}', { name: c.name, count: c.count })"
                >
                  <img
                    v-if="componentIconOrNull(c.name)"
                    class="comp-icon"
                    :src="componentIconOrNull(c.name) ?? ''"
                    :alt="c.name"
                  />
                  <svg v-else class="comp-icon comp-icon-generic" viewBox="0 0 18 18">
                    <rect x="3" y="4.5" width="12" height="3" rx="1.5" fill="currentColor" opacity="0.45" />
                    <rect x="5" y="10.5" width="10" height="3" rx="1.5" fill="currentColor" opacity="0.85" />
                  </svg>
                  <span class="mono dim">×{{ c.count }}</span>
                </span>
              </span>
            </td>
            <td class="num mono">{{ r.count }}</td>
            <td class="num mono">{{ fmtMs(r.total) }}</td>
            <td class="num mono">{{ fmtMs(r.avg) }}</td>
            <td class="num mono">{{ fmtMs(r.max) }}</td>
          </tr>
        </tbody>
      </table>
    </template>
  </article>

  <!-- Span detail modal. Cross-trace refs route through openTrace()
       → the global popout. -->
  <div v-if="openSpan" class="span-modal-backdrop" @click.self="closeSpan">
    <article class="span-modal sw-card">
      <header class="span-modal-head">
        <h4>
          <span class="dim">{{ t('Span detail') }}</span>
          <span class="mono">{{ openSpan.endpointName || '—' }}</span>
        </h4>
        <button class="sw-btn small ghost" type="button" @click="closeSpan">×</button>
      </header>
      <div class="span-modal-body">
        <section class="sd-section">
          <h5>{{ t('Meta') }}</h5>
          <dl class="kv">
            <dt>{{ t('Service') }}</dt>
            <dd class="mono" :style="{ color: serviceColor(openSpan.serviceCode) }">
              <span class="svc-swatch inline" :style="{ background: serviceColor(openSpan.serviceCode) }" />
              {{ openSpan.serviceCode }}
            </dd>
            <dt>{{ t('Instance') }}</dt><dd class="mono">{{ openSpan.serviceInstanceName }}</dd>
            <dt>{{ t('Endpoint') }}</dt><dd class="mono">{{ openSpan.endpointName || '—' }}</dd>
            <dt>{{ t('Kind') }}</dt><dd><span class="tr-kind" :style="{ color: kindColor(openSpan.type) }">{{ openSpan.type }}</span></dd>
            <dt>{{ t('Component') }}</dt><dd class="mono">{{ openSpan.component || '—' }}</dd>
            <dt>{{ t('Peer') }}</dt><dd class="mono">{{ openSpan.peer || '—' }}</dd>
            <dt>{{ t('Layer') }}</dt><dd class="mono dim">{{ openSpan.layer || '—' }}</dd>
            <dt>{{ t('Start') }}</dt><dd class="mono">{{ fmtDateTime(openSpan.startTime) }}</dd>
            <dt>{{ t('Duration') }}</dt><dd class="mono">{{ fmtMs(openSpan.endTime - openSpan.startTime) }}</dd>
            <dt>{{ t('Error') }}</dt><dd><span class="status-flag" :class="nativeSpanError(openSpan) ? 'flag-err' : 'flag-ok'"><span class="flag-dot" />{{ nativeSpanError(openSpan) ? t('true') : t('false') }}</span></dd>
          </dl>
        </section>
        <section
          v-if="(openSpan.refs ?? []).some((r) => r.traceId !== traceId)"
          class="sd-section"
        >
          <h5>{{ t('Cross-trace refs') }}</h5>
          <table class="kv-table">
            <thead><tr><th>{{ t('Trace ID') }}</th><th>{{ t('Parent segment') }}</th><th class="num">{{ t('Parent span') }}</th><th>{{ t('Ref type') }}</th></tr></thead>
            <tbody>
              <template v-for="(r, i) in openSpan.refs" :key="i">
                <tr v-if="r.traceId !== traceId">
                  <td>
                    <button class="trace-link mono" type="button" @click="openTrace(r.traceId)">{{ r.traceId }} ↗</button>
                  </td>
                  <td class="mono dim">{{ r.parentSegmentId }}</td>
                  <td class="num mono">{{ r.parentSpanId }}</td>
                  <td class="mono dim">{{ r.type }}</td>
                </tr>
              </template>
            </tbody>
          </table>
        </section>
        <section v-if="openSpan.tags && openSpan.tags.length > 0" class="sd-section">
          <h5>{{ t('Tags') }}</h5>
          <dl class="kv">
            <template v-for="(tag, i) in openSpan.tags" :key="i">
              <dt class="mono">{{ tag.key }}</dt>
              <dd class="mono wba">{{ tag.value }}</dd>
            </template>
          </dl>
        </section>
        <section v-if="openSpan.logs && openSpan.logs.length > 0" class="sd-section">
          <h5>{{ t('Logs') }}</h5>
          <div v-for="(log, i) in (openSpan.logs as TraceLogEntry[])" :key="i" class="span-log">
            <div class="span-log-time mono dim">{{ fmtDateTime(log.time) }}</div>
            <dl class="kv">
              <template v-for="(d, j) in log.data" :key="j">
                <dt class="mono">{{ d.key }}</dt>
                <dd><pre class="mono pre wba">{{ d.value }}</pre></dd>
              </template>
            </dl>
          </div>
        </section>
        <section v-if="openSpan.attachedEvents && openSpan.attachedEvents.length > 0" class="sd-section">
          <h5>{{ t('Attached Events') }}</h5>
          <div v-for="(ev, i) in (openSpan.attachedEvents as TraceAttachedEvent[])" :key="i" class="span-event">
            <div class="span-event-head">
              <span class="mono">{{ ev.event }}</span>
              <span class="dim mono">{{ fmtAttachedTs(ev.startTime) }} → {{ fmtAttachedTs(ev.endTime) }}</span>
            </div>
            <dl v-if="ev.summary && ev.summary.length > 0" class="kv">
              <template v-for="(s, j) in ev.summary" :key="`s${j}`">
                <dt class="mono">{{ s.key }}</dt>
                <dd class="mono wba">{{ s.value }}</dd>
              </template>
            </dl>
            <dl v-if="ev.tags && ev.tags.length > 0" class="kv">
              <template v-for="(tag, j) in ev.tags" :key="`t${j}`">
                <dt class="mono dim">{{ t('tag') }} · {{ tag.key }}</dt>
                <dd class="mono wba">{{ tag.value }}</dd>
              </template>
            </dl>
          </div>
        </section>
      </div>
    </article>
  </div>
</template>

<style scoped>
.tr-empty { padding: 24px; text-align: center; color: var(--sw-fg-3); font-size: 11.5px; }
.hint { font-size: 10.5px; color: var(--sw-fg-3); }
.mono { font-family: var(--sw-mono); }
.dim { color: var(--sw-fg-3); }
.wba { word-break: break-all; }

.sw-btn.small { height: 24px; padding: 0 10px; font-size: 11px; }
.sw-btn.ghost { background: transparent; border: 1px solid var(--sw-line-2); color: var(--sw-fg-2); }

/* Detail card — height adapts to content. */
.tr-detail {
  padding: 0;
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.tr-detail-head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--sw-line);
  flex-wrap: wrap;
  flex: 0 0 auto;
}
.tr-detail-title { display: flex; align-items: center; gap: 8px; flex: 1; min-width: 0; }
.tr-detail-title .dim { font-size: 12px; font-weight: 500; color: var(--sw-fg-3); }
.tr-detail-title .mono { font-family: var(--sw-mono); color: var(--sw-fg-1); font-size: 12px; }
.trace-id-text {
  max-width: 320px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.trace-id-select {
  height: 24px;
  padding: 0 6px;
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line-2);
  border-radius: 4px;
  color: var(--sw-fg-1);
  font-family: var(--sw-mono);
  font-size: 11px;
  min-width: 320px;
}
.tr-detail-tools { display: flex; align-items: center; gap: 10px; }
.view-toggle {
  display: inline-flex;
  border: 1px solid var(--sw-line-2);
  border-radius: 4px;
  overflow: hidden;
  background: var(--sw-bg-2);
}
.vt-btn {
  background: transparent;
  border: none;
  color: var(--sw-fg-2);
  padding: 0 10px;
  height: 24px;
  font-size: 11px;
  cursor: pointer;
  border-right: 1px solid var(--sw-line-2);
}
.vt-btn:last-child { border-right: none; }
.vt-btn:hover { background: var(--sw-bg-3); }
.vt-btn.on { background: var(--sw-accent); color: var(--sw-bg-0); font-weight: 600; }

.tr-kpis {
  display: flex;
  gap: 28px;
  padding: 8px 14px;
  border-bottom: 1px solid var(--sw-line);
  flex: 0 0 auto;
}
.kpi-label {
  font-size: 9.5px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--sw-fg-3);
}
.kpi-val {
  font-family: var(--sw-mono);
  font-size: 14px;
  color: var(--sw-fg-0);
  font-weight: 700;
}
.tr-svc-legend {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  padding: 6px 14px;
  border-bottom: 1px solid var(--sw-line);
  background: var(--sw-bg-1);
  flex: 0 0 auto;
}
.svc-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 10.5px;
  color: var(--sw-fg-2);
  padding: 1px 6px 1px 4px;
  border: 1px solid var(--sw-line-2);
  border-radius: 10px;
  background: var(--sw-bg-2);
}
.svc-swatch {
  width: 8px;
  height: 8px;
  border-radius: 2px;
  flex: 0 0 auto;
}
.svc-swatch.inline {
  display: inline-block;
  margin-right: 4px;
  vertical-align: middle;
}

/* Default view — single combined row. The bar sits as the
   *background* of the name band (encoding start + duration on the
   trace timeline). */
.tr-default-list { padding: 6px 0; }
.tr-default-row {
  display: grid;
  grid-template-columns: 4px auto auto auto minmax(0, 1fr) auto;
  gap: 8px;
  align-items: center;
  padding: 3px 14px 3px 0;
  font-size: 11px;
  cursor: pointer;
}
.tr-default-row:hover { background: var(--sw-bg-2); }
.tr-default-row.err { background: rgba(239, 68, 68, 0.06); }
.svc-stripe { width: 4px; height: 18px; flex: 0 0 auto; }
.kind-glyph {
  width: 14px;
  height: 14px;
  flex: 0 0 auto;
  color: var(--sw-fg-2);
}
.tr-name-band {
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  height: 22px;
}
.tr-name-band-bg {
  position: absolute;
  top: 2px;
  bottom: 2px;
  border-radius: 3px;
  opacity: 0.3;
  outline: 1px solid transparent;
  outline-offset: -1px;
  pointer-events: none;
}
.tr-default-row.err .tr-name-band-bg { opacity: 0.45; }
/* Vertical guide for each ancestor depth — drawn behind the band
   content. Makes call hierarchy readable without shifting the bar. */
.tr-depth-guide {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 1px;
  background: var(--sw-line-2);
  opacity: 0.45;
  pointer-events: none;
}
.tr-name-indent {
  flex: 0 0 auto;
  align-self: stretch;
}
.tr-name {
  position: relative;
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--sw-fg-0);
  font-size: 12px;
  font-weight: 500;
  padding-left: 4px;
}
.tr-peer {
  position: relative;
  flex: 0 0 auto;
  white-space: nowrap;
  font-size: 10.5px;
  color: var(--sw-fg-2);
}
.tr-row-dur {
  font-size: 10.5px;
  color: var(--sw-fg-1);
  font-weight: 600;
  flex: 0 0 auto;
  text-align: right;
  min-width: 56px;
  padding-left: 6px;
}

/* Tree view — d3 horizontal layout. */
.tr-tree-canvas {
  position: relative;
  padding: 12px;
  height: clamp(420px, 60vh, 720px);
  background:
    linear-gradient(var(--sw-bg-1), var(--sw-bg-1)) padding-box,
    repeating-linear-gradient(
      45deg,
      transparent 0 8px,
      var(--sw-line) 8px 9px
    ) border-box;
}
.tree-svg { display: block; cursor: grab; }
.tree-svg:active { cursor: grabbing; }
/* Floating zoom control cluster — top-right of the tree canvas. */
.tree-zoom-ctrls {
  position: sticky;
  top: 8px;
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 6px;
  background: rgba(15, 18, 30, 0.85);
  border: 1px solid var(--sw-line-2);
  border-radius: 6px;
  z-index: 2;
  width: fit-content;
  float: right;
  backdrop-filter: blur(6px);
}
.tree-zoom-ctrls .zoom-pct {
  font-size: 10.5px;
  color: var(--sw-fg-2);
  min-width: 36px;
  text-align: right;
  padding-right: 2px;
}
.tree-link { transition: stroke 0.12s ease; }
.tree-node { cursor: pointer; }
.tree-node:hover rect { fill-opacity: 0.35; }
.tree-node.err rect { stroke: var(--sw-err); }
.tree-node-body {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  height: 100%;
  font-size: 11px;
  color: var(--sw-fg-0);
  overflow: hidden;
  box-sizing: border-box;
}
.tree-node-text {
  display: inline-flex;
  flex-direction: column;
  min-width: 0;
  flex: 1 1 auto;
  line-height: 1.25;
  gap: 1px;
}
.tree-node-svc {
  font-size: 9.5px;
  font-weight: 700;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tree-node-name {
  font-size: 11px;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--sw-fg-0);
}
.tree-node-lat-text {
  font-size: 9.5px;
  font-weight: 700;
  font-family: var(--sw-mono);
}

/* Technology component icon — same PNG set as the topology map. */
.comp-icon {
  width: 18px;
  height: 18px;
  flex: 0 0 auto;
  object-fit: contain;
  background: transparent;
}
.comp-icon-generic { color: var(--sw-fg-2); }
.tree-node-body .comp-icon-generic { color: var(--sw-fg-1); }
/* Attached-event badge. */
.evt-badge {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  height: 16px;
  padding: 0 5px;
  border-radius: 8px;
  background: var(--sw-accent-soft);
  color: var(--sw-accent-2);
  font-size: 9.5px;
  font-weight: 700;
  flex: 0 0 auto;
}
.evt-flag { font-size: 10px; line-height: 1; }
.evt-count { font-family: var(--sw-mono); }

/* Table */
.tr-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 11.5px;
}
.tr-table th {
  text-align: left;
  font-size: 9.5px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--sw-fg-3);
  font-weight: 600;
  padding: 6px 12px;
  border-bottom: 1px solid var(--sw-line);
}
.tr-table th.num { text-align: right; }
.tr-table th.endpoint-col { width: 40%; }
.tr-table td {
  padding: 6px 12px;
  border-bottom: 1px solid var(--sw-line);
  max-width: 1px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tr-table td.endpoint-col { max-width: none; }
.tr-table td.num { text-align: right; }
.tr-table td.mono { font-family: var(--sw-mono); }
.tr-table td.dim { color: var(--sw-fg-3); }
.tr-table tbody tr { cursor: pointer; }
.tr-table tbody tr:hover { background: var(--sw-bg-2); }
.tr-table tbody tr.err { background: rgba(239, 68, 68, 0.06); }
/* Statistics — components column. */
.stat-comp-stack {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  flex-wrap: nowrap;
}
.stat-comp {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: 10.5px;
}
.stat-comp .comp-icon { width: 16px; height: 16px; }

.tr-table th.sortable {
  cursor: pointer;
  user-select: none;
}
.tr-table th.sortable:hover { color: var(--sw-fg-1); }
.tr-table th.sortable.on { color: var(--sw-accent); }
.sort-ind {
  display: inline-block;
  margin-left: 4px;
  font-family: var(--sw-mono);
  font-size: 10px;
  opacity: 0.7;
}
.tr-table th.sortable.on .sort-ind { opacity: 1; }

/* Status flag */
.status-flag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 18px;
  padding: 0 6px;
  border-radius: 9px;
  font-size: 9.5px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  flex: 0 0 auto;
}
.status-flag.sm {
  height: 12px;
  width: 12px;
  padding: 0;
  border-radius: 50%;
  justify-content: center;
}
.status-flag.sm .flag-dot { margin: 0; }
.flag-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
  flex: 0 0 auto;
}
.status-flag.flag-ok { background: rgba(34, 197, 94, 0.14); color: var(--sw-ok); }
.status-flag.flag-err { background: rgba(239, 68, 68, 0.18); color: var(--sw-err); }

/* Span detail modal */
.span-modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  z-index: 1000;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: 40px 20px;
  overflow-y: auto;
}
.span-modal {
  width: 100%;
  max-width: 920px;
  max-height: calc(100vh - 80px);
  display: flex;
  flex-direction: column;
}
.span-modal-head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--sw-line);
  flex: 0 0 auto;
}
.span-modal-head h4 {
  margin: 0;
  font-size: 12px;
  font-weight: 600;
  display: inline-flex;
  gap: 10px;
  align-items: baseline;
  flex: 1;
  min-width: 0;
}
.span-modal-head h4 .dim { color: var(--sw-fg-3); font-weight: 500; }
.span-modal-head h4 .mono {
  font-family: var(--sw-mono);
  color: var(--sw-fg-1);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.span-modal-body { padding: 12px 14px 16px; overflow-y: auto; }
.sd-section { margin-bottom: 18px; }
.sd-section h5 {
  margin: 0 0 6px;
  font-size: 9.5px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--sw-accent);
  font-weight: 700;
}
.kv {
  display: grid;
  grid-template-columns: 160px 1fr;
  gap: 4px 12px;
  margin: 0;
  font-size: 11px;
}
.kv dt { color: var(--sw-fg-3); font-size: 10.5px; }
.kv dd { margin: 0; color: var(--sw-fg-1); }
.kv-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 11px;
}
.kv-table th {
  text-align: left;
  font-size: 9.5px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--sw-fg-3);
  font-weight: 600;
  padding: 4px 8px;
  border-bottom: 1px solid var(--sw-line);
}
.kv-table th.num { text-align: right; }
.kv-table td { padding: 4px 8px; border-bottom: 1px solid var(--sw-line); }
.kv-table td.num { text-align: right; }
.trace-link {
  background: transparent;
  border: none;
  color: var(--sw-cyan);
  cursor: pointer;
  padding: 0;
  font: inherit;
  text-decoration: underline;
  text-underline-offset: 2px;
}
.trace-link:hover { color: var(--sw-accent); }
.span-log, .span-event {
  border: 1px solid var(--sw-line);
  border-radius: 4px;
  padding: 6px 10px;
  margin-bottom: 6px;
  background: var(--sw-bg-1);
}
.span-log-time { font-size: 10px; margin-bottom: 4px; }
.span-event-head {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  font-size: 11px;
  margin-bottom: 4px;
}
.pre {
  background: var(--sw-bg-2);
  padding: 4px 6px;
  border-radius: 3px;
  font-size: 10.5px;
  margin: 0;
  white-space: pre-wrap;
  word-break: break-all;
  color: var(--sw-fg-1);
}

/* Copy affordance */
.copy-btn:active { transform: scale(0.94); }
.copy-flash-chip {
  display: inline-flex;
  align-items: center;
  height: 18px;
  padding: 0 8px;
  border-radius: 9px;
  font-size: 9.5px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  background: rgba(34, 197, 94, 0.18);
  color: var(--sw-ok);
}
.copy-flash-enter-from { opacity: 0; transform: translateX(-4px); }
.copy-flash-enter-active { transition: opacity 0.18s ease, transform 0.18s ease; }
.copy-flash-leave-to { opacity: 0; transform: translateX(4px); }
.copy-flash-leave-active { transition: opacity 0.3s ease, transform 0.3s ease; }
</style>
