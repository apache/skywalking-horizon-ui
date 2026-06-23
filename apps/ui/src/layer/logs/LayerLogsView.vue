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
  Per-layer Logs tab — Loki / Datadog visualization style.
   - Condition bar with the scoping chips + free-text keyword search.
   - Time-bucketed density histogram (60 bins) across the top, stacked
     by level (error / warn / info / debug / unknown).
   - Faceted sidebar with level + service breakdowns (counts derived
     from the loaded page).
   - Dense stream: one row per log; click expands inline showing the
     full payload (auto-detected as JSON or text) + tags + trace link.
-->
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import type { LayerDef, LogRow, LogTagFilter } from '@/api/client';
import { useLayerLanding } from '@/layer/useLayerLanding';
import { useLayerLogs, useLayerLogFacets } from '@/layer/logs/useLayerLogs';
import { bffClient } from '@/api/client';
import { useLayerInstances } from '@/layer/useLayerInstances';
import { useLayerEndpoints } from '@/layer/useLayerEndpoints';
import { useLayers } from '@/shell/useLayers';
import { useSelectedService } from '@/layer/useSelectedService';
import { useSelectedInstance } from '@/layer/useSelectedInstance';
import { useSelectedEndpoint } from '@/layer/useSelectedEndpoint';
import { useLayerServiceName } from '@/layer/useLayerServiceName';
import { useSetupStore } from '@/state/setup';
import { useTracePopout } from '@/layer/traces/useTracePopout';
import { parseServiceName } from '@/utils/serviceName';

const route = useRoute();
const layerKey = computed(() => String(route.params.layerKey ?? ''));
const { openTrace } = useTracePopout();

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
    const first = rows[0];
    if (!first) return;
    // Auto-pick only when nothing is selected. A valid tail selection
    // (not in landing's sampled top-N) must NOT be clobbered back to the
    // first sampled row — the shell recovers genuinely-stale ids against
    // the full roster.
    if (!selectedId.value) {
      setSelectedService(first.serviceId);
    }
  },
  { immediate: true },
);

// ── Log scope (per-layer config) ───────────────────────────────────
// Drives which condition selectors the conditions bar surfaces.
// Mirrors booster-ui's ConditionTags / EntityType routing:
//   - 'service'  → instance + endpoint selectors (both optional)
//   - 'instance' → endpoint selector only (instance is pinned)
//   - 'endpoint' → instance selector only (endpoint is pinned)
const logScope = computed<'service' | 'instance' | 'endpoint'>(
  () => layer.value?.log?.scope ?? 'service',
);
// Instance + endpoint selectors render unconditionally now (with All
// as the default). `showEndpointSelector` still gates whether the
// combobox lists an `All` row — for endpoint-pinned layers picking
// "All" doesn't make sense.
const showEndpointSelector = computed(() => logScope.value !== 'endpoint');

// ── Instance picker. Always queries OAP's instance list; how the
// picked value is used depends on `logScope`:
//   - `instance` scope: pinned — the picker is the primary entity
//     selector for the page.
//   - `service` scope: optional narrower; null means "all instances".
//   - `endpoint` scope: optional narrower as well.
const { selectedInstance, setSelectedInstance } = useSelectedInstance();
const { instances: instanceList } = useLayerInstances(layerKey, serviceName);
// Logs (and traces) intentionally do NOT auto-select an instance.
// Default is `All` so the stream starts broad; the operator opts into
// narrowing by picking from the dropdown. Auto-selection is reserved
// for metrics-scope pages (instance / endpoint dashboards), where a
// chosen entity is needed to render the metric widgets at all.
watch(serviceName, (next, prev) => {
  if (prev !== undefined && next !== prev && selectedInstance.value) {
    setSelectedInstance(null);
  }
});
const selectedInstanceObj = computed(() =>
  selectedInstance.value
    ? instanceList.value.find((i) => i.name === selectedInstance.value) ?? null
    : null,
);
const instanceIdForQuery = computed<string | null>(() => selectedInstanceObj.value?.id ?? null);

// ── Endpoint picker. Same shape — pinned when `logScope === 'endpoint'`,
// optional narrower otherwise. Endpoint lists are unbounded so the
// picker uses a search-keyword model (Enter to commit).
const { selectedEndpoint, setSelectedEndpoint } = useSelectedEndpoint();
// Endpoint search-and-select combobox. The input acts as both the
// search field (filters the OAP `findEndpoint` query via the debounced
// `endpointQuery`) AND the displayed selection. The dropdown opens
// on focus / typing and closes on click-outside or after a pick.
const endpointSearchInput = ref('');
const endpointQuery = ref('');
const endpointLimit = ref(20);
const endpointComboOpen = ref(false);
const endpointComboEl = ref<HTMLDivElement | null>(null);
let endpointSearchTimer: ReturnType<typeof setTimeout> | null = null;
watch(endpointSearchInput, (v) => {
  if (endpointSearchTimer) clearTimeout(endpointSearchTimer);
  endpointSearchTimer = setTimeout(() => {
    endpointQuery.value = v.trim();
  }, 250);
});
function onEndpointComboClickOutside(ev: MouseEvent): void {
  if (!endpointComboOpen.value) return;
  const el = endpointComboEl.value;
  if (el && !el.contains(ev.target as Node)) endpointComboOpen.value = false;
}
if (typeof window !== 'undefined') {
  window.addEventListener('click', onEndpointComboClickOutside);
}
function pickEndpoint(name: string): void {
  setSelectedEndpoint(name);
  endpointSearchInput.value = name;
  endpointComboOpen.value = false;
}
function clearEndpoint(): void {
  setSelectedEndpoint(null);
  endpointSearchInput.value = '';
  endpointQuery.value = '';
}
const { endpoints: endpointList, isFetching: endpointsLoading } = useLayerEndpoints(
  layerKey,
  serviceName,
  endpointQuery,
  endpointLimit,
);
// No endpoint auto-pick on Logs either — same reasoning as the
// instance picker above. Default is `All`; operator narrows by hand.
watch(serviceName, (next, prev) => {
  if (prev !== undefined && next !== prev && selectedEndpoint.value) {
    setSelectedEndpoint(null);
  }
});
const selectedEndpointObj = computed(() =>
  selectedEndpoint.value
    ? endpointList.value.find((e) => e.name === selectedEndpoint.value) ?? null
    : null,
);
const endpointIdForQuery = computed<string | null>(() => selectedEndpointObj.value?.id ?? null);

// ── Query state ────────────────────────────────────────────────────
// Trace ID rides either from `?traceId=` in the URL (e.g. log row's
// "↗ trace" link landing back on this tab) or from the operator's
// explicit input on the conditions bar. The URL takes precedence so
// shared / bookmarked URLs always restore the same view.
const traceIdParam = computed(() => {
  const v = route.query.traceId;
  return typeof v === 'string' && v.length > 0 ? v : null;
});
// Trace ID — bound directly to the input. Each keystroke updates the
// query (no Pin/Clear button). URL `?traceId=` still wins so the
// trace→log roundtrip keeps the pinned value.
const traceIdInput = ref('');
// Free-text content search is intentionally NOT exposed. OAP's
// content-keyword filter is opt-in per storage backend (off on the
// stock H2 store) and indexing across full log bodies has surprising
// latency / cardinality behaviour on busy clusters. The conditions
// the UI exposes — service / instance / endpoint / traceID / tags —
// are all indexed dimensions and cover the booster-ui condition set.
const customTags = ref<LogTagFilter[]>([]);
const page = ref(1);
const pageSize = ref(50);
const traceIdRef = computed<string | null>(() => {
  if (traceIdParam.value) return traceIdParam.value;
  const v = traceIdInput.value.trim();
  return v.length > 0 ? v : null;
});
const instanceIdRef = computed<string | null>(() => instanceIdForQuery.value);
const endpointIdRef = computed<string | null>(() => endpointIdForQuery.value);
const keywordsRef = computed<string[]>(() => []);

