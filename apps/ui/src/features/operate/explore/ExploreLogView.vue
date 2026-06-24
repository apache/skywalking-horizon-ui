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

  Three sources: Log · raw (queryLogs), Log · browser (BROWSER-layer JS
  errors), and Log · Kubernetes Pod logs (on-demand container tail through
  OAP). The Browser source swaps the entity to a browser SERVICE picker
  and the conditions to Category + Time + Limit, renders an error list, and
  the row-click popout adds the source-map de-obfuscation control (the same
  resolve flow the per-layer Browser Logs tab uses). The Kubernetes Pod logs
  source pins a specific pod (instance) + container and does a one-shot
  on-demand window fetch (the same BFF route the per-layer Pod Logs tab
  tails) — these logs are never persisted, so there is no cold-stage.
-->
<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { bff, bffClient, describeApiError } from '@/api/client';
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
  SourceMapUsage,
} from '@/api/client';
import type { PodLogLine } from '@/api/scopes/log';
import { useLayers } from '@/shell/useLayers';
import { useTracePopout } from '@/layer/traces/useTracePopout';
import { WINDOW_OPTS as POD_WINDOW_OPTS, INTERVAL_OPTS as POD_INTERVAL_OPTS } from '@/layer/pod-logs/useLayerPodLogs';
import TypeaheadSelect from '@/components/primitives/TypeaheadSelect.vue';
import TagInput from '@/components/primitives/TagInput.vue';
import LogStreamPanel from '@/render/widgets/LogStreamPanel.vue';
import LogDetailPopout from '@/render/widgets/LogDetailPopout.vue';
import BrowserErrorPopout from '@/render/widgets/BrowserErrorPopout.vue';
import SourceMapManager from '@/layer/browser-errors/SourceMapManager.vue';
import { logRowKey } from '@/utils/logRow';

const { t } = useI18n();
const { availableLayers } = useLayers();
const { openTrace } = useTracePopout();

// ── source. `raw` = queryLogs (any service across layers); `browser` =
// BROWSER-layer JS errors; `pods` = on-demand Kubernetes Pod logs (a
// specific pod + container, never persisted). ─────────────────────────
type LogSource = 'raw' | 'browser' | 'pods';
const logSource = ref<LogSource>('raw');

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

// No layer seed for the browser source: this is an inspect tool, so it
// exposes every layer/service rather than pinning BROWSER (which left the
// service list showing only the browser app under an "Any layer" label).

// ── pods entity — a specific pod (instance) + container, scoped to a
// `caps.podLogs` layer. The SERVICE field has its own Pick/Type toggle
// (Pod + Container stay dropdowns either way): in Pick mode the service
// is chosen from the layer's catalog (→ `pickServiceId`); in Type mode
// the operator types a service name (→ `podTypeService`), which the
// instances route resolves per-layer (name → listServices → listInstances).
// The instance IS the pod; the container list is lazy-loaded from the
// pod's id. No endpoint — a pod log scopes to one container. ────────────
type PodEntityMode = 'pick' | 'type';
const podEntityMode = ref<PodEntityMode>('pick');
const podTypeService = ref<string>('');
// Real flag for the typed service. Pod logs are real-only in practice
// (a virtual/peer service has no pods), so this defaults to real.
const podTypeReal = ref(true);
const podContainer = ref<string>('');
const podContainers = ref<string[]>([]);
const containersLoading = ref(false);
const containersError = ref<string | null>(null);

const podInstancesLoading = ref(false);
// Pods service identity for the instances route: a picked OAP service-id
// (Pick) or the typed name (Type). Both resolve per-layer server-side.
const podServiceArg = computed(() =>
  podEntityMode.value === 'pick' ? pickServiceId.value : podTypeService.value.trim(),
);

/** Encode a typed service name to an OAP service id (base64 of the UTF-8
 *  name + the real flag). Type mode sends this so the instances route's
 *  id-passthrough resolves the pods without a per-layer name lookup,
 *  which is why Type needs no layer. */
function encodePodServiceId(name: string, real: boolean): string {
  const bytes = new TextEncoder().encode(name);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return `${btoa(bin)}.${real ? 1 : 0}`;
}

/** Load the pod (instance) list for the chosen/typed service of the pods
 *  source, scoped to its `caps.podLogs` layer. Cascade-clears the pod +
 *  container picks first so a stale pod never sits under the new list. */
async function loadPodInstances(): Promise<void> {
  instances.value = [];
  pickInstanceId.value = '';
  podContainer.value = '';
  podContainers.value = [];
  containersError.value = null;
  // Pick resolves the service within the chosen layer. Type needs no layer:
  // the typed name is encoded to a service id, and the instances route
  // ignores the layer key for an id, so any caps.podLogs layer works.
  let layer: string | undefined;
  let arg: string;
  if (podEntityMode.value === 'pick') {
    layer = pickLayer.value;
    arg = pickServiceId.value;
  } else {
    const name = podTypeService.value.trim();
    layer = podLayers.value[0]?.key;
    arg = name ? encodePodServiceId(name, podTypeReal.value) : '';
  }
  if (!layer || !arg) return;
  podInstancesLoading.value = true;
  try {
    const res = await bff.layer.instances(layer, arg);
    instances.value = res.reachable ? res.instances : [];
    // Single pod → auto-pin it (the common single-replica case); the
    // `pickInstanceId` watch then lists its containers.
    if (instances.value.length === 1) pickInstanceId.value = instances.value[0]!.id;
  } catch {
    instances.value = [];
  } finally {
    podInstancesLoading.value = false;
  }
}

