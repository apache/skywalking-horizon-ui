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
  Per-layer Traces tab — Zipkin source. Active for layers whose
  data path ships Zipkin-format spans (mesh / k8s — Envoy ALS, rover).
  Mirrors LayerTracesView's voice (run-query toolbar + condition grid
  + sortable list) but the wire shape is Zipkin v2 and the popout is
  the parent-id-walking ZipkinTracePopout.
-->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute } from 'vue-router';
import type { ZipkinTraceListRow } from '@skywalking-horizon-ui/api-client';

const { t } = useI18n({ useScope: 'global' });
import { useLayerZipkinTraces, useZipkinTrace } from '@/layer/traces/useZipkinTraces';
import { useZipkinTracePopout } from '@/layer/traces/useZipkinTracePopout';
import { bffClient } from '@/api/client';
import TypeaheadSelect from '@/components/primitives/TypeaheadSelect.vue';
import ZipkinTraceDetailCard from '@/render/widgets/ZipkinTraceDetailCard.vue';

// Zipkin trace data is keyed by its own service universe (the names
// reported in span `localEndpoint.serviceName`), not by SkyWalking's
// per-page service picker. This view deliberately does NOT read the
// URL-backed selected service or the layer's landing rows — those
// belong to the SkyWalking metric stack. Service filtering happens
// entirely through the operator's input + the Zipkin `/api/v2/services`
// autocomplete list.
const route = useRoute();
const layerKey = computed(() => String(route.params.layerKey ?? ''));

