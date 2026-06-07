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
  Per-layer Trace Profiling tab — feature parity with the booster-ui
  `dashboard/related/profile` widget. Layout:

    ┌───────────────┬──────────────────────────────────────────────┐
    │  Task list    │   Trace-ID + display-mode + analyze toolbar  │
    │  (top)        │   Span table  (top half of the right pane)   │
    │  ▸ New Task ┼─                                            ─│
    │  Segments     │   Tree / Flame visualization (bottom half)   │
    │  (bottom)     │                                              │
    └───────────────┴──────────────────────────────────────────────┘

  The widget binds to the URL-selected service. Operators kick off a
  new profile task with the ▸ New Task chip; once OAP fans the task
  out to instances and sampled segments come back, the operator clicks
  a segment to load its spans, picks a profiled span, hits Analyze,
  and inspects the resulting call tree as either an indented stack
  table or a flame graph.
-->
<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { useLayers } from '@/shell/useLayers';
import { useLayerEndpoints } from '@/layer/useLayerEndpoints';
import { useSelectedService } from '@/layer/useSelectedService';
import { useLayerLanding } from '@/layer/useLayerLanding';
import { useLayerServiceName } from '@/layer/useLayerServiceName';
import { useSetupStore } from '@/state/setup';
import { bffClient } from '@/api/client';
import type {
  LayerDef,
  ProfileAnalyzationTree,
  ProfileAnalyzeQuery,
  ProfileSegment,
  ProfileSpan,
  ProfileTask,
  ProfileTaskLog,
  ProfileTimeRange,
} from '@/api/client';
import ProfileStackTable from '@/layer/profiling/ProfileStackTable.vue';
import ProfileFlameGraph from '@/layer/profiling/ProfileFlameGraph.vue';
import NativeTraceWaterfall from '@/layer/traces/NativeTraceWaterfall.vue';
import { useNewTaskPoll } from '@/layer/profiling/useNewTaskPoll';
import Icon from '@/components/icons/Icon.vue';

const route = useRoute();
const layerKey = computed(() => String(route.params.layerKey ?? ''));
const { layers } = useLayers();
const layer = computed<LayerDef | null>(
  () => layers.value.find((l) => l.key === layerKey.value) ?? null,
);

// Reuse the landing feed to resolve the URL `?service=` id back to a
// human name for the topbar — same trick the Logs / Traces tabs use.
const safeLayer = computed<LayerDef>(
  () =>
    layer.value ?? {
      key: layerKey.value,
      name: layerKey.value,
      color: 'var(--sw-fg-2)',
      serviceCount: -1,
      active: false,
      level: null,
      slots: {},
      caps: {},
    },
);
const store = useSetupStore();
const safeCfg = computed(() => {
  if (!layer.value)
    return { priority: 99, topN: 5, orderBy: 'cpm', columns: [], style: 'table' as const };
  return store.ensure(layer.value.key, {
    slots: layer.value.slots,
    caps: layer.value.caps,
    metrics: layer.value.metrics,
    overview: layer.value.overview,
  }).landing;
});
const landing = useLayerLanding(safeLayer, safeCfg);
const { selectedId } = useSelectedService();
const serviceName = useLayerServiceName(layerKey, landing);

// ── Task list + segments ────────────────────────────────────────────
const tasks = ref<ProfileTask[]>([]);
const tasksError = ref<string | null>(null);
const tasksLoading = ref(false);
const currentTask = ref<ProfileTask | null>(null);
const { polling, pollRound, pollForNewTask } = useNewTaskPoll();

const segments = ref<ProfileSegment[]>([]);
const segmentsLoading = ref(false);
const segmentsError = ref<string | null>(null);
const currentSegment = ref<ProfileSegment | null>(null);

const segmentSpans = computed<ProfileSpan[]>(() => currentSegment.value?.spans ?? []);
const currentSpan = ref<ProfileSpan | null>(null);

// Track the operator's open task-detail modal independently of the
// "current selected task" — opening the eye icon mustn't swap the
// segment list out.
const taskDetailFor = ref<ProfileTask | null>(null);
const taskDetailLogs = ref<ProfileTaskLog[]>([]);

// ── Analyze result ──────────────────────────────────────────────────
const analyzeTrees = ref<ProfileAnalyzationTree[]>([]);
const analyzeLoading = ref(false);
const analyzeMessage = ref('');
const displayMode = ref<'tree' | 'flame'>('tree');
const dataMode = ref<'include' | 'exclude'>('include');
const highlightTop = ref(true);

