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
  Per-layer Evaluation records tab: the LLM-as-Judge results OAP stored for
  the picked provider, in the Logs tab's dense-stream shape.
   - Condition bar: provider + model, value type / score bounds, task, caller
     service, judge model, sort, trace id, time range.
   - Time-bucketed density histogram (60 bins) stacked by evaluation level.
   - Dense stream: one row per record; a row opens the detail popout, and the
     trace link opens the native or OTLP trace it was judged from.
-->
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useQuery } from '@tanstack/vue-query';
import { useI18n } from 'vue-i18n';
import { bffClient } from '@/api/client';
import {
  type GenAIEvaluationRecordStreamRow,
  useLayerEvaluationRecord,
  useLayerEvaluationRecordFacets,
} from '@/layer/evaluation-record/useLayerEvaluationRecord';
import { useLayerInstances } from '@/layer/useLayerInstances';
import { useSelectedService } from '@/layer/useSelectedService';
import { useSelectedInstance } from '@/layer/useSelectedInstance';
import { useResultTracePopout } from '@/layer/traces/useResultTracePopout';
import { serviceRef, type ServiceRef } from '@/utils/serviceRef';
import { useAutoRefreshSubscribe } from '@/controls/useAutoRefreshSubscribe';
import { useAuthStore } from '@/state/auth';
import EvaluationRecordStreamPanel from '@/render/widgets/EvaluationRecordStreamPanel.vue';
import EvaluationRecordDetailPopout from '@/render/widgets/EvaluationRecordDetailPopout.vue';
import RelatedTraceSpanPicker, { type RelatedSpanPick } from '@/layer/evaluation-record/RelatedTraceSpanPicker.vue';
import TypeaheadSelect from '@/components/primitives/TypeaheadSelect.vue';

const route = useRoute();
const router = useRouter();
const { t } = useI18n();
const auth = useAuthStore();
const layerKey = computed(() => String(route.params.layerKey ?? ''));
const { openResultTrace } = useResultTracePopout();

function queryString(name: string): string | null {
  const value = route.query[name];
  return typeof value === 'string' && value.length > 0 ? value : null;
}
const providerIdParam = computed(() => queryString('providerId'));
const modelIdParam = computed(() => queryString('modelId'));
function queryEpochMs(name: string): number | null {
  const value = queryString(name);
  if (!value) return null;
  const epochMs = Number(value);
  return Number.isFinite(epochMs) ? epochMs : null;
}
const startTimeParam = computed(() => queryEpochMs('startTime'));
const endTimeParam = computed(() => queryEpochMs('endTime'));