// ── Conditions ──────────────────────────────────────────────────
// Sentinel duration that means "use customStartMs / customEndMs
// instead of a preset window." Picked as -1 so it can't collide with
// any real ms value.
const CUSTOM_RANGE = -1;
const lookbackMs = ref<number>(30 * 60_000); // 30 min default
const TIME_PRESETS = computed<Array<{ label: string; ms: number }>>(() => [
  { label: t('Last 15 min'), ms: 15 * 60_000 },
  { label: t('Last 30 min'), ms: 30 * 60_000 },
  { label: t('Last 1 hour'), ms: 60 * 60_000 },
  { label: t('Last 3 hours'), ms: 3 * 60 * 60_000 },
  { label: t('Last 6 hours'), ms: 6 * 60 * 60_000 },
  { label: t('Last 12 hours'), ms: 12 * 60 * 60_000 },
  { label: t('Last 24 hours'), ms: 24 * 60 * 60_000 },
  { label: t('Custom range…'), ms: CUSTOM_RANGE },
]);
// `<input type="datetime-local">` produces "YYYY-MM-DDTHH:MM" in the
// browser's local zone (no seconds, no tz). We pre-seed with a sane
// pair (now − default lookback → now) so flipping to Custom shows
// readable values instead of an empty input.
function toLocalDtValue(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
const customStart = ref<string>(toLocalDtValue(Date.now() - 60 * 60_000));
const customEnd = ref<string>(toLocalDtValue(Date.now()));
const isCustomRange = computed(() => lookbackMs.value === CUSTOM_RANGE);
function parseLocalDt(v: string): number | null {
  if (!v) return null;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : null;
}
const limit = ref<number>(30);
const spanName = ref<string>('');
const remoteServiceName = ref<string>('');
const minDurationMs = ref<number | null>(null);
const maxDurationMs = ref<number | null>(null);
const annotationQuery = ref<string>('');
const traceIdInput = ref<string>('');
/**
 * The Zipkin query optionally narrows by serviceName. We default the
 * input to the page's selected service for ergonomic landing (so the
 * first query is scoped to what the operator is looking at), but the
 * input is fully editable — including blank for "all services".
 * Driven by `zipkinServiceFilter`, not the URL service picker.
 */
const zipkinServiceFilter = ref<string>('');
const zipkinServiceOptions = ref<string[]>([]);
/** Span-name / remote-service autocomplete inputs are service-scoped in
 *  Zipkin (`/api/v2/spans?serviceName=`, `/api/v2/remoteServices?serviceName=`).
 *  Lens-UI mirror: both inputs are disabled until a service is picked. */
const hasService = computed<boolean>(() => zipkinServiceFilter.value.trim().length > 0);

// Committed snapshot — only changes when Run query is clicked.
const cService = ref<string | null>(null);
const cLookback = ref<number>(lookbackMs.value);
const cEndTs = ref<number | null>(null); // absolute window end (ms), null = now
const cLimit = ref<number>(limit.value);
const cSpan = ref<string | null>(null);
const cRemote = ref<string | null>(null);
const cMinDurUs = ref<number | null>(null);
const cMaxDurUs = ref<number | null>(null);
const cAnno = ref<string | null>(null);
const hasQueried = ref<boolean>(false);
const queryEnabled = computed(() => hasQueried.value);

const { traces, isFetching, error, refetch } = useLayerZipkinTraces({
  serviceName: cService,
  remoteServiceName: cRemote,
  spanName: cSpan,
  minDuration: cMinDurUs,
  maxDuration: cMaxDurUs,
  endTs: cEndTs,
  lookback: cLookback,
  limit: cLimit,
  annotationQuery: cAnno,
  enabled: queryEnabled,
});
const { openTrace } = useZipkinTracePopout();

// hasQueried gate: a layer switch leaves cached `traces` stale until refetch.
const shownTraces = computed<ZipkinTraceListRow[]>(() => (hasQueried.value ? traces.value : []));

function runQuery(): void {
  // Service filter is now operator-driven (free-text + datalist), not
  // bound to the URL service picker. Empty = "All services" in
  // Zipkin's API — pass null and OAP returns the full set.
  cService.value = zipkinServiceFilter.value.trim() || null;
  // Time range — preset emits {endTs: now, lookback: preset}; Custom
  // commits absolute start/end → {endTs: end, lookback: end - start}.
  // Zipkin queries the window [endTs - lookback, endTs] so this is a
  // straightforward translation.
  if (isCustomRange.value) {
    const s = parseLocalDt(customStart.value);
    const e = parseLocalDt(customEnd.value);
    if (s != null && e != null && e > s) {
      cEndTs.value = e;
      cLookback.value = e - s;
    } else {
      cEndTs.value = null;
      cLookback.value = 30 * 60_000;
    }
  } else {
    cEndTs.value = null;
    cLookback.value = lookbackMs.value;
  }
  cLimit.value = limit.value;
  cSpan.value = spanName.value.trim() || null;
  cRemote.value = remoteServiceName.value.trim() || null;
  cAnno.value = annotationQuery.value.trim() || null;
  cMinDurUs.value = minDurationMs.value != null ? Math.max(0, minDurationMs.value * 1000) : null;
  cMaxDurUs.value = maxDurationMs.value != null ? Math.max(0, maxDurationMs.value * 1000) : null;
  hasQueried.value = true;
  void refetch();
}

// Zipkin's service universe is independent of SkyWalking's per-page
// picker; the input defaults to All-services and narrows via the
// /api/v2/services dropdown.

// No auto-fire (traces are expensive); a layer switch resets to the prompt.
watch(layerKey, () => {
  hasQueried.value = false;
  selectedTraceId.value = null;
  pickedTraceIds.value = new Set();
});

// Load the full Zipkin service list once for the filter dropdown.
// Best-effort: a failed fetch leaves the input as plain text.
async function loadServiceOptions(): Promise<void> {
  try {
    const res = await bffClient.zipkin.services();
    // De-duplicate (OAP sometimes returns the same name twice).
    zipkinServiceOptions.value = Array.from(new Set(Array.isArray(res) ? res : []));
  } catch { /* noop */ }
}
watch(layerKey, () => { void loadServiceOptions(); }, { immediate: true });

// ── Auto-complete for Span name / Remote service ─────────────────
// Mirrors Zipkin Lens's search pattern. The two endpoints are
// SERVICE-SCOPED in Zipkin (`/api/v2/spans?serviceName=` and
// `/api/v2/remoteServices?serviceName=`), so the options refresh as
// the operator types a service in the filter — same dependency
// chain Zipkin Lens follows. When the service is blank ("All"), we
// clear both lists because Zipkin doesn't expose a "all spans" /
// "all remotes" endpoint.
const spanNameOptions = ref<string[]>([]);
const remoteSvcOptions = ref<string[]>([]);
const serviceSelectOptions = computed(() => [
  { value: '', label: t('All') },
  ...zipkinServiceOptions.value.map((s) => ({ value: s, label: s })),
]);
const remoteSelectOptions = computed(() => [
  { value: '', label: t('any') },
  ...remoteSvcOptions.value.map((s) => ({ value: s, label: s })),
]);
const spanNameSelectOptions = computed(() => [
  { value: '', label: t('any') },
  ...spanNameOptions.value.map((s) => ({ value: s, label: s })),
]);
async function loadAutocomplete(svc: string): Promise<void> {
  if (!svc) {
    spanNameOptions.value = [];
    remoteSvcOptions.value = [];
    return;
  }
  try {
    const sp = await bffClient.zipkin.spans(svc);
    spanNameOptions.value = Array.isArray(sp) ? sp : [];
  } catch { spanNameOptions.value = []; }
  try {
    const rs = await bffClient.zipkin.remoteServices(svc);
    remoteSvcOptions.value = Array.isArray(rs) ? rs : [];
  } catch { remoteSvcOptions.value = []; }
}
// Debounce so typing doesn't fire on every keystroke. When the
// service is cleared we also reset the dependent fields — running a
// query with stale span/remote values against "All services" would
// otherwise silently filter out everything.
let autocompleteTimer: ReturnType<typeof setTimeout> | null = null;
watch(zipkinServiceFilter, (v) => {
  if (autocompleteTimer) clearTimeout(autocompleteTimer);
  const trimmed = v.trim();
  if (!trimmed) {
    spanName.value = '';
    remoteServiceName.value = '';
  }
  autocompleteTimer = setTimeout(() => { void loadAutocomplete(trimmed); }, 250);
}, { immediate: true });

// ── Annotation autocomplete ─────────────────────────────────────
// Zipkin annotation queries are `key` (presence) or `key=value`
// pairs, AND-joined with space. OAP exposes a pre-configured key set
// via `/api/v2/autocompleteKeys` + per-key values via
// `/api/v2/autocompleteValues?key=`. We mirror the log-tag pattern:
// one `<datalist>` for the annotations input, content swapping
// between known keys (before `=`) and per-key values (after).
const annotationKeyOptions = ref<string[]>([]);
const annotationValueOptions = ref<string[]>([]);
const annotationValueKey = ref<string>('');
async function loadAnnotationKeys(): Promise<void> {
  try {
    const res = await bffClient.zipkin.autocompleteKeys();
    annotationKeyOptions.value = Array.isArray(res) ? res : [];
  } catch { /* best-effort */ }
}
async function loadAnnotationValues(key: string): Promise<void> {
  if (!key || key === annotationValueKey.value) return;
  annotationValueKey.value = key;
  try {
    const res = await bffClient.zipkin.autocompleteValues(key);
    annotationValueOptions.value = Array.isArray(res) ? res : [];
  } catch { /* noop */ }
}
function onAnnotationInput(): void {
  // Operator can chain `k1=v1 k2=v2`; we look at the last token to
  // decide whether to show keys or values.
  const last = (annotationQuery.value.split(/\s+/).pop() ?? '').trim();
  const eq = last.indexOf('=');
  if (eq === -1) return; // keys datalist is active by default
  const key = last.slice(0, eq).trim();
  if (key) void loadAnnotationValues(key);
}
const annotationDatalistOptions = computed<string[]>(() => {
  const last = (annotationQuery.value.split(/\s+/).pop() ?? '').trim();
  const eq = last.indexOf('=');
  if (eq === -1) return annotationKeyOptions.value;
  const key = last.slice(0, eq).trim();
  return annotationValueOptions.value.map((v) => `${key}=${v}`);
});
// Eagerly load keys once we know the layer — keys aren't service-
// scoped, so a single load on mount is enough.
watch(layerKey, (k) => { if (k) void loadAnnotationKeys(); }, { immediate: true });

// ── Inline selection (list-left, detail-right) ──────────────────
// Mirrors `LayerTracesView`'s native pattern: a row click commits a
// selection to local state instead of opening the global popout.
// The selected trace's full spans render in the side rail. The
// trace-id input + URL-driven `?traceId=` still fall back to the
// popout for the "paste an id" / "share a link" flows.
const selectedTraceId = ref<string | null>(null);
function selectRow(row: ZipkinTraceListRow): void {
  selectedTraceId.value = row.traceId;
}
function closeDetail(): void {
  selectedTraceId.value = null;
}
/** Rail toggle — when a trace is selected, the result list collapses
 *  to a narrow rail with progress-bar-only entries (folder style).
 *  Click any bar to swap the inline detail without expanding back. */
const railOpen = ref<boolean>(true);
// Reset when the query parameters change so a stale selection
// doesn't outlive its result set.
watch([cService, cLookback, cLimit, cSpan, cRemote, cAnno], () => {
  selectedTraceId.value = null;
});

// Full Zipkin span set for the selected trace — rendered by the shared
// ZipkinTraceDetailCard (waterfall + KPIs + span modal).
const { spans: selectedSpans, isLoading: selectedLoading } = useZipkinTrace(selectedTraceId);

// Esc cascade: the detail card owns the span modal — close it first
// (via the card's `closeSpanModal`), then the inline detail.
const detailCard = ref<{ closeSpanModal: () => void } | null>(null);
const spanModalOpen = ref<boolean>(false);
function onPageKeyDown(e: KeyboardEvent): void {
  if (e.key !== 'Escape') return;
  if (spanModalOpen.value) {
    detailCard.value?.closeSpanModal();
    e.preventDefault();
    e.stopPropagation();
  } else if (selectedTraceId.value) {
    closeDetail();
    e.preventDefault();
    e.stopPropagation();
  }
}
onMounted(() => window.addEventListener('keydown', onPageKeyDown, true));
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onPageKeyDown, true);
  if (autocompleteTimer) clearTimeout(autocompleteTimer);
});

