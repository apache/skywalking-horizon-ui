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
  Explore — cross-layer trace/log query power-tool.

  Layer-less by design: the operator names an entity by PICKING it (a
  layer-filtered dropdown) or TYPING it (service name + the real/normal
  flag, which the BFF encodes into the OAP id). One query → one result,
  rendered with the same waterfall the per-layer Traces tab uses. The
  resolved-query panel surfaces the exact condition the BFF ran — the
  trace/log analog of Metrics-inspect showing the bare MQE.

  This pass implements Trace · native end to end. Trace · zipkin and the
  Log kinds (raw / browser-error) are wired into the same spine next.
-->
<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { bffClient } from '@/api/client';
import type {
  ExploreEntity,
  ExploreRequest,
  ExploreResolved,
  LayerDef,
  NativeSpan,
  NativeTraceListResponse,
  NativeTraceListRow,
  TraceQueryOrder,
  TraceQueryState,
} from '@/api/client';
import { useLayers } from '@/shell/useLayers';
import { useTraceDetail } from '@/layer/traces/useLayerTraces';
import NativeTraceWaterfall, { type WaterfallSpan } from '@/layer/traces/NativeTraceWaterfall.vue';
import TypeaheadSelect from '@/components/primitives/TypeaheadSelect.vue';

const { t } = useI18n();
const { layers } = useLayers();

// ── kind + source (zipkin / log land in the next increments) ──────────
type Kind = 'trace' | 'log';
type TraceSource = 'native' | 'zipkin';
const kind = ref<Kind>('trace');
const traceSource = ref<TraceSource>('native');

// ── entity: pick (layer-filtered) vs type (name + real flag) ──────────
type EntityMode = 'pick' | 'type';
const entityMode = ref<EntityMode>('pick');

// Layers that actually serve native traces.
const traceLayers = computed<LayerDef[]>(() =>
  layers.value.filter((l) => l.caps?.traces && (l.traces?.source ?? 'native') !== 'zipkin'),
);