const { selectedId, setSelected: setSelectedService } = useSelectedService();
const callerServicesQuery = useQuery({
  queryKey: ['evaluation-record-caller-services'],
  queryFn: () => bffClient.evaluationRecord.callerServices(),
  staleTime: 60_000,
});
const callerServices = computed(() => callerServicesQuery.data.value?.services ?? []);
const callerServicesLoading = computed(() => callerServicesQuery.isLoading.value);
// The catalog is the upstream control of everything here: a failure to read
// it is reported where the prompt would otherwise ask for a provider that
// cannot be picked.
const catalogFailure = computed<string | null>(() => {
  if (callerServicesQuery.error.value) return String(callerServicesQuery.error.value);
  const answer = callerServicesQuery.data.value;
  return answer && answer.reachable === false ? (answer.error || t('Backend unreachable.')) : null;
});
// The catalog spans every layer because the caller filter needs the
// applications that call a provider; the providers are its rows on THIS
// layer. The page owns the provider picker (route meta `ownsServiceSelector`)
// and draws it from this `logs:read` catalog: the shell's picker reads the
// metrics roster, which a logs-only role cannot.
const providers = computed(() => {
  const key = layerKey.value.toUpperCase();
  return callerServices.value.filter((candidate) => candidate.layer.toUpperCase() === key);
});
const selectedService = computed(() => callerServices.value.find((candidate) => candidate.id === selectedId.value) ?? null);
const service = computed<ServiceRef | null>(() => {
  const candidate = selectedService.value;
  return candidate ? serviceRef(candidate.id, candidate.name, candidate.normal) : null;
});
watch(providers, (rows) => {
  if (!selectedId.value && rows.length > 0) setSelectedService(rows[0].id);
}, { immediate: true });
watch(providerIdParam, (providerId) => {
  if (providerId && selectedId.value !== providerId) setSelectedService(providerId);
}, { immediate: true });
// A bookmarked provider that has gone quiet stays selectable, as a model does.
const providerOptions = computed(() => {
  const id = selectedId.value;
  return id && !providers.value.some((p) => p.id === id)
    ? [{ id, name: id }, ...providers.value]
    : providers.value;
});
function changeProvider(providerId: string): void {
  if (providerId) setSelectedService(providerId);
}
const providerTypeaheadOptions = computed(() => providerOptions.value.map((p) => ({ value: p.id, label: p.name })));
// Callers span every layer, so the layer rides along as the row's hint. A
// caller that reports through the Zipkin receiver alone registers no layer
// service, so the catalog never lists it; the records do carry its id and
// name, and the facet sample brings those in once a query has run.
// Remembered across samples: a caller seen once stays pickable, and the one
// picked stays visible, even after a query whose sample has no row of it —
// otherwise the picker read "Select…" while `serviceId` still filtered.
const seenCallers = ref(new Map<string, string>());
const callerTypeaheadOptions = computed(() => {
  const catalog = callerServices.value.map((s) => ({ value: s.id, label: s.name, hint: s.layer }));
  const known = new Set(catalog.map((o) => o.value));
  const seen = [...seenCallers.value.entries()]
    .filter(([id]) => !known.has(id))
    .map(([id, name]) => ({ value: id, label: name, hint: t('seen in records') }));
  const picked = serviceId.value;
  const orphan = picked && !known.has(picked) && !seenCallers.value.has(picked)
    ? [{ value: picked, label: picked }]
    : [];
  return [{ value: '', label: t('All services') }, ...catalog, ...seen, ...orphan];
});
// — Model picker. Evaluation records currently reuse the instance
// selector plumbing, but the UI labels it by the GenAI domain concept.
const { selectedInstance, setSelectedInstance } = useSelectedInstance();
const { instances: instanceList } = useLayerInstances(layerKey, service);
// Keep the query identity independently of the recent instance roster: an
// inactive historical model may never appear in that roster.
const selectedModelId = ref<string | null>(modelIdParam.value);
let modelSelectionExplicit = modelIdParam.value != null;
watch(modelIdParam, (modelId) => {
  selectedModelId.value = modelId;
  modelSelectionExplicit = true;
});
watch(instanceList, (instances) => {
  if (!modelSelectionExplicit && !selectedModelId.value && selectedInstance.value) {
    selectedModelId.value = instances.find((i) => i.name === selectedInstance.value)?.id ?? null;
  }
}, { immediate: true });
watch(selectedId, (next, prev) => {
  if (!prev || next === prev) return;
  if (next === providerIdParam.value && modelIdParam.value) {
    selectedModelId.value = modelIdParam.value;
    modelSelectionExplicit = true;
    setSelectedInstance(null);
  } else {
    changeModel(null);
  }
  // A provider switch is a context change: back to the Run-query prompt, never
  // the previous provider's records under the new name.
  hasQueried.value = false;
  selectedLevel.value = null;
  page.value = 1;
  applyConditions();
});
function changeModel(modelId: string | null): void {
  modelSelectionExplicit = true;
  selectedModelId.value = modelId;
  setSelectedInstance(instanceList.value.find((i) => i.id === modelId)?.name ?? null);
  // Both ids, always: a model belongs to the provider it was picked under, and
  // a reload or a shared link applies the pair. Writing the model alone left
  // the previous provider in the address.
  const query = { ...route.query };
  if (selectedId.value) query.providerId = selectedId.value;
  else delete query.providerId;
  if (modelId) query.modelId = modelId;
  else delete query.modelId;
  void router.replace({ path: route.path, query });
}
const modelOptions = computed(() => {
  const instances = instanceList.value;
  const id = selectedModelId.value;
  return id && !instances.some((i) => i.id === id)
    ? [{ id, name: id }, ...instances]
    : instances;
});
const modelTypeaheadOptions = computed(() => [
  { value: '', label: t('All models') },
  ...modelOptions.value.map((i) => ({ value: i.id, label: i.name })),
]);