// Time-range picker. Logs blocks the global topbar picker (see
// `TIME_RANGE_OPT_OUT` in AppTopbar), so this is the source of truth
// for which rolling window the log + facet queries scan. Presets
// cover the most common ranges; the operator can extend if needed
// (cap is 7 days, enforced server-side too). Mirrors the trace tab's
// Custom… escape hatch — picking it swaps the preset dropdown for two
// `datetime-local` inputs so the operator can pin an absolute window.
const TIME_RANGE_PRESETS: Array<{ label: string; minutes: number }> = [
  { label: 'Last 15 min', minutes: 15 },
  { label: 'Last 30 min', minutes: 30 },
  { label: 'Last 1 hour', minutes: 60 },
  { label: 'Last 3 hours', minutes: 180 },
  { label: 'Last 6 hours', minutes: 360 },
  { label: 'Last 12 hours', minutes: 720 },
  { label: 'Last 24 hours', minutes: 1440 },
];
const CUSTOM_RANGE_SENTINEL = -1;
const windowMinutes = ref<number>(30);
const customStart = ref<string | null>(null);
const customEnd = ref<string | null>(null);
const isCustomRange = computed(() => windowMinutes.value === CUSTOM_RANGE_SENTINEL);
function fmtDateTimeLocal(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
watch(isCustomRange, (custom) => {
  if (custom) {
    if (!customStart.value || !customEnd.value) {
      const end = new Date();
      const start = new Date(end.getTime() - 30 * 60_000);
      customStart.value = fmtDateTimeLocal(start);
      customEnd.value = fmtDateTimeLocal(end);
    }
  } else {
    customStart.value = null;
    customEnd.value = null;
  }
});
/** OAP wants `YYYY-MM-DD HHmm`; the native `datetime-local` input
 *  emits `YYYY-MM-DDTHH:MM`. Convert so the BFF can forward to the
 *  same `queryDuration.start/end` slot the trace tab uses. */
function toOapMinute(local: string | null): string | null {
  if (!local) return null;
  const [d, t] = local.split('T');
  if (!d || !t) return null;
  return `${d} ${t.replace(':', '')}`;
}
const startTimeRef = computed<string | null>(() =>
  isCustomRange.value ? toOapMinute(customStart.value) : null,
);
const endTimeRef = computed<string | null>(() =>
  isCustomRange.value ? toOapMinute(customEnd.value) : null,
);
const windowMinutesEffective = computed<number>(() =>
  isCustomRange.value ? 0 : windowMinutes.value,
);

// ── Tag conditions (booster-style single `key=value` input) ──────
// Mirrors the trace tab's ConditionTags pattern: one text input, the
// datalist behind it swaps between known keys (before the operator
// types `=`) and per-key values (after `=`). Enter commits the tag.
// Tags accumulate in `customTags` and ride along on the OAP log query
// as filters.
const tagInput = ref('');
const tagKeyOptions = ref<string[]>([]);
const tagValueOptions = ref<string[]>([]);
const tagValueKey = ref<string>('');
async function loadTagKeys(): Promise<void> {
  try {
    const res = await bffClient.log.tagKeys(30);
    tagKeyOptions.value = res.keys ?? [];
  } catch { /* autocomplete is best-effort */ }
}
async function loadTagValues(key: string): Promise<void> {
  if (!key || key === tagValueKey.value) return;
  tagValueKey.value = key;
  try {
    const res = await bffClient.log.tagValues(key, 30);
    tagValueOptions.value = res.values ?? [];
  } catch { /* noop */ }
}
function onTagInput(): void {
  const eq = tagInput.value.indexOf('=');
  if (eq === -1) return; // still typing key — keys datalist is active
  const key = tagInput.value.slice(0, eq).trim();
  if (key) void loadTagValues(key);
}
// Pre-load known keys once we know which layer the operator is on so
// the suggestion list isn't empty on first keypress.
watch(layerKey, (k) => { if (k) void loadTagKeys(); }, { immediate: true });
const tagDatalistOptions = computed<string[]>(() => {
  const eq = tagInput.value.indexOf('=');
  if (eq === -1) return tagKeyOptions.value;
  const key = tagInput.value.slice(0, eq).trim();
  return tagValueOptions.value.map((v) => `${key}=${v}`);
});
function addTagFilter(): void {
  const raw = tagInput.value.trim();
  if (!raw || !raw.includes('=')) return;
  const idx = raw.indexOf('=');
  const key = raw.slice(0, idx).trim();
  const value = raw.slice(idx + 1).trim();
  if (!key) return;
  if (customTags.value.some((t) => t.key === key && t.value === value)) return;
  customTags.value = [...customTags.value, { key, value }];
  tagInput.value = '';
  page.value = 1;
}
function removeTagFilter(i: number): void {
  customTags.value = customTags.value.filter((_, idx) => idx !== i);
  page.value = 1;
}

// ── Level filter goes to OAP as a `level=<UPPER>` tag filter so the
// server-side total + pagination match the visible rows. The filter
// is single-select (booster-ui uses the same pattern).
const LEVEL_TAG_VALUES: Record<'error' | 'warn' | 'info' | 'debug', string> = {
  error: 'ERROR',
  warn: 'WARN',
  info: 'INFO',
  debug: 'DEBUG',
};
const selectedLevel = ref<'error' | 'warn' | 'info' | 'debug' | null>(null);
const allTags = computed<LogTagFilter[]>(() => {
  const out = [...customTags.value];
  if (selectedLevel.value) {
    out.push({ key: 'level', value: LEVEL_TAG_VALUES[selectedLevel.value] });
  }
  return out;
});
function toggleLevel(l: 'error' | 'warn' | 'info' | 'debug' | 'other'): void {
  if (l === 'other') return; // server-side has no canonical value for "other"
  selectedLevel.value = selectedLevel.value === l ? null : l;
  page.value = 1;
}

const { logs, total, isFetching, error, refetch } = useLayerLogs(layerKey, {
  service: serviceName,
  instanceId: instanceIdRef,
  endpointId: endpointIdRef,
  traceId: traceIdRef,
  keywords: keywordsRef,
  tags: allTags,
  page,
  pageSize,
  windowMinutes: windowMinutesEffective,
  startTime: startTimeRef,
  endTime: endTimeRef,
});

const { facets } = useLayerLogFacets(layerKey, {
  service: serviceName,
  instanceId: instanceIdRef,
  endpointId: endpointIdRef,
  traceId: traceIdRef,
  keywords: keywordsRef,
  windowMinutes: windowMinutesEffective,
  startTime: startTimeRef,
  endTime: endTimeRef,
});

// Run-query handler mirrors the trace tab: refetch both the log
// stream + the facet sample on demand. With most filters already
// auto-refetching, this is the operator's "I'm done editing — refresh
// now" affordance, identical voice to `LayerTracesView#runQuery`.
function runQuery(): void {
  page.value = 1;
  void refetch();
}

// ── Density histogram (60 bins). Loki/Datadog style: stacked bars
// per level over the visible page's time window. Counts come from
// the loaded page only — total-window density would need a server
// aggregation we don't have yet. -----------------------------------

const LEVEL_ORDER = ['error', 'warn', 'info', 'debug', 'other'] as const;
type Level = typeof LEVEL_ORDER[number];
const LEVEL_COLOR: Record<Level, string> = {
  error: 'var(--sw-err)',
  warn: 'var(--sw-warn)',
  info: 'var(--sw-info)',
  debug: 'var(--sw-fg-3)',
  other: 'var(--sw-fg-3)',
};

function levelOf(r: LogRow): Level {
  const tag = (r.tags ?? []).find((t) => t.key.toLowerCase() === 'level');
  const raw = (tag?.value ?? '').toLowerCase();
  if (raw.includes('error') || raw === 'err' || raw === 'fatal') return 'error';
  if (raw.includes('warn')) return 'warn';
  if (raw.includes('info')) return 'info';
  if (raw.includes('debug') || raw.includes('trace')) return 'debug';
  return 'other';
}

const BINS = 60;
const histogram = computed(() => {
  const rows = logs.value;
  if (rows.length === 0) return { bins: [] as Array<Record<Level, number>>, max: 0, t0: 0, t1: 0 };
  let t0 = Infinity;
  let t1 = -Infinity;
  for (const r of rows) {
    if (r.timestamp < t0) t0 = r.timestamp;
    if (r.timestamp > t1) t1 = r.timestamp;
  }
  if (!Number.isFinite(t0) || !Number.isFinite(t1) || t0 === t1) {
    t0 = (t1 || Date.now()) - 60_000;
    t1 = t1 || Date.now();
  }
  const span = t1 - t0 || 1;
  const bins: Array<Record<Level, number>> = Array.from({ length: BINS }, () => ({
    error: 0,
    warn: 0,
    info: 0,
    debug: 0,
    other: 0,
  }));
  for (const r of rows) {
    const idx = Math.min(BINS - 1, Math.floor(((r.timestamp - t0) / span) * BINS));
    bins[idx][levelOf(r)] += 1;
  }
  let max = 0;
  for (const b of bins) {
    const t = b.error + b.warn + b.info + b.debug + b.other;
    if (t > max) max = t;
  }
  return { bins, max, t0, t1 };
});

// ── Facets — server-side aggregated across a larger window sample
// (default 200 rows). When the facet fetch hasn't returned yet we
// fall back to counts derived from the visible page so the rail
// never goes empty.
const levelFacet = computed<Record<Level, number>>(() => {
  if (facets.value?.level) return facets.value.level;
  const counts: Record<Level, number> = { error: 0, warn: 0, info: 0, debug: 0, other: 0 };
  for (const r of logs.value) counts[levelOf(r)] += 1;
  return counts;
});
// Service facet removed — the log query is already service-scoped
// (the view is opened from /layer/<key>/logs with a specific service
// selected), so a "top services" rail just repeats the title.

// Since the level filter now goes to OAP, the visible logs already
// reflect it — no client-side narrowing needed.
const filteredLogs = computed<LogRow[]>(() => logs.value);

// Row keys for `<template v-for>`. Inline expand is gone — click
// now opens the full-canvas popout via `onRowClick(r)`.
function rowKey(r: LogRow, idx: number): string {
  return `${r.timestamp}-${r.traceId ?? ''}-${idx}`;
}

function fmtTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}
function fmtDate(ts: number): string {
  // Numeric MM-DD in the operator's browser-local TZ. Matches the
  // topbar's compact date chip (`05-12 03h → 06h`) and stays
  // locale-independent — `toLocaleDateString` without an explicit
  // locale picks up the system locale (e.g. `5月08日` on zh-CN), which
  // looked inconsistent next to the rest of the dense English UI.
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
/**
 * Render a one-line inline preview. Length is NOT capped here — the
 * row's CSS (`.lg-content-body { white-space: nowrap; overflow:
 * hidden; text-overflow: ellipsis }`) clips at the actual visible
 * width, so wider viewports surface more of the payload while narrow
 * ones still get a clean ellipsis. The slicing-at-220-chars heuristic
 * I had before always cut at the same offset regardless of width.
 *
 *   - JSON: re-serialize to the tightest single-line form so the row
 *     reads as `{"level":"error","msg":"…"}` and not the raw
 *     whitespace-laden source.
 *   - YAML: collapse newlines into a single space so the row still
 *     carries the keys (`apiVersion: v1 kind: Pod spec: containers:
 *     - name: nginx`). Indentation chars stay, which preserves a
 *     visual sense of the hierarchy even on one line. The popout is
 *     the right place to read the proper multi-line structure.
 *   - Text: whitespace collapsed, same as before.
 */
function summariseContent(r: LogRow): string {
  if (!r.content) return '';
  const fmt = detectFormat(r);
  if (fmt === 'json') {
    try {
      return JSON.stringify(JSON.parse(r.content));
    } catch {
      /* fall through to the plain compaction below */
    }
  }
  if (fmt === 'yaml') {
    // Replace newlines with a single space — keeps the indentation
    // characters that sit at the start of each line, which gives the
    // operator a visual cue of nesting depth even when flattened.
    return r.content.replace(/\n+/g, ' ').trim();
  }
  // Plain text — collapse any runs of whitespace.
  return r.content.replace(/\s+/g, ' ').trim();
}
/** With the new flattening rule above, every payload has a usable
 *  inline preview — JSON, YAML, and multi-line text all flatten to
 *  one line cleanly. We no longer need a hidden-payload affordance.
 *  Returns false unconditionally; kept so the template doesn't have
 *  to change. */
function hasHiddenPayload(_r: LogRow): boolean {
  return false;
}
function tryPrettyJson(content: string): string {
  try {
    return JSON.stringify(JSON.parse(content), null, 2);
  } catch {
    return content;
  }
}

/**
 * Detect the rendered format of a log payload. OAP only labels
 * JSON / TEXT, so we sniff for YAML markers (leading `---`, top-level
 * `key:` mappings) and JSON-ness as a fallback so operators get the
 * right pretty-printer in the popout. The detection is best-effort —
 * an ambiguous payload falls back to TEXT.
 */
type LogFormat = 'json' | 'yaml' | 'text';
function detectFormat(r: LogRow): LogFormat {
  if (r.contentType === 'application/json') return 'json';
  const trimmed = r.content?.trim() ?? '';
  if (!trimmed) return 'text';
  // JSON sniff — content-type missing but body parses cleanly.
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) ||
      (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    try { JSON.parse(trimmed); return 'json'; } catch { /* fallthrough */ }
  }
  // YAML sniff — document marker or 2+ top-level `key:` mappings.
  if (trimmed.startsWith('---') || trimmed.startsWith('apiVersion:')) return 'yaml';
  const lines = trimmed.split('\n');
  if (lines.length >= 2) {
    const topLevelMaps = lines.filter((l) => /^[A-Za-z_][\w.-]*\s*:\s*(\S|$)/.test(l)).length;
    if (topLevelMaps >= 2) return 'yaml';
  }
  return 'text';
}
function prettyForFormat(r: LogRow, fmt: LogFormat): string {
  if (fmt === 'json') return tryPrettyJson(r.content);
  return r.content;
}