// pick mode
const pickLayer = ref<string>('');
const pickServiceId = ref<string>('');
const pickInstanceId = ref<string>('');
const pickEndpointId = ref<string>('');
const services = ref<Array<{ id: string; name: string; normal: boolean | null }>>([]);
const instances = ref<Array<{ id: string; name: string }>>([]);
const endpoints = ref<Array<{ id: string; name: string }>>([]);
const endpointQuery = ref<string>('');
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
  const name = pickServiceName.value;
  if (!pickLayer.value || !name) {
    endpoints.value = [];
    return;
  }
  try {
    const res = await bffClient.layer.endpoints(pickLayer.value, name, endpointQuery.value.trim());
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
watch(endpointQuery, () => void loadEndpoints());

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

// type mode
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

// ── trace conditions ──────────────────────────────────────────────────
const cond = reactive({
  traceId: '',
  traceState: 'ALL' as TraceQueryState,
  queryOrder: 'BY_START_TIME' as TraceQueryOrder,
  minDuration: '' as string,
  maxDuration: '' as string,
  tags: '' as string,
  windowMinutes: 30,
  limit: 30,
});
const WINDOWS = [15, 30, 60, 180, 360, 720, 1440];
const LIMITS = [20, 30, 50, 100];

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

// ── run + result ──────────────────────────────────────────────────────
const running = ref(false);
const hasQueried = ref(false);
const errorMsg = ref<string | null>(null);
const native = ref<NativeTraceListResponse | null>(null);
const resolved = ref<ExploreResolved | null>(null);
const showResolved = ref(false);

const canRun = computed(() => kind.value === 'trace' && traceSource.value === 'native' && currentEntity() !== null);

async function runQuery(): Promise<void> {
  const entity = currentEntity();
  if (!entity) return;
  running.value = true;
  hasQueried.value = true;
  errorMsg.value = null;
  selectedTraceId.value = null;
  embeddedSpans.value = null;
  const req: ExploreRequest = {
    kind: 'trace',
    traceSource: 'native',
    entity,
    window: { windowMinutes: cond.windowMinutes },
    pageSize: cond.limit,
    traceId: cond.traceId.trim() || undefined,
    traceState: cond.traceState,
    queryOrder: cond.queryOrder,
    minTraceDuration: cond.minDuration ? Number(cond.minDuration) : undefined,
    maxTraceDuration: cond.maxDuration ? Number(cond.maxDuration) : undefined,
    tags: parseTags(cond.tags),
  };
  try {
    const res = await bffClient.explore.query(req);
    if (res.kind === 'trace' && res.traceSource === 'native') {
      native.value = res.native;
      resolved.value = res.resolved;
      if (!res.native.reachable) errorMsg.value = res.native.error ?? t('OAP unreachable');
    }
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : String(e);
    native.value = null;
  } finally {
    running.value = false;
  }
}

const rows = computed<NativeTraceListRow[]>(() => (hasQueried.value ? native.value?.traces ?? [] : []));

// ── detail (reuses the native waterfall + GET /api/trace/:id) ─────────
const selectedTraceId = ref<string | null>(null);
const embeddedSpans = ref<NativeSpan[] | null>(null);
const selectedSpan = ref<WaterfallSpan | null>(null);
const sourceRef = ref<'native' | 'zipkin'>('native');
const { nativeDetail, isFetching: detailFetching } = useTraceDetail(selectedTraceId, sourceRef);
const waterfallSpans = computed<NativeSpan[]>(() => embeddedSpans.value ?? nativeDetail.value?.spans ?? []);

function openRow(row: NativeTraceListRow): void {
  selectedSpan.value = null;
  selectedTraceId.value = row.traceIds[0] ?? null;
  embeddedSpans.value = row.spans ?? null;
}

function fmtDur(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms} ms`;
}
function fmtTime(start: string): string {
  const n = Number(start);
  return Number.isFinite(n) && n > 0 ? new Date(n).toLocaleTimeString() : start;
}
</script>

<template>
  <div class="ex">
    <header class="ex-head">
      <h1>{{ t('Explore') }}</h1>
      <p class="ex-sub">{{ t('Cross-layer trace and log query. Pick any service, or type its name.') }}</p>
    </header>

    <div class="ex-bar">
      <div class="ex-seg">
        <button :class="{ on: kind === 'trace' }" @click="kind = 'trace'">{{ t('Trace') }}</button>
        <button class="muted" disabled :title="t('coming next')">{{ t('Log') }}</button>
      </div>
      <div class="ex-seg" v-if="kind === 'trace'">
        <button :class="{ on: traceSource === 'native' }" @click="traceSource = 'native'">{{ t('Native') }}</button>
        <button class="muted" disabled :title="t('coming next')">Zipkin</button>
      </div>
    </div>

    <div class="ex-form">
      <div class="ex-seg sm">
        <button :class="{ on: entityMode === 'pick' }" @click="entityMode = 'pick'">{{ t('Pick') }}</button>
        <button :class="{ on: entityMode === 'type' }" @click="entityMode = 'type'">{{ t('Type') }}</button>
      </div>

      <!-- Pick: layer-filtered dropdowns -->
      <template v-if="entityMode === 'pick'">
        <label class="ex-f">
          <span>{{ t('Layer') }}</span>
          <TypeaheadSelect
            v-model="pickLayer"
            :aria-label="t('Layer')"
            :options="traceLayers.map((l) => ({ value: l.key, label: l.name || l.key }))"
            :placeholder="t('Select a layer')"
          />
        </label>
        <label class="ex-f">
          <span>{{ t('Service') }}</span>
          <TypeaheadSelect
            v-model="pickServiceId"
            :aria-label="t('Service')"
            :options="serviceOptions"
            :disabled="!pickLayer || servicesLoading"
            :placeholder="servicesLoading ? t('Reading…') : t('Select a service')"
          />
        </label>
        <label class="ex-f">
          <span>{{ t('Instance') }}</span>
          <TypeaheadSelect
            v-model="instanceSel"
            :aria-label="t('Instance')"
            :options="instanceOptions"
            :disabled="!pickServiceId"
            :placeholder="t('All instances')"
          />
        </label>
        <label class="ex-f cf-wide">
          <span>{{ t('Endpoint') }}</span>
          <input
            v-model="endpointQuery"
            class="ex-input"
            type="text"
            :disabled="!pickServiceId"
            :placeholder="t('Search endpoints…')"
          />
          <TypeaheadSelect
            v-model="endpointSel"
            :aria-label="t('Endpoint')"
            :options="endpointOptions"
            :disabled="!pickServiceId"
            :placeholder="t('All endpoints')"
          />
        </label>
        <button class="ex-link" :disabled="!pickServiceId" @click="seedTypeFromPick">{{ t('→ edit as text') }}</button>
      </template>

      <!-- Type: name + real flag (no layer) -->
      <template v-else>
        <label class="ex-f">
          <span>{{ t('Service name') }}</span>
          <input v-model="typeService" class="ex-input" type="text" :placeholder="t('e.g. agent::checkout')" />
        </label>
        <label class="ex-f chk">
          <input v-model="typeReal" type="checkbox" />
          <span>{{ t('real') }}</span>
          <small class="dim">{{ t('agent-reported (off = virtual/peer)') }}</small>
        </label>
        <label class="ex-f">
          <span>{{ t('Instance') }}</span>
          <input v-model="typeInstance" class="ex-input" type="text" :placeholder="t('optional')" />
        </label>
        <label class="ex-f">
          <span>{{ t('Endpoint') }}</span>
          <input v-model="typeEndpoint" class="ex-input" type="text" :placeholder="t('optional')" />
        </label>
      </template>
    </div>

    <div class="ex-form">
      <label class="ex-f">
        <span>{{ t('Trace ID') }}</span>
        <input v-model="cond.traceId" class="ex-input mono" type="text" :placeholder="t('paste a trace id')" />
      </label>
      <label class="ex-f">
        <span>{{ t('Status') }}</span>
        <select v-model="cond.traceState" class="ex-input">
          <option value="ALL">{{ t('All') }}</option>
          <option value="SUCCESS">{{ t('Success') }}</option>
          <option value="ERROR">{{ t('Error') }}</option>
        </select>
      </label>
      <label class="ex-f">
        <span>{{ t('Order') }}</span>
        <select v-model="cond.queryOrder" class="ex-input">
          <option value="BY_START_TIME">{{ t('Newest') }}</option>
          <option value="BY_DURATION">{{ t('Slowest') }}</option>
        </select>
      </label>
      <label class="ex-f sm">
        <span>{{ t('Duration (ms)') }}</span>
        <span class="ex-dur">
          <input v-model="cond.minDuration" class="ex-input" type="number" min="0" :placeholder="t('min')" />
          <input v-model="cond.maxDuration" class="ex-input" type="number" min="0" :placeholder="t('max')" />
        </span>
      </label>
      <label class="ex-f cf-wide">
        <span>{{ t('Tags') }}</span>
        <input v-model="cond.tags" class="ex-input mono" type="text" :placeholder="t('http.status_code=500, …')" />
      </label>
      <label class="ex-f">
        <span>{{ t('Time') }}</span>
        <select v-model.number="cond.windowMinutes" class="ex-input">
          <option v-for="w in WINDOWS" :key="w" :value="w">{{ w < 60 ? `${w}m` : `${w / 60}h` }}</option>
        </select>
      </label>
      <label class="ex-f">
        <span>{{ t('Limit') }}</span>
        <select v-model.number="cond.limit" class="ex-input">
          <option v-for="l in LIMITS" :key="l" :value="l">{{ l }}</option>
        </select>
      </label>
      <button class="ex-run" :disabled="!canRun || running" @click="runQuery">
        {{ running ? t('Running…') : t('Run query') }}
      </button>
    </div>

    <div v-if="resolved" class="ex-resolved">
      <button class="ex-resolved-tog" @click="showResolved = !showResolved">
        {{ showResolved ? '▾' : '▸' }} {{ t('Resolved query') }}
        <span class="dim">{{ resolved.source }}{{ resolved.backend ? ` · ${resolved.backend}` : '' }}</span>
      </button>
      <pre v-if="showResolved" class="ex-resolved-body">{{ JSON.stringify(resolved.condition, null, 2) }}</pre>
    </div>

    <div class="ex-result">
      <div v-if="!hasQueried" class="ex-empty">{{ t('Pick or type an entity, then Run query.') }}</div>
      <div v-else-if="errorMsg" class="ex-err">{{ errorMsg }}</div>
      <div v-else-if="rows.length === 0" class="ex-empty">{{ t('No traces in this window.') }}</div>
      <div v-else class="ex-split">
        <ul class="ex-list">
          <li
            v-for="(row, i) in rows"
            :key="row.key || i"
            class="ex-row"
            :class="{ on: selectedTraceId === (row.traceIds[0] ?? ''), err: row.isError }"
            @click="openRow(row)"
          >
            <span class="ex-flag" :class="{ err: row.isError }"></span>
            <span class="ex-ep">{{ row.endpointNames[0] || row.traceIds[0] || row.key }}</span>
            <span class="ex-dur-v">{{ fmtDur(row.duration) }}</span>
            <span class="ex-time">{{ fmtTime(row.start) }}</span>
          </li>
        </ul>
        <div class="ex-detail">
          <div v-if="!selectedTraceId" class="ex-empty sm">{{ t('Select a trace.') }}</div>
          <div v-else-if="detailFetching && waterfallSpans.length === 0" class="ex-empty sm">{{ t('Reading trace…') }}</div>
          <div v-else-if="waterfallSpans.length === 0" class="ex-empty sm">{{ t('No spans (older than the detail window).') }}</div>
          <NativeTraceWaterfall
            v-else
            :spans="waterfallSpans"
            :selected-span="selectedSpan"
            @select-span="selectedSpan = $event"
          />
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ex { display: flex; flex-direction: column; gap: 10px; height: 100%; min-height: 0; padding: 14px 16px; }
.ex-head h1 { font-size: 16px; margin: 0; }
.ex-sub { color: var(--sw-fg-3); font-size: 12px; margin: 2px 0 0; }
.ex-bar { display: flex; gap: 12px; align-items: center; }
.ex-seg { display: inline-flex; border: 1px solid var(--sw-line-2); border-radius: 5px; overflow: hidden; }
.ex-seg.sm button { padding: 3px 10px; }
.ex-seg button {
  background: var(--sw-bg-2); color: var(--sw-fg-2); border: none; padding: 4px 14px;
  font: inherit; font-size: 12px; cursor: pointer;
}
.ex-seg button + button { border-left: 1px solid var(--sw-line-2); }
.ex-seg button.on { background: var(--sw-accent); color: #fff; }
.ex-seg button.muted { opacity: 0.45; cursor: not-allowed; }
.ex-form { display: flex; flex-wrap: wrap; gap: 10px 14px; align-items: flex-end; }
.ex-f { display: flex; flex-direction: column; gap: 3px; font-size: 11px; color: var(--sw-fg-3); }
.ex-f.cf-wide { min-width: 240px; flex: 1 1 240px; }
.ex-f.chk { flex-direction: row; align-items: center; gap: 6px; padding-bottom: 4px; }
.ex-f.chk .dim { color: var(--sw-fg-4); }
.ex-input {
  background: var(--sw-bg-2); color: var(--sw-fg-1); border: 1px solid var(--sw-line-2);
  border-radius: 4px; padding: 3px 8px; font: inherit; font-size: 12px; min-width: 140px;
}
.ex-input.mono { font-family: var(--sw-mono); }
.ex-dur { display: inline-flex; gap: 6px; }
.ex-dur .ex-input { min-width: 70px; width: 80px; }
.ex-link { background: none; border: none; color: var(--sw-accent); font-size: 11px; cursor: pointer; padding: 0 0 4px; }
.ex-link:disabled { color: var(--sw-fg-4); cursor: not-allowed; }
.ex-run {
  background: var(--sw-accent); color: #fff; border: none; border-radius: 4px;
  padding: 5px 16px; font: inherit; font-size: 12px; cursor: pointer; height: 28px;
}
.ex-run:disabled { opacity: 0.5; cursor: not-allowed; }
.ex-resolved { border: 1px solid var(--sw-line); border-radius: 5px; }
.ex-resolved-tog {
  width: 100%; text-align: left; background: var(--sw-bg-1); color: var(--sw-fg-2);
  border: none; padding: 5px 10px; font: inherit; font-size: 11px; cursor: pointer;
}
.ex-resolved-tog .dim { color: var(--sw-fg-4); margin-left: 8px; }
.ex-resolved-body {
  margin: 0; padding: 8px 12px; font-family: var(--sw-mono); font-size: 11px;
  color: var(--sw-fg-2); background: var(--sw-bg-0); overflow: auto; max-height: 180px;
  border-top: 1px solid var(--sw-line);
}
.ex-result { flex: 1; min-height: 0; border: 1px solid var(--sw-line); border-radius: 5px; overflow: hidden; }
.ex-empty, .ex-err { padding: 24px; text-align: center; color: var(--sw-fg-3); font-size: 12px; }
.ex-empty.sm { padding: 14px; }
.ex-err { color: var(--sw-err); }
.ex-split { display: grid; grid-template-columns: minmax(280px, 360px) 1fr; height: 100%; min-height: 0; }
.ex-list { list-style: none; margin: 0; padding: 0; overflow: auto; border-right: 1px solid var(--sw-line); }
.ex-row {
  display: grid; grid-template-columns: 10px 1fr auto auto; gap: 8px; align-items: center;
  padding: 5px 10px; cursor: pointer; font-size: 12px; border-bottom: 1px solid var(--sw-line);
}
.ex-row:hover { background: var(--sw-bg-2); }
.ex-row.on { background: var(--sw-bg-3); }
.ex-flag { width: 8px; height: 8px; border-radius: 50%; background: var(--sw-ok, #3a7); }
.ex-flag.err { background: var(--sw-err); }
.ex-ep { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ex-dur-v { font-family: var(--sw-mono); font-size: 11px; color: var(--sw-fg-2); }
.ex-time { font-size: 11px; color: var(--sw-fg-3); }
.ex-detail { overflow: auto; min-width: 0; }
</style>
