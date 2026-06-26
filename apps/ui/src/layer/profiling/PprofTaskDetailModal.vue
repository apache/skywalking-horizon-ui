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
  Read-only task-detail modal for the pprof (Go) profiling tab: the task's
  create parameters plus the per-instance operation logs OAP fanned the task
  out to. Opening it must not disturb the parent's selected-task / analyze
  state, so it is driven by its own `task` ref in the parent. `fmtTime` is
  injected so the timestamp format stays identical to the surrounding task
  list. Mirrors TraceProfileTaskDetailModal, but pprof tasks carry an event
  type + optional duration / dumpPeriod instead of endpoint + thresholds.
-->
<script setup lang="ts">
import type { PprofTask, AsyncProfilingProgressLog } from '@/api/client';
import { useEscapeToClose } from '@/components/primitives/useEscapeToClose';

const props = defineProps<{
  task: PprofTask | null;
  serviceName: string | null;
  logs: AsyncProfilingProgressLog[];
  fmtTime: (ms: number) => string;
}>();
const emit = defineEmits<{
  (e: 'close'): void;
}>();

useEscapeToClose(
  () => props.task != null,
  () => emit('close'),
);
</script>

<template>
  <div v-if="task" class="dlg-mask" @click.self="emit('close')">
    <div class="dlg wide">
      <div class="dlg-head">
        <div>pprof task detail</div>
        <button class="x" @click="emit('close')">×</button>
      </div>
      <div class="dlg-body">
        <dl class="kv">
          <dt>Service</dt><dd>{{ serviceName ?? task.serviceId }}</dd>
          <dt>Instances</dt><dd>{{ task.serviceInstanceIds?.length ?? 0 }}</dd>
          <dt>Event</dt><dd>{{ task.events }}</dd>
          <dt>Create time</dt><dd>{{ fmtTime(task.createTime) }}</dd>
          <dt v-if="task.duration != null">Duration</dt>
          <dd v-if="task.duration != null">{{ task.duration }} min</dd>
          <dt v-if="task.dumpPeriod != null">Dump period</dt>
          <dd v-if="task.dumpPeriod != null">{{ task.dumpPeriod }}</dd>
        </dl>
        <div v-if="logs.length" class="logs">
          <h5>Instance logs</h5>
          <div v-for="(log, i) in logs" :key="i" class="log-line">
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
.muted {
  color: var(--sw-fg-3);
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
.t-tag {
  font-size: 10px;
  padding: 0 5px;
  border-radius: 2px;
  background: #6c5cd9;
  color: #fff;
  font-weight: 600;
}
</style>
