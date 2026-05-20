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
  Per-layer eBPF profiling tab — feature parity with booster-ui
  `dashboard/related/ebpf`.

    ┌───────────┬────────────────────────────────────────────────┐
    │  Task     │ Filter bar: labels • aggregate (OFF_CPU only)  │
    │  list     │           • process picker • Analyze button    │
    │           ├────────────────────────────────────────────────┤
    │  + New    │   Schedule duration banner                     │
    │           │                                                │
    │           │   Flame graph / Tree view (toggle)             │
    └───────────┴────────────────────────────────────────────────┘
-->
<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { useLayers } from '@/shell/useLayers';
import { useSelectedService } from '@/layer/useSelectedService';
import { useLayerLanding } from '@/layer/useLayerLanding';
import { useSetupStore } from '@/state/setup';
import { bffClient } from '@/api/client';
import type {
  EBPFAnalysisTree,
  EBPFProcess,
  EBPFSchedule,
  EBPFTargetType,
  EBPFTask,
  LayerDef,
  ProfileAnalyzationTree,
} from '@/api/client';
import ProfileFlameGraph from '@/layer/profiling/ProfileFlameGraph.vue';
import ProfileStackTable from '@/layer/profiling/ProfileStackTable.vue';
import Icon from '@/components/icons/Icon.vue';

const route = useRoute();
const layerKey = computed(() => String(route.params.layerKey ?? ''));
const { layers } = useLayers();
const layer = computed<LayerDef | null>(
  () => layers.value.find((l) => l.key === layerKey.value) ?? null,
);

// Resolve URL-bound service id → name (same trick as the trace tab).
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
const setup = useSetupStore();
const safeCfg = computed(() => {
  if (!layer.value)
    return { priority: 99, topN: 5, orderBy: 'cpm', columns: [], style: 'table' as const };
  return setup.ensure(layer.value.key, {
    slots: layer.value.slots,
    caps: layer.value.caps,
    metrics: layer.value.metrics,
    overview: layer.value.overview,
  }).landing;
});
const landing = useLayerLanding(safeLayer, safeCfg);
const { selectedId } = useSelectedService();
const serviceName = computed<string | null>(() => {
  const rows = landing.data.value?.sampledRows ?? landing.rows.value ?? [];
  return rows.find((r) => r.serviceId === selectedId.value)?.serviceName ?? null;
});

// ── State ─────────────────────────────────────────────────────────
const tasks = ref<EBPFTask[]>([]);
const tasksError = ref<string | null>(null);
const tasksLoading = ref(false);
const couldProfiling = ref(false);
const allProcessLabels = ref<string[]>([]);
const currentTask = ref<EBPFTask | null>(null);

const schedules = ref<EBPFSchedule[]>([]);
const schedulesError = ref<string | null>(null);

const selectedLabels = ref<string[]>([]); // empty list = all labels
const selectedProcessIds = ref<string[]>([]);
const aggregateType = ref<'COUNT' | 'DURATION'>('COUNT');

const analyzeTrees = ref<EBPFAnalysisTree[]>([]);
const analyzeTip = ref<string>('');
const analyzeLoading = ref(false);
const displayMode = ref<'flame' | 'tree'>('flame');
const highlightTop = ref(true);

// Process picker state
const processSearch = ref('');
const showProcessPicker = ref(false);

// New task modal
const showNewTask = ref(false);
const newTask = reactive({
  labels: [] as string[],
  targetType: 'ON_CPU' as EBPFTargetType,
  monitorTime: 'now' as 'now' | 'set',
  monitorTimeAt: new Date(),
  monitorMinutes: 10,
});
const newTaskError = ref<string | null>(null);

watch(
  () => layerKey.value + '|' + (selectedId.value ?? ''),
  () => void refreshTasks(),
  { immediate: true },
);

async function refreshTasks(): Promise<void> {
  tasksError.value = null;
  if (!selectedId.value) {
    tasks.value = [];
    currentTask.value = null;
    return;
  }
  tasksLoading.value = true;
  try {
    const resp = await bffClient.ebpf.tasks(layerKey.value, selectedId.value);
    if (!resp.reachable && resp.error) tasksError.value = resp.error;
    tasks.value = resp.tasks ?? [];
    couldProfiling.value = resp.couldProfiling;
    allProcessLabels.value = resp.processLabels ?? [];
    if (tasks.value.length) {
      await pickTask(tasks.value[0]);
    } else {
      currentTask.value = null;
      schedules.value = [];
      analyzeTrees.value = [];
    }
  } catch (e) {
    tasksError.value = e instanceof Error ? e.message : String(e);
  } finally {
    tasksLoading.value = false;
  }
}

