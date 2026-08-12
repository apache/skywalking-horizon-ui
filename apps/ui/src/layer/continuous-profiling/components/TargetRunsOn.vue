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
  Where ONE target of the policy runs — the INSTANCES of the target service,
  each expanding to its processes.

  Paged, because a production service has dozens to 100+ instances with several
  processes each. Search matches instance AND process names, so a named process
  finds the instance holding it. The banner totals stay the denominator so a
  page never reads as the whole truth.

  Rows arrive as a PROP because OAP builds the roster target-independently, so
  it is fetched once for the whole policy.
-->
<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type {
  ContinuousProfilingMonitoringInstance,
  ContinuousProfilingTargetType,
} from '@skywalking-horizon-ui/api-client';
import Icon from '@/components/icons/Icon.vue';
import Btn from '@/components/primitives/Btn.vue';
import { matchRoster, pageOf } from '../data';

const props = defineProps<{
  target: ContinuousProfilingTargetType;
  rows: ContinuousProfilingMonitoringInstance[];
  loading: boolean;
  /** False when the roster could not be READ. An empty list then says nothing
   *  about whether an agent is reporting. */
  reachable: boolean;
  readError?: string | null;
  /** False when this target has not been applied — OAP is not evaluating it,
   *  so showing a roster for it would assert something untrue. */
  applied: boolean;
  /** The service these instances belong to; the root of what runs. */
  serviceName: string;
}>();

const { t } = useI18n();
const PAGE_SIZE = 20;
const STEP = 25;
const PROC_FIRST = 10;

const instanceQuery = ref('');
const page = ref(1);
const expanded = ref(new Set<string>());
const procLimit = ref(new Map<string, number>());

const count = (i: ContinuousProfilingMonitoringInstance): number => i.triggers[props.target]?.count ?? 0;
const lastAt = (i: ContinuousProfilingMonitoringInstance): number | null | undefined =>
  i.triggers[props.target]?.last;


const processCount = computed(() => props.rows.reduce((n, r) => n + r.processes.length, 0));
const firedCount = computed(() => props.rows.filter((r) => count(r) > 0).length);

const matchedInstances = computed(() => matchRoster(props.rows, instanceQuery.value));
const view = computed(() => pageOf(matchedInstances.value, page.value, PAGE_SIZE));
const shown = computed<ContinuousProfilingMonitoringInstance[]>(() => view.value.rows);

function goto(n: number): void {
  page.value = Math.min(Math.max(1, n), view.value.pages);
}

