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
  Per-layer Async-profiler tab (Java only).

    ┌──────────────┬────────────────────────────────────────────────┐
    │ Task list    │ Toolbar: event-type · per-instance toggle row  │
    │ + New Task   ├────────────────────────────────────────────────┤
    │              │ Flame graph for the chosen event-type tree     │
    └──────────────┴────────────────────────────────────────────────┘
-->
<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { useLayerInstances } from '@/layer/useLayerInstances';
import { useSelectedService } from '@/layer/useSelectedService';
import { bffClient } from '@/api/client';
import type {
  AsyncProfilingEvent,
  AsyncProfilingTask,
  AsyncProfilingTree,
  ProfileAnalyzationTree,
} from '@/api/client';
import ProfileFlameGraph from '@/layer/profiling/ProfileFlameGraph.vue';
import { useNewTaskPoll } from '@/layer/profiling/useNewTaskPoll';
import Icon from '@/components/icons/Icon.vue';

const route = useRoute();
const layerKey = computed(() => String(route.params.layerKey ?? ''));
const { selectedId: serviceId } = useSelectedService();
const instances = useLayerInstances(layerKey, serviceId);

const tasks = ref<AsyncProfilingTask[]>([]);
const tasksError = ref<string | null>(null);
const currentTask = ref<AsyncProfilingTask | null>(null);
const tasksLoading = ref(false);

const selectedInstances = ref<string[]>([]);
const eventType = ref<string>('EXECUTION_SAMPLE');
const tree = ref<AsyncProfilingTree | null>(null);
const analyzeError = ref<string | null>(null);
const analyzeLoading = ref(false);

const showNewTask = ref(false);
const newTask = reactive({
  instances: [] as string[],
  duration: 60,
  events: ['CPU'] as AsyncProfilingEvent[],
  execArgs: '',
});
const newTaskError = ref<string | null>(null);
const { polling, pollRound, pollForNewTask } = useNewTaskPoll();

const DURATION_OPTS = [
  { v: 30, label: '30 sec' },
  { v: 60, label: '1 min' },
  { v: 300, label: '5 min' },
  { v: 600, label: '10 min' },
  { v: 900, label: '15 min' },
];
const EVENTS: AsyncProfilingEvent[] = ['CPU', 'ALLOC', 'LOCK', 'WALL', 'CTIMER', 'ITIMER'];

watch(
  () => layerKey.value + '|' + (serviceId.value ?? ''),
  () => void refreshTasks(),
  { immediate: true },
);

async function refreshTasks(): Promise<void> {
  tasksError.value = null;
  if (!serviceId.value) return;
  tasksLoading.value = true;
  try {
    const resp = await bffClient.asyncProfile.tasks(layerKey.value, serviceId.value);
    if (!resp.reachable && resp.error) tasksError.value = resp.error;
    tasks.value = resp.tasks ?? [];
    currentTask.value = tasks.value[0] ?? null;
    if (currentTask.value) syncInstancesFromTask(currentTask.value);
    tree.value = null;
  } catch (e) {
    tasksError.value = e instanceof Error ? e.message : String(e);
  } finally {
    tasksLoading.value = false;
  }
}

function syncInstancesFromTask(t: AsyncProfilingTask): void {
  selectedInstances.value = [...(t.serviceInstanceIds ?? [])];
  // default event type to the first one collectable from CPU-like
  const ev = t.events?.[0];
  if (ev === 'LOCK') eventType.value = 'LOCK';
  else if (ev === 'ALLOC') eventType.value = 'OBJECT_ALLOCATION_IN_NEW_TLAB';
  else eventType.value = 'EXECUTION_SAMPLE';
}