async function pickTask(t: EBPFTask): Promise<void> {
  currentTask.value = t;
  analyzeTrees.value = [];
  analyzeTip.value = '';
  schedulesError.value = null;
  try {
    const resp = await bffClient.ebpf.schedules(t.taskId);
    if (!resp.reachable && resp.error) schedulesError.value = resp.error;
    schedules.value = resp.schedules ?? [];
    resetFiltersForTask();
    // Auto-trigger analyze on task switch (booster-ui behaviour).
    if (schedules.value.length) await runAnalyze();
  } catch (e) {
    schedulesError.value = e instanceof Error ? e.message : String(e);
  }
}

function resetFiltersForTask(): void {
  selectedLabels.value = [];
  selectedProcessIds.value = [];
  aggregateType.value = 'COUNT';
}

// Distinct labels across this task's schedules
const labelOptions = computed<string[]>(() => {
  const s = new Set<string>();
  for (const sc of schedules.value)
    for (const l of sc.process.labels ?? []) s.add(l);
  return [...s];
});
// Distinct processes (collapsed by id)
const processes = computed<EBPFProcess[]>(() => {
  const byId = new Map<string, EBPFProcess>();
  for (const sc of schedules.value) byId.set(sc.process.id, sc.process);
  return [...byId.values()];
});
const filteredProcesses = computed<EBPFProcess[]>(() => {
  const q = processSearch.value.toLowerCase().trim();
  if (!q) return processes.value;
  return processes.value.filter((p) => {
    if (p.name?.toLowerCase().includes(q)) return true;
    if (p.instanceName?.toLowerCase().includes(q)) return true;
    const cmd = (p.attributes ?? []).find((a) => a.name === 'command_line');
    return Boolean(cmd?.value.toLowerCase().includes(q));
  });
});
// Schedule duration banner (min start → max end)
const scheduleDuration = computed(() => {
  if (!schedules.value.length) return null;
  const starts = schedules.value.map((s) => s.startTime);
  const ends = schedules.value.map((s) => s.endTime);
  return { start: Math.min(...starts), end: Math.max(...ends) };
});

async function runAnalyze(): Promise<void> {
  if (!schedules.value.length) {
    analyzeTrees.value = [];
    analyzeTip.value = '';
    return;
  }
  const wantedLabels =
    selectedLabels.value.length === 0 ? labelOptions.value : selectedLabels.value;
  const matching = schedules.value.filter((sc) => {
    const labels = sc.process.labels ?? [];
    const labelHit = labels.some((l) => wantedLabels.includes(l));
    const idHit = selectedProcessIds.value.includes(sc.process.id);
    return labelHit || idHit;
  });
  if (!matching.length) {
    analyzeTrees.value = [];
    analyzeTip.value = 'No schedules match the current filter.';
    return;
  }
  // Merge overlapping time ranges (mirrors booster-ui logic).
  const ranges: { start: number; end: number }[] = matching
    .map((sc) => ({ start: sc.startTime, end: sc.endTime }))
    .sort((a, b) => a.start - b.start);
  const merged: { start: number; end: number }[] = [];
  for (const r of ranges) {
    if (merged.length && r.start <= merged[merged.length - 1].end) {
      merged[merged.length - 1].end = Math.max(merged[merged.length - 1].end, r.end);
    } else {
      merged.push({ ...r });
    }
  }
  analyzeLoading.value = true;
  analyzeTip.value = '';
  try {
    const resp = await bffClient.ebpf.analyze({
      scheduleIdList: matching.map((sc) => sc.scheduleId),
      timeRanges: merged,
      aggregateType: aggregateType.value,
    });
    analyzeTrees.value = resp.trees ?? [];
    analyzeTip.value = resp.tip ?? '';
    if (!resp.reachable && resp.error) analyzeTip.value = resp.error;
  } catch (e) {
    analyzeTip.value = e instanceof Error ? e.message : String(e);
    analyzeTrees.value = [];
  } finally {
    analyzeLoading.value = false;
  }
}

