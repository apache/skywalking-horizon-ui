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
  Log inspect — cross-layer raw-log query power-tool. The Log sibling of
  ExploreView (Trace inspect): same dark-dense spine, same OPTIONAL
  entity (pick a layer-filtered service, type its name + the real flag,
  or leave it blank to query every service). One query → one full-width
  log stream, rendered with the shared LogStreamPanel; clicking a row
  opens the shared LogDetailPopout with the full payload. The
  resolved-query panel surfaces the exact condition the BFF ran.

  Two sources: Log · raw (queryLogs) and Log · browser (BROWSER-layer JS
  errors). The Browser source swaps the entity to a browser SERVICE picker
  and the conditions to Category + Time + Limit, renders an error list, and
  the row-click popout adds the source-map de-obfuscation control (the same
  resolve flow the per-layer Browser Logs tab uses). The next increment adds
  the k8s pod-logs source — its toggle is present but disabled.
-->
<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { bffClient } from '@/api/client';
import type {
  BrowserErrorCategory,
  BrowserErrorRow,
  BrowserErrorsResponse,
  ExploreEntity,
  ExploreRequest,
  ExploreResolved,
  ExploreWindow,
  LogRow,
  LogsResponse,
  SourceMapDescriptor,
} from '@/api/client';
import { useLayers } from '@/shell/useLayers';
import { useTracePopout } from '@/layer/traces/useTracePopout';
import TypeaheadSelect from '@/components/primitives/TypeaheadSelect.vue';
import LogStreamPanel from '@/render/widgets/LogStreamPanel.vue';
import LogDetailPopout from '@/render/widgets/LogDetailPopout.vue';
import BrowserErrorPopout from '@/render/widgets/BrowserErrorPopout.vue';
import { logRowKey } from '@/utils/logRow';

const { t } = useI18n();
const { availableLayers } = useLayers();
const { openTrace } = useTracePopout();

// ── source. `raw` = queryLogs (any service across layers); `browser` =
// BROWSER-layer JS errors. The k8s pod-logs source lands next (disabled). ─
type LogSource = 'raw' | 'browser';
const logSource = ref<LogSource>('raw');

// ── browser entity — a BROWSER-layer service. Reuses the Pick metadata
// feed (bffClient.layer.services) pinned to BROWSER; no instance/endpoint
// (browser errors scope by version/page, which this view doesn't surface). ─
const BROWSER_LAYER = 'BROWSER';
const browserServiceId = ref<string>('');
const browserServices = ref<Array<{ id: string; name: string; normal: boolean | null }>>([]);
const browserServicesLoading = ref(false);
const browserServicesReachable = ref(true);