// ── Log payload popout — operator-triggered modal for inspecting a
// single row's full payload at maximum size, with format-aware
// pretty-print + a copy button + key/value tag table. The inline
// expand below the row stays as a quick peek; the popout is the
// "give me the whole thing" view.
const popoutRow = ref<LogRow | null>(null);
function openPopout(r: LogRow): void { popoutRow.value = r; }
function closePopout(): void { popoutRow.value = null; }
async function copyPopout(): Promise<void> {
  if (!popoutRow.value) return;
  try {
    await navigator.clipboard.writeText(popoutRow.value.content);
  } catch {
    /* clipboard may be blocked; silently no-op */
  }
}
// ESC closes the popout. Bound on the window so it works whether or
// not the popout has keyboard focus (clicking the modal sometimes
// drops focus into the underlying row).
function onGlobalKeydown(ev: KeyboardEvent): void {
  if (ev.key === 'Escape' && popoutRow.value) {
    ev.preventDefault();
    closePopout();
  }
}
if (typeof window !== 'undefined') {
  window.addEventListener('keydown', onGlobalKeydown);
}

/**
 * Row click → open popout. The inline expand is intentionally gone —
 * for multi-line / YAML / JSON payloads it rendered as a cramped strip
 * inside the row band; the popout has the full canvas. Trace-id chip
 * and group decoder still propagate stop-events so their own clicks
 * don't bubble.
 */
