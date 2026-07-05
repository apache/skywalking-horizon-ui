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
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import type { LayerDef, LogRow, LogTagFilter } from '@/api/client';
import { useLayerLanding } from '@/layer/useLayerLanding';
import { useLayerLogs, useLayerLogFacets } from '@/layer/logs/useLayerLogs';
import { useLayerInstances } from '@/layer/useLayerInstances';
import { useLayerEndpoints } from '@/layer/useLayerEndpoints';
import { useLayers } from '@/shell/useLayers';
import { useSelectedService } from '@/layer/useSelectedService';
import { useSelectedInstance } from '@/layer/useSelectedInstance';
import { useSelectedEndpoint } from '@/layer/useSelectedEndpoint';
import { useLayerServiceName } from '@/layer/useLayerServiceName';
import { useSetupStore } from '@/state/setup';
import { useTracePopout, TRACE_POPOUT_QUERY } from '@/layer/traces/useTracePopout';
import { useDensityBins } from '@/layer/_shared/useDensityBins';
import { useLogTimeRange, TIME_RANGE_PRESETS, CUSTOM_RANGE_SENTINEL } from '@/layer/logs/useLogTimeRange';
import { useLogTagConditions } from '@/layer/logs/useLogTagConditions';
import DensityHistogram from '@/layer/_shared/DensityHistogram.vue';
import EndpointCombo from '@/layer/_shared/EndpointCombo.vue';
import LogStreamPanel from '@/render/widgets/LogStreamPanel.vue';
import LogDetailPopout from '@/render/widgets/LogDetailPopout.vue';
import TagInput from '@/components/primitives/TagInput.vue';

