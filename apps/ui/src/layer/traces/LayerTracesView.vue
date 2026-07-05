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
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute } from 'vue-router';

const { t } = useI18n({ useScope: 'global' });
import type {
  LayerDef,
  NativeSpan,
  NativeTraceListRow,
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
import TraceListPanel from '@/render/widgets/TraceListPanel.vue';
import TagInput from '@/components/primitives/TagInput.vue';
import TraceDetailCard from '@/render/widgets/TraceDetailCard.vue';
import TraceDistribution from '@/render/widgets/TraceDistribution.vue';

const props = defineProps<{
  /** Embedded (AI-chat) mode: seed the focus from props, bypass the shared
   *  layerSelection store + the filter chrome, and auto-run on mount. Default
   *  off → the /layer/:key/trace route is unchanged. */
  embedded?: boolean;
  layerKey?: string;
  focusService?: string;
  focusEndpointId?: string;
  focusInstanceId?: string;
  focusWindowMinutes?: number;
}>();
const route = useRoute();
const embedded = computed(() => Boolean(props.embedded));
const layerKey = computed(() =>
  props.layerKey && props.layerKey.length > 0 ? props.layerKey : String(route.params.layerKey ?? ''),
);

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
// Embedded mode takes the focus service straight from the prop; the route uses
// the shared layerSelection store (resolved to a name). Overriding here means
// the chat block never touches that global selection.
const serviceNameRaw = useLayerServiceName(layerKey, landing);
const serviceName = computed<string | null>(() =>
  embedded.value ? (props.focusService ?? null) : serviceNameRaw.value,
);
const landingRows = computed(() => landing.data.value?.sampledRows ?? landing.rows.value ?? []);
watch(
  landingRows,
  (rows) => {
    if (embedded.value) return; // never auto-pick into the shared store from the chat
    if (selectedId.value) return;
    const first = rows[0];
    if (first) setSelectedService(first.serviceId);
  },
  { immediate: true },
);

// Two layers: live form refs (bound to the inputs) and *committed* refs that
// drive the query. The query only fires on "Run query" — trace queries can be
// slow over slow links, so we don't auto-refetch on every keystroke / select.
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
  if (embedded.value) return; // focus (incl. seeded endpoint/instance) is fixed by props
  instanceId.value = null;
  endpointId.value = null;
});

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

// Metric→trace drill deep-link: filter pre-seeded via route query
// (?dMode/dValue/dFrom/dTo/dInstance/dEndpoint/dNonce); names resolve to ids here.
const pendingDrillInstance = ref<string | null>(null);
const pendingDrillEndpoint = ref<string | null>(null);
const drillArmed = ref<boolean>(false);
function resolveDrillEntities(): boolean {
  let changed = false;
  if (pendingDrillInstance.value) {
    const hit = instances.value.find((i) => i.name === pendingDrillInstance.value);
    if (hit) { instanceId.value = hit.id; pendingDrillInstance.value = null; changed = true; }
  }
  if (pendingDrillEndpoint.value) {
    const hit = endpoints.value.find((e) => e.name === pendingDrillEndpoint.value);
    if (hit) { endpointId.value = hit.id; pendingDrillEndpoint.value = null; changed = true; }
  }
  return changed;
}
function maybeRunDrill(): void {
  // Wait for service + any pending entity id, else the first query runs unfiltered.
  if (!drillArmed.value || !serviceName.value) return;
  if (pendingDrillInstance.value || pendingDrillEndpoint.value) return;
  drillArmed.value = false;
  runQuery();
}
function applyDrillFromRoute(): void {
  const q = route.query;
  const mode = typeof q.dMode === 'string' ? q.dMode : null;
  if (mode !== 'latency' && mode !== 'error') return;
  traceState.value = mode === 'error' ? 'ERROR' : 'ALL';
  queryOrder.value = mode === 'latency' ? 'BY_DURATION' : 'BY_START_TIME';
  minDuration.value =
    mode === 'latency' && typeof q.dValue === 'string' && Number.isFinite(Number(q.dValue))
      ? Math.max(0, Math.round(Number(q.dValue)))
      : null;
  maxDuration.value = null;
  if (typeof q.dFrom === 'string' && typeof q.dTo === 'string' && q.dFrom && q.dTo) {
    windowMinutes.value = CUSTOM_RANGE_SENTINEL;
    customStart.value = q.dFrom;
    customEnd.value = q.dTo;
  }
  pendingDrillInstance.value = typeof q.dInstance === 'string' ? q.dInstance : null;
  pendingDrillEndpoint.value = typeof q.dEndpoint === 'string' ? q.dEndpoint : null;
  // Seed the endpoint keyword so a >50-endpoint service still fetches this one.
  if (pendingDrillEndpoint.value) endpointQuery.value = pendingDrillEndpoint.value;
  resolveDrillEntities();
  drillArmed.value = true;
  maybeRunDrill();
}
watch(serviceName, maybeRunDrill);
watch([instances, endpoints], () => {
  if (!drillArmed.value) return;
  resolveDrillEntities();
  maybeRunDrill();
});
watch(() => route.query.dNonce, applyDrillFromRoute, { immediate: true });

// Embedded (chat) auto-run: seed the committed filters from props and fire the
// query on mount, so the block renders self-contained without a Run-query click.
onMounted(() => {
  if (!embedded.value) return;
  if (props.focusInstanceId) instanceId.value = props.focusInstanceId;
  if (props.focusEndpointId) endpointId.value = props.focusEndpointId;
  if (props.focusWindowMinutes) windowMinutes.value = props.focusWindowMinutes;
  runQuery();
});

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

