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
  Per-layer Traces tab. SkyWalking-native only (Zipkin is its own
  component).

  Two trigger modes for trace detail:
    - In-page click (general select): writes a LOCAL `selectedTraceId`,
      flipping the layout to folded-rail + inline detail (left/right).
      No URL mutation — clicking around stays cheap.
    - URL-driven access (`?traceId=<id>`): opens the global TracePopout
      overlay (mounted in AppShell). Used for shareable links and
      cross-trace refs. While the URL carries a traceId we suppress
      the list query — the popout is a cold-link experience.

  Distribution chart: dots are clickable; clicking a dot selects the
  matching list row (inline detail). Y axis is omitted — Y is the
  per-trace duration, surfaced via the dot's tooltip and the inline
  list row's bar instead.
-->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute } from 'vue-router';

const { t } = useI18n({ useScope: 'global' });
import type {
  LayerDef,
  NativeSpan,
  NativeTraceListRow,
  TraceAttachedEvent,
  TraceLogEntry,
  TraceQueryOrder,
  TraceQueryState,
} from '@/api/client';
import { useLayerLanding } from '@/layer/useLayerLanding';
import { useLayers } from '@/shell/useLayers';
import { useLayerTraces, useTraceDetail } from '@/layer/traces/useLayerTraces';
import { useLayerInstances } from '@/layer/useLayerInstances';
import { useLayerEndpoints } from '@/layer/useLayerEndpoints';
import TypeaheadSelect from '@/components/primitives/TypeaheadSelect.vue';
import { useSelectedService } from '@/layer/useSelectedService';
import { useLayerServiceName } from '@/layer/useLayerServiceName';
import { useSetupStore } from '@/state/setup';
import { useTracePopout } from '@/layer/traces/useTracePopout';
import { componentIconOrNull } from '@/layer/service-map/useTopologyIcons';
import { fmtMetric } from '@/utils/formatters';
import { bffClient } from '@/api/client';
import * as d3 from 'd3';

const route = useRoute();
const layerKey = computed(() => String(route.params.layerKey ?? ''));

const { selectedId, setSelected: setSelectedService } = useSelectedService();
const { layers } = useLayers();
const layer = computed<LayerDef | null>(() => layers.value.find((l) => l.key === layerKey.value) ?? null);
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
const serviceName = useLayerServiceName(layerKey, landing);
const landingRows = computed(() => landing.data.value?.sampledRows ?? landing.rows.value ?? []);
watch(
  landingRows,
  (rows) => {
    if (selectedId.value) return;
    const first = rows[0];
    if (first) setSelectedService(first.serviceId);
  },
  { immediate: true },
);

// ── Filter state ───────────────────────────────────────────────────
// Two layers: live form refs (bound to the inputs) and *committed*
// refs that drive the actual query. The query only fires when the
// operator hits "Run query" — trace queries can be slow over slow
// links, so we don't auto-refetch on every keystroke / select change.
const traceState = ref<TraceQueryState>('ALL');
const queryOrder = ref<TraceQueryOrder>('BY_START_TIME');
const minDuration = ref<number | null>(null);
const maxDuration = ref<number | null>(null);
/** Trace-result cap. Replaces booster's paging — operators tune
 *  with explicit "show me 30 / 50 / 100 …" knobs. */
const limit = ref<number>(30);
const instanceId = ref<string | null>(null);
const endpointId = ref<string | null>(null);
const endpointQuery = ref<string>('');
const traceIdInput = ref<string>('');
const traceIdFilter = ref<string | null>(null);
const tagsInput = ref<string>('');
const tagsList = ref<Array<{ key: string; value: string }>>([]);

// Committed snapshot — what useLayerTraces actually reads. Updated
// only by runQuery(). Initially mirrors the live defaults so the
// FIRST `Run query` click fetches with sensible inputs.
const cTraceState = ref<TraceQueryState>('ALL');
const cQueryOrder = ref<TraceQueryOrder>('BY_START_TIME');
const cMinDuration = ref<number | null>(null);
const cMaxDuration = ref<number | null>(null);
const cLimit = ref<number>(30);
const cInstanceId = ref<string | null>(null);
const cEndpointId = ref<string | null>(null);
const cTraceIdFilter = ref<string | null>(null);
const cTags = ref<Array<{ key: string; value: string }>>([]);
const cWindowMinutes = ref<number>(30);
const cCustomStart = ref<string | null>(null);
const cCustomEnd = ref<string | null>(null);
/** Becomes true on the first `Run query` click. Until then the
 *  list area shows a placeholder and the query stays disabled. */