watch(
  () => layerKey.value + '|' + (selectedId.value ?? ''),
  () => {
    void refreshTasks();
  },
  { immediate: true },
);

async function refreshTasks(): Promise<void> {
  tasksError.value = null;
  if (!selectedId.value) {
    tasks.value = [];
    currentTask.value = null;
    segments.value = [];
    currentSegment.value = null;
    return;
  }
  tasksLoading.value = true;
  try {
    const resp = await bffClient.profile.tasks(layerKey.value, selectedId.value);
    if (!resp.reachable && resp.error) tasksError.value = resp.error;
    tasks.value = resp.tasks ?? [];
    if (tasks.value.length) {
      await pickTask(tasks.value[0]);
    } else {
      currentTask.value = null;
      segments.value = [];
      currentSegment.value = null;
      analyzeTrees.value = [];
    }
  } catch (e) {
    tasksError.value = e instanceof Error ? e.message : String(e);
  } finally {
    tasksLoading.value = false;
  }
}

async function pickTask(t: ProfileTask): Promise<void> {
  currentTask.value = t;
  analyzeTrees.value = [];
  segments.value = [];
  currentSegment.value = null;
  currentSpan.value = null;
  segmentsLoading.value = true;
  segmentsError.value = null;
  try {
    const resp = await bffClient.profile.segments(t.id);
    if (!resp.reachable && resp.error) segmentsError.value = resp.error;
    segments.value = resp.segments ?? [];
    if (segments.value.length) {
      pickSegment(segments.value[0]);
    }
  } catch (e) {
    segmentsError.value = e instanceof Error ? e.message : String(e);
  } finally {
    segmentsLoading.value = false;
  }
}

function pickSegment(s: ProfileSegment): void {
  currentSegment.value = s;
  // Stamp the traceId onto each span so the span table can deep-link
  // back to the trace explorer without re-fetching.
  for (const sp of s.spans ?? []) sp.traceId = s.traceId;
  // Default-select the deepest (=last) span so analyze is one click away.
  currentSpan.value = s.spans?.length ? s.spans[s.spans.length - 1] : null;
  analyzeTrees.value = [];
}

async function openTaskDetail(t: ProfileTask, ev: Event): Promise<void> {
  ev.stopPropagation();
  taskDetailFor.value = t;
  taskDetailLogs.value = [];
  try {
    const resp = await bffClient.profile.logs(t.id);
    taskDetailLogs.value = resp.logs ?? [];
  } catch {
    taskDetailLogs.value = [];
  }
}

// ── Analyze ─────────────────────────────────────────────────────────
function timeRangesFor(span: ProfileSpan): ProfileTimeRange[] {
  if (dataMode.value === 'include') {
    return [{ start: span.startTime, end: span.endTime }];
  }
  const children = span.children ?? [];
  if (!children.length) return [{ start: span.startTime, end: span.endTime }];
  let ranges: ProfileTimeRange[] = [];
  for (const c of children) {
    ranges.push({ start: span.startTime, end: c.startTime });
    ranges.push({ start: c.endTime, end: span.endTime });
  }
  ranges = ranges.reduce<ProfileTimeRange[]>((acc, cur) => {
    let merged = false;
    for (const r of acc) {
      if (cur.start <= r.end && r.start <= cur.start) {
        r.start = Math.max(r.start, cur.start);
        r.end = Math.min(r.end, cur.end);
        merged = true;
      }
    }
    if (!merged) acc.push(cur);
    return acc;
  }, []);
  return ranges.filter((r) => r.start !== r.end);
}

async function runAnalyze(): Promise<void> {
  const span = currentSpan.value;
  if (!span?.profiled) {
    analyzeMessage.value = "It's a un-profiled span";
    return;
  }
  analyzeMessage.value = '';
  analyzeLoading.value = true;
  try {
    const queries: ProfileAnalyzeQuery[] = timeRangesFor(span).map((tr) => ({
      segmentId: span.segmentId,
      timeRange: tr,
    }));
    const resp = await bffClient.profile.analyze(queries);
    if (resp.tip) {
      analyzeMessage.value = resp.tip;
      analyzeTrees.value = [];
    } else {
      analyzeTrees.value = resp.trees ?? [];
    }
    if (!resp.reachable && resp.error) analyzeMessage.value = resp.error;
  } catch (e) {
    analyzeMessage.value = e instanceof Error ? e.message : String(e);
  } finally {
    analyzeLoading.value = false;
  }
}