// The shared cascade serves two sources with different downstreams:
//  · raw/browser → service list, then instances + endpoints.
//  · pods        → service list (Pick mode), then pods (instances), then
//                  containers; no endpoints.
// Each cascade gates on the active source so the wrong downstream never
// fires (loading pod containers for a browser service, etc.).
watch(pickLayer, () => {
  // pods Pick reloads its service list here; pods Type ignores the layer
  // (it encodes the name to an id), so no pods-specific branch is needed.
  void loadServices();
});
watch(pickServiceId, () => {
  if (logSource.value === 'pods') {
    if (podEntityMode.value === 'pick') void loadPodInstances();
    return;
  }
  void loadInstances();
  void loadEndpoints();
});
// Type mode: the typed name + real flag encode to a service id → resolve pods.
watch([podTypeService, podTypeReal], () => {
  if (logSource.value === 'pods' && podEntityMode.value === 'type') void loadPodInstances();
});

async function loadContainers(): Promise<void> {
  podContainer.value = '';
  podContainers.value = [];
  containersError.value = null;
  const id = pickInstanceId.value;
  const layer = podFetchLayer.value;
  if (!layer || !id) return;
  containersLoading.value = true;
  try {
    const r = await bff.log.podContainers(layer, id);
    if (r.errorReason) {
      containersError.value = r.errorReason;
    } else if (!r.reachable) {
      containersError.value = r.error ?? t('OAP unreachable');
    } else {
      podContainers.value = r.containers;
      // Auto-pick the first container (OAP lists the app container first).
      podContainer.value = r.containers[0] ?? '';
    }
  } catch (e) {
    containersError.value = e instanceof Error ? e.message : String(e);
  } finally {
    containersLoading.value = false;
  }
}
// Only the pods source needs containers — fetch when its pinned pod
// changes (operator pick OR the single-pod auto-pin in loadPodInstances).
// Entering pods always wipes the shared entity, so a pod can only ever be
// set from within the pods cascade — no "carried-in pod" case to handle.
watch(pickInstanceId, () => {
  if (logSource.value === 'pods') void loadContainers();
});
// Pick↔Type for the pods service is a fresh start: drop the service in
// both representations + the downstream pod / container so neither mode
// inherits the other's pick. The layer stays (Type still needs one).
watch(podEntityMode, () => {
  pickServiceId.value = '';
  podTypeService.value = '';
  instances.value = [];
  pickInstanceId.value = '';
  podContainer.value = '';
  podContainers.value = [];
  containersError.value = null;
});
const podContainerOptions = computed(() => podContainers.value.map((c) => ({ value: c, label: c })));

const layerOptions = computed(() => availableLayers.value.map((l) => ({ value: l.key, label: l.name || l.key })));
// `caps.podLogs` marks K8s-deployed layers (k8s_service / mesh — the same
// flag that gates the per-layer Pod Logs tab). The pods Layer dropdown lists
// EVERY layer (the layer is cosmetic on the pod-log wire, so operators may
// pick any); this narrower set only auto-defaults the Pick layer when exactly
// one such layer exists.
const podLayers = computed(() => availableLayers.value.filter((l) => l.caps?.podLogs));
// The layer key for the pod-log fetches: the picked layer in Pick mode; in
// Type mode the Layer field is hidden, so fall back to any caps.podLogs layer.
// OAP resolves the pod by its instance id, not the layer (the BFF only checks
// the key's shape), so any pod-log layer works — without this, Type mode
// dead-ends whenever more than one caps.podLogs layer exists.
const podFetchLayer = computed(() =>
  podEntityMode.value === 'pick' ? pickLayer.value : (podLayers.value[0]?.key ?? ''),
);
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
// Pods source: the instance is REQUIRED (it is the pod), so no "All
// instances" sentinel row — just the raw instance list.
const podInstanceOptions = computed(() => instances.value.map((i) => ({ value: i.id, label: i.name })));
const podInstanceSel = computed<string>({ get: () => pickInstanceId.value, set: (v) => (pickInstanceId.value = v ?? '') });

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
  tags: '' as string,
  traceId: '' as string,
  windowMinutes: 30,
  limit: 50,
});
const WINDOWS = [15, 30, 60, 180, 360, 720, 1440];
const LIMITS = [20, 50, 100, 200];