const hasQueried = ref<boolean>(false);
const TIME_RANGE_PRESETS = computed<Array<{ label: string; minutes: number }>>(() => [
  { label: t('Last 15 min'), minutes: 15 },
  { label: t('Last 30 min'), minutes: 30 },
  { label: t('Last 1 hour'), minutes: 60 },
  { label: t('Last 3 hours'), minutes: 180 },
  { label: t('Last 6 hours'), minutes: 360 },
  { label: t('Last 12 hours'), minutes: 720 },
  { label: t('Last 24 hours'), minutes: 1440 },
]);
const windowMinutes = ref<number>(30);
const CUSTOM_RANGE_SENTINEL = -1;
const customStart = ref<string | null>(null);
const customEnd = ref<string | null>(null);
function setCustomMode(): void {
  if (windowMinutes.value !== CUSTOM_RANGE_SENTINEL) return;
  if (customStart.value && customEnd.value) return;
  const end = new Date();
  const start = new Date(end.getTime() - 30 * 60_000);
  const fmt = (d: Date) => {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  customStart.value = fmt(start);
  customEnd.value = fmt(end);
}
function clearCustomRange(): void {
  customStart.value = null;
  customEnd.value = null;
}
const isCustomRange = computed(() => windowMinutes.value === CUSTOM_RANGE_SENTINEL);
watch(isCustomRange, (custom) => {
  if (custom) setCustomMode();
  else clearCustomRange();
});

const NATIVE_SOURCE = ref<'native'>('native');
const sourceRef = computed<'native'>(() => 'native');

const { instances } = useLayerInstances(layerKey, serviceName);
const { endpoints } = useLayerEndpoints(layerKey, serviceName, endpointQuery, ref(50));
// '' ↔ null bridges the All sentinel (TypeaheadSelect value is a string).
const instanceSelectOptions = computed(() => [
  { value: '', label: t('All') },
  ...instances.value.map((i) => ({ value: i.id, label: i.name })),
]);
const endpointSelectOptions = computed(() => [
  { value: '', label: t('All') },
  ...endpoints.value.map((e) => ({ value: e.id, label: e.name })),
]);
const instanceIdSel = computed<string>({
  get: () => instanceId.value ?? '',
  set: (v) => { instanceId.value = v || null; },
});
const endpointIdSel = computed<string>({
  get: () => endpointId.value ?? '',
  set: (v) => { endpointId.value = v || null; },
});

watch([serviceName], () => {
  instanceId.value = null;
  endpointId.value = null;
});

const { openTrace } = useTracePopout();

// Service is auto-resolved from the URL/landing; when it changes we
// reset the committed snapshot so a stale committed `service` doesn't
// drive the next query for the wrong layer-service pair.
const cService = ref<string | null>(null);
const queryEnabled = computed(() => hasQueried.value);

const { native, isFetching, refetch } = useLayerTraces(layerKey, {
  source: NATIVE_SOURCE,
  service: cService,
  instanceId: cInstanceId,
  endpointId: cEndpointId,
  traceId: cTraceIdFilter,
  traceState: cTraceState,
  queryOrder: cQueryOrder,
  minDuration: cMinDuration,
  maxDuration: cMaxDuration,
  // pageNum kept at 1 — paging is replaced by an explicit `limit`.
  pageNum: ref(1),
  pageSize: cLimit,
  tags: cTags,
  windowMinutes: cWindowMinutes,
  customStart: cCustomStart,
  customEnd: cCustomEnd,
  enabled: queryEnabled,
});

// Which OAP query answered. `queryBasicTraces` (Trace Query v1 API)
// returns trace SEGMENTS — each row is one segment and the full trace
// is fetched on click via queryTrace. `queryTraces` (v2, BanyanDB
// only) returns whole traces with spans inline, rendered immediately
// on selection. The banner states the API and persists across the
// browse + detail views so operators always know what a row is.
const isSegmentList = computed(() => native.value?.api === 'queryBasicTraces');
const traceApiLabel = computed(() => (native.value?.api === 'queryTraces' ? 'v2' : 'v1'));
const showApiBanner = computed(() => hasQueried.value && !!native.value?.reachable);

/**
 * Commit live filter values to the committed refs, then fire the
 * query. This is the only path that fetches — filter inputs don't
 * auto-refresh the result list.
 */
function runQuery(): void {
  traceIdFilter.value = traceIdInput.value.trim() || null;
  cService.value = serviceName.value;
  cInstanceId.value = instanceId.value;
  cEndpointId.value = endpointId.value;
  cTraceIdFilter.value = traceIdFilter.value;
  cTraceState.value = traceState.value;
  cQueryOrder.value = queryOrder.value;
  cMinDuration.value = minDuration.value;
  cMaxDuration.value = maxDuration.value;
  cLimit.value = limit.value;
  cTags.value = [...tagsList.value];
  cWindowMinutes.value = windowMinutes.value;
  cCustomStart.value = customStart.value;
  cCustomEnd.value = customEnd.value;
  hasQueried.value = true;
  void refetch();
}
function addTag(): void {
  const raw = tagsInput.value.trim();
  if (!raw || !raw.includes('=')) return;
  const idx = raw.indexOf('=');
  const key = raw.slice(0, idx).trim();
  const value = raw.slice(idx + 1).trim();
  if (!key) return;
  tagsList.value = [...tagsList.value, { key, value }];
  tagsInput.value = '';
}
function removeTag(i: number): void {
  tagsList.value = tagsList.value.filter((_, idx) => idx !== i);
}

// Tag autocomplete (booster-style) — fetch known keys + per-key
// values from the BFF, surfaced via a <datalist>. The list source
// switches based on whether the operator has typed an `=` yet:
//   before `=` → keys
//   after `=`  → values of the entered key
const tagKeyOptions = ref<string[]>([]);
const tagValueOptions = ref<string[]>([]);
const tagValueKey = ref<string>('');
async function loadTagKeys(): Promise<void> {
  try {
    const res = await bffClient.trace.tagKeys(windowMinutes.value === -1 ? 30 : windowMinutes.value);
    tagKeyOptions.value = res.keys ?? [];
  } catch { /* noop — autocomplete is best-effort */ }
}
async function loadTagValues(key: string): Promise<void> {
  if (!key || key === tagValueKey.value) return;
  tagValueKey.value = key;
  try {
    const res = await bffClient.trace.tagValues(key, windowMinutes.value === -1 ? 30 : windowMinutes.value);
    tagValueOptions.value = res.values ?? [];
  } catch { /* noop */ }
}
function onTagInput(): void {
  const raw = tagsInput.value;
  const eq = raw.indexOf('=');
  if (eq === -1) {
    // Still typing the key — keep the keys datalist active.
    return;
  }
  const key = raw.slice(0, eq).trim();
  if (key) void loadTagValues(key);
}
// Pre-load keys once the operator has picked a service (so the
// suggestions reflect what the upstream OAP actually has indexed).
watch(serviceName, (v) => { if (v) void loadTagKeys(); }, { immediate: true });
const tagDatalistOptions = computed<string[]>(() => {
  const raw = tagsInput.value;
  const eq = raw.indexOf('=');
  if (eq === -1) return tagKeyOptions.value;
  const key = raw.slice(0, eq).trim();
  // Prefix each suggestion with the typed key so picking from the
  // datalist replaces the *value* portion of the input.
  return tagValueOptions.value.map((v) => `${key}=${v}`);
});

// ── Inline selection (click-driven, local state, no URL change) ───
const selectedTraceId = ref<string | null>(null);
const selectedTraceIds = ref<string[]>([]);
const selectedRowKey = ref<string | null>(null);
const embeddedSpans = ref<NativeSpan[] | null>(null);
const railOpen = ref<boolean>(true);

function selectNative(row: NativeTraceListRow): void {
  selectedRowKey.value = row.key;
  selectedTraceIds.value = row.traceIds;
  selectedTraceId.value = row.traceIds[0] ?? null;
  embeddedSpans.value = row.spans ?? null;
}
function closeDetail(): void {
  selectedTraceId.value = null;
  selectedRowKey.value = null;
  embeddedSpans.value = null;
}
function changeSelectedTraceId(id: string): void {
  selectedTraceId.value = id;
  embeddedSpans.value = null;
}
function copyShareableUrl(): void {
  if (!selectedTraceId.value) return;
  // Compose a URL with `?traceId=<id>` so anyone with the link gets
  // the popout cold-load experience. We don't normally mirror the
  // selection to the URL (click-driven flow stays cheap) — only
  // build it on demand here.
  const url = new URL(window.location.href);
  url.searchParams.set('traceId', selectedTraceId.value);
  navigator.clipboard?.writeText(url.toString()).then(() => flashCopy('url'), () => {});
}
function copyTraceId(): void {
  if (!selectedTraceId.value) return;
  navigator.clipboard?.writeText(selectedTraceId.value).then(() => flashCopy('id'), () => {});
}
const copyFlash = ref<'id' | 'url' | null>(null);
let copyFlashTimer: ReturnType<typeof setTimeout> | null = null;
function flashCopy(kind: 'id' | 'url'): void {
  copyFlash.value = kind;
  if (copyFlashTimer) clearTimeout(copyFlashTimer);
  copyFlashTimer = setTimeout(() => { copyFlash.value = null; }, 1400);
}

const traceIdRef = computed(() => selectedTraceId.value);
const { nativeDetail, isFetching: detailFetching } = useTraceDetail(traceIdRef, sourceRef);

// ── Tree-view zoom/pan ────────────────────────────────────────────
// d3.zoom drives wheel + drag. Programmatic +/-/⊙ buttons call the
// same zoom behaviour so the transform stays consistent. The
// behaviour is re-bound whenever the SVG element changes (new trace
// opened, view toggled away and back, …) so drag-pan keeps working
// after re-renders.
const treeSvgEl = ref<SVGSVGElement | null>(null);
const treeTransform = ref<{ x: number; y: number; k: number }>({ x: 0, y: 0, k: 1 });
let treeZoomBehavior: ReturnType<typeof d3.zoom<SVGSVGElement, unknown>> | null = null;
let treeZoomBoundEl: SVGSVGElement | null = null;
function ensureTreeZoom(): void {
  const el = treeSvgEl.value;
  if (!el) return;
  // Already bound to this element? Nothing to do.
  if (treeZoomBoundEl === el && treeZoomBehavior) return;
  // Detach the previous binding (if any) so stale listeners don't
  // pile up.
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

// ── View mode (for inline detail) ─────────────────────────────────
// Three view modes:
//   - default     — list row with status + kind + icon + a coloured
//                   *bar background* under the span name (the bar
//                   encodes start/duration on the trace timeline).
//                   Duration sits as a suffix on the right.
//   - tree        — d3 horizontal flowing layout, parent-child
//                   structure with Bezier connectors.
//   - statistics  — per-span-name roll-up; sortable on total/avg/max.
type ViewMode = 'default' | 'tree' | 'statistics';
const viewMode = ref<ViewMode>('default');

// Auto-attach d3.zoom when the Tree view becomes active and its SVG
// mounts. We re-attach on viewMode change so a hidden-then-shown
// tree picks the new SVG ref.
watch([viewMode, treeSvgEl], async ([m, _el]) => {
  if (m === 'tree') {
    await nextTick();
    ensureTreeZoom();
  }
});

// Statistics sort state — clickable headers cycle desc / asc on the
// chosen column. Default is total desc (biggest contributors first).
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
const nativeSpans = computed<NativeSpan[]>(() => embeddedSpans.value ?? nativeDetail.value?.spans ?? []);
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
  const t = (type ?? '').toUpperCase();
  if (t.includes('SERVER') || t === 'ENTRY') return 'var(--sw-accent)';
  if (t.includes('CLIENT') || t === 'EXIT') return 'var(--sw-info)';
  if (t === 'LOCAL') return 'var(--sw-purple)';
  if (t.includes('PRODUCER') || t.includes('CONSUMER')) return 'var(--sw-purple)';
  if (t.includes('DATABASE') || t.includes('SQL') || t.includes('CACHE')) return 'var(--sw-cyan)';
  return 'var(--sw-fg-2)';
}
/**
 * Span-kind family — Entry, Local, Exit, plus catch-alls for the
 * GraphQL-spelled Server/Client/Producer/Consumer set. Drives the
 * inline SVG glyph rendered in place of the text chip.
 */
type KindFamily = 'entry' | 'local' | 'exit' | 'server' | 'client' | 'producer' | 'consumer' | 'other';
function kindFamily(type: string | null | undefined): KindFamily {
  const t = (type ?? '').toUpperCase();
  if (t === 'ENTRY' || t.includes('SERVER')) return 'entry';
  if (t === 'EXIT' || t.includes('CLIENT')) return 'exit';
  if (t === 'LOCAL') return 'local';
  if (t.includes('PRODUCER')) return 'producer';
  if (t.includes('CONSUMER')) return 'consumer';
  return 'other';
}

// ── Render helpers ────────────────────────────────────────────────
function fmtMs(v: number | null | undefined): string {
  if (v === null || v === undefined) return '—';
  return `${fmtMetric(v)} ms`;
}
function fmtRelativeAgo(ts: number | null | undefined): string {
  if (!ts) return '—';
  const ms = Date.now() - ts;
  if (ms < 1000) return t('just now');
  if (ms < 60_000) return t('{n}s ago', { n: Math.round(ms / 1000) });
  if (ms < 3_600_000) return t('{n}m ago', { n: Math.round(ms / 60_000) });
  return t('{n}h ago', { n: Math.round(ms / 3_600_000) });
}
function fmtDateTime(ts: number | null | undefined): string {
  if (!ts || !Number.isFinite(ts)) return '—';
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function parseNativeStart(v: string): number {
  const n = Number(v);
  if (Number.isFinite(n) && n > 0) return n;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : 0;
}
/**
 * Trace-result bar colour, used in the browsing list. Red is
 * reserved for actual error-status traces; high-duration successful
 * traces stay on a softer palette (info → warn) so the operator
 * doesn't read a slow-but-ok request as a failure.
 *
 * The bar fill itself is rendered at low opacity (see CSS) so the
 * colour reads as a tint, not a saturated alert.
 */
function rowDurationColor(durationMs: number): string {
  if (durationMs >= 500) return 'var(--sw-warn)';
  if (durationMs >= 100) return 'var(--sw-info)';
  return 'var(--sw-ok)';
}
/**
 * Latency-band color for tree nodes. Cool-to-warm gradient that
 * tops out at the accent orange — red is reserved for actual error
 * states (isError === true), not slow successful spans. So a slow
 * span looks "hot" but not "failed".
 *
 * Bands:
 *   < 100 ms     teal-mint  — fast, cool palette
 *   100 – 500    cyan       — informational
 *   500 – 1 s    amber      — getting warm
 *   ≥ 1 s        accent     — hot, but still healthy-looking orange
 */
function latencyColor(durationMs: number): string {
  if (durationMs >= 1000) return 'var(--sw-accent)';
  if (durationMs >= 500) return 'var(--sw-warn)';
  if (durationMs >= 100) return 'var(--sw-info)';
  return 'var(--sw-ok)';
}
function fmtAttachedTs(t: { seconds: number; nanos: number }): string {
  const ms = t.seconds * 1000 + t.nanos / 1_000_000;
  return fmtDateTime(ms) + '.' + String(t.nanos).padStart(9, '0').slice(0, 6);
}
function nativeSpanError(s: NativeSpan): boolean { return s.isError; }

const maxTraceDuration = computed(() => {
  const arr = visibleTraces.value;
  if (arr.length === 0) return 0;
  return Math.max(...arr.map((t) => t.duration));
});

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
  // the span becomes a root (orphan -> depth 0). This prevents lost
  // spans when the parent segment is outside the queried trace set.
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

// ── Tree view — d3 horizontal hierarchical layout (matches booster
// ui's `d3-trace-tree`). Spans flow left-to-right: root anchored on
// the left, children fan out to the right. The layout is computed
// declaratively (no direct DOM mutation); Vue renders the resulting
// SVG nodes + connector paths.
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
  // If there are multiple roots, wrap them in a synthetic root so the
  // d3 layout treats them as siblings under one tree. The synthetic
  // root is rendered as a "User" pseudo-node (a thin pill) so the
  // operator sees the entry point even when OAP didn't materialise
  // a literal `User` span.
  const synthRoot: Datum = roots.length === 1
    ? build(roots[0])
    : {
        // Synthetic — has no real span. Filtered out at render time.
        span: { segmentId: '__synth__', spanId: -1 } as NativeSpan,
        children: roots.map(build),
      };
  const hierarchy = d3.hierarchy<Datum>(synthRoot, (d) => d.children);
  const layout = d3.tree<Datum>().nodeSize([NODE_H + NODE_GAP_Y, NODE_W + NODE_GAP_X])(hierarchy);
  // d3.tree() produces y for depth and x for sibling. For a
  // left-to-right tree we use d.y as horizontal and d.x as vertical
  // coords on screen.
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
  // Build links with parent refs.
  const links: TreeLink[] = [];
  layout.descendants().forEach((d) => {
    if (!d.parent) return;
    if (d.parent.data.span.segmentId === '__synth__') return;
    if (d.data.span.segmentId === '__synth__') return;
    const child = nodeMap.get(key(d.data.span.segmentId, d.data.span.spanId));
    const parent = nodeMap.get(key(d.parent.data.span.segmentId, d.parent.data.span.spanId));
    if (!child || !parent) return;
    child.parent = parent;
    // Bezier path from parent's right edge to child's left edge.
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

// ── Statistics view ───────────────────────────────────────────────
// Grouped by SPAN NAME (the operationName — endpointName when set,
// else component/peer). Service + components are aggregated within
// the group: the same span name might appear across more than one
// component (e.g., an HTTP call routed through different clients);
// we surface the top-3 components by occurrence so the operator
// can spot variation without flooding the row.
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

// ── Duration scatter ──────────────────────────────────────────────
interface ScatterPoint { id: string; rowKey: string; x: number; y: number; isError: boolean; label: string; row: NativeTraceListRow; }
const scatterPoints = computed<ScatterPoint[]>(() => {
  const out: ScatterPoint[] = [];
  if (native.value?.traces) {
    for (const t of native.value.traces) {
      const ts = parseNativeStart(t.start);
      out.push({
        id: t.key,
        rowKey: t.key,
        x: ts,
        y: t.duration,
        isError: t.isError,
        label: t.endpointNames[0] ?? '—',
        row: t,
      });
    }
  }
  return out;
});
const scatterBounds = computed(() => {
  const pts = scatterPoints.value.filter((p) => p.x > 0 && Number.isFinite(p.y));
  if (pts.length === 0) return null;
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const rawYMax = Math.max(...ys, 1);
  const yMax = rawYMax || 1;
  return { xMin: Math.min(...xs), xMax: Math.max(...xs), yMin: 0, yMax };
});
const scatterXTicks = computed(() => {
  const b = scatterBounds.value;
  if (!b) return [];
  const xCount = 3;
  const span = Math.max(1, b.xMax - b.xMin);
  return Array.from({ length: xCount }, (_, i) => {
    const t = b.xMin + (span * i) / (xCount - 1);
    const d = new Date(t);
    const pad = (n: number) => String(n).padStart(2, '0');
    return { frac: i / (xCount - 1), label: `${pad(d.getHours())}:${pad(d.getMinutes())}` };
  });
});

/* ── Distribution selection (in-page filter) ─────────────────────
 *
 * Clicking a dot adds (or removes) the corresponding trace to the
 * `pickedTraceIds` set. Dragging a rectangle on the chart selects
 * every dot inside it. The list below is then filtered to only the
 * picked traces — no extra query fires. Reset clears the set.
 */
const pickedTraceIds = ref<Set<string>>(new Set());
const isPicking = computed(() => pickedTraceIds.value.size > 0);
function togglePick(rowKey: string): void {
  const s = new Set(pickedTraceIds.value);
  if (s.has(rowKey)) s.delete(rowKey);
  else s.add(rowKey);
  pickedTraceIds.value = s;
}
function resetPick(): void {
  pickedTraceIds.value = new Set();
}

// Drag-to-select state. Coords are SVG-space (viewBox 0..1000 in x,
// 1000..0 in y). The drag rect renders while pointer is down.
const scatterSvgRef = ref<SVGSVGElement | null>(null);
const dragState = ref<{
  active: boolean;
  startVx: number; startVy: number; curVx: number; curVy: number;
}>({ active: false, startVx: 0, startVy: 0, curVx: 0, curVy: 0 });
function clientToViewbox(ev: PointerEvent): { vx: number; vy: number } | null {
  const svg = scatterSvgRef.value;
  if (!svg) return null;
  const rect = svg.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return null;
  const vx = ((ev.clientX - rect.left) / rect.width) * 1000;
  const vy = ((ev.clientY - rect.top) / rect.height) * 1000;
  return { vx, vy };
}
function onScatterDown(ev: PointerEvent): void {
  const pt = clientToViewbox(ev);
  if (!pt) return;
  const target = ev.target as Element | null;
  // Click on a dot is handled by its own click handler; the drag is
  // for the empty plot area.
  if (target?.classList.contains('scatter-dot')) return;
  ev.preventDefault();
  dragState.value = { active: true, startVx: pt.vx, startVy: pt.vy, curVx: pt.vx, curVy: pt.vy };
  (ev.currentTarget as SVGSVGElement).setPointerCapture(ev.pointerId);
}
function onScatterMove(ev: PointerEvent): void {
  if (!dragState.value.active) return;
  const pt = clientToViewbox(ev);
  if (!pt) return;
  dragState.value = { ...dragState.value, curVx: pt.vx, curVy: pt.vy };
}
function onScatterUp(ev: PointerEvent): void {
  if (!dragState.value.active) return;
  const { startVx, startVy, curVx, curVy } = dragState.value;
  dragState.value = { active: false, startVx: 0, startVy: 0, curVx: 0, curVy: 0 };
  try {
    (ev.currentTarget as SVGSVGElement).releasePointerCapture(ev.pointerId);
  } catch { /* noop */ }
  // No real drag (click without move) → don't change selection.
  if (Math.abs(curVx - startVx) < 4 && Math.abs(curVy - startVy) < 4) return;
  const b = scatterBounds.value;
  if (!b) return;
  const vxMin = Math.min(startVx, curVx);
  const vxMax = Math.max(startVx, curVx);
  const vyMin = Math.min(startVy, curVy);
  const vyMax = Math.max(startVy, curVy);
  const next = new Set(pickedTraceIds.value);
  for (const p of scatterPoints.value) {
    const cx = b.xMax === b.xMin ? 500 : ((p.x - b.xMin) / (b.xMax - b.xMin)) * 1000;
    const cy = 1000 - ((p.y - b.yMin) / (b.yMax - b.yMin || 1)) * 990;
    if (cx >= vxMin && cx <= vxMax && cy >= vyMin && cy <= vyMax) {
      next.add(p.rowKey);
    }
  }
  pickedTraceIds.value = next;
}
const dragRect = computed(() => {
  const s = dragState.value;
  if (!s.active) return null;
  return {
    x: Math.min(s.startVx, s.curVx),
    y: Math.min(s.startVy, s.curVy),
    w: Math.abs(s.curVx - s.startVx),
    h: Math.abs(s.curVy - s.startVy),
  };
});

// Dot click → toggle picked. Replaces the earlier "open inline
// detail" wiring: the operator picks dots to filter; the inline
// detail still opens via the list row click below.
function pickScatterDot(p: ScatterPoint, ev: MouseEvent): void {
  ev.stopPropagation();
  togglePick(p.rowKey);
}

// Filter the visible list by the picked set when any are picked.
const visibleTraces = computed(() => {
  const all = native.value?.traces ?? [];
  if (pickedTraceIds.value.size === 0) return all;
  return all.filter((t) => pickedTraceIds.value.has(t.key));
});

// ── Span detail modal ──────────────────────────────────────────────
const openSpan = ref<NativeSpan | null>(null);
function openNativeSpan(s: NativeSpan): void { openSpan.value = s; }
function closeSpan(): void { openSpan.value = null; }

/**
 * Esc cascade for the inline detail layout (popout has its own
 * separate handler). Order of dismissal:
 *   1. Span detail modal — if open, Esc closes it first.
 *   2. Inline detail — Esc closes the rail+detail back to browsing.
 *
 * Capture phase so it fires before native form-input handlers
 * (operators often have an input focused when they hit Esc).
 */
function onPageKeyDown(e: KeyboardEvent): void {
  if (e.key !== 'Escape') return;
  if (openSpan.value) {
    openSpan.value = null;
    e.preventDefault();
    e.stopPropagation();
  } else if (selectedTraceId.value) {
    closeDetail();
    e.preventDefault();
    e.stopPropagation();
  }
}
onMounted(() => window.addEventListener('keydown', onPageKeyDown, true));
onBeforeUnmount(() => window.removeEventListener('keydown', onPageKeyDown, true));
</script>

<template>
  <div class="tr-tab">
    <!-- Top strip: filter (80%) + duration distribution (20%). -->
    <div class="tr-top-strip">
      <header class="tr-toolbar sw-card">
        <div class="tr-toolbar-head">
          <!-- Service name removed from the head row — the layer
               header's Switch button already shows which service the
               page is bound to, so repeating it here is duplicate
               chrome (same reasoning as the logs tab). -->
          <span class="kicker">{{ t('Traces') }}</span>
          <span v-if="isFetching" class="hint">{{ t('refreshing…') }}</span>
          <button class="sw-btn primary tr-run-btn" type="button" @click="runQuery">{{ t('Run query') }}</button>
        </div>
        <div class="tr-conditions">
          <label class="cf">
            <span>{{ t('Instance') }}</span>
            <TypeaheadSelect
              v-model="instanceIdSel"
              :aria-label="t('Instance')"
              :options="instanceSelectOptions"
              :placeholder="t('All')"
              :disabled="!serviceName"
              class="cf-tas"
            />
          </label>
          <label class="cf cf-wide">
            <span>{{ t('Endpoint') }}</span>
            <TypeaheadSelect
              v-model="endpointIdSel"
              :aria-label="t('Endpoint')"
              :options="endpointSelectOptions"
              :placeholder="t('All')"
              :disabled="!serviceName"
              class="cf-tas"
            />
          </label>
          <label class="cf">
            <span>{{ t('Status') }}</span>
            <select v-model="traceState" class="cf-input">
              <option value="ALL">{{ t('All') }}</option>
              <option value="SUCCESS">{{ t('Success') }}</option>
              <option value="ERROR">{{ t('Error') }}</option>
            </select>
          </label>
          <label class="cf">
            <span>{{ t('Order') }}</span>
            <select v-model="queryOrder" class="cf-input">
              <option value="BY_START_TIME">{{ t('Newest') }}</option>
              <option value="BY_DURATION">{{ t('Slowest') }}</option>
            </select>
          </label>
          <label class="cf" :title="t('Cap on trace rows returned (default 30).')">
            <span>{{ t('Limit') }}</span>
            <select v-model.number="limit" class="cf-input">
              <option :value="20">20</option>
              <option :value="30">30</option>
              <option :value="50">50</option>
              <option :value="100">100</option>
            </select>
          </label>
          <label class="cf" :class="{ 'cf-wide': isCustomRange }">
            <span>{{ t('Time range') }}</span>
            <template v-if="isCustomRange">
              <div class="cf-range">
                <input v-model="customStart" type="datetime-local" class="cf-input cf-range-num" />
                <span class="cf-range-sep">–</span>
                <input v-model="customEnd" type="datetime-local" class="cf-input cf-range-num" />
                <button class="sw-btn small ghost" type="button" :title="t('Back to presets')" @click="windowMinutes = 30">×</button>
              </div>
            </template>
            <select v-else v-model.number="windowMinutes" class="cf-input">
              <option v-for="p in TIME_RANGE_PRESETS" :key="p.minutes" :value="p.minutes">{{ p.label }}</option>
              <option :value="CUSTOM_RANGE_SENTINEL">{{ t('Custom…') }}</option>
            </select>
          </label>
          <label class="cf cf-wide">
            <span>{{ t('Trace ID') }}</span>
            <input v-model="traceIdInput" type="text" :placeholder="t('paste trace id…')" class="cf-input" @keyup.enter="runQuery" />
          </label>
          <div class="cf" :title="t('Trace duration in ms (min – max).')">
            <span>{{ t('Duration range (ms)') }}</span>
            <div class="cf-range">
              <input v-model.number.lazy="minDuration" type="number" min="0" :placeholder="t('min')" class="cf-input cf-range-num" />
              <span class="cf-range-sep">–</span>
              <input v-model.number.lazy="maxDuration" type="number" min="0" :placeholder="t('max')" class="cf-input cf-range-num" />
            </div>
          </div>
          <label class="cf cf-wide">
            <span>{{ t('Tag') }}</span>
            <input
              v-model="tagsInput"
              type="text"
              :placeholder="t('key=value, then Enter')"
              class="cf-input"
              list="trace-tag-suggestions"
              @input="onTagInput"
              @keyup.enter="addTag"
            />
            <!-- Datalist content swaps between known tag keys (before
                 `=`) and values for the typed key (after `=`). -->
            <datalist id="trace-tag-suggestions">
              <option v-for="opt in tagDatalistOptions" :key="opt" :value="opt" />
            </datalist>
          </label>
        </div>
        <div v-if="tagsList.length > 0" class="tr-tag-row">
          <span class="tag-row-label">{{ t('Active tags') }}</span>
          <span class="tag-chips">
            <span v-for="(tag, i) in tagsList" :key="i" class="tag-chip">
              <span class="mono">{{ tag.key }}={{ tag.value }}</span>
              <button type="button" class="tag-x" @click="removeTag(i)">×</button>
            </span>
          </span>
        </div>
      </header>

      <!-- Distribution: dots only. Y axis dropped — the y value is
           surfaced on hover (tooltip) and re-surfaced in the list-row
           bar below. Click a dot to select the matching trace. -->
      <section class="tr-scatter sw-card">
        <header class="tr-scatter-head">
          <!-- Header text swaps when the operator is picking dots:
               `Distribution` becomes `N picked` + a Reset button.
               Reset is always visible while picking so the operator
               can drop the filter with one click. -->
          <span v-if="!isPicking" class="kicker">{{ t('Distribution') }}</span>
          <span v-else class="kicker pick-kicker">{{ t('{n} picked', { n: pickedTraceIds.size }) }}</span>
          <span class="legend">
            <span class="lg ok" /> {{ t('ok') }}
            <span class="lg err" /> {{ t('err') }}
          </span>
          <button
            v-if="isPicking"
            class="sw-btn small ghost reset-btn"
            type="button"
            :title="t('Clear in-page filter')"
            @click="resetPick"
          >{{ t('Reset') }}</button>
        </header>
        <div v-if="scatterPoints.length > 0 && scatterBounds" class="scatter-wrap">
          <svg
            ref="scatterSvgRef"
            class="scatter-svg"
            viewBox="0 0 1000 1000"
            preserveAspectRatio="none"
            @pointerdown="onScatterDown"
            @pointermove="onScatterMove"
            @pointerup="onScatterUp"
            @pointercancel="onScatterUp"
          >
            <line x1="0" y1="998" x2="1000" y2="998" stroke="var(--sw-line-2)" stroke-width="1" vector-effect="non-scaling-stroke" />
            <circle
              v-for="p in scatterPoints"
              :key="p.id"
              :cx="scatterBounds.xMax === scatterBounds.xMin ? 500 : ((p.x - scatterBounds.xMin) / (scatterBounds.xMax - scatterBounds.xMin)) * 1000"
              :cy="1000 - ((p.y - scatterBounds.yMin) / (scatterBounds.yMax - scatterBounds.yMin || 1)) * 990"
              :r="pickedTraceIds.has(p.rowKey) ? 6 : 3.2"
              :fill="p.isError ? 'var(--sw-err)' : 'var(--sw-accent)'"
              :fill-opacity="pickedTraceIds.has(p.rowKey) ? 1 : (isPicking ? 0.35 : 0.9)"
              :stroke="pickedTraceIds.has(p.rowKey) ? 'var(--sw-fg-0)' : (p.isError ? 'var(--sw-err)' : 'var(--sw-accent-2)')"
              :stroke-width="pickedTraceIds.has(p.rowKey) ? 1.8 : 0.8"
              vector-effect="non-scaling-stroke"
              class="scatter-dot"
              @click="pickScatterDot(p, $event)"
            >
              <title>{{ p.label }} · {{ fmtMs(p.y) }}{{ pickedTraceIds.has(p.rowKey) ? ` · ${t('picked')}` : '' }}</title>
            </circle>
            <!-- Drag-select rectangle. -->
            <rect
              v-if="dragRect"
              :x="dragRect.x"
              :y="dragRect.y"
              :width="dragRect.w"
              :height="dragRect.h"
              fill="var(--sw-accent)"
              fill-opacity="0.12"
              stroke="var(--sw-accent)"
              stroke-width="1"
              stroke-dasharray="4 3"
              vector-effect="non-scaling-stroke"
              pointer-events="none"
            />
          </svg>
          <div class="scatter-x-axis">
            <span
              v-for="(t, i) in scatterXTicks"
              :key="`x${i}`"
              class="x-tick"
              :class="{ first: i === 0, last: i === scatterXTicks.length - 1 }"
            >{{ t.label }}</span>
          </div>
        </div>
        <div v-else class="scatter-empty">{{ t('no traces') }}</div>
      </section>
    </div>

    <!-- Persists across browse + detail so the active trace-query API
         (and what a row represents) stays visible after a click. -->
    <div v-if="showApiBanner" class="tr-api-banner">
      {{ t('This OAP serves traces via') }} <b>{{ t('Trace Query {label} API', { label: traceApiLabel }) }}</b>
      (<code>{{ native?.api }}</code>).
      <template v-if="isSegmentList">
        {{ t('Each row is a trace') }} <b>{{ t('segment') }}</b> — {{ t('click one to fetch its full trace.') }}
      </template>
      <template v-else>
        {{ t('Full traces are returned inline.') }}
      </template>
    </div>

    <!-- Browsing mode: full-width list when no trace is selected -->
    <template v-if="!selectedTraceId">
      <article class="tr-list-card sw-card">
        <header class="tr-list-head">
          <h4>{{ isSegmentList ? t('Segments') : t('Traces') }}</h4>
          <span v-if="native?.error" class="err-chip" :title="native.error">{{ t('unreachable') }}</span>
          <span v-if="native" class="hint">{{ native.traces.length }} {{ isSegmentList ? t('segments') : t('traces') }}</span>
        </header>
        <div v-if="!hasQueried" class="tr-empty">
          {{ t('Pick your conditions, then click Run query.') }}
        </div>
        <div v-else-if="!native || (native.reachable && native.traces.length === 0)" class="tr-empty">
          {{ t('No traces in window.') }}
        </div>
        <div v-else-if="isPicking && visibleTraces.length === 0" class="tr-empty">
          {{ t('No traces match the distribution selection.') }}
        </div>
        <ul v-else class="tr-rowlist">
          <li
            v-for="row in visibleTraces"
            :key="row.key"
            class="tr-row-card"
            :class="{ err: row.isError, ok: !row.isError }"
            @click="selectNative(row)"
          >
            <div class="tr-row-head">
              <span class="tr-ep mono" :class="{ red: row.isError, blue: !row.isError }">{{ row.endpointNames[0] ?? '—' }}</span>
              <span
                class="status-flag"
                :class="row.isError ? 'flag-err' : 'flag-ok'"
              >
                <span class="flag-dot" />
                {{ row.isError ? t('ERR') : t('OK') }}
              </span>
            </div>
            <div class="tr-row-bar" :title="t('{dur} ms — {pct}% of slowest', { dur: row.duration, pct: Math.round((row.duration / (maxTraceDuration || 1)) * 100) })">
              <div
                class="tr-row-bar-fill"
                :style="{
                  width: maxTraceDuration > 0 ? Math.max(2, (row.duration / maxTraceDuration) * 100) + '%' : '0%',
                  background: row.isError ? 'var(--sw-err)' : rowDurationColor(row.duration),
                }"
              />
              <span class="tr-row-bar-label mono">{{ row.duration }} ms</span>
            </div>
            <div class="tr-row-meta">
              <span class="mono dim trace-id-snip" :title="row.traceIds[0]">{{ (row.traceIds[0] ?? '').slice(0, 18) }}…</span>
              <span class="mono dim ml-auto">{{ fmtRelativeAgo(parseNativeStart(row.start)) }}</span>
            </div>
          </li>
        </ul>
      </article>

    </template>

    <!-- Inline detail: folded rail (left) + detail (right) -->
    <section v-else class="tr-detail-split" :class="{ 'rail-collapsed': !railOpen }">
      <aside class="tr-rail sw-card">
        <header class="tr-rail-head">
          <button class="rail-handle" type="button" :title="railOpen ? t('Collapse list') : t('Expand list')" @click="railOpen = !railOpen">
            <span v-if="railOpen">«</span><span v-else>»</span>
          </button>
          <h4 v-if="railOpen">{{ isSegmentList ? t('Segments') : t('Traces') }}</h4>
          <span v-if="railOpen && native" class="hint">{{ native.traces.length }}</span>
        </header>
        <ul v-if="railOpen && visibleTraces.length" class="tr-rowlist rail-list">
          <li
            v-for="row in visibleTraces"
            :key="row.key"
            class="tr-row-card compact"
            :class="{ on: selectedRowKey === row.key, err: row.isError, ok: !row.isError }"
            @click="selectNative(row)"
          >
            <div class="rail-row-top">
              <span
                class="dur-tag mono lg"
                :style="{
                  background: rowDurationColor(row.duration) + '22',
                  color: rowDurationColor(row.duration),
                }"
              >
                {{ row.duration }} ms
              </span>
              <span
                class="status-flag"
                :class="row.isError ? 'flag-err' : 'flag-ok'"
              >
                <span class="flag-dot" />
                {{ row.isError ? t('ERR') : t('OK') }}
              </span>
            </div>
            <div class="tr-ep rail-ep mono" :class="{ red: row.isError }">{{ row.endpointNames[0] ?? '—' }}</div>
            <div class="tr-row-meta">
              <span class="mono dim ml-auto">{{ fmtRelativeAgo(parseNativeStart(row.start)) }}</span>
            </div>
          </li>
        </ul>
        <!-- Folded rail: clickable progress bars per trace. Click
             switches the inline detail, doesn't expand the rail. -->
        <ul v-if="!railOpen && visibleTraces.length" class="rail-mini">
          <li
            v-for="row in visibleTraces"
            :key="row.key"
            class="rail-mini-row"
            :class="{ on: selectedRowKey === row.key }"
            :title="`${row.endpointNames[0] ?? '—'} · ${row.duration} ms · ${row.isError ? t('err') : t('ok')}`"
            @click="selectNative(row)"
          >
            <div class="rail-mini-bar">
              <div
                class="rail-mini-fill"
                :style="{
                  width: maxTraceDuration > 0 ? Math.max(8, (row.duration / maxTraceDuration) * 100) + '%' : '0%',
                  background: row.isError ? 'var(--sw-err)' : 'var(--sw-ok)',
                }"
              />
            </div>
          </li>
        </ul>
      </aside>

      <article class="tr-detail sw-card">
        <header class="tr-detail-head">
          <div class="tr-detail-title">
            <span class="dim">{{ t('trace') }}</span>
            <select v-if="selectedTraceIds.length > 1" :value="selectedTraceId ?? ''" class="trace-id-select mono" @change="changeSelectedTraceId(($event.target as HTMLSelectElement).value)">
              <option v-for="id in selectedTraceIds" :key="id" :value="id">{{ id }}</option>
            </select>
            <span v-else class="mono trace-id-text" :title="selectedTraceId ?? ''">{{ selectedTraceId }}</span>
            <button class="sw-btn small ghost copy-btn" type="button" :title="t('Copy trace id')" @click="copyTraceId">⧉ {{ t('id') }}</button>
            <button class="sw-btn small ghost copy-btn" type="button" :title="t('Copy shareable URL')" @click="copyShareableUrl">⧉ {{ t('url') }}</button>
            <transition name="copy-flash">
              <span v-if="copyFlash" class="copy-flash-chip">{{ copyFlash === 'url' ? t('url copied') : t('id copied') }}</span>
            </transition>
          </div>
          <div class="tr-detail-tools">
            <span v-if="detailFetching" class="hint">{{ t('loading…') }}</span>
            <div class="view-toggle">
              <button :class="['vt-btn', { on: viewMode === 'default' }]" type="button" @click="viewMode = 'default'">{{ t('Default') }}</button>
              <button :class="['vt-btn', { on: viewMode === 'tree' }]" type="button" @click="viewMode = 'tree'">{{ t('Tree') }}</button>
              <button :class="['vt-btn', { on: viewMode === 'statistics' }]" type="button" @click="viewMode = 'statistics'">{{ t('Statistics') }}</button>
            </div>
            <button class="sw-btn small ghost" type="button" :title="t('Back to list')" @click="closeDetail">×</button>
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

        <!-- Default view — single combined row. Each row has:
             • the service-coloured stripe on the left,
             • status flag + kind chip + component icon,
             • a band that carries the span name + peer with the
               start/duration bar drawn as the band's BACKGROUND
               (the colored region indicates when the span ran on
               the trace timeline),
             • the duration as a suffix on the right.
             Service code is conveyed by colour only — no text. -->
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
                   speech-bubble (producer/consumer), generic (other).
                   Same colour family as the bar. -->
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
              <!-- Name band — the bar is rendered as the band's
                   background (absolute), so the bar's left+width
                   encode the span's start+duration on the trace
                   timeline. Depth indent is rendered as faint
                   vertical guide lines on the band's left side
                   AND a flex spacer that shifts the text right,
                   so hierarchy reads visibly. The bar background
                   anchors to the band's full left edge — its
                   position is independent of the indent. -->
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

        <!-- Tree view — d3 horizontal flowing tree. Root left,
             children to the right; cards are connected by Bezier
             paths. Click a card to open the span detail modal.
             Wheel-zoom + drag-pan via d3.zoom; explicit +/-/⊙
             controls on the top-right of the canvas. -->
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
                     latency vs the trace's total duration. Colour from
                     latencyColor() bands. Clipped to the card's
                     rounded rect so the fill follows the card shape. -->
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
             Total / Avg / Max. Components are aggregated within each
             group; the top-3 icons render in a single cell. -->
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
    </section>

    <!-- Span detail modal (inline-detail flow). Cross-trace refs
         route through openTrace() → popout. -->
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
            v-if="(openSpan.refs ?? []).some((r) => r.traceId !== selectedTraceId)"
            class="sd-section"
          >
            <h5>{{ t('Cross-trace refs') }}</h5>
            <table class="kv-table">
              <thead><tr><th>{{ t('Trace ID') }}</th><th>{{ t('Parent segment') }}</th><th class="num">{{ t('Parent span') }}</th><th>{{ t('Ref type') }}</th></tr></thead>
              <tbody>
                <template v-for="(r, i) in openSpan.refs" :key="i">
                  <tr v-if="r.traceId !== selectedTraceId">
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
  </div>
</template>

<style scoped>
.tr-tab { display: flex; flex-direction: column; gap: 12px; padding: 4px 0 0; min-height: 0; }
.tr-top-strip {
  display: grid;
  grid-template-columns: 4fr 1fr;
  gap: 12px;
  align-items: stretch;
}
@media (max-width: 1100px) { .tr-top-strip { grid-template-columns: 1fr; } }
.tr-top-strip .tr-toolbar,
.tr-top-strip .tr-scatter { margin: 0; }
.tr-toolbar { padding: 10px 12px; display: flex; flex-direction: column; gap: 10px; }
.tr-toolbar-head { display: flex; align-items: baseline; gap: 10px; }
.tr-run-btn { margin-left: auto; }
.kicker {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--sw-accent);
  font-weight: 600;
}
.for-svc { font-size: 11.5px; color: var(--sw-fg-3); }
.for-svc b { color: var(--sw-fg-1); font-family: var(--sw-mono); font-weight: 500; }
.hint { font-size: 10.5px; color: var(--sw-fg-3); }
.tr-conditions {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px 10px;
}
@media (max-width: 900px) { .tr-conditions { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
.cf {
  display: flex;
  flex-direction: column;
  gap: 3px;
  font-size: 11px;
  color: var(--sw-fg-3);
  font-weight: 500;
  min-width: 0;
}
.cf.cf-wide { grid-column: span 2; }
.cf-input {
  height: 28px;
  padding: 0 8px;
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line-2);
  border-radius: 4px;
  color: var(--sw-fg-0);
  font: inherit;
  font-size: 11px;
  width: 100%;
  box-sizing: border-box;
}
.cf-input:disabled { opacity: 0.5; cursor: not-allowed; }
.cf-tas { display: block; width: 100%; }
.cf-tas :deep(.tas__trigger) {
  width: 100%;
  max-width: none;
  min-width: 0;
  height: 28px;
  padding: 0 8px;
  font-size: 11px;
  background: var(--sw-bg-2);
  border-radius: 4px;
}
.cf-range { display: flex; align-items: center; gap: 4px; }
.cf-range-num { flex: 1; min-width: 0; }
.cf-range-sep { color: var(--sw-fg-3); font-size: 12px; flex: 0 0 auto; }
.tr-tag-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding-top: 6px;
  border-top: 1px dashed var(--sw-line);
}
.tag-row-label { font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--sw-fg-3); }
.tag-chips { display: inline-flex; flex-wrap: wrap; gap: 4px; }
.tag-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 22px;
  padding: 0 6px;
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line-2);
  border-radius: 11px;
  font-size: 10.5px;
}
.tag-x {
  background: transparent;
  border: none;
  color: var(--sw-fg-3);
  cursor: pointer;
  font-size: 12px;
  line-height: 1;
  padding: 0;
}
.tag-x:hover { color: var(--sw-err); }

