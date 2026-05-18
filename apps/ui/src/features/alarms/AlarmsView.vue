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
  Alarms triage page. Layout:

   ┌── header ─────────────────────────────────────────────────────┐
   │ Alarms                       [20m] [2h] [4h] [custom] [↻]    │
   ├── KPI strip ──────────────────────────────────────────────────┤
   │  TOTAL · GENERAL · MESH · …pinned…  · k8s 4  vm 2  …overflow │
   ├── filter row (conditional on capabilities.queryAlarms) ──────┤
   │  layer · service · instance · endpoint · keyword · [apply]   │
   ├── timeline (alarm flags per layer lane) ─────────────────────┤
   │  click flag = select alarm; brush = select time range        │
   ├── grouped list ─────────────────────┬── detail panel ────────┤
   │  rows + frontend pager              │ expression + snapshot   │
   └─────────────────────────────────────┴────────────────────────┘

  Dual-mode contract — driven by `useOapInfo().capabilities.queryAlarms`:
   - New: filter row shows layer + cascade + keyword. Filters apply
          server-side via queryAlarms `entities` / `layers`.
   - Legacy: filter row shows keyword only. Server-side filters
          gracefully no-op; chips in the header still filter the
          fetched response client-side.
-->
<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useQuery } from '@tanstack/vue-query';
import {
  bff,
  bffClient,
  type AlarmMessage,
  type AlarmsConfig,
  type AlarmsResponse,
} from '@/api/client';
import { useLayers } from '@/shell/useLayers';
import { useOapInfo } from '@/shell/useOapInfo';
import AlarmsTimeline from '@/components/charts/AlarmsTimeline.vue';
import AlarmDetailPanel from './AlarmDetailPanel.vue';
import { formatAlarmEntity } from '@/utils/alarmEntity';
import { mergeIncidents, type AlarmIncident } from '@/utils/alarmIncidents';

// ── Time window ──────────────────────────────────────────────────────
/* Per the alerting redesign: 20m / 2h / 4h presets + custom up to 4h.
 * Alarms are second-precision events; longer windows pull thousands
 * of rows and starve the page on some storage backends. The BFF
 * enforces the same 4h cap server-side. */
type PresetKey = '20m' | '2h' | '4h';
const PRESET_MS: Record<PresetKey, number> = {
  '20m': 20 * 60_000,
  '2h': 2 * 60 * 60_000,
  '4h': 4 * 60 * 60_000,
};
const PRESETS: readonly PresetKey[] = ['20m', '2h', '4h'] as const;
const MAX_CUSTOM_MS = 4 * 60 * 60_000;

/** Reverse-lookup: configured ms → preset key. Returns `'20m'` for
 *  any value that doesn't match a preset (defensive — the BFF rejects
 *  non-preset values, but the page should still render with a sane
 *  default if it ever sees one). */
function presetFromMs(ms: number | undefined): PresetKey {
  if (ms === PRESET_MS['4h']) return '4h';
  if (ms === PRESET_MS['2h']) return '2h';
  return '20m';
}

type WindowMode = PresetKey | 'custom';
const windowMode = ref<WindowMode>('20m');
const windowEndAt = ref<number>(Date.now());
/** Custom range — only consulted when `windowMode === 'custom'`. */
const customStart = ref<number>(Date.now() - PRESET_MS['4h']);
const customEnd = ref<number>(Date.now());
const customError = ref<string | null>(null);
const customOpen = ref<boolean>(false);

const startTime = computed<number>(() => {
  if (windowMode.value === 'custom') return customStart.value;
  return windowEndAt.value - PRESET_MS[windowMode.value];
});
const endTime = computed<number>(() => {
  if (windowMode.value === 'custom') return customEnd.value;
  return windowEndAt.value;
});

function pickPreset(p: PresetKey): void {
  windowMode.value = p;
  windowEndAt.value = Date.now();
  customOpen.value = false;
  customError.value = null;
}

/* Format `epochMs → 'YYYY-MM-DDTHH:mm'` (datetime-local). Uses browser
 * TZ — display is browser-local; the BFF converts to OAP TZ on send. */
