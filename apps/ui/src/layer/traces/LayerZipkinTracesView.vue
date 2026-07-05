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
import type { NativeTraceListRow, ZipkinTraceListRow } from '@skywalking-horizon-ui/api-client';

const { t } = useI18n({ useScope: 'global' });
import { useLayerZipkinTraces, useZipkinTrace } from '@/layer/traces/useZipkinTraces';
import { useZipkinTracePopout } from '@/layer/traces/useZipkinTracePopout';
import { useZipkinAutocomplete } from '@/layer/traces/useZipkinAutocomplete';
import { zipkinRowToNative } from '@/layer/traces/zipkinTraceRows';
import TypeaheadSelect from '@/components/primitives/TypeaheadSelect.vue';
import ZipkinTraceDetailCard from '@/render/widgets/ZipkinTraceDetailCard.vue';
import TraceDistribution from '@/render/widgets/TraceDistribution.vue';
import TraceListPanel from '@/render/widgets/TraceListPanel.vue';

// Zipkin trace data is keyed by its own service universe (the names
// reported in span `localEndpoint.serviceName`), not by SkyWalking's
// per-page service picker. This view deliberately does NOT read the
// URL-backed selected service or the layer's landing rows — those
// belong to the SkyWalking metric stack. Service filtering happens
// entirely through the operator's input + the Zipkin `/api/v2/services`
// autocomplete list.
// The AI chat mounts this view embedded (read-only), seeded with a ZIPKIN service
// name (span localEndpoint.serviceName — NOT a SkyWalking service name) + window,
// and auto-runs the query. Additive + default-off: the interactive route passes
// none and is byte-behaviour-identical. This view already owns its own time range
// and writes no shared store, so embedded needs no ticker/store guard — just seed
// + auto-run + hide the toolbar chrome.
const props = defineProps<{
  embedded?: boolean;
  layerKey?: string;
  /** MUST be a Zipkin service name (localEndpoint.serviceName), matched by the
   *  assistant from list_zipkin_services — it differs from the SkyWalking name. */
  focusService?: string;
  focusWindowMinutes?: number;
}>();
const embedded = computed(() => Boolean(props.embedded));

const route = useRoute();
const layerKey = computed(() =>
  props.layerKey && props.layerKey.length > 0 ? props.layerKey : String(route.params.layerKey ?? ''),
);

// Sentinel duration meaning "use the custom start/end instead of a preset
// window." Picked as -1 so it can't collide with any real ms value.
const CUSTOM_RANGE = -1;
const lookbackMs = ref<number>(30 * 60_000);
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
  // Empty service filter = "All services" in Zipkin's API: pass null and
  // OAP returns the full set.
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

// No auto-fire (traces are expensive); a layer switch resets to the prompt.
watch(layerKey, () => {
  hasQueried.value = false;
  selectedTraceId.value = null;
  pickedTraceIds.value = new Set();
});

const {
  serviceOptions: zipkinServiceOptions,
  spanNameOptions,
  remoteSvcOptions,
  annotationDatalistOptions,
  onAnnotationInput,
} = useZipkinAutocomplete({
  layerKey,
  serviceFilter: zipkinServiceFilter,
  annotationQuery,
  spanName,
  remoteServiceName,
  // Embedded (chat) hides the whole toolbar, so skip the autocomplete fetches
  // that only feed its dropdowns.
  enabled: !embedded.value,
});

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

// A row click commits a selection to local state (inline detail in the side
// rail). The trace-id input + URL `?traceId=` still fall back to the global
// popout for the "paste an id" / "share a link" flows.
const selectedTraceId = ref<string | null>(null);
function selectNative(row: NativeTraceListRow): void {
  selectedTraceId.value = row.key;
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
onBeforeUnmount(() => window.removeEventListener('keydown', onPageKeyDown, true));

// Embedded (chat): seed the focus Zipkin service + window and auto-run once —
// the same "commit refs + refetch on mount" contract the native trace view uses.
onMounted(() => {
  if (!embedded.value) return;
  if (props.focusService) zipkinServiceFilter.value = props.focusService;
  if (props.focusWindowMinutes && props.focusWindowMinutes > 0) {
    lookbackMs.value = props.focusWindowMinutes * 60_000;
  }
  runQuery();
});

// Adapt each Zipkin row onto `NativeTraceListRow` (µs → ms, traceId stays the
// row key) so the shared native-trace widgets can render them.
const nativeRows = computed<NativeTraceListRow[]>(() =>
  [...shownTraces.value]
    .sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0))
    .map(zipkinRowToNative),
);
const maxTraceDuration = computed<number>(() => {
  let m = 0;
  for (const r of nativeRows.value) if (r.duration > m) m = r.duration;
  return m;
});
function openByInput(): void {
  const v = traceIdInput.value.trim();
  if (v) openTrace(v);
}