// — Query state ——————————————————————————
// Trace ID is seeded by the route and remains editable in the condition bar.
const traceIdParam = computed(() => {
  const v = route.query.evaluationTraceId;
  return typeof v === 'string' && v.length > 0 ? v : null;
});
// Keep the route-provided value visible and editable. Updating or clearing
// the field updates the route-provided condition as well.
const traceIdInput = ref(queryString('evaluationTraceId') ?? '');
watch(traceIdParam, (next) => {
  const value = next ?? '';
  if (traceIdInput.value !== value) traceIdInput.value = value;
}, { immediate: true });
watch(traceIdInput, (value) => {
  const next = value.trim();
  if (next === (traceIdParam.value ?? '')) return;
  const query = { ...route.query };
  if (next) query.evaluationTraceId = next;
  else delete query.evaluationTraceId;
  void router.replace({ path: route.path, query });
});
// Free-text content search is intentionally NOT exposed. OAP's
// content-keyword filter is opt-in per storage backend (off on the
// stock H2 store) and indexing across full log bodies has surprising
// latency / cardinality behaviour on busy clusters. The conditions
// the UI exposes — service / instance / endpoint / traceID / tags —
// are all indexed dimensions and cover the booster-ui condition set.
const page = ref(1);
const pageSize = ref(50);
const valueType = ref<'SCORE' | 'BOOLEAN' | 'STRING' | 'JSON' | null>('SCORE');
const minScore = ref<number | null>(null);
const maxScore = ref<number | null>(null);
const booleanValue = ref<boolean | null>(null);
// A dashboard drill seeds the clicked task once. Do not watch the query
// afterwards: the text field must remain editable, including clearing it to
// broaden the result set.
const taskName = ref(queryString('taskName') ?? '');
const judgeModel = ref('');
// One ordering, not a field and a direction: newest first is the only order
// time is read in, and a score reads either way.
type SortKey = 'time' | 'score_desc' | 'score_asc';
const sortKey = ref<SortKey>('time');
const sortField = computed<'EVALUATION_TIME' | 'SCORE_VALUE'>(() => (sortKey.value === 'time' ? 'EVALUATION_TIME' : 'SCORE_VALUE'));
const sortOrder = computed<'ASC' | 'DES'>(() => (sortKey.value === 'score_asc' ? 'ASC' : 'DES'));
const traceIdRef = computed<string | null>(() => {
  const v = traceIdInput.value.trim();
  return v.length > 0 ? v : null;
});
// The addressing scheme is only needed when locating a specific trace.
const traceTypeRef = ref<'SKYWALKING_NATIVE' | 'OTLP'>('SKYWALKING_NATIVE');
// Narrowing to ONE span of that trace: typed in (ids copied from logs) or
// picked from the trace. A span belongs to its trace and scheme, so both
// reset the narrowing.
const traceSegmentIdInput = ref('');
const traceSpanIndexInput = ref<number | ''>('');
const traceSpanIdInput = ref('');
function clearSpanNarrowing(): void {
  traceSegmentIdInput.value = '';
  traceSpanIndexInput.value = '';
  traceSpanIdInput.value = '';
}
watch([traceIdRef, traceTypeRef], clearSpanNarrowing);
const traceSegmentIdRef = computed<string | null>(() =>
    traceTypeRef.value === 'SKYWALKING_NATIVE' ? traceSegmentIdInput.value.trim() || null : null);
const traceSpanIndexRef = computed<number | null>(() => {
  const index = traceSpanIndexInput.value;
  return traceTypeRef.value === 'SKYWALKING_NATIVE' && Number.isInteger(index) && (index as number) >= 0 ? (index as number) : null;
});
const traceSpanIdRef = computed<string | null>(() =>
    traceTypeRef.value === 'OTLP' ? traceSpanIdInput.value.trim() || null : null);
const spanPickerOpen = ref(false);
function applySpanPick(pick: RelatedSpanPick | null): void {
  spanPickerOpen.value = false;
  clearSpanNarrowing();
  if (pick?.type === 'SKYWALKING_NATIVE') {
    traceSegmentIdInput.value = pick.segmentId;
    traceSpanIndexInput.value = pick.spanIndex;
  } else if (pick?.type === 'OTLP') {
    traceSpanIdInput.value = pick.spanId;
  }
}
const serviceId = ref('');
const providerIdRef = computed<string | null>(() => selectedId.value);
const modelIdRef = computed<string | null>(() => selectedModelId.value);
const keywordsRef = computed<string[]>(() => []);

function changeValueType(): void {
  minScore.value = null;
  maxScore.value = null;
  booleanValue.value = null;
  if (valueType.value !== 'SCORE') sortKey.value = 'time';
}

// Time-range picker. Logs blocks the global topbar picker (see
// `TIME_RANGE_OPT_OUT` in AppTopbar), so this is the source of truth
// for which rolling window the log + facet queries scan. Presets
// cover the most common ranges; the operator can extend if needed
// (cap is 7 days, enforced server-side too). Mirrors the trace tab's
// Custom escape hatch — picking it swaps the preset dropdown for two
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
watch([startTimeParam, endTimeParam], ([start, end]) => {
  if (start == null || end == null) return;
  windowMinutes.value = CUSTOM_RANGE_SENTINEL;
  customStart.value = fmtDateTimeLocal(new Date(start));
  customEnd.value = fmtDateTimeLocal(new Date(end));
}, { immediate: true });
function localInputToEpoch(local: string | null): number | null {
  if (!local) return null;
  const epochMs = new Date(local).getTime();
  return Number.isFinite(epochMs) ? epochMs : null;
}
const startTimeRef = computed<number | null>(() =>
    isCustomRange.value ? localInputToEpoch(customStart.value) : null,
);
const endTimeRef = computed<number | null>(() =>
    isCustomRange.value ? localInputToEpoch(customEnd.value) : null,
);
const customRangeError = computed<string | null>(() => {
  if (!isCustomRange.value) return null;
  const start = startTimeRef.value;
  const end = endTimeRef.value;
  if (start == null || end == null) return 'Select both start and end times.';
  if (end <= start) return 'End time must be later than start time.';
  if (end - start > 7 * 24 * 60 * 60_000) return 'Time range cannot exceed 7 days.';
  return null;
});
const windowMinutesEffective = computed<number>(() =>
    isCustomRange.value ? 0 : windowMinutes.value,
);
// Taken when the picker opens, not at render: a rolling window read from a
// computed would keep the clock of the last render, and a trace judged after
// that would be looked up before its own time.
function currentWindow(): { startMs: number; endMs: number } | null {
  if (isCustomRange.value) {
    const start = startTimeRef.value;
    const end = endTimeRef.value;
    return start != null && end != null && end > start ? { startMs: start, endMs: end } : null;
  }
  const endMs = Date.now();
  return { startMs: endMs - windowMinutes.value * 60_000, endMs };
}
const pickerWindow = ref<{ startMs: number; endMs: number } | null>(null);
function openSpanPicker(): void {
  pickerWindow.value = currentWindow();
  spanPickerOpen.value = true;
}