// ProfileFlameGraph + ProfileStackTable expect the trace-profile element
// shape `{id, parentId, codeSignature, count, duration, durationChildExcluded}`.
// eBPF returns `{id, parentId, symbol, stackType, dumpCount}` — translate.
//
// MUST be a computed, not a function called from the template: the
// FlameGraph re-renders whenever the `trees` prop's reference changes,
// and a fresh `.map()` array returned by a function would make every
// parent reactive tick (toolbar chip click, modal open, search input)
// invalidate the cached draw. A computed gives a stable identity that
// only changes when `analyzeTrees` itself changes.
const profileTrees = computed<ProfileAnalyzationTree[]>(() =>
  analyzeTrees.value.map((t) => ({
    elements: t.elements.map((e) => ({
      id: e.id,
      parentId: e.parentId,
      codeSignature: e.symbol,
      count: e.dumpCount,
      duration: e.dumpCount,
      durationChildExcluded: e.dumpCount,
    })),
  })),
);

// Pinning / unpinning a process is a query-shape change; the operator
// expects the flamegraph to follow that selection without having to
// click Analyze. Other toolbar inputs (label chips, aggregate, display
// mode) stay manual — they're filter-tweaks the operator typically
// stacks up before re-querying. `pickTask` already nulls
// `selectedProcessIds` via `resetFiltersForTask`; the watcher fires
// after that reset with an empty list and harmlessly no-ops because
// the matching set is unchanged from the task-pick analyze run.
//
// `deep: true` because toggleProcessId mutates the array in place
// (push / splice). Without it the watcher only fires when the array
// reference itself changes, which is never on pin/unpin.
watch(selectedProcessIds, () => {
  if (!schedules.value.length) return;
  void runAnalyze();
}, { deep: true });

