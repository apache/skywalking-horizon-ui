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
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute } from 'vue-router';
import type { ZipkinTraceListRow } from '@skywalking-horizon-ui/api-client';

const { t } = useI18n({ useScope: 'global' });
import { useLayerZipkinTraces, useZipkinTrace } from '@/layer/traces/useZipkinTraces';
import { useZipkinTracePopout } from '@/layer/traces/useZipkinTracePopout';
import { readAccent } from '@/utils/cssVar';
import { bffClient } from '@/api/client';

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

// URL `?traceId=<id>` opens the popout directly (e.g. log-row link
// → trace jump). We just route those through the Zipkin popout state.
watch(
  () => route.query.traceId,
  (raw) => {
    const id = typeof raw === 'string' ? raw : null;
    if (id) openTrace(id);
  },
  { immediate: true },
);

// Zipkin's service universe is INDEPENDENT of SkyWalking's per-page
// service picker — different name index (no `<group>::` prefix, no
// `normal` flag, different list endpoint). We don't seed from the URL
// SkyWalking service; the input defaults to empty (= All services
// known to Zipkin) and the operator narrows by picking from the
// `/api/v2/services` dropdown.
//
// Auto-fire one query on landing so the table isn't empty on first
// arrival — runs with "All" so every layer (mesh / k8s / etc.) shows
// something immediately.
watch(layerKey, () => {
  if (!hasQueried.value) runQuery();
}, { immediate: true });

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
// trace-id input + URL-driven `?openZipkinTraceId=` still fall back
// to the popout for the "paste an id" / "share a link" flows.
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
const selectedRow = computed<ZipkinTraceListRow | null>(() => {
  if (!selectedTraceId.value) return null;
  return traces.value.find((t) => t.traceId === selectedTraceId.value) ?? null;
});
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
const selectedTraceIdRef = computed<string | null>(() => selectedTraceId.value);
const { spans: selectedSpans, isLoading: selectedLoading } = useZipkinTrace(selectedTraceIdRef);
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
  function walk(parentId: string, depth: number): void {
    for (const s of (byParent.get(parentId) ?? [])) {
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
/* Per-service color palette. First entry tracks `--sw-accent` so the
 * trace waterfall's brand color follows the active theme; the rest
 * stay constant because their job is "be distinct from each other"
 * across services, not "match brand". Rebuilt per call so theme
 * swaps land immediately on next render. */
function detailColor(name: string | null | undefined): string {
  if (!name) return 'var(--sw-fg-3)';
  const palette = [readAccent('#f97316'), '#60a5fa', '#a78bfa', '#22d3ee', '#f472b6', '#34d399', '#fbbf24', '#fb7185'];
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return palette[Math.abs(h) % palette.length]!;
}
function detailLeftPct(us: number): number {
  return Math.max(0, Math.min(100, (us / (detailBounds.value.totalUs || 1)) * 100));
}
function detailWidthPct(us: number): number {
  if (us <= 0) return 0.6;
  return Math.max(0.6, Math.min(100, (us / (detailBounds.value.totalUs || 1)) * 100));
}
function expandInPopout(): void {
  if (selectedTraceId.value) openTrace(selectedTraceId.value);
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

function fmtAbsTime(usSinceEpoch: number): string {
  if (!usSinceEpoch) return '—';
  const d = new Date(usSinceEpoch / 1000);
  return `${d.toLocaleTimeString('en-US', { hour12: false })}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

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
  return [...traces.value].sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
});
/** Largest duration in the visible set — drives the proportional
 *  fill of each row's duration bar. Matches the native trace tab's
 *  "% of slowest" presentation. */
const maxTraceDurationUs = computed<number>(() => {
  let m = 0;
  for (const t of traces.value) {
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
</script>

<template>
  <div class="ztr-tab">
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
        <!-- Service condition — free-text + datalist with All. Empty
             commits as `null` (= every service) to the Zipkin query. -->
        <label class="cf">
          <span>{{ t('Service') }}</span>
          <input
            v-model="zipkinServiceFilter"
            class="cf-input"
            type="text"
            :placeholder="t('All')"
            list="ztr-svc-suggest"
            @keyup.enter="runQuery"
          />
          <datalist id="ztr-svc-suggest">
            <option v-for="s in zipkinServiceOptions" :key="s" :value="s" />
          </datalist>
        </label>
        <label class="cf" :class="{ disabled: !hasService }">
          <span>{{ t('Remote service') }} <small v-if="!hasService" class="dim">— {{ t('pick a service') }}</small></span>
          <input
            v-model="remoteServiceName"
            class="cf-input"
            type="text"
            :placeholder="hasService ? t('any') : t('select a service first')"
            :disabled="!hasService"
            list="ztr-remote-svc-suggest"
            @keyup.enter="runQuery"
          />
          <datalist id="ztr-remote-svc-suggest">
            <option v-for="rs in remoteSvcOptions" :key="rs" :value="rs" />
          </datalist>
        </label>
        <label class="cf cf-wide" :class="{ disabled: !hasService }">
          <span>{{ t('Span name') }} <small v-if="!hasService" class="dim">— {{ t('pick a service') }}</small></span>
          <input
            v-model="spanName"
            class="cf-input"
            type="text"
            :placeholder="hasService ? t('any') : t('select a service first')"
            :disabled="!hasService"
            list="ztr-span-suggest"
            @keyup.enter="runQuery"
          />
          <datalist id="ztr-span-suggest">
            <option v-for="sp in spanNameOptions" :key="sp" :value="sp" />
          </datalist>
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
            <option :value="10">10</option>
            <option :value="30">30</option>
            <option :value="50">50</option>
            <option :value="100">100</option>
            <option :value="200">200</option>
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
          <code class="ztr-tid mono">{{ selectedTraceId.slice(0, 18) }}…</code>
          <span v-if="selectedRow" class="dim small">{{ fmtMs(selectedRow.duration) }} · {{ t('{n} spans', { n: selectedRow.spanCount }) }}</span>
          <button class="sw-btn small" type="button" @click="expandInPopout">{{ t('Expand') }}</button>
          <button class="sw-btn small ghost" type="button" @click="closeDetail">×</button>
        </header>
        <div v-if="selectedLoading" class="ztr-empty hint">{{ t('loading spans…') }}</div>
        <div v-else-if="detailRows.length === 0" class="ztr-empty">{{ t('No spans for this trace.') }}</div>
        <div v-else class="ztr-detail-body" :class="{ 'has-span': !!selectedSpan }">
          <div class="ztr-waterfall">
            <div
              v-for="row in detailRows"
              :key="row.span.id"
              class="ztr-wf-row"
              :class="{
                err: row.span.tags?.error != null,
                on: selectedSpanId === row.span.id,
              }"
              :title="row.span.name ?? ''"
              @click="selectSpan(row.span)"
            >
              <span class="ztr-wf-label mono" :style="{ paddingLeft: row.depth * 12 + 'px' }">
                <span class="ztr-wf-svc" :style="{ color: detailColor(row.span.localEndpoint?.serviceName) }">
                  {{ row.span.localEndpoint?.serviceName ?? '—' }}
                </span>
                <span class="ztr-wf-name">{{ row.span.name || t('(unnamed)') }}</span>
              </span>
              <div class="ztr-wf-track">
                <div
                  class="ztr-wf-bar"
                  :style="{
                    left: detailLeftPct(row.offsetUs) + '%',
                    width: detailWidthPct(row.durUs) + '%',
                    background: detailColor(row.span.localEndpoint?.serviceName),
                    borderColor: row.span.tags?.error != null ? 'var(--sw-err)' : 'transparent',
                  }"
                />
              </div>
              <span class="ztr-wf-dur mono">{{ fmtMs(row.durUs) }}</span>
            </div>
          </div>

          <!-- Lens-style span detail sidebar. Appears when a span is
               pinned; renders identity block + tags + annotation timeline. -->
          <aside v-if="selectedSpan" class="ztr-span-detail">
            <header class="ztr-span-detail-head">
              <h5>{{ t('Span detail') }}</h5>
              <button class="sw-btn small ghost" type="button" :title="t('Close')" @click="clearSpan">×</button>
            </header>
            <dl class="zk-kv">
              <dt>{{ t('Service') }}</dt>
              <dd
                class="mono"
                :style="{ color: detailColor(selectedSpan.localEndpoint?.serviceName) }"
              >
                {{ selectedSpan.localEndpoint?.serviceName ?? '—' }}
              </dd>
              <dt>{{ t('Name') }}</dt><dd class="mono wba">{{ selectedSpan.name || t('(unnamed)') }}</dd>
              <dt v-if="selectedSpan.kind">{{ t('Kind') }}</dt>
              <dd v-if="selectedSpan.kind">{{ selectedSpan.kind }}</dd>
              <dt>{{ t('Span id') }}</dt><dd class="mono wba">{{ selectedSpan.id }}</dd>
              <dt v-if="selectedSpan.parentId">{{ t('Parent id') }}</dt>
              <dd v-if="selectedSpan.parentId" class="mono wba">{{ selectedSpan.parentId }}</dd>
              <dt>{{ t('Start') }}</dt><dd class="mono">{{ fmtAbsTime(selectedSpan.timestamp ?? 0) }}</dd>
              <dt>{{ t('Duration') }}</dt><dd class="mono">{{ fmtMs(selectedSpan.duration ?? 0) }}</dd>
              <dt v-if="selectedSpan.remoteEndpoint?.serviceName">{{ t('Peer') }}</dt>
              <dd v-if="selectedSpan.remoteEndpoint?.serviceName" class="mono wba">
                {{ selectedSpan.remoteEndpoint.serviceName }}
              </dd>
              <dt v-if="selectedSpan.remoteEndpoint?.ipv4 || selectedSpan.remoteEndpoint?.ipv6">{{ t('Peer addr') }}</dt>
              <dd v-if="selectedSpan.remoteEndpoint?.ipv4 || selectedSpan.remoteEndpoint?.ipv6" class="mono wba">
                {{ selectedSpan.remoteEndpoint.ipv4 ?? selectedSpan.remoteEndpoint.ipv6
                  }}<template v-if="selectedSpan.remoteEndpoint.port">:{{ selectedSpan.remoteEndpoint.port }}</template>
              </dd>
            </dl>
            <section
              v-if="selectedSpan.tags && Object.keys(selectedSpan.tags).length > 0"
              class="zk-tags"
            >
              <h6>{{ t('Tags') }}</h6>
              <dl class="zk-kv">
                <template v-for="(v, k) in selectedSpan.tags" :key="k">
                  <dt class="mono">{{ k }}</dt>
                  <dd class="mono wba" :class="{ err: k === 'error' }">{{ v }}</dd>
                </template>
              </dl>
            </section>
            <section
              v-if="selectedSpan.annotations && selectedSpan.annotations.length > 0"
              class="zk-annotations"
            >
              <h6>{{ t('Annotations') }}</h6>
              <ul>
                <li v-for="(a, i) in selectedSpan.annotations" :key="i">
                  <span class="mono dim">{{ fmtAbsTime(a.timestamp) }}</span>
                  <span class="zk-ann-val mono">{{ a.value }}</span>
                </li>
              </ul>
            </section>
          </aside>
        </div>
      </article>
    </section>
  </div>
</template>

<style scoped>
.ztr-tab { display: flex; flex-direction: column; gap: 12px; padding: 4px 0 0; }
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
.ztr-split.has-detail {
  grid-template-columns: minmax(0, 1.4fr) minmax(360px, 1fr);
}
.ztr-detail {
  display: flex;
  flex-direction: column;
  max-height: 720px;
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
.ztr-tid { flex: 1; color: var(--sw-fg-2); font-size: 11px; }

/* When a span is pinned, the detail card splits into waterfall (left)
   + span-detail panel (right) — same layout as the popout. */
.ztr-detail-body {
  flex: 1;
  display: flex;
  min-height: 0;
  overflow: hidden;
}
.ztr-detail-body.has-span .ztr-waterfall {
  border-right: 1px solid var(--sw-line);
}
.ztr-span-detail {
  flex: 0 0 320px;
  overflow-y: auto;
  padding: 12px 14px;
  background: var(--sw-bg-1);
}
.ztr-span-detail-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}
.ztr-span-detail-head h5 {
  margin: 0;
  font-size: 12px;
  color: var(--sw-fg-0);
}
.zk-tags, .zk-annotations { margin-top: 12px; }
.zk-tags h6, .zk-annotations h6 {
  margin: 0 0 6px;
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--sw-fg-3);
  font-weight: 600;
}
.zk-kv {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 4px 12px;
  font-size: 11px;
  margin: 0;
}
.zk-kv dt { color: var(--sw-fg-3); }
.zk-kv dd { margin: 0; color: var(--sw-fg-1); }
.zk-kv dd.wba { word-break: break-all; }
.zk-kv dd.err { color: var(--sw-err); }
.zk-annotations ul {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.zk-annotations li {
  display: grid;
  grid-template-columns: 100px 1fr;
  gap: 8px;
  font-size: 10.5px;
}
.zk-annotations .dim { color: var(--sw-fg-3); }
.zk-ann-val { color: var(--sw-fg-1); word-break: break-all; }

@media (max-width: 1200px) {
  .ztr-span-detail { flex-basis: 260px; }
}
@media (max-width: 980px) {
  .ztr-detail-body { flex-direction: column; }
  .ztr-detail-body.has-span .ztr-waterfall { border-right: none; border-bottom: 1px solid var(--sw-line); }
  .ztr-span-detail { flex: 0 0 auto; max-height: 360px; }
}

/* Inline waterfall — each span is a row with `<label> <track> <dur>`.
   Track width is dynamic; the bar inside left/width % positions the
   span chronologically within the trace's window. Service color
   matches the popout palette so the two views read consistently. */
.ztr-waterfall {
  flex: 1 1 0;
  min-width: 0;
  overflow-y: auto;
}
.ztr-wf-row {
  display: grid;
  grid-template-columns: minmax(120px, 1fr) minmax(0, 2fr) 64px;
  gap: 8px;
  padding: 3px 12px;
  border-bottom: 1px solid var(--sw-line);
  align-items: center;
  cursor: pointer;
}
.ztr-wf-row:hover { background: var(--sw-bg-2); }
.ztr-wf-row.on {
  background: var(--sw-accent-soft);
  box-shadow: inset 2px 0 0 var(--sw-accent);
}
.ztr-wf-row.err { box-shadow: inset 3px 0 0 var(--sw-err); }
.ztr-wf-row.on.err { box-shadow: inset 3px 0 0 var(--sw-err), inset 0 0 0 1px var(--sw-accent); }
.ztr-wf-label {
  display: inline-flex;
  align-items: baseline;
  gap: 6px;
  font-size: 10.5px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}
.ztr-wf-svc {
  flex: 0 0 auto;
  font-weight: 700;
  max-width: 90px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ztr-wf-name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--sw-fg-1);
}
.ztr-wf-track {
  position: relative;
  height: 14px;
  background: var(--sw-bg-1);
  border-radius: 2px;
}
.ztr-wf-bar {
  position: absolute;
  top: 1px;
  bottom: 1px;
  border-radius: 2px;
  border: 1px solid transparent;
}
.ztr-wf-dur {
  font-size: 10px;
  text-align: right;
  color: var(--sw-fg-2);
  font-variant-numeric: tabular-nums;
}

@media (max-width: 1100px) {
  /* On narrow screens, fall back to stacked layout — the detail rail
     would crowd the table otherwise. */
  .ztr-split.has-detail { grid-template-columns: 1fr; }
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
  align-items: start;
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
</style>
