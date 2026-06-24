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
  Trace inspect — cross-layer trace query power-tool. (Log inspect is the
  sibling ExploreLogView; both share the same `.iq-*` spine.)

  Layer-less by design: the entity is OPTIONAL. Name a service by PICKING
  it (a layer-filtered dropdown), TYPING it (service name + the real/
  normal flag, which the BFF encodes into the OAP id), or leave it blank
  to query every service in the window. One query → one result, rendered
  with the same waterfall the per-layer Traces tab uses; the resolved-
  query panel surfaces the exact condition the BFF ran.

  Source switches between SkyWalking-native and Zipkin traces.
-->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { bffClient } from '@/api/client';
import type {
  ExploreEntity,
  ExploreRequest,
  ExploreResolved,
  ExploreWindow,
  NativeSpan,
  NativeTraceListResponse,
  NativeTraceListRow,
  TraceQueryOrder,
  TraceQueryState,
} from '@/api/client';
import type { ZipkinTraceListRow } from '@/api/client';
import { useLayers } from '@/shell/useLayers';
import { useTraceDetail } from '@/layer/traces/useLayerTraces';
import { useZipkinTrace } from '@/layer/traces/useZipkinTraces';
import TraceListPanel from '@/render/widgets/TraceListPanel.vue';
import TraceDetailCard from '@/render/widgets/TraceDetailCard.vue';
import ZipkinTraceDetailCard from '@/render/widgets/ZipkinTraceDetailCard.vue';
import TraceDistribution from '@/render/widgets/TraceDistribution.vue';
import TypeaheadSelect from '@/components/primitives/TypeaheadSelect.vue';
import TagInput from '@/components/primitives/TagInput.vue';

const { t } = useI18n();
const { availableLayers } = useLayers();

// ── source (native / zipkin) ──────────────────────────────────────────
type TraceSource = 'native' | 'zipkin';
const traceSource = ref<TraceSource>('native');

// ── entity (OPTIONAL): pick (layer-filtered) vs type (name + real) ────
type EntityMode = 'pick' | 'type';
const entityMode = ref<EntityMode>('pick');

const pickLayer = ref<string>('');
const pickServiceId = ref<string>('');
const pickInstanceId = ref<string>('');
const pickEndpointId = ref<string>('');
const services = ref<Array<{ id: string; name: string; normal: boolean | null }>>([]);
const instances = ref<Array<{ id: string; name: string }>>([]);
const endpoints = ref<Array<{ id: string; name: string }>>([]);
const servicesLoading = ref(false);

const pickServiceName = computed(
  () => services.value.find((s) => s.id === pickServiceId.value)?.name ?? '',
);

async function loadServices(): Promise<void> {
  services.value = [];
  instances.value = [];
  endpoints.value = [];
  pickServiceId.value = '';
  pickInstanceId.value = '';
  pickEndpointId.value = '';
  if (!pickLayer.value) return;
  servicesLoading.value = true;
  try {
    const res = await bffClient.layer.services(pickLayer.value);
    services.value = res.reachable ? res.services : [];
  } catch {
    services.value = [];
  } finally {
    servicesLoading.value = false;
  }
}

async function loadInstances(): Promise<void> {
  instances.value = [];
  pickInstanceId.value = '';
  const name = pickServiceName.value;
  if (!pickLayer.value || !name) return;
  try {
    const res = await bffClient.layer.instances(pickLayer.value, name);
    instances.value = res.reachable ? res.instances : [];
  } catch {
    instances.value = [];
  }
}

async function loadEndpoints(): Promise<void> {
  pickEndpointId.value = '';
  const name = pickServiceName.value;
  if (!pickLayer.value || !name) {
    endpoints.value = [];
    return;
  }
  try {
    // Preload the top endpoints (like the per-layer Traces picker); the
    // dropdown filters them client-side.
    const res = await bffClient.layer.endpoints(pickLayer.value, name, '', 50);
    endpoints.value = res.reachable ? res.endpoints : [];
  } catch {
    endpoints.value = [];
  }
}

watch(pickLayer, () => void loadServices());
watch(pickServiceId, () => {
  void loadInstances();
  void loadEndpoints();
});

const layerOptions = computed(() => availableLayers.value.map((l) => ({ value: l.key, label: l.name || l.key })));
const serviceOptions = computed(() =>
  services.value.map((s) => ({ value: s.id, label: s.name, hint: s.normal === false ? 'virtual' : undefined })),
);
const instanceOptions = computed(() => [
  { value: '', label: t('All instances') },
  ...instances.value.map((i) => ({ value: i.id, label: i.name })),
]);
const endpointOptions = computed(() => [
  { value: '', label: t('All endpoints') },
  ...endpoints.value.map((e) => ({ value: e.id, label: e.name })),
]);
const instanceSel = computed<string>({ get: () => pickInstanceId.value, set: (v) => (pickInstanceId.value = v ?? '') });
const endpointSel = computed<string>({ get: () => pickEndpointId.value, set: (v) => (pickEndpointId.value = v ?? '') });