// — Tag conditions (booster-style single `key=value` input) ———
// One text input; Enter commits the tag. Tags accumulate in `customTags`
// and ride along on the OAP log query as filters. Key/value autocomplete
// lives in TagInput.
// — Level filter goes to OAP as a `level=<UPPER>` tag filter so the
// server-side total + pagination match the visible rows. The filter
// is single-select (booster-ui uses the same pattern).
const LEVEL_TAG_VALUES: Record<'fail' | 'warning' | 'good' | 'excellent', string> = {
  fail: 'fail',
  warning: 'warning',
  good: 'good',
  excellent: 'excellent',
};
const selectedLevel = ref<'fail' | 'warning' | 'good' | 'excellent' | null>(null);
// The legend chips sit under the results and act on them: unlike the
// condition bar, a click here commits and re-reads at once, so the chip
// means what it shows. Before the first Run query it only stages.
function toggleLevel(l: 'fail' | 'warning' | 'good' | 'excellent' | 'undefined'): void {
  if (l === 'undefined') return; // server-side fallback bucket is not user-selectable
  selectedLevel.value = selectedLevel.value === l ? null : l;
  if (hasQueried.value) runQuery();
}

// The reads take these APPLIED conditions, not the live draft refs, so
// editing a condition stages the query without firing it — the same
// contract as the Logs and Traces tabs. `applyConditions()` commits the draft
// on Run query and on a provider switch. `page` / `pageSize` stay live.
interface AppliedConditions {
  providerId: string | null;
  modelId: string | null;
  serviceId: string | null;
  valueType: 'SCORE' | 'BOOLEAN' | 'STRING' | 'JSON' | null;
  minScore: number | null;
  maxScore: number | null;
  booleanValue: boolean | null;
  taskName: string | null;
  evaluationLevel: string | null;
  judgeModel: string | null;
  sortField: 'EVALUATION_TIME' | 'SCORE_VALUE';
  sortOrder: 'ASC' | 'DES';
  traceId: string | null;
  traceType: 'SKYWALKING_NATIVE' | 'OTLP';
  traceSegmentId: string | null;
  traceSpanIndex: number | null;
  traceSpanId: string | null;
  windowMinutes: number;
  startTime: number | null;
  endTime: number | null;
}
function snapshotConditions(): AppliedConditions {
  return {
    providerId: providerIdRef.value,
    modelId: modelIdRef.value,
    serviceId: serviceId.value.trim() || null,
    valueType: valueType.value,
    minScore: minScore.value,
    maxScore: maxScore.value,
    booleanValue: booleanValue.value,
    taskName: taskName.value.trim() || null,
    evaluationLevel: selectedLevel.value ? LEVEL_TAG_VALUES[selectedLevel.value] : null,
    judgeModel: judgeModel.value.trim() || null,
    sortField: sortField.value,
    sortOrder: sortOrder.value,
    traceId: traceIdRef.value,
    traceType: traceTypeRef.value,
    traceSegmentId: traceSegmentIdRef.value,
    traceSpanIndex: traceSpanIndexRef.value,
    traceSpanId: traceSpanIdRef.value,
    windowMinutes: windowMinutesEffective.value,
    startTime: startTimeRef.value,
    endTime: endTimeRef.value,
  };
}
const applied = ref<AppliedConditions>(snapshotConditions());
function applyConditions(): void {
  applied.value = snapshotConditions();
}
// Manual-fire gate: nothing is read until the operator presses Run query, so
// a freshly opened tab shows the prompt rather than a misleading empty state.
const hasQueried = ref(false);
// The provider is the upstream control: both reads stay parked until one is
// picked, however many times Run query is pressed.
const providerReady = computed(() => !!selectedId.value);
const queryEnabled = computed(() => hasQueried.value && providerReady.value && customRangeError.value == null);
const a = <K extends keyof AppliedConditions>(key: K) => computed(() => applied.value[key]);

const { genAIEvaluationRecordStreamRows, total, hasNext, reachable, queryError, isFetching, refetch } = useLayerEvaluationRecord(layerKey, {
  service: computed(() => null),
  serviceId: a('serviceId'),
  providerId: a('providerId'),
  modelId: a('modelId'),
  valueType: a('valueType'),
  minScore: a('minScore'),
  maxScore: a('maxScore'),
  booleanValue: a('booleanValue'),
  taskName: a('taskName'),
  evaluationLevel: a('evaluationLevel'),
  judgeModel: a('judgeModel'),
  sortField: a('sortField'),
  sortOrder: a('sortOrder'),
  traceId: a('traceId'),
  traceType: a('traceType'),
  traceSegmentId: a('traceSegmentId'),
  traceSpanIndex: a('traceSpanIndex'),
  traceSpanId: a('traceSpanId'),
  keywords: keywordsRef,
  page,
  pageSize,
  windowMinutes: a('windowMinutes'),
  startTime: a('startTime'),
  endTime: a('endTime'),
  enabled: queryEnabled,
});