// ── New Task dialog ─────────────────────────────────────────────────
const showNewTask = ref(false);
const taskCreateError = ref<string | null>(null);
const endpointKeyword = ref('');
const endpointLimit = ref(20);
const endpointPicks = useLayerEndpoints(layerKey, selectedId, endpointKeyword, endpointLimit);
const newTask = reactive({
  endpointName: '',
  monitorTime: 'now' as 'now' | 'set',
  monitorTimeAt: new Date(),
  monitorDuration: 5,
  minThreshold: 0,
  dumpPeriod: 10,
  maxSamplingCount: 5,
});
function resetNewTask(): void {
  newTask.endpointName = '';
  newTask.monitorTime = 'now';
  newTask.monitorTimeAt = new Date();
  newTask.monitorDuration = 5;
  newTask.minThreshold = 0;
  newTask.dumpPeriod = 10;
  newTask.maxSamplingCount = 5;
  taskCreateError.value = null;
}
async function submitNewTask(): Promise<void> {
  if (!selectedId.value) {
    taskCreateError.value = 'Pick a service first';
    return;
  }
  taskCreateError.value = null;
  const idsBefore = new Set(tasks.value.map((t) => t.id));
  try {
    const startTime =
      newTask.monitorTime === 'now' ? Date.now() : newTask.monitorTimeAt.getTime();
    const resp = await bffClient.profile.create(layerKey.value, {
      serviceId: selectedId.value,
      endpointName: newTask.endpointName,
      startTime,
      duration: Number(newTask.monitorDuration),
      minDurationThreshold: Number(newTask.minThreshold),
      dumpPeriod: Number(newTask.dumpPeriod),
      maxSamplingCount: Number(newTask.maxSamplingCount),
    });
    if (resp.errorReason) {
      taskCreateError.value = resp.errorReason;
      return;
    }
    if (!resp.reachable && resp.error) {
      taskCreateError.value = resp.error;
      return;
    }
    showNewTask.value = false;
    resetNewTask();
    await refreshTasks();
    await pollForNewTask({
      idsBefore,
      refresh: refreshTasks,
      currentIds: () => tasks.value.map((t) => t.id),
    });
  } catch (e) {
    taskCreateError.value = e instanceof Error ? e.message : String(e);
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
  <div class="sw-card prof-shell">
    <div class="prof-side">
      <!-- Tasks -->
      <div class="side-pane">
        <div class="side-head">
          <span>Profile tasks</span>
          <div class="side-head-actions">
            <button
              type="button"
              class="btn-refresh"
              :class="{ spinning: tasksLoading }"
              :disabled="!selectedId || tasksLoading"
              :title="!selectedId ? 'Pick a service first' : tasksLoading ? 'Refreshing…' : 'Refresh task list'"
              aria-label="Refresh task list"
              @click="refreshTasks"
            ><Icon name="refresh" :size="11" /></button>
            <button
              type="button"
              class="btn-new"
              :disabled="!selectedId"
              :title="selectedId ? 'Create a new profile task' : 'Pick a service first'"
              @click="showNewTask = true"
            >+ New Task</button>
          </div>
        </div>
        <div v-if="polling" class="poll-hint">Waiting for new task… ({{ pollRound }}/4)</div>
        <div v-if="tasksError" class="side-err">{{ tasksError }}</div>
        <div v-else-if="tasksLoading && !tasks.length" class="side-empty">Loading…</div>
        <div v-else-if="!tasks.length" class="side-empty">
          {{ selectedId ? 'No tasks yet for this service.' : 'Pick a service to load profile tasks.' }}
        </div>
        <ul v-else class="side-list">
          <li
            v-for="t in tasks"
            :key="t.id"
            :class="{ 'is-active': currentTask?.id === t.id }"
            @click="pickTask(t)"
          >
            <div class="row1">
              <span class="ep" :title="t.endpointName">{{ t.endpointName || '(no endpoint)' }}</span>
              <button
                type="button"
                class="row-eye"
                title="View task detail"
                @click.stop="openTaskDetail(t, $event)"
              >i</button>
            </div>
            <div class="row2">
              <span>{{ fmtTime(t.startTime) }}</span>
              <span class="muted">→</span>
              <span>{{ fmtTime(t.startTime + t.duration * 60_000) }}</span>
            </div>
          </li>
        </ul>
      </div>
      <!-- Segments -->
      <div class="side-pane">
        <div class="side-head">
          <span>Sampled traces</span>
          <span v-if="currentTask" class="side-counter">{{ segments.length }}</span>
        </div>
        <div v-if="segmentsError" class="side-err">{{ segmentsError }}</div>
        <div v-else-if="segmentsLoading && !segments.length" class="side-empty">Loading…</div>
        <div v-else-if="!segments.length" class="side-empty">No sampled segments collected.</div>
        <ul v-else class="side-list">
          <li
            v-for="s in segments"
            :key="s.traceId"
            :class="{ 'is-active': currentSegment?.traceId === s.traceId, err: s.isError }"
            @click="pickSegment(s)"
          >
            <div class="row1">
              <span class="ep" :title="s.endpointNames?.[0]">{{ s.endpointNames?.[0] ?? '—' }}</span>
            </div>
            <div class="row2">
              <span class="dur-chip">{{ s.duration }} ms</span>
              <span class="muted">{{ fmtTime(Number(s.start)) }}</span>
            </div>
          </li>
        </ul>
      </div>
    </div>

    <div class="prof-main">
      <div class="main-toolbar">
        <div class="tb-block">
          <label class="lbl">Trace ID</label>
          <input class="ti-input" readonly :value="currentSegment?.traceId ?? ''" />
        </div>
        <div class="tb-block">
          <label class="lbl">Data mode</label>
          <select v-model="dataMode" class="sel">
            <option value="include">Include children</option>
            <option value="exclude">Exclude children</option>
          </select>
        </div>
        <div class="tb-block">
          <label class="lbl">Display</label>
          <div class="seg">
            <button :class="{ on: displayMode === 'tree' }" @click="displayMode = 'tree'">Tree</button>
            <button :class="{ on: displayMode === 'flame' }" @click="displayMode = 'flame'">Flame</button>
          </div>
        </div>
        <button
          class="btn-primary"
          :disabled="!currentSpan?.profiled || analyzeLoading"
          :title="currentSpan?.profiled ? 'Analyze selected span' : 'Select a profiled span to analyze'"
          @click="runAnalyze"
        >{{ analyzeLoading ? 'Analyzing…' : 'Analyze' }}</button>
      </div>

      <!-- Spans rendered through the shared NativeTraceWaterfall used
           by the Trace explorer — identical visual vocabulary (service-
           coloured bar, kind glyph, component icon, peer arrow,
           duration suffix). The only profiling-specific addition is
           the `profiled` chip per row, enabled via `mark-profiled`. -->
      <section class="sw-card span-card">
        <header class="span-card-head">
          <h4>Spans</h4>
          <span class="sub">{{ segmentSpans.length }} in segment · click to select</span>
        </header>
        <div class="span-scroll">
          <div v-if="!segmentSpans.length" class="span-empty">
            {{ currentTask ? 'No spans in selected segment.' : 'Select a task to load spans.' }}
          </div>
          <NativeTraceWaterfall
            v-else
            :spans="segmentSpans"
            :selected-span="currentSpan"
            mark-profiled
            @select-span="(sp) => (currentSpan = sp as ProfileSpan)"
          />
        </div>
      </section>

      <!-- Result panel -->
      <div class="result">
        <div v-if="analyzeMessage" class="result-tip">{{ analyzeMessage }}</div>
        <ProfileStackTable
          v-if="displayMode === 'tree'"
          :trees="analyzeTrees"
          :highlight-top="highlightTop"
          @toggle-highlight="highlightTop = !highlightTop"
        />
        <ProfileFlameGraph v-else :trees="analyzeTrees" metric-key="count" />
      </div>
    </div>
  </div>

  <!-- New task modal -->
  <div v-if="showNewTask" class="dlg-mask" @click.self="showNewTask = false">
    <div class="dlg">
      <div class="dlg-head">
        <div>
          New profile task
          <span v-if="serviceName" class="muted">on {{ serviceName }}</span>
        </div>
        <button class="x" @click="showNewTask = false">×</button>
      </div>
      <div class="dlg-body">
        <div class="field">
          <label>Endpoint name</label>
          <input
            v-model="endpointKeyword"
            placeholder="Type to search…"
            class="ti-input wide"
          />
          <select v-model="newTask.endpointName" class="sel wide">
            <option value="">(any)</option>
            <option v-for="e in endpointPicks.endpoints.value" :key="e.id" :value="e.name">
              {{ e.name }}
            </option>
          </select>
        </div>
        <div class="field-row">
          <div class="field">
            <label>Start when</label>
            <div class="seg">
              <button :class="{ on: newTask.monitorTime === 'now' }" @click="newTask.monitorTime = 'now'">now</button>
              <button :class="{ on: newTask.monitorTime === 'set' }" @click="newTask.monitorTime = 'set'">set time</button>
            </div>
            <input
              v-if="newTask.monitorTime === 'set'"
              type="datetime-local"
              class="ti-input"
              :value="new Date(newTask.monitorTimeAt.getTime() - newTask.monitorTimeAt.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)"
              @input="(ev: Event) => (newTask.monitorTimeAt = new Date((ev.target as HTMLInputElement).value))"
            />
          </div>
          <div class="field">
            <label>Duration (min)</label>
            <select v-model.number="newTask.monitorDuration" class="sel">
              <option :value="5">5</option>
              <option :value="10">10</option>
              <option :value="15">15</option>
            </select>
          </div>
        </div>
        <div class="field-row">
          <div class="field">
            <label>Min threshold (ms)</label>
            <input type="number" min="0" v-model.number="newTask.minThreshold" class="ti-input" />
          </div>
          <div class="field">
            <label>Dump period (ms)</label>
            <select v-model.number="newTask.dumpPeriod" class="sel">
              <option :value="10">10</option>
              <option :value="20">20</option>
              <option :value="50">50</option>
              <option :value="100">100</option>
            </select>
          </div>
          <div class="field">
            <label>Max sampling count</label>
            <select v-model.number="newTask.maxSamplingCount" class="sel">
              <option v-for="n in [1,2,3,4,5,6,7,8,9]" :key="n" :value="n">{{ n }}</option>
            </select>
          </div>
        </div>
        <div v-if="taskCreateError" class="dlg-err">{{ taskCreateError }}</div>
      </div>
      <div class="dlg-foot">
        <button class="btn-secondary" @click="showNewTask = false">Cancel</button>
        <button class="btn-primary" @click="submitNewTask">Create task</button>
      </div>
    </div>
  </div>

  <!-- Task detail modal -->
  <div v-if="taskDetailFor" class="dlg-mask" @click.self="taskDetailFor = null">
    <div class="dlg wide">
      <div class="dlg-head">
        <div>Profile task detail</div>
        <button class="x" @click="taskDetailFor = null">×</button>
      </div>
      <div class="dlg-body">
        <dl class="kv">
          <dt>Service</dt><dd>{{ serviceName ?? taskDetailFor.serviceId }}</dd>
          <dt>Endpoint</dt><dd>{{ taskDetailFor.endpointName }}</dd>
          <dt>Start time</dt><dd>{{ fmtTime(taskDetailFor.startTime) }}</dd>
          <dt>Duration</dt><dd>{{ taskDetailFor.duration }} min</dd>
          <dt>Min threshold</dt><dd>{{ taskDetailFor.minDurationThreshold }} ms</dd>
          <dt>Dump period</dt><dd>{{ taskDetailFor.dumpPeriod }}</dd>
          <dt>Max sampling count</dt><dd>{{ taskDetailFor.maxSamplingCount }}</dd>
        </dl>
        <div v-if="taskDetailLogs.length" class="logs">
          <h5>Instance logs</h5>
          <div v-for="(log, i) in taskDetailLogs" :key="i" class="log-line">
            <span class="t-tag">{{ log.operationType }}</span>
            <span class="muted">{{ log.instanceName }}</span>
            <span>{{ fmtTime(log.operationTime) }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.prof-shell {
  display: flex;
  height: calc(100vh - 280px);
  min-height: 520px;
  padding: 0;
  overflow: hidden;
}
.prof-side {
  width: 310px;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--sw-line);
  flex: 0 0 310px;
}
.side-pane {
  display: flex;
  flex-direction: column;
  flex: 1 1 50%;
  min-height: 0;
}
.side-pane + .side-pane {
  border-top: 1px solid var(--sw-line);
}
.side-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 10px;
  background: var(--sw-bg-2);
  border-bottom: 1px solid var(--sw-line);
  font-size: 11.5px;
  font-weight: 600;
  color: var(--sw-fg-1);
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
.side-counter {
  font-weight: 500;
  font-size: 10.5px;
  color: var(--sw-fg-3);
}
.poll-hint {
  padding: 6px 10px;
  font-size: 10.5px;
  color: var(--sw-accent);
  background: var(--sw-bg-2);
  border-bottom: 1px solid var(--sw-line);
}
.side-err {
  padding: 8px 12px;
  font-size: 11px;
  color: var(--sw-err);
}
.side-empty {
  padding: 12px;
  font-size: 11.5px;
  color: var(--sw-fg-3);
  text-align: center;
}
.side-list {
  list-style: none;
  margin: 0;
  padding: 0;
  overflow-y: auto;
  flex: 1 1 0;
}
.side-list li {
  padding: 7px 10px;
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
.side-list li.err .ep {
  color: var(--sw-err);
}
.row1 {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}
.ep {
  font-size: 12px;
  color: var(--sw-fg-0);
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.row-eye {
  background: transparent;
  border: none;
  color: var(--sw-fg-3);
  cursor: pointer;
  padding: 0;
}
.row-eye:hover {
  color: var(--sw-accent);
}
.row2 {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 10.5px;
  color: var(--sw-fg-2);
  margin-top: 3px;
}
.muted {
  color: var(--sw-fg-3);
}
.dur-chip {
  background: var(--sw-bg-3, var(--sw-bg-2));
  border-radius: 2px;
  padding: 0 5px;
  color: var(--sw-fg-1);
}

.prof-main {
  flex: 1 1 0;
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.main-toolbar {
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
.ti-input,
.sel {
  background: var(--sw-bg-2);
  color: var(--sw-fg-0);
  border: 1px solid var(--sw-line);
  border-radius: 3px;
  padding: 4px 6px;
  font-size: 11.5px;
  font-family: var(--sw-mono);
  outline: none;
}
.ti-input {
  width: 260px;
}
.ti-input.wide,
.sel.wide {
  width: 100%;
}
.sel {
  min-width: 140px;
}
.seg {
  display: inline-flex;
  border: 1px solid var(--sw-line-2);
  border-radius: 3px;
  overflow: hidden;
}
.seg button {
  background: transparent;
  border: none;
  color: var(--sw-fg-2);
  padding: 4px 10px;
  font-size: 11px;
  cursor: pointer;
}
.seg button.on {
  background: var(--sw-accent);
  color: #fff;
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
  padding: 6px 14px;
  font-size: 11.5px;
  cursor: pointer;
}

/* Span card frame — wraps the shared NativeTraceWaterfall in a
 * sw-card boundary with a labelled header so it reads as a distinct
 * section above the Analyze result panel. */
.span-card {
  flex: 0 0 auto;
  max-height: 42%;
  display: flex;
  flex-direction: column;
  min-height: 0;
  margin-bottom: 10px;
  overflow: hidden;
}
.span-card-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--sw-line);
  background: var(--sw-bg-1);
}
.span-card-head h4 {
  margin: 0; font-size: 12px; font-weight: 600; color: var(--sw-fg-0);
}
.span-card-head .sub { font-size: 10.5px; color: var(--sw-fg-3); margin-left: auto; }
.span-scroll {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
}
.span-empty {
  padding: 14px;
  font-size: 11.5px;
  color: var(--sw-fg-3);
  text-align: center;
}
.result {
  flex: 1 1 0;
  min-height: 0;
  overflow: hidden;
  position: relative;
  display: flex;
  flex-direction: column;
}
.result-tip {
  padding: 10px 14px;
  background: var(--sw-bg-2);
  color: #ffb86b;
  font-size: 11.5px;
  border-bottom: 1px solid var(--sw-line);
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
  width: 520px;
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
  line-height: 1;
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
  color: var(--sw-fg-1);
}
.field label {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--sw-fg-3);
}
.field-row {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}
.field-row .field {
  flex: 1 1 0;
  min-width: 140px;
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
.kv {
  display: grid;
  grid-template-columns: 140px 1fr;
  row-gap: 6px;
  font-size: 11.5px;
  margin: 0;
}
.kv dt {
  color: var(--sw-fg-3);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  font-size: 10px;
  align-self: center;
}
.kv dd {
  margin: 0;
  color: var(--sw-fg-0);
}
.logs h5 {
  margin: 14px 0 6px;
  font-size: 11px;
  color: var(--sw-fg-1);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
.log-line {
  display: flex;
  gap: 8px;
  align-items: center;
  font-size: 11px;
  padding: 4px 0;
  border-bottom: 1px dotted var(--sw-line);
}
</style>
