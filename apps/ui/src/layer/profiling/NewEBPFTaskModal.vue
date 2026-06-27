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
  Create-task form for the eBPF profiling tab. Owns the form state (process
  labels, ON/OFF_CPU target, start-now-vs-set, duration) and emits the
  resolved payload on `submit`; the parent runs the create + post-create
  poll and closes the dialog. The form clears its label selection each time
  the dialog opens so a fresh task starts from a clean filter.
-->
<script setup lang="ts">
import { reactive, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useEscapeToClose } from '@/components/primitives/useEscapeToClose';
import type { EBPFTargetType } from '@/api/client';
import type { NewEBPFTaskPayload } from '@/layer/profiling/useEBPFProfiling';

const props = defineProps<{
  show: boolean;
  serviceName: string | null;
  processLabels: string[];
  couldProfiling: boolean;
  error: string | null;
}>();
const emit = defineEmits<{
  (e: 'update:show', show: boolean): void;
  (e: 'submit', payload: NewEBPFTaskPayload): void;
}>();

const { t } = useI18n();

const newTask = reactive({
  labels: [] as string[],
  targetType: 'ON_CPU' as EBPFTargetType,
  monitorTime: 'now' as 'now' | 'set',
  monitorTimeAt: new Date(),
  monitorMinutes: 10,
});

function resetForm(): void {
  newTask.labels = [];
  newTask.targetType = 'ON_CPU';
  newTask.monitorTime = 'now';
  newTask.monitorTimeAt = new Date();
  newTask.monitorMinutes = 10;
}
watch(
  () => props.show,
  (open) => {
    if (open) resetForm();
  },
);

function toggleNewTaskLabel(l: string): void {
  const i = newTask.labels.indexOf(l);
  if (i === -1) newTask.labels.push(l);
  else newTask.labels.splice(i, 1);
}

function close(): void {
  emit('update:show', false);
}

useEscapeToClose(
  () => props.show,
  close,
);

function submit(): void {
  const start =
    newTask.monitorTime === 'now' ? Date.now() : newTask.monitorTimeAt.getTime();
  emit('submit', {
    labels: newTask.labels,
    targetType: newTask.targetType,
    startTime: start,
    monitorMinutes: newTask.monitorMinutes,
  });
}
</script>

<template>
  <div v-if="show" class="dlg-mask" @click.self="close">
    <div class="dlg">
      <div class="dlg-head">
        <div>
          New eBPF profile task
          <span v-if="serviceName" class="muted">on {{ serviceName }}</span>
        </div>
        <button class="x" @click="close">×</button>
      </div>
      <div class="dlg-body">
        <div v-if="!couldProfiling" class="dlg-warn">
          <strong>{{ t('OAP reports no profilable processes for this service.') }}</strong>
          <span>A new task can't run until OAP sees an eBPF-profilable process. Check that:</span>
          <ul>
            <li>instances are running and instrumented;</li>
            <li>eBPF collection is enabled in OAP;</li>
            <li>the processes support eBPF profiling.</li>
          </ul>
        </div>
        <div class="field">
          <label>Process labels (filter; leave empty = all)</label>
          <div class="chip-row">
            <button
              v-for="l in processLabels"
              :key="l"
              type="button"
              class="chip"
              :class="{ on: newTask.labels.includes(l) }"
              @click="toggleNewTaskLabel(l)"
            >{{ l }}</button>
            <span v-if="!processLabels.length" class="muted">No labels surfaced by OAP.</span>
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
        <div v-if="error" class="dlg-err">{{ error }}</div>
      </div>
      <div class="dlg-foot">
        <button class="btn-secondary" @click="close">Cancel</button>
        <button
          class="btn-primary"
          :disabled="!couldProfiling"
          :title="couldProfiling ? '' : t('OAP reports no profilable processes for this service')"
          @click="submit"
        >Create task</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.muted {
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
.dlg-warn {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px 12px;
  font-size: 11.5px;
  color: var(--sw-fg-1);
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line);
  border-left: 3px solid var(--sw-err);
  border-radius: 4px;
}
.dlg-warn strong {
  color: var(--sw-err);
  font-weight: 600;
}
.dlg-warn ul {
  margin: 0;
  padding-left: 18px;
  color: var(--sw-fg-2);
}
</style>
