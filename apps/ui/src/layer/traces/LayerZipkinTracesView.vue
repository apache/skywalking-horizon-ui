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
function copyDetailTraceId(): void {
  if (!selectedTraceId.value) return;
  navigator.clipboard?.writeText(selectedTraceId.value).catch(() => {});
}
function copyDetailUrl(): void {
  if (!selectedTraceId.value || typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  url.searchParams.set('traceId', selectedTraceId.value);
  navigator.clipboard?.writeText(url.toString()).catch(() => {});
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

// ── Inline span tree for the selected trace ─────────────────────
// Fetches the full Zipkin span set + flattens into a depth-indented
// waterfall row list. Reused-but-simplified from `ZipkinTracePopout`:
// same parent-id walk, fewer per-row affordances since the rail is
// narrower than the popout.
const { spans: selectedSpans, isLoading: selectedLoading } = useZipkinTrace(selectedTraceId);
interface DetailRow { span: import('@skywalking-horizon-ui/api-client').ZipkinSpan; depth: number; offsetUs: number; durUs: number; }
const detailBounds = computed(() => {
  let t0 = Infinity;
  let t1 = -Infinity;
  for (const s of selectedSpans.value) {
    const start = s.timestamp ?? 0;
    const dur = s.duration ?? 0;
    if (start && start < t0) t0 = start;
    if (start && (start + dur) > t1) t1 = start + dur;
  }
  if (!Number.isFinite(t0)) t0 = 0;
  if (!Number.isFinite(t1) || t1 <= t0) t1 = t0 + 1;
  return { t0, t1, totalUs: t1 - t0 };
});
const detailRows = computed<DetailRow[]>(() => {
  const list = selectedSpans.value;
  if (list.length === 0) return [];
  const byParent = new Map<string, typeof list>();
  for (const s of list) {
    const p = s.parentId ?? '';
    if (!byParent.has(p)) byParent.set(p, [] as typeof list);
    (byParent.get(p) as typeof list).push(s);
  }
  for (const arr of byParent.values()) arr.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
  const out: DetailRow[] = [];
  const { t0 } = detailBounds.value;
  const visited = new Set<string>();
  function walk(parentId: string, depth: number): void {
    for (const s of (byParent.get(parentId) ?? [])) {
      if (visited.has(s.id)) continue; // guard against cyclic parentId chains
      visited.add(s.id);
      const start = s.timestamp ?? t0;
      out.push({ span: s, depth, offsetUs: start - t0, durUs: s.duration ?? 0 });
      walk(s.id, depth + 1);
    }
  }
  // Real roots have no parent or a parent missing from the set.
  const ids = new Set(list.map((s) => s.id));
  walk('', 0);
  for (const s of list) {
    if (!s.parentId) continue;
    if (ids.has(s.parentId)) continue;
    const start = s.timestamp ?? t0;
    out.push({ span: s, depth: 0, offsetUs: start - t0, durUs: s.duration ?? 0 });
    walk(s.id, 1);
  }
  return out;
});
// Palette + hash match the native trace detail (TracePopout).
const SERVICE_PALETTE = [
  'var(--sw-accent)', 'var(--sw-info)', 'var(--sw-cyan)', 'var(--sw-purple)',
  'var(--sw-ok)', 'var(--sw-warn)', 'var(--sw-pink)',
  '#a78bfa', '#fb7185', '#34d399', '#fbbf24', '#60a5fa',
];
function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function detailColor(name: string | null | undefined): string {
  if (!name) return 'var(--sw-fg-2)';
  return SERVICE_PALETTE[hashString(name) % SERVICE_PALETTE.length]!;
}
const detailServiceColors = computed<Map<string, string>>(() => {
  const m = new Map<string, string>();
  for (const s of selectedSpans.value) {
    const n = s.localEndpoint?.serviceName ?? '—';
    if (!m.has(n)) m.set(n, detailColor(n));
  }
  return m;
});
const detailRootStart = computed<number | null>(() => {
  const ts = selectedSpans.value.map((s) => s.timestamp ?? 0).filter(Boolean);
  return ts.length ? Math.min(...ts) : null;
});
function kindColor(k: string | null | undefined): string {
  const t = (k ?? '').toUpperCase();
  if (t.includes('SERVER')) return 'var(--sw-accent)';
  if (t.includes('CLIENT')) return 'var(--sw-info)';
  if (t.includes('PRODUCER') || t.includes('CONSUMER')) return 'var(--sw-purple)';
  return 'var(--sw-fg-2)';
}
// Zipkin/B3 timing codes → human label; unknown values render raw.
const ANNOTATION_LABELS: Record<string, string> = {
  cs: 'client send', cr: 'client receive',
  sr: 'server receive', ss: 'server send',
  ws: 'wire send', wr: 'wire receive',
  error: 'error',
};
function annotationHint(value: string): string | null {
  const label = ANNOTATION_LABELS[value.trim().toLowerCase()];
  return label ? t(label) : null;
}
function fmtDateTime(usSinceEpoch: number | null | undefined): string {
  if (!usSinceEpoch || !Number.isFinite(usSinceEpoch)) return '—';
  const d = new Date(usSinceEpoch / 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function detailLeftPct(us: number): number {
  return Math.max(0, Math.min(100, (us / (detailBounds.value.totalUs || 1)) * 100));
}
function detailWidthPct(us: number): number {
  if (us <= 0) return 0.8;
  return Math.max(0.8, Math.min(100, (us / (detailBounds.value.totalUs || 1)) * 100));
}

// ── Span detail (Lens-style inline panel) ───────────────────────
// Clicking a waterfall row pins that span. The panel mirrors Zipkin
// Lens's span sidebar: service header, key-value identity block,
// tag table, annotation timeline. Selection is local to the inline
// view — the popout has its own.
const selectedSpanId = ref<string | null>(null);
const selectedSpan = computed<import('@skywalking-horizon-ui/api-client').ZipkinSpan | null>(() => {
  if (!selectedSpanId.value) return null;
  return selectedSpans.value.find((s) => s.id === selectedSpanId.value) ?? null;
});
function selectSpan(s: import('@skywalking-horizon-ui/api-client').ZipkinSpan): void {
  selectedSpanId.value = selectedSpanId.value === s.id ? null : s.id;
}
function clearSpan(): void {
  selectedSpanId.value = null;
}
// Clear the pinned span when the operator switches trace.
watch(selectedTraceId, () => { selectedSpanId.value = null; });

// Dismiss the floating span-detail overlay on Escape or click-outside.
const spanDetailRef = ref<HTMLElement | null>(null);
function onSpanDetailDocClick(e: MouseEvent): void {
  if (!selectedSpan.value) return;
  const t = e.target as Element | null;
  if (!t) return;
  if (spanDetailRef.value?.contains(t)) return;
  clearSpan();
}
function onSpanDetailKey(e: KeyboardEvent): void {
  if (e.key === 'Escape' && selectedSpan.value) {
    e.stopPropagation();
    clearSpan();
  }
}
onMounted(() => {
  document.addEventListener('mousedown', onSpanDetailDocClick);
  document.addEventListener('keydown', onSpanDetailKey);
});
onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onSpanDetailDocClick);
  document.removeEventListener('keydown', onSpanDetailKey);
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

      <article class="ztr-detail sw-card">
        <header class="ztr-detail-head">
          <span class="kicker">{{ t('Trace') }}</span>
          <code class="ztr-tid mono" :title="selectedTraceId ?? ''">{{ selectedTraceId }}</code>
          <button class="sw-btn small copy-btn" type="button" :title="t('Copy trace id')" @click="copyDetailTraceId">⧉ {{ t('id') }}</button>
          <button class="sw-btn small copy-btn" type="button" :title="t('Copy shareable URL')" @click="copyDetailUrl">⧉ {{ t('url') }}</button>
          <span v-if="selectedLoading" class="hint">{{ t('loading…') }}</span>
          <button class="sw-btn small ghost ztr-detail-close" type="button" :title="t('Close')" @click="closeDetail">×</button>
        </header>
        <div v-if="selectedLoading" class="ztr-empty hint">{{ t('loading spans…') }}</div>
        <div v-else-if="detailRows.length === 0" class="ztr-empty">{{ t('No spans for this trace.') }}</div>
        <template v-else>
          <div class="ztr-kpis">
            <div><div class="kpi-label">{{ t('started') }}</div><div class="kpi-val">{{ fmtDateTime(detailRootStart) }}</div></div>
            <div><div class="kpi-label">{{ t('duration') }}</div><div class="kpi-val">{{ fmtMs(detailBounds.totalUs) }}</div></div>
            <div><div class="kpi-label">{{ t('spans') }}</div><div class="kpi-val">{{ detailRows.length }}</div></div>
            <div><div class="kpi-label">{{ t('services') }}</div><div class="kpi-val">{{ detailServiceColors.size }}</div></div>
          </div>
          <div v-if="detailServiceColors.size > 0" class="ztr-svc-legend">
            <span v-for="[code, color] in detailServiceColors" :key="code" class="svc-chip">
              <span class="svc-swatch" :style="{ background: color }" />
              <span class="mono">{{ code }}</span>
            </span>
          </div>
          <div class="ztr-detail-body">
            <div class="ztr-waterfall">
              <div class="tp-time-axis">
                <span class="t-tick first">0</span>
                <span class="t-tick">{{ fmtMs(detailBounds.totalUs * 0.25) }}</span>
                <span class="t-tick">{{ fmtMs(detailBounds.totalUs * 0.5) }}</span>
                <span class="t-tick">{{ fmtMs(detailBounds.totalUs * 0.75) }}</span>
                <span class="t-tick last">{{ fmtMs(detailBounds.totalUs) }}</span>
              </div>
              <div
                v-for="row in detailRows"
                :key="row.span.id"
                class="tp-row"
                :class="{ err: row.span.tags?.error != null, on: selectedSpanId === row.span.id }"
                @click="selectSpan(row.span)"
              >
                <div class="tp-track">
                  <span class="t-grid q1" /><span class="t-grid q2" /><span class="t-grid q3" />
                  <div
                    class="tp-bar"
                    :style="{
                      left: detailLeftPct(row.offsetUs) + '%',
                      width: detailWidthPct(row.durUs) + '%',
                      background: detailColor(row.span.localEndpoint?.serviceName),
                      borderColor: row.span.tags?.error != null ? 'var(--sw-err)' : 'transparent',
                    }"
                  >
                    <span class="bar-inner">
                      <span
                        class="status-flag sm"
                        :class="row.span.tags?.error != null ? 'flag-err' : 'flag-ok'"
                        :title="row.span.tags?.error != null ? t('Span errored') : t('Span OK')"
                      ><span class="flag-dot" /></span>
                      <svg class="comp-icon comp-icon-generic" viewBox="0 0 18 18" :aria-label="t('generic span')">
                        <rect x="3" y="4.5" width="12" height="3" rx="1.5" fill="currentColor" opacity="0.45" />
                        <rect x="5" y="10.5" width="10" height="3" rx="1.5" fill="currentColor" opacity="0.85" />
                      </svg>
                      <span class="bar-text mono">
                        <span class="bar-svc" :title="row.span.localEndpoint?.serviceName ?? ''">{{ row.span.localEndpoint?.serviceName ?? '—' }}</span>
                        <span class="bar-name" :title="row.span.name || row.span.remoteEndpoint?.serviceName || '—'">{{ row.span.name || row.span.remoteEndpoint?.serviceName || '—' }}</span>
                      </span>
                      <span v-if="detailWidthPct(row.durUs) > 12" class="bar-dur-inside mono">{{ fmtMs(row.durUs) }}</span>
                    </span>
                  </div>
                  <span
                    v-if="detailWidthPct(row.durUs) <= 12"
                    class="bar-dur-outside mono"
                    :style="{ left: `calc(${detailLeftPct(row.offsetUs + row.durUs)}% + 6px)` }"
                  >{{ fmtMs(row.durUs) }}</span>
                </div>
              </div>
            </div>

          <!-- Span detail opens as a centered modal (max-width 920px) so
               it can render long tag values without compressing the
               waterfall bars. Click ×, click the same span, or pick
               another span to dismiss / swap. -->
          <div v-if="selectedSpan" class="span-modal-backdrop">
            <article ref="spanDetailRef" class="span-modal sw-card">
            <header class="span-modal-head">
              <h4><span class="dim">{{ t('Span detail') }}</span> <span class="mono">{{ selectedSpan.name || '—' }}</span></h4>
              <button class="sw-btn small ghost" type="button" :title="t('Close')" @click="clearSpan">×</button>
            </header>
            <div class="span-modal-body">
            <section class="sd-section">
              <h6>{{ t('Meta') }}</h6>
              <dl class="kv">
                <dt>{{ t('Service') }}</dt>
                <dd class="mono" :style="{ color: detailColor(selectedSpan.localEndpoint?.serviceName) }">
                  <span class="svc-swatch inline" :style="{ background: detailColor(selectedSpan.localEndpoint?.serviceName) }" />
                  {{ selectedSpan.localEndpoint?.serviceName ?? '—' }}
                </dd>
                <dt>{{ t('Name') }}</dt><dd class="mono wba">{{ selectedSpan.name || '—' }}</dd>
                <dt>{{ t('Kind') }}</dt><dd><span class="tp-kind" :style="{ color: kindColor(selectedSpan.kind) }">{{ selectedSpan.kind ?? '—' }}</span></dd>
                <dt>{{ t('Peer') }}</dt><dd class="mono wba">{{ selectedSpan.remoteEndpoint?.serviceName || '—' }}</dd>
                <dt v-if="selectedSpan.remoteEndpoint?.ipv4 || selectedSpan.remoteEndpoint?.ipv6">{{ t('Peer addr') }}</dt>
                <dd v-if="selectedSpan.remoteEndpoint?.ipv4 || selectedSpan.remoteEndpoint?.ipv6" class="mono wba">{{ selectedSpan.remoteEndpoint?.ipv4 ?? selectedSpan.remoteEndpoint?.ipv6 }}<template v-if="selectedSpan.remoteEndpoint?.port">:{{ selectedSpan.remoteEndpoint.port }}</template></dd>
                <dt>{{ t('Span id') }}</dt><dd class="mono wba">{{ selectedSpan.id }}</dd>
                <dt v-if="selectedSpan.parentId">{{ t('Parent id') }}</dt>
                <dd v-if="selectedSpan.parentId" class="mono wba">{{ selectedSpan.parentId }}</dd>
                <dt>{{ t('Start') }}</dt><dd class="mono">{{ fmtDateTime(selectedSpan.timestamp) }}</dd>
                <dt>{{ t('Duration') }}</dt><dd class="mono">{{ fmtMs(selectedSpan.duration ?? 0) }}</dd>
                <dt>{{ t('Error') }}</dt><dd><span class="status-flag" :class="selectedSpan.tags?.error != null ? 'flag-err' : 'flag-ok'"><span class="flag-dot" />{{ selectedSpan.tags?.error != null ? t('true') : t('false') }}</span></dd>
              </dl>
            </section>
            <section v-if="selectedSpan.tags && Object.keys(selectedSpan.tags).length > 0" class="sd-section">
              <h6>{{ t('Tags') }}</h6>
              <dl class="kv">
                <template v-for="(v, k) in selectedSpan.tags" :key="k">
                  <dt class="mono">{{ k }}</dt>
                  <dd class="mono wba" :class="{ err: k === 'error' }">{{ v }}</dd>
                </template>
              </dl>
            </section>
            <section v-if="selectedSpan.annotations && selectedSpan.annotations.length > 0" class="sd-section">
              <h6>{{ t('Annotations') }}</h6>
              <div v-for="(a, i) in selectedSpan.annotations" :key="i" class="span-event">
                <div class="span-event-head">
                  <span class="mono">{{ a.value }}<span v-if="annotationHint(a.value)" class="ann-hint" :title="annotationHint(a.value) ?? ''"> ({{ annotationHint(a.value) }})</span></span>
                  <span class="dim mono">{{ fmtDateTime(a.timestamp) }}</span>
                </div>
              </div>
            </section>
            </div>
            </article>
          </div>
          </div>
        </template>
      </article>
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
.ztr-detail {
  display: flex;
  flex-direction: column;
  /* Match the rail's sticky viewport-anchored height so the two cards
     read as equal-height side-by-side. Without this they sized to
     content independently (rail was viewport-tall, detail capped at
     720px) and looked visually mismatched. */
  position: sticky;
  top: 12px;
  max-height: calc(100vh - 80px);
  min-height: 240px;
  overflow: hidden;
}
.ztr-detail-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--sw-line);
}
.ztr-tid { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--sw-fg-2); font-size: 11px; }
.ztr-detail-close { margin-left: auto; }