.sw-btn.primary {
  background: var(--sw-accent);
  color: var(--sw-bg-0);
  border: none;
  height: 26px;
  padding: 0 14px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
}
.sw-btn.small { height: 24px; padding: 0 10px; font-size: 11px; }
.sw-btn.ghost { background: transparent; border: 1px solid var(--sw-line-2); color: var(--sw-fg-2); }

/* Scatter — fills as much of the card as possible. Kicker + legend
   sit on one tight strip; the chart claims the rest. */
.tr-scatter {
  padding: 6px 10px 8px;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.tr-scatter-head { display: flex; align-items: baseline; gap: 10px; margin-bottom: 2px; flex: 0 0 auto; }
.tr-scatter-head .legend { margin-left: auto; font-size: 10.5px; color: var(--sw-fg-3); display: inline-flex; gap: 10px; align-items: center; }
.tr-scatter-head .lg {
  display: inline-block;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  margin-right: 3px;
  vertical-align: middle;
}
.tr-scatter-head .lg.ok { background: var(--sw-accent); }
.tr-scatter-head .lg.err { background: var(--sw-err); }
.scatter-tools { margin-left: 6px; display: inline-flex; gap: 4px; }
.pick-kicker {
  color: var(--sw-accent-2);
  font-weight: 700;
}
.reset-btn { margin-left: 6px; }
.pick-hint {
  background: var(--sw-accent-soft);
  color: var(--sw-accent-2);
  padding: 1px 6px;
  border-radius: 8px;
  font-weight: 600;
}
.scatter-svg { cursor: crosshair; }
.scatter-dot { cursor: pointer; }
.scatter-wrap {
  padding: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.scatter-svg {
  width: 100%;
  flex: 1;
  min-height: 140px;
  display: block;
}
.scatter-dot { cursor: pointer; transition: r 0.12s ease; }
.scatter-dot:hover { stroke: var(--sw-fg-0); stroke-width: 1.6; }
.scatter-x-axis {
  display: flex;
  justify-content: space-between;
  padding: 4px 0 0;
  font-size: 11px;
  color: var(--sw-fg-2);
  font-family: var(--sw-mono);
  flex: 0 0 auto;
}
.x-tick { white-space: nowrap; }
.x-tick.first { text-align: left; }
.x-tick.last { text-align: right; }
.scatter-empty {
  flex: 1;
  min-height: 140px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  color: var(--sw-fg-3);
}

/* Browsing list */
.tr-list-card { padding: 0; display: flex; flex-direction: column; }
.tr-list-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--sw-line);
  flex: 0 0 auto;
}
.tr-list-head h4 { margin: 0; font-size: 12px; font-weight: 600; color: var(--sw-fg-0); }
.tr-list-head .hint { margin-left: auto; }
.err-chip {
  font-size: 9px;
  font-weight: 700;
  padding: 1px 5px;
  border-radius: 3px;
  background: rgba(239, 68, 68, 0.18);
  color: var(--sw-err);
}
.tr-api-banner {
  padding: 7px 12px;
  border: 1px solid var(--sw-line);
  border-radius: 6px;
  background: var(--sw-bg-2);
  color: var(--sw-fg-2);
  font-size: 11px;
  line-height: 1.5;
}
.tr-api-banner code {
  font-family: var(--sw-mono);
  font-size: 10.5px;
  padding: 0 3px;
  border-radius: 3px;
  background: var(--sw-bg-3);
  color: var(--sw-accent);
}
.tr-api-banner b { color: var(--sw-fg-0); }
.tr-empty { padding: 24px; text-align: center; color: var(--sw-fg-3); font-size: 11.5px; }
.tr-rowlist {
  list-style: none;
  margin: 0;
  padding: 0;
  overflow-y: auto;
  flex: 1;
}
.tr-row-card {
  cursor: pointer;
  padding: 8px 14px;
  border-left: 3px solid transparent;
  border-bottom: 1px solid var(--sw-line);
}
.tr-row-card.compact { padding: 6px 10px; }
.tr-row-card.ok { border-left-color: var(--sw-ok); }
.tr-row-card.err { border-left-color: var(--sw-err); }
.tr-row-card:hover { background: var(--sw-bg-2); }
.tr-row-card.on { background: var(--sw-accent-soft); }
.tr-row-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 5px;
}
.tr-ep {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
  font-size: 12px;
  font-weight: 600;
}
.tr-ep.red { color: var(--sw-err); }
.tr-ep.blue { color: var(--sw-info); }
.tr-row-bar {
  position: relative;
  height: 10px;
  background: var(--sw-bg-2);
  border-radius: 3px;
  overflow: hidden;
  margin-bottom: 4px;
}
/* Bar fill is intentionally muted — the colour reads as a tint, not
   a saturated alert. Error traces (`.err`) keep the full saturation
   so they pop on the page. */
