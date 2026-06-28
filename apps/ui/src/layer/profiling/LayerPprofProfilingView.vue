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
  Per-layer pprof (Go) profiling tab. Mirrors the async-profiler view
  shape since OAP's pprof entry points use the same task / progress /
  analyze contract; the only practical differences are:
    - Event types are pprof-flavoured strings (`CPU`, `HEAP`, `BLOCK`,
      `GOROUTINE`, `MUTEX`, `ALLOCS`, `THREADCREATE`).
    - A `dumpPeriod` (sampling tick) is captured per task.
    - Result graph is a SINGLE tree (no per-event split).
-->
<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute } from 'vue-router';
import { useLayerInstances } from '@/layer/useLayerInstances';
import { useLayerServices } from '@/layer/useLayerServices';
import { useSelectedService } from '@/layer/useSelectedService';
import { bffClient } from '@/api/client';
import type {
  AsyncProfilingProgressLog,
  PprofTask,
  PprofTree,
  ProfileAnalyzationTree,
} from '@/api/client';
import ProfileFlameGraph from '@/layer/profiling/ProfileFlameGraph.vue';
import PprofTaskDetailModal from '@/layer/profiling/PprofTaskDetailModal.vue';
import { useNewTaskPoll } from '@/layer/profiling/useNewTaskPoll';
import Icon from '@/components/icons/Icon.vue';
import { useEscapeToClose } from '@/components/primitives/useEscapeToClose';

const { t } = useI18n();
const route = useRoute();
const layerKey = computed(() => String(route.params.layerKey ?? ''));
const { selectedId: serviceId } = useSelectedService();
const instances = useLayerInstances(layerKey, serviceId);
const { services } = useLayerServices(layerKey);
const serviceName = computed<string | null>(
  () => services.value.find((s) => s.id === serviceId.value)?.name ?? null,
);

const tasks = ref<PprofTask[]>([]);
const tasksError = ref<string | null>(null);
const currentTask = ref<PprofTask | null>(null);
const tasksLoading = ref(false);

const selectedInstances = ref<string[]>([]);
const tree = ref<PprofTree | null>(null);
const analyzeError = ref<string | null>(null);
const analyzeLoading = ref(false);

// Track the operator's open task-detail modal independently of the
// "current selected task" — opening the detail icon mustn't reset the
// selected instances / analyze result.
const taskDetailFor = ref<PprofTask | null>(null);
const taskDetailLogs = ref<AsyncProfilingProgressLog[]>([]);

const showNewTask = ref(false);
useEscapeToClose(() => showNewTask.value, () => (showNewTask.value = false));
const newTask = reactive({
  instances: [] as string[],
  // OAP measures pprof duration in MINUTES (capped at 15).
  duration: 5,
  // pprof takes exactly ONE event per task (OAP's PprofEventType is a
  // scalar enum, not a list).
  event: 'CPU',
  // Sampling rate for BLOCK (ns/sample) / MUTEX (occurrences/sample);
  // 1 samples every event.
  dumpPeriod: 1,
});
const newTaskError = ref<string | null>(null);
const { polling, countdown, pollForNewTask } = useNewTaskPoll();

const PPROF_EVENTS = ['CPU', 'HEAP', 'BLOCK', 'GOROUTINE', 'MUTEX', 'ALLOCS', 'THREADCREATE'];
// Per OAP: duration applies to CPU/BLOCK/MUTEX; dumpPeriod to BLOCK/MUTEX.
const DURATION_REQUIRED = ['CPU', 'BLOCK', 'MUTEX'];
const DUMP_PERIOD_REQUIRED = ['BLOCK', 'MUTEX'];
const newNeedsDuration = computed(() => DURATION_REQUIRED.includes(newTask.event));
const newNeedsDumpPeriod = computed(() => DUMP_PERIOD_REQUIRED.includes(newTask.event));
// Values are MINUTES — OAP rejects pprof durations over 15 minutes.
const DURATION_OPTS = [
  { v: 1, label: '1 min' },
  { v: 5, label: '5 min' },
  { v: 10, label: '10 min' },
  { v: 15, label: '15 min' },
];

watch(
  () => layerKey.value + '|' + (serviceId.value ?? ''),
  () => {
    taskDetailFor.value = null; // drop the detail modal on context change
    void refreshTasks();
  },
  { immediate: true },
);

