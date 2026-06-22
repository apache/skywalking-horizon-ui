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
  Per-layer BROWSER "Browser Logs" tab (#6784). Lists JS error logs from
  OAP and de-obfuscates the minified stack against an operator-chosen
  source map (held in BFF memory). Visual vocabulary is deliberately the
  SAME as the general Logs tab — category legend + counts, time-bucketed
  density histogram, dense stream rows — so the two read identically. The
  one addition is the row-expand panel: raw stack + source-map resolution.
-->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { useI18n } from 'vue-i18n';
import type {
  BrowserErrorCategory,
  BrowserErrorRow,
  LayerDef,
  ResolveResponse,
  SourceMapDescriptor,
  SourceMapUsage,
} from '@/api/client';
import { bffClient, describeApiError } from '@/api/client';
import { useLayers } from '@/shell/useLayers';
import { useSetupStore } from '@/state/setup';
import { useSelectedService } from '@/layer/useSelectedService';
import { useLayerLanding } from '@/layer/useLayerLanding';
import { useLayerServiceName } from '@/layer/useLayerServiceName';
import { useLayerInstances } from '@/layer/useLayerInstances';
import { useLayerEndpoints } from '@/layer/useLayerEndpoints';
import { useLayerBrowserErrors } from '@/layer/browser-errors/useLayerBrowserErrors';
import SourceMapManager from '@/layer/browser-errors/SourceMapManager.vue';

const route = useRoute();
const { t } = useI18n({ useScope: 'global' });
const layerKey = computed(() => String(route.params.layerKey ?? ''));

const { layers } = useLayers();
const layer = computed<LayerDef | null>(() => layers.value.find((l) => l.key === layerKey.value) ?? null);
const setup = useSetupStore();
const { selectedId, setSelected } = useSelectedService();
const safeLayer = computed<LayerDef>(
  () =>
    layer.value ?? {
      key: layerKey.value,
      name: layerKey.value,
      color: 'var(--sw-fg-2)',
      serviceCount: -1,
      active: false,
      level: null,
      slots: {},
      caps: {},
    },
);
const safeCfg = computed(() => {
  if (!layer.value) return { priority: 99, topN: 5, orderBy: 'cpm', columns: [], style: 'table' as const };
  return setup.ensure(layer.value.key, {
    slots: layer.value.slots,
    caps: layer.value.caps,
    metrics: layer.value.metrics,
    overview: layer.value.overview,
  }).landing;
});
const landing = useLayerLanding(safeLayer, safeCfg);
const serviceName = useLayerServiceName(layerKey, landing);
const landingRows = computed(() => landing.data.value?.sampledRows ?? landing.rows.value ?? []);
watch(
  landingRows,
  (rows) => {
    const first = rows[0];
    if (first && !selectedId.value) setSelected(first.serviceId);
  },
  { immediate: true },
);

// ── Time range (own to this triage page — the topbar pauses the global
// ticker here) + paging. Preset window OR a Custom absolute range, exactly
// like the Logs conditions bar. ─────────────────────────────────────────
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
// Send the custom range as epoch MS — the datetime-local inputs are
// browser-local, so `new Date(value)` yields the correct absolute instant.
// The BFF renders it in OAP-server-local using the OAP offset; sending a
// bare local string would be misread as OAP-local and miss by the TZ delta.
const startMsRef = computed<number | null>(() =>
  isCustomRange.value && customStart.value ? new Date(customStart.value).getTime() : null,
);
const endMsRef = computed<number | null>(() =>
  isCustomRange.value && customEnd.value ? new Date(customEnd.value).getTime() : null,
);
const windowMinutesEffective = computed<number>(() => (isCustomRange.value ? 0 : windowMinutes.value));
const page = ref(1);
const pageSize = ref(30);
// The query always pulls every category; the legend filters the stream
// client-side (mirrors the Logs legend) so the chips can show full
// per-category counts regardless of which one is selected.
const allCategories = ref<BrowserErrorCategory>('ALL');

// Server-side filters (mirror booster-ui's Version + Page conditions):
// the BROWSER "Versions" are instances → serviceVersionId; "Pages" are
// endpoints → pagePathId. Reuse the shared layer instance/endpoint feeds.
const selectedVersionId = ref('');
const { instances: versionList } = useLayerInstances(layerKey, serviceName);

// Page (endpoint) is a searchable combobox, not a plain dropdown: OAP
// returns only a top-N endpoint list, so the typed keyword is forwarded to
// the endpoint search (`pageQuery`) to surface pages outside the top-N.
const selectedPageId = ref('');
const selectedPageLabel = ref('');
const pageSearchInput = ref('');
const pageComboOpen = ref(false);
const pageComboEl = ref<HTMLElement | null>(null);
const pageQuery = ref('');
const pageLimit = ref(50);
const { endpoints: pageList } = useLayerEndpoints(layerKey, serviceName, pageQuery, pageLimit);
function onPageInput(ev: Event): void {
  const v = (ev.target as HTMLInputElement).value;
  pageSearchInput.value = v;
  pageQuery.value = v.trim();
  pageComboOpen.value = true;
}
function pickPage(p: { id: string; name: string }): void {
  selectedPageId.value = p.id;
  selectedPageLabel.value = p.name;
  pageSearchInput.value = '';
  pageQuery.value = '';
  pageComboOpen.value = false;
}
function clearPage(): void {
  selectedPageId.value = '';
  selectedPageLabel.value = '';
  pageSearchInput.value = '';
  pageQuery.value = '';
  pageComboOpen.value = false;
}
function onPageComboClickOutside(ev: MouseEvent): void {
  if (!pageComboOpen.value) return;
  const el = pageComboEl.value;
  if (el && !el.contains(ev.target as Node)) pageComboOpen.value = false;
}
onMounted(() => window.addEventListener('click', onPageComboClickOutside));
onBeforeUnmount(() => window.removeEventListener('click', onPageComboClickOutside));

const { logs, total, reachable, queryError, isFetching, refetch } = useLayerBrowserErrors(layerKey, {
  service: serviceName,
  serviceVersionId: selectedVersionId,
  pagePathId: selectedPageId,
  category: allCategories,
  page,
  pageSize,
  windowMinutes: windowMinutesEffective,
  startMs: startMsRef,
  endMs: endMsRef,
});

// Reset the version/page filters when the app changes (their ids belong to
// the previous service), and reset paging on any condition change.
watch(serviceName, () => {
  selectedVersionId.value = '';
  clearPage();
});
watch([serviceName, windowMinutes, customStart, customEnd, selectedVersionId, selectedPageId, pageSize], () => {
  page.value = 1;
});
// Collapse the open row + its resolution whenever a fresh result set
// lands. (Category-filter toggles reset it too — see toggleCat — because
// `expanded` is an index into `filteredLogs`, which changes when the
// filter changes.)
watch(logs, () => {
  closeExpanded();
});

const hasMorePages = computed(() => logs.value.length >= pageSize.value);

// ── Categories: legend + histogram colours (uses the same tokens the
// Logs view uses for level colours, so the two tabs share a palette). ─
const CATEGORY_ORDER = ['js', 'promise', 'vue', 'ajax', 'resource', 'unknown'] as const;
type Cat = (typeof CATEGORY_ORDER)[number];
const CATEGORY_COLOR: Record<Cat, string> = {
  js: 'var(--sw-err)',
  promise: 'var(--sw-warn)',
  vue: 'var(--sw-info)',
  ajax: 'var(--sw-accent-2)',
  resource: 'var(--sw-cyan)',
  unknown: 'var(--sw-fg-3)',
};
function catOf(r: BrowserErrorRow): Cat {
  const c = (r.category ?? '').toLowerCase();
  return (CATEGORY_ORDER as readonly string[]).includes(c) ? (c as Cat) : 'unknown';
}

const selectedCat = ref<Cat | null>(null);
function toggleCat(c: Cat): void {
  selectedCat.value = selectedCat.value === c ? null : c;
  // `expanded` indexes into filteredLogs, which just changed — drop it.
  closeExpanded();
}
const filteredLogs = computed<BrowserErrorRow[]>(() =>
  selectedCat.value ? logs.value.filter((r) => catOf(r) === selectedCat.value) : logs.value,
);
const catFacet = computed<Record<Cat, number>>(() => {
  const counts = { js: 0, promise: 0, vue: 0, ajax: 0, resource: 0, unknown: 0 } as Record<Cat, number>;
  for (const r of logs.value) counts[catOf(r)] += 1;
  return counts;
});

// ── Density histogram (60 bins) — counts per category over the loaded
// rows' time window, same construction as the Logs tab. ──────────────
const BINS = 60;
const histogram = computed(() => {
  const rows = logs.value;
  if (rows.length === 0) return { bins: [] as Array<Record<Cat, number>>, max: 0, t0: 0, t1: 0 };
  let t0 = Infinity;
  let t1 = -Infinity;
  for (const r of rows) {
    if (r.time < t0) t0 = r.time;
    if (r.time > t1) t1 = r.time;
  }
  if (!Number.isFinite(t0) || !Number.isFinite(t1) || t0 === t1) {
    t0 = (t1 || Date.now()) - 60_000;
    t1 = t1 || Date.now();
  }
  const span = t1 - t0 || 1;
  const bins: Array<Record<Cat, number>> = Array.from({ length: BINS }, () => ({
    js: 0, promise: 0, vue: 0, ajax: 0, resource: 0, unknown: 0,
  }));
  for (const r of rows) {
    const idx = Math.min(BINS - 1, Math.floor(((r.time - t0) / span) * BINS));
    bins[idx][catOf(r)] += 1;
  }
  let max = 0;
  for (const b of bins) {
    const t = b.js + b.promise + b.vue + b.ajax + b.resource + b.unknown;
    if (t > max) max = t;
  }
  return { bins, max, t0, t1 };
});
const hoveredBin = ref<number | null>(null);
function binTotal(b: Record<Cat, number>): number {
  return b.js + b.promise + b.vue + b.ajax + b.resource + b.unknown;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}
function fmtTime(ts: number): string {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}
function fmtDate(ts: number): string {
  const d = new Date(ts);
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function fmtAxisTime(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function fmtBucketRange(i: number, t0: number, t1: number): string {
  const span = (t1 - t0) || 1;
  const a = t0 + (span * i) / BINS;
  const b = t0 + (span * (i + 1)) / BINS;
  const t = (ms: number) => {
    const d = new Date(ms);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  };
  return `${t(a)} – ${t(b)}`;
}

// ── Source-map cache (shared by the manager + the per-row picker) ───
const showMaps = ref(false);
const sourceMaps = ref<SourceMapDescriptor[]>([]);
const usage = ref<SourceMapUsage | null>(null);
const mapsEnabled = ref(true);
const mapsBusy = ref(false);
const mapsError = ref<string | null>(null);

async function loadMaps(): Promise<void> {
  try {
    const res = await bffClient.browserErrors.listSourceMaps();
    sourceMaps.value = res.maps;
    usage.value = res.usage;
    mapsEnabled.value = res.enabled;
    mapsError.value = null;
  } catch (err) {
    mapsError.value = describeApiError(err);
  }
}
async function onUpload(file: File): Promise<void> {
  mapsBusy.value = true;
  mapsError.value = null;
  try {
    const res = await bffClient.browserErrors.uploadSourceMap(file);
    if (!res.ok) mapsError.value = t('Upload rejected: {reason}', { reason: res.error ?? t('unknown') });
    await loadMaps();
    if (res.ok && res.map && !selectedMapId.value) selectedMapId.value = res.map.id;
  } catch (err) {
    mapsError.value = describeApiError(err);
  } finally {
    mapsBusy.value = false;
  }
}
async function onRemove(id: string): Promise<void> {
  mapsBusy.value = true;
  try {
    await bffClient.browserErrors.deleteSourceMap(id);
    if (selectedMapId.value === id) selectedMapId.value = '';
    await loadMaps();
  } catch (err) {
    mapsError.value = describeApiError(err);
  } finally {
    mapsBusy.value = false;
  }
}
onMounted(loadMaps);

// ── Row expand + source-map resolution (one row open at a time) ─────
const expanded = ref<number | null>(null);
const selectedMapId = ref<string>('');
const resolved = ref<ResolveResponse | null>(null);
const resolveBusy = ref(false);
const resolveErr = ref<string | null>(null);

// idx is part of the key so rows stay uniquely keyed even when the demo
// reports several errors at the identical timestamp+page+version (a
// data-only key would collide). Same approach as the Logs stream.
function rowKey(r: BrowserErrorRow, idx: number): string {
  return `${r.time}-${r.category}-${idx}`;
}
function closeExpanded(): void {
  expanded.value = null;
  resolved.value = null;
  resolveErr.value = null;
}
function toggleRow(idx: number): void {
  if (expanded.value === idx) {
    closeExpanded();
    return;
  }
  expanded.value = idx;
  resolved.value = null;
  resolveErr.value = null;
  if (!selectedMapId.value && sourceMaps.value.length > 0) selectedMapId.value = sourceMaps.value[0].id;
}
async function resolveRow(row: BrowserErrorRow): Promise<void> {
  if (!selectedMapId.value) return;
  resolveBusy.value = true;
  resolveErr.value = null;
  resolved.value = null;
  try {
    const res = await bffClient.browserErrors.resolve({
      stack: row.stack ?? undefined,
      line: row.line ?? undefined,
      col: row.col ?? undefined,
      errorUrl: row.errorUrl ?? undefined,
      category: row.category,
      sourceMapId: selectedMapId.value,
    });
    resolved.value = res;
    if (!res.ok) resolveErr.value = t('Could not resolve: {reason}', { reason: res.error ?? t('unknown') });
  } catch (err) {
    resolveErr.value = describeApiError(err);
  } finally {
    resolveBusy.value = false;
  }
}
function loc(row: BrowserErrorRow): string {
  // Browser line/col are 1-based; OAP reports 0 for categories that carry
  // no top-level position (PROMISE/AJAX/…), so a positive line is the
  // signal that a position is real. Avoids "0:0" littering every row.
  if (!row.line) return '';
  return `${row.line}:${row.col ?? 0}`;
}
</script>

<template>
  <div class="lg-tab">
    <!-- Conditions card — same shape/vocabulary as the Logs conditions
         bar (kicker + Run query head, label-on-top field grid). Source
         maps sits on the right of the head; its panel expands below. -->
    <section class="lg-toolbar sw-card">
      <div class="lg-toolbar-head">
        <span class="kicker">{{ t('Browser Logs') }}</span>
        <div class="be-head-right">
          <button type="button" class="be-maps-toggle" @click="showMaps = !showMaps">
            <span class="be-caret">{{ showMaps ? '▾' : '▸' }}</span>
            {{ t('Source maps') }}
            <span class="be-maps-count">{{ sourceMaps.length }}</span>
          </button>
          <button class="sw-btn primary" type="button" :disabled="isFetching" @click="refetch()">{{ t('Run query') }}</button>
        </div>
      </div>
      <div class="lg-conditions">
        <label class="cf">
          <span>{{ t('Version') }}</span>
          <select v-model="selectedVersionId" class="cf-input" :disabled="!serviceName" :title="t('Service version')">
            <option value="">{{ t('All versions') }}</option>
            <option v-for="v in versionList" :key="v.id" :value="v.id">{{ v.name }}</option>
          </select>
        </label>
        <div ref="pageComboEl" class="cf cf-span-3 cf-combo-field">
          <span>{{ t('Page') }}</span>
          <div class="be-combo">
            <input
              class="cf-input be-combo-input"
              type="text"
              :value="pageSearchInput"
              :placeholder="selectedPageLabel || t('All pages')"
              :disabled="!serviceName"
              :title="t('Search page path')"
              @focus="pageComboOpen = true"
              @input="onPageInput"
            />
            <button
              v-if="selectedPageId || pageSearchInput"
              type="button"
              class="be-combo-clear"
              :title="t('Clear page')"
              @click="clearPage"
            >×</button>
            <ul v-if="pageComboOpen" class="be-combo-list">
              <li class="be-combo-item" :class="{ on: !selectedPageId }" @click="clearPage"><em>{{ t('All pages') }}</em></li>
              <li
                v-for="p in pageList"
                :key="p.id"
                class="be-combo-item"
                :class="{ on: selectedPageId === p.id }"
                @click="pickPage(p)"
              >{{ p.name }}</li>
              <li v-if="pageList.length === 0" class="be-combo-empty">{{ t('no matches') }}</li>
            </ul>
          </div>
        </div>
        <label class="cf cf-wide">
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
            <option v-for="p in TIME_RANGE_PRESETS" :key="p.minutes" :value="p.minutes">{{ t(p.label) }}</option>
            <option :value="CUSTOM_RANGE_SENTINEL">{{ t('Custom…') }}</option>
          </select>
        </label>
        <label class="cf">
          <span>{{ t('Page size') }}</span>
          <select v-model.number="pageSize" class="cf-input">
            <option :value="20">20</option>
            <option :value="30">30</option>
            <option :value="50">50</option>
            <option :value="100">100</option>
          </select>
        </label>
      </div>
      <SourceMapManager
        v-if="showMaps"
        :maps="sourceMaps"
        :usage="usage"
        :enabled="mapsEnabled"
        :busy="mapsBusy"
        @upload="onUpload"
        @remove="onRemove"
        @refresh="loadMaps"
      />
      <p v-if="mapsError" class="be-maps-err">{{ mapsError }}</p>
    </section>

    <section class="lg-body sw-card">
      <div class="lg-main">
        <!-- Category legend — one chip per category with the in-window
             count; click toggles the stream filter. Mirrors the Logs
             "Levels" strip. -->
        <div v-if="logs.length > 0" class="lg-legend">
          <span class="lg-legend-kicker">{{ t('Categories') }}</span>
          <button
            v-for="c in CATEGORY_ORDER"
            :key="c"
            type="button"
            class="lg-legend-chip"
            :class="{ on: selectedCat === c }"
            @click="toggleCat(c)"
          >
            <span class="lvl-dot" :style="{ background: CATEGORY_COLOR[c] }" />
            <span class="lg-legend-name">{{ c }}</span>
            <span v-if="catFacet[c] > 0" class="lg-legend-count">{{ catFacet[c] }}</span>
          </button>
          <span class="lg-legend-sample">{{ t('{count} in window', { count: logs.length }) }}</span>
        </div>

        <!-- Density bar — x: time, y: count, colour: category. -->
        <div class="lg-density-wrap" v-if="histogram.bins.length > 0" @mouseleave="hoveredBin = null">
          <div class="lg-density">
            <div
              v-for="(bin, i) in histogram.bins"
              :key="i"
              class="lg-density-bin"
              @mouseenter="hoveredBin = i"
            >
              <span
                v-for="c in CATEGORY_ORDER"
                :key="c"
                class="lg-density-segment"
                :style="{
                  background: CATEGORY_COLOR[c],
                  height: histogram.max ? (bin[c] / histogram.max * 100) + '%' : '0%',
                }"
              />
            </div>
            <div
              v-if="hoveredBin !== null"
              class="lg-density-tip"
              :style="{ left: ((hoveredBin + 0.5) / 60) * 100 + '%' }"
            >
              <div class="lg-density-tip-time">{{ fmtBucketRange(hoveredBin, histogram.t0, histogram.t1) }}</div>
              <div class="lg-density-tip-total">
                {{ t('{count} logs', { count: binTotal(histogram.bins[hoveredBin]) }) }}
              </div>
              <div class="lg-density-tip-rows">
                <span v-for="c in CATEGORY_ORDER" :key="c" v-show="histogram.bins[hoveredBin][c] > 0" class="lg-density-tip-row">
                  <span class="lvl-dot" :style="{ background: CATEGORY_COLOR[c] }" />
                  <span class="lg-density-tip-name">{{ c }}</span>
                  <span class="lg-density-tip-val mono">{{ histogram.bins[hoveredBin][c] }}</span>
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

        <!-- States + stream -->
        <div v-if="!serviceName" class="lg-empty">{{ t('Select an app to view its browser logs.') }}</div>
        <div v-else-if="isFetching && logs.length === 0" class="lg-empty">{{ t('Reading data…') }}</div>
        <div v-else-if="!reachable" class="lg-empty">{{ t('Backend unreachable.') }}<span v-if="queryError"> {{ queryError }}</span></div>
        <div v-else-if="filteredLogs.length === 0" class="lg-empty">
          {{ logs.length === 0 ? t('No browser logs in this window.') : t('No logs match the selected category.') }}
        </div>
        <div v-else class="lg-stream">
          <template v-for="(r, idx) in filteredLogs" :key="rowKey(r, idx)">
            <div
              class="lg-row"
              :class="{ 'is-open': expanded === idx }"
              :style="{ boxShadow: `inset 3px 0 0 ${CATEGORY_COLOR[catOf(r)]}` }"
              @click="toggleRow(idx)"
            >
              <span class="lg-time mono">{{ fmtTime(r.time) }}</span>
              <span class="lg-date mono dim">{{ fmtDate(r.time) }}</span>
              <span class="lg-lvl" :style="{ color: CATEGORY_COLOR[catOf(r)] }">{{ r.category }}</span>
              <span class="lg-svc mono dim" :title="r.pagePath">{{ r.pagePath || '—' }}</span>
              <span class="lg-ver mono dim" :title="r.serviceVersion">{{ r.serviceVersion || '—' }}</span>
              <span class="lg-content mono">
                <span v-if="loc(r)" class="lg-loc">{{ loc(r) }}</span>
                <span class="lg-content-body">{{ r.message || t('(no message)') }}</span>
              </span>
            </div>

            <div v-if="expanded === idx" class="lg-expand" @click.stop>
              <div class="be-meta">
                <span v-if="r.errorUrl" class="be-meta-item mono" :title="r.errorUrl">{{ r.errorUrl }}</span>
                <span v-if="r.grade" class="be-meta-item">{{ t('grade') }}: {{ r.grade }}</span>
                <span v-if="r.firstReportedError" class="be-meta-item be-first">{{ t('first occurrence') }}</span>
              </div>
              <div class="be-cols">
                <div class="be-col">
                  <div class="be-col-head">{{ t('Raw stack') }}</div>
                  <pre class="be-pre">{{ r.stack || t('(no stack)') }}</pre>
                </div>
                <div class="be-col">
                  <div class="be-col-head">
                    <span>{{ t('Resolved') }}</span>
                    <select v-model="selectedMapId" class="f-select be-map-pick" :disabled="sourceMaps.length === 0">
                      <option value="" disabled>{{ sourceMaps.length ? t('Pick a source map…') : t('No maps loaded') }}</option>
                      <option v-for="m in sourceMaps" :key="m.id" :value="m.id">
                        {{ m.label }}{{ m.origin === 'upload' ? ' ' + t('(temp)') : '' }}
                      </option>
                    </select>
                    <button class="sw-btn small primary" type="button" :disabled="!selectedMapId || resolveBusy" @click="resolveRow(r)">{{ t('Resolve') }}</button>
                  </div>
                  <p v-if="resolveErr" class="be-maps-err">{{ resolveErr }}</p>
                  <p v-else-if="resolveBusy" class="be-dim">{{ t('Resolving…') }}</p>
                  <div v-else-if="resolved && resolved.ok" class="be-frames">
                    <div v-for="(f, fi) in resolved.frames" :key="fi" class="be-frame">
                      <div class="be-frame-line">
                        <span class="be-frame-fn">{{ f.generated.fn || t('(anonymous)') }}</span>
                        <span v-if="f.original" class="be-frame-orig">
                          {{ f.original.source }}:{{ f.original.line }}:{{ f.original.col }}
                          <span v-if="f.original.name" class="be-frame-name">→ {{ f.original.name }}</span>
                        </span>
                        <span v-else class="be-frame-unmapped">{{ t('unmapped ({line}:{col})', { line: f.generated.line, col: f.generated.col }) }}</span>
                      </div>
                      <pre v-if="f.snippet" class="be-snippet"><code v-for="(ln, li) in f.snippet.lines" :key="li" class="be-snip-line" :class="{ 'is-hit': f.original && f.snippet.startLine + li === f.original.line }"><span class="be-snip-no">{{ f.snippet.startLine + li }}</span><span class="be-snip-code">{{ ln }}</span></code></pre>
                    </div>
                  </div>
                  <p v-else class="be-dim">{{ t('Pick a source map and resolve to de-obfuscate this stack.') }}</p>
                </div>
              </div>
            </div>
          </template>
        </div>

        <div class="lg-pager">
          <span class="hint">{{ t('page {page} · showing {shown} of {total} loaded', { page, shown: filteredLogs.length, total }) }}</span>
          <div class="lg-pager-ctrls">
            <button class="sw-btn small" type="button" :disabled="page <= 1 || isFetching" @click="page--">{{ t('Prev') }}</button>
            <button class="sw-btn small" type="button" :disabled="!hasMorePages || isFetching" @click="page++">{{ t('Next') }}</button>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
/* Visual vocabulary copied from the Logs tab so the two read identically
   (LayerLogsView keeps its own scoped copy — they intentionally don't
   share a stylesheet so neither can regress the other). */
.lg-tab { display: flex; flex-direction: column; gap: 12px; padding: 4px 0 0; }

/* Conditions card — mirrors the Logs conditions bar: a padded sw-card
   with a kicker + Run-query head, then a 4-column grid of label-on-top
   full-width fields. */
/* overflow:visible so the Page combobox dropdown isn't clipped by the
   card's rounded-corner overflow (same as the Logs conditions card). */
.lg-toolbar { padding: 10px 12px; display: flex; flex-direction: column; gap: 10px; overflow: visible; }
.lg-toolbar-head { display: flex; align-items: center; gap: 10px; width: 100%; }
.kicker { font-size: 10px; text-transform: uppercase; letter-spacing: 0.1em; color: var(--sw-accent); font-weight: 600; }
.be-head-right { margin-left: auto; display: inline-flex; align-items: center; gap: 8px; }
.lg-conditions { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px 10px; }
@media (max-width: 900px) { .lg-conditions { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
.cf { display: flex; flex-direction: column; gap: 3px; font-size: 11px; color: var(--sw-fg-3); font-weight: 500; min-width: 0; }
.cf-wide { grid-column: span 2; }
/* Row 1 = Version (1 col) + Page (3 cols, fills the row); Time range
   (span 2) then flows onto row 2 — always its own second row. */
.cf-span-3 { grid-column: span 3; }
.cf-input {
  height: 28px;
  width: 100%;
  padding: 0 8px;
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line-2);
  border-radius: 4px;
  color: var(--sw-fg-0);
  font: inherit;
  font-size: 11px;
  box-sizing: border-box;
}
.cf-input:focus { outline: none; border-color: var(--sw-accent-line); }
.cf-input:disabled { opacity: 0.5; cursor: not-allowed; }
.cf-range { display: flex; align-items: center; gap: 4px; }
.cf-range-num { flex: 1; min-width: 0; }
.cf-range-sep { color: var(--sw-fg-3); font-size: 12px; flex: 0 0 auto; }
/* Searchable Page (endpoint) combobox — typed keyword feeds the OAP
   endpoint search, so pages outside the top-N list still surface. */
.cf-combo-field .be-combo { position: relative; width: 100%; }
.be-combo { position: relative; }
.be-combo-input { width: 100%; padding-right: 22px; }
.be-combo-input::placeholder { color: var(--sw-fg-2); }
.be-combo-clear {
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
.be-combo-clear:hover { color: var(--sw-err); }
.be-combo-list {
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
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
}
.be-combo-item {
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
.be-combo-item:hover { background: var(--sw-bg-2); color: var(--sw-fg-0); }
.be-combo-item.on { background: var(--sw-accent-soft); color: var(--sw-accent-2); font-weight: 600; }
.be-combo-item em { font-style: normal; }
.be-combo-empty { padding: 6px 8px; font-size: 10.5px; color: var(--sw-fg-3); }
.lg-legend-sample { margin-left: auto; font-size: 10.5px; color: var(--sw-fg-3); font-family: var(--sw-mono); }
.be-maps-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 26px;
  background: transparent;
  border: 1px solid var(--sw-line-2);
  border-radius: 6px;
  color: var(--sw-fg-2);
  font: inherit;
  font-size: 11.5px;
  padding: 4px 10px;
  cursor: pointer;
}
.be-maps-toggle:hover { color: var(--sw-fg-0); border-color: var(--sw-line); }
.be-caret { color: var(--sw-fg-3); }
.be-maps-count {
  font-family: var(--sw-mono);
  font-size: 10.5px;
  color: var(--sw-fg-2);
  background: var(--sw-bg-2);
  border-radius: 8px;
  padding: 0 6px;
}
.be-maps-err { margin: 0; font-size: 11.5px; color: var(--sw-err); }

.lg-body { padding: 0; min-height: 540px; }
.lg-main { display: flex; flex-direction: column; min-height: 0; }

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
.lg-legend-chip.on { color: var(--sw-accent-2); background: var(--sw-accent-soft); border-color: var(--sw-accent-line); }
.lg-legend-name { text-transform: uppercase; letter-spacing: 0.04em; font-size: 10.5px; }
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
.lg-legend-tools { margin-left: auto; display: inline-flex; align-items: center; gap: 6px; }
.lvl-dot { width: 8px; height: 8px; border-radius: 2px; flex: 0 0 auto; }

.f-select {
  height: 26px;
  padding: 0 6px;
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line-2);
  border-radius: 4px;
  color: var(--sw-fg-0);
  font: inherit;
  font-size: 11px;
}
.f-select:focus { outline: none; border-color: var(--sw-accent-line); }
.f-select:disabled { opacity: 0.5; cursor: not-allowed; }

.lg-density-wrap { padding: 8px 12px 4px; border-bottom: 1px solid var(--sw-line); background: var(--sw-bg-1); }
.lg-density { display: grid; grid-template-columns: repeat(60, 1fr); align-items: end; gap: 1px; height: 60px; position: relative; }
.lg-density-bin { display: flex; flex-direction: column-reverse; height: 100%; background: var(--sw-bg-2); border-radius: 1px; overflow: hidden; }
.lg-density-bin:hover { outline: 1px solid var(--sw-accent-line); }
.lg-density-segment { display: block; }
.lg-density-tip {
  position: absolute;
  bottom: calc(100% + 6px);
  transform: translateX(-50%);
  min-width: 160px;
  padding: 6px 9px;
  background: var(--sw-bg-0);
  border: 1px solid var(--sw-line-2);
  border-radius: 4px;
  box-shadow: 0 8px 20px rgba(0, 0, 0, 0.45);
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
.lg-density-tip-name { color: var(--sw-fg-2); flex: 1; text-transform: uppercase; letter-spacing: 0.04em; }
.lg-density-tip-val { color: var(--sw-fg-0); font-weight: 600; font-variant-numeric: tabular-nums; }
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

.lg-empty { padding: 32px; text-align: center; color: var(--sw-fg-3); font-size: 11.5px; }
.lg-stream { flex: 1; overflow-y: auto; font-size: 11.5px; }
.lg-row {
  display: grid;
  grid-template-columns: 92px 44px 74px 150px 90px 1fr;
  gap: 10px;
  align-items: center;
  padding: 4px 12px;
  border-bottom: 1px solid var(--sw-line);
  cursor: pointer;
}
.lg-row:hover { background: var(--sw-bg-2); }
.lg-row.is-open { background: var(--sw-bg-2); }
.lg-time { font-family: var(--sw-mono); color: var(--sw-fg-1); }
.lg-date { font-size: 10px; }
.lg-lvl { font-size: 9.5px; text-transform: uppercase; letter-spacing: 0.06em; font-weight: 700; }
.lg-svc, .lg-ver { font-size: 10.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
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
.lg-loc {
  flex: 0 0 auto;
  font-size: 9.5px;
  color: var(--sw-fg-3);
  background: var(--sw-bg-3);
  border-radius: 3px;
  padding: 0 5px;
  font-variant-numeric: tabular-nums;
}
.lg-content-body { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.lg-expand { padding: 10px 14px 14px 28px; border-bottom: 1px solid var(--sw-line); background: var(--sw-bg-2); }
.be-meta { display: flex; gap: 14px; flex-wrap: wrap; font-size: 10.5px; color: var(--sw-fg-3); margin-bottom: 8px; }
.be-meta-item { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 60%; }
.be-first { color: var(--sw-warn); }
.be-cols { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.be-col { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
/* Both column heads share a min-height so "Raw stack" lines up with the
   "Resolved" head (which carries the map picker + Resolve button) and the
   two panes below start at the same Y. */
.be-col-head { display: flex; align-items: center; gap: 6px; min-height: 28px; font-size: 11px; font-weight: 600; color: var(--sw-fg-2); }
.be-map-pick { margin-left: auto; max-width: 220px; }
.be-pre {
  margin: 0;
  background: var(--sw-bg-1);
  border: 1px solid var(--sw-line);
  border-radius: 4px;
  padding: 8px;
  font-family: var(--sw-mono);
  font-size: 11px;
  line-height: 1.5;
  color: var(--sw-fg-1);
  overflow-x: auto;
  white-space: pre;
  max-height: 280px;
}
.be-frames { display: flex; flex-direction: column; gap: 8px; }
.be-resolved-by { margin: 0 0 2px; font-size: 11px; color: var(--sw-fg-3); }
.be-frame { display: flex; flex-direction: column; border: 1px solid var(--sw-line); border-radius: 5px; overflow: hidden; background: var(--sw-bg-0); }
.be-frame-line { font-family: var(--sw-mono); font-size: 11px; display: flex; flex-wrap: wrap; gap: 8px; align-items: baseline; padding: 5px 9px; background: var(--sw-bg-1); }
.be-frame-fn { color: var(--sw-fg-0); font-weight: 600; }
.be-frame-orig { color: var(--sw-cyan); }
.be-frame-name { color: var(--sw-info); }
.be-frame-unmapped { color: var(--sw-fg-3); margin-left: auto; font-style: italic; }
/* Source snippet — a small code block with a line-number gutter; the
   mapped line is tinted + its number accented. */
.be-snippet {
  display: flex;
  flex-direction: column;
  margin: 0;
  font-family: var(--sw-mono);
  font-size: 11px;
  line-height: 1.6;
  border-top: 1px solid var(--sw-line);
  overflow-x: auto;
}
.be-snip-line { display: flex; white-space: pre; }
.be-snip-no {
  flex: 0 0 auto;
  width: 30px;
  text-align: right;
  padding: 0 8px;
  color: var(--sw-fg-3);
  background: var(--sw-bg-1);
  border-right: 1px solid var(--sw-line);
  user-select: none;
}
.be-snip-code { padding: 0 10px; color: var(--sw-fg-1); white-space: pre; }
.be-snip-line.is-hit { background: color-mix(in srgb, var(--sw-accent) 13%, transparent); }
.be-snip-line.is-hit .be-snip-no { color: var(--sw-accent-2); background: color-mix(in srgb, var(--sw-accent) 22%, transparent); font-weight: 700; }
.be-snip-line.is-hit .be-snip-code { color: var(--sw-fg-0); }
.be-dim { color: var(--sw-fg-3); font-size: 11px; padding: 4px 0; }

.lg-pager { display: flex; align-items: center; gap: 12px; padding: 8px 14px; border-top: 1px solid var(--sw-line); }
.lg-pager .hint { font-size: 10.5px; color: var(--sw-fg-3); }
.lg-pager-ctrls { margin-left: auto; display: inline-flex; gap: 6px; }
.dim { color: var(--sw-fg-3); }
.mono { font-family: var(--sw-mono); }
.sw-btn {
  height: 26px;
  padding: 0 12px;
  border-radius: 4px;
  font: inherit;
  font-size: 11px;
  font-weight: 500;
  border: 1px solid var(--sw-line-2);
  background: var(--sw-bg-2);
  color: var(--sw-fg-1);
  cursor: pointer;
}
.sw-btn:hover { color: var(--sw-fg-0); border-color: var(--sw-line); }
.sw-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.sw-btn.small { height: 24px; padding: 0 10px; }
.sw-btn.ghost { background: transparent; }
.sw-btn.primary {
  background: var(--sw-accent);
  color: var(--sw-bg-0);
  border: none;
  padding: 0 14px;
  font-weight: 600;
}
.sw-btn.primary:hover { background: var(--sw-accent-2); color: var(--sw-bg-0); }
</style>