function onRowClick(r: LogRow): void {
  openPopout(r);
}

// Custom hover tooltip state for the density bar. Native browser
// `title` was making the cursor render as `?` (help-cursor) instead
// of showing the count, which read like a UI bug.
const hoveredBin = ref<number | null>(null);
function fmtBucketRange(idx: number, t0: number, t1: number): string {
  if (!t0 || !t1) return '';
  const span = (t1 - t0) || 1;
  const start = new Date(t0 + (span * idx) / BINS);
  const end = new Date(t0 + (span * (idx + 1)) / BINS);
  const pad = (n: number) => String(n).padStart(2, '0');
  const fmt = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  return `${fmt(start)} – ${fmt(end)}`;
}
function fmtAxisTime(ts: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Open the trace in the global popout overlay rather than navigating
 *  to the Traces tab — keeps the operator in the log stream, lets them
 *  scan the waterfall + close it back to where they were without
 *  losing the keyword filter / pagination state. The row's timestamp
 *  is passed as a hint so BanyanDB's `queryTrace` looks in the right
 *  window — without this, OAP searches only the last 1 day and any
 *  trace older than that (cold-tier, etc.) silently fails to load. */
function jumpToTrace(traceId: string, ts?: number): void {
  openTrace(traceId, ts);
}
</script>

<template>
  <div class="lg-tab">
    <!-- Toolbar mirrors the trace tab: head row (kicker + Run query)
         on top, conditions grid below, active tag chips at the foot. -->
    <header class="lg-toolbar sw-card">
      <div class="lg-toolbar-head">
        <span class="kicker">Logs</span>
        <span v-if="traceIdRef" class="trace-pin">trace <code>{{ traceIdRef.slice(0, 12) }}…</code></span>
        <span v-if="isFetching" class="hint">refreshing…</span>
        <button class="sw-btn primary lg-run-btn" type="button" @click="runQuery">Run query</button>
      </div>
      <div class="lg-conditions">
        <!-- Instance / Sidecar picker. `All` is the default for every
             scope; pinning an instance is opt-in via the dropdown. -->
        <label class="cf">
          <span>{{ logScope === 'instance' ? 'Sidecar' : 'Instance' }}</span>
          <select
            class="cf-input"
            :value="selectedInstance ?? ''"
            @change="setSelectedInstance(($event.target as HTMLSelectElement).value || null)"
          >
            <option value="">All</option>
            <option v-for="i in instanceList" :key="i.id" :value="i.name">{{ i.name }}</option>
          </select>
        </label>
        <!-- Endpoint combobox = search + dropdown in one component.
             Type to filter the OAP list via `endpointQuery`; click an
             item to pick. Width: 2 columns so long endpoint paths fit. -->
        <div class="cf cf-wide">
          <span>Endpoint</span>
          <div ref="endpointComboEl" class="cf-combo" @click.stop>
            <input
              v-model="endpointSearchInput"
              type="text"
              class="cf-input"
              :placeholder="selectedEndpoint ?? 'All'"
              @focus="endpointComboOpen = true"
              @input="endpointComboOpen = true"
            />
            <button
              v-if="selectedEndpoint || endpointSearchInput"
              type="button"
              class="cf-combo-clear"
              title="Clear endpoint"
              @click="clearEndpoint"
            >×</button>
            <ul v-if="endpointComboOpen" class="cf-combo-list">
              <li
                v-if="showEndpointSelector"
                class="cf-combo-item"
                :class="{ on: !selectedEndpoint }"
                @click="clearEndpoint"
              >
                <em>All</em>
              </li>
              <li
                v-for="e in endpointList"
                :key="e.id"
                class="cf-combo-item"
                :class="{ on: selectedEndpoint === e.name }"
                @click="pickEndpoint(e.name)"
              >
                {{ e.name }}
              </li>
              <li v-if="endpointList.length === 0" class="cf-combo-empty">
                {{ endpointsLoading ? 'searching…' : 'no matches' }}
              </li>
            </ul>
          </div>
        </div>
        <!-- Trace ID. Bound directly — each keystroke updates the
             query. URL `?traceId=` still overrides. -->
        <label class="cf cf-wide">
          <span>Trace ID</span>
          <input
            v-model="traceIdInput"
            type="text"
            class="cf-input mono"
            placeholder="paste trace id…"
          />
        </label>
        <!-- Tags — single key=value input + datalist autocomplete. -->
        <label class="cf cf-wide">
          <span>Tags</span>
          <input
            v-model="tagInput"
            type="text"
            class="cf-input mono"
            placeholder="key=value, then Enter"
            list="lg-tag-suggestions"
            @input="onTagInput"
            @keyup.enter="addTagFilter"
          />
          <datalist id="lg-tag-suggestions">
            <option v-for="opt in tagDatalistOptions" :key="opt" :value="opt" />
          </datalist>
        </label>
        <!-- Time range — presets + Custom… that swaps to two
             datetime-local inputs (matches the trace tab). -->
        <label class="cf" :class="{ 'cf-wide': isCustomRange }">
          <span>Time range</span>
          <template v-if="isCustomRange">
            <div class="cf-range">
              <input v-model="customStart" type="datetime-local" class="cf-input cf-range-num" />
              <span class="cf-range-sep">–</span>
              <input v-model="customEnd" type="datetime-local" class="cf-input cf-range-num" />
              <button class="sw-btn small ghost" type="button" title="Back to presets" @click="windowMinutes = 30">×</button>
            </div>
          </template>
          <select v-else v-model.number="windowMinutes" class="cf-input">
            <option v-for="p in TIME_RANGE_PRESETS" :key="p.minutes" :value="p.minutes">{{ p.label }}</option>
            <option :value="CUSTOM_RANGE_SENTINEL">Custom…</option>
          </select>
        </label>
        <label class="cf">
          <span>Page size</span>
          <select v-model.number="pageSize" class="cf-input">
            <option :value="20">20</option>
            <option :value="30">30</option>
            <option :value="50">50</option>
            <option :value="100">100</option>
          </select>
        </label>
      </div>
      <!-- Active tag chips — same markup / class names as the trace
           tab's `tr-tag-row` so the two pages read identically. -->
      <div v-if="customTags.length > 0" class="tr-tag-row">
        <span class="tag-row-label">Active tags</span>
        <span class="tag-chips">
          <span v-for="(t, i) in customTags" :key="`${t.key}=${t.value}`" class="tag-chip">
            <span class="mono">{{ t.key }}={{ t.value }}</span>
            <button type="button" class="tag-x" @click="removeTagFilter(i)">×</button>
          </span>
        </span>
      </div>
    </header>

    <div v-if="error" class="banner err">
      <strong>Logs feed failed.</strong> {{ String(error) }}
    </div>

    <!-- Histogram + main stream -->
    <section class="lg-body sw-card">
      <div class="lg-main">
        <!-- Top-of-table legend strip — one chip per level with the
             in-window count when data exists. Clickable: toggles the
             level filter. The service axis is intentionally absent
             (this query is already service-scoped, so the service
             dimension carries no information). -->
        <div v-if="facets || logs.length > 0" class="lg-legend">
          <span class="lg-legend-kicker">Levels</span>
          <button
            v-for="l in LEVEL_ORDER"
            :key="l"
            type="button"
            class="lg-legend-chip"
            :class="{ on: selectedLevel === l, disabled: l === 'other' }"
            :disabled="l === 'other'"
            @click="toggleLevel(l)"
          >
            <span class="lvl-dot" :style="{ background: LEVEL_COLOR[l] }" />
            <span class="lg-legend-name">{{ l }}</span>
            <span v-if="levelFacet[l] > 0" class="lg-legend-count">{{ levelFacet[l] }}</span>
          </button>
          <span v-if="facets" class="lg-legend-sample" :title="`window sample of ${facets.sampled} rows`">
            sample of {{ facets.sampled }}
          </span>
        </div>

        <!-- Density bar — x: time, y: count, color: level. Hover a
             bin: a custom tooltip (NOT the native `title` — the
             native cursor was rendering as a help cursor `?` instead
             of the count, which was confusing) shows the bucket time
             range + per-level counts. Axis tick labels under the bar
             carry the time scale. -->
        <div class="lg-density-wrap" v-if="histogram.bins.length > 0" @mouseleave="hoveredBin = null">
          <div class="lg-density">
            <div
              v-for="(bin, i) in histogram.bins"
              :key="i"
              class="lg-density-bin"
              @mouseenter="hoveredBin = i"
            >
              <span
                v-for="l in LEVEL_ORDER"
                :key="l"
                class="lg-density-segment"
                :style="{
                  background: LEVEL_COLOR[l],
                  height: histogram.max ? (bin[l] / histogram.max * 100) + '%' : '0%',
                }"
              />
            </div>
            <!-- Custom hover tooltip — replaces the native browser
                 tooltip which was both slow to appear AND coupled to
                 the `cursor: help` rendering (the `?` cursor was the
                 thing the operator was reporting). -->
            <div
              v-if="hoveredBin !== null"
              class="lg-density-tip"
              :style="{ left: ((hoveredBin + 0.5) / 60) * 100 + '%' }"
            >
              <div class="lg-density-tip-time">
                {{ fmtBucketRange(hoveredBin, histogram.t0, histogram.t1) }}
              </div>
              <div class="lg-density-tip-total">
                {{ histogram.bins[hoveredBin].error + histogram.bins[hoveredBin].warn + histogram.bins[hoveredBin].info + histogram.bins[hoveredBin].debug + histogram.bins[hoveredBin].other }} log<template v-if="(histogram.bins[hoveredBin].error + histogram.bins[hoveredBin].warn + histogram.bins[hoveredBin].info + histogram.bins[hoveredBin].debug + histogram.bins[hoveredBin].other) !== 1">s</template>
              </div>
              <div class="lg-density-tip-rows">
                <span v-for="l in LEVEL_ORDER" :key="l" v-show="histogram.bins[hoveredBin][l] > 0" class="lg-density-tip-row">
                  <span class="lvl-dot" :style="{ background: LEVEL_COLOR[l] }" />
                  <span class="lg-density-tip-name">{{ l }}</span>
                  <span class="lg-density-tip-val mono">{{ histogram.bins[hoveredBin][l] }}</span>
                </span>
              </div>
            </div>
          </div>
          <div class="lg-density-axis">
            <span class="t-tick">{{ fmtAxisTime(histogram.t0) }}</span>
            <span class="t-tick">{{ fmtAxisTime(histogram.t0 + (histogram.t1 - histogram.t0) * 0.25) }}</span>
            <span class="t-tick">{{ fmtAxisTime(histogram.t0 + (histogram.t1 - histogram.t0) * 0.5) }}</span>
            <span class="t-tick">{{ fmtAxisTime(histogram.t0 + (histogram.t1 - histogram.t0) * 0.75) }}</span>
            <span class="t-tick">{{ fmtAxisTime(histogram.t1) }}</span>
          </div>
        </div>

        <!-- Stream -->
        <div v-if="filteredLogs.length === 0" class="lg-empty">
          {{ logs.length === 0 ? 'No logs returned for this scope.' : 'No logs match the active filters.' }}
        </div>
        <div v-else class="lg-stream">
          <template v-for="(r, idx) in filteredLogs" :key="rowKey(r, idx)">
            <!-- Row click → open the popout. Inline expand removed:
                 YAML / JSON / multi-line text rendered cramped inside
                 the row band and reads as truncated. The popout has
                 the full canvas + format-aware pretty-print. -->
            <div class="lg-row" :class="`lv-${levelOf(r)}`" @click="onRowClick(r)">
              <span class="lg-time mono">{{ fmtTime(r.timestamp) }}</span>
              <span class="lg-date mono dim">{{ fmtDate(r.timestamp) }}</span>
              <span class="lg-lvl" :style="{ color: LEVEL_COLOR[levelOf(r)] }">{{ levelOf(r) }}</span>
              <span class="lg-svc mono dim">
                <span
                  v-if="r.serviceName && parseServiceName(r.serviceName).group"
                  class="lg-svc-group"
                >{{ parseServiceName(r.serviceName).group }}</span>
                {{ r.serviceName ? parseServiceName(r.serviceName).base : '—' }}
              </span>
              <!-- The trace-link slot is ALWAYS rendered, even when the
                   row has no traceId — its 60px grid column is fixed,
                   and skipping the slot collapses every subsequent
                   column leftward (the 1fr content cell ends up sized
                   at 60px, truncating the preview to two characters). -->
              <span v-if="r.traceId" class="lg-trace mono" @click.stop="jumpToTrace(r.traceId!, r.timestamp)">↗ trace</span>
              <span v-else class="lg-trace-spacer" aria-hidden="true"></span>
              <!-- Format chip + flat content preview. Chip is always
                   rendered so the operator can tell at-a-glance which
                   rows are JSON / YAML / plain text. Preview is single
                   line, length-capped, and trimmed-with-ellipsis via
                   `.lg-content` CSS so even when JSON contains long
                   strings the row stays one line. -->
              <span class="lg-content mono">
                <span class="lg-fmt-chip" :class="`fmt-${detectFormat(r)}`">{{ detectFormat(r).toUpperCase() }}</span>
                <span class="lg-content-body">
                  <template v-if="hasHiddenPayload(r)">
                    <em class="lg-content-hint">click to view</em>
                  </template>
                  <template v-else>{{ summariseContent(r) }}</template>
                </span>
              </span>
            </div>
          </template>
        </div>
        <div class="lg-pager">
          <span class="hint">page {{ page }} · showing {{ filteredLogs.length }} of {{ total }} total</span>
          <div class="lg-pager-ctrls">
            <button class="sw-btn small" type="button" :disabled="page <= 1" @click="page--">Prev</button>
            <button
              class="sw-btn small"
              type="button"
              :disabled="logs.length < pageSize"
              @click="page++"
            >Next</button>
          </div>
        </div>
      </div>
    </section>

    <!-- Full-payload popout. Triggered from a row's expanded panel.
         Format-aware pretty-print + copy button + tag table. Escape
         or backdrop click closes. -->
    <div v-if="popoutRow" class="lg-popout-backdrop" @click.self="closePopout">
      <article class="lg-popout sw-card">
        <header class="lg-popout-head">
          <div>
            <span class="kicker">Log entry</span>
            <span class="lg-popout-time mono">{{ fmtTime(popoutRow.timestamp) }} · {{ fmtDate(popoutRow.timestamp) }}</span>
            <span class="lg-popout-fmt">{{ detectFormat(popoutRow).toUpperCase() }}</span>
          </div>
          <div class="lg-popout-ctrls">
            <button class="sw-btn small" type="button" @click="copyPopout">Copy</button>
            <button
              v-if="popoutRow.traceId"
              class="sw-btn small"
              type="button"
              @click="jumpToTrace(popoutRow.traceId!, popoutRow.timestamp)"
            >↗ trace</button>
            <button class="sw-btn small ghost" type="button" @click="closePopout">×</button>
          </div>
        </header>
        <div class="lg-popout-meta">
          <span v-if="popoutRow.serviceName" class="lg-meta">service <code>{{ popoutRow.serviceName }}</code></span>
          <span v-if="popoutRow.serviceInstanceName" class="lg-meta">instance <code>{{ popoutRow.serviceInstanceName }}</code></span>
          <span v-if="popoutRow.endpointName" class="lg-meta">endpoint <code>{{ popoutRow.endpointName }}</code></span>
          <span v-if="popoutRow.traceId" class="lg-meta">trace <code class="mono">{{ popoutRow.traceId }}</code></span>
        </div>
        <div class="lg-popout-split">
          <pre
            v-if="detectFormat(popoutRow) === 'json'"
            class="lg-popout-body json"
          >{{ prettyForFormat(popoutRow, 'json') }}</pre>
          <pre
            v-else-if="detectFormat(popoutRow) === 'yaml'"
            class="lg-popout-body yaml"
          >{{ popoutRow.content }}</pre>
          <pre v-else class="lg-popout-body text">{{ popoutRow.content }}</pre>
          <aside v-if="popoutRow.tags.length > 0" class="lg-popout-tags">
            <table class="lg-popout-tag-tbl">
              <thead><tr><th>Key</th><th>Value</th></tr></thead>
              <tbody>
                <tr v-for="t in popoutRow.tags" :key="`${t.key}=${t.value}`">
                  <td class="mono">{{ t.key }}</td>
                  <td class="mono">{{ t.value }}</td>
                </tr>
              </tbody>
            </table>
          </aside>
        </div>
      </article>
    </div>
  </div>
