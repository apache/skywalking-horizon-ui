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
  Per-layer Network Profiling tab — feature parity with booster-ui
  `dashboard/related/network-profiling`. Mounts on a service instance
  and surfaces eBPF NETWORK + CONTINUOUS_PROFILING tasks plus the
  process-level topology snapshot.

    ┌──────────────┬─────────────────────────────────────────────┐
    │  Instance    │ Topology window selector + refresh          │
    │  picker      ├─────────────────────────────────────────────┤
    │  Tasks list  │                                             │
    │  + New Task  │   ProcessTopologyGraph (honeycomb layout)   │
    │              │                                             │
    │              ├─────────────────────────────────────────────┤
    │              │  Selected node / call detail panel          │
    └──────────────┴─────────────────────────────────────────────┘
-->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { useLayerInstances } from '@/layer/useLayerInstances';
import { useSelectedService } from '@/layer/useSelectedService';
import { bffClient } from '@/api/client';
import { usePreviewLayerBlock } from '@/controls/previewConfig';
import type {
  EBPFTask,
  NetworkProfilingSampling,
  ProcessCall,
  ProcessNode,
  ProcessRelationEndpointRef,
  ProcessRelationMetricsResponse,
} from '@/api/client';
import ProcessTopologyGraph from '@/layer/profiling/ProcessTopologyGraph.vue';
import TimeChart from '@/components/charts/TimeChart.vue';
import { useNewTaskPoll } from '@/layer/profiling/useNewTaskPoll';
import Icon from '@/components/icons/Icon.vue';

const route = useRoute();
const layerKey = computed(() => String(route.params.layerKey ?? ''));
// Preview-only: forward the draft `processTopology` block so a clicked
// edge's metrics reflect the unpublished config.
const previewProcessTopology = usePreviewLayerBlock(layerKey, 'processTopology');
const { selectedId: serviceId } = useSelectedService();

// Instance picker (binds to ?serviceInstance= via plain ref state — the
// network view needs an *instance* to be useful, so we don't reuse the
// generic `useSelectedInstance` composable's URL contract).
const instances = useLayerInstances(layerKey, serviceId);
const selectedInstanceId = ref<string | null>(null);
watch(
  () => instances.instances.value,
  (rows) => {
    if (rows.length && !rows.some((i) => i.id === selectedInstanceId.value)) {
      selectedInstanceId.value = rows[0]?.id ?? null;
    }
  },
  { immediate: true },
);

// ── Tasks ──────────────────────────────────────────────────────────
const tasks = ref<EBPFTask[]>([]);
const tasksError = ref<string | null>(null);
const tasksLoading = ref(false);
const currentTask = ref<EBPFTask | null>(null);

// Tasks are listed per SERVICE, not per selected instance. A network
// task runs against the instance that was live when it was created; if
// that pod has since been replaced (new pod name), AND-ing the task
// query with the currently-selected instance hides the task entirely.
// The task object carries its own serviceInstanceId, so the list stays
// correct and selecting a task can still drive the right topology.
watch(
  () => layerKey.value + '|' + (serviceId.value ?? ''),
  () => void refreshTasks(),
  { immediate: true },
);

async function refreshTasks(): Promise<void> {
  tasksError.value = null;
  tasks.value = [];
  currentTask.value = null;
  if (!serviceId.value) return;
  tasksLoading.value = true;
  try {
    const resp = await bffClient.networkProfile.tasks(layerKey.value, {
      service: serviceId.value ?? undefined,
    });
    if (!resp.reachable && resp.error) tasksError.value = resp.error;
    tasks.value = resp.tasks ?? [];
    currentTask.value = tasks.value[0] ?? null;
    // currentTask change drives loadTopology via the watch below; when
    // the list is empty currentTask stays null and we fall back to the
    // live picker view.
    if (!currentTask.value) await loadTopology();
  } catch (e) {
    tasksError.value = e instanceof Error ? e.message : String(e);
  } finally {
    tasksLoading.value = false;
  }
}

// ── Process topology ──────────────────────────────────────────────
const nodes = ref<ProcessNode[]>([]);
const calls = ref<ProcessCall[]>([]);
const topologyLoading = ref(false);
const topologyError = ref<string | null>(null);
const windowMinutes = ref(30);

