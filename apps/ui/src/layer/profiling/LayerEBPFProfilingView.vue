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

  This file is the thin picker + panes shell: the task list, the filter
  bar, and the result panes. Data orchestration lives in
  `useEBPFProfiling`; the teleported process picker and the create-task
  form are extracted sub-components (`EBPFProcessPicker`, `NewEBPFTaskModal`).
-->
<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRoute } from 'vue-router';
import { useLayers } from '@/shell/useLayers';
import { useSelectedService } from '@/layer/useSelectedService';
import { useLayerLanding } from '@/layer/useLayerLanding';
import { useLayerServiceName } from '@/layer/useLayerServiceName';
import { useSetupStore } from '@/state/setup';
import type { EBPFTask, LayerDef } from '@/api/client';
import ProfileFlameGraph from '@/layer/profiling/ProfileFlameGraph.vue';
import ProfileStackTable from '@/layer/profiling/ProfileStackTable.vue';
import EBPFProcessPicker from '@/layer/profiling/EBPFProcessPicker.vue';
import NewEBPFTaskModal from '@/layer/profiling/NewEBPFTaskModal.vue';
import {
  useEBPFProfiling,
  type NewEBPFTaskPayload,
} from '@/layer/profiling/useEBPFProfiling';
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
const serviceName = useLayerServiceName(layerKey, landing);

const {
  tasks,
  tasksError,
  tasksLoading,
  couldProfiling,
  allProcessLabels,
  currentTask,
  refreshTasks,
  pickTask,
  schedules,
  schedulesError,
  selectedLabels,
  selectedProcessIds,
  aggregateType,
  labelOptions,
  processes,
  scheduleDuration,
  toggleLabel,
  analyzeTrees,
  analyzeTip,
  analyzeLoading,
  profileTrees,
  runAnalyze,
  newTaskError,
  submitNewTask,
  polling,
  countdown,
} = useEBPFProfiling(layerKey, selectedId);

// Display-only toggles owned by the view.
const displayMode = ref<'flame' | 'tree'>('flame');
const highlightTop = ref(true);

const showNewTask = ref(false);

async function onSubmitNewTask(payload: NewEBPFTaskPayload): Promise<void> {
  await submitNewTask(payload);
  if (!newTaskError.value) showNewTask.value = false;
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

function onPickTask(t: EBPFTask): void {
  void pickTask(t);
}
</script>

<template>
  <div class="sw-card ebpf-shell">
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
            :disabled="!selectedId"
            :title="!selectedId ? 'Pick a service' : 'Create a new eBPF task'"
            @click="showNewTask = true"
          >+ New Task</button>
        </div>
      </div>
      <div v-if="polling" class="poll-hint">Registering new task… refreshing in {{ countdown }}s</div>
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
          @click="onPickTask(t)"
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
        <EBPFProcessPicker v-model="selectedProcessIds" :processes="processes" />
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

  <NewEBPFTaskModal
    v-model:show="showNewTask"
    :service-name="serviceName"
    :process-labels="allProcessLabels"
    :could-profiling="couldProfiling"
    :error="newTaskError"
    @submit="onSubmitNewTask"
  />
</template>

<style scoped>
.ebpf-shell {
  display: flex;
  height: calc(100vh - 200px);
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
</style>