</template>

<style scoped>
.lg-tab { display: flex; flex-direction: column; gap: 12px; padding: 4px 0 0; }
.lg-toolbar {
  display: flex;
  align-items: baseline;
  gap: 12px;
  padding: 8px 12px;
  flex-wrap: wrap;
}
.kicker {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--sw-accent);
  font-weight: 600;
}
.for-svc { font-size: 11.5px; color: var(--sw-fg-3); }
.for-svc b { color: var(--sw-fg-1); font-family: var(--sw-mono); font-weight: 500; }
.trace-pin {
  font-size: 10.5px;
  color: var(--sw-accent-2);
  background: var(--sw-accent-soft);
  border: 1px solid var(--sw-accent-line);
  padding: 1px 6px;
  border-radius: 4px;
}
.trace-pin code { font-family: var(--sw-mono); }
.hint { font-size: 10.5px; color: var(--sw-fg-3); }
.filters {
  display: inline-flex;
  align-items: baseline;
  gap: 8px;
  margin-left: auto;
  flex-wrap: wrap;
  flex: 1;
  min-width: 320px;
}
/* Trace-style toolbar layout (same voice as `LayerTracesView`). */
.lg-toolbar { padding: 10px 12px; display: flex; flex-direction: column; gap: 10px; overflow: visible; }
.lg-toolbar-head { display: flex; align-items: center; gap: 10px; width: 100%; }
/* Run-query button: SkyWalking orange, sits at the right edge of the
   toolbar head row. Matches `LayerTracesView.tr-run-btn` exactly so the
   two pages read identically. `.sw-btn.primary` is locally scoped per
   page (each view declares its own styling); copying the rule keeps
   the visual stable without dragging in a shared global. */