// Topology follows the SELECTED TASK: a finished FIXED_TIME task only
// captured process relations on its own instance during its own window
// (and that pod may since have been replaced). When a task is selected
// we query its instance + [taskStartTime, taskStartTime+duration]; with
// no task we fall back to the picker instance + rolling window.
watch([currentTask, selectedInstanceId], () => void loadTopology());

async function loadTopology(): Promise<void> {
  nodes.value = [];
  calls.value = [];
  topologyError.value = null;
  const task = currentTask.value;
  const instanceId = task?.serviceInstanceId ?? selectedInstanceId.value;
  if (!instanceId) return;
  topologyLoading.value = true;
  try {
    let topoOpts: { windowMinutes?: number; startTime?: number; endTime?: number };
    if (task?.taskStartTime) {
      const dur = (task.fixedTriggerDuration ?? 0) * 1000;
      topoOpts = {
        startTime: task.taskStartTime,
        endTime: dur > 0 ? task.taskStartTime + dur : Date.now(),
      };
    } else {
      topoOpts = { windowMinutes: windowMinutes.value };
    }
    const resp = await bffClient.networkProfile.topology(instanceId, topoOpts);
    if (!resp.reachable && resp.error) topologyError.value = resp.error;
    nodes.value = resp.nodes ?? [];
    calls.value = resp.calls ?? [];
  } catch (e) {
    topologyError.value = e instanceof Error ? e.message : String(e);
  } finally {
    topologyLoading.value = false;
  }
}

// Edge selection drives the dashboard modal. Node info is shown by the
// graph's own floating popover, so the view only tracks the edge.
const selectedCall = ref<ProcessCall | null>(null);
function onSelectCall(c: ProcessCall | null): void {
  selectedCall.value = c;
}
function closeEdge(): void {
  selectedCall.value = null;
}

// ── Edge (process-relation) metrics ────────────────────────────────
const relationMetrics = ref<ProcessRelationMetricsResponse | null>(null);
const relationLoading = ref(false);
const relationError = ref<string | null>(null);

function nodeById(id: string): ProcessNode | undefined {
  return nodes.value.find((n) => n.id === id);
}
function endpointRef(n: ProcessNode): ProcessRelationEndpointRef {
  return {
    serviceName: n.serviceName,
    serviceInstanceName: n.serviceInstanceName,
    processName: n.name,
    // Process-topology services are agent/rover-monitored = normal.
    normal: true,
  };
}

// Refire when the operator clicks a different edge. The detail area
// resets first (cascade-clear), then resolves async — never leaves a
// stale conversation's numbers under the new edge's header.
watch(selectedCall, async (call) => {
  relationMetrics.value = null;
  relationError.value = null;
  if (!call) return;
  const src = nodeById(call.source);
  const dst = nodeById(call.target);
  if (!src || !dst) {
    relationError.value = 'Edge endpoints not in the current topology.';
    return;
  }
  relationLoading.value = true;
  try {
    // Query over the profiling task's own run window (the data only
    // exists for that span), falling back to the topology window when
    // no task is selected.
    const task = currentTask.value;
    const taskWindow =
      task?.taskStartTime && task.fixedTriggerDuration
        ? {
            startTime: task.taskStartTime,
            endTime: task.taskStartTime + task.fixedTriggerDuration * 1000,
          }
        : { windowMinutes: windowMinutes.value };
    relationMetrics.value = await bffClient.networkProfile.relationMetrics(layerKey.value, {
      source: endpointRef(src),
      dest: endpointRef(dst),
      ...taskWindow,
      ...(previewProcessTopology.value ? { previewConfig: previewProcessTopology.value } : {}),
    });
    if (!relationMetrics.value.reachable && relationMetrics.value.error) {
      relationError.value = relationMetrics.value.error;
    }
  } catch (e) {
    relationError.value = e instanceof Error ? e.message : String(e);
  } finally {
    relationLoading.value = false;
  }
});

/** Latest non-null value in a series, for the headline number next to
 *  each metric's sparkline. cpm/bytes can go null at the tail (no data
 *  in the most recent bucket) so we scan backwards. */