function toggleRow(id: string): void {
  const next = new Set(expanded.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  expanded.value = next;
}
function procsOf(inst: ContinuousProfilingMonitoringInstance) {
  return inst.processes.slice(0, procLimit.value.get(inst.id) ?? PROC_FIRST);
}
function moreProcs(inst: ContinuousProfilingMonitoringInstance): number {
  return Math.max(0, inst.processes.length - (procLimit.value.get(inst.id) ?? PROC_FIRST));
}
function showMoreProcs(inst: ContinuousProfilingMonitoringInstance): void {
  const next = new Map(procLimit.value);
  next.set(inst.id, (next.get(inst.id) ?? PROC_FIRST) + STEP);
  procLimit.value = next;
}
function when(ms: number | null | undefined): string {
  return ms ? new Date(ms).toLocaleString() : '—';
}
</script>

<template>
  <div class="runs">
    <header class="banner">
      <Icon name="svc" />
      <h4>{{ t('Where it runs') }}</h4>
      <span v-if="!applied" class="hint">{{ t('apply first — OAP is not evaluating this target yet') }}</span>
      <span v-else-if="loading" class="hint">{{ t('Reading data…') }}</span>
      <span v-else-if="!reachable" class="hint">{{ t('unreadable') }}</span>
      <span v-else class="hint">
        {{ t('{instances} instances · {processes} processes · {fired} triggered', {
          instances: rows.length, processes: processCount, fired: firedCount }) }}
      </span>
    </header>

    <div v-if="applied" class="body">
      <p class="note">
        {{ t('Read-only. The rule above applies to the whole service — it cannot be scoped to an instance. These are the instances and processes an eBPF agent evaluates it against.') }}
      </p>

      <p v-if="!reachable" class="note err">
        {{ t('Could not read the monitored instances for this service, so this list is unknown — not empty.') }}
        <span v-if="readError" class="faint-inline">{{ readError }}</span>
      </p>
      <p v-else-if="!rows.length" class="note">
        {{ t('No process of this service is reporting, so there is nothing to evaluate. A policy only sees processes an eBPF agent reports.') }}
      </p>

      <template v-else>
        <div class="tools">
          <input
            v-model="instanceQuery"
            class="filter"
            type="search"
            :placeholder="t('Search instance or process name…')"
            @input="page = 1"
          />
          <span class="matched">
            {{ instanceQuery
              ? t('{n} of {total} instances match', { n: matchedInstances.length, total: rows.length })
              : t('{n} instances', { n: rows.length }) }}
          </span>
        </div>

        <table class="runs-table">
          <thead>
            <tr>
              <th>{{ t('Instance / process') }}</th>
              <th>{{ t('Detect type') }}</th>
              <th>{{ t('Labels') }}</th>
              <th class="num">{{ t('Triggered') }}</th>
              <th class="num">{{ t('Last') }}</th>
            </tr>
          </thead>
          <tbody>
            <template v-for="inst in shown" :key="inst.id">
              <tr class="inst-row" @click="toggleRow(inst.id)">
                <td class="cell-name">
                  <Icon :name="expanded.has(inst.id) ? 'caret' : 'chev'" />
                  <span class="iname">{{ inst.name }}</span>
                </td>
                <td class="dim">{{ t('{n} proc', { n: inst.processes.length }) }}</td>
                <td></td>
                <td class="num" :class="{ fired: count(inst) > 0 }">{{ count(inst) }}×</td>
                <td class="num dim">{{ when(lastAt(inst)) }}</td>
              </tr>
              <template v-if="expanded.has(inst.id)">
                <tr v-for="p in procsOf(inst)" :key="p.id" class="proc-row">
                  <td class="cell-name indent"><span class="pname">{{ p.name }}</span></td>
                  <td><span class="tag">{{ p.detectType }}</span></td>
                  <td>
                    <span v-for="l in p.labels" :key="l" class="tag soft">{{ l }}</span>
                  </td>
                  <td class="num" :class="{ fired: (p.triggers[target]?.count ?? 0) > 0 }">
                    {{ p.triggers[target]?.count ?? 0 }}×
                  </td>
                  <td class="num dim">{{ when(p.triggers[target]?.last) }}</td>
                </tr>
                <tr v-if="moreProcs(inst)" class="proc-row">
                  <td class="cell-name indent" colspan="5">
                    <Btn kind="ghost" size="sm" @click="showMoreProcs(inst)">
                      {{ t('{n} more processes', { n: moreProcs(inst) }) }}
                    </Btn>
                  </td>
                </tr>
              </template>
            </template>
          </tbody>
        </table>

        <!-- Same pager vocabulary as Alarms, so paging reads identically
             wherever it appears. -->
        <nav v-if="view.pages > 1" class="pager">
          <span class="range mono">
            {{ t('{from}–{to} of {total}', {
              from: view.from, to: view.to, total: matchedInstances.length }) }}
          </span>
          <button type="button" class="pager-btn" :disabled="view.page <= 1" @click="goto(view.page - 1)">
            {{ t('‹ prev') }}
          </button>
          <span class="pageno mono">{{ t('page {p} / {total}', { p: view.page, total: view.pages }) }}</span>
          <button type="button" class="pager-btn" :disabled="view.page >= view.pages" @click="goto(view.page + 1)">
            {{ t('next ›') }}
          </button>
        </nav>
        <p v-if="instanceQuery && !matchedInstances.length" class="note">
          {{ t('No instance or process matches that filter.') }}
        </p>

        <p class="note faint">
          {{ t('This roster is every process that reported recently, not a live liveness check, and very large fleets may be capped by OAP before they reach this list.') }}
        </p>
      </template>
    </div>
  </div>
</template>

<style scoped>
.runs {
  margin-top: 6px;
}
.banner {
  display: flex;
  gap: 8px;
  align-items: baseline;
  padding: 6px 10px;
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line);
  border-radius: var(--sw-radius);
}
.banner h4 {
  margin: 0;
  font-size: var(--sw-fs-sm);
  font-weight: var(--sw-fw-semibold);
  color: var(--sw-fg-0);
}
.hint {
  font-size: var(--sw-fs-xs);
  color: var(--sw-fg-3);
}
.body {
  margin-top: 8px;
}
.note {
  margin: 0 0 6px;
  font-size: var(--sw-fs-xs);
  color: var(--sw-fg-3);
  line-height: var(--sw-lh-relaxed);
  display: flex;
  gap: 8px;
  align-items: center;
}
.note.faint {
  margin-top: 8px;
  padding-top: 6px;
  border-top: 1px solid var(--sw-line);
}
.faint-inline {
  color: var(--sw-fg-3);
}
.tools {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-bottom: 6px;
}
.filter {
  flex: 1 1 0;
  min-width: 0;
  background: var(--sw-bg-1);
  border: 1px solid var(--sw-line);
  border-radius: var(--sw-radius);
  color: var(--sw-fg-0);
  font-size: var(--sw-fs-xs);
  padding: 4px 8px;
}
.matched {
  flex: 0 0 auto;
  font-size: var(--sw-fs-xs);
  color: var(--sw-fg-3);
  white-space: nowrap;
}
.pager {
  display: flex;
  gap: 10px;
  align-items: center;
  justify-content: flex-end;
  padding: 6px 2px 0;
}
.range,
.pageno {
  font-size: var(--sw-fs-xs);
  color: var(--sw-fg-3);
}
.pager-btn {
  background: var(--sw-bg-1);
  border: 1px solid var(--sw-line);
  border-radius: var(--sw-radius);
  color: var(--sw-fg-1);
  font-size: var(--sw-fs-xs);
  padding: 3px 10px;
  cursor: pointer;
}
.pager-btn:hover:not(:disabled) {
  color: var(--sw-fg-0);
  border-color: var(--sw-line-2);
}
.pager-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
td.num.fired {
  color: var(--sw-ok);
  font-weight: var(--sw-fw-semibold);
}
.none {
  color: var(--sw-fg-3);
}
.note.err {
  color: var(--sw-err);
}
.runs-table {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--sw-fs-xs);
}
.runs-table th {
  text-align: left;
  font-weight: var(--sw-fw-medium);
  color: var(--sw-fg-3);
  padding: 4px 8px;
  border-bottom: 1px solid var(--sw-line);
  white-space: nowrap;
}
.runs-table th.num,
.runs-table td.num {
  text-align: right;
  font-family: var(--sw-mono);
  white-space: nowrap;
}
.runs-table th:nth-child(4),
.runs-table td:nth-child(4) {
  width: 90px;
}
.runs-table th:nth-child(5),
.runs-table td:nth-child(5) {
  width: 170px;
}
.runs-table td {
  padding: 4px 8px;
  border-bottom: 1px solid var(--sw-line);
  color: var(--sw-fg-2);
  vertical-align: middle;
}
.inst-row {
  cursor: pointer;
}
.inst-row:hover {
  background: var(--sw-bg-2);
}
.cell-name {
  display: flex;
  gap: 6px;
  align-items: center;
}
.cell-name.indent {
  padding-left: 26px;
}
.iname {
  color: var(--sw-fg-0);
  font-weight: var(--sw-fw-medium);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pname {
  font-family: var(--sw-mono);
  color: var(--sw-fg-1);
}
.dim {
  color: var(--sw-fg-3);
}
td.num.fired {
  color: var(--sw-ok);
  font-weight: var(--sw-fw-semibold);
}
.tag {
  border: 1px solid var(--sw-line-2);
  border-radius: var(--sw-radius);
  padding: 0 5px;
  color: var(--sw-fg-3);
  margin-right: 4px;
  white-space: nowrap;
}
.tag.soft {
  border-style: dashed;
}
</style>