async function refreshTasks(): Promise<void> {
  tasksError.value = null;
  if (!serviceId.value) return;
  tasksLoading.value = true;
  try {
    const resp = await bffClient.pprof.tasks(layerKey.value, serviceId.value);
    if (!resp.reachable && resp.error) tasksError.value = resp.error;
    tasks.value = resp.tasks ?? [];
    currentTask.value = tasks.value[0] ?? null;
    if (currentTask.value) {
      selectedInstances.value = [...(currentTask.value.serviceInstanceIds ?? [])];
    }
    tree.value = null;
  } catch (e) {
    tasksError.value = e instanceof Error ? e.message : String(e);
  } finally {
    tasksLoading.value = false;
  }
}

async function runAnalyze(): Promise<void> {
  if (!currentTask.value || !selectedInstances.value.length) return;
  analyzeError.value = null;
  analyzeLoading.value = true;
  try {
    const resp = await bffClient.pprof.analyze({
      taskId: currentTask.value.id,
      instanceIds: selectedInstances.value,
    });
    if (!resp.reachable && resp.error) analyzeError.value = resp.error;
    tree.value = resp.tree;
  } catch (e) {
    analyzeError.value = e instanceof Error ? e.message : String(e);
  } finally {
    analyzeLoading.value = false;
  }
}

async function openTaskDetail(t: PprofTask, ev: Event): Promise<void> {
  ev.stopPropagation();
  taskDetailFor.value = t;
  taskDetailLogs.value = [];
  try {
    const resp = await bffClient.pprof.progress(t.id);
    if (taskDetailFor.value?.id !== t.id) return; // stale: another task opened mid-fetch
    taskDetailLogs.value = resp.progress?.logs ?? [];
  } catch {
    if (taskDetailFor.value?.id === t.id) taskDetailLogs.value = [];
  }
}

const profileTrees = computed<ProfileAnalyzationTree[]>(() => {
  if (!tree.value) return [];
  return [
    {
      elements: tree.value.elements.map((el) => ({
        id: el.id,
        parentId: el.parentId,
        codeSignature: el.symbol,
        count: el.dumpCount,
        duration: el.dumpCount,
        durationChildExcluded: el.self,
      })),
    },
  ];
});

function toggleInstance(id: string, dst: 'filter' | 'new'): void {
  const target = dst === 'filter' ? selectedInstances.value : newTask.instances;
  const i = target.indexOf(id);
  if (i === -1) target.push(id);
  else target.splice(i, 1);
}