function latestValue(values: Array<number | null>): number | null {
  for (let i = values.length - 1; i >= 0; i--) {
    if (values[i] !== null && values[i] !== undefined) return values[i];
  }
  return null;
}
function fmtMetric(v: number | null, unit?: string): string {
  if (v === null) return '—';
  if (unit === 'B') {
    if (v >= 1024 * 1024) return `${(v / 1024 / 1024).toFixed(1)} MB`;
    if (v >= 1024) return `${(v / 1024).toFixed(1)} KB`;
    return `${v} B`;
  }
  const n = Number.isInteger(v) ? v : Number(v.toFixed(2));
  return unit ? `${n} ${unit}` : String(n);
}
const sourceProcessName = computed(
  () => (selectedCall.value && nodeById(selectedCall.value.source)?.name) || '—',
);
const targetProcessName = computed(
  () => (selectedCall.value && nodeById(selectedCall.value.target)?.name) || '—',
);

/** Edge-chart x-axis labels = the ACTUAL profiling clock time per bucket
 *  (task start → end), browser-local `HH:mm:ss`. Not relative `-Nm`
 *  markers (which blow up for long tasks) — the operator reads the real
 *  wall-clock span the task profiled. */
const edgeTimeFmt = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});
const edgeXLabels = computed<string[]>(() => {
  const m = relationMetrics.value;
  const n = m?.client[0]?.values.length ?? m?.server[0]?.values.length ?? 0;
  if (n <= 0) return [];
  const task = currentTask.value;
  const startMs =
    task?.taskStartTime ?? Date.now() - windowMinutes.value * 60_000;
  const spanMs =
    task?.taskStartTime && task.fixedTriggerDuration
      ? task.fixedTriggerDuration * 1000
      : windowMinutes.value * 60_000;
  const stepMs = n > 1 ? spanMs / (n - 1) : spanMs;
  return Array.from({ length: n }, (_, i) =>
    edgeTimeFmt.format(new Date(startMs + i * stepMs)),
  );
});

function onEdgeKeydown(ev: KeyboardEvent): void {
  if (ev.key === 'Escape' && selectedCall.value) closeEdge();
}
onMounted(() => window.addEventListener('keydown', onEdgeKeydown));
onBeforeUnmount(() => window.removeEventListener('keydown', onEdgeKeydown));

// ── New task modal ────────────────────────────────────────────────
const showNewTask = ref(false);
const newTaskError = ref<string | null>(null);
const { polling, pollRound, pollForNewTask } = useNewTaskPoll();
// OAP's `EBPFNetworkDataCollectingSettings.requireCompleteRequest` and
// `requireCompleteResponse` are `Boolean!` — non-null. Every sampling
// row MUST carry the settings block, otherwise
// `createEBPFNetworkProfiling` 400s with a schema validation error.
const DEFAULT_SETTINGS = (): NetworkProfilingSampling['settings'] => ({
  requireCompleteRequest: true,
  requireCompleteResponse: true,
});
const samplings = ref<NetworkProfilingSampling[]>([
  { uriRegex: '', minDuration: 0, when4xx: true, when5xx: true, settings: DEFAULT_SETTINGS() },
]);
function addSampling(): void {
  samplings.value.push({ minDuration: 0, when4xx: false, when5xx: false, settings: DEFAULT_SETTINGS() });
}
function removeSampling(i: number): void {
  samplings.value.splice(i, 1);
}
async function submitNewTask(): Promise<void> {
  if (!selectedInstanceId.value) {
    newTaskError.value = 'Pick an instance first';
    return;
  }
  newTaskError.value = null;
  const idsBefore = new Set(tasks.value.map((t) => t.taskId));
  try {
    const resp = await bffClient.networkProfile.create({
      instanceId: selectedInstanceId.value,
      samplings: samplings.value,
    });
    if (!resp.status && resp.errorReason) {
      newTaskError.value = resp.errorReason;
      return;
    }
    if (!resp.reachable && resp.error) {
      newTaskError.value = resp.error;
      return;
    }
    showNewTask.value = false;
    await refreshTasks();
    await pollForNewTask({
      idsBefore,
      refresh: refreshTasks,
      currentIds: () => tasks.value.map((t) => t.taskId),
    });
  } catch (e) {
    newTaskError.value = e instanceof Error ? e.message : String(e);
  }
}