const typeService = ref<string>('');
const typeReal = ref<boolean>(true);
const typeInstance = ref<string>('');
const typeEndpoint = ref<string>('');

/** Seed the Type form from the current Pick selection — pick to discover,
 *  then tweak the name/flag by hand. */
function seedTypeFromPick(): void {
  if (!pickServiceName.value) return;
  typeService.value = pickServiceName.value;
  typeReal.value = services.value.find((s) => s.id === pickServiceId.value)?.normal !== false;
  typeInstance.value = instances.value.find((i) => i.id === pickInstanceId.value)?.name ?? '';
  typeEndpoint.value = endpoints.value.find((e) => e.id === pickEndpointId.value)?.name ?? '';
  entityMode.value = 'type';
}

function currentEntity(): ExploreEntity | null {
  if (entityMode.value === 'pick') {
    if (!pickServiceId.value) return null;
    return {
      mode: 'pick',
      serviceId: pickServiceId.value,
      instanceId: pickInstanceId.value || undefined,
      endpointId: pickEndpointId.value || undefined,
    };
  }
  const name = typeService.value.trim();
  if (!name) return null;
  return {
    mode: 'type',
    serviceName: name,
    isReal: typeReal.value,
    instanceName: typeInstance.value.trim() || undefined,
    endpointName: typeEndpoint.value.trim() || undefined,
  };
}

// ── zipkin entity (raw service universe — no layer, no id) ────────────
const zipkinService = ref<string>('');
const zipkinRemote = ref<string>('');
const zipkinSpan = ref<string>('');
const zipkinServiceNames = ref<string[]>([]);
const zipkinRemoteNames = ref<string[]>([]);
const zipkinSpanNames = ref<string[]>([]);

const zipkinServiceOptions = computed(() => [
  { value: '', label: t('All services') },
  ...zipkinServiceNames.value.map((s) => ({ value: s, label: s })),
]);
const zipkinRemoteOptions = computed(() => [
  { value: '', label: t('any') },
  ...zipkinRemoteNames.value.map((s) => ({ value: s, label: s })),
]);
const zipkinSpanOptions = computed(() => [
  { value: '', label: t('any') },
  ...zipkinSpanNames.value.map((s) => ({ value: s, label: s })),
]);
const zipkinHasService = computed(() => zipkinService.value.trim().length > 0);

async function loadZipkinServices(): Promise<void> {
  try {
    const res = await bffClient.zipkin.services();
    zipkinServiceNames.value = Array.from(new Set(Array.isArray(res) ? res : []));
  } catch {
    zipkinServiceNames.value = [];
  }
}
async function loadZipkinAutocomplete(svc: string): Promise<void> {
  if (!svc) {
    zipkinRemoteNames.value = [];
    zipkinSpanNames.value = [];
    return;
  }
  try {
    const sp = await bffClient.zipkin.spans(svc);
    zipkinSpanNames.value = Array.isArray(sp) ? sp : [];
  } catch { zipkinSpanNames.value = []; }
  try {
    const rs = await bffClient.zipkin.remoteServices(svc);
    zipkinRemoteNames.value = Array.isArray(rs) ? rs : [];
  } catch { zipkinRemoteNames.value = []; }
}
// Span / remote autocomplete is service-scoped in Zipkin; clearing the
// service resets the dependent fields so a stale span/remote doesn't
// silently filter out everything against "All services".
watch(zipkinService, (svc) => {
  const trimmed = svc.trim();
  if (!trimmed) {
    zipkinRemote.value = '';
    zipkinSpan.value = '';
  }
  void loadZipkinAutocomplete(trimmed);
});
// Load the zipkin service list the first time the operator switches to
// the Zipkin source (and reset the result + detail on every switch).
watch(traceSource, (src) => {
  closeDetail();
  hasQueried.value = false;
  native.value = null;
  zipkinRows.value = [];
  resolved.value = null;
  errorMsg.value = null;
  if (src === 'zipkin' && zipkinServiceNames.value.length === 0) void loadZipkinServices();
});

// ── trace conditions ──────────────────────────────────────────────────
const cond = reactive({
  traceId: '',
  traceState: 'ALL' as TraceQueryState,
  queryOrder: 'BY_START_TIME' as TraceQueryOrder,
  minDuration: '' as string,
  maxDuration: '' as string,
  tags: '' as string,
  annotationQuery: '' as string,
  windowMinutes: 30,
  limit: 30,
});
const WINDOWS = [15, 30, 60, 180, 360, 720, 1440];
const LIMITS = [20, 30, 50, 100];

// Custom time range — same sentinel-on-windowMinutes shape the per-layer
// Traces tab uses. When chosen, the Time select swaps to two
// datetime-local inputs and the query carries explicit epoch-ms bounds.
const CUSTOM_RANGE_SENTINEL = -1;
const customStart = ref<string | null>(null);
const customEnd = ref<string | null>(null);
const isCustomRange = computed(() => cond.windowMinutes === CUSTOM_RANGE_SENTINEL);
function fmtLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
watch(isCustomRange, (custom) => {
  if (custom) {
    if (customStart.value && customEnd.value) return;
    const end = new Date();
    const start = new Date(end.getTime() - 30 * 60_000);
    customStart.value = fmtLocalInput(start);
    customEnd.value = fmtLocalInput(end);
  } else {
    customStart.value = null;
    customEnd.value = null;
  }
});