.lg-run-btn { margin-left: auto; }
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
.sw-btn.primary:hover { background: var(--sw-accent-2); }
.sw-btn.ghost { background: transparent; border: 1px solid var(--sw-line-2); color: var(--sw-fg-2); }
.lg-conditions {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px 10px;
}
@media (max-width: 900px) { .lg-conditions { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
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
.cf-input:focus { outline: none; border-color: var(--sw-accent-line); }
.cf-input:disabled { opacity: 0.5; cursor: not-allowed; }
.cf-range { display: flex; align-items: center; gap: 4px; }
.cf-range-num { flex: 1; min-width: 0; }
.cf-range-sep { color: var(--sw-fg-3); font-size: 12px; flex: 0 0 auto; }

/* Endpoint combobox = single search input + anchored dropdown.
   Click-outside closes it (see `onEndpointComboClickOutside`). */
.cf-combo { position: relative; }
.cf-combo .cf-input { padding-right: 22px; }
.cf-combo-clear {
  position: absolute;
  right: 6px;
  top: 50%;
  transform: translateY(-50%);
  width: 16px;
  height: 16px;
  line-height: 14px;
  padding: 0;
  background: transparent;
  border: none;
  color: var(--sw-fg-3);
  font-size: 13px;
  cursor: pointer;
}
.cf-combo-clear:hover { color: var(--sw-err); }
.cf-combo-list {
  position: absolute;
  top: 100%;
  left: 0;
  right: 0;
  margin: 4px 0 0;
  padding: 4px;
  max-height: 240px;
  overflow-y: auto;
  list-style: none;
  background: var(--sw-bg-1);
  border: 1px solid var(--sw-line-2);
  border-radius: 4px;
  z-index: 50;
  box-shadow: 0 8px 24px rgba(0,0,0,0.45);
}
.cf-combo-item {
  padding: 5px 8px;
  font-size: 11px;
  font-family: var(--sw-mono);
  color: var(--sw-fg-1);
  border-radius: 3px;
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.cf-combo-item em { color: var(--sw-fg-1); font-style: normal; font-family: var(--sw-mono); }
.cf-combo-item:hover { background: var(--sw-bg-2); color: var(--sw-fg-0); }
.cf-combo-item.on { background: var(--sw-accent-soft); color: var(--sw-accent-2); font-weight: 600; }
.cf-combo-empty { padding: 6px 8px; font-size: 10.5px; color: var(--sw-fg-3); }

/* Group-prefix chip in a log row's service column. Decodes
   `<group>::<base>` so the eye lands on the base name first. */
.lg-svc-group {
  display: inline-block;
  padding: 0 5px;
  margin-right: 4px;
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line-2);
  border-radius: 3px;
  font-size: 9.5px;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: var(--sw-fg-2);
  text-transform: uppercase;
}
.f-field {
  display: inline-flex;
  align-items: baseline;
  gap: 5px;
  font-size: 10.5px;
  color: var(--sw-fg-3);
}
.f-field select {
  height: 26px;
  padding: 0 6px;
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line-2);
  border-radius: 4px;
  color: var(--sw-fg-0);
  font: inherit;
  font-size: 11px;
}
.banner.err {
  padding: 8px 12px;
  background: var(--sw-err-soft);
  border: 1px solid rgba(239, 68, 68, 0.3);
  border-radius: 6px;
  color: #f87171;
  font-size: 11.5px;
}

.lg-body {
  padding: 0;
  min-height: 540px;
}
/* Top-of-table level legend — chips sit above the density bar so the
   level counts surface at the same scan line the user reads the
   timeline. Clicking a chip filters the stream to that level. */
.lg-legend {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--sw-line);
  flex-wrap: wrap;
}
.lg-legend-kicker {
  font-size: 10.5px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--sw-fg-3);
  margin-right: 6px;
}
.lg-legend-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 9px;
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line-2);
  border-radius: 12px;
  color: var(--sw-fg-1);
  font: inherit;
  font-size: 11.5px;
  cursor: pointer;
}
.lg-legend-chip:hover { color: var(--sw-fg-0); border-color: var(--sw-line); }
.lg-legend-chip.on {
  color: var(--sw-accent-2);
  background: var(--sw-accent-soft);
  border-color: var(--sw-accent-line);
}
.lg-legend-chip.disabled { opacity: 0.45; cursor: not-allowed; }
.lg-legend-name { text-transform: capitalize; }
.lg-legend-count {
  font-family: var(--sw-mono);
  font-size: 11px;
  font-weight: 600;
  color: var(--sw-fg-2);
  padding: 0 4px;
  border-left: 1px solid var(--sw-line-2);
  margin-left: 2px;
}
.lg-legend-chip.on .lg-legend-count { color: var(--sw-accent-2); border-color: var(--sw-accent-line); }
.lg-legend-sample {
  margin-left: auto;
  font-size: 10.5px;
  color: var(--sw-fg-3);
  font-family: var(--sw-mono);
}
.lvl-dot {
  width: 8px;
  height: 8px;
  border-radius: 2px;
  flex: 0 0 auto;
}