.tr-row-bar-fill {
  height: 100%;
  border-radius: 3px;
  transition: width 0.18s ease;
  opacity: 0.55;
}
.tr-row-card.err .tr-row-bar-fill { opacity: 0.9; }
.tr-row-bar-label {
  position: absolute;
  right: 6px;
  top: 50%;
  transform: translateY(-50%);
  font-size: 9.5px;
  color: var(--sw-fg-0);
  font-weight: 600;
  pointer-events: none;
  text-shadow: 0 0 2px var(--sw-bg-0);
}
.tr-row-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 10.5px;
}
.ml-auto { margin-left: auto; }
.trace-id-snip { max-width: 220px; overflow: hidden; text-overflow: ellipsis; }
.dur-tag {
  display: inline-block;
  padding: 1px 6px;
  border-radius: 3px;
  font-weight: 600;
  font-size: 10.5px;
}
.dur-tag.lg {
  padding: 3px 10px;
  font-size: 12px;
  font-weight: 700;
  border-radius: 4px;
  font-family: var(--sw-mono);
}
.rail-row-top {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 4px;
}
.rail-row-top .status-flag { margin-left: auto; }
.rail-ep {
  display: block;
  font-size: 11px;
  color: var(--sw-fg-1);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  margin-bottom: 2px;
}
.rail-ep.red { color: var(--sw-err); }
.tr-pager {
  display: flex;
  gap: 10px;
  align-items: center;
  justify-content: center;
}