async function submitNewTask(): Promise<void> {
  if (!serviceId.value || !newTask.instances.length || !newTask.event) {
    newTaskError.value = 'Pick a service, instances, and an event.';
    return;
  }
  newTaskError.value = null;
  const idsBefore = new Set(tasks.value.map((t) => t.id));
  try {
    const resp = await bffClient.pprof.create(layerKey.value, {
      serviceId: serviceId.value,
      serviceInstanceIds: newTask.instances,
      events: newTask.event,
      ...(newNeedsDuration.value ? { duration: Number(newTask.duration) } : {}),
      ...(newNeedsDumpPeriod.value ? { dumpPeriod: Number(newTask.dumpPeriod) } : {}),
    });
    if (resp.errorReason) {
      newTaskError.value = resp.errorReason;
      return;
    }
    showNewTask.value = false;
    await refreshTasks();
    await pollForNewTask({
      idsBefore,
      refresh: refreshTasks,
      currentIds: () => tasks.value.map((t) => t.id),
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
function instanceName(id: string): string {
  return instances.instances.value.find((i) => i.id === id)?.name ?? id;
}
</script>

<template>
  <div class="sw-card pp-shell">
    <div class="pp-side">
      <div class="side-head between">
        <span>pprof tasks</span>
        <div class="side-head-actions">
          <button
            class="btn-refresh"
            :class="{ spinning: tasksLoading }"
            :disabled="!serviceId || tasksLoading"
            :title="!serviceId ? 'Pick a service first' : tasksLoading ? 'Refreshing…' : 'Refresh task list'"
            aria-label="Refresh task list"
            @click="refreshTasks"
          ><Icon name="refresh" :size="11" /></button>
          <button class="btn-new" :disabled="!serviceId" :title="serviceId ? 'Create a new pprof task' : 'Pick a service first'" @click="showNewTask = true">+ New Task</button>
        </div>
      </div>
      <div v-if="polling" class="poll-hint">Registering new task… refreshing in {{ countdown }}s</div>
      <div v-if="tasksError" class="side-err">{{ tasksError }}</div>
      <div v-else-if="tasksLoading && !tasks.length" class="side-empty">Loading…</div>
      <div v-else-if="!tasks.length" class="side-empty">
        {{ serviceId ? 'No pprof tasks. pprof works with Go services only.' : 'Pick a service to load tasks.' }}
      </div>
      <ul v-else class="side-list">
        <li
          v-for="t in tasks"
          :key="t.id"
          :class="{ 'is-active': currentTask?.id === t.id }"
          @click="currentTask = t; selectedInstances = [...(t.serviceInstanceIds ?? [])]; tree = null"
        >
          <div class="row1">
            <span class="t-tag">{{ t.events }}</span>
            <span class="ep">{{ t.serviceInstanceIds?.length ?? 0 }} instance{{ (t.serviceInstanceIds?.length ?? 0) === 1 ? '' : 's' }}</span>
            <button
              type="button"
              class="row-eye"
              title="View task detail"
              @click.stop="openTaskDetail(t, $event)"
            >i</button>
          </div>
          <div class="row2">
            <span>{{ fmtTime(t.createTime) }}</span>
            <span class="muted">
              <template v-if="t.duration != null">· {{ t.duration }}min</template>
              <template v-if="t.dumpPeriod != null"> · rate {{ t.dumpPeriod }}</template>
            </span>
          </div>
        </li>
      </ul>
    </div>

    <div class="pp-main">
      <div class="filter-bar">
        <div class="tb-block grow">
          <label class="lbl">Instances ({{ selectedInstances.length }} / {{ currentTask?.serviceInstanceIds?.length ?? 0 }})</label>
          <div class="chip-row">
            <button
              v-for="id in currentTask?.serviceInstanceIds ?? []"
              :key="id"
              class="chip"
              :class="{ on: selectedInstances.includes(id) }"
              @click="toggleInstance(id, 'filter')"
            >{{ instanceName(id) }}</button>
            <span v-if="!currentTask" class="muted">Pick a task on the left.</span>
          </div>
        </div>
        <div class="tb-block">
          <label class="lbl">Event</label>
          <span class="event-fixed">{{ currentTask?.events ?? '—' }}</span>
        </div>
        <button class="btn-primary" :disabled="analyzeLoading || !currentTask || !selectedInstances.length" :title="!selectedInstances.length ? 'Select at least one instance' : 'Analyze the selected instances'" @click="runAnalyze">
          {{ analyzeLoading ? 'Analyzing…' : 'Analyze' }}
        </button>
      </div>
      <div v-if="analyzeError" class="banner err">{{ analyzeError }}</div>
      <div class="result">
        <ProfileFlameGraph v-if="profileTrees.length" :trees="profileTrees" metric-key="count" />
        <div v-else-if="!analyzeLoading" class="result-empty">
          {{ currentTask ? 'Pick instances, then click Analyze.' : 'Select a task.' }}
        </div>
      </div>
    </div>
  </div>

  <div v-if="showNewTask" class="dlg-mask" @click.self="showNewTask = false">
    <div class="dlg">
      <div class="dlg-head">
        <div>New pprof task</div>
        <button class="x" @click="showNewTask = false">×</button>
      </div>
      <div class="dlg-body">
        <div class="field">
          <label>Instances (Go services only)</label>
          <div class="chip-row">
            <button
              v-for="i in instances.instances.value"
              :key="i.id"
              type="button"
              class="chip"
              :class="{ on: newTask.instances.includes(i.id) }"
              @click="toggleInstance(i.id, 'new')"
            >{{ i.name }}</button>
            <span v-if="!instances.instances.value.length" class="muted">{{ t('No instances available for this service — a pprof task cannot be created.') }}</span>
          </div>
        </div>
        <div class="field">
          <label>Event (one per task)</label>
          <div class="chip-row">
            <button
              v-for="e in PPROF_EVENTS"
              :key="e"
              type="button"
              class="chip"
              :class="{ on: newTask.event === e }"
              @click="newTask.event = e"
            >{{ e }}</button>
          </div>
        </div>
        <div class="field-row">
          <div v-if="newNeedsDuration" class="field">
            <label>Duration</label>
            <select v-model.number="newTask.duration" class="sel">
              <option v-for="o in DURATION_OPTS" :key="o.v" :value="o.v">{{ o.label }}</option>
            </select>
          </div>
          <div v-if="newNeedsDumpPeriod" class="field">
            <label>Dump period (rate)</label>
            <input type="number" min="1" v-model.number="newTask.dumpPeriod" class="ti-input" />
            <span class="hint">
              {{ newTask.event === 'BLOCK'
                ? 'Blocked-ns sampling rate; 1 samples every event.'
                : 'Contention-occurrences sampling rate; 1 samples every event.' }}
            </span>
          </div>
        </div>
        <div v-if="newTaskError" class="dlg-err">{{ newTaskError }}</div>
      </div>
      <div class="dlg-foot">
        <button class="btn-secondary" @click="showNewTask = false">Cancel</button>
        <button
          class="btn-primary"
          :disabled="!newTask.instances.length || !newTask.event"
          :title="!newTask.instances.length ? 'Select at least one instance' : !newTask.event ? 'Pick an event type' : 'Create the pprof task'"
          @click="submitNewTask"
        >Create task</button>
      </div>
    </div>
  </div>

  <PprofTaskDetailModal
    :task="taskDetailFor"
    :service-name="serviceName"
    :logs="taskDetailLogs"
    :fmt-time="fmtTime"
    @close="taskDetailFor = null"
  />
</template>

<style scoped>
.pp-shell {
  display: flex;
  height: calc(100vh - 200px);
  min-height: 520px;
  padding: 0;
  overflow: hidden;
}
.pp-side {
  width: 320px;
  flex: 0 0 320px;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--sw-line);
}
.side-head {
  padding: 6px 10px;
  font-size: 11.5px;
  font-weight: 600;
  background: var(--sw-bg-2);
  border-bottom: 1px solid var(--sw-line);
  color: var(--sw-fg-1);
}
.side-head.between {
  display: flex;
  align-items: center;
  justify-content: space-between;
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
  text-align: center;
  font-size: 11.5px;
  color: var(--sw-fg-3);
}
.side-err {
  color: var(--sw-err);
}
.side-list {
  list-style: none;
  margin: 0;
  padding: 0;
  flex: 1 1 0;
  overflow-y: auto;
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
  font-size: 10px;
  padding: 0 5px;
  border-radius: 2px;
  background: #6c5cd9;
  color: #fff;
  font-weight: 600;
}
.ep {
  font-size: 12px;
  color: var(--sw-fg-0);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.row-eye {
  margin-left: auto;
  background: transparent;
  border: none;
  color: var(--sw-fg-3);
  cursor: pointer;
  padding: 0;
  font-style: italic;
  line-height: 1;
}
.row-eye:hover {
  color: var(--sw-accent);
}
.muted {
  color: var(--sw-fg-3);
}

.pp-main {
  flex: 1 1 0;
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.filter-bar {
  display: flex;
  gap: 12px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--sw-line);
  align-items: end;
  flex-wrap: wrap;
}
.tb-block {
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.tb-block.grow {
  flex: 1 1 auto;
}
.lbl {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--sw-fg-3);
}
.chip-row {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
  align-items: center;
  min-height: 26px;
}
.chip {
  font-size: 11px;
  padding: 3px 9px;
  border-radius: 12px;
  border: 1px solid var(--sw-line-2);
  background: var(--sw-bg-2);
  color: var(--sw-fg-1);
  cursor: pointer;
}
.chip.on {
  background: var(--sw-accent);
  border-color: var(--sw-accent);
  color: #fff;
}
.event-fixed {
  font-size: 11.5px;
  font-family: var(--sw-mono);
  color: var(--sw-fg-0);
  padding: 4px 0;
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
.btn-primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
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
.banner.err {
  padding: 6px 12px;
  font-size: 11px;
  color: var(--sw-err);
  background: var(--sw-bg-2);
  border-bottom: 1px solid var(--sw-line);
}
.result {
  flex: 1 1 0;
  min-height: 0;
  position: relative;
  overflow: hidden;
}
.result-empty {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--sw-fg-3);
  font-size: 12px;
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
.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 11.5px;
}
.field label {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--sw-fg-3);
}
.field .hint {
  font-size: 10px;
  color: var(--sw-fg-3);
  text-transform: none;
  letter-spacing: 0;
  line-height: 1.4;
}
.field-row {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}
.field-row .field {
  min-width: 130px;
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