const props = defineProps<{
  /** Embedded (AI-chat) mode: seed the focus service from props, bypass the
   *  shared layerSelection store + filter chrome, and auto-run on mount.
   *  Default off → the /layer/:key/logs route is unchanged. */
  embedded?: boolean;
  layerKey?: string;
  focusService?: string;
  focusWindowMinutes?: number;
}>();
const route = useRoute();
const embedded = computed(() => Boolean(props.embedded));
const layerKey = computed(() =>
  props.layerKey && props.layerKey.length > 0 ? props.layerKey : String(route.params.layerKey ?? ''),
);
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
// Embedded takes the focus service from the prop; the route resolves it from
// the shared layerSelection store — overriding here means the chat block never
// touches that global selection.
const serviceNameRaw = useLayerServiceName(layerKey, landing);
const serviceName = computed<string | null>(() =>
  embedded.value ? (props.focusService ?? null) : serviceNameRaw.value,
);
const landingRows = computed(() => landing.data.value?.sampledRows ?? landing.rows.value ?? []);
watch(
  landingRows,
  (rows) => {
    if (embedded.value) return; // never auto-pick into the shared store from the chat
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

// Log scope routes which condition selectors the bar surfaces (booster-ui parity):
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

// How the picked instance is used depends on `logScope`: pinned primary
// selector under `instance` scope, optional narrower otherwise.
const { selectedInstance, setSelectedInstance } = useSelectedInstance();
const { instances: instanceList } = useLayerInstances(layerKey, serviceName);
// Logs (and traces) intentionally do NOT auto-select an instance.
// Default is `All` so the stream starts broad; the operator opts into
// narrowing by picking from the dropdown. Auto-selection is reserved
// for metrics-scope pages (instance / endpoint dashboards), where a
// chosen entity is needed to render the metric widgets at all.
watch(serviceName, (next, prev) => {
  if (embedded.value) return;
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

// Endpoint lists are unbounded, so the picker uses a search-keyword model:
// the typed value drives the OAP `findEndpoint` list via `update:query`.
const { selectedEndpoint, setSelectedEndpoint } = useSelectedEndpoint();
const endpointQuery = ref('');
const endpointLimit = ref(20);
function pickEndpoint(name: string): void {
  setSelectedEndpoint(name);
}
function clearEndpoint(): void {
  setSelectedEndpoint(null);
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
  if (embedded.value) return;
  if (prev !== undefined && next !== prev) {
    if (selectedEndpoint.value) setSelectedEndpoint(null);
    endpointQuery.value = '';
  }
});
const selectedEndpointObj = computed(() =>
  selectedEndpoint.value
    ? endpointList.value.find((e) => e.name === selectedEndpoint.value) ?? null
    : null,
);
const endpointIdForQuery = computed<string | null>(() => selectedEndpointObj.value?.id ?? null);

// Trace ID rides from `?traceId=` in the URL or the operator's input. The URL
// takes precedence so shared / bookmarked URLs restore the same view.
const traceIdParam = computed(() => {
  const v = route.query[TRACE_POPOUT_QUERY];
  return typeof v === 'string' && v.length > 0 ? v : null;
});
const traceIdInput = ref('');
// Free-text content search is intentionally NOT exposed. OAP's
// content-keyword filter is opt-in per storage backend (off on the
// stock H2 store) and indexing across full log bodies has surprising
// latency / cardinality behaviour on busy clusters. The conditions
// the UI exposes — service / instance / endpoint / traceID / tags —
// are all indexed dimensions and cover the booster-ui condition set.
const page = ref(1);
const pageSize = ref(50);
const traceIdRef = computed<string | null>(() => {
  if (traceIdParam.value) return traceIdParam.value;
  const v = traceIdInput.value.trim();
  return v.length > 0 ? v : null;
});
// Embedded (chat) mode advertises a service-wide stream and hides the pickers,
// so it must NOT inherit an instance/endpoint the operator left selected in the
// shared layerSelection store on a real Logs page — force All by short-circuiting.
const instanceIdRef = computed<string | null>(() =>
  embedded.value ? null : instanceIdForQuery.value,
);
const endpointIdRef = computed<string | null>(() =>
  embedded.value ? null : endpointIdForQuery.value,
);
const keywordsRef = computed<string[]>(() => []);

// Time range (presets + Custom…) — owns the OAP-shaped window refs.
const {
  windowMinutes,
  customStart,
  customEnd,
  isCustomRange,
  startMs: startMsRef,
  endMs: endMsRef,
  windowMinutesEffective,
} = useLogTimeRange(30);

// Tag chips + single-select level filter; editing any condition resets
// `page` to 1. `allTags` is what the OAP log query consumes.
const { tagInput, customTags, selectedLevel, allTags, addTagFilter, removeTagFilter, toggleLevel } =
  useLogTagConditions(page);

// The log stream + facet queries read these APPLIED conditions, not the live
// draft refs, so editing instance / endpoint / trace-id / tags / time stages
// the query without firing it. `applyConditions()` commits the current draft;
// it runs on initial service load, on each "Run query", and on a service
// switch. `page`/`pageSize` stay live; there is no periodic refresh.
interface AppliedLogConditions {
  service: string | null;
  instanceId: string | null;
  endpointId: string | null;
  traceId: string | null;
  keywords: string[];
  tags: LogTagFilter[];
  windowMinutes: number;
  startMs: number | null;
  endMs: number | null;
}
function snapshotConditions(): AppliedLogConditions {
  return {
    service: serviceName.value,
    instanceId: instanceIdRef.value,
    endpointId: endpointIdRef.value,
    traceId: traceIdRef.value,
    keywords: keywordsRef.value,
    tags: allTags.value,
    windowMinutes: windowMinutesEffective.value,
    startMs: startMsRef.value,
    endMs: endMsRef.value,
  };
}
const applied = ref<AppliedLogConditions>(snapshotConditions());
// Manual-fire gate: the log + facet queries stay disabled until the
// operator presses Run query (or pages), so a freshly-opened tab shows a
// "Run query" prompt rather than a misleading "no logs" empty state.
const hasQueried = ref(false);
function applyConditions(): void {
  applied.value = snapshotConditions();
}
// A service switch is a context change → clear back to the Run-query
// prompt (cascade-clear: never show the prior service's logs under the
// new one). Filter edits just stage; they wait for Run query.
watch(serviceName, () => {
  if (embedded.value) return; // focus is fixed by prop; onMounted drives the run
  hasQueried.value = false;
  selectedLevel.value = null;
  customTags.value = [];
  page.value = 1;
  applyConditions();
});
const aService = computed(() => applied.value.service);
const aInstanceId = computed(() => applied.value.instanceId);
const aEndpointId = computed(() => applied.value.endpointId);
const aTraceId = computed(() => applied.value.traceId);
const aKeywords = computed(() => applied.value.keywords);
const aTags = computed(() => applied.value.tags);
const aWindowMinutes = computed(() => applied.value.windowMinutes);
const aStartMs = computed(() => applied.value.startMs);
const aEndMs = computed(() => applied.value.endMs);

const { logs, total, isFetching, error, refetch } = useLayerLogs(layerKey, {
  service: aService,
  instanceId: aInstanceId,
  endpointId: aEndpointId,
  traceId: aTraceId,
  keywords: aKeywords,
  tags: aTags,
  page,
  pageSize,
  windowMinutes: aWindowMinutes,
  startMs: aStartMs,
  endMs: aEndMs,
  enabled: hasQueried,
});

const { facets, refetch: refetchFacets } = useLayerLogFacets(layerKey, {
  service: aService,
  instanceId: aInstanceId,
  endpointId: aEndpointId,
  traceId: aTraceId,
  keywords: aKeywords,
  windowMinutes: aWindowMinutes,
  startMs: aStartMs,
  endMs: aEndMs,
  enabled: hasQueried,
});

// Run query refetches BOTH the log stream and the facet sample (level
// counts) so they never diverge — facets carry a 30s staleTime, so an
// unchanged-condition Run query needs an explicit refetch.
function runQuery(): void {
  page.value = 1;
  hasQueried.value = true;
  applyConditions();
  void refetch();
  void refetchFacets();
}

// Embedded (chat) auto-run: seed the look-back and fire on mount so the block
// renders self-contained (instance/endpoint stay All — a service-wide stream).
onMounted(() => {
  if (!embedded.value) return;
  if (props.focusWindowMinutes) windowMinutes.value = props.focusWindowMinutes;
  runQuery();
});

// Density histogram counts come from the loaded page only — total-window
// density would need a server aggregation we don't have yet.
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

const histogram = useDensityBins<LogRow, Level>(logs, {
  keys: LEVEL_ORDER,
  timeOf: (r) => r.timestamp,
  keyOf: levelOf,
});

// Server-side level facets; until the facet fetch returns, fall back to
// counts from the visible page so the rail never goes empty.
const levelFacet = computed<Record<Level, number>>(() => {
  if (facets.value?.level) return facets.value.level;
  const counts: Record<Level, number> = { error: 0, warn: 0, info: 0, debug: 0, other: 0 };
  for (const r of logs.value) counts[levelOf(r)] += 1;
  return counts;
});
// No service facet: the log query is already service-scoped, so a
// "top services" rail would just repeat the title.

// The level filter goes to OAP, so the visible logs already reflect it.
const filteredLogs = computed<LogRow[]>(() => logs.value);

const popoutRow = ref<LogRow | null>(null);
function onRowClick(r: LogRow): void {
  popoutRow.value = r;
}

/** Drill from a log entry into its trace via the global trace popout. The
 *  row's timestamp is passed so BanyanDB's `queryTrace` looks in the right
 *  window — without it OAP only searches the last 1 day and older
 *  (cold-tier) traces silently fail to load.
 *
 *  UX: one overlay at a time. Rather than stacking the trace popout on top
 *  of the log popout, or just dropping the log popout (jarring), we
 *  remember the entry, hide it, and reopen it when the trace popout closes
 *  (Escape / × / back) — a drill-in / back flow. A bare row → trace jump
 *  (no log popout open) leaves nothing to return to. */
const logReturnRow = ref<LogRow | null>(null);
watch([layerKey, serviceName], () => { logReturnRow.value = null; });
function jumpToTrace(traceId: string, ts?: number): void {
  if (popoutRow.value) {
    logReturnRow.value = popoutRow.value;
    popoutRow.value = null;
  }
  openTrace(traceId, ts);
}
watch(
  () => route.query[TRACE_POPOUT_QUERY],
  (id, prev) => {
    // Trace popout just closed → return to the log entry we drilled in from.
    if (prev && !id && logReturnRow.value) {
      popoutRow.value = logReturnRow.value;
      logReturnRow.value = null;
    }
  },
);
</script>

<template>
  <div class="lg-tab" :class="{ 'is-embedded': embedded }">
    <!-- Toolbar mirrors the trace tab: head row (kicker + Run query)
         on top, conditions grid below, active tag chips at the foot.
         Hidden in embedded (chat) mode — the focus is fixed by the prompt. -->
    <header v-if="!embedded" class="lg-toolbar sw-card">
      <div class="lg-toolbar-head">
        <span class="kicker">Logs</span>
        <span v-if="traceIdRef" class="trace-pin">trace <code>{{ traceIdRef.slice(0, 12) }}…</code></span>
        <span v-if="isFetching" class="hint">refreshing…</span>
        <button class="sw-btn primary lg-run-btn" type="button" @click="runQuery">Run query</button>
      </div>
      <div class="lg-conditions">
        <label class="cf">
          <span>{{ logScope === 'instance' ? 'Sidecar' : 'Instance' }}</span>
          <select
            class="cf-input"
            name="log-instance"
            :value="selectedInstance ?? ''"
            @change="setSelectedInstance(($event.target as HTMLSelectElement).value || null)"
          >
            <option value="">All</option>
            <option v-for="i in instanceList" :key="i.id" :value="i.name">{{ i.name }}</option>
          </select>
        </label>
        <div class="cf cf-wide">
          <span>Endpoint</span>
          <EndpointCombo
            :endpoints="endpointList"
            :selected="selectedEndpoint"
            :show-all="showEndpointSelector"
            :loading="endpointsLoading"
            @update:query="endpointQuery = $event"
            @pick="pickEndpoint"
            @clear="clearEndpoint"
          />
        </div>
        <label class="cf cf-wide">
          <span>Trace ID</span>
          <input
            v-model="traceIdInput"
            type="text"
            name="log-trace-id"
            autocomplete="off"
            class="cf-input mono"
            placeholder="paste trace id…"
          />
        </label>
        <label class="cf cf-wide">
          <span>Tags</span>
          <TagInput
            v-model="tagInput"
            kind="log"
            placeholder="key=value, then Enter"
            @commit="addTagFilter"
          />
        </label>
        <label class="cf" :class="{ 'cf-wide': isCustomRange }">
          <span>Time range</span>
          <template v-if="isCustomRange">
            <div class="cf-range">
              <input v-model="customStart" type="datetime-local" name="log-start" class="cf-input cf-range-num" />
              <span class="cf-range-sep">–</span>
              <input v-model="customEnd" type="datetime-local" name="log-end" class="cf-input cf-range-num" />
              <button class="sw-btn small ghost" type="button" title="Back to presets" @click="windowMinutes = 30">×</button>
            </div>
          </template>
          <select v-else v-model.number="windowMinutes" name="log-window" class="cf-input">
            <option v-for="p in TIME_RANGE_PRESETS" :key="p.minutes" :value="p.minutes">{{ p.label }}</option>
            <option :value="CUSTOM_RANGE_SENTINEL">Custom…</option>
          </select>
        </label>
        <label class="cf">
          <span>Page size</span>
          <select v-model.number="pageSize" name="log-page-size" class="cf-input">
            <option :value="20">20</option>
            <option :value="30">30</option>
            <option :value="50">50</option>
            <option :value="100">100</option>
          </select>
        </label>
      </div>
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

    <section class="lg-body sw-card">
      <div class="lg-main">
        <div v-if="!hasQueried" class="lg-empty">
          Pick your conditions, then click Run query.
        </div>
        <template v-else>
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

        <DensityHistogram :data="histogram" :keys="LEVEL_ORDER" :colors="LEVEL_COLOR" />

        <div v-if="filteredLogs.length === 0" class="lg-empty">
          {{ logs.length === 0 ? 'No logs returned for this scope.' : 'No logs match the active filters.' }}
        </div>
        <LogStreamPanel
          v-else
          :rows="filteredLogs"
          @select="onRowClick($event.row)"
          @jump-trace="jumpToTrace($event.traceId, $event.ts)"
        />
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
        </template>
      </div>
    </section>

    <LogDetailPopout
      :row="popoutRow"
      @close="popoutRow = null"
      @jump-trace="jumpToTrace($event.traceId, $event.ts)"
    />
  </div>
</template>

<style scoped>
.lg-tab { display: flex; flex-direction: column; gap: 12px; padding: 4px 0 0; }
/* Embedded (chat) — fill the bounded host box instead of the viewport. */
.lg-tab.is-embedded { height: 100%; gap: 8px; padding: 0; min-height: 0; }
.lg-tab.is-embedded .lg-body { flex: 1 1 auto; min-height: 0; overflow-y: auto; }
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
.lg-toolbar { padding: 10px 12px; display: flex; flex-direction: column; gap: 10px; overflow: visible; }
.lg-toolbar-head { display: flex; align-items: center; gap: 10px; width: 100%; }
/* `.sw-btn.primary` is locally scoped per page (each view declares its own);
   the rule is copied to keep the visual stable without a shared global. */
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

.lg-empty {
  padding: 32px;
  text-align: center;
  color: var(--sw-fg-3);
  font-size: 11.5px;
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

</style>