function toLocalInput(ms: number): string {
  const d = new Date(ms);
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const h = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${y}-${mo}-${dd}T${h}:${mi}`;
}
const customStartInput = ref<string>(toLocalInput(customStart.value));
const customEndInput = ref<string>(toLocalInput(customEnd.value));

function openCustom(): void {
  windowMode.value = 'custom';
  customOpen.value = true;
  customStartInput.value = toLocalInput(customStart.value);
  customEndInput.value = toLocalInput(customEnd.value);
  customError.value = null;
}
function applyCustom(): void {
  const s = new Date(customStartInput.value).getTime();
  const e = new Date(customEndInput.value).getTime();
  if (!Number.isFinite(s) || !Number.isFinite(e)) {
    customError.value = 'Invalid date';
    return;
  }
  if (e <= s) {
    customError.value = 'End must be after start';
    return;
  }
  if (e - s > MAX_CUSTOM_MS) {
    customError.value = `Window exceeds ${MAX_CUSTOM_MS / 60_000 / 60}h cap`;
    return;
  }
  customStart.value = s;
  customEnd.value = e;
  customError.value = null;
  customOpen.value = false;
}

// ── Capability + page config ────────────────────────────────────────
const { capabilities } = useOapInfo();
const hasQueryAlarms = computed<boolean>(() => capabilities.value.queryAlarms);

const pageConfig = useQuery({
  queryKey: ['alarms/config'],
  queryFn: (): Promise<AlarmsConfig> => bff.alarms.config(),
  staleTime: Infinity,
});
const pinnedLayers = computed<string[]>(() => pageConfig.data.value?.pinnedLayers ?? []);

/* Initial picker selection is admin-configured. We only apply the
 * config'd default once — after that the operator's manual picker
 * choices win (they shouldn't snap back on a refetch). The flag
 * survives across pageConfig refetches because it's outside the
 * `data` reactive. */
let didApplyDefault = false;
watch(
  () => pageConfig.data.value?.defaultWindowMs,
  (ms) => {
    if (didApplyDefault || ms === undefined) return;
    windowMode.value = presetFromMs(ms);
    didApplyDefault = true;
  },
  { immediate: true },
);

// ── Filters (new-mode cascade) ──────────────────────────────────────
/* Two layers of state: `draft` is what the operator is composing;
 * `applied` is what the alarms query actually filters by. Nothing
 * fires until `applyFilters()` (or pickPreset(), or onRefresh()). */
interface FilterValues {
  layer: string;
  service: string;
  instance: string;
  endpoint: string;
  keyword: string;
}
function emptyFilters(): FilterValues {
  return { layer: '', service: '', instance: '', endpoint: '', keyword: '' };
}
const draft = ref<FilterValues>(emptyFilters());
const applied = ref<FilterValues>(emptyFilters());

const { availableLayers } = useLayers();

const servicesQuery = useQuery({
  queryKey: computed(() => ['alarms/services', draft.value.layer]),
  queryFn: () => bff.alarms.services(draft.value.layer),
  enabled: computed(() => hasQueryAlarms.value && draft.value.layer.length > 0),
  staleTime: 30_000,
});
const serviceOptions = computed<string[]>(
  () => (servicesQuery.data.value?.services ?? []).map((s) => s.name),
);

const instancesQuery = useQuery({
  queryKey: computed(() => ['alarms/instances', draft.value.layer, draft.value.service]),
  queryFn: () => bffClient.layer.instances(draft.value.layer, draft.value.service),
  enabled: computed(
    () => hasQueryAlarms.value && draft.value.layer.length > 0 && draft.value.service.length > 0,
  ),
  staleTime: 30_000,
});
const instanceOptions = computed<string[]>(
  () => (instancesQuery.data.value?.instances ?? []).map((i) => i.name),
);

const endpointsQuery = useQuery({
  queryKey: computed(() => ['alarms/endpoints', draft.value.layer, draft.value.service]),
  queryFn: () => bffClient.layer.endpoints(draft.value.layer, draft.value.service, '', 50),
  enabled: computed(
    () => hasQueryAlarms.value && draft.value.layer.length > 0 && draft.value.service.length > 0,
  ),
  staleTime: 30_000,
});
const endpointOptions = computed<string[]>(
  () => (endpointsQuery.data.value?.endpoints ?? []).map((e) => e.name),
);

function onLayerChange(): void {
  draft.value.service = '';
  draft.value.instance = '';
  draft.value.endpoint = '';
}
function onServiceChange(): void {
  draft.value.instance = '';
  draft.value.endpoint = '';
}
function applyFilters(): void {
  applied.value = { ...draft.value };
}
function clearFilters(): void {
  draft.value = emptyFilters();
  applied.value = emptyFilters();
}
const isDirty = computed<boolean>(() => {
  const d = draft.value;
  const a = applied.value;
  return (
    d.layer !== a.layer ||
    d.service !== a.service ||
    d.instance !== a.instance ||
    d.endpoint !== a.endpoint ||
    d.keyword !== a.keyword
  );
});

// ── URL-reflected chip filter ───────────────────────────────────────
/* The header layer chips narrow the rendered list to that layer
 * (client-side filter on top of the fetched response). The selection
 * lives in the URL `?layer=GENERAL` so refresh / share preserves it
 * AND so the chip state survives a navigation. Empty / 'all' means
 * no chip filter active. */
const route = useRoute();
const router = useRouter();
const chipLayer = computed<string>({
  get: () => {
    const raw = route.query.layer;
    if (typeof raw === 'string') return raw.toUpperCase();
    return '';
  },
  set: (v: string) => {
    router.replace({ query: { ...route.query, layer: v ? v : undefined } });
  },
});
function selectChip(layerKey: string): void {
  chipLayer.value = layerKey === chipLayer.value ? '' : layerKey;
}

// ── Selection (alarm OR time range, mutually exclusive) ────────────
function keyFor(a: AlarmMessage): string {
  return `${a.id}::${a.startTime}`;
}
const selectedAlarmKey = ref<string | null>(null);
const selectedRange = ref<{ startTime: number; endTime: number } | null>(null);

/* Picking an alarm and brushing a range are NOT mutually exclusive:
 * the operator typically brushes first to narrow the rows, then
 * clicks one to inspect. Clearing the brush on row-click yanked the
 * list out from under the click and surprised everyone. Now row
 * selection only sets the alarm; the brush survives so the list
 * stays narrowed. Brushing still clears any alarm selection (a new
 * brush implies the operator is re-narrowing, and the previously
 * selected alarm may not be in the new slice). */
function selectAlarm(key: string): void {
  selectedAlarmKey.value = key;
}
function selectRange(r: { startTime: number; endTime: number }): void {
  selectedRange.value = r;
  selectedAlarmKey.value = null;
}
function clearSelection(): void {
  selectedAlarmKey.value = null;
  selectedRange.value = null;
}

// ── Alarms query ───────────────────────────────────────────────────
const alarmsQuery = useQuery({
  queryKey: computed(() => [
    'alarms',
    startTime.value,
    endTime.value,
    applied.value.layer,
    applied.value.service,
    applied.value.instance,
    applied.value.endpoint,
    applied.value.keyword,
  ]),
  queryFn: (): Promise<AlarmsResponse> =>
    bff.alarms.list({
      startTime: startTime.value,
      endTime: endTime.value,
      layer: applied.value.layer || undefined,
      service: applied.value.service || undefined,
      instance: applied.value.instance || undefined,
      endpoint: applied.value.endpoint || undefined,
      keyword: applied.value.keyword || undefined,
    }),
  staleTime: Infinity,
  refetchOnWindowFocus: false,
});

// ── Derived data ────────────────────────────────────────────────────
const alarms = computed<AlarmMessage[]>(() => alarmsQuery.data.value?.msgs ?? []);
const truncated = computed<boolean>(() => alarmsQuery.data.value?.truncated ?? false);

/** Events narrowed by the brushed time range. Drives the KPI + tab
 *  counts after incident merging. The chip / tab layer filter is
 *  applied LATER (on incidents), not here — otherwise every chip
 *  except the active one would zero out. */
const rangeScopedAlarms = computed<AlarmMessage[]>(() => {
  if (!selectedRange.value) return alarms.value;
  const { startTime: s, endTime: e } = selectedRange.value;
  return alarms.value.filter((a) => a.startTime >= s && a.startTime <= e);
});

/* ── Incident-merged view ────────────────────────────────────────
 * (entity, rule) → one incident. The page's counts + list operate
 * on incidents; the Timeline operates on raw events (so the
 * fire-then-recovered pattern stays visible).
 *
 * Per spec: an incident whose LATEST event has recoveryTime !== null
 * is "recovered" and does NOT count in totals / tabs / badges. Only
 * `state === 'firing'` incidents are counted. */
const rangeIncidents = computed<AlarmIncident[]>(() =>
  mergeIncidents(rangeScopedAlarms.value),
);

const countsByLayer = computed<Map<string, number>>(() => {
  const m = new Map<string, number>();
  for (const inc of rangeIncidents.value) {
    if (inc.state === 'recovered') continue;  // unstable is still actively firing
    const k = inc.layerKey ?? 'OTHER';
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return m;
});
const totalCount = computed<number>(
  () => rangeIncidents.value.filter((i) => i.state !== 'recovered').length,
);
/** Pinned layers always render in the header even when count = 0. */
const pinnedKpis = computed<Array<{ key: string; label: string; count: number }>>(() => {
  return pinnedLayers.value.map((k) => ({
    key: k,
    label: prettyLayer(k),
    count: countsByLayer.value.get(k) ?? 0,
  }));
});
/** Non-pinned layers with at least one active incident, descending
 *  by count. Recovered-only layers drop out — "no alarm as number". */
const overflowChips = computed<Array<{ key: string; label: string; count: number }>>(() => {
  const pinned = new Set(pinnedLayers.value);
  const out: Array<{ key: string; label: string; count: number }> = [];
  for (const [k, n] of countsByLayer.value.entries()) {
    if (pinned.has(k)) continue;
    if (n === 0) continue;
    out.push({ key: k, label: prettyLayer(k), count: n });
  }
  out.sort((a, b) => b.count - a.count);
  return out;
});

/** Row list uses the SAME incident merge as the counts: one row per
 *  (entity, rule). Re-firings of the same rule on the same entity
 *  collapse into a single row tagged "triggered N×"; the row's state
 *  reflects the latest firing (still firing or recovered). Recovered
 *  incidents stay visible in the list as recent history but already
 *  drop out of `totalCount` / `countsByLayer` above. */
const listEntries = computed<AlarmIncident[]>(() => rangeIncidents.value);
const filteredIncidents = computed<AlarmIncident[]>(() => {
  let rows = listEntries.value;
  if (chipLayer.value) {
    rows = rows.filter((i) => (i.layerKey ?? 'OTHER') === chipLayer.value);
  }
  return rows;
});

/* Expandable per-incident history — operators click the chevron to see
 * every individual firing/recovery on this (entity, rule) in time
 * order. Tracked by incident id; survives re-renders, cleared when the
 * page unmounts. The detail panel (right-side) keeps showing the latest
 * event regardless of which expanded sub-row is hovered. */
const expandedIncidents = ref<Set<string>>(new Set());
function isExpanded(id: string): boolean {
  return expandedIncidents.value.has(id);
}
function toggleExpanded(id: string): void {
  const next = new Set(expandedIncidents.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  expandedIncidents.value = next;
}

/** Per-state labels for the row. */
function stateBadgeLabel(inc: AlarmIncident): string {
  if (inc.state === 'recovered') {
    return inc.triggerCount > 1 ? `recovered · was triggered ${inc.triggerCount}×` : 'recovered';
  }
  if (inc.state === 'unstable') {
    const firingNow = inc.triggerCount - inc.recoveredCount;
    return `unstable · ${firingNow} firing, ${inc.recoveredCount} recovered`;
  }
  return inc.triggerCount > 1 ? `firing · triggered ${inc.triggerCount}×` : 'firing';
}
function stateBadgeClass(inc: AlarmIncident): string {
  if (inc.state === 'recovered') return 'is-ok';
  if (inc.state === 'unstable') return 'is-warn';
  return 'is-err';
}

/** Data feed for the timeline chart — chip-aware, range-IGNORANT.
 *  Brushing must not hide data outside the brush, otherwise the
 *  operator can't see other peaks to rebrush onto. The brush
 *  rectangle is the only visual marker for the selection. The
 *  timeline keeps every raw event (NOT incidents) so the firing /
 *  recovered pattern is fully visible. */
const timelineAlarms = computed<AlarmMessage[]>(() => {
  if (!chipLayer.value) return alarms.value;
  return alarms.value.filter((a) => (a.layerKey ?? 'OTHER') === chipLayer.value);
});

const selectedAlarm = computed<AlarmMessage | null>(() => {
  const k = selectedAlarmKey.value;
  if (!k) return null;
  return alarms.value.find((a) => keyFor(a) === k) ?? null;
});

// ── List tabs (by layer) ───────────────────────────────────────────
/* Tab strip above the row list: "All · pinned-1 · pinned-2 · …
 * overflow chips". The "All" tab maps to no layer filter; every
 * other tab maps to its layer key via `chipLayer`. We render the
 * same set of layers that the header KPIs + overflow chips show, so
 * the two surfaces stay consistent — different entry points to the
 * same `chipLayer` URL state. */
interface ListTab {
  key: string;
  label: string;
  count: number;
}
const listTabs = computed<ListTab[]>(() => {
  /* "All" uses `totalCount` (range-scoped), not `alarms.value.length`,
   * so it stays in sync with the per-layer counts after a brush. */
  const tabs: ListTab[] = [{ key: '', label: 'All', count: totalCount.value }];
  for (const k of pinnedLayers.value) {
    tabs.push({ key: k, label: prettyLayer(k), count: countsByLayer.value.get(k) ?? 0 });
  }
  for (const c of overflowChips.value) {
    tabs.push({ key: c.key, label: c.label, count: c.count });
  }
  return tabs;
});

// ── Frontend paging ────────────────────────────────────────────────
const PAGE_SIZE = 10;
const page = ref<number>(1);
const totalPages = computed<number>(
  () => Math.max(1, Math.ceil(filteredIncidents.value.length / PAGE_SIZE)),
);
const pagedIncidents = computed<AlarmIncident[]>(() => {
  const start = (page.value - 1) * PAGE_SIZE;
  return filteredIncidents.value.slice(start, start + PAGE_SIZE);
});

watch([filteredIncidents, chipLayer, startTime, endTime], () => {
  page.value = 1;
});

// ── Misc utils ─────────────────────────────────────────────────────
function prettyLayer(k: string): string {
  if (k === 'OTHER') return 'Other';
  return k
    .toLowerCase()
    .split('_')
    .map((w) => (w.length > 0 ? w[0]!.toUpperCase() + w.slice(1) : ''))
    .join(' ');
}

function formatRelative(ts: number): string {
  const delta = Date.now() - ts;
  if (delta < 0) return new Date(ts).toLocaleString();
  const s = Math.floor(delta / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m ago`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h ago`;
}

function formatWindowLabel(): string {
  if (windowMode.value === 'custom') {
    return `${new Date(customStart.value).toLocaleString()} → ${new Date(customEnd.value).toLocaleString()}`;
  }
  return `last ${windowMode.value}`;
}

watch([startTime, endTime], () => {
  selectedRange.value = null;
});

const refreshing = ref(false);
async function onRefresh(): Promise<void> {
  if (refreshing.value) return;
  refreshing.value = true;
  try {
    if (windowMode.value !== 'custom') windowEndAt.value = Date.now();
    await alarmsQuery.refetch();
  } finally {
    refreshing.value = false;
  }
}

onMounted(() => {
  /* Nothing to do here — vue-query fires on mount. */
});
</script>

<template>
  <div class="ax">
    <header class="ax__head">
      <div>
        <div class="ax__kicker">Alarms</div>
        <h1 class="ax__h1">Active alarms</h1>
        <p class="ax__lede">
          {{ formatWindowLabel() }}. Pinned layers come from
          <RouterLink to="/admin/alert-page-setup">Alert page setup</RouterLink>.
          Click a layer chip to narrow the list; click a flag on the timeline to inspect one
          alarm; brush a region to slice the list to that window.
        </p>
      </div>
      <div class="ax__header-actions">
        <div class="ax__window">
          <button
            v-for="p in PRESETS"
            :key="p"
            type="button"
            class="ax__window-btn"
            :class="{ active: windowMode === p }"
            @click="pickPreset(p)"
          >{{ p }}</button>
          <button
            type="button"
            class="ax__window-btn"
            :class="{ active: windowMode === 'custom' }"
            @click="openCustom"
          >custom</button>
        </div>
        <button
          type="button"
          class="ax__refresh"
          :disabled="refreshing"
          @click="onRefresh"
        >{{ refreshing ? 'refreshing…' : 'refresh' }}</button>
      </div>
    </header>

    <!-- Custom range editor — sits under the picker; closes on apply. -->
    <div v-if="customOpen" class="ax__custom">
      <label class="ax__custom-field">
        <span>Start</span>
        <input v-model="customStartInput" type="datetime-local" step="60" />
      </label>
      <label class="ax__custom-field">
        <span>End</span>
        <input v-model="customEndInput" type="datetime-local" step="60" />
      </label>
      <div v-if="customError" class="ax__custom-err">{{ customError }}</div>
      <div class="ax__custom-actions">
        <span class="ax__custom-hint">max {{ MAX_CUSTOM_MS / 60_000 / 60 }}h</span>
        <button type="button" class="ax__custom-btn" @click="customOpen = false">cancel</button>
        <button type="button" class="ax__custom-btn ax__custom-btn--primary" @click="applyCustom">apply</button>
      </div>
    </div>

    <!-- ── KPI strip: total + pinned + overflow chips ─────────────── -->
    <div class="ax__kpis">
      <button
        type="button"
        class="ax__kpi ax__kpi--total"
        :class="{ active: !chipLayer }"
        @click="chipLayer = ''"
      >
        <div class="ax__kpi-label">Active</div>
        <div class="ax__kpi-val" :class="{ 'ax__kpi-val--err': totalCount > 0 }">{{ totalCount }}</div>
        <div class="ax__kpi-sub">{{ rangeIncidents.length }} incident{{ rangeIncidents.length === 1 ? '' : 's' }}</div>
      </button>
      <button
        v-for="k in pinnedKpis"
        :key="k.key"
        type="button"
        class="ax__kpi"
        :class="{ active: chipLayer === k.key }"
        @click="selectChip(k.key)"
      >
        <div class="ax__kpi-label">{{ k.label }}</div>
        <div class="ax__kpi-val" :class="{ 'ax__kpi-val--err': k.count > 0 }">{{ k.count }}</div>
      </button>
      <div v-if="overflowChips.length > 0" class="ax__chips">
        <button
          v-for="c in overflowChips"
          :key="c.key"
          type="button"
          class="ax__chip"
          :class="{ active: chipLayer === c.key }"
          @click="selectChip(c.key)"
        >
          <span class="ax__chip-label">{{ c.label }}</span>
          <span class="ax__chip-count mono">{{ c.count }}</span>
        </button>
      </div>
    </div>

    <!-- ── Filter row — conditional on capabilities.queryAlarms ──── -->
    <div v-if="hasQueryAlarms" class="ax__filters">
      <label class="ax__filter">
        <span>Layer</span>
        <select v-model="draft.layer" @change="onLayerChange">
          <option value="">any layer</option>
          <option v-for="L in availableLayers" :key="L.key" :value="L.key.toUpperCase()">{{ L.name }}</option>
        </select>
      </label>
      <label class="ax__filter" :class="{ 'is-disabled': !draft.layer }">
        <span>Service</span>
        <select v-model="draft.service" :disabled="!draft.layer" @change="onServiceChange">
          <option value="">
            {{ !draft.layer ? 'pick a layer first' : servicesQuery.isFetching.value ? 'loading…' : 'any service' }}
          </option>
          <option v-for="name in serviceOptions" :key="name" :value="name">{{ name }}</option>
        </select>
      </label>
      <label class="ax__filter" :class="{ 'is-disabled': !draft.service }">
        <span>Instance</span>
        <select v-model="draft.instance" :disabled="!draft.service">
          <option value="">
            {{ !draft.service ? 'pick a service first' : instancesQuery.isFetching.value ? 'loading…' : 'any instance' }}
          </option>
          <option v-for="name in instanceOptions" :key="name" :value="name">{{ name }}</option>
        </select>
      </label>
      <label class="ax__filter" :class="{ 'is-disabled': !draft.service }">
        <span>Endpoint</span>
        <select v-model="draft.endpoint" :disabled="!draft.service">
          <option value="">
            {{ !draft.service ? 'pick a service first' : endpointsQuery.isFetching.value ? 'loading…' : 'any endpoint' }}
          </option>
          <option v-for="name in endpointOptions" :key="name" :value="name">{{ name }}</option>
        </select>
      </label>
      <label class="ax__filter ax__filter--wide">
        <span>Keyword</span>
        <input v-model="draft.keyword" type="text" placeholder="match alarm message" />
      </label>
      <button
        type="button"
        class="ax__filter-apply"
        :class="{ 'is-dirty': isDirty }"
        :disabled="!isDirty"
        @click="applyFilters"
      >{{ isDirty ? 'apply' : 'applied' }}</button>
      <button
        v-if="applied.layer || applied.service || applied.instance || applied.endpoint || applied.keyword"
        type="button"
        class="ax__filter-clear"
        @click="clearFilters"
      >clear</button>
    </div>
    <div v-else class="ax__filters ax__filters--legacy">
      <label class="ax__filter ax__filter--wide">
        <span>Keyword</span>
        <input v-model="draft.keyword" type="text" placeholder="match alarm message" />
      </label>
      <button
        type="button"
        class="ax__filter-apply"
        :class="{ 'is-dirty': isDirty }"
        :disabled="!isDirty"
        @click="applyFilters"
      >{{ isDirty ? 'apply' : 'applied' }}</button>
      <span class="ax__legacy-note">
        This OAP version supports keyword + tag filters only. Upgrade for layer + entity filters.
      </span>
    </div>

    <!-- ── Timeline (flags only) ─────────────────────────────────── -->
    <section class="ax__panel">
      <header class="ax__panel-head">
        <h3>Timeline</h3>
        <button
          type="button"
          class="ax__panel-reset"
          :disabled="!selectedRange && !selectedAlarmKey"
          title="Clear the selected time range / alarm"
          @click="clearSelection"
        >reset</button>
        <span v-if="alarmsQuery.isFetching.value" class="ax__refreshing">loading…</span>
        <span v-else-if="truncated" class="ax__panel-warn">
          showing {{ totalCount }} rows (page may be truncated — tighten the window)
        </span>
      </header>
      <AlarmsTimeline
        :alarms="timelineAlarms"
        :start-time="startTime"
        :end-time="endTime"
        :selected-range="selectedRange"
        :height="110"
        @select-time-range="selectRange"
        @clear-selection="clearSelection"
      />
    </section>

    <!-- ── List + detail ─────────────────────────────────────────── -->
    <section class="ax__split">
      <div class="ax__list">
        <!-- Layer tabs — same `chipLayer` state as the header KPIs, so
             clicking a tab and clicking a header chip do the same
             thing. URL `?layer=…` persists either selection. -->
        <div v-if="listTabs.length > 1" class="ax__tabs" role="tablist">
          <button
            v-for="t in listTabs"
            :key="t.key || '_all'"
            type="button"
            role="tab"
            class="ax__tab"
            :class="{ active: chipLayer === t.key }"
            :aria-selected="chipLayer === t.key"
            @click="chipLayer = t.key"
          >
            <span class="ax__tab-label">{{ t.label }}</span>
            <span class="ax__tab-count mono">{{ t.count }}</span>
          </button>
        </div>

        <div v-if="alarmsQuery.isPending.value" class="ax__empty">loading…</div>
        <div v-else-if="filteredIncidents.length === 0" class="ax__empty">
          No alarms in the current window.
        </div>

        <!-- One row per (entity, rule) incident. Click selects the
             incident's LATEST event for the detail panel — that's the
             one with the freshest snapshot. Incidents with N>1
             firings show a "triggered N times" subnote. -->
        <ul v-else class="ax__rows">
          <template v-for="inc in pagedIncidents" :key="inc.id">
            <li
              class="ax__row"
              :class="{
                active: keyFor(inc.latest) === selectedAlarmKey,
                resolved: inc.state === 'recovered',
                unstable: inc.state === 'unstable',
              }"
              @click="selectAlarm(keyFor(inc.latest))"
            >
              <span class="ax__sev" :class="['ax__sev--' + inc.state]" />
              <div class="ax__row-main">
                <div class="ax__row-entity">
                  <span class="ax__row-kind">{{ formatAlarmEntity(inc.latest.scope, inc.latest.name).prefix }}</span>
                  <code class="ax__row-entity-name">
                    <template v-for="(s, i) in formatAlarmEntity(inc.latest.scope, inc.latest.name).segments" :key="i">
                      <template v-if="s.kind === 'group'">
                        <span class="ax__row-entity-group">{{ s.group }}</span><span>{{ s.base }}</span>
                      </template>
                      <span v-else>{{ s.text }}</span>
                    </template>
                  </code>
                </div>
                <div class="ax__row-msg">{{ inc.latest.message }}</div>
                <div class="ax__row-meta">
                  <span v-if="inc.latest.layerKey" class="ax__row-tag">{{ prettyLayer(inc.latest.layerKey) }}</span>
                  <span v-else class="ax__row-tag ax__row-tag--other">Other</span>
                  <span class="ax__row-time">{{ formatRelative(inc.latest.startTime) }}</span>
                </div>
              </div>
              <span class="sw-badge" :class="stateBadgeClass(inc)">
                <span class="state-dot" />{{ stateBadgeLabel(inc) }}
              </span>
              <button
                v-if="inc.triggerCount > 1"
                type="button"
                class="ax__row-expand"
                :class="{ 'is-open': isExpanded(inc.id) }"
                :aria-expanded="isExpanded(inc.id)"
                :title="isExpanded(inc.id) ? 'Hide history' : `Show all ${inc.triggerCount} events`"
                @click.stop="toggleExpanded(inc.id)"
              >▾</button>
              <span v-else class="ax__row-expand-placeholder" aria-hidden="true" />
            </li>
            <!-- Expanded history: every individual firing/recovery
                 in startTime-ascending order. Clicking a sub-row
                 selects that specific event for the detail panel. -->
            <li
              v-if="isExpanded(inc.id) && inc.triggerCount > 1"
              class="ax__row-history"
              :key="inc.id + '::history'"
            >
              <ol>
                <li
                  v-for="(ev, evi) in inc.events"
                  :key="ev.startTime + '-' + evi"
                  class="ax__hist-row"
                  :class="{
                    active: keyFor(ev) === selectedAlarmKey,
                    'is-recovered': ev.recoveryTime !== null,
                  }"
                  @click.stop="selectAlarm(keyFor(ev))"
                >
                  <span class="ax__hist-idx mono">#{{ evi + 1 }}</span>
                  <span class="ax__hist-dot" :class="ev.recoveryTime !== null ? 'is-ok' : 'is-err'" />
                  <span class="ax__hist-label">
                    {{ ev.recoveryTime !== null ? 'recovered' : 'fired' }}
                  </span>
                  <span class="ax__hist-time mono">
                    {{ formatRelative(ev.recoveryTime ?? ev.startTime) }}
                  </span>
                </li>
              </ol>
            </li>
          </template>
        </ul>

        <!-- Frontend pager — only when there's more than one page. -->
        <nav v-if="totalPages > 1" class="ax__pager">
          <button
            type="button"
            class="ax__pager-btn"
            :disabled="page <= 1"
            @click="page = page - 1"
          >‹ prev</button>
          <span class="ax__pager-pos mono">page {{ page }} / {{ totalPages }}</span>
          <button
            type="button"
            class="ax__pager-btn"
            :disabled="page >= totalPages"
            @click="page = page + 1"
          >next ›</button>
        </nav>
      </div>

      <AlarmDetailPanel :alarm="selectedAlarm" />
    </section>
  </div>
</template>

<style scoped>
.ax {
  padding: 20px 20px 60px;
  max-width: 1600px;
  margin: 0 auto;
}
.ax__head {
  display: flex;
  align-items: flex-start;
  gap: 16px;
  margin-bottom: 16px;
}
.ax__head > div:first-child { flex: 1; }
.ax__kicker {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--sw-accent);
  margin-bottom: 4px;
}
.ax__h1 {
  font-size: 22px;
  font-weight: 600;
  letter-spacing: -0.02em;
  color: var(--sw-fg-0);
  margin: 0 0 8px;
}
.ax__lede {
  font-size: 12.5px;
  color: var(--sw-fg-1);
  line-height: 1.5;
  margin: 0;
  max-width: 820px;
}
.ax__lede a { color: var(--sw-accent); text-decoration: none; }
.ax__lede a:hover { text-decoration: underline; }

.ax__header-actions {
  display: flex;
  gap: 8px;
  align-items: stretch;
}
.ax__window {
  display: flex;
  gap: 2px;
  background: var(--sw-bg-1);
  border: 1px solid var(--sw-line);
  border-radius: 6px;
  padding: 3px;
}
.ax__window-btn {
  background: transparent;
  border: 0;
  color: var(--sw-fg-2);
  font: inherit;
  font-size: 11.5px;
  padding: 4px 12px;
  border-radius: 4px;
  cursor: pointer;
}
.ax__window-btn:hover { color: var(--sw-fg-0); }
.ax__window-btn.active {
  background: var(--sw-bg-3);
  color: var(--sw-fg-0);
}
.ax__refresh {
  background: var(--sw-bg-1);
  border: 1px solid var(--sw-line-2);
  color: var(--sw-fg-0);
  font: inherit;
  font-size: 11.5px;
  padding: 0 14px;
  border-radius: 6px;
  cursor: pointer;
  font-weight: 500;
}
.ax__refresh:not(:disabled):hover {
  background: var(--sw-bg-2);
  border-color: var(--sw-accent);
}
.ax__refresh:disabled { opacity: 0.55; cursor: not-allowed; }

/* Custom date range editor */
.ax__custom {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  background: var(--sw-bg-1);
  border: 1px solid var(--sw-line);
  border-radius: 8px;
  margin-bottom: 12px;
}
.ax__custom-field {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 10.5px;
  color: var(--sw-fg-3);
  text-transform: uppercase;
  letter-spacing: 0.08em;
}
.ax__custom-field input {
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line);
  color: var(--sw-fg-0);
  font: inherit;
  font-size: 12px;
  padding: 4px 6px;
  border-radius: 4px;
}
.ax__custom-err {
  color: var(--sw-err);
  font-size: 11px;
}
.ax__custom-actions {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 8px;
}
.ax__custom-hint {
  font-size: 10.5px;
  color: var(--sw-fg-3);
}
.ax__custom-btn {
  background: transparent;
  border: 1px solid var(--sw-line-2);
  color: var(--sw-fg-1);
  font: inherit;
  font-size: 11.5px;
  padding: 4px 12px;
  border-radius: 4px;
  cursor: pointer;
}
.ax__custom-btn--primary {
  background: var(--sw-accent);
  border-color: var(--sw-accent);
  color: #0a0d12;
  font-weight: 600;
}

/* KPI strip — total + pinned + overflow */
.ax__kpis {
  display: flex;
  flex-wrap: wrap;
  align-items: stretch;
  gap: 10px;
  margin-bottom: 14px;
}
.ax__kpi {
  background: var(--sw-bg-1);
  border: 1px solid var(--sw-line);
  border-radius: 8px;
  padding: 10px 16px;
  min-width: 120px;
  cursor: pointer;
  font: inherit;
  text-align: left;
  transition: border-color 0.1s ease;
}
.ax__kpi:hover { border-color: var(--sw-line-2); }
.ax__kpi.active {
  border-color: var(--sw-accent);
  box-shadow: inset 0 0 0 1px var(--sw-accent);
}
.ax__kpi--total {
  border-color: var(--sw-line-2);
}
.ax__kpi-label {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--sw-fg-3);
  font-weight: 600;
}
.ax__kpi-val {
  font-size: 24px;
  font-weight: 600;
  letter-spacing: -0.02em;
  color: var(--sw-fg-0);
  margin-top: 2px;
  font-variant-numeric: tabular-nums;
  line-height: 1.1;
}
.ax__kpi-val--err { color: var(--sw-err); }
.ax__kpi-sub {
  font-size: 10.5px;
  color: var(--sw-fg-3);
  margin-top: 2px;
}
.ax__chips {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  padding: 10px 4px;
  margin-left: auto;
  max-width: 600px;
}
.ax__chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: var(--sw-bg-1);
  border: 1px solid var(--sw-line);
  color: var(--sw-fg-1);
  font: inherit;
  font-size: 11.5px;
  padding: 4px 10px;
  border-radius: 12px;
  cursor: pointer;
}
.ax__chip:hover { background: var(--sw-bg-2); color: var(--sw-fg-0); }
.ax__chip.active {
  background: var(--sw-accent-soft);
  border-color: var(--sw-accent);
  color: var(--sw-accent-2);
}
.ax__chip-label { font-weight: 500; }
.ax__chip-count {
  font-size: 10.5px;
  color: var(--sw-fg-3);
  background: var(--sw-bg-2);
  padding: 0 5px;
  border-radius: 8px;
  font-variant-numeric: tabular-nums;
}
.ax__chip.active .ax__chip-count {
  background: var(--sw-bg-1);
  color: var(--sw-accent-2);
}

/* Filter row (re-used styles from the prior view) */
.ax__filters {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: stretch;
  margin-bottom: 14px;
  padding: 10px;
  background: var(--sw-bg-1);
  border: 1px solid var(--sw-line);
  border-radius: 8px;
}
.ax__filter {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 170px;
  padding: 6px 10px;
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line);
  border-radius: 5px;
  cursor: pointer;
}
.ax__filter--wide { flex: 1; min-width: 220px; }
.ax__filter:hover:not(.is-disabled) { border-color: var(--sw-line-2); }
.ax__filter:focus-within:not(.is-disabled) { border-color: var(--sw-accent); }
.ax__filter.is-disabled { opacity: 0.45; cursor: not-allowed; }
.ax__filter > span {
  font-size: 9.5px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--sw-fg-3);
  font-weight: 600;
}
.ax__filter select,
.ax__filter input[type='text'] {
  -webkit-appearance: none;
  -moz-appearance: none;
  appearance: none;
  background: transparent;
  border: 0;
  color: var(--sw-fg-0);
  font: inherit;
  font-size: 12px;
  padding: 1px 0;
  margin: 0;
  width: 100%;
  outline: none;
}
.ax__filter select {
  cursor: pointer;
  padding-right: 16px;
  background: transparent
    url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 6' width='10' height='6'><path d='M1 1l4 4 4-4' stroke='%23818a9c' stroke-width='1.4' fill='none' stroke-linecap='round'/></svg>")
    right 2px center / 9px no-repeat;
}
.ax__filter select:disabled { cursor: not-allowed; background-image: none; color: var(--sw-fg-2); }
.ax__filter-apply {
  align-self: stretch;
  display: inline-flex;
  align-items: center;
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line-2);
  color: var(--sw-fg-2);
  font: inherit;
  font-size: 11.5px;
  font-weight: 500;
  padding: 0 16px;
  border-radius: 5px;
  cursor: pointer;
  margin-left: auto;
}
.ax__filter-apply.is-dirty {
  background: var(--sw-accent);
  border-color: var(--sw-accent);
  color: #0a0d12;
  font-weight: 600;
}
.ax__filter-apply:disabled { cursor: default; }
.ax__filter-clear {
  align-self: stretch;
  display: inline-flex;
  align-items: center;
  background: transparent;
  border: 1px dashed var(--sw-line-2);
  color: var(--sw-fg-2);
  font: inherit;
  font-size: 11px;
  padding: 0 14px;
  border-radius: 5px;
  cursor: pointer;
}
.ax__filter-clear:hover { background: var(--sw-bg-2); color: var(--sw-fg-0); border-style: solid; }
.ax__filters--legacy { align-items: center; gap: 12px; }
.ax__legacy-note {
  font-size: 11px;
  color: var(--sw-fg-3);
  font-style: italic;
}

/* Panel + timeline */
.ax__panel {
  background: var(--sw-bg-1);
  border: 1px solid var(--sw-line);
  border-radius: 8px;
  padding: 12px;
  margin-bottom: 16px;
}
.ax__panel-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 8px;
  padding: 0 4px;
}
.ax__panel-head h3 {
  font-size: 12px;
  font-weight: 600;
  color: var(--sw-fg-1);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  margin: 0;
}
.ax__refreshing { margin-left: auto; font-size: 11px; color: var(--sw-fg-3); font-style: italic; }
.ax__panel-warn { margin-left: auto; font-size: 11px; color: var(--sw-warn); }
.ax__panel-reset {
  background: transparent;
  border: 1px solid var(--sw-line-2);
  color: var(--sw-fg-2);
  font: inherit;
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  padding: 2px 8px;
  border-radius: 4px;
  cursor: pointer;
}
.ax__panel-reset:not(:disabled):hover {
  border-color: rgba(239, 68, 68, 0.4);
  color: var(--sw-err);
  background: var(--sw-bg-2);
}
.ax__panel-reset:disabled { opacity: 0.35; cursor: not-allowed; }

/* Split list / detail */
.ax__split {
  display: grid;
  grid-template-columns: 1fr 360px;
  gap: 16px;
}
.ax__list { display: flex; flex-direction: column; gap: 12px; }
.ax__empty {
  padding: 24px;
  text-align: center;
  font-size: 12px;
  color: var(--sw-fg-3);
  background: var(--sw-bg-1);
  border: 1px dashed var(--sw-line);
  border-radius: 8px;
}
/* Layer tab strip — sits between the list header and the rows.
 * Tabs share state with the header KPI chips (both write `chipLayer`),
 * so visual sync is automatic. */
.ax__tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 2px;
  padding: 4px;
  background: var(--sw-bg-1);
  border: 1px solid var(--sw-line);
  border-radius: 8px;
  margin-bottom: -4px; /* visually attach to the rows below */
}
.ax__tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: transparent;
  border: 0;
  color: var(--sw-fg-2);
  font: inherit;
  font-size: 11.5px;
  padding: 5px 10px;
  border-radius: 5px;
  cursor: pointer;
}
.ax__tab:hover { background: var(--sw-bg-2); color: var(--sw-fg-0); }
.ax__tab.active {
  background: var(--sw-accent-soft);
  color: var(--sw-accent-2);
  font-weight: 600;
}
.ax__tab-label { line-height: 1; }
.ax__tab-count {
  font-size: 10px;
  color: var(--sw-fg-3);
  background: var(--sw-bg-2);
  padding: 1px 6px;
  border-radius: 8px;
  font-variant-numeric: tabular-nums;
  line-height: 1.4;
}
.ax__tab.active .ax__tab-count {
  background: var(--sw-bg-1);
  color: var(--sw-accent-2);
}
.ax__rows {
  list-style: none;
  margin: 0;
  padding: 0;
  background: var(--sw-bg-1);
  border: 1px solid var(--sw-line);
  border-radius: 8px;
  overflow: hidden;
}
.ax__row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--sw-line);
  cursor: pointer;
  transition: background 0.1s ease;
}
.ax__row:last-child { border-bottom: none; }
.ax__row:hover { background: var(--sw-bg-2); }
.ax__row.active { background: var(--sw-bg-3); box-shadow: inset 2px 0 0 var(--sw-accent); }
.ax__row.resolved { opacity: 0.65; }
.ax__sev {
  width: 3px;
  height: 26px;
  border-radius: 2px;
  flex-shrink: 0;
}
.ax__sev.is-err { background: var(--sw-err); }
.ax__sev.is-ok { background: var(--sw-ok); }
.ax__sev--firing { background: var(--sw-err); }
.ax__sev--recovered { background: var(--sw-ok); }
.ax__sev--unstable { background: var(--sw-warn); }
.ax__row-main { flex: 1; min-width: 0; }
.ax__row-entity {
  display: flex;
  align-items: baseline;
  gap: 6px;
  margin-bottom: 2px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ax__row-kind {
  font-size: 9.5px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--sw-accent);
  font-weight: 600;
  flex-shrink: 0;
}
.ax__row-entity code {
  font-family: var(--sw-mono);
  font-size: 11.5px;
  color: var(--sw-fg-0);
  background: transparent;
  padding: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ax__row-entity-name { display: inline-flex; align-items: baseline; gap: 0; }
.ax__row-entity-group {
  display: inline-block;
  font-family: var(--sw-mono);
  font-size: 9px;
  font-weight: 500;
  text-transform: lowercase;
  color: var(--sw-fg-2);
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line);
  padding: 0 5px;
  border-radius: 3px;
  margin-right: 5px;
  vertical-align: 1px;
  line-height: 1.5;
}
.ax__row-msg {
  font-size: 12px;
  color: var(--sw-fg-1);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ax__row-meta {
  font-size: 11px;
  color: var(--sw-fg-3);
  display: flex;
  gap: 8px;
  align-items: center;
  margin-top: 3px;
}
.ax__row-meta code {
  font-family: var(--sw-mono);
  font-size: 10.5px;
  color: var(--sw-fg-1);
  background: var(--sw-bg-2);
  padding: 1px 5px;
  border-radius: 3px;
}
.ax__row-tag {
  font-size: 10px;
  color: var(--sw-fg-2);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.ax__row-tag--other { color: var(--sw-fg-3); }
.ax__row-time { margin-left: auto; font-variant-numeric: tabular-nums; }

.ax__pager {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 10px;
}
.ax__pager-btn {
  background: var(--sw-bg-1);
  border: 1px solid var(--sw-line-2);
  color: var(--sw-fg-1);
  font: inherit;
  font-size: 11.5px;
  padding: 4px 12px;
  border-radius: 4px;
  cursor: pointer;
}
.ax__pager-btn:not(:disabled):hover { background: var(--sw-bg-2); color: var(--sw-fg-0); }
.ax__pager-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.ax__pager-pos { font-size: 11px; color: var(--sw-fg-2); font-variant-numeric: tabular-nums; }

.sw-badge .state-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
  margin-right: 4px;
  display: inline-block;
  vertical-align: middle;
}
.sw-badge.is-ok { color: var(--sw-ok); background: var(--sw-ok-soft); border-color: rgba(34,197,94,0.3); }
.sw-badge.is-err { color: var(--sw-err); background: var(--sw-err-soft); border-color: rgba(239,68,68,0.3); }
.sw-badge.is-warn { color: var(--sw-warn); background: var(--sw-warn-soft); border-color: rgba(234,179,8,0.3); }

/* ── Expand chevron + per-incident history ────────────────────────
   The chevron is only rendered when triggerCount > 1; otherwise a
   spacer keeps the row's grid alignment stable. */
.ax__row-expand,
.ax__row-expand-placeholder {
  width: 22px; height: 22px;
  display: inline-grid; place-items: center;
  margin-left: 8px;
  flex: 0 0 22px;
}
.ax__row-expand {
  background: transparent;
  border: 1px solid var(--sw-line-2);
  border-radius: 4px;
  color: var(--sw-fg-2);
  font-size: 12px;
  cursor: pointer;
  transition: transform 0.12s, border-color 0.1s, color 0.1s;
}
.ax__row-expand:hover {
  border-color: var(--sw-line-3);
  color: var(--sw-fg-0);
}
.ax__row-expand.is-open {
  transform: rotate(180deg);
  border-color: var(--sw-accent-line);
  color: var(--sw-accent-2);
}

.ax__row-history {
  list-style: none;
  margin: 0;
  padding: 0;
  background: var(--sw-bg-1);
  border-bottom: 1px solid var(--sw-line);
}
.ax__row-history ol {
  list-style: none;
  margin: 0;
  padding: 4px 14px 8px 56px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.ax__hist-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 4px 8px;
  border-radius: 4px;
  font-size: 11.5px;
  color: var(--sw-fg-2);
  cursor: pointer;
}
.ax__hist-row:hover { background: var(--sw-bg-2); color: var(--sw-fg-1); }
.ax__hist-row.active { background: var(--sw-accent-soft); color: var(--sw-fg-0); }
.ax__hist-idx { color: var(--sw-fg-3); width: 28px; }
.ax__hist-dot {
  width: 6px; height: 6px; border-radius: 50%;
}
.ax__hist-dot.is-err { background: var(--sw-err); }
.ax__hist-dot.is-ok { background: var(--sw-ok); }
.ax__hist-label { flex: 1; }
.ax__hist-row.is-recovered .ax__hist-label { color: var(--sw-ok); }
.ax__hist-row:not(.is-recovered) .ax__hist-label { color: var(--sw-err); }
.ax__hist-time { color: var(--sw-fg-3); font-variant-numeric: tabular-nums; }
</style>