function parseTags(s: string): Array<{ key: string; value: string }> {
  return s
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const i = p.indexOf('=');
      return i < 0 ? { key: p, value: '' } : { key: p.slice(0, i).trim(), value: p.slice(i + 1).trim() };
    })
    .filter((kv) => kv.key);
}

// Enter on the Tags field commits the current tag and primes a trailing
// comma so the operator keeps typing the next one — the per-layer chip
// muscle memory, minus the chips. The Run button still executes.
function onTagCommit(): void {
  const base = cond.tags.replace(/\s*,\s*$/, '').trimEnd();
  if (!base) return;
  cond.tags = `${base}, `;
}

// ── run + result ──────────────────────────────────────────────────────
const running = ref(false);
const hasQueried = ref(false);
const errorMsg = ref<string | null>(null);
const native = ref<NativeTraceListResponse | null>(null);
const zipkinRows = ref<ZipkinTraceListRow[]>([]);
const resolved = ref<ExploreResolved | null>(null);
const showResolved = ref(false);

/** Build the window the request carries: explicit epoch-ms bounds in
 *  Custom mode (datetime-local strings are browser-local; `Date.parse`
 *  reads them as local), else the rolling minutes preset. */
function resolveWindow(): ExploreWindow {
  if (isCustomRange.value) {
    if (customStart.value && customEnd.value) {
      const startMs = Date.parse(customStart.value);
      const endMs = Date.parse(customEnd.value);
      if (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs) {
        return { startMs, endMs };
      }
    }
    // Custom selected but bounds not yet valid — fall back to a sane
    // rolling window rather than forwarding the -1 sentinel.
    return { windowMinutes: 30 };
  }
  return { windowMinutes: cond.windowMinutes };
}

function buildNativeRequest(): ExploreRequest {
  const entity = currentEntity();
  return {
    kind: 'trace',
    traceSource: 'native',
    ...(entity ? { entity } : {}),
    window: resolveWindow(),
    pageSize: cond.limit,
    traceId: cond.traceId.trim() || undefined,
    traceState: cond.traceState,
    queryOrder: cond.queryOrder,
    minTraceDuration: cond.minDuration ? Number(cond.minDuration) : undefined,
    maxTraceDuration: cond.maxDuration ? Number(cond.maxDuration) : undefined,
    tags: parseTags(cond.tags),
  };
}

/** Zipkin entity carries the raw service name (no layer, no id); the
 *  remote-service / span / annotation conditions ride on the request. */
function buildZipkinRequest(): ExploreRequest {
  const svc = zipkinService.value.trim();
  return {
    kind: 'trace',
    traceSource: 'zipkin',
    ...(svc ? { entity: { mode: 'type', serviceName: svc } } : {}),
    window: resolveWindow(),
    pageSize: cond.limit,
    remoteServiceName: zipkinRemote.value.trim() || undefined,
    spanName: zipkinSpan.value.trim() || undefined,
    annotationQuery: cond.annotationQuery.trim() || undefined,
    minTraceDuration: cond.minDuration ? Number(cond.minDuration) : undefined,
    maxTraceDuration: cond.maxDuration ? Number(cond.maxDuration) : undefined,
  };
}

async function runQuery(): Promise<void> {
  running.value = true;
  hasQueried.value = true;
  errorMsg.value = null;
  closeDetail();
  brushedKeys.value = [];
  native.value = null;
  zipkinRows.value = [];
  resolved.value = null;
  const zipkin = traceSource.value === 'zipkin';
  const req = zipkin ? buildZipkinRequest() : buildNativeRequest();
  try {
    const res = await bffClient.explore.query(req);
    if (res.kind === 'trace' && res.traceSource === 'native') {
      native.value = res.native;
      zipkinRows.value = [];
      resolved.value = res.resolved;
      if (!res.native.reachable) errorMsg.value = res.native.error ?? t('OAP unreachable');
    } else if (res.kind === 'trace' && res.traceSource === 'zipkin') {
      zipkinRows.value = res.zipkin.traces;
      native.value = null;
      resolved.value = res.resolved;
      if (!res.zipkin.reachable) errorMsg.value = res.zipkin.error ?? t('OAP unreachable');
    }
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : String(e);
    native.value = null;
    zipkinRows.value = [];
  } finally {
    running.value = false;
  }
}

const isZipkin = computed(() => traceSource.value === 'zipkin');

/** Adapt a Zipkin list row to the shared list/distribution row model.
 *  Zipkin durations + timestamps are µs; the shared widgets read ms. */
function zipkinToNativeRow(r: ZipkinTraceListRow): NativeTraceListRow {
  return {
    key: r.traceId,
    segmentId: r.traceId,
    endpointNames: [r.rootName ?? r.rootService ?? '—'],
    duration: Math.round((r.duration ?? 0) / 1000),
    start: String(Math.round((r.timestamp ?? 0) / 1000)),
    isError: r.errorCount > 0,
    traceIds: [r.traceId],
  };
}

