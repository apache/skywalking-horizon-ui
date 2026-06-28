/*
 * Licensed to the Apache Software Foundation (ASF) under one or more
 * contributor license agreements.  See the NOTICE file distributed with
 * this work for additional information regarding copyright ownership.
 * The ASF licenses this file to You under the Apache License, Version 2.0
 * (the "License"); you may not use this file except in compliance with
 * the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * Data orchestration for the per-layer eBPF profiling tab — task list,
 * schedules, filter state, and the analyze run that feeds the flamegraph /
 * tree view. The view layer keeps only display toggles (flame vs. tree,
 * highlight-top) + the teleported pickers; everything that talks to OAP and
 * the derived state it produces lives here.
 *
 * Inputs are the URL-bound layer key + selected service id (both refs) so
 * the composable re-fires when the operator switches service or layer.
 */

import { computed, ref, watch, type Ref } from 'vue';
import { bffClient } from '@/api/client';
import type {
  EBPFAnalysisTree,
  EBPFProcess,
  EBPFSchedule,
  EBPFTargetType,
  EBPFTask,
  ProfileAnalyzationTree,
} from '@/api/client';
import { useNewTaskPoll } from '@/layer/profiling/useNewTaskPoll';

export interface NewEBPFTaskPayload {
  labels: string[];
  targetType: EBPFTargetType;
  /** Epoch ms the task starts monitoring. */
  startTime: number;
  /** Monitor window in minutes (1–60). */
  monitorMinutes: number;
}

export function useEBPFProfiling(layerKey: Ref<string>, selectedId: Ref<string | null>) {
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

  const newTaskError = ref<string | null>(null);
  const { polling, countdown, pollForNewTask } = useNewTaskPoll();

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

  const labelOptions = computed<string[]>(() => {
    const s = new Set<string>();
    for (const sc of schedules.value)
      for (const l of sc.process.labels ?? []) s.add(l);
    return [...s];
  });
  const processes = computed<EBPFProcess[]>(() => {
    const byId = new Map<string, EBPFProcess>();
    for (const sc of schedules.value) byId.set(sc.process.id, sc.process);
    return [...byId.values()];
  });
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

  async function submitNewTask(payload: NewEBPFTaskPayload): Promise<void> {
    if (!selectedId.value) {
      newTaskError.value = 'Pick a service first';
      return;
    }
    newTaskError.value = null;
    const idsBefore = new Set(tasks.value.map((t) => t.taskId));
    try {
      const resp = await bffClient.ebpf.create(layerKey.value, {
        serviceId: selectedId.value,
        processLabels: payload.labels,
        startTime: payload.startTime,
        duration: Number(payload.monitorMinutes) * 60,
        targetType: payload.targetType,
      });
      if (!resp.status && resp.errorReason) {
        newTaskError.value = resp.errorReason;
        return;
      }
      if (!resp.reachable && resp.error) {
        newTaskError.value = resp.error;
        return;
      }
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

  function toggleLabel(l: string): void {
    const i = selectedLabels.value.indexOf(l);
    if (i === -1) selectedLabels.value.push(l);
    else selectedLabels.value.splice(i, 1);
  }

  return {
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
  };
}