/* Inline detail split — height is driven by the *content* of the
   detail card on the right. The rail on the left stretches to match
   (sticky to its scroll context). No fixed min/max-height: short
   traces stay compact, long ones make the page scroll. */
.tr-detail-split {
  display: grid;
  grid-template-columns: 320px 1fr;
  gap: 12px;
  align-items: start;
}
.tr-detail-split.rail-collapsed { grid-template-columns: 64px 1fr; }
.tr-rail {
  padding: 0;
  display: flex;
  flex-direction: column;
  position: sticky;
  top: 12px;
  max-height: calc(100vh - 80px);
  overflow: hidden;
}
.tr-rail-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--sw-line);
  flex: 0 0 auto;
}
.tr-rail-head h4 { margin: 0; font-size: 11.5px; font-weight: 600; color: var(--sw-fg-0); }
.tr-rail-head .hint { margin-left: auto; }
.rail-handle {
  background: transparent;
  border: 1px solid var(--sw-line-2);
  color: var(--sw-fg-2);
  width: 22px;
  height: 22px;
  border-radius: 3px;
  cursor: pointer;
  font-size: 12px;
  line-height: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.rail-handle:hover { color: var(--sw-accent); border-color: var(--sw-accent); }
.rail-list { padding: 0; }

/* Folded rail — wider clickable progress bars per trace. Bigger
   click target than the previous 36px column. */
.rail-mini {
  list-style: none;
  margin: 0;
  padding: 6px 4px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  overflow-y: auto;
  flex: 1;
}
.rail-mini-row {
  padding: 4px 6px;
  cursor: pointer;
  border-left: 2px solid transparent;
  border-radius: 2px;
}
.rail-mini-row:hover { background: var(--sw-bg-2); }
.rail-mini-row.on {
  background: var(--sw-accent-soft);
  border-left-color: var(--sw-accent);
}
.rail-mini-bar {
  height: 10px;
  background: var(--sw-bg-2);
  border-radius: 2px;
  overflow: hidden;
}
.rail-mini-fill {
  height: 100%;
  border-radius: 2px;
  transition: width 0.18s ease;
}

/* Detail card — height adapts to content. The card itself is a
   plain stack; each row list inside expands to fit its rows. The
   page (not the card) scrolls when the content runs long. */
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
   trace timeline). Depth indent is rendered as a flex spacer +
   faint vertical guide lines so call hierarchy is visible without
   moving the bar around. */
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