.lg-main {
  display: flex;
  flex-direction: column;
  min-height: 0;
}
/* Density-bar wrapper: the 60 stacked bin bars on top, x-axis tick
   strip underneath so the time scale is readable at a glance. */
.lg-density-wrap {
  padding: 8px 12px 4px;
  border-bottom: 1px solid var(--sw-line);
  background: var(--sw-bg-1);
}
.lg-density {
  display: grid;
  grid-template-columns: repeat(60, 1fr);
  align-items: end;
  gap: 1px;
  height: 60px;
  position: relative; /* anchor for the absolute-positioned tooltip */
}
.lg-density-bin {
  display: flex;
  flex-direction: column-reverse;
  height: 100%;
  background: var(--sw-bg-2);
  border-radius: 1px;
  overflow: hidden;
  /* No `cursor: help` — the `?` cursor was misread as a UI error.
     The bin reads as informational (hover surfaces a count tooltip),
     so a default pointer is the right affordance. */
}
.lg-density-bin:hover { outline: 1px solid var(--sw-accent-line); }
.lg-density-segment { display: block; }
/* Custom hover tooltip — anchored to the hovered bin via the
   `left: <bin-center>%` inline style. Wider than a single bin so it
   doesn't clip; transforms back by 50% to centre on the bin. */
.lg-density-tip {
  position: absolute;
  bottom: calc(100% + 6px);
  transform: translateX(-50%);
  min-width: 160px;
  padding: 6px 9px;
  background: var(--sw-bg-0);
  border: 1px solid var(--sw-line-2);
  border-radius: 4px;
  box-shadow: 0 8px 20px rgba(0,0,0,0.45);
  font-size: 11px;
  color: var(--sw-fg-1);
  pointer-events: none;
  z-index: 5;
}
.lg-density-tip-time { color: var(--sw-fg-3); font-family: var(--sw-mono); font-size: 10px; margin-bottom: 2px; }
.lg-density-tip-total { color: var(--sw-fg-0); font-weight: 700; font-size: 12px; margin-bottom: 4px; }
.lg-density-tip-rows { display: flex; flex-direction: column; gap: 2px; }
.lg-density-tip-row { display: inline-flex; align-items: center; gap: 6px; font-size: 10.5px; }
.lg-density-tip-row .lvl-dot { width: 7px; height: 7px; border-radius: 50%; flex: 0 0 7px; }
.lg-density-tip-name { color: var(--sw-fg-2); flex: 1; text-transform: capitalize; }
.lg-density-tip-val { color: var(--sw-fg-0); font-weight: 600; font-variant-numeric: tabular-nums; }
/* X-axis tick strip — 5 evenly-spaced labels (start / 25% / 50% /
   75% / end) underneath the bars, in tabular nums so they line up. */
.lg-density-axis {
  display: flex;
  justify-content: space-between;
  font-family: var(--sw-mono);
  font-size: 9.5px;
  color: var(--sw-fg-3);
  font-variant-numeric: tabular-nums;
  margin-top: 4px;
  padding: 0 2px;
}
.lg-density-axis .t-tick:first-child { text-align: left; }
.lg-density-axis .t-tick:last-child { text-align: right; }

/* Row-content hint when the inline preview is suppressed (multi-line,
   YAML, JSON). Italic gray so it reads as "this is a placeholder, not
   the actual content". */