.ztr-detail-body {
  flex: 1;
  position: relative;
  display: flex;
  min-height: 0;
  overflow: hidden;
}
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
.sd-section { margin-bottom: 14px; }
.sd-section h6 {
  margin: 0 0 6px;
  font-size: 9.5px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--sw-accent);
  font-weight: 700;
}
.kv {
  display: grid;
  grid-template-columns: 100px 1fr;
  gap: 4px 10px;
  margin: 0;
  font-size: 11px;
}
.kv dt { color: var(--sw-fg-3); font-size: 10.5px; min-width: 0; overflow-wrap: anywhere; }
.kv dd { margin: 0; color: var(--sw-fg-1); min-width: 0; }
.kv dd.wba { word-break: break-all; }
.kv dd.err { color: var(--sw-err); }
.tp-kind { font-family: var(--sw-mono); font-size: 11px; font-weight: 600; }
.span-event {
  border: 1px solid var(--sw-line);
  border-radius: 4px;
  padding: 6px 10px;
  margin-bottom: 6px;
  background: var(--sw-bg-0);
}
.span-event-head {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  font-size: 11px;
}
.ann-hint { color: var(--sw-fg-3); }
.dim { color: var(--sw-fg-3); }
.wba { word-break: break-all; }

/* Inline waterfall — each span is a row with `<label> <track> <dur>`.
   Track width is dynamic; the bar inside left/width % positions the
   span chronologically within the trace's window. Service color
   matches the popout palette so the two views read consistently. */