/* Tree view — d3 horizontal layout. Cards flow left-to-right with
   Bezier connectors. Scroll both axes when the tree exceeds the
   container; bigger traces produce wide layouts. */
.tr-tree-canvas {
  position: relative;
  padding: 12px;
  /* Canvas has a known viewport height (clamped to viewport-relative
     bounds). The SVG inside fills the canvas 100%/100% via
     preserveAspectRatio="xMidYMid meet" so the tree always fits;
     wheel/drag zoom takes you in from there. */
  height: clamp(420px, 60vh, 720px);
  background:
    linear-gradient(var(--sw-bg-1), var(--sw-bg-1)) padding-box,
    repeating-linear-gradient(
      45deg,
      transparent 0 8px,
      var(--sw-line) 8px 9px
    ) border-box;
}
.tree-svg { display: block; }
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
.tree-svg { cursor: grab; }
.tree-svg:active { cursor: grabbing; }
.tree-svg { display: block; }
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
/* Attached-event badge — uniform style; sits next to the peer
   on the Default row, and in the Stats components column. */
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
/* Statistics — components column. Stacks the top-3 component
   icons horizontally with their occurrence count. */
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

.dim { color: var(--sw-fg-3); }
.mono { font-family: var(--sw-mono); }
.wba { word-break: break-all; }

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