async function submitNewTask(): Promise<void> {
  if (!selectedId.value) {
    newTaskError.value = 'Pick a service first';
    return;
  }
  newTaskError.value = null;
  const start =
    newTask.monitorTime === 'now' ? Date.now() : newTask.monitorTimeAt.getTime();
  try {
    const resp = await bffClient.ebpf.create(layerKey.value, {
      serviceId: selectedId.value,
      processLabels: newTask.labels,
      startTime: start,
      duration: Number(newTask.monitorMinutes) * 60,
      targetType: newTask.targetType,
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
    newTask.labels = [];
    await refreshTasks();
  } catch (e) {
    newTaskError.value = e instanceof Error ? e.message : String(e);
  }
}

// OAP returns `taskStartTime` / `createTime` / schedule `startTime` and
// `endTime` as standard 1970 ms timestamps (System.currentTimeMillis()
// in EBPFProfilingMutationService). Render in the browser's local TZ
// via Intl — explicit `timeZone` left at the browser default and a
// stable formatter shared across rows (cheaper than a new Date split
// + manual padding per cell).
const TIME_FMT = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});
function fmtTime(ms: number): string {
  if (!ms) return '—';
  // Intl gives `2026/05/20, 17:00:00` on en-US — normalize to ISO-ish
  // `2026-05-20 17:00:00` so the layout matches the rest of the UI.
  return TIME_FMT.format(new Date(ms)).replace(/\//g, '-').replace(', ', ' ');
}
function attrLine(p: EBPFProcess): string {
  return (p.attributes ?? []).map((a) => `${a.name}=${a.value}`).join(' · ');
}
function toggleProcessId(id: string): void {
  const i = selectedProcessIds.value.indexOf(id);
  if (i === -1) selectedProcessIds.value.push(id);
  else selectedProcessIds.value.splice(i, 1);
}
function toggleLabel(l: string): void {
  const i = selectedLabels.value.indexOf(l);
  if (i === -1) selectedLabels.value.push(l);
  else selectedLabels.value.splice(i, 1);
}
function toggleNewTaskLabel(l: string): void {
  const i = newTask.labels.indexOf(l);
  if (i === -1) newTask.labels.push(l);
  else newTask.labels.splice(i, 1);
}
</script>

<template>
  <div class="sw-card ebpf-shell">
    <!-- Tasks -->
    <div class="ebpf-side">
      <div class="side-head">
        <span>eBPF profile tasks</span>
        <div class="side-head-actions">
          <button
            class="btn-refresh"
            :class="{ spinning: tasksLoading }"
            :disabled="!selectedId || tasksLoading"
            :title="
              !selectedId
                ? 'Pick a service'
                : tasksLoading
                  ? 'Refreshing…'
                  : 'Refresh task list'
            "
            aria-label="Refresh task list"
            @click="refreshTasks"
          ><Icon name="refresh" :size="11" /></button>
          <button
            class="btn-new"
            :disabled="!selectedId || !couldProfiling"
            :title="
              !selectedId
                ? 'Pick a service'
                : couldProfiling
                  ? 'Create a new eBPF task'
                  : 'OAP reports no profilable processes for this service'
            "
            @click="showNewTask = true"
          >+ New Task</button>
        </div>
      </div>
      <div v-if="tasksError" class="side-err">{{ tasksError }}</div>
      <div v-else-if="tasksLoading && !tasks.length" class="side-empty">Loading…</div>
      <div v-else-if="!tasks.length" class="side-empty">
        {{
          selectedId
            ? couldProfiling
              ? 'No eBPF tasks yet — kick off one.'
              : 'OAP can not eBPF-profile this service.'
            : 'Pick a service to load tasks.'
        }}
      </div>
      <ul v-else class="side-list">
        <li
          v-for="t in tasks"
          :key="t.taskId"
          :class="{ 'is-active': currentTask?.taskId === t.taskId }"
          @click="pickTask(t)"
        >
          <div class="row1">
            <span class="t-tag" :class="{ off: t.targetType === 'OFF_CPU' }">{{ t.targetType }}</span>
            <span class="ep">{{ t.processLabels?.length ? t.processLabels.join(' · ') : 'All processes' }}</span>
          </div>
          <div class="row2">
            <span>{{ fmtTime(t.taskStartTime) }}</span>
            <span class="muted">→</span>
            <span>{{ fmtTime(t.taskStartTime + (t.fixedTriggerDuration ?? 0) * 1000) }}</span>
          </div>
        </li>
      </ul>
    </div>

    <!-- Main pane -->
    <div class="ebpf-main">
      <div class="filter-bar">
        <div class="tb-block">
          <label class="lbl">Labels</label>
          <div class="chip-row">
            <button
              v-for="l in labelOptions"
              :key="l"
              class="chip"
              :class="{ on: selectedLabels.includes(l) }"
              @click="toggleLabel(l)"
            >{{ l }}</button>
            <span v-if="!labelOptions.length" class="muted">—</span>
          </div>
        </div>
        <div class="tb-block">
          <label class="lbl">Aggregate</label>
          <div class="seg">
            <button :class="{ on: aggregateType === 'COUNT' }" @click="aggregateType = 'COUNT'">Count</button>
            <button
              :class="{ on: aggregateType === 'DURATION' }"
              :disabled="currentTask?.targetType !== 'OFF_CPU'"
              :title="currentTask?.targetType === 'OFF_CPU' ? '' : 'Duration is OFF_CPU-only'"
              @click="aggregateType = 'DURATION'"
            >Duration</button>
          </div>
        </div>
        <div class="tb-block">
          <label class="lbl">Display</label>
          <div class="seg">
            <button :class="{ on: displayMode === 'flame' }" @click="displayMode = 'flame'">Flame</button>
            <button :class="{ on: displayMode === 'tree' }" @click="displayMode = 'tree'">Tree</button>
          </div>
        </div>
        <div class="tb-block grow">
          <label class="lbl">Processes ({{ selectedProcessIds.length }} pinned)</label>
          <button class="btn-secondary" @click="showProcessPicker = !showProcessPicker">
            {{ showProcessPicker ? 'Hide picker' : 'Pick processes' }}
          </button>
        </div>
        <button
          class="btn-primary"
          :disabled="analyzeLoading || !schedules.length"
          @click="runAnalyze"
        >{{ analyzeLoading ? 'Analyzing…' : 'Analyze' }}</button>
      </div>

      <div v-if="schedulesError" class="banner err">{{ schedulesError }}</div>
      <div v-else-if="scheduleDuration" class="banner">
        Captured between
        <strong>{{ fmtTime(scheduleDuration.start) }}</strong>
        and
        <strong>{{ fmtTime(scheduleDuration.end) }}</strong>
        — {{ schedules.length }} schedule{{ schedules.length === 1 ? '' : 's' }}
      </div>

      <div v-if="showProcessPicker" class="process-picker">
        <input
          v-model="processSearch"
          placeholder="Search by name / instance / command line…"
          class="ti-input wide"
        />
        <div class="proc-table">
          <div class="ph">
            <div class="cc cc-sel"></div>
            <div class="cc cc-name">Process</div>
            <div class="cc cc-inst">Instance</div>
            <div class="cc cc-attrs">Attributes</div>
          </div>
          <div v-if="!filteredProcesses.length" class="empty">No matches.</div>
          <label
            v-for="p in filteredProcesses"
            :key="p.id"
            class="pr"
            :class="{ on: selectedProcessIds.includes(p.id) }"
          >
            <div class="cc cc-sel">
              <input
                type="checkbox"
                :checked="selectedProcessIds.includes(p.id)"
                @change="toggleProcessId(p.id)"
              />
            </div>
            <div class="cc cc-name" :title="p.name">{{ p.name }}</div>
            <div class="cc cc-inst" :title="p.instanceName ?? ''">{{ p.instanceName }}</div>
            <div class="cc cc-attrs" :title="attrLine(p)">{{ attrLine(p) }}</div>
          </label>
        </div>
      </div>

      <div class="result">
        <div v-if="analyzeTip" class="tip">{{ analyzeTip }}</div>
        <template v-if="analyzeTrees.length">
          <ProfileFlameGraph
            v-if="displayMode === 'flame'"
            :trees="profileTrees"
            metric-key="count"
          />
          <ProfileStackTable
            v-else
            :trees="profileTrees"
            :highlight-top="highlightTop"
            @toggle-highlight="highlightTop = !highlightTop"
          />
        </template>
        <div v-else-if="!analyzeTip && !analyzeLoading" class="result-empty">
          {{
            currentTask
              ? schedules.length
                ? 'No analyze data yet — click Analyze.'
                : 'No schedules captured for this task.'
              : 'Select a task to inspect its eBPF profile.'
          }}
        </div>
      </div>
    </div>
  </div>

  <!-- New task modal -->
  <div v-if="showNewTask" class="dlg-mask" @click.self="showNewTask = false">
    <div class="dlg">
      <div class="dlg-head">
        <div>
          New eBPF profile task
          <span v-if="serviceName" class="muted">on {{ serviceName }}</span>
        </div>
        <button class="x" @click="showNewTask = false">×</button>
      </div>
      <div class="dlg-body">
        <div class="field">
          <label>Process labels (filter; leave empty = all)</label>
          <div class="chip-row">
            <button
              v-for="l in allProcessLabels"
              :key="l"
              type="button"
              class="chip"
              :class="{ on: newTask.labels.includes(l) }"
              @click="toggleNewTaskLabel(l)"
            >{{ l }}</button>
            <span v-if="!allProcessLabels.length" class="muted">No labels surfaced by OAP.</span>
          </div>
        </div>
        <div class="field-row">
          <div class="field">
            <label>Target</label>
            <div class="seg">
              <button :class="{ on: newTask.targetType === 'ON_CPU' }" @click="newTask.targetType = 'ON_CPU'">ON_CPU</button>
              <button :class="{ on: newTask.targetType === 'OFF_CPU' }" @click="newTask.targetType = 'OFF_CPU'">OFF_CPU</button>
            </div>
          </div>
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
            <label>Duration (min, 1–60)</label>
            <input
              type="number"
              class="ti-input"
              min="1"
              max="60"
              v-model.number="newTask.monitorMinutes"
            />
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
.ebpf-shell {
  display: flex;
  height: calc(100vh - 280px);
  min-height: 520px;
  padding: 0;
  overflow: hidden;
}
.ebpf-side {
  width: 310px;
  flex: 0 0 310px;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--sw-line);
}
.side-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 10px;
  background: var(--sw-bg-2);
  border-bottom: 1px solid var(--sw-line);
  font-weight: 600;
  font-size: 11.5px;
  color: var(--sw-fg-1);
}
.side-head-actions {
  display: inline-flex;
  align-items: center;
  gap: 6px;
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
.btn-new:hover:not(:disabled) {
  border-color: var(--sw-accent);
  color: var(--sw-accent);
}
.btn-new:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
/* Refresh button — matches .btn-new height (font-size 10.5px + 2px V
 * padding ≈ 18px tall) so the two head-actions sit flush. Square ratio
 * via padding instead of fixed width keeps the box auto-sized to the
 * icon — `Icon :size="11"` renders an 11px SVG that the .sw-btn global
 * would force to 12px via `.sw-btn svg`, which is why we use a custom
 * shell rather than `sw-btn is-icon`. */
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
.btn-refresh:hover:not(:disabled) {
  border-color: var(--sw-accent);
  color: var(--sw-accent);
}
.btn-refresh:disabled { opacity: 0.5; cursor: not-allowed; }
.btn-refresh.spinning :deep(svg) {
  animation: ebpf-refresh-spin 1.6s linear infinite;
  transform-origin: 50% 50%;
}
@keyframes ebpf-refresh-spin {
  to { transform: rotate(360deg); }
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
.row1 {
  display: flex;
  align-items: center;
  gap: 6px;
}
.row2 {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 10.5px;
  color: var(--sw-fg-2);
  margin-top: 4px;
}
.muted {
  color: var(--sw-fg-3);
}
.t-tag {
  display: inline-block;
  font-size: 10px;
  padding: 0 5px;
  border-radius: 2px;
  background: var(--sw-accent);
  color: #fff;
  font-weight: 600;
  letter-spacing: 0.04em;
}
.t-tag.off {
  background: #4a8cf2;
}
.ep {
  font-size: 12px;
  color: var(--sw-fg-0);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ebpf-main {
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
  min-height: 26px;
  align-items: center;
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
  color: #fff;
  border-color: var(--sw-accent);
}
.seg {
  display: inline-flex;
  border: 1px solid var(--sw-line-2);
  border-radius: 3px;
  overflow: hidden;
  align-self: start;
}
.seg button {
  background: transparent;
  border: none;
  color: var(--sw-fg-2);
  padding: 4px 10px;
  font-size: 11px;
  cursor: pointer;
}
.seg button:disabled {
  opacity: 0.4;
  cursor: not-allowed;
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
  padding: 5px 12px;
  font-size: 11px;
  cursor: pointer;
}
.banner {
  padding: 6px 12px;
  font-size: 11px;
  color: var(--sw-fg-2);
  background: var(--sw-bg-2);
  border-bottom: 1px solid var(--sw-line);
}
.banner.err {
  color: var(--sw-err);
}
.banner strong {
  color: var(--sw-fg-0);
  font-weight: 600;
}

.process-picker {
  border-bottom: 1px solid var(--sw-line);
  background: var(--sw-bg-1);
  padding: 8px 12px;
  max-height: 220px;
  overflow: auto;
}
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
  margin-bottom: 8px;
}
.proc-table {
  border: 1px solid var(--sw-line);
  border-radius: 3px;
}
.ph,
.pr {
  display: grid;
  grid-template-columns: 30px minmax(120px, 1.2fr) minmax(120px, 1fr) minmax(160px, 2fr);
  align-items: center;
  font-size: 11px;
}
.ph {
  background: var(--sw-bg-2);
  border-bottom: 1px solid var(--sw-line);
}
.ph .cc {
  padding: 6px 8px;
  font-weight: 600;
  color: var(--sw-fg-1);
}
.pr {
  border-bottom: 1px dotted var(--sw-line);
  cursor: pointer;
}
.pr:hover {
  background: var(--sw-bg-2);
}
.pr.on {
  background: var(--sw-bg-3, var(--sw-bg-2));
}
.pr .cc {
  padding: 5px 8px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.result {
  flex: 1 1 0;
  min-height: 0;
  position: relative;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}
.tip {
  padding: 10px 14px;
  background: var(--sw-bg-2);
  color: #ffb86b;
  font-size: 11.5px;
  border-bottom: 1px solid var(--sw-line);
}
.result-empty {
  margin: auto;
  color: var(--sw-fg-3);
  font-size: 12px;
  text-align: center;
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
.empty {
  padding: 10px;
  text-align: center;
  font-size: 11px;
  color: var(--sw-fg-3);
}
</style>