const rows = computed<NativeTraceListRow[]>(() => {
  if (!hasQueried.value) return [];
  return isZipkin.value
    ? zipkinRows.value.map(zipkinToNativeRow)
    : native.value?.traces ?? [];
});
const maxDuration = computed(() => (rows.value.length === 0 ? 0 : Math.max(...rows.value.map((r) => r.duration))));

// Brushing a region of the distribution highlights those dots and filters
// the list to them; a single click still opens one trace's detail.
const brushedKeys = ref<string[]>([]);
const brushedSet = computed(() => new Set(brushedKeys.value));
const displayRows = computed<NativeTraceListRow[]>(() =>
  brushedKeys.value.length > 0 ? rows.value.filter((r) => brushedSet.value.has(r.key)) : rows.value,
);
function onScatterBrush(keys: string[]): void { brushedKeys.value = keys; }
function clearBrush(): void { brushedKeys.value = []; }

// Which OAP query answered. `queryBasicTraces` (Trace Query v1 API)
// returns trace SEGMENTS; `queryTraces` (v2, BanyanDB only) returns whole
// traces with spans inline. The banner states the API so operators always
// know what a row represents — same wording as the per-layer Traces tab.
// Zipkin always returns whole traces, so the banner is native-only.
const isSegmentList = computed(() => !isZipkin.value && native.value?.api === 'queryBasicTraces');
const traceApiLabel = computed(() => (native.value?.api === 'queryTraces' ? 'v2' : 'v1'));
const showApiBanner = computed(() => hasQueried.value && !isZipkin.value && !!native.value?.reachable);

// ── detail (reuses the shared trace-detail card + GET /api/trace/:id) ─
const selectedTraceId = ref<string | null>(null);
const selectedTraceIds = ref<string[]>([]);
const selectedRowKey = ref<string | null>(null);
const embeddedSpans = ref<NativeSpan[] | null>(null);
const railOpen = ref<boolean>(true);
const sourceRef = ref<'native' | 'zipkin'>('native');
// Two detail hooks, each fed by a SOURCE-SCOPED trace-id ref so only the
// active backend fetches (each hook gates on `!!traceId`). Native uses the
// segment-id → queryTrace path; the zipkin detail is layer-less.
const nativeDetailTraceId = computed<string | null>(() => (isZipkin.value ? null : selectedTraceId.value));
const zipkinDetailTraceId = computed<string | null>(() => (isZipkin.value ? selectedTraceId.value : null));
const { nativeDetail, isFetching: detailFetching } = useTraceDetail(nativeDetailTraceId, sourceRef);
const { spans: zipkinSpans, isFetching: zipkinDetailFetching } = useZipkinTrace(zipkinDetailTraceId);
const waterfallSpans = computed<NativeSpan[]>(() => embeddedSpans.value ?? nativeDetail.value?.spans ?? []);
const detailLoading = computed(() => (isZipkin.value ? zipkinDetailFetching.value : detailFetching.value));

function openRow(row: NativeTraceListRow): void {
  selectedRowKey.value = row.key;
  selectedTraceIds.value = row.traceIds;
  selectedTraceId.value = row.traceIds[0] ?? null;
  embeddedSpans.value = row.spans ?? null;
}
function closeDetail(): void {
  selectedTraceId.value = null;
  selectedTraceIds.value = [];
  selectedRowKey.value = null;
  embeddedSpans.value = null;
}
function changeSelectedTraceId(id: string): void {
  selectedTraceId.value = id;
  embeddedSpans.value = null;
}

// Both detail cards (native + zipkin) expose `closeSpanModal`; only one
// mounts at a time, so a single ref drives the shared Esc cascade.
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
</script>