.lg-content-hint {
  color: var(--sw-fg-3);
  font-style: italic;
  font-size: 10.5px;
  letter-spacing: 0.04em;
}
.lg-row { cursor: pointer; }
.lg-empty {
  padding: 32px;
  text-align: center;
  color: var(--sw-fg-3);
  font-size: 11.5px;
}
.lg-stream {
  flex: 1;
  overflow-y: auto;
  font-size: 11.5px;
}
.lg-row {
  display: grid;
  grid-template-columns: 80px 60px 56px 140px 60px 1fr;
  gap: 10px;
  align-items: center;
  padding: 4px 12px;
  border-bottom: 1px solid var(--sw-line);
  cursor: pointer;
}
.lg-row:hover { background: var(--sw-bg-2); }
.lg-row.lv-error { box-shadow: inset 3px 0 0 var(--sw-err); }
.lg-row.lv-warn { box-shadow: inset 3px 0 0 var(--sw-warn); }
.lg-time { font-family: var(--sw-mono); color: var(--sw-fg-1); }
.lg-date { font-size: 10px; }
.lg-lvl {
  font-size: 9.5px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  font-weight: 700;
}
.lg-svc { font-size: 10.5px; }
.lg-trace {
  font-size: 10px;
  color: var(--sw-accent-2);
  cursor: pointer;
  padding: 1px 5px;
  background: var(--sw-accent-soft);
  border: 1px solid var(--sw-accent-line);
  border-radius: 3px;
}
.lg-trace:hover { color: var(--sw-fg-0); }
.lg-content {
  font-family: var(--sw-mono);
  font-size: 11px;
  color: var(--sw-fg-1);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
/* Format chip — small uppercase tag rendered before the preview. Per-
   format color keeps JSON / YAML / TEXT visually distinct without
   adding chrome. Tabular-nums + monospace so the three chips align. */
.lg-fmt-chip {
  flex: 0 0 auto;
  display: inline-block;
  padding: 0 5px;
  height: 14px;
  line-height: 14px;
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.04em;
  border-radius: 3px;
  text-transform: uppercase;
  font-family: var(--sw-mono);
}
.lg-fmt-chip.fmt-json { background: var(--sw-info-soft); color: var(--sw-info); }
.lg-fmt-chip.fmt-yaml { background: rgba(251, 191, 36, 0.18); color: #fbbf24; }
.lg-fmt-chip.fmt-text { background: var(--sw-bg-3); color: var(--sw-fg-2); }
.lg-content-body {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.lg-expand {
  padding: 10px 14px 14px 28px;
  border-bottom: 1px solid var(--sw-line);
  background: var(--sw-bg-2);
}
.lg-payload {
  margin: 0 0 8px;
  padding: 8px 10px;
  background: var(--sw-bg-1);
  border: 1px solid var(--sw-line);
  border-radius: 4px;
  font-family: var(--sw-mono);
  font-size: 11px;
  color: var(--sw-fg-1);
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 280px;
  overflow: auto;
}
.lg-payload.json { color: var(--sw-cyan); }
.lg-tag-row {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  margin-bottom: 6px;
}
.lg-tag {
  display: inline-flex;
  align-items: baseline;
  gap: 4px;
  font-size: 10.5px;
  padding: 1px 6px;
  background: var(--sw-bg-1);
  border: 1px solid var(--sw-line);
  border-radius: 3px;
}
.lg-tag-k { color: var(--sw-fg-3); }
.lg-tag-v { color: var(--sw-fg-1); }
.lg-meta-row {
  display: flex;
  gap: 14px;
  flex-wrap: wrap;
  font-size: 10.5px;
  color: var(--sw-fg-3);
}
.lg-meta code {
  font-family: var(--sw-mono);
  color: var(--sw-fg-2);
  background: var(--sw-bg-1);
  padding: 1px 4px;
  border-radius: 3px;
}

.lg-pager {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 14px;
  border-top: 1px solid var(--sw-line);
}
.lg-pager .hint { font-size: 10.5px; color: var(--sw-fg-3); }
.lg-pager-ctrls { margin-left: auto; display: inline-flex; gap: 6px; }
.dim { color: var(--sw-fg-3); }
.mono { font-family: var(--sw-mono); }
.sw-btn.small {
  height: 24px;
  padding: 0 10px;
  font-size: 11px;
}
.sw-btn.ghost {
  background: transparent;
}

@media (max-width: 1100px) {
  .lg-legend { padding: 8px 10px; gap: 4px; }
  .lg-legend-chip { padding: 2px 7px; font-size: 11px; }
}

/* Trace-ID + tag-key=value inputs on the conditions bar. */
.lg-trace-input {
  height: 26px;
  width: 220px;
  padding: 0 8px;
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line-2);
  border-radius: 4px;
  color: var(--sw-fg-0);
  font: inherit;
  font-size: 11px;
}
.lg-trace-input:focus { outline: none; border-color: var(--sw-accent-line); }
.lg-tag-input {
  height: 26px;
  width: 220px;
  padding: 0 8px;
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line-2);
  border-radius: 4px;
  color: var(--sw-fg-0);
  font: inherit;
  font-size: 11px;
}
.lg-tag-input:focus { outline: none; border-color: var(--sw-accent-line); }

/* Active tag chips — markup + visuals lifted from `LayerTracesView`
   so the two pages read identically. */
.tr-tag-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding-top: 6px;
  width: 100%;
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

/* YAML payload colour (cyan-leaning to distinguish from JSON which
   is also cyan; warm-yellow scheme conveys "config / declarative"). */
.lg-payload.yaml { color: #fbbf24; }

/* Full-payload popout — fixed, centred, modal-like overlay. */
.lg-popout-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.55);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
  padding: 24px;
}
.lg-popout {
  width: min(1100px, 92vw);
  min-height: 70vh;
  max-height: 92vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.lg-popout-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--sw-line);
}
.lg-popout-head .kicker { margin-right: 8px; }
.lg-popout-time { font-size: 11px; color: var(--sw-fg-2); margin-right: 10px; }
.lg-popout-fmt {
  display: inline-block;
  padding: 1px 8px;
  border-radius: 10px;
  background: var(--sw-accent-soft);
  color: var(--sw-accent-2);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.04em;
}
.lg-popout-ctrls { display: inline-flex; gap: 6px; }
.lg-popout-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  padding: 8px 14px;
  border-bottom: 1px dashed var(--sw-line);
  font-size: 11px;
  color: var(--sw-fg-3);
}
.lg-popout-meta code {
  font-family: var(--sw-mono);
  color: var(--sw-fg-1);
  padding: 0 4px;
  background: var(--sw-bg-2);
  border-radius: 3px;
}
.lg-popout-split { flex: 1; min-height: 0; display: flex; }
.lg-popout-body {
  flex: 1;
  min-height: 0;
  min-width: 0;
  margin: 0;
  padding: 12px 14px;
  background: var(--sw-bg-0);
  font-family: var(--sw-mono);
  font-size: 12px;
  line-height: 1.55;
  color: var(--sw-fg-0);
  white-space: pre-wrap;
  word-break: break-all;
  overflow: auto;
}
.lg-popout-body.json { color: var(--sw-cyan); }
.lg-popout-body.yaml { color: #fbbf24; }
.lg-popout-tags {
  flex: 0 0 340px;
  border-left: 1px solid var(--sw-line);
  padding: 8px 14px 12px;
  overflow: auto;
  background: var(--sw-bg-1);
}
.lg-popout-tag-tbl {
  width: 100%;
  table-layout: fixed;
  border-collapse: collapse;
  font-size: 11px;
}
.lg-popout-tag-tbl td { word-break: break-all; vertical-align: top; }
.lg-popout-tag-tbl th, .lg-popout-tag-tbl td {
  padding: 4px 10px;
  text-align: left;
  border-bottom: 1px solid var(--sw-line);
}
.lg-popout-tag-tbl th { color: var(--sw-fg-3); font-weight: 500; }
.lg-popout-tag-tbl td { color: var(--sw-fg-1); font-family: var(--sw-mono); }
</style>