function fmtTime(ms: number): string {
  if (!ms) return '—';
  const d = new Date(ms);
  const z = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}:${z(d.getMinutes())}:${z(d.getSeconds())}`;
}
</script>

<template>
  <div class="sw-card net-shell">
    <!-- Side: instance picker + tasks -->
    <div class="net-side">
      <div class="side-head">
        <span>Instance</span>
      </div>
      <div class="picker">
        <select v-model="selectedInstanceId" class="sel wide" :disabled="!instances.instances.value.length">
          <option v-if="!instances.instances.value.length" :value="null">— no instances —</option>
          <option v-for="inst in instances.instances.value" :key="inst.id" :value="inst.id">
            {{ inst.name }}
          </option>
        </select>
      </div>

      <div class="side-head between">
        <span>Network tasks</span>
        <div class="side-head-actions">
          <button
            class="btn-refresh"
            :class="{ spinning: tasksLoading }"
            :disabled="!serviceId || tasksLoading"
            :title="!serviceId ? 'Pick a service' : tasksLoading ? 'Refreshing…' : 'Refresh task list'"
            aria-label="Refresh task list"
            @click="refreshTasks"
          ><Icon name="refresh" :size="11" /></button>
          <button
            class="btn-new"
            :disabled="!selectedInstanceId"
            @click="showNewTask = true"
          >+ New Task</button>
        </div>
      </div>
      <div v-if="polling" class="poll-hint">Waiting for new task… ({{ pollRound }}/4)</div>
      <div v-if="tasksError" class="side-err">{{ tasksError }}</div>
      <div v-else-if="tasksLoading && !tasks.length" class="side-empty">Loading…</div>
      <div v-else-if="!tasks.length" class="side-empty">
        {{ serviceId ? 'No network tasks for this service.' : 'Pick a service to load tasks.' }}
      </div>
      <ul v-else class="side-list">
        <li
          v-for="t in tasks"
          :key="t.taskId"
          :class="{ 'is-active': currentTask?.taskId === t.taskId }"
          @click="currentTask = t"
        >
          <div class="row1">
            <span class="t-tag net">NETWORK</span>
            <span class="ep">{{ t.serviceInstanceName || t.taskId.slice(0, 12) }}</span>
          </div>
          <div class="row2">
            <span>{{ fmtTime(t.taskStartTime) }}</span>
          </div>
        </li>
      </ul>
    </div>

    <!-- Main: topology + detail -->
    <div class="net-main">
      <div class="filter-bar">
        <div class="tb-block">
          <label class="lbl">Window</label>
          <select v-model.number="windowMinutes" class="sel" @change="loadTopology">
            <option :value="5">5 min</option>
            <option :value="15">15 min</option>
            <option :value="30">30 min</option>
            <option :value="60">1 hr</option>
            <option :value="180">3 hr</option>
          </select>
        </div>
        <span class="spacer"></span>
        <span class="muted" v-if="!topologyLoading">{{ nodes.length }} processes · {{ calls.length }} edges</span>
        <span v-if="topologyLoading" class="muted">loading topology…</span>
      </div>

      <div v-if="topologyError" class="banner err">{{ topologyError }}</div>

      <div class="topology">
        <ProcessTopologyGraph
          v-if="nodes.length"
          :nodes="nodes"
          :calls="calls"
          @select-call="onSelectCall"
        />
        <div v-else-if="!topologyLoading" class="topology-empty">
          {{ selectedInstanceId
            ? 'No process topology data in the selected window. Create a network profile task and let it run, then refresh.'
            : 'Pick an instance to view its process topology.' }}
        </div>
      </div>
    </div>
  </div>

  <!-- Edge dashboard — a large modal showing the full process-relation
       metric dashboard (client + server) for the clicked conversation. -->
  <div v-if="selectedCall" class="dlg-mask" @click.self="closeEdge">
    <div class="dlg edge-dlg">
      <div class="dlg-head">
        <div class="edge-dlg-title">
          <span class="mono">{{ sourceProcessName }}</span>
          <span class="muted">→</span>
          <span class="mono">{{ targetProcessName }}</span>
          <span v-if="selectedCall.detectPoints?.length" class="dp-chip">{{ selectedCall.detectPoints.join(' · ') }}</span>
        </div>
        <button class="x" @click="closeEdge">×</button>
      </div>
      <div class="dlg-body edge-dlg-body">
        <div v-if="relationLoading" class="muted">Reading process-relation metrics…</div>
        <div v-else-if="relationError" class="banner err">{{ relationError }}</div>
        <!-- Left/right split: client side | server side. Each column
             stacks its metric widgets; matching ids line up row-for-row.
             The metric set is operator-configurable in the admin. -->
        <div v-else-if="relationMetrics" class="edge-cols">
          <section
            v-for="side in (['client', 'server'] as const)"
            :key="side"
            class="edge-col"
          >
            <h5 class="edge-col-head" :class="side">{{ side === 'client' ? 'Client side' : 'Server side' }}</h5>
            <div v-if="!relationMetrics[side].length" class="muted sm">No {{ side }} metrics configured.</div>
            <div v-else class="edge-col-grid">
              <div v-for="m in relationMetrics[side]" :key="m.id" class="edge-widget sw-card">
                <div class="ew-head">
                  <span class="ew-label">{{ m.label }}</span>
                  <span class="ew-val mono">{{ fmtMetric(latestValue(m.values), m.unit) }}</span>
                </div>
                <TimeChart
                  :series="[{ label: m.label, data: m.values, unit: m.unit }]"
                  :x-labels="edgeXLabels"
                  :height="150"
                  :unit="m.unit"
                />
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  </div>

  <div v-if="showNewTask" class="dlg-mask" @click.self="showNewTask = false">
    <div class="dlg wide">
      <div class="dlg-head">
        <div>New network profile task</div>
        <button class="x" @click="showNewTask = false">×</button>
      </div>
      <div class="dlg-body">
        <p class="hint">
          OAP captures one connection sample per matching rule. Leave URI
          empty to match any request; toggle 4xx/5xx to scope by status.
        </p>
        <div v-for="(s, i) in samplings" :key="i" class="sampling">
          <div class="sampling-head">
            <strong>Sampling rule {{ i + 1 }}</strong>
            <button
              v-if="samplings.length > 1"
              class="del"
              type="button"
              @click="removeSampling(i)"
            >× remove</button>
          </div>
          <div class="field-row">
            <div class="field grow">
              <label>URI regex (optional)</label>
              <input class="ti-input wide" v-model="s.uriRegex" placeholder="e.g. ^/api/.*" />
            </div>
            <div class="field">
              <label>Min duration (ms)</label>
              <input class="ti-input" type="number" min="0" v-model.number="s.minDuration" />
            </div>
          </div>
          <div class="check-row">
            <label class="cb"><input type="checkbox" v-model="s.when4xx" /> when 4xx</label>
            <label class="cb"><input type="checkbox" v-model="s.when5xx" /> when 5xx</label>
            <label class="cb"><input type="checkbox" v-model="s.settings.requireCompleteRequest" /> capture request</label>
            <label class="cb"><input type="checkbox" v-model="s.settings.requireCompleteResponse" /> capture response</label>
          </div>
        </div>
        <button class="btn-secondary" type="button" @click="addSampling">+ add another sampling rule</button>
        <div v-if="newTaskError" class="dlg-err">{{ newTaskError }}</div>
      </div>
      <div class="dlg-foot">
        <button class="btn-secondary" @click="showNewTask = false">Cancel</button>
        <button class="btn-primary" @click="submitNewTask">Create task</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.net-shell {
  display: flex;
  height: calc(100vh - 280px);
  min-height: 520px;
  padding: 0;
  overflow: hidden;
}
.net-side {
  width: 310px;
  flex: 0 0 310px;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--sw-line);
}
.side-head {
  padding: 6px 10px;
  font-size: 11.5px;
  font-weight: 600;
  color: var(--sw-fg-1);
  background: var(--sw-bg-2);
  border-bottom: 1px solid var(--sw-line);
}
.side-head.between {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 0;
}
.picker {
  padding: 8px 10px;
  border-bottom: 1px solid var(--sw-line);
}
.btn-new {
  font-size: 10.5px;
  padding: 2px 8px;
  border-radius: 3px;
  border: 1px solid var(--sw-line-2);
  background: var(--sw-bg-1);
  color: var(--sw-fg-1);
  cursor: pointer;
}
.side-head-actions { display: inline-flex; align-items: center; gap: 6px; }
.btn-refresh {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 2px 6px;
  border-radius: 3px;
  border: 1px solid var(--sw-line-2);
  background: var(--sw-bg-1);
  color: var(--sw-fg-1);
  cursor: pointer;
  line-height: 0;
}
.btn-refresh:hover:not(:disabled) { border-color: var(--sw-accent); color: var(--sw-accent); }
.btn-refresh:disabled { opacity: 0.5; cursor: not-allowed; }
.btn-refresh.spinning :deep(svg) {
  animation: prof-refresh-spin 1.6s linear infinite;
  transform-origin: 50% 50%;
}
@keyframes prof-refresh-spin {
  to { transform: rotate(360deg); }
}
.btn-new:hover:not(:disabled) {
  border-color: var(--sw-accent);
  color: var(--sw-accent);
}
.btn-new:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.poll-hint {
  padding: 6px 10px;
  font-size: 10.5px;
  color: var(--sw-accent);
  background: var(--sw-bg-2);
  border-bottom: 1px solid var(--sw-line);
}
.side-err,
.side-empty {
  padding: 12px;
  font-size: 11.5px;
  color: var(--sw-fg-3);
  text-align: center;
}
.side-err {
  color: var(--sw-err);
}
.side-list {
  list-style: none;
  margin: 0;
  padding: 0;
  overflow-y: auto;
  flex: 1 1 0;
}
.side-list li {
  padding: 8px 10px;
  border-bottom: 1px solid var(--sw-line);
  cursor: pointer;
}
.side-list li:hover {
  background: var(--sw-bg-2);
}
.side-list li.is-active {
  background: var(--sw-bg-3, var(--sw-bg-2));
  border-left: 3px solid var(--sw-accent);
  padding-left: 7px;
}
.row1,
.row2 {
  display: flex;
  align-items: center;
  gap: 6px;
}
.row2 {
  margin-top: 4px;
  font-size: 10.5px;
  color: var(--sw-fg-2);
}
.t-tag {
  display: inline-block;
  font-size: 10px;
  padding: 0 5px;
  border-radius: 2px;
  background: var(--sw-accent);
  color: #fff;
  font-weight: 600;
}
.t-tag.net {
  background: #58a6ff;
}
.ep {
  font-size: 12px;
  color: var(--sw-fg-0);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.muted {
  color: var(--sw-fg-3);
}

.net-main {
  flex: 1 1 0;
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.filter-bar {
  display: flex;
  align-items: end;
  gap: 12px;
  padding: 8px 12px;
  background: var(--sw-bg-1);
  border-bottom: 1px solid var(--sw-line);
}
.tb-block {
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.lbl {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--sw-fg-3);
}
.sel,
.ti-input {
  background: var(--sw-bg-2);
  color: var(--sw-fg-0);
  border: 1px solid var(--sw-line);
  border-radius: 3px;
  padding: 4px 6px;
  font-size: 11.5px;
  font-family: var(--sw-mono);
  outline: none;
}
.sel.wide,
.ti-input.wide {
  width: 100%;
}
.btn-primary {
  background: var(--sw-accent);
  color: #fff;
  border: none;
  border-radius: 3px;
  padding: 6px 14px;
  font-size: 11.5px;
  font-weight: 600;
  cursor: pointer;
}
.btn-secondary {
  background: var(--sw-bg-2);
  color: var(--sw-fg-1);
  border: 1px solid var(--sw-line-2);
  border-radius: 3px;
  padding: 5px 12px;
  font-size: 11.5px;
  cursor: pointer;
}
.btn-secondary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.spacer {
  flex: 1 1 0;
}
.banner.err {
  padding: 6px 12px;
  font-size: 11px;
  color: var(--sw-err);
  background: var(--sw-bg-2);
  border-bottom: 1px solid var(--sw-line);
}
.topology {
  flex: 1 1 0;
  position: relative;
  min-height: 240px;
}
.topology-empty {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 11.5px;
  color: var(--sw-fg-3);
  padding: 20px;
  text-align: center;
}
.detail {
  border-top: 1px solid var(--sw-line);
  background: var(--sw-bg-1);
  padding: 8px 14px;
  max-height: 320px;
  overflow-y: auto;
}
.detail h5 {
  margin: 0 0 6px;
  font-size: 10.5px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--sw-fg-1);
}
.kv {
  display: grid;
  grid-template-columns: 130px 1fr;
  row-gap: 4px;
  font-size: 11.5px;
  margin: 0;
}
.kv dt {
  color: var(--sw-fg-3);
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  align-self: center;
}
.kv dd {
  margin: 0;
  color: var(--sw-fg-0);
}
.kv dd.mono {
  font-family: var(--sw-mono);
  font-size: 10.5px;
  color: var(--sw-fg-1);
}
/* Edge dashboard modal — near-fullscreen; client | server side-by-side,
   each side a 2-up widget grid → 4 widgets per row (2 client + 2 server). */
/* `.dlg.edge-dlg` (not `.edge-dlg`) so this beats the base `.dlg`
 * width:560px regardless of rule order. */
.dlg.edge-dlg { width: 92vw; max-width: 92vw; height: 92vh; max-height: 92vh; }
.edge-dlg-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--sw-fg-0);
}
.edge-dlg-title .mono { font-family: var(--sw-mono); }
.dp-chip {
  font-size: 9.5px;
  font-family: var(--sw-mono);
  color: var(--sw-fg-2);
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line);
  border-radius: 10px;
  padding: 1px 8px;
}
.edge-dlg-body { flex: 1 1 0; min-height: 0; overflow-y: auto; padding: 12px 14px; }
.edge-cols {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px;
  align-items: start;
}
.edge-col { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.edge-col-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}
.edge-col-head {
  margin: 0;
  padding-bottom: 6px;
  border-bottom: 2px solid var(--sw-line);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}
.edge-col-head.client { color: var(--sw-accent); border-bottom-color: var(--sw-accent); }
.edge-col-head.server { color: var(--sw-info, #5a9cf8); border-bottom-color: var(--sw-info, #5a9cf8); }
.edge-widget { padding: 8px 10px; }
.ew-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: 4px;
}
.ew-label { font-size: 11.5px; color: var(--sw-fg-1); font-weight: 600; }
.ew-val {
  font-size: 11.5px;
  color: var(--sw-fg-0);
  font-family: var(--sw-mono);
  font-variant-numeric: tabular-nums;
}

.dlg-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  z-index: 50;
  display: flex;
  align-items: center;
  justify-content: center;
}
.dlg {
  background: var(--sw-bg-1);
  border: 1px solid var(--sw-line);
  border-radius: 6px;
  width: 560px;
  max-width: 92vw;
  max-height: 90vh;
  display: flex;
  flex-direction: column;
}
.dlg.wide {
  width: 640px;
}
.dlg-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  border-bottom: 1px solid var(--sw-line);
  background: var(--sw-bg-2);
  font-weight: 600;
  font-size: 12.5px;
  color: var(--sw-fg-0);
}
.x {
  background: transparent;
  border: none;
  color: var(--sw-fg-3);
  font-size: 18px;
  cursor: pointer;
}
.dlg-body {
  padding: 14px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.hint {
  font-size: 11px;
  color: var(--sw-fg-2);
  margin: 0;
  line-height: 1.5;
}
.sampling {
  border: 1px solid var(--sw-line);
  border-radius: 4px;
  padding: 10px;
  background: var(--sw-bg-2);
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.sampling-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 11px;
  color: var(--sw-fg-1);
}
.sampling-head .del {
  background: transparent;
  border: none;
  color: var(--sw-err);
  cursor: pointer;
  font-size: 11px;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.field.grow {
  flex: 1 1 0;
}
.field label {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--sw-fg-3);
}
.field-row {
  display: flex;
  gap: 8px;
  align-items: end;
}
.check-row {
  display: flex;
  gap: 14px;
  flex-wrap: wrap;
  font-size: 11.5px;
  color: var(--sw-fg-1);
}
.cb {
  display: flex;
  align-items: center;
  gap: 4px;
  cursor: pointer;
}
.dlg-foot {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 10px 14px;
  border-top: 1px solid var(--sw-line);
}
.dlg-err {
  color: var(--sw-err);
  font-size: 11px;
}
</style>