.ztr-waterfall {
  flex: 1 1 0;
  min-width: 0;
  /* overflow-y:auto forces x:auto; clip x (full-width bar's duration renders inside). */
  overflow-x: hidden;
  overflow-y: auto;
  padding: 4px 0;
}
.ztr-kpis {
  display: flex;
  gap: 24px;
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
  font-size: 13px;
  color: var(--sw-fg-0);
  font-weight: 700;
}
.ztr-svc-legend {
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
.svc-swatch { width: 8px; height: 8px; border-radius: 2px; flex: 0 0 auto; }
.svc-swatch.inline { display: inline-block; margin-right: 4px; vertical-align: middle; }
.tp-time-axis {
  position: sticky;
  top: 0;
  z-index: 10;
  display: flex;
  justify-content: space-between;
  padding: 6px 12px;
  background-color: var(--sw-bg-1);
  border-bottom: 1px solid var(--sw-line);
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.35);
  font-family: var(--sw-mono);
  font-size: 10px;
  color: var(--sw-fg-3);
}
.t-tick { white-space: nowrap; }
.t-tick.first { text-align: left; }
.t-tick.last { text-align: right; }
.tp-row { padding: 3px 12px; cursor: pointer; }
.tp-row:hover { background: var(--sw-bg-2); }
.tp-row.err { background: rgba(239, 68, 68, 0.06); }
.tp-row.on { background: var(--sw-accent-soft); }
.tp-track { position: relative; height: 22px; background: transparent; }
.t-grid {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 1px;
  background: var(--sw-line);
  opacity: 0.55;
  pointer-events: none;
}
.t-grid.q1 { left: 25%; }
.t-grid.q2 { left: 50%; }
.t-grid.q3 { left: 75%; }
.tp-bar {
  position: absolute;
  top: 2px;
  bottom: 2px;
  border-radius: 3px;
  border: 1px solid transparent;
  display: flex;
  align-items: center;
  overflow: hidden;
  cursor: pointer;
  transition: filter 0.12s ease;
}
.tp-bar:hover { filter: brightness(1.12); }
.bar-inner {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 0 6px;
  height: 100%;
  width: 100%;
  min-width: 0;
}
.bar-text {
  display: inline-flex;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
  flex: 1 1 auto;
  overflow: hidden;
  color: var(--sw-bg-0);
  text-shadow: 0 0 1px rgba(0, 0, 0, 0.25);
}
.bar-svc {
  font-weight: 700;
  font-size: 10.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 0 1 auto;
  max-width: 40%;
  opacity: 0.9;
}
.bar-name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  font-weight: 500;
}
.comp-icon { width: 18px; height: 18px; flex: 0 0 auto; object-fit: contain; background: transparent; }
.comp-icon-generic { color: var(--sw-fg-2); }
.bar-inner .comp-icon-generic { color: rgba(0, 0, 0, 0.72); }
.bar-inner .status-flag.sm { background: rgba(255, 255, 255, 0.35); color: var(--sw-bg-0); }
.bar-inner .status-flag.flag-err { background: var(--sw-err); color: #fff; }
.bar-dur-outside {
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  font-size: 10px;
  color: var(--sw-fg-2);
  white-space: nowrap;
  pointer-events: none;
}
.bar-dur-inside {
  flex: 0 0 auto;
  margin-left: auto;
  padding-left: 8px;
  font-size: 10px;
  color: var(--sw-bg-0);
  opacity: 0.82;
  white-space: nowrap;
}
.status-flag.sm { height: 12px; width: 12px; padding: 0; border-radius: 50%; justify-content: center; }
.status-flag.sm .flag-dot { margin: 0; }

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

/* Detail-head buttons + small-text affordance. */
.small { font-size: 10.5px; }
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
.sw-btn.small.copy-btn { background: transparent; color: var(--sw-fg-2); white-space: nowrap; }
</style>