async function loadBrowserServices(): Promise<void> {
  browserServicesLoading.value = true;
  try {
    const res = await bffClient.layer.services(BROWSER_LAYER);
    browserServicesReachable.value = res.reachable;
    browserServices.value = res.reachable ? res.services : [];
  } catch {
    browserServicesReachable.value = false;
    browserServices.value = [];
  } finally {
    browserServicesLoading.value = false;
  }
}
const browserServiceOptions = computed(() =>
  browserServices.value.map((s) => ({ value: s.id, label: s.name })),
);
// Lazy-load the BROWSER catalog the first time the operator opens that
// source — the BROWSER layer may not exist on every deployment.
watch(logSource, (src) => {
  if (src === 'browser' && browserServices.value.length === 0 && !browserServicesLoading.value) {
    void loadBrowserServices();
  }
});

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
  const name = pickServiceName.value;
  if (!pickLayer.value || !name) {
    endpoints.value = [];
    return;
  }
  try {
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

// ── log conditions ────────────────────────────────────────────────────
const cond = reactive({
  keywords: '' as string,
  tags: '' as string,
  traceId: '' as string,
  windowMinutes: 30,
  limit: 50,
});
const WINDOWS = [15, 30, 60, 180, 360, 720, 1440];
const LIMITS = [20, 50, 100, 200];

// ── browser condition: error category (ALL = no filter; the rest mirror
// OAP's ErrorCategory enum verbatim). Time + Limit are shared with raw. ─
const BROWSER_CATEGORIES: BrowserErrorCategory[] = ['ALL', 'AJAX', 'RESOURCE', 'VUE', 'PROMISE', 'JS', 'UNKNOWN'];
const browserCategory = ref<BrowserErrorCategory>('ALL');

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

/** Free-text keywords → OAP's content-keyword list. Split on whitespace
 *  and commas; each token is AND-joined server-side. */
function parseKeywords(s: string): string[] {
  return s
    .split(/[\s,]+/)
    .map((p) => p.trim())
    .filter(Boolean);
}
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
const logsResp = ref<LogsResponse | null>(null);
const browserResp = ref<BrowserErrorsResponse | null>(null);
const resolved = ref<ExploreResolved | null>(null);
const showResolved = ref(false);

const canRun = computed(() => {
  if (logSource.value === 'browser') return !!browserServiceId.value;
  return true;
});

/** Explicit epoch-ms bounds in Custom mode (datetime-local strings are
 *  browser-local; `Date.parse` reads them as local), else rolling. */
function resolveWindow(): ExploreWindow {
  if (isCustomRange.value) {
    if (customStart.value && customEnd.value) {
      const startMs = Date.parse(customStart.value);
      const endMs = Date.parse(customEnd.value);
      if (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs) {
        return { startMs, endMs };
      }
    }
    return { windowMinutes: 30 };
  }
  return { windowMinutes: cond.windowMinutes };
}

function buildRequest(): ExploreRequest {
  if (logSource.value === 'browser') {
    // Pick forwards a pre-resolved BROWSER service id; no instance/endpoint.
    return {
      kind: 'log',
      logSource: 'browser',
      entity: { mode: 'pick', serviceId: browserServiceId.value },
      window: resolveWindow(),
      pageSize: cond.limit,
      ...(browserCategory.value !== 'ALL' ? { category: browserCategory.value } : {}),
    };
  }
  const entity = currentEntity();
  const keywords = parseKeywords(cond.keywords);
  const tags = parseTags(cond.tags);
  return {
    kind: 'log',
    logSource: 'raw',
    ...(entity ? { entity } : {}),
    window: resolveWindow(),
    pageSize: cond.limit,
    ...(keywords.length > 0 ? { keywordsOfContent: keywords } : {}),
    ...(tags.length > 0 ? { tags } : {}),
    ...(cond.traceId.trim() ? { relatedTraceId: cond.traceId.trim() } : {}),
  };
}

async function runQuery(): Promise<void> {
  if (!canRun.value) return;
  running.value = true;
  hasQueried.value = true;
  errorMsg.value = null;
  closeDetail();
  // Cascade-clear: drop the prior result before the new query lands so
  // operators never read stale rows as the new state.
  logsResp.value = null;
  browserResp.value = null;
  const req = buildRequest();
  try {
    const res = await bffClient.explore.query(req);
    if (res.kind === 'log' && res.logSource === 'raw') {
      logsResp.value = res.logs;
      resolved.value = res.resolved;
      if (!res.logs.reachable) errorMsg.value = res.logs.error ?? t('OAP unreachable');
    } else if (res.kind === 'log' && res.logSource === 'browser') {
      browserResp.value = res.browser;
      resolved.value = res.resolved;
      if (!res.browser.reachable) errorMsg.value = res.browser.error ?? t('OAP unreachable');
    }
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : String(e);
    logsResp.value = null;
    browserResp.value = null;
  } finally {
    running.value = false;
  }
}

const rows = computed<LogRow[]>(() => (hasQueried.value ? logsResp.value?.logs ?? [] : []));
const browserRows = computed<BrowserErrorRow[]>(() =>
  hasQueried.value && logSource.value === 'browser' ? browserResp.value?.logs ?? [] : [],
);

// ── detail — clicking a row opens the shared full-payload popout. The
// stream stays full-width; the popout owns its own Escape / close +
// format-aware pretty-print + copy + tag table.
const selectedKey = ref<string | null>(null);
const selectedRow = ref<LogRow | null>(null);

// ── browser detail — a BrowserErrorRow row-click opens the browser-error
// popout (raw stack + source-map de-obfuscation). One open at a time. ──
const selectedBrowserRow = ref<BrowserErrorRow | null>(null);

function openRow(payload: { row: LogRow; key: string }): void {
  selectedKey.value = payload.key;
  selectedRow.value = payload.row;
}
function openBrowserRow(row: BrowserErrorRow): void {
  selectedBrowserRow.value = row;
}
function closeDetail(): void {
  selectedKey.value = null;
  selectedRow.value = null;
  selectedBrowserRow.value = null;
}
function jumpToTrace(traceId: string, ts: number): void {
  openTrace(traceId, ts);
}

// Drop the selection across result changes — a row that's no longer in
// the new result closes the popout.
watch(rows, (next) => {
  if (selectedKey.value == null) return;
  const stillThere = next.some((r, idx) => logRowKey(r, idx) === selectedKey.value);
  if (!stillThere) closeDetail();
});
watch(browserRows, () => {
  if (selectedBrowserRow.value) selectedBrowserRow.value = null;
});

// ── source-map cache — loaded once for the browser popout's resolve
// control. The popout owns the per-row resolve; the host owns the list. ─
const sourceMaps = ref<SourceMapDescriptor[]>([]);
async function loadSourceMaps(): Promise<void> {
  try {
    const res = await bffClient.browserErrors.listSourceMaps();
    sourceMaps.value = res.enabled ? res.maps : [];
  } catch {
    sourceMaps.value = [];
  }
}
onMounted(loadSourceMaps);

// ── presentation helpers (browser list rows) ──────────────────────────
const CATEGORY_COLOR: Record<string, string> = {
  js: 'var(--sw-err)',
  promise: 'var(--sw-warn)',
  vue: 'var(--sw-info)',
  ajax: 'var(--sw-accent-2)',
  resource: 'var(--sw-cyan)',
  unknown: 'var(--sw-fg-3)',
};
function catColor(r: BrowserErrorRow): string {
  return CATEGORY_COLOR[(r.category ?? '').toLowerCase()] ?? 'var(--sw-fg-3)';
}
function fmtRowTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function fmtRowDate(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function rowLoc(r: BrowserErrorRow): string {
  if (!r.line) return '';
  return `${r.line}:${r.col ?? 0}`;
}
function browserRowKey(r: BrowserErrorRow, idx: number): string {
  return `${r.time}-${r.category}-${idx}`;
}

// Cascade-clear on source switch: drop the prior result + resolved-query
// echo so the new source starts on its own "run a query" empty state rather
// than the other source's stale rows / wrong empty message.
watch(logSource, () => {
  hasQueried.value = false;
  errorMsg.value = null;
  logsResp.value = null;
  browserResp.value = null;
  resolved.value = null;
  closeDetail();
});
</script>

<template>
  <div class="iq">
    <header class="iq-head">
      <h1>{{ t('Log inspect') }}</h1>
      <p class="iq-sub">{{ t('Query any service across layers — pick it, type its name, or leave it blank.') }}</p>
    </header>

    <div class="iq-bar">
      <span class="iq-bar-l">{{ t('Source') }}</span>
      <div class="seg">
        <button :class="{ on: logSource === 'raw' }" @click="logSource = 'raw'">{{ t('Raw') }}</button>
        <button :class="{ on: logSource === 'browser' }" @click="logSource = 'browser'">{{ t('Browser') }}</button>
        <button disabled :title="t('coming next')">{{ t('Pod logs') }}</button>
      </div>
    </div>

    <!-- Logs have no distribution square — the form spans the full width
         (a 3-column condition grid reads well across it). -->
    <div class="iq-form">
      <!-- Browser source: a single BROWSER-layer service picker (required —
           browser errors always scope by service). -->
      <div v-if="logSource === 'browser'" class="iq-target">
        <div class="iq-target-h">
          <span>{{ t('Browser app') }} <small class="dim">{{ t('required — pick a BROWSER service') }}</small></span>
        </div>
        <div class="iq-grid">
          <label class="cf cf-wide">
            <span>{{ t('Service') }}</span>
            <TypeaheadSelect
              v-model="browserServiceId" :aria-label="t('Service')" :options="browserServiceOptions"
              :disabled="browserServicesLoading"
              :placeholder="browserServicesLoading ? t('Reading…') : (browserServicesReachable ? t('Pick a browser service') : t('No BROWSER layer'))"
              class="cf-tas"
            />
          </label>
        </div>
      </div>

      <div v-else class="iq-target">
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
            <span class="kicker iq-cond-kicker">{{ logSource === 'browser' ? t('Browser errors') : 'Logs' }}</span>
            <button v-if="resolved" class="iq-resolved-tog" @click="showResolved = !showResolved">
              {{ showResolved ? '▾' : '▸' }} {{ t('Resolved query') }}
              <span class="dim">{{ resolved.source }}</span>
            </button>
            <button class="iq-run" :disabled="!canRun || running" @click="runQuery">
              {{ running ? t('Running…') : t('Run query') }}
            </button>
          </div>
          <div class="iq-grid">
            <template v-if="logSource === 'browser'">
              <label class="cf cf-wide">
                <span>{{ t('Category') }}</span>
                <select v-model="browserCategory" class="cf-input">
                  <option v-for="c in BROWSER_CATEGORIES" :key="c" :value="c">{{ c === 'ALL' ? t('All categories') : c }}</option>
                </select>
              </label>
            </template>
            <template v-else>
              <label class="cf cf-wide">
                <span>{{ t('Keywords') }}</span>
                <input v-model="cond.keywords" class="cf-input mono" type="text" :placeholder="t('space- or comma-separated, AND-joined')" />
              </label>
              <label class="cf cf-wide">
                <span>{{ t('Tags') }}</span>
                <input v-model="cond.tags" class="cf-input mono" type="text" :placeholder="t('level=ERROR, …')" />
              </label>
              <label class="cf cf-wide">
                <span>{{ t('Trace ID') }}</span>
                <input v-model="cond.traceId" class="cf-input mono" type="text" :placeholder="t('paste a trace id')" />
              </label>
            </template>
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

    <!-- Browser source: a dense error list in the same dark vocabulary as
         the per-layer Browser Logs stream; row-click opens the popout. -->
    <div v-if="logSource === 'browser'" class="iq-result">
      <div v-if="!hasQueried" class="iq-empty">{{ t('Pick a browser service and run a query.') }}</div>
      <div v-else-if="running && browserRows.length === 0" class="iq-empty">{{ t('Reading data…') }}</div>
      <div v-else-if="errorMsg" class="iq-err">{{ errorMsg }}</div>
      <div v-else-if="browserRows.length === 0" class="iq-empty">{{ t('No browser logs in this window.') }}</div>

      <article v-else class="iq-list-card sw-card">
        <header class="iq-list-head">
          <h4>{{ t('Browser errors') }}</h4>
          <span class="hint">{{ browserRows.length }} {{ t('errors') }}</span>
        </header>
        <div class="iq-stream-scroll">
          <div class="be-stream">
            <div
              v-for="(r, idx) in browserRows"
              :key="browserRowKey(r, idx)"
              class="be-row"
              :class="{ 'is-open': selectedBrowserRow === r }"
              :style="{ boxShadow: `inset 3px 0 0 ${catColor(r)}` }"
              @click="openBrowserRow(r)"
            >
              <span class="be-time mono">{{ fmtRowTime(r.time) }}</span>
              <span class="be-date mono dim">{{ fmtRowDate(r.time) }}</span>
              <span class="be-cat" :style="{ color: catColor(r) }">{{ r.category }}</span>
              <span class="be-page mono dim" :title="r.pagePath">{{ r.pagePath || '—' }}</span>
              <span class="be-ver mono dim" :title="r.serviceVersion">{{ r.serviceVersion || '—' }}</span>
              <span class="be-msg mono">
                <span v-if="rowLoc(r)" class="be-loc">{{ rowLoc(r) }}</span>
                <span class="be-msg-body">{{ r.message || t('(no message)') }}</span>
              </span>
            </div>
          </div>
        </div>
      </article>
    </div>

    <div v-else class="iq-result">
      <div v-if="!hasQueried" class="iq-empty">{{ t('Run a query — name a service or leave it blank.') }}</div>
      <div v-else-if="running && rows.length === 0" class="iq-empty">{{ t('Reading data…') }}</div>
      <div v-else-if="errorMsg" class="iq-err">{{ errorMsg }}</div>
      <div v-else-if="rows.length === 0" class="iq-empty">{{ t('No logs in this window.') }}</div>

      <article v-else class="iq-list-card sw-card">
        <header class="iq-list-head">
          <h4>Logs</h4>
          <span class="hint">{{ rows.length }} {{ t('logs') }}</span>
        </header>
        <div class="iq-stream-scroll">
          <LogStreamPanel :rows="rows" :selected-key="selectedKey" @select="openRow" @jump-trace="jumpToTrace($event.traceId, $event.ts)" />
        </div>
      </article>
    </div>

    <!-- Row click → shared full-payload popout (format-aware pretty-print
         + copy + tag table + trace link). Escape / × closes it. -->
    <LogDetailPopout :row="selectedRow" @close="closeDetail" @jump-trace="jumpToTrace($event.traceId, $event.ts)" />
    <!-- Browser row → browser-error popout (raw stack + source-map resolve). -->
    <BrowserErrorPopout :row="selectedBrowserRow" :maps="sourceMaps" @close="closeDetail" />
  </div>
</template>

<style scoped>
/* Mirrors ExploreView's `.iq-*` vocab — see the comment there for the
   viewport-anchored min-height rationale. */
.iq { display: flex; flex-direction: column; gap: 10px; min-height: calc(100vh - 52px); padding: 14px 16px; }
.iq-head h1 { font-size: 16px; margin: 0; }
.iq-sub { color: var(--sw-fg-3); font-size: 12px; margin: 2px 0 0; }
.iq-bar { display: flex; align-items: center; gap: 10px; }
.iq-bar-l { font-size: 11px; color: var(--sw-fg-3); font-weight: 500; }
.seg { display: inline-flex; border: 1px solid var(--sw-line-2); border-radius: 5px; overflow: hidden; }
.seg button { background: var(--sw-bg-2); color: var(--sw-fg-2); border: none; padding: 4px 14px; font: inherit; font-size: 12px; cursor: pointer; }
.seg button:disabled { opacity: 0.45; cursor: not-allowed; }
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
.cf small { font-weight: 400; font-size: 9.5px; margin-left: 4px; font-style: italic; }
.iq-chk { display: inline-flex; align-items: center; gap: 6px; height: 28px; }
.iq-chk .dim { color: var(--sw-fg-4); }
.cf-input {
  height: 28px; padding: 0 8px; background: var(--sw-bg-2); border: 1px solid var(--sw-line-2);
  border-radius: 4px; color: var(--sw-fg-0); font: inherit; font-size: 11px; width: 100%; box-sizing: border-box;
}
.cf-input.mono { font-family: var(--sw-mono); }
.cf-input:disabled { opacity: 0.5; cursor: not-allowed; }
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
.kicker { font-size: 10px; text-transform: uppercase; letter-spacing: 0.1em; color: var(--sw-accent); font-weight: 600; }

.iq-form { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.iq-conditions { display: flex; flex-direction: column; gap: 10px; min-width: 0; }

.iq-result { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.iq-result > .iq-list-card { flex: 1; }
.iq-empty, .iq-err { padding: 24px; text-align: center; color: var(--sw-fg-3); font-size: 12px; }
.iq-err { color: var(--sw-err); }
.iq-list-card { padding: 0; display: flex; flex-direction: column; min-height: 0; max-height: calc(100vh - 80px); overflow: hidden; }
.iq-list-head { display: flex; align-items: baseline; gap: 8px; padding: 10px 14px; border-bottom: 1px solid var(--sw-line); flex: 0 0 auto; }
.iq-list-head h4 { margin: 0; font-size: 12px; font-weight: 600; color: var(--sw-fg-0); }
.iq-list-head .hint { margin-left: auto; font-size: 10.5px; color: var(--sw-fg-3); }
.iq-stream-scroll { flex: 1; overflow-y: auto; min-height: 0; }
.mono { font-family: var(--sw-mono); }
.dim { color: var(--sw-fg-3); }

/* Browser-error list rows — same dense grid vocabulary as the per-layer
   Browser Logs stream so the two read identically. */
.be-stream { font-size: 11.5px; }
.be-row {
  display: grid;
  grid-template-columns: 76px 40px 74px 150px 90px 1fr;
  gap: 10px;
  align-items: center;
  padding: 4px 12px;
  border-bottom: 1px solid var(--sw-line);
  cursor: pointer;
}
.be-row:hover, .be-row.is-open { background: var(--sw-bg-2); }
.be-time { color: var(--sw-fg-1); }
.be-date { font-size: 10px; }
.be-cat { font-size: 9.5px; text-transform: uppercase; letter-spacing: 0.06em; font-weight: 700; }
.be-page, .be-ver { font-size: 10.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.be-msg {
  font-size: 11px; color: var(--sw-fg-1); overflow: hidden; text-overflow: ellipsis;
  white-space: nowrap; display: inline-flex; align-items: center; gap: 6px; min-width: 0;
}
.be-loc {
  flex: 0 0 auto; font-size: 9.5px; color: var(--sw-fg-3); background: var(--sw-bg-3);
  border-radius: 3px; padding: 0 5px; font-variant-numeric: tabular-nums;
}
.be-msg-body { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