// ── pods condition — a trailing SECOND-precision window (live tail), in
// seconds. Reuses the per-layer Pod Logs window + interval options. No
// cold-stage: pod logs are never persisted. ─────────────────────────────
const podWindowSeconds = ref<number>(60);
const podIntervalSeconds = ref<number>(5);
// Include / Exclude are RAW regex (no `.*…*` wrap — the operator types the
// regex), passed verbatim as keywordsOfContent / excludingKeywordsOfContent,
// exactly like the per-layer Pod Logs tab.
const podIncludes = ref<string[]>([]);
const podExcludes = ref<string[]>([]);
const podIncludeInput = ref('');
const podExcludeInput = ref('');
function addPodInclude(): void {
  const v = podIncludeInput.value.trim();
  if (v && !podIncludes.value.includes(v)) podIncludes.value = [...podIncludes.value, v];
  podIncludeInput.value = '';
}
function removePodInclude(i: number): void {
  podIncludes.value = podIncludes.value.filter((_, idx) => idx !== i);
}
function addPodExclude(): void {
  const v = podExcludeInput.value.trim();
  if (v && !podExcludes.value.includes(v)) podExcludes.value = [...podExcludes.value, v];
  podExcludeInput.value = '';
}
function removePodExclude(i: number): void {
  podExcludes.value = podExcludes.value.filter((_, idx) => idx !== i);
}

// ── pods live-tail engine. Owns its own setInterval: Start polls
// `runPodQuery` every interval (re-fetching the rolling Window), Pause
// stops it, manual Refresh fetches now. The timer is torn down on unmount,
// on switching away from pods, and on any entity / window / interval / filter
// change (so a stale loop never keeps hitting OAP or stacks fetches). The
// Run button still works as a one-shot — `runQuery` reuses `runPodQuery`. ─
const podTailing = ref(false);
let podTimer: ReturnType<typeof setInterval> | null = null;

function stopPodTail(): void {
  podTailing.value = false;
  if (podTimer !== null) {
    clearInterval(podTimer);
    podTimer = null;
  }
}
function startPodTail(): void {
  if (logSource.value !== 'pods' || !canRun.value) return;
  stopPodTail();
  podTailing.value = true;
  void tickPodQuery();
  podTimer = setInterval(() => void tickPodQuery(), podIntervalSeconds.value * 1000);
}
function togglePodTail(): void {
  if (podTailing.value) stopPodTail();
  else startPodTail();
}

// Re-targeting the pod (pod / container / layer / service change) tears the
// tail down — a loop must never bleed across pods. Window / interval / filter
// changes while tailing restart the loop so OAP re-runs with the new
// condition (mirrors the per-layer Pod Logs tab); paused, they just take
// effect on the next Start.
watch([pickInstanceId, podContainer, pickLayer, podServiceArg], stopPodTail);
watch([podWindowSeconds, podIntervalSeconds], () => {
  if (podTailing.value) startPodTail();
});
watch([podIncludes, podExcludes], () => {
  if (podTailing.value) startPodTail();
}, { deep: true });
onUnmounted(stopPodTail);

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
const logsResp = ref<LogsResponse | null>(null);
const browserResp = ref<BrowserErrorsResponse | null>(null);
// Pod-log one-shot result. `errorReason` carries OAP's verbatim reason
// (feature disabled / stale pod) so the pane shows a hint, not a blank.
const podLines = ref<PodLogLine[]>([]);
const podErrorReason = ref<string | null>(null);
// The pods source bypasses the BFF explore resolver (it uses the
// dedicated pod-log route), so its resolved-query echo is built UI-side.
// `ExploreResolved.source` only types raw/browser, so widen the panel's
// shape to also accept this local pod echo.
type ResolvedEcho = ExploreResolved | { source: string; condition: Record<string, unknown> };
const resolved = ref<ResolvedEcho | null>(null);
const showResolved = ref(false);

const canRun = computed(() => {
  // A pod log needs a specific pod + container — both required.
  if (logSource.value === 'pods') return !!pickInstanceId.value && !!podContainer.value;
  // raw + browser: the entity is optional (blank queries every service).
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
    // Shared Pick/Type entity, same as raw — the BFF browser branch resolves
    // it via resolveNativeEntity and scopes by serviceId only (instance /
    // endpoint are ignored). Blank queries every service (OAP: serviceId 0).
    const entity = currentEntity();
    return {
      kind: 'log',
      logSource: 'browser',
      ...(entity ? { entity } : {}),
      window: resolveWindow(),
      pageSize: cond.limit,
      ...(browserCategory.value !== 'ALL' ? { category: browserCategory.value } : {}),
    };
  }
  // Raw logs deliberately omit content-keyword search — it's opt-in per
  // storage backend and off on the default (mirrors the per-layer Logs tab).
  // Only the pods source carries Keywords → keywordsOfContent.
  const entity = currentEntity();
  const tags = parseTags(cond.tags);
  return {
    kind: 'log',
    logSource: 'raw',
    ...(entity ? { entity } : {}),
    window: resolveWindow(),
    pageSize: cond.limit,
    ...(tags.length > 0 ? { tags } : {}),
    ...(cond.traceId.trim() ? { relatedTraceId: cond.traceId.trim() } : {}),
  };
}

async function runPodQuery(): Promise<void> {
  // Include / Exclude are RAW regex — the operator types the full-line
  // pattern (OAP matches keywordsOfContent / excludingKeywordsOfContent as a
  // full-line regex), so they go to the route VERBATIM, no `.*…*` wrap.
  // No Resolved-query echo for pods — it's a live tail, not a stored query,
  // so the panel stays hidden (resolved is reset on source switch).
  try {
    const r = await bff.log.podLogs(podFetchLayer.value, {
      serviceInstanceId: pickInstanceId.value,
      container: podContainer.value,
      windowSeconds: podWindowSeconds.value,
      ...(podIncludes.value.length > 0 ? { keywordsOfContent: [...podIncludes.value] } : {}),
      ...(podExcludes.value.length > 0 ? { excludingKeywordsOfContent: [...podExcludes.value] } : {}),
    });
    if (r.errorReason) {
      podErrorReason.value = r.errorReason;
    } else if (!r.reachable) {
      errorMsg.value = r.error ?? t('OAP unreachable');
    } else {
      podLines.value = r.lines;
    }
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : String(e);
  }
}