<template>
  <div class="iq">
    <header class="iq-head">
      <h1>{{ t('Trace inspect') }}</h1>
      <p class="iq-sub">{{ t('Query any service across layers — pick it, type its name, or leave it blank.') }}</p>
    </header>

    <div class="iq-bar">
        <span class="iq-bar-l">{{ t('Source') }}</span>
        <div class="seg">
          <button :class="{ on: traceSource === 'native' }" @click="traceSource = 'native'">{{ t('Native') }}</button>
          <button :class="{ on: traceSource === 'zipkin' }" @click="traceSource = 'zipkin'">Zipkin</button>
        </div>
      </div>

      <div class="iq-top-strip">
        <div class="iq-form">
          <div class="iq-target">
            <div class="iq-target-h">
              <span>{{ t('Target') }} <small class="dim">{{ t('optional — blank queries all services') }}</small></span>
              <div v-if="!isZipkin" class="seg sm">
                <button :class="{ on: entityMode === 'pick' }" @click="entityMode = 'pick'">{{ t('Pick') }}</button>
                <button :class="{ on: entityMode === 'type' }" @click="entityMode = 'type'">{{ t('Type') }}</button>
              </div>
              <button v-if="!isZipkin && entityMode === 'pick'" class="iq-link" :disabled="!pickServiceId" @click="seedTypeFromPick">
                {{ t('→ edit as text') }}
              </button>
            </div>

            <!-- Zipkin entity — a raw service universe (no layer / no id).
                 Remote service + span are service-scoped autocompletes. -->
            <div class="iq-grid" v-if="isZipkin">
              <label class="cf">
                <span>{{ t('Service') }}</span>
                <TypeaheadSelect v-model="zipkinService" :aria-label="t('Service')" :options="zipkinServiceOptions" :placeholder="t('All services')" class="cf-tas" />
              </label>
              <label class="cf" :class="{ 'cf-disabled': !zipkinHasService }">
                <span>{{ t('Remote service') }} <small v-if="!zipkinHasService" class="dim">— {{ t('pick a service') }}</small></span>
                <TypeaheadSelect v-model="zipkinRemote" :aria-label="t('Remote service')" :options="zipkinRemoteOptions" :disabled="!zipkinHasService" :placeholder="zipkinHasService ? t('any') : t('select a service first')" class="cf-tas" />
              </label>
              <label class="cf" :class="{ 'cf-disabled': !zipkinHasService }">
                <span>{{ t('Span name') }} <small v-if="!zipkinHasService" class="dim">— {{ t('pick a service') }}</small></span>
                <TypeaheadSelect v-model="zipkinSpan" :aria-label="t('Span name')" :options="zipkinSpanOptions" :disabled="!zipkinHasService" :placeholder="zipkinHasService ? t('any') : t('select a service first')" class="cf-tas" />
              </label>
            </div>

            <div class="iq-grid" v-else-if="entityMode === 'pick'">
              <label class="cf">
                <span>{{ t('Layer') }}</span>
                <TypeaheadSelect v-model="pickLayer" :aria-label="t('Layer')" :options="layerOptions" :placeholder="t('Any layer')" class="cf-tas" />
              </label>
              <label class="cf">
                <span>{{ t('Service') }}</span>
                <TypeaheadSelect
                  v-model="pickServiceId" :aria-label="t('Service')" :options="serviceOptions" :disabled="!pickLayer || servicesLoading"
                  :placeholder="servicesLoading ? t('Reading…') : t('Any service')" class="cf-tas"
                />
              </label>
              <label class="cf">
                <span>{{ t('Instance') }}</span>
                <TypeaheadSelect v-model="instanceSel" :aria-label="t('Instance')" :options="instanceOptions" :disabled="!pickServiceId" :placeholder="t('All instances')" class="cf-tas" />
              </label>
              <label class="cf">
                <span>{{ t('Endpoint') }}</span>
                <TypeaheadSelect v-model="endpointSel" :aria-label="t('Endpoint')" :options="endpointOptions" :disabled="!pickServiceId" :placeholder="t('All endpoints')" class="cf-tas" />
              </label>
            </div>

            <div class="iq-grid" v-else>
              <label class="cf">
                <span>{{ t('Service name') }}</span>
                <input v-model="typeService" class="cf-input mono" type="text" :placeholder="t('e.g. agent::checkout')" />
              </label>
              <label class="cf cf-chk">
                <span>{{ t('Real') }}</span>
                <span class="iq-chk"><input v-model="typeReal" type="checkbox" /> <small class="dim">{{ t('off = virtual / peer') }}</small></span>
              </label>
              <label class="cf">
                <span>{{ t('Instance') }}</span>
                <input v-model="typeInstance" class="cf-input" type="text" :placeholder="t('optional')" />
              </label>
              <label class="cf">
                <span>{{ t('Endpoint') }}</span>
                <input v-model="typeEndpoint" class="cf-input" type="text" :placeholder="t('optional')" />
              </label>
            </div>
          </div>

          <div class="iq-conditions">
            <div class="iq-conditions-h">
              <span class="kicker iq-cond-kicker">{{ t('Traces') }}</span>
              <button v-if="resolved" class="iq-resolved-tog" @click="showResolved = !showResolved">
                {{ showResolved ? '▾' : '▸' }} {{ t('Resolved query') }}
                <span class="dim">{{ resolved.source }}{{ resolved.backend ? ` · ${resolved.backend}` : '' }}</span>
              </button>
              <button class="iq-run" :disabled="running" @click="runQuery">
                {{ running ? t('Running…') : t('Run query') }}
              </button>
            </div>
            <div class="iq-grid">
              <label v-if="!isZipkin" class="cf">
                <span>{{ t('Trace ID') }}</span>
                <input v-model="cond.traceId" class="cf-input mono" type="text" :placeholder="t('paste a trace id')" />
              </label>
              <label v-if="!isZipkin" class="cf">
                <span>{{ t('Status') }}</span>
                <select v-model="cond.traceState" class="cf-input">
                  <option value="ALL">{{ t('All') }}</option>
                  <option value="SUCCESS">{{ t('Success') }}</option>
                  <option value="ERROR">{{ t('Error') }}</option>
                </select>
              </label>
              <label v-if="!isZipkin" class="cf">
                <span>{{ t('Order') }}</span>
                <select v-model="cond.queryOrder" class="cf-input">
                  <option value="BY_START_TIME">{{ t('Newest') }}</option>
                  <option value="BY_DURATION">{{ t('Slowest') }}</option>
                </select>
              </label>
              <label class="cf">
                <span>{{ t('Duration (ms)') }}</span>
                <span class="cf-range">
                  <input v-model="cond.minDuration" class="cf-input cf-range-num" type="number" min="0" :placeholder="t('min')" />
                  <span class="cf-range-sep">–</span>
                  <input v-model="cond.maxDuration" class="cf-input cf-range-num" type="number" min="0" :placeholder="t('max')" />
                </span>
              </label>
              <label v-if="!isZipkin" class="cf cf-wide">
                <span>{{ t('Tags') }}</span>
                <TagInput
                  v-model="cond.tags"
                  kind="trace"
                  :window-minutes="cond.windowMinutes"
                  :placeholder="t('http.status_code=500, …')"
                  @commit="onTagCommit"
                />
              </label>
              <label v-else class="cf cf-wide">
                <span>{{ t('Annotation query') }}</span>
                <input v-model="cond.annotationQuery" class="cf-input mono" type="text" :placeholder="t('error or key=value, AND-joined')" />
              </label>
              <label class="cf iq-time" :class="{ 'cf-wide': isCustomRange }">
                <span>{{ t('Time') }}</span>
                <template v-if="isCustomRange">
                  <span class="cf-range">
                    <input v-model="customStart" type="datetime-local" class="cf-input cf-range-num" />
                    <span class="cf-range-sep">–</span>
                    <input v-model="customEnd" type="datetime-local" class="cf-input cf-range-num" />
                    <button class="iq-range-reset" type="button" :title="t('Back to presets')" @click="cond.windowMinutes = 30">×</button>
                  </span>
                </template>
                <select v-else v-model.number="cond.windowMinutes" class="cf-input">
                  <option v-for="w in WINDOWS" :key="w" :value="w">{{ w < 60 ? `${w}m` : `${w / 60}h` }}</option>
                  <option :value="CUSTOM_RANGE_SENTINEL">{{ t('Custom…') }}</option>
                </select>
              </label>
              <label class="cf">
                <span>{{ t('Limit') }}</span>
                <select v-model.number="cond.limit" class="cf-input">
                  <option v-for="l in LIMITS" :key="l" :value="l">{{ l }}</option>
                </select>
              </label>
            </div>
            <pre v-if="resolved && showResolved" class="iq-resolved-body">{{ JSON.stringify(resolved.condition, null, 2) }}</pre>
          </div>
        </div>

        <section class="iq-scatter sw-card">
          <header class="iq-scatter-head">
            <span class="kicker">{{ t('Distribution') }}</span>
            <span class="legend">
              <span class="lg ok" /> {{ t('ok') }}
              <span class="lg err" /> {{ t('err') }}
            </span>
          </header>
          <TraceDistribution
            :rows="rows"
            :max-duration="maxDuration"
            :selected-key="selectedRowKey"
            :highlight-keys="brushedKeys"
            @select="openRow"
            @brush="onScatterBrush"
          />
        </section>
      </div>

      <div v-if="showApiBanner" class="iq-api-banner">
        {{ t('This OAP serves traces via') }} <b>{{ t('Trace Query {label} API', { label: traceApiLabel }) }}</b>
        (<code>{{ native?.api }}</code>).
        <template v-if="isSegmentList">
          {{ t('Each row is a trace') }} <b>{{ t('segment') }}</b> — {{ t('click one to fetch its full trace.') }}
        </template>
        <template v-else>
          {{ t('Full traces are returned inline.') }}
        </template>
      </div>

      <div class="iq-result">
        <div v-if="!hasQueried" class="iq-empty">{{ t('Run a query — name a service or leave it blank.') }}</div>
        <div v-else-if="running && rows.length === 0" class="iq-empty">{{ t('Reading data…') }}</div>
        <div v-else-if="errorMsg" class="iq-err">{{ errorMsg }}</div>
        <div v-else-if="rows.length === 0" class="iq-empty">{{ t('No traces in this window.') }}</div>

        <article v-else-if="!selectedTraceId" class="iq-list-card sw-card">
          <header class="iq-list-head">
            <h4>{{ isSegmentList ? t('Segments') : t('Traces') }}</h4>
            <span class="hint">{{ displayRows.length }}<template v-if="brushedKeys.length"> / {{ rows.length }}</template> {{ isSegmentList ? t('segments') : t('traces') }}</span>
            <button v-if="brushedKeys.length" type="button" class="iq-brush-clear" @click="clearBrush">{{ t('clear') }}</button>
          </header>
          <TraceListPanel
            :rows="displayRows"
            :selected-key="selectedRowKey"
            :max-duration="maxDuration"
            @select="openRow"
          />
        </article>

        <section v-else class="iq-detail-split" :class="{ 'rail-collapsed': !railOpen }">
          <TraceListPanel
            foldable
            :rail-open="railOpen"
            :rows="displayRows"
            :selected-key="selectedRowKey"
            :max-duration="maxDuration"
            :title="isSegmentList ? t('Segments') : t('Traces')"
            :count-hint="displayRows.length"
            @select="openRow"
            @toggle-rail="railOpen = !railOpen"
          />
          <div class="iq-detail">
            <ZipkinTraceDetailCard
              v-if="isZipkin"
              ref="detailCard"
              :spans="zipkinSpans"
              :trace-id="selectedTraceId"
              :loading="detailLoading"
              @close="closeDetail"
              @update:modal-open="spanModalOpen = $event"
            />
            <template v-else>
              <div v-if="detailFetching && waterfallSpans.length === 0" class="iq-empty sm">{{ t('Reading trace…') }}</div>
              <div v-else-if="waterfallSpans.length === 0" class="iq-empty sm">{{ t('No spans (older than the detail window).') }}</div>
              <TraceDetailCard
                v-else
                ref="detailCard"
                :spans="waterfallSpans"
                :trace-id="selectedTraceId"
                :trace-ids="selectedTraceIds"
                :loading="detailFetching"
                @close="closeDetail"
                @change-trace-id="changeSelectedTraceId"
                @update:modal-open="spanModalOpen = $event"
              />
            </template>
          </div>
        </section>
      </div>
  </div>