// ── Rendering helpers ───────────────────────────────────────────
function fmtMs(us: number | null): string {
  if (us == null) return '—';
  if (us < 1000) return `${us}μs`;
  if (us < 1_000_000) return `${(us / 1000).toFixed(2)}ms`;
  return `${(us / 1_000_000).toFixed(2)}s`;
}
// `fmtTime` removed — absolute start moved to `fmtRelativeAgo` in
// the row meta strip; the card layout drops the wall-clock column.
const sortedTraces = computed<ZipkinTraceListRow[]>(() => {
  const rows = pickedTraceIds.value.size > 0
    ? shownTraces.value.filter((r) => pickedTraceIds.value.has(r.traceId))
    : shownTraces.value;
  return [...rows].sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
});
/** Largest duration in the visible set — drives the proportional
 *  fill of each row's duration bar. Matches the native trace tab's
 *  "% of slowest" presentation. */
const maxTraceDurationUs = computed<number>(() => {
  let m = 0;
  for (const t of shownTraces.value) {
    if ((t.duration ?? 0) > m) m = t.duration ?? 0;
  }
  return m || 1;
});
/** Tint for a row's duration bar — green for fast, amber for mid,
 *  red for slow. Error rows override to red regardless. Matches the
 *  native list's `rowDurationColor` heuristic. */