// One poll tick: a reentrancy-guarded `runPodQuery` so overlapping ticks
// never stack (a slow OAP response can outlast the interval). Marks the
// pane as queried + clears the prior soft-error before fetching, then
// resolves; a hard error stops the loop so it doesn't spin on failures.
let podTickInFlight = false;
async function tickPodQuery(): Promise<void> {
  if (podTickInFlight) return;
  podTickInFlight = true;
  hasQueried.value = true;
  errorMsg.value = null;
  podErrorReason.value = null;
  try {
    await runPodQuery();
    if (errorMsg.value) stopPodTail();
  } finally {
    podTickInFlight = false;
  }
}

async function runQuery(): Promise<void> {
  if (!canRun.value) return;
  running.value = true;
  hasQueried.value = true;
  errorMsg.value = null;
  podErrorReason.value = null;
  closeDetail();
  // Cascade-clear: drop the prior result before the new query lands so
  // operators never read stale rows as the new state.
  logsResp.value = null;
  browserResp.value = null;
  podLines.value = [];
  if (logSource.value === 'pods') {
    // A manual Run is a one-shot — pause any live tail first so the two
    // never double-fetch; the operator re-arms Start when they want tailing.
    stopPodTail();
    try {
      await runPodQuery();
    } finally {
      running.value = false;
    }
    return;
  }
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
const podRows = computed<PodLogLine[]>(() =>
  hasQueried.value && logSource.value === 'pods' ? podLines.value : [],
);
/** Pod log line timestamp (ms epoch from the BFF) → HH:MM:SS, browser-local. */
function fmtPodTime(ts: number | null): string {
  if (ts == null) return '';
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

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

// ── source-map cache — shared by the in-view SourceMapManager (upload /
// remove / refresh) and the browser popout's per-row resolve. The host owns
// the list + the API calls; the popout owns the per-row resolve. Same flow
// as the per-layer Browser Logs tab. ───────────────────────────────────────
const sourceMaps = ref<SourceMapDescriptor[]>([]);
const mapsUsage = ref<SourceMapUsage | null>(null);
const mapsEnabled = ref(true);
const mapsBusy = ref(false);
const mapsError = ref<string | null>(null);

async function loadMaps(): Promise<void> {
  try {
    const res = await bffClient.browserErrors.listSourceMaps();
    sourceMaps.value = res.maps;
    mapsUsage.value = res.usage;
    mapsEnabled.value = res.enabled;
    mapsError.value = null;
  } catch (err) {
    mapsError.value = describeApiError(err);
  }
}
async function onUploadMap(file: File): Promise<void> {
  mapsBusy.value = true;
  mapsError.value = null;
  try {
    const res = await bffClient.browserErrors.uploadSourceMap(file);
    if (!res.ok) mapsError.value = t('Upload rejected: {reason}', { reason: res.error ?? t('unknown') });
    await loadMaps();
  } catch (err) {
    mapsError.value = describeApiError(err);
  } finally {
    mapsBusy.value = false;
  }
}
async function onRemoveMap(id: string): Promise<void> {
  mapsBusy.value = true;
  try {
    await bffClient.browserErrors.deleteSourceMap(id);
    await loadMaps();
  } catch (err) {
    mapsError.value = describeApiError(err);
  } finally {
    mapsBusy.value = false;
  }
}
onMounted(loadMaps);

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
//
// The entity is reset ONLY when pods is on either side of the switch.
// Raw↔Browser share one entity scope (any-layer services), so that
// transition keeps the picked service. Pods scopes to `caps.podLogs`
// layers and a browser service has no pod — so crossing the pods
// boundary in either direction wipes the shared cascade clean.
watch(logSource, (next, prev) => {
  // Leaving (or re-entering) pods always kills the live tail — no orphan
  // loop polling a source the operator has navigated off.
  stopPodTail();
  hasQueried.value = false;
  errorMsg.value = null;
  logsResp.value = null;
  browserResp.value = null;
  podLines.value = [];
  podErrorReason.value = null;
  resolved.value = null;
  closeDetail();
  if (next === 'pods' || prev === 'pods') {
    pickLayer.value = '';
    pickServiceId.value = '';
    pickInstanceId.value = '';
    pickEndpointId.value = '';
    services.value = [];
    instances.value = [];
    endpoints.value = [];
    podTypeService.value = '';
    podContainer.value = '';
    podContainers.value = [];
    containersError.value = null;
    // Entering pods with exactly one K8s layer: auto-pin it so the
    // single-cluster common case is one fewer click. More than one →
    // leave blank with the "Any layer" placeholder for the operator.
    if (next === 'pods' && podLayers.value.length === 1) {
      pickLayer.value = podLayers.value[0]!.key;
    }
  }
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
        <button :class="{ on: logSource === 'pods' }" :title="t('Kubernetes Pod logs')" @click="logSource = 'pods'">{{ t('Kubernetes Pod logs') }}</button>
      </div>
    </div>

    <!-- Logs have no distribution square — the form spans the full width
         (a 3-column condition grid reads well across it). -->
    <div class="iq-form">
      <!-- Kubernetes Pod logs source: a specific pod (instance) + container,
           both required, scoped to a `caps.podLogs` layer. The SERVICE field
           has its own Pick/Type toggle — Pick chooses from the layer's
           catalog, Type takes a free-text service name the instances route
           resolves per-layer. Pod + Container stay dropdowns either way; the
           pod IS the instance and its containers lazy-load from the pod id.
           Pod + Container auto-select when unambiguous. No endpoint — a pod
           log scopes to one container. -->
      <div v-if="logSource === 'pods'" class="iq-target">
        <div class="iq-target-h">
          <span>{{ t('Kubernetes Pod logs') }} <small class="dim">{{ t('required — a pod and a container (pick or type a service)') }}</small></span>
          <div class="seg sm">
            <button :class="{ on: podEntityMode === 'pick' }" @click="podEntityMode = 'pick'">{{ t('Pick') }}</button>
            <button :class="{ on: podEntityMode === 'type' }" @click="podEntityMode = 'type'">{{ t('Type') }}</button>
          </div>
        </div>
        <div class="iq-grid" :class="podEntityMode === 'pick' ? 'iq-grid--ent' : 'iq-grid--ent-type'">
          <label class="cf" v-if="podEntityMode === 'pick'">
            <span>{{ t('Layer') }}</span>
            <TypeaheadSelect v-model="pickLayer" :aria-label="t('Layer')" :options="layerOptions" :placeholder="t('Any layer')" class="cf-tas" />
          </label>
          <label class="cf" v-if="podEntityMode === 'pick'">
            <span>{{ t('Service') }}</span>
            <TypeaheadSelect
              v-model="pickServiceId" :aria-label="t('Service')" :options="serviceOptions" :disabled="!pickLayer || servicesLoading"
              :placeholder="servicesLoading ? t('Reading…') : t('Pick a service')" class="cf-tas"
            />
          </label>
          <label class="cf" v-else>
            <span>{{ t('Service name') }}</span>
            <input v-model="podTypeService" class="cf-input mono" type="text" :placeholder="t('e.g. agent::checkout')" />
          </label>
          <label class="cf cf-chk" v-if="podEntityMode === 'type'">
            <span>{{ t('Real') }}</span>
            <span class="iq-chk"><input v-model="podTypeReal" type="checkbox" /> <small class="dim">{{ t('off = virtual / peer') }}</small></span>
          </label>
          <label class="cf">
            <span>{{ t('Pod') }}</span>
            <TypeaheadSelect
              v-model="podInstanceSel" :aria-label="t('Pod')" :options="podInstanceOptions" :disabled="!podServiceArg || podInstancesLoading"
              :placeholder="podInstancesLoading ? t('Reading…') : (instances.length ? t('Select a pod…') : t('No pods'))" class="cf-tas"
            />
          </label>
          <label class="cf">
            <span>{{ t('Container') }}</span>
            <TypeaheadSelect
              v-model="podContainer" :aria-label="t('Container')" :options="podContainerOptions"
              :disabled="!pickInstanceId || containersLoading"
              :placeholder="containersLoading ? t('Loading…') : (podContainers.length ? t('Select a container…') : t('No containers'))"
              class="cf-tas"
            />
          </label>
        </div>
        <p class="iq-pod-tip">{{ t('Each pod is the service instance, surfaced as its live Kubernetes pod — logs are tailed straight from the cluster, so the pod must be currently running.') }}</p>
        <!-- Listing a pod's containers can itself return OAP's errorReason
             (feature disabled / stale pod) — surface it before Run. -->
        <div v-if="containersError" class="iq-pod-banner">
          <strong>{{ t('Logs unavailable:') }}</strong> {{ containersError }}
          <span class="dim">{{ t('— pick a currently-running pod, or check that on-demand pod logs are enabled on OAP.') }}</span>
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

          <div class="iq-grid iq-grid--ent" v-if="entityMode === 'pick'">
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
              <span>{{ logSource === 'browser' ? t('Version') : t('Instance') }}</span>
              <TypeaheadSelect v-model="instanceSel" :aria-label="logSource === 'browser' ? t('Version') : t('Instance')" :options="instanceOptions" :disabled="!pickServiceId" :placeholder="logSource === 'browser' ? t('All versions') : t('All instances')" class="cf-tas" />
            </label>
            <label class="cf">
              <span>{{ logSource === 'browser' ? t('Page') : t('Endpoint') }}</span>
              <TypeaheadSelect v-model="endpointSel" :aria-label="logSource === 'browser' ? t('Page') : t('Endpoint')" :options="endpointOptions" :disabled="!pickServiceId" :placeholder="logSource === 'browser' ? t('All pages') : t('All endpoints')" class="cf-tas" />
            </label>
          </div>

          <div class="iq-grid iq-grid--ent-type" v-else>
            <label class="cf">
              <span>{{ t('Service name') }}</span>
              <input v-model="typeService" class="cf-input mono" type="text" :placeholder="t('e.g. agent::checkout')" />
            </label>
            <label class="cf cf-chk">
              <span>{{ t('Real') }}</span>
              <span class="iq-chk"><input v-model="typeReal" type="checkbox" /> <small class="dim">{{ t('off = virtual / peer') }}</small></span>
            </label>
            <label class="cf">
              <span>{{ logSource === 'browser' ? t('Version') : t('Instance') }}</span>
              <input v-model="typeInstance" class="cf-input" type="text" :placeholder="t('optional')" />
            </label>
            <label class="cf">
              <span>{{ logSource === 'browser' ? t('Page') : t('Endpoint') }}</span>
              <input v-model="typeEndpoint" class="cf-input" type="text" :placeholder="t('optional')" />
            </label>
          </div>
        </div>

        <div class="iq-conditions">
          <div class="iq-conditions-h">
            <span class="kicker iq-cond-kicker">{{ logSource === 'browser' ? t('Browser errors') : (logSource === 'pods' ? t('Kubernetes Pod logs') : 'Logs') }}</span>
            <button v-if="resolved" class="iq-resolved-tog" @click="showResolved = !showResolved">
              {{ showResolved ? '▾' : '▸' }} {{ t('Resolved query') }}
              <span class="dim">{{ resolved.source }}</span>
            </button>
            <!-- Pods auto-tail trio: Interval + Pause/Start + manual Refresh.
                 Start polls runPodQuery on the chosen interval (re-fetching the
                 rolling Window); Pause stops it; Refresh fetches once now. -->
            <template v-if="logSource === 'pods'">
              <label class="iq-tail-int">
                <span>{{ t('Interval') }}</span>
                <select v-model.number="podIntervalSeconds" class="cf-input">
                  <option v-for="o in POD_INTERVAL_OPTS" :key="o.value" :value="o.value">{{ o.label }}</option>
                </select>
              </label>
              <button class="iq-refresh" :disabled="!canRun || running" :title="t('Refresh')" @click="runQuery">{{ t('Refresh') }}</button>
              <button class="iq-tail" :class="{ on: podTailing }" :disabled="!canRun" @click="togglePodTail">
                <span class="dot" :class="{ live: podTailing }" />
                {{ podTailing ? t('Pause') : t('Start') }}
              </button>
            </template>
            <button v-else class="iq-run" :disabled="!canRun || running" @click="runQuery">
              {{ running ? t('Running…') : t('Run query') }}
            </button>
          </div>
          <div :class="logSource === 'browser' ? 'iq-cond--inline iq-cond--tlast' : 'iq-cond--inline'">
            <template v-if="logSource === 'browser'">
              <label class="cf cf-cat">
                <span>{{ t('Category') }}</span>
                <select v-model="browserCategory" class="cf-input">
                  <option v-for="c in BROWSER_CATEGORIES" :key="c" :value="c">{{ c === 'ALL' ? t('All categories') : c }}</option>
                </select>
              </label>
            </template>
            <template v-else-if="logSource === 'pods'">
              <!-- Include / Exclude: RAW-regex chip fields (operator types the
                   full-line pattern, no `.*…*` wrap), passed verbatim as
                   keywordsOfContent / excludingKeywordsOfContent — same as the
                   per-layer Pod Logs tab. -->
              <label class="cf cf-incl">
                <span>{{ t('Include') }}</span>
                <div class="iq-kw">
                  <span v-for="(k, i) in podIncludes" :key="`inc${i}`" class="iq-chip">
                    {{ k }}<button class="iq-chip-x" type="button" @click="removePodInclude(i)">×</button>
                  </span>
                  <input
                    v-model="podIncludeInput" class="iq-kw-inp mono" type="text"
                    :placeholder="t('regex (e.g. .*error.*) + Enter')"
                    @keydown.enter.prevent="addPodInclude"
                  />
                </div>
              </label>
              <label class="cf cf-incl">
                <span>{{ t('Exclude') }}</span>
                <div class="iq-kw">
                  <span v-for="(k, i) in podExcludes" :key="`exc${i}`" class="iq-chip ex">
                    {{ k }}<button class="iq-chip-x" type="button" @click="removePodExclude(i)">×</button>
                  </span>
                  <input
                    v-model="podExcludeInput" class="iq-kw-inp mono" type="text"
                    :placeholder="t('regex (e.g. .*error.*) + Enter')"
                    @keydown.enter.prevent="addPodExclude"
                  />
                </div>
              </label>
            </template>
            <template v-else>
              <label class="cf cf-grow">
                <span>{{ t('Tags') }}</span>
                <TagInput
                  v-model="cond.tags"
                  kind="log"
                  :window-minutes="cond.windowMinutes"
                  :placeholder="t('level=ERROR, …')"
                  @commit="onTagCommit"
                />
              </label>
              <label class="cf cf-grow">
                <span>{{ t('Trace ID') }}</span>
                <input v-model="cond.traceId" class="cf-input mono" type="text" :placeholder="t('paste a trace id')" />
              </label>
            </template>
            <!-- Pods: a trailing SECOND-precision window (seconds) — the
                 logs are tailed live, never persisted, so no custom range. -->
            <label v-if="logSource === 'pods'" class="cf cf-podw">
              <span>{{ t('Window') }}</span>
              <select v-model.number="podWindowSeconds" class="cf-input">
                <option v-for="o in POD_WINDOW_OPTS" :key="o.value" :value="o.value">{{ t(o.label) }}</option>
              </select>
            </label>
            <label v-else class="cf iq-time" :class="{ 'cf-wide': isCustomRange }">
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
            <label v-if="logSource !== 'pods'" class="cf cf-lim">
              <span>{{ t('Limit') }}</span>
              <select v-model.number="cond.limit" class="cf-input">
                <option v-for="l in LIMITS" :key="l" :value="l">{{ l }}</option>
              </select>
            </label>
          </div>
        <pre v-if="resolved && showResolved" class="iq-resolved-body">{{ JSON.stringify(resolved.condition, null, 2) }}</pre>
      </div>
    </div>

    <!-- Browser source: source-map file management. The same in-memory cache
         the row-click popout resolves stacks against — upload a .map here so
         the de-obfuscation control has something to pick. -->
    <div v-if="logSource === 'browser'" class="iq-maps">
      <SourceMapManager
        :maps="sourceMaps"
        :usage="mapsUsage"
        :enabled="mapsEnabled"
        :busy="mapsBusy"
        @upload="onUploadMap"
        @remove="onRemoveMap"
        @refresh="loadMaps"
      />
      <p v-if="mapsError" class="iq-maps-err">{{ mapsError }}</p>
    </div>

    <!-- Browser source: a dense error list in the same dark vocabulary as
         the per-layer Browser Logs stream; row-click opens the popout. -->
    <div v-if="logSource === 'browser'" class="iq-result">
      <div v-if="!hasQueried" class="iq-empty">{{ t('Run a query — pick a BROWSER service, type a name, or leave it blank.') }}</div>
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

    <!-- Kubernetes Pod logs source: a read-only dense pane of on-demand log
         lines (timestamp + content), matching the per-layer Pod Logs look.
         OAP's errorReason (feature disabled / stale pod) shows as a hint. -->
    <div v-else-if="logSource === 'pods'" class="iq-result">
      <div v-if="!hasQueried" class="iq-empty">{{ t('Pick a pod and a container, then run a query.') }}</div>
      <div v-else-if="running && podRows.length === 0" class="iq-empty">{{ t('Reading data…') }}</div>
      <div v-else-if="errorMsg" class="iq-err">{{ errorMsg }}</div>
      <div v-else-if="podErrorReason" class="iq-pod-banner">
        <strong>{{ t('Logs unavailable:') }}</strong> {{ podErrorReason }}
        <span class="dim">{{ t('— pick a currently-running pod, or check that on-demand pod logs are enabled on OAP.') }}</span>
      </div>
      <div v-else-if="podRows.length === 0" class="iq-empty">{{ t('No logs in this window.') }}</div>

      <article v-else class="iq-list-card sw-card">
        <header class="iq-list-head">
          <h4>{{ t('Kubernetes Pod logs') }}</h4>
          <span class="hint">{{ podRows.length }} {{ t('lines') }}</span>
        </header>
        <div class="iq-stream-scroll">
          <div class="pl-stream">
            <div v-for="(l, idx) in podRows" :key="`pl-${idx}`" class="pl-row">
              <span class="pl-time mono dim">{{ fmtPodTime(l.timestamp) }}</span>
              <span class="pl-content mono">{{ l.content }}</span>
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
/* The conditions grid carries few fields (the log sources expose Tags /
   Trace ID / Time / Limit, or just Category / Keywords + Window), so it
   runs 2 columns: `.cf-wide` text fields fill the row and Time + Limit sit
   side by side — no blank trailing column the way 3 columns would leave. */
.iq-grid--cond { grid-template-columns: repeat(2, minmax(0, 1fr)); }
/* The raw/browser entity sits in one 4-field row. Pick (4 selects:
   Layer/Service + Instance/Endpoint) splits evenly; Type keeps the Real
   checkbox at its content width so its column doesn't leave a blank gap,
   handing the freed space to Service name / Instance / Endpoint. */
.iq-grid--ent { grid-template-columns: repeat(4, minmax(0, 1fr)); }
.iq-grid--ent-type { grid-template-columns: minmax(0, 1fr) max-content minmax(0, 1fr) minmax(0, 1fr); }
@media (max-width: 900px) { .iq-grid, .iq-grid--ent, .iq-grid--ent-type { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 560px) { .iq-grid, .iq-grid--ent, .iq-grid--ent-type { grid-template-columns: 1fr; } }

/* Browser conditions run inline (not the grid): Category + Limit stay
   compact, and Time sits last (order:9) so its custom-range mode expands
   into the trailing space without shoving the other two. */
.iq-cond--inline { display: flex; flex-wrap: wrap; gap: 8px 10px; align-items: flex-start; }
/* Raw: Tags + Trace ID take ~half each (two per row); Time + Limit then
   wrap to a compact second row where a custom range still fits inline. */
.iq-cond--inline .cf-grow { flex: 1 1 calc(50% - 6px); }
.iq-cond--inline .cf-cat { flex: 0 1 240px; }
.iq-cond--inline .cf-lim { flex: 0 0 110px; }
.iq-cond--inline .iq-time { flex: 0 1 150px; }
.iq-cond--inline .iq-time.cf-wide { flex: 0 1 420px; }
/* Pods: Include + Exclude grow to share the row, Window stays compact at
   its end — all three on one line. */
.iq-cond--inline .cf-incl { flex: 1 1 0; min-width: 0; }
.iq-cond--inline .cf-podw { flex: 0 0 160px; }
/* Browser only: Time sits last so its custom range expands into the
   trailing space without shoving Category/Limit. */
.iq-cond--tlast .iq-time { order: 9; }
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

/* Pods auto-tail trio in the conditions header — Interval / Refresh / Start
   sit to the right of the kicker, matching the per-layer Pod Logs bar. */
.iq-tail-int { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; color: var(--sw-fg-3); }
.iq-tail-int .cf-input { width: auto; height: 28px; }
.iq-refresh {
  background: var(--sw-bg-2); color: var(--sw-fg-1); border: 1px solid var(--sw-line-2);
  border-radius: 4px; padding: 0 12px; font: inherit; font-size: 12px; cursor: pointer; height: 28px;
}
.iq-refresh:disabled { opacity: 0.5; cursor: not-allowed; }
.iq-tail {
  display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 14px;
  border: 1px solid var(--sw-accent); border-radius: 4px; background: var(--sw-accent);
  color: #1a1106; font: inherit; font-size: 12px; font-weight: 700; cursor: pointer;
}
.iq-tail.on { background: transparent; color: var(--sw-accent); }
.iq-tail:disabled { opacity: 0.45; cursor: not-allowed; border-color: var(--sw-line-2); background: var(--sw-bg-2); color: var(--sw-fg-3); }
.iq-tail .dot { background: currentColor; }
.dot { width: 7px; height: 7px; border-radius: 50%; background: var(--sw-fg-3); }
.dot.live { background: #4ade80; animation: iq-pulse 1.2s infinite ease-in-out; }
.iq-tail .dot.live { background: #4ade80; }
@keyframes iq-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }

/* Include / Exclude regex chip fields — same chip vocabulary as the
   per-layer Pod Logs filters (include = cyan, exclude = red). */
.iq-kw {
  display: flex; align-items: center; gap: 5px; flex-wrap: wrap; min-height: 28px;
  padding: 3px 6px; background: var(--sw-bg-2); border: 1px solid var(--sw-line-2); border-radius: 4px;
}
.iq-chip {
  display: inline-flex; align-items: center; gap: 3px; padding: 1px 4px 1px 7px;
  border-radius: 10px; background: rgba(125, 211, 252, 0.16); color: #7dd3fc; font-size: 11px;
}
.iq-chip.ex { background: rgba(248, 113, 113, 0.16); color: #f87171; }
.iq-chip-x { border: none; background: transparent; color: inherit; cursor: pointer; font-size: 13px; line-height: 1; padding: 0 2px; }
.iq-kw-inp {
  flex: 1 1 180px; min-width: 140px; height: 22px; padding: 0 6px;
  background: transparent; border: none; color: var(--sw-fg-0); font: inherit; font-size: 11px;
}
.iq-kw-inp:focus { outline: none; }
.iq-resolved-tog { background: none; border: none; color: var(--sw-fg-3); font-size: 11px; cursor: pointer; }
.iq-resolved-tog .dim { color: var(--sw-fg-4); margin-left: 6px; }
.iq-resolved-body { margin: 0; padding: 8px 12px; font-family: var(--sw-mono); font-size: 11px; color: var(--sw-fg-2); background: var(--sw-bg-0); overflow: auto; max-height: 160px; border: 1px solid var(--sw-line); border-radius: 5px; }
.kicker { font-size: 10px; text-transform: uppercase; letter-spacing: 0.1em; color: var(--sw-accent); font-weight: 600; }

.iq-form { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.iq-conditions { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.iq-maps { display: flex; flex-direction: column; gap: 6px; }
.iq-maps-err { margin: 0; font-size: 11.5px; color: var(--sw-err); }

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

/* Pod-log line list — read-only dense lines (timestamp + content) in the
   same dark vocabulary as the per-layer Pod Logs pane. Plain text, no
   row-click popout (each line is just a string). */
.pl-stream { font-size: 11.5px; }
.pl-row {
  display: grid;
  grid-template-columns: 70px 1fr;
  gap: 10px;
  align-items: baseline;
  padding: 2px 12px;
  border-bottom: 1px solid var(--sw-line);
}
.pl-row:hover { background: var(--sw-bg-2); }
.pl-time { font-size: 10.5px; flex: 0 0 auto; font-variant-numeric: tabular-nums; }
.pl-content { color: var(--sw-fg-1); white-space: pre-wrap; word-break: break-word; }

/* On-demand pod logs return OAP's errorReason when the feature is disabled
   or the pod can't be resolved — surface it as a hint, not a blank pane. */
.iq-pod-tip { margin: 8px 0 0; font-size: 11px; line-height: 1.45; color: var(--sw-fg-3); }
.iq-pod-banner {
  margin: 8px 0 0;
  padding: 8px 12px;
  border: 1px solid rgba(240, 160, 75, 0.5);
  background: rgba(240, 160, 75, 0.1);
  border-radius: 4px;
  font-size: 11.5px;
  color: #f0a04b;
}
.iq-pod-banner .dim { color: var(--sw-fg-3); }
</style>