const traceIdRef = computed(() => selectedTraceId.value);
const { nativeDetail, isFetching: detailFetching } = useTraceDetail(traceIdRef, sourceRef);
// Spans fed to the shared detail card: list-embedded (`queryTraces`)
// when present, else the on-demand `queryTrace` fetch.
const detailSpans = computed<NativeSpan[]>(() => embeddedSpans.value ?? nativeDetail.value?.spans ?? []);

const maxTraceDuration = computed(() => {
  const arr = visibleTraces.value;
  if (arr.length === 0) return 0;
  return Math.max(...arr.map((tr) => tr.duration));
});

// Picking dots / brushing a rectangle filters the list to the picked traces;
// no extra query fires.
const pickedTraceIds = ref<Set<string>>(new Set());
const pickedKeys = computed(() => [...pickedTraceIds.value]);
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
// Picking dots filters the list; the inline detail still opens via a list row.
function onScatterSelect(row: NativeTraceListRow): void {
  togglePick(row.key);
}
function onScatterBrush(keys: string[]): void {
  const next = new Set(pickedTraceIds.value);
  for (const k of keys) next.add(k);
  pickedTraceIds.value = next;
}

const visibleTraces = computed(() => {
  const all = native.value?.traces ?? [];
  if (pickedTraceIds.value.size === 0) return all;
  return all.filter((t) => pickedTraceIds.value.has(t.key));
});

// The span-detail modal lives inside TraceDetailCard and reports open/close via
// `update:modalOpen`; the page owns the single Esc cascade so the two dismissal
// steps stay ordered without competing capture-phase listeners.
const detailCard = ref<InstanceType<typeof TraceDetailCard> | null>(null);
const spanModalOpen = ref<boolean>(false);

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
  // Let an open tag-autocomplete dropdown consume Escape (close itself)
  // rather than tearing down the trace detail behind it.
  if (document.querySelector('.tgi__panel')) return;
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
onBeforeUnmount(() => window.removeEventListener('keydown', onPageKeyDown, true));
</script>

<template>
  <div class="tr-tab" :class="{ 'is-embedded': embedded }">
    <div v-if="!embedded" class="tr-top-strip">
      <header class="tr-toolbar sw-card">
        <div class="tr-toolbar-head">
          <!-- No service name in the head row: the layer header's Switch
               button already shows the bound service, so repeating it is
               duplicate chrome. -->
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
            <TagInput
              v-model="tagsInput"
              kind="trace"
              :window-minutes="windowMinutes"
              :placeholder="t('key=value, then Enter')"
              @commit="addTag"
            />
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

      <section class="tr-scatter sw-card">
        <header class="tr-scatter-head">
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
        <TraceDistribution
          :rows="native?.traces ?? []"
          :max-duration="maxTraceDuration"
          :selected-key="null"
          :highlight-keys="pickedKeys"
          @select="onScatterSelect"
          @brush="onScatterBrush"
        />
      </section>
    </div>

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
        <TraceListPanel
          v-else
          :rows="visibleTraces"
          :selected-key="selectedRowKey"
          :max-duration="maxTraceDuration"
          @select="selectNative"
        />
      </article>

    </template>

    <section v-else class="tr-detail-split" :class="{ 'rail-collapsed': !railOpen }">
      <TraceListPanel
        foldable
        :rail-open="railOpen"
        :rows="visibleTraces"
        :selected-key="selectedRowKey"
        :max-duration="maxTraceDuration"
        :title="isSegmentList ? t('Segments') : t('Traces')"
        :count-hint="native ? native.traces.length : null"
        @select="selectNative"
        @toggle-rail="railOpen = !railOpen"
      />
      <TraceDetailCard
        ref="detailCard"
        :spans="detailSpans"
        :trace-id="selectedTraceId"
        :trace-ids="selectedTraceIds"
        :loading="detailFetching"
        @close="closeDetail"
        @change-trace-id="changeSelectedTraceId"
        @update:modal-open="spanModalOpen = $event"
      />
    </section>
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
.pick-kicker {
  color: var(--sw-accent-2);
  font-weight: 700;
}
.reset-btn { margin-left: 6px; }
/* Chart internals live in TraceDistribution.vue; this card only styles
   the head strip and lets the shared component fill the remaining height. */
.tr-scatter :deep(.scatter-wrap) { flex: 1; min-height: 0; }

.tr-list-card { padding: 0; display: flex; flex-direction: column; min-height: 0; max-height: calc(100vh - 80px); overflow: hidden; }
/* Embedded (chat) — fill the bounded host box instead of the viewport, and let
   the list + the detail waterfall each SCROLL inside it (a long trace can far
   exceed the fixed block height). */
.tr-tab.is-embedded { height: 100%; gap: 8px; padding: 0; min-height: 0; overflow: hidden; }
.tr-tab.is-embedded .tr-list-card { max-height: none; flex: 1 1 auto; min-height: 0; overflow-y: auto; }
/* Bound the split to the leftover height and STRETCH its cells (the base grid
   is `align-items: start` with auto rows, so the detail card would otherwise
   grow to the full waterfall height and clip). minmax(0,1fr) caps the single
   row; each column then scrolls its own overflow. */
.tr-tab.is-embedded .tr-detail-split {
  flex: 1 1 auto;
  min-height: 0;
  align-items: stretch;
  grid-template-rows: minmax(0, 1fr);
}
.tr-tab.is-embedded .tr-detail-split > * { min-height: 0; overflow-y: auto; }
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
.tr-detail-split {
  display: grid;
  grid-template-columns: 320px 1fr;
  gap: 12px;
  align-items: start;
}
.tr-detail-split.rail-collapsed { grid-template-columns: 64px 1fr; }
</style>