</template>

<style scoped>
/* Fill the viewport below the topbar so the result area (and the list /
   detail inside it) flex to the available height instead of collapsing to
   content. The shell `<main>` grows with content rather than imposing a
   definite height, so a plain `height: 100%` would resolve to auto — the
   viewport-anchored min-height gives the flex column real height to share
   (52px ≈ the topbar row). */
.iq { display: flex; flex-direction: column; gap: 10px; min-height: calc(100vh - 52px); padding: 14px 16px; }
.iq-head h1 { font-size: 16px; margin: 0; }
.iq-sub { color: var(--sw-fg-3); font-size: 12px; margin: 2px 0 0; }
.iq-bar { display: flex; align-items: center; gap: 10px; }
.iq-bar-l { font-size: 11px; color: var(--sw-fg-3); font-weight: 500; }
.seg { display: inline-flex; border: 1px solid var(--sw-line-2); border-radius: 5px; overflow: hidden; }
.seg button { background: var(--sw-bg-2); color: var(--sw-fg-2); border: none; padding: 4px 14px; font: inherit; font-size: 12px; cursor: pointer; }
.seg.sm button { padding: 3px 10px; }
.seg button + button { border-left: 1px solid var(--sw-line-2); }
.seg button.on { background: var(--sw-accent); color: #fff; }
.iq-target { border: 1px solid var(--sw-line); border-radius: 6px; padding: 8px 10px; }
.iq-target-h { display: flex; align-items: center; gap: 12px; margin-bottom: 8px; font-size: 11px; color: var(--sw-fg-2); font-weight: 600; }
.iq-target-h .dim { color: var(--sw-fg-4); font-weight: 400; }
.iq-link { background: none; border: none; color: var(--sw-accent); font-size: 11px; cursor: pointer; padding: 0; margin-left: auto; }
.iq-link:disabled { color: var(--sw-fg-4); cursor: not-allowed; }
.iq-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px 10px; }
@media (max-width: 900px) { .iq-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 560px) { .iq-grid { grid-template-columns: 1fr; } }
.cf { display: flex; flex-direction: column; gap: 3px; font-size: 11px; color: var(--sw-fg-3); font-weight: 500; min-width: 0; }
.cf.cf-wide { grid-column: span 2; }
.cf.iq-time { grid-column-start: 1; }
.cf.iq-time.cf-wide { grid-column: 1 / span 2; }
.cf.cf-chk { justify-content: flex-end; }
.cf.cf-disabled > span { color: var(--sw-fg-3); opacity: 0.7; }
.cf small { font-weight: 400; font-size: 9.5px; margin-left: 4px; font-style: italic; }
.iq-chk { display: inline-flex; align-items: center; gap: 6px; height: 28px; }
.iq-chk .dim { color: var(--sw-fg-4); }
.cf-input {
  height: 28px; padding: 0 8px; background: var(--sw-bg-2); border: 1px solid var(--sw-line-2);
  border-radius: 4px; color: var(--sw-fg-0); font: inherit; font-size: 11px; width: 100%; box-sizing: border-box;
}
.cf-input.mono { font-family: var(--sw-mono); }
.cf-input:disabled { opacity: 0.5; cursor: not-allowed; }
.cf-input + .cf-tas { margin-top: 3px; }
.cf-tas { display: block; width: 100%; }
.cf-tas :deep(.tas__trigger) { width: 100%; max-width: none; min-width: 0; height: 28px; padding: 0 8px; font-size: 11px; background: var(--sw-bg-2); border-radius: 4px; }
.cf-range { display: flex; align-items: center; gap: 4px; }
.cf-range-num { flex: 1; min-width: 0; }
.cf-range-sep { color: var(--sw-fg-3); font-size: 12px; flex: 0 0 auto; }
.iq-conditions-h { display: flex; align-items: center; gap: 12px; }
.iq-cond-kicker { margin-right: auto; }
.iq-run { background: var(--sw-accent); color: #fff; border: none; border-radius: 4px; padding: 5px 18px; font: inherit; font-size: 12px; cursor: pointer; height: 28px; order: 2; }
.iq-run:disabled { opacity: 0.5; cursor: not-allowed; }
.iq-resolved-tog { background: none; border: none; color: var(--sw-fg-3); font-size: 11px; cursor: pointer; }
.iq-resolved-tog .dim { color: var(--sw-fg-4); margin-left: 6px; }
.iq-resolved-body { margin: 0; padding: 8px 12px; font-family: var(--sw-mono); font-size: 11px; color: var(--sw-fg-2); background: var(--sw-bg-0); overflow: auto; max-height: 160px; border: 1px solid var(--sw-line); border-radius: 5px; }

.iq-top-strip { display: grid; grid-template-columns: minmax(0, 1fr) minmax(240px, 360px); gap: 12px; align-items: start; }
@media (max-width: 1100px) { .iq-top-strip { grid-template-columns: 1fr; } }
.iq-form { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.iq-conditions { display: flex; flex-direction: column; gap: 10px; min-width: 0; }

.iq-scatter { padding: 6px 10px 8px; display: flex; flex-direction: column; min-height: 0; margin: 0; aspect-ratio: 1; }
.iq-brush-clear { margin-left: 8px; background: none; border: 1px solid var(--sw-line-2); color: var(--sw-fg-2); border-radius: 4px; padding: 1px 8px; font: inherit; font-size: 11px; cursor: pointer; }
.iq-brush-clear:hover { color: var(--sw-fg-0); border-color: var(--sw-fg-3); }
@media (max-width: 1100px) { .iq-scatter { aspect-ratio: auto; height: 320px; } }
.iq-scatter-head { display: flex; align-items: baseline; gap: 10px; margin-bottom: 2px; flex: 0 0 auto; }
.iq-scatter-head .legend { margin-left: auto; font-size: 10.5px; color: var(--sw-fg-3); display: inline-flex; gap: 10px; align-items: center; }
.iq-scatter-head .lg { display: inline-block; width: 7px; height: 7px; border-radius: 50%; margin-right: 3px; vertical-align: middle; }
.iq-scatter-head .lg.ok { background: var(--sw-accent); }
.iq-scatter-head .lg.err { background: var(--sw-err); }
.kicker { font-size: 10px; text-transform: uppercase; letter-spacing: 0.1em; color: var(--sw-accent); font-weight: 600; }
/* The scatter chart internals live in TraceDistribution.vue; this card
   only styles the head strip. The shared component fills the remaining
   card height via its own flex. */
.iq-scatter :deep(.scatter-wrap) { flex: 1; min-height: 0; }

/* API banner — same v1/v2 line the per-layer Traces tab renders. */
.iq-api-banner {
  padding: 7px 12px; border: 1px solid var(--sw-line); border-radius: 6px;
  background: var(--sw-bg-2); color: var(--sw-fg-2); font-size: 11px; line-height: 1.5;
}
.iq-api-banner code {
  font-family: var(--sw-mono); font-size: 10.5px; padding: 0 3px;
  border-radius: 3px; background: var(--sw-bg-3); color: var(--sw-accent);
}
.iq-api-banner b { color: var(--sw-fg-0); }

.iq-result { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.iq-result > .iq-list-card { flex: 1; }
.iq-empty, .iq-err { padding: 24px; text-align: center; color: var(--sw-fg-3); font-size: 12px; }
.iq-empty.sm { padding: 14px; }
.iq-err { color: var(--sw-err); }
.iq-list-card { padding: 0; display: flex; flex-direction: column; min-height: 0; max-height: calc(100vh - 80px); overflow: hidden; }
.iq-list-head { display: flex; align-items: baseline; gap: 8px; padding: 10px 14px; border-bottom: 1px solid var(--sw-line); flex: 0 0 auto; }
.iq-list-head h4 { margin: 0; font-size: 12px; font-weight: 600; color: var(--sw-fg-0); }
.iq-list-head .hint { margin-left: auto; font-size: 10.5px; color: var(--sw-fg-3); }
.iq-detail-split { display: grid; grid-template-columns: 320px 1fr; gap: 12px; align-items: start; }
.iq-detail-split.rail-collapsed { grid-template-columns: 64px 1fr; }
.iq-detail { overflow: auto; min-width: 0; }

/* Custom-range reset (× back to presets). */
.iq-range-reset {
  flex: 0 0 auto; height: 28px; width: 24px; padding: 0;
  background: transparent; border: 1px solid var(--sw-line-2); border-radius: 4px;
  color: var(--sw-fg-2); cursor: pointer; font-size: 13px; line-height: 1;
}
.iq-range-reset:hover { color: var(--sw-accent); border-color: var(--sw-accent); }
</style>