const { facets, refetch: refetchFacets } = useLayerEvaluationRecordFacets(layerKey, {
  service: computed(() => null),
  serviceId: a('serviceId'),
  providerId: a('providerId'),
  modelId: a('modelId'),
  valueType: a('valueType'),
  minScore: a('minScore'),
  maxScore: a('maxScore'),
  booleanValue: a('booleanValue'),
  taskName: a('taskName'),
  judgeModel: a('judgeModel'),
  traceId: a('traceId'),
  traceType: a('traceType'),
  traceSegmentId: a('traceSegmentId'),
  traceSpanIndex: a('traceSpanIndex'),
  traceSpanId: a('traceSpanId'),
  keywords: keywordsRef,
  windowMinutes: a('windowMinutes'),
  startTime: a('startTime'),
  endTime: a('endTime'),
  enabled: queryEnabled,
});
useAutoRefreshSubscribe(() => refetchFacets(), queryEnabled);
// Declared after the facets composable it reads: a watch fires during setup.
watch(() => facets.value?.services, (services) => {
  if (!services) return;
  const next = new Map(seenCallers.value);
  for (const s of services) if (s.id) next.set(s.id, s.name);
  seenCallers.value = next;
});

// Run query commits the draft and refetches BOTH reads, so the facet sample
// never diverges from the stream (facets carry a staleTime of their own).
function runQuery(): void {
  if (!providerReady.value || customRangeError.value != null) return;
  page.value = 1;
  hasQueried.value = true;
  applyConditions();
  void refetch();
  void refetchFacets();
}

// — Density histogram (60 bins). Loki/Datadog style: stacked bars
// per level over the visible page's time window. Counts come from
// the loaded page only — total-window density would need a server
// aggregation we don't have yet. -----------------------------------

const LEVEL_ORDER = ['fail', 'warning', 'good', 'excellent', 'undefined'] as const;
type Level = typeof LEVEL_ORDER[number];
const LEVEL_COLOR: Record<Level, string> = {
  fail: 'var(--sw-err)',
  warning: 'var(--sw-warn)',
  good: 'var(--sw-info)',
  excellent: 'var(--sw-ok)',
  undefined: 'var(--sw-fg-3)',
};

function levelOf(r: GenAIEvaluationRecordStreamRow): Level {
  const raw = (r.evaluationLevel ?? '').toLowerCase();
  if (raw === 'fail') return 'fail';
  if (raw === 'warning') return 'warning';
  if (raw === 'good') return 'good';
  if (raw === 'excellent') return 'excellent';
  return 'undefined';
}

const BINS = 60;
const histogram = computed(() => {
  const rows = genAIEvaluationRecordStreamRows.value;
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
    fail: 0,
    warning: 0,
    good: 0,
    excellent: 0,
    undefined: 0,
  }));
  for (const r of rows) {
    const idx = Math.min(BINS - 1, Math.floor(((r.timestamp - t0) / span) * BINS));
    bins[idx][levelOf(r)] += 1;
  }
  let max = 0;
  for (const b of bins) {
    const t = b.fail + b.warning + b.good + b.excellent + b.undefined;
    if (t > max) max = t;
  }
  return { bins, max, t0, t1 };
});

// — Facets — server-side aggregated across a larger window sample
// (default 200 rows). When the facet fetch hasn't returned yet we
// fall back to counts derived from the visible page so the rail
// never goes empty.
const levelFacet = computed<Record<Level, number>>(() => {
  if (facets.value?.level) return facets.value.level;
  const counts: Record<Level, number> = { fail: 0, warning: 0, good: 0, excellent: 0, undefined: 0 };
  for (const r of genAIEvaluationRecordStreamRows.value) counts[levelOf(r)] += 1;
  return counts;
});
// The sample is the newest records up to the facet size, so a count saturates
// once the window holds more than that and says nothing. The share within the
// sample is what it can honestly say; the count stays in the tooltip.
const levelSampleTotal = computed(() => (facets.value ? facets.value.sampled : genAIEvaluationRecordStreamRows.value.length));
function levelShare(l: Level): number {
  const total = levelSampleTotal.value;
  return total > 0 ? Math.round((levelFacet.value[l] / total) * 100) : 0;
}
// Service facet removed — the log query is already service-scoped
// (the view is opened from /layer/<key>/logs with a specific service
// selected), so a "top services" rail just repeats the title.