function rowDurationColor(durUs: number): string {
  const max = maxTraceDurationUs.value || 1;
  const pct = durUs / max;
  if (pct > 0.75) return 'var(--sw-err)';
  if (pct > 0.4) return 'var(--sw-warn)';
  return 'var(--sw-ok)';
}
function fmtRelativeAgo(usSinceEpoch: number | null): string {
  if (!usSinceEpoch) return '';
  const seconds = Math.floor((Date.now() - usSinceEpoch / 1000) / 1000);
  if (seconds < 60) return t('{n}s ago', { n: seconds });
  if (seconds < 3600) return t('{n}m ago', { n: Math.floor(seconds / 60) });
  if (seconds < 86400) return t('{n}h ago', { n: Math.floor(seconds / 3600) });
  return t('{n}d ago', { n: Math.floor(seconds / 86400) });
}
function openByInput(): void {
  const v = traceIdInput.value.trim();
  if (v) openTrace(v);
}

// ── Duration scatter ──────────────────────────────────────────────
// x = trace start (µs since epoch), y = duration (µs). Click a dot to
// open the inline detail; drag a box to pick a set and filter the list.
interface ScatterPoint { id: string; x: number; y: number; isError: boolean; label: string; row: ZipkinTraceListRow; }
const scatterPoints = computed<ScatterPoint[]>(() =>
  shownTraces.value
    .filter((r): r is ZipkinTraceListRow & { timestamp: number; duration: number } =>
      r.timestamp != null && r.timestamp > 0 && r.duration != null && r.duration >= 0)
    .map((r) => ({
      id: r.traceId,
      x: r.timestamp,
      y: r.duration,
      isError: r.errorCount > 0,
      label: r.rootName ?? r.rootService ?? '—',
      row: r,
    })),
);
const scatterBounds = computed(() => {
  const pts = scatterPoints.value.filter((p) => p.x > 0 && Number.isFinite(p.y));
  if (pts.length === 0) return null;
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  return { xMin: Math.min(...xs), xMax: Math.max(...xs), yMin: 0, yMax: Math.max(...ys, 1) };
});
const scatterXTicks = computed(() => {
  const b = scatterBounds.value;
  if (!b) return [];
  const xCount = 3;
  const span = Math.max(1, b.xMax - b.xMin);
  return Array.from({ length: xCount }, (_, i) => {
    // x is µs since epoch — divide by 1000 for the JS Date.
    const d = new Date((b.xMin + (span * i) / (xCount - 1)) / 1000);
    const pad = (n: number) => String(n).padStart(2, '0');
    return { frac: i / (xCount - 1), label: `${pad(d.getHours())}:${pad(d.getMinutes())}` };
  });
});