// Picking dots / brushing a box narrows the list to the picked set; no extra
// query fires.
const pickedTraceIds = ref<Set<string>>(new Set());
const pickedKeys = computed(() => [...pickedTraceIds.value]);
const isPicking = computed(() => pickedTraceIds.value.size > 0);
function resetPick(): void {
  pickedTraceIds.value = new Set();
}
function onScatterSelect(row: NativeTraceListRow): void {
  const s = new Set(pickedTraceIds.value);
  if (s.has(row.key)) s.delete(row.key);
  else s.add(row.key);
  pickedTraceIds.value = s;
}
function onScatterBrush(keys: string[]): void {
  const next = new Set(pickedTraceIds.value);
  for (const k of keys) next.add(k);
  pickedTraceIds.value = next;
}
watch(traces, () => { pickedTraceIds.value = new Set(); });

const visibleRows = computed<NativeTraceListRow[]>(() => {
  if (pickedTraceIds.value.size === 0) return nativeRows.value;
  return nativeRows.value.filter((r) => pickedTraceIds.value.has(r.key));
});
</script>

<template>
  <div class="ztr-tab" :class="{ 'is-embedded': embedded }">
    <div v-if="!embedded" class="ztr-top-strip">
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
        <label class="cf row-break">
          <span>{{ t('Time range') }}</span>
          <select v-model.number="lookbackMs" class="cf-input">
            <option v-for="p in TIME_PRESETS" :key="p.ms" :value="p.ms">{{ p.label }}</option>
          </select>
        </label>
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
        <TraceDistribution
          :rows="nativeRows"
          :max-duration="maxTraceDuration"
          :selected-key="null"
          :highlight-keys="pickedKeys"
          @select="onScatterSelect"
          @brush="onScatterBrush"
        />
      </section>
    </div>

    <section v-if="!selectedTraceId" class="ztr-split">
      <article class="ztr-list sw-card">
        <header class="ztr-list-head">
          <span class="kicker">{{ t('Results') }}</span>
          <span class="hint">{{ t('{n} traces', { n: visibleRows.length }) }}</span>
        </header>
        <div v-if="error" class="banner err">
          <strong>{{ t('Zipkin query failed.') }}</strong> {{ String(error) }}
        </div>
        <div v-else-if="!hasQueried" class="ztr-empty">
          {{ t('Click Run query to fetch Zipkin traces for this service.') }}
        </div>
        <div v-else-if="visibleRows.length === 0 && !isFetching" class="ztr-empty">
          {{ t('No Zipkin traces in the selected window. Widen the time range or relax conditions.') }}
        </div>
        <TraceListPanel
          v-else
          :rows="visibleRows"
          :selected-key="selectedTraceId"
          :max-duration="maxTraceDuration"
          @select="selectNative"
        />
      </article>
    </section>

    <section v-else class="ztr-detail-split" :class="{ 'rail-collapsed': !railOpen }">
      <TraceListPanel
        foldable
        :rail-open="railOpen"
        :rows="visibleRows"
        :selected-key="selectedTraceId"
        :max-duration="maxTraceDuration"
        :title="t('Traces')"
        :count-hint="visibleRows.length"
        @select="selectNative"
        @toggle-rail="railOpen = !railOpen"
      />

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
/* Embedded (chat): bound to the host stage and scroll INSIDE. The results state
   wraps the list in a `.ztr-split` GRID and the detail state is `.ztr-detail-split`
   — both are the direct flex child of `.ztr-tab`, so BOTH need the height cap
   (min-height:0 + minmax(0,1fr) row); then the list card / detail columns scroll
   their own overflow instead of clipping at the stage. */
.ztr-tab.is-embedded { height: 100%; gap: 8px; padding: 0; min-height: 0; overflow: hidden; }
.ztr-tab.is-embedded .ztr-split {
  flex: 1 1 auto;
  min-height: 0;
  grid-template-rows: minmax(0, 1fr);
}
.ztr-tab.is-embedded .ztr-list { min-height: 0; overflow-y: auto; }
.ztr-tab.is-embedded .ztr-detail-split {
  flex: 1 1 auto;
  min-height: 0;
  align-items: stretch;
  grid-template-rows: minmax(0, 1fr);
}
.ztr-tab.is-embedded .ztr-detail-split > * { min-height: 0; overflow-y: auto; }
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
.ztr-split {
  display: grid;
  grid-template-columns: 1fr;
  gap: 12px;
}
.dim { color: var(--sw-fg-3); }

@media (max-width: 1100px) {
  .ztr-detail-split { grid-template-columns: 1fr !important; }
}

.ztr-detail-split {
  display: grid;
  grid-template-columns: 320px 1fr;
  gap: 12px;
  /* `stretch` (not `start`) so the rail + detail cards share the row
     height; otherwise the detail card collapses to its content height
     while a long rail extends past it, visibly mismatched. */
  align-items: stretch;
}
.ztr-detail-split.rail-collapsed { grid-template-columns: 64px 1fr; }

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