// — Evaluation-record payload popout — a row click opens the dedicated
// detail modal (format-aware pretty-print + copy + key/value tag table +
// trace link). The popout owns its own Escape / close + format detection.
const popoutRow = ref<GenAIEvaluationRecordStreamRow | null>(null);
function onRowClick(r: GenAIEvaluationRecordStreamRow): void {
  popoutRow.value = r;
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
function jumpToTrace(traceId: string, ts?: number, traceType: 'SKYWALKING_NATIVE' | 'OTLP' | null = null, traceSegmentId?: string | null, traceSpanIndex?: number | null, traceSpanId?: string | null): void {
  popoutRow.value = null;
  openResultTrace({
    type: traceType ?? 'SKYWALKING_NATIVE',
    traceId,
    segmentId: traceSegmentId,
    spanIndex: traceSpanIndex,
    spanId: traceSpanId,
  }, ts);
}

// A dashboard drill arrives with its conditions in the address (the window,
// and the provider / model / task it was clicked from), as does a link
// carrying a trace id. Those run once the provider resolves, the way the
// metric→trace drill does on the Traces tab; a plain open waits for Run query.
// Declared last: it fires during setup and reads everything above.
const drillArmed = ref(traceIdParam.value != null || (startTimeParam.value != null && endTimeParam.value != null));
watch([drillArmed, providerReady], ([armed, ready]) => {
  if (!armed || !ready) return;
  drillArmed.value = false;
  runQuery();
}, { immediate: true });
</script>

<template>
  <div class="lg-tab">
    <!-- Toolbar mirrors the trace tab: head row (kicker + Run query)
         on top, conditions grid below, active tag chips at the foot. -->
    <header class="lg-toolbar sw-card">
      <div class="lg-toolbar-head">
        <span class="kicker">{{ t('Evaluation records') }}</span>
        <span v-if="traceIdRef" class="trace-pin">trace <code>{{ traceIdRef.slice(0, 12) }}...</code></span>
        <span v-if="isFetching" class="hint">refreshing...</span>
        <button class="sw-btn primary lg-run-btn" type="button" :disabled="!providerReady || customRangeError != null" @click="runQuery">{{ t('Run query') }}</button>
      </div>
      <div class="lg-conditions">
        <div class="cf-row cf-row-3">
        <!-- Provider is always scoped (a layer page keys on one service);
             a model is opt-in, `All` by default. -->
        <label class="cf cf-provider">
          <span>{{ t('Provider') }}</span>
          <TypeaheadSelect
              :model-value="selectedId"
              :options="providerTypeaheadOptions"
              :placeholder="callerServicesLoading ? t('Reading data…') : undefined"
              :disabled="providerOptions.length === 0"
              :aria-label="t('Provider')"
              block
              @update:model-value="changeProvider"
          />
        </label>
        <label class="cf cf-model">
          <span>{{ t('Model') }}</span>
          <TypeaheadSelect
              :model-value="selectedModelId ?? ''"
              :options="modelTypeaheadOptions"
              :aria-label="t('Model')"
              block
              @update:model-value="(id: string) => changeModel(id || null)"
          />
        </label>
        <label class="cf cf-caller">
          <span>{{ t('Service') }}</span>
          <TypeaheadSelect
              v-model="serviceId"
              :options="callerTypeaheadOptions"
              :disabled="callerServices.length === 0"
              :aria-label="t('Service')"
              block
          />
        </label>
        </div>
        <div class="cf-row cf-row-2">
        <label class="cf">
          <span>Task name</span>
          <input v-model="taskName" type="text" class="cf-input" :placeholder="t('All tasks')" />
        </label>
        <label class="cf">
          <span>Judge model</span>
          <input v-model="judgeModel" type="text" class="cf-input" :placeholder="t('All judge models')" />
        </label>
        </div>
        <div class="cf-row cf-row-4">
        <!-- One condition: the value's type and, beside it, the operand that
             type takes. A score is bounded, a verdict is true or false; a
             string or JSON value has no operand, since OAP's condition offers
             none for those. -->
        <label class="cf cf-wide cf-value">
          <span>{{ t('Value') }}</span>
          <div class="cf-range">
            <select v-model="valueType" class="cf-input cf-value-type" @change="changeValueType">
              <option :value="null">{{ t('Any type') }}</option>
              <option value="SCORE">Score</option>
              <option value="BOOLEAN">Boolean</option>
              <option value="STRING">String</option>
              <option value="JSON">JSON</option>
            </select>
            <template v-if="valueType === 'SCORE'">
              <input v-model.number="minScore" type="number" class="cf-input cf-range-num cf-min-score" step="any" :placeholder="t('min')" />
              <span class="cf-range-sep">to</span>
              <input v-model.number="maxScore" type="number" class="cf-input cf-range-num cf-max-score" step="any" :placeholder="t('max')" />
            </template>
            <select v-else-if="valueType === 'BOOLEAN'" v-model="booleanValue" class="cf-input cf-boolean-value">
              <option :value="null">{{ t('All') }}</option>
              <option :value="true">True</option>
              <option :value="false">False</option>
            </select>
          </div>
        </label>
        <!-- Trace ID. Bound directly — each keystroke updates the
             query. URL `?traceId=` still overrides. -->
        <label class="cf cf-wide">
          <span>Trace ID</span>
          <input
              v-model="traceIdInput"
              type="text"
              class="cf-input mono cf-trace-id"
              placeholder="paste trace id..."
          />
        </label>
        <label v-if="traceIdRef" class="cf">
          <span>Trace ID type</span>
          <select v-model="traceTypeRef" class="cf-input">
            <option value="SKYWALKING_NATIVE">SkyWalking Native</option>
            <option value="OTLP">OTLP</option>
          </select>
        </label>
        <!-- One span of that trace, by the scheme's own address. Blank means
             the whole trace; the picker fills these from the trace itself. -->
        <template v-if="traceIdRef">
          <template v-if="traceTypeRef === 'SKYWALKING_NATIVE'">
            <label class="cf">
              <span>{{ t('Segment ID') }}</span>
              <input v-model="traceSegmentIdInput" type="text" class="cf-input mono cf-segment-id" :placeholder="t('Whole trace')" />
            </label>
            <label class="cf">
              <span>{{ t('Span index') }}</span>
              <input v-model.number="traceSpanIndexInput" type="number" min="0" step="1" class="cf-input mono cf-span-index" :placeholder="t('Any')" />
            </label>
          </template>
          <label v-else class="cf">
            <span>{{ t('Span ID') }}</span>
            <input v-model="traceSpanIdInput" type="text" class="cf-input mono cf-span-id" :placeholder="t('Whole trace')" />
          </label>
          <!-- Reading a trace needs traces:read, as the row links do; the
               address can still be typed without it. -->
          <label v-if="auth.hasVerb('traces:read')" class="cf cf-action">
            <span>&nbsp;</span>
            <button class="sw-btn small cf-pick-span" type="button" @click="openSpanPicker">{{ t('Pick span…') }}</button>
          </label>
        </template>
        </div>
        <div class="cf-row cf-row-3">
        <!-- Time range — presets + Custom, which swaps to two
             datetime-local inputs (matches the trace tab). -->
        <label class="cf" :class="{ 'cf-wide': isCustomRange }">
          <span>Time range</span>
          <template v-if="isCustomRange">
            <div class="cf-range">
              <input v-model="customStart" type="datetime-local" class="cf-input cf-range-num" />
              <span class="cf-range-sep">to</span>
              <input v-model="customEnd" type="datetime-local" class="cf-input cf-range-num" />
              <button class="sw-btn small ghost" type="button" title="Back to presets" @click="windowMinutes = 30">Back</button>
            </div>
          </template>
          <select v-else v-model.number="windowMinutes" class="cf-input">
            <option v-for="p in TIME_RANGE_PRESETS" :key="p.minutes" :value="p.minutes">{{ p.label }}</option>
            <option :value="CUSTOM_RANGE_SENTINEL">{{ t('Custom') }}</option>
          </select>
        </label>
        <label class="cf">
          <span>{{ t('Page size') }}</span>
          <select v-model.number="pageSize" class="cf-input" @change="page = 1">
            <option :value="20">20</option>
            <option :value="30">30</option>
            <option :value="50">50</option>
            <option :value="100">100</option>
          </select>
        </label>
        <label class="cf">
          <span>{{ t('Sort by') }}</span>
          <select v-model="sortKey" class="cf-input cf-sort">
            <option value="time">{{ t('Evaluation time (newest first)') }}</option>
            <option v-if="valueType === 'SCORE'" value="score_desc">{{ t('Score (high to low)') }}</option>
            <option v-if="valueType === 'SCORE'" value="score_asc">{{ t('Score (low to high)') }}</option>
          </select>
        </label>
        </div>
      </div>
    </header>

    <div v-if="!reachable" class="banner err">
      <strong>{{ t('Evaluation records feed failed.') }}</strong> {{ queryError || t('Backend unreachable.') }}
    </div>
    <div v-else-if="customRangeError" class="banner err">{{ customRangeError }}</div>

    <!-- Histogram + main stream -->
    <section v-if="!customRangeError" class="lg-body sw-card">
      <div class="lg-main">
        <!-- Trailing control: the stream waits for a provider, then for Run
             query. Editing a condition stages it; nothing reads until then. -->
        <div v-if="catalogFailure" class="banner err lg-catalog-failure">
          <strong>{{ t('Evaluation catalog unreachable.') }}</strong> {{ catalogFailure }}
          <button class="sw-btn small" type="button" @click="callerServicesQuery.refetch()">{{ t('Retry') }}</button>
        </div>
        <div v-else-if="!providerReady" class="lg-empty">
          <template v-if="callerServicesLoading">{{ t('Resolving provider…') }}</template>
          <template v-else>{{ t('Pick a provider to run this query.') }}</template>
        </div>
        <div v-else-if="!hasQueried" class="lg-empty">
          {{ t('Pick your conditions, then click Run query.') }}
        </div>
        <template v-else>
        <!-- Top-of-table legend strip — one chip per level with the
             in-window count when data exists. Clickable: toggles the
             level filter. The service axis is intentionally absent
             (this query is already service-scoped, so the service
             dimension carries no information). -->
        <div v-if="facets || genAIEvaluationRecordStreamRows.length > 0" class="lg-legend">
          <span class="lg-legend-kicker">{{ t('Evaluation Levels') }}</span>
          <button
              v-for="l in LEVEL_ORDER"
              :key="l"
              type="button"
              class="lg-legend-chip"
              :class="{ on: selectedLevel === l, disabled: l === 'undefined' }"
              :disabled="l === 'undefined'"
              @click="toggleLevel(l)"
          >
            <span class="lvl-dot" :style="{ background: LEVEL_COLOR[l] }" />
            <span class="lg-legend-name">{{ l }}</span>
            <span
                v-if="levelFacet[l] > 0"
                class="lg-legend-count"
                :title="t('{count} of the {n} most recent records', { count: levelFacet[l], n: levelSampleTotal })"
            >{{ levelShare(l) }}%</span>
          </button>
          <span v-if="facets" class="lg-legend-sample" :title="t('{count} of the {n} most recent records', { count: facets.sampled, n: facets.sampled })">
            {{ t('share of the newest {n}', { n: facets.sampled }) }}
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
                {{ histogram.bins[hoveredBin].fail + histogram.bins[hoveredBin].warning + histogram.bins[hoveredBin].good + histogram.bins[hoveredBin].excellent + histogram.bins[hoveredBin].undefined }} record<template v-if="(histogram.bins[hoveredBin].fail + histogram.bins[hoveredBin].warning + histogram.bins[hoveredBin].good + histogram.bins[hoveredBin].excellent + histogram.bins[hoveredBin].undefined) !== 1">s</template>
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

        <!-- Stream. A read in flight shows as reading, never as an empty scope. -->
        <div v-if="genAIEvaluationRecordStreamRows.length === 0 && isFetching" class="lg-empty">
          {{ t('Reading data…') }}
        </div>
        <div v-else-if="genAIEvaluationRecordStreamRows.length === 0" class="lg-empty">
          {{ t('No evaluation records returned for this scope.') }}
        </div>
        <!-- Row click — open the full-payload popout. The dense row
             rendering is the shared `LogStreamPanel` (same markup the
             cross-layer Log inspect uses); the popout + density bar +
             facets stay in this view. -->
        <EvaluationRecordStreamPanel
            v-else
            :rows="genAIEvaluationRecordStreamRows"
            @select="onRowClick($event.row)"
            @jump-trace="jumpToTrace($event.traceId, $event.ts, $event.traceType, $event.traceSegmentId, $event.traceSpanIndex, $event.traceSpanId)"
        />
        <div class="lg-pager">
          <span class="hint">
            {{ t('page {page} · showing {shown}', { page, shown: genAIEvaluationRecordStreamRows.length }) }}
            <template v-if="total != null"> of {{ total }} total</template>
          </span>
          <div class="lg-pager-ctrls">
            <button class="sw-btn small" type="button" :disabled="page <= 1" @click="page--">{{ t('Prev') }}</button>
            <button
                class="sw-btn small"
                type="button"
                :disabled="!hasNext || isFetching"
                @click="page++"
            >{{ t('Next') }}</button>
          </div>
        </div>
        </template>
      </div>
    </section>

    <!-- Full-payload popout. Evaluation-record-specific presentation lives
         in the dedicated modal so shared log pages stay unchanged. -->
    <EvaluationRecordDetailPopout
        :row="popoutRow"
        @close="popoutRow = null"
        @jump-trace="jumpToTrace($event.traceId, $event.ts, $event.traceType, $event.traceSegmentId, $event.traceSpanIndex, $event.traceSpanId)"
    />
    <RelatedTraceSpanPicker
        :open="spanPickerOpen"
        :trace-id="traceIdRef ?? ''"
        :trace-type="traceTypeRef"
        :window="pickerWindow"
        @close="spanPickerOpen = false"
        @pick="applySpanPick"
    />
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
.lg-conditions { display: flex; flex-direction: column; gap: 8px; width: 100%; }
/* Fixed rows: what belongs together stays together, and a control that
   appears or disappears (the value's operand, the trace address) never
   reflows its neighbours. */
.cf-row { display: grid; gap: 8px 10px; }
.cf-row-2 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.cf-row-3 { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.cf-row-4 { grid-template-columns: repeat(4, minmax(0, 1fr)); }
@media (max-width: 900px) { .cf-row { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
/* The type-to-filter pickers take the native inputs' metrics, so a row of
   mixed controls sits on one line at one height. */
.cf :deep(.tas__trigger) {
  height: 28px;
  padding: 0 8px;
  font-size: 11px;
  color: var(--sw-fg-0);
  min-width: 0;
  max-width: none;
}
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
.cf.cf-action { justify-content: flex-end; }
.cf.cf-action .sw-btn { align-self: flex-start; }
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
.cf-range-num { flex: 1 1 0; min-width: 5.5ch; }
/* The type select's full-width basis would otherwise take the whole cell and
   crush the bounds beside it to slivers. */
.cf-range .cf-value-type { flex: 0 1 44%; width: auto; }
.cf-range .cf-boolean-value { flex: 1 1 0; width: auto; }
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
  color: var(--sw-err);
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

</style>