// Clicking a dot opens the inline detail; dragging a box picks every
// dot inside it and the list narrows to the picked set — no extra
// query fires. Reset clears it.
const pickedTraceIds = ref<Set<string>>(new Set());
const isPicking = computed(() => pickedTraceIds.value.size > 0);
function resetPick(): void {
  pickedTraceIds.value = new Set();
}
// Drop a stale pick when the result set changes.
watch(traces, () => { pickedTraceIds.value = new Set(); });

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
  return {
    vx: ((ev.clientX - rect.left) / rect.width) * 1000,
    vy: ((ev.clientY - rect.top) / rect.height) * 1000,
  };
}
function onScatterDown(ev: PointerEvent): void {
  const pt = clientToViewbox(ev);
  if (!pt) return;
  const target = ev.target as Element | null;
  // Dot clicks are handled by the circle's own handler; drag is for the
  // empty plot area.
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
  // A click without movement leaves the selection untouched.
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
    if (cx >= vxMin && cx <= vxMax && cy >= vyMin && cy <= vyMax) next.add(p.id);
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
// Dot click opens the inline detail for that trace.
function pickScatterDot(p: ScatterPoint, ev: MouseEvent): void {
  ev.stopPropagation();
  selectRow(p.row);
}
</script>

<template>
  <div class="ztr-tab">
    <!-- Top strip: filter (80%) + duration distribution (20%). -->
    <div class="ztr-top-strip">
    <header class="ztr-toolbar sw-card">
      <div class="ztr-head">
        <span class="kicker">{{ t('Traces · Zipkin') }}</span>
        <span v-if="zipkinServiceFilter" class="for-svc">
          {{ t('service') }} <b class="mono">{{ zipkinServiceFilter }}</b>
        </span>
        <span v-else class="for-svc dim">{{ t('all services') }}</span>
        <span v-if="isCustomRange && customStart && customEnd" class="for-svc dim">
          · <b class="mono">{{ customStart.replace('T', ' ') }} → {{ customEnd.replace('T', ' ') }}</b>
        </span>
        <span v-if="isFetching" class="hint">{{ t('refreshing…') }}</span>
        <button class="sw-btn primary ztr-run-btn" type="button" @click="runQuery">{{ t('Run query') }}</button>
      </div>
      <div class="ztr-conditions">
        <!-- Service condition — on-theme TypeaheadSelect. Empty value
             commits as `null` (= every service) to the Zipkin query. -->
        <label class="cf">
          <span>{{ t('Service') }}</span>
          <TypeaheadSelect
            v-model="zipkinServiceFilter"
            :aria-label="t('Service')"
            :options="serviceSelectOptions"
            :placeholder="t('All')"
            class="cf-tas"
          />
        </label>
        <label class="cf" :class="{ disabled: !hasService }">
          <span>{{ t('Remote service') }} <small v-if="!hasService" class="dim">— {{ t('pick a service') }}</small></span>
          <TypeaheadSelect
            v-model="remoteServiceName"
            :aria-label="t('Remote service')"
            :options="remoteSelectOptions"
            :placeholder="hasService ? t('any') : t('select a service first')"
            :disabled="!hasService"
            class="cf-tas"
          />
        </label>
        <label class="cf cf-wide" :class="{ disabled: !hasService }">
          <span>{{ t('Span name') }} <small v-if="!hasService" class="dim">— {{ t('pick a service') }}</small></span>
          <TypeaheadSelect
            v-model="spanName"
            :aria-label="t('Span name')"
            :options="spanNameSelectOptions"
            :placeholder="hasService ? t('any') : t('select a service first')"
            :disabled="!hasService"
            class="cf-tas"
          />
        </label>
        <label class="cf">
          <span>{{ t('Min duration (ms)') }}</span>
          <input v-model.number.lazy="minDurationMs" class="cf-input" type="number" min="0" placeholder="—" />
        </label>
        <label class="cf">
          <span>{{ t('Max duration (ms)') }}</span>
          <input v-model.number.lazy="maxDurationMs" class="cf-input" type="number" min="0" placeholder="—" />
        </label>
        <label class="cf cf-wide">
          <span>{{ t('Annotations') }}</span>
          <input
            v-model="annotationQuery"
            class="cf-input mono"
            type="text"
            :placeholder="t('error or key=value, AND-joined')"
            list="ztr-annotation-suggest"
            @input="onAnnotationInput"
            @keyup.enter="runQuery"
          />
          <datalist id="ztr-annotation-suggest">
            <option v-for="opt in annotationDatalistOptions" :key="opt" :value="opt" />
          </datalist>
        </label>
        <label class="cf cf-wide">
          <span>{{ t('Open trace ID') }}</span>
          <input v-model="traceIdInput" class="cf-input mono" type="text" :placeholder="t('paste trace id…')" @keyup.enter="openByInput" />
        </label>
        <label class="cf">
          <span>{{ t('Limit') }}</span>
          <select v-model.number="limit" class="cf-input">
            <option :value="20">20</option>
            <option :value="30">30</option>
            <option :value="50">50</option>
            <option :value="100">100</option>
          </select>
        </label>
        <!-- Time range pinned to its own final row so the (optional)
             custom-range pair sits beside it on the same line. -->
        <label class="cf row-break">
          <span>{{ t('Time range') }}</span>
          <select v-model.number="lookbackMs" class="cf-input">
            <option v-for="p in TIME_PRESETS" :key="p.ms" :value="p.ms">{{ p.label }}</option>
          </select>
        </label>
        <!-- Custom-range inputs — show only when "Custom range…" is
             picked. `datetime-local` parses to the operator's local
             zone; we convert to ms-since-epoch on Run query. -->
        <label v-if="isCustomRange" class="cf">
          <span>{{ t('From') }}</span>
          <input
            v-model="customStart"
            class="cf-input mono"
            type="datetime-local"
            @keyup.enter="runQuery"
          />
        </label>
        <label v-if="isCustomRange" class="cf">
          <span>{{ t('To') }}</span>
          <input
            v-model="customEnd"
            class="cf-input mono"
            type="datetime-local"
            @keyup.enter="runQuery"
          />
        </label>
      </div>
    </header>

      <!-- Distribution: dots only. Click a dot to open its trace; drag
           a box to narrow the list. -->
      <section class="ztr-scatter sw-card">
        <header class="ztr-scatter-head">
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
              :r="pickedTraceIds.has(p.id) ? 6 : 3.2"
              :fill="p.isError ? 'var(--sw-err)' : 'var(--sw-accent)'"
              :fill-opacity="pickedTraceIds.has(p.id) ? 1 : (isPicking ? 0.35 : 0.9)"
              :stroke="pickedTraceIds.has(p.id) ? 'var(--sw-fg-0)' : (p.isError ? 'var(--sw-err)' : 'var(--sw-accent-2)')"
              :stroke-width="pickedTraceIds.has(p.id) ? 1.8 : 0.8"
              vector-effect="non-scaling-stroke"
              class="scatter-dot"
              @click="pickScatterDot(p, $event)"
            >
              <title>{{ p.label }} · {{ fmtMs(p.y) }}{{ pickedTraceIds.has(p.id) ? ` · ${t('picked')}` : '' }}</title>
            </circle>
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
              v-for="(tick, i) in scatterXTicks"
              :key="`x${i}`"
              class="x-tick"
              :class="{ first: i === 0, last: i === scatterXTicks.length - 1 }"
            >{{ tick.label }}</span>
          </div>
        </div>
        <div v-else class="scatter-empty">{{ t('no traces') }}</div>
      </section>
    </div>

    <!-- No selection — full-width list. Once an operator clicks a
         row, the section flips below to the rail+detail split. -->
    <section v-if="!selectedTraceId" class="ztr-split">
      <article class="ztr-list sw-card">
        <header class="ztr-list-head">
          <span class="kicker">{{ t('Results') }}</span>
          <span class="hint">{{ t('{n} traces', { n: sortedTraces.length }) }}</span>
        </header>
        <div v-if="error" class="banner err">
          <strong>{{ t('Zipkin query failed.') }}</strong> {{ String(error) }}
        </div>
        <div v-else-if="!hasQueried" class="ztr-empty">
          {{ t('Click Run query to fetch Zipkin traces for this service.') }}
        </div>
        <div v-else-if="sortedTraces.length === 0 && !isFetching" class="ztr-empty">
          {{ t('No Zipkin traces in the selected window. Widen the time range or relax conditions.') }}
        </div>
        <!-- Result cards — same shape as the SkyWalking native trace
             list. Each row carries: status flag at top, endpoint /
             root span name, a proportional duration bar (% of the
             slowest visible trace, color tinted by latency band, red
             on error), and a trace-id snippet + relative-time meta
             below. No raw "Service / Root span" columns — those bleed
             into the bar / meta rows so the list reads as cards. -->
        <ul v-else class="ztr-rowlist">
          <li
            v-for="r in sortedTraces"
            :key="r.traceId"
            class="ztr-row-card"
            :class="{ err: r.errorCount > 0, ok: r.errorCount === 0, on: selectedTraceId === r.traceId }"
            @click="selectRow(r)"
          >
            <div class="ztr-row-head">
              <span class="ztr-ep mono" :class="{ red: r.errorCount > 0, blue: r.errorCount === 0 }">
                {{ r.rootName ?? r.rootService ?? '—' }}
              </span>
              <span class="status-flag" :class="r.errorCount > 0 ? 'flag-err' : 'flag-ok'">
                <span class="flag-dot" />
                {{ r.errorCount > 0 ? t('ERR') : t('OK') }}
              </span>
            </div>
            <div
              class="ztr-row-bar"
              :title="t('{dur} — {pct}% of slowest', { dur: fmtMs(r.duration), pct: Math.round(((r.duration ?? 0) / (maxTraceDurationUs || 1)) * 100) })"
            >
              <div
                class="ztr-row-bar-fill"
                :style="{
                  width: maxTraceDurationUs > 0
                    ? Math.max(2, ((r.duration ?? 0) / maxTraceDurationUs) * 100) + '%'
                    : '0%',
                  background: r.errorCount > 0 ? 'var(--sw-err)' : rowDurationColor(r.duration ?? 0),
                }"
              />
              <span class="ztr-row-bar-label mono">{{ fmtMs(r.duration) }}</span>
            </div>
            <div class="ztr-row-meta">
              <span class="mono dim ztr-svc">{{ r.rootService ?? '—' }}</span>
              <span class="mono dim ztr-tid-snip" :title="r.traceId">{{ r.traceId.slice(0, 18) }}…</span>
              <span class="mono dim ml-auto">{{ fmtRelativeAgo(r.timestamp) }}</span>
            </div>
          </li>
        </ul>
      </article>
    </section>

    <!-- Selection mode — native trace pattern: a narrow rail of
         compact cards on the left + the detail (span tree) on the
         right. Rail can collapse to a column of progress bars for
         "folder style" navigation between traces without rebuilding
         the page layout. -->
    <section v-else class="ztr-detail-split" :class="{ 'rail-collapsed': !railOpen }">
      <aside class="ztr-rail sw-card">
        <header class="ztr-rail-head">
          <button class="rail-handle" type="button" :title="railOpen ? t('Collapse list') : t('Expand list')" @click="railOpen = !railOpen">
            <span v-if="railOpen">«</span><span v-else>»</span>
          </button>
          <h4 v-if="railOpen">{{ t('Traces') }}</h4>
          <span v-if="railOpen" class="hint">{{ sortedTraces.length }}</span>
        </header>
        <ul v-if="railOpen" class="ztr-rowlist rail-list">
          <li
            v-for="r in sortedTraces"
            :key="r.traceId"
            class="ztr-row-card compact"
            :class="{ on: selectedTraceId === r.traceId, err: r.errorCount > 0, ok: r.errorCount === 0 }"
            @click="selectRow(r)"
          >
            <div class="rail-row-top">
              <span
                class="dur-tag mono"
                :style="{ background: rowDurationColor(r.duration ?? 0) + '22', color: rowDurationColor(r.duration ?? 0) }"
              >{{ fmtMs(r.duration) }}</span>
              <span class="status-flag" :class="r.errorCount > 0 ? 'flag-err' : 'flag-ok'">
                <span class="flag-dot" />
                {{ r.errorCount > 0 ? t('ERR') : t('OK') }}
              </span>
            </div>
            <div class="ztr-ep rail-ep mono" :class="{ red: r.errorCount > 0 }">
              {{ r.rootName ?? r.rootService ?? '—' }}
            </div>
            <div class="ztr-row-meta">
              <span class="mono dim ml-auto">{{ fmtRelativeAgo(r.timestamp) }}</span>
            </div>
          </li>
        </ul>
        <!-- Folded rail: clickable progress bars per trace. Click
             switches the inline detail; doesn't expand the rail. -->
        <ul v-if="!railOpen" class="rail-mini">
          <li
            v-for="r in sortedTraces"
            :key="r.traceId"
            class="rail-mini-row"
            :class="{ on: selectedTraceId === r.traceId }"
            :title="`${r.rootName ?? r.rootService ?? '—'} · ${fmtMs(r.duration)} · ${r.errorCount > 0 ? t('err') : t('ok')}`"
            @click="selectRow(r)"
          >
            <div class="rail-mini-bar">
              <div
                class="rail-mini-fill"
                :style="{
                  width: maxTraceDurationUs > 0 ? Math.max(8, ((r.duration ?? 0) / maxTraceDurationUs) * 100) + '%' : '0%',
                  background: r.errorCount > 0 ? 'var(--sw-err)' : 'var(--sw-ok)',
                }"
              />
            </div>
          </li>
        </ul>
      </aside>

      <ZipkinTraceDetailCard
        ref="detailCard"
        :spans="selectedSpans"
        :trace-id="selectedTraceId"
        :loading="selectedLoading"
        @close="closeDetail"
        @update:modal-open="spanModalOpen = $event"
      />
    </section>
  </div>
