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
  Trace inspect / Log inspect — cross-layer trace/log query power-tools
  (the `kind` prop picks which; two sidebar menus, one component).

  Layer-less by design: the entity is OPTIONAL. Name a service by PICKING
  it (a layer-filtered dropdown), TYPING it (service name + the real/
  normal flag, which the BFF encodes into the OAP id), or leave it blank
  to query every service in the window. One query → one result, rendered
  with the same waterfall the per-layer Traces tab uses; the resolved-
  query panel surfaces the exact condition the BFF ran.

  This pass implements Trace · native. Trace · zipkin and the Log kinds
  (raw / browser-error) land next on the same spine.
-->
<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { bffClient } from '@/api/client';
import type {
  ExploreEntity,
  ExploreRequest,
  ExploreResolved,
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

const props = defineProps<{ kind: 'trace' | 'log' }>();
const { t } = useI18n();
const { availableLayers } = useLayers();

const title = computed(() => (props.kind === 'trace' ? t('Trace inspect') : t('Log inspect')));

// ── source (zipkin / log sources land in the next increments) ─────────
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

const canRun = computed(() => props.kind === 'trace' && traceSource.value === 'native');

async function runQuery(): Promise<void> {
  running.value = true;
  hasQueried.value = true;
  errorMsg.value = null;
  selectedTraceId.value = null;
  embeddedSpans.value = null;
  const entity = currentEntity();
  const req: ExploreRequest = {
    kind: 'trace',
    traceSource: 'native',
    ...(entity ? { entity } : {}),
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
  <div class="iq">
    <header class="iq-head">
      <h1>{{ title }}</h1>
      <p class="iq-sub">{{ t('Query any service across layers — pick it, type its name, or leave it blank.') }}</p>
    </header>

    <div v-if="props.kind === 'log'" class="iq-coming">{{ t('Log inspect — coming in the next pass.') }}</div>

    <template v-else>
      <div class="iq-bar">
        <span class="iq-bar-l">{{ t('Source') }}</span>
        <div class="seg">
          <button :class="{ on: traceSource === 'native' }" @click="traceSource = 'native'">{{ t('Native') }}</button>
          <button class="muted" disabled :title="t('coming next')">Zipkin</button>
        </div>
      </div>

      <div class="iq-target">
        <div class="iq-target-h">
          <span>{{ t('Target') }} <small class="dim">{{ t('optional — blank queries all services') }}</small></span>
          <div class="seg sm">
            <button :class="{ on: entityMode === 'pick' }" @click="entityMode = 'pick'">{{ t('Pick') }}</button>
            <button :class="{ on: entityMode === 'type' }" @click="entityMode = 'type'">{{ t('Type') }}</button>
          </div>
          <button v-if="entityMode === 'pick'" class="iq-link" :disabled="!pickServiceId" @click="seedTypeFromPick">
            {{ t('→ edit as text') }}
          </button>
        </div>

        <div class="iq-grid" v-if="entityMode === 'pick'">
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
            <input v-model="endpointQuery" class="cf-input" type="text" :disabled="!pickServiceId" :placeholder="t('search…')" />
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

      <div class="iq-grid">
        <label class="cf">
          <span>{{ t('Trace ID') }}</span>
          <input v-model="cond.traceId" class="cf-input mono" type="text" :placeholder="t('paste a trace id')" />
        </label>
        <label class="cf">
          <span>{{ t('Status') }}</span>
          <select v-model="cond.traceState" class="cf-input">
            <option value="ALL">{{ t('All') }}</option>
            <option value="SUCCESS">{{ t('Success') }}</option>
            <option value="ERROR">{{ t('Error') }}</option>
          </select>
        </label>
        <label class="cf">
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
        <label class="cf cf-wide">
          <span>{{ t('Tags') }}</span>
          <input v-model="cond.tags" class="cf-input mono" type="text" :placeholder="t('http.status_code=500, …')" />
        </label>
        <label class="cf">
          <span>{{ t('Time') }}</span>
          <select v-model.number="cond.windowMinutes" class="cf-input">
            <option v-for="w in WINDOWS" :key="w" :value="w">{{ w < 60 ? `${w}m` : `${w / 60}h` }}</option>
          </select>
        </label>
        <label class="cf">
          <span>{{ t('Limit') }}</span>
          <select v-model.number="cond.limit" class="cf-input">
            <option v-for="l in LIMITS" :key="l" :value="l">{{ l }}</option>
          </select>
        </label>
      </div>

      <div class="iq-run-row">
        <button class="iq-run" :disabled="!canRun || running" @click="runQuery">
          {{ running ? t('Running…') : t('Run query') }}
        </button>
        <button v-if="resolved" class="iq-resolved-tog" @click="showResolved = !showResolved">
          {{ showResolved ? '▾' : '▸' }} {{ t('Resolved query') }}
          <span class="dim">{{ resolved.source }}{{ resolved.backend ? ` · ${resolved.backend}` : '' }}</span>
        </button>
      </div>
      <pre v-if="resolved && showResolved" class="iq-resolved-body">{{ JSON.stringify(resolved.condition, null, 2) }}</pre>

      <div class="iq-result">
        <div v-if="!hasQueried" class="iq-empty">{{ t('Run a query — name a service or leave it blank.') }}</div>
        <div v-else-if="errorMsg" class="iq-err">{{ errorMsg }}</div>
        <div v-else-if="rows.length === 0" class="iq-empty">{{ t('No traces in this window.') }}</div>
        <div v-else class="iq-split">
          <ul class="iq-list">
            <li
              v-for="(row, i) in rows" :key="row.key || i" class="iq-row"
              :class="{ on: selectedTraceId === (row.traceIds[0] ?? ''), err: row.isError }" @click="openRow(row)"
            >
              <span class="iq-flag" :class="{ err: row.isError }"></span>
              <span class="iq-ep">{{ row.endpointNames[0] || row.traceIds[0] || row.key }}</span>
              <span class="iq-dur">{{ fmtDur(row.duration) }}</span>
              <span class="iq-time">{{ fmtTime(row.start) }}</span>
            </li>
          </ul>
          <div class="iq-detail">
            <div v-if="!selectedTraceId" class="iq-empty sm">{{ t('Select a trace.') }}</div>
            <div v-else-if="detailFetching && waterfallSpans.length === 0" class="iq-empty sm">{{ t('Reading trace…') }}</div>
            <div v-else-if="waterfallSpans.length === 0" class="iq-empty sm">{{ t('No spans (older than the detail window).') }}</div>
            <NativeTraceWaterfall v-else :spans="waterfallSpans" :selected-span="selectedSpan" @select-span="selectedSpan = $event" />
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.iq { display: flex; flex-direction: column; gap: 10px; height: 100%; min-height: 0; padding: 14px 16px; }
.iq-head h1 { font-size: 16px; margin: 0; }
.iq-sub { color: var(--sw-fg-3); font-size: 12px; margin: 2px 0 0; }
.iq-coming { padding: 40px; text-align: center; color: var(--sw-fg-3); font-size: 13px; }
.iq-bar { display: flex; align-items: center; gap: 10px; }
.iq-bar-l { font-size: 11px; color: var(--sw-fg-3); font-weight: 500; }
.seg { display: inline-flex; border: 1px solid var(--sw-line-2); border-radius: 5px; overflow: hidden; }
.seg button { background: var(--sw-bg-2); color: var(--sw-fg-2); border: none; padding: 4px 14px; font: inherit; font-size: 12px; cursor: pointer; }
.seg.sm button { padding: 3px 10px; }
.seg button + button { border-left: 1px solid var(--sw-line-2); }
.seg button.on { background: var(--sw-accent); color: #fff; }
.seg button.muted { opacity: 0.45; cursor: not-allowed; }
.iq-target { border: 1px solid var(--sw-line); border-radius: 6px; padding: 8px 10px; }
.iq-target-h { display: flex; align-items: center; gap: 12px; margin-bottom: 8px; font-size: 11px; color: var(--sw-fg-2); font-weight: 600; }
.iq-target-h .dim { color: var(--sw-fg-4); font-weight: 400; }
.iq-link { background: none; border: none; color: var(--sw-accent); font-size: 11px; cursor: pointer; padding: 0; margin-left: auto; }
.iq-link:disabled { color: var(--sw-fg-4); cursor: not-allowed; }
.iq-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px 10px; }
@media (max-width: 900px) { .iq-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
.cf { display: flex; flex-direction: column; gap: 3px; font-size: 11px; color: var(--sw-fg-3); font-weight: 500; min-width: 0; }
.cf.cf-wide { grid-column: span 2; }
.cf.cf-chk { justify-content: flex-end; }
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
.iq-run-row { display: flex; align-items: center; gap: 12px; }
.iq-run { background: var(--sw-accent); color: #fff; border: none; border-radius: 4px; padding: 5px 18px; font: inherit; font-size: 12px; cursor: pointer; height: 28px; }
.iq-run:disabled { opacity: 0.5; cursor: not-allowed; }
.iq-resolved-tog { background: none; border: none; color: var(--sw-fg-3); font-size: 11px; cursor: pointer; }
.iq-resolved-tog .dim { color: var(--sw-fg-4); margin-left: 6px; }
.iq-resolved-body { margin: 0; padding: 8px 12px; font-family: var(--sw-mono); font-size: 11px; color: var(--sw-fg-2); background: var(--sw-bg-0); overflow: auto; max-height: 160px; border: 1px solid var(--sw-line); border-radius: 5px; }
.iq-result { flex: 1; min-height: 0; border: 1px solid var(--sw-line); border-radius: 6px; overflow: hidden; }
.iq-empty, .iq-err { padding: 24px; text-align: center; color: var(--sw-fg-3); font-size: 12px; }
.iq-empty.sm { padding: 14px; }
.iq-err { color: var(--sw-err); }
.iq-split { display: grid; grid-template-columns: minmax(280px, 360px) 1fr; height: 100%; min-height: 0; }
.iq-list { list-style: none; margin: 0; padding: 0; overflow: auto; border-right: 1px solid var(--sw-line); }
.iq-row { display: grid; grid-template-columns: 10px 1fr auto auto; gap: 8px; align-items: center; padding: 5px 10px; cursor: pointer; font-size: 12px; border-bottom: 1px solid var(--sw-line); }
.iq-row:hover { background: var(--sw-bg-2); }
.iq-row.on { background: var(--sw-bg-3); }
.iq-flag { width: 8px; height: 8px; border-radius: 50%; background: var(--sw-ok, #3a7); }
.iq-flag.err { background: var(--sw-err); }
.iq-ep { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.iq-dur { font-family: var(--sw-mono); font-size: 11px; color: var(--sw-fg-2); }
.iq-time { font-size: 11px; color: var(--sw-fg-3); }
.iq-detail { overflow: auto; min-width: 0; }
</style>