async function runAnalyze(): Promise<void> {
  if (!currentTask.value) return;
  if (!selectedInstances.value.length) {
    analyzeError.value = 'Select at least one instance.';
    return;
  }
  analyzeError.value = null;
  analyzeLoading.value = true;
  try {
    const resp = await bffClient.asyncProfile.analyze({
      taskId: currentTask.value.id,
      instanceIds: selectedInstances.value,
      eventType: eventType.value,
    });
    if (!resp.reachable && resp.error) analyzeError.value = resp.error;
    tree.value = resp.tree;
  } catch (e) {
    analyzeError.value = e instanceof Error ? e.message : String(e);
  } finally {
    analyzeLoading.value = false;
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

function toggleEvent(e: AsyncProfilingEvent): void {
  const i = newTask.events.indexOf(e);
  if (i === -1) newTask.events.push(e);
  else newTask.events.splice(i, 1);
}
function toggleInstance(id: string, dst: 'filter' | 'new'): void {
  const target = dst === 'filter' ? selectedInstances.value : newTask.instances;
  const i = target.indexOf(id);
  if (i === -1) target.push(id);
  else target.splice(i, 1);
}

async function submitNewTask(): Promise<void> {
  if (!serviceId.value) {
    newTaskError.value = 'Pick a service first';
    return;
  }
  if (!newTask.instances.length) {
    newTaskError.value = 'Pick at least one instance.';
    return;
  }
  if (!newTask.events.length) {
    newTaskError.value = 'Pick at least one event.';
    return;
  }
  newTaskError.value = null;
  const idsBefore = new Set(tasks.value.map((t) => t.id));
  try {
    const resp = await bffClient.asyncProfile.create(layerKey.value, {
      serviceId: serviceId.value,
      serviceInstanceIds: newTask.instances,
      duration: Number(newTask.duration),
      events: newTask.events,
      execArgs: newTask.execArgs || undefined,
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
  <div class="sw-card ap-shell">
    <div class="ap-side">
      <div class="side-head between">
        <span>Async profile tasks</span>
        <div class="side-head-actions">
          <button
            class="btn-refresh"
            :class="{ spinning: tasksLoading }"
            :disabled="!serviceId || tasksLoading"
            :title="!serviceId ? 'Pick a service first' : tasksLoading ? 'Refreshing…' : 'Refresh task list'"
            aria-label="Refresh task list"
            @click="refreshTasks"
          ><Icon name="refresh" :size="11" /></button>
          <button
            class="btn-new"
            :disabled="!serviceId"
            @click="showNewTask = true"
          >+ New Task</button>
        </div>
      </div>
      <div v-if="polling" class="poll-hint">Waiting for new task… ({{ pollRound }}/4)</div>
      <div v-if="tasksError" class="side-err">{{ tasksError }}</div>
      <div v-else-if="tasksLoading && !tasks.length" class="side-empty">Loading…</div>
      <div v-else-if="!tasks.length" class="side-empty">
        {{ serviceId ? 'No async profile tasks yet.' : 'Pick a service to load tasks.' }}
      </div>
      <ul v-else class="side-list">
        <li
          v-for="t in tasks"
          :key="t.id"
          :class="{ 'is-active': currentTask?.id === t.id }"
          @click="currentTask = t; syncInstancesFromTask(t); tree = null"
        >
          <div class="row1">
            <span class="t-tag">{{ t.events?.join(',') }}</span>
            <span class="ep">{{ t.serviceInstanceIds?.length ?? 0 }} instance{{ (t.serviceInstanceIds?.length ?? 0) === 1 ? '' : 's' }}</span>
          </div>
          <div class="row2">
            <span>{{ fmtTime(t.createTime) }}</span>
            <span class="muted">· {{ t.duration }}s</span>
          </div>
        </li>
      </ul>
    </div>

    <div class="ap-main">
      <div class="filter-bar">
        <div class="tb-block grow">
          <label class="lbl">Instances ({{ selectedInstances.length }} / {{ currentTask?.serviceInstanceIds?.length ?? 0 }})</label>
          <div class="chip-row">
            <button
              v-for="id in currentTask?.serviceInstanceIds ?? []"
              :key="id"
              class="chip"
              :class="{ on: selectedInstances.includes(id) }"
              :title="id"
              @click="toggleInstance(id, 'filter')"
            >{{ instanceName(id) }}</button>
            <span v-if="!currentTask" class="muted">Pick a task on the left.</span>
          </div>
        </div>
        <div class="tb-block">
          <label class="lbl">Event type</label>
          <select v-model="eventType" class="sel">
            <option value="EXECUTION_SAMPLE">EXECUTION_SAMPLE (CPU/Wall/Timer)</option>
            <option value="LOCK">LOCK</option>
            <option value="OBJECT_ALLOCATION_IN_NEW_TLAB">OBJECT_ALLOCATION_IN_NEW_TLAB</option>
            <option value="OBJECT_ALLOCATION_OUTSIDE_TLAB">OBJECT_ALLOCATION_OUTSIDE_TLAB</option>
            <option value="PROFILER_LIVE_OBJECT">PROFILER_LIVE_OBJECT</option>
          </select>
        </div>
        <button
          class="btn-primary"
          :disabled="analyzeLoading || !currentTask"
          @click="runAnalyze"
        >{{ analyzeLoading ? 'Analyzing…' : 'Analyze' }}</button>
      </div>
      <div v-if="analyzeError" class="banner err">{{ analyzeError }}</div>

      <div class="result">
        <ProfileFlameGraph
          v-if="profileTrees.length"
          :trees="profileTrees"
          metric-key="count"
        />
        <div v-else-if="!analyzeLoading" class="result-empty">
          {{ currentTask ? 'Pick instances + event type, then click Analyze.' : 'Select a task to inspect its async profile.' }}
        </div>
      </div>
    </div>
  </div>

  <div v-if="showNewTask" class="dlg-mask" @click.self="showNewTask = false">
    <div class="dlg">
      <div class="dlg-head">
        <div>New async profile task</div>
        <button class="x" @click="showNewTask = false">×</button>
      </div>
      <div class="dlg-body">
        <div class="field">
          <label>Instances</label>
          <div class="chip-row">
            <button
              v-for="i in instances.instances.value"
              :key="i.id"
              type="button"
              class="chip"
              :class="{ on: newTask.instances.includes(i.id) }"
              @click="toggleInstance(i.id, 'new')"
            >{{ i.name }}</button>
            <span v-if="!instances.instances.value.length" class="muted">No instances available.</span>
          </div>
        </div>
        <div class="field-row">
          <div class="field">
            <label>Duration</label>
            <select v-model.number="newTask.duration" class="sel">
              <option v-for="o in DURATION_OPTS" :key="o.v" :value="o.v">{{ o.label }}</option>
            </select>
          </div>
          <div class="field grow">
            <label>Exec args (async-profiler -e flags)</label>
            <input class="ti-input wide" v-model="newTask.execArgs" placeholder="e.g. interval=10000000,jstackdepth=2048" />
          </div>
        </div>
        <div class="field">
          <label>Events</label>
          <div class="chip-row">
            <button
              v-for="e in EVENTS"
              :key="e"
              type="button"
              class="chip"
              :class="{ on: newTask.events.includes(e) }"
              @click="toggleEvent(e)"
            >{{ e }}</button>
          </div>
        </div>
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
.ap-shell {
  display: flex;
  height: calc(100vh - 200px);
  min-height: 520px;
  padding: 0;
  overflow: hidden;
}
.ap-side {
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
  color: var(--sw-fg-1);
  background: var(--sw-bg-2);
  border-bottom: 1px solid var(--sw-line);
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
  background: var(--sw-accent);
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
.muted {
  color: var(--sw-fg-3);
}

.ap-main {
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
  min-width: 0;
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
.sel,
.ti-input,
.ti-input.wide {
  background: var(--sw-bg-2);
  color: var(--sw-fg-0);
  border: 1px solid var(--sw-line);
  border-radius: 3px;
  padding: 4px 6px;
  font-size: 11.5px;
  font-family: var(--sw-mono);
  outline: none;
}
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
.field.grow {
  flex: 1 1 0;
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