</template>

<style scoped>
.ztr-tab { display: flex; flex-direction: column; gap: 12px; padding: 4px 0 0; }
.ztr-top-strip {
  display: grid;
  grid-template-columns: 4fr 1fr;
  gap: 12px;
  align-items: stretch;
}
@media (max-width: 1100px) { .ztr-top-strip { grid-template-columns: 1fr; } }
.ztr-top-strip .ztr-toolbar,
.ztr-top-strip .ztr-scatter { margin: 0; }
.ztr-toolbar { padding: 10px 12px; display: flex; flex-direction: column; gap: 10px; overflow: visible; }
.ztr-head { display: flex; align-items: baseline; gap: 10px; }
.ztr-run-btn { margin-left: auto; }
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
.ztr-conditions {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px 10px;
}
@media (max-width: 900px) { .ztr-conditions { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
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
/* Force-break: place the next condition at column 1 of a fresh row.
   Used to pin Time range (+ optional custom-range pair) to its own
   last line so the controls don't wrap mid-line. */
.cf.row-break { grid-column: 1 / span 1; }
@media (max-width: 900px) { .cf.row-break { grid-column: 1 / span 1; } }
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
.cf-input:focus { outline: none; border-color: var(--sw-accent-line); }
.cf-input:disabled {
  opacity: 0.5;
  cursor: not-allowed;
  background: var(--sw-bg-1);
}
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
.cf.disabled > span { color: var(--sw-fg-3); opacity: 0.7; }
.cf small { font-weight: 400; font-size: 9.5px; margin-left: 4px; font-style: italic; }
.cf .dim { color: var(--sw-fg-3); }
.mono { font-family: var(--sw-mono); }
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
.sw-btn.primary:disabled { opacity: 0.5; cursor: not-allowed; }
.sw-btn.primary:hover:not(:disabled) { background: var(--sw-accent-2); }

/* ── Duration distribution scatter ───────────────────────────────
   Ported from `LayerTracesView`'s `.tr-scatter` so the native +
   Zipkin trace tabs read identically. */
.ztr-scatter {
  padding: 6px 10px 8px;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.ztr-scatter-head { display: flex; align-items: baseline; gap: 10px; margin-bottom: 2px; flex: 0 0 auto; }
.ztr-scatter-head .legend { margin-left: auto; font-size: 10.5px; color: var(--sw-fg-3); display: inline-flex; gap: 10px; align-items: center; }
.ztr-scatter-head .lg {
  display: inline-block;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  margin-right: 3px;
  vertical-align: middle;
}
.ztr-scatter-head .lg.ok { background: var(--sw-accent); }
.ztr-scatter-head .lg.err { background: var(--sw-err); }
.pick-kicker { color: var(--sw-accent-2); font-weight: 700; }
.reset-btn { margin-left: 6px; }
.scatter-wrap {
  padding: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.scatter-svg {
  cursor: crosshair;
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

.ztr-list { display: flex; flex-direction: column; min-height: 240px; }
.ztr-list-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--sw-line);
}
.ztr-empty {
  padding: 36px;
  text-align: center;
  color: var(--sw-fg-3);
  font-size: 12px;
}
.banner.err {
  padding: 12px 16px;
  background: var(--sw-err-soft);
  border: 1px solid rgba(239,68,68,0.3);
  border-radius: 0;
  border-left: none;
  border-right: none;
  color: #f87171;
  font-size: 11.5px;
}
/* Card list — mirrors `LayerTracesView`'s `.tr-row-card` shape so
   native + Zipkin trace lists read identically (status flag, endpoint
   name, proportional duration bar, meta strip). */
.ztr-rowlist {
  list-style: none;
  margin: 0;
  padding: 0;
}
.ztr-row-card {
  cursor: pointer;
  padding: 8px 14px;
  border-left: 3px solid transparent;
  border-bottom: 1px solid var(--sw-line);
}
.ztr-row-card.ok { border-left-color: var(--sw-ok); }
.ztr-row-card.err { border-left-color: var(--sw-err); }
.ztr-row-card:hover { background: var(--sw-bg-2); }
.ztr-row-card.on { background: var(--sw-accent-soft); }
.ztr-row-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 5px;
}
.ztr-ep {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
  font-size: 12px;
  font-weight: 600;
}
.ztr-ep.red { color: var(--sw-err); }
.ztr-ep.blue { color: var(--sw-info); }
.ztr-row-bar {
  position: relative;
  height: 10px;
  background: var(--sw-bg-2);
  border-radius: 3px;
  overflow: hidden;
  margin-bottom: 4px;
}
.ztr-row-bar-fill {
  height: 100%;
  border-radius: 3px;
  transition: width 0.18s ease;
  opacity: 0.55;
}
.ztr-row-card.err .ztr-row-bar-fill { opacity: 0.9; }
.ztr-row-bar-label {
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
.ztr-row-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 10.5px;
}
.ztr-row-meta .dim { color: var(--sw-fg-3); }
.ztr-svc { max-width: 30%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ztr-tid-snip { max-width: 40%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ml-auto { margin-left: auto; }
/* Reused status-flag (matches the native list's badge). */
.status-flag {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 18px;
  padding: 0 6px;
  border-radius: 9px;
  font-size: 9.5px;
  font-weight: 700;
  letter-spacing: 0.04em;
  flex: 0 0 auto;
}
.status-flag .flag-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
}
.status-flag.flag-ok { background: rgba(34, 197, 94, 0.14); color: var(--sw-ok); }
.status-flag.flag-err { background: rgba(239, 68, 68, 0.18); color: var(--sw-err); }

/* Two-column split — single grid that collapses to one column when
   no row is selected, so the table claims full width on landing. */
.ztr-split {
  display: grid;
  grid-template-columns: 1fr;
  gap: 12px;
}
.dim { color: var(--sw-fg-3); }

@media (max-width: 1100px) {
  /* On narrow screens, fall back to stacked layout — the detail rail
     would crowd the table otherwise. */
  .ztr-detail-split { grid-template-columns: 1fr !important; }
}

/* ── Selection-mode layout (rail + detail) ───────────────────────
   Mirrors `LayerTracesView`'s `.tr-detail-split` shape so the
   native + Zipkin trace tabs behave identically when an operator
   drills into a row. */
.ztr-detail-split {
  display: grid;
  grid-template-columns: 320px 1fr;
  gap: 12px;
  /* `stretch` lets the two cards share the row height (max of each
     side's natural height, capped by their respective max-height
     rules). With `start` the right detail card collapsed to its
     content height while the rail extended down with many trace
     rows, producing a visibly mismatched pair. */
  align-items: stretch;
}
.ztr-detail-split.rail-collapsed { grid-template-columns: 64px 1fr; }
.ztr-rail {
  padding: 0;
  display: flex;
  flex-direction: column;
  position: sticky;
  top: 12px;
  max-height: calc(100vh - 80px);
  overflow: hidden;
}
.ztr-rail-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--sw-line);
  flex: 0 0 auto;
}
.ztr-rail-head h4 { margin: 0; font-size: 11.5px; font-weight: 600; color: var(--sw-fg-0); }
.ztr-rail-head .hint { margin-left: auto; }
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
.rail-list { padding: 0; overflow-y: auto; flex: 1; }
.ztr-row-card.compact { padding: 6px 10px; }

/* Folded rail — column of clickable progress bars (folder style). */
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

/* Compact-row pieces — duration chip, status row, endpoint line. */
.rail-row-top {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 4px;
}
.rail-row-top .status-flag { margin-left: auto; }
.dur-tag {
  display: inline-block;
  padding: 1px 6px;
  border-radius: 3px;
  font-weight: 600;
  font-size: 10.5px;
}
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

/* Small buttons (scatter Reset). */
.sw-btn.small {
  height: 22px;
  padding: 0 8px;
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line-2);
  color: var(--sw-fg-1);
  border-radius: 3px;
  font-size: 10.5px;
  cursor: pointer;
}
.sw-btn.small:hover { background: var(--sw-bg-3); border-color: var(--sw-accent); color: var(--sw-accent); }
.sw-btn.small.ghost {
  background: transparent;
  border-color: transparent;
  color: var(--sw-fg-3);
  width: 22px;
  padding: 0;
  font-size: 14px;
}
.sw-btn.small.ghost:hover { color: var(--sw-err); background: var(--sw-bg-2); }
</style>
