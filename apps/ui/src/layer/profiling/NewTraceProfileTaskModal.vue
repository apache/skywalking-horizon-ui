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
  Create-task form for the trace profiling tab. Owns the form state (endpoint,
  start-now-vs-set, duration, threshold, dump period, sampling) and emits the
  resolved payload on `submit`; the parent runs the create + post-create poll
  and closes the dialog. The endpoint search keyword is two-way bound so the
  parent's endpoint composable drives the option list. The form resets each
  time the dialog opens so a fresh task starts clean.
-->
<script setup lang="ts">
import { reactive, watch } from 'vue';
import { useEscapeToClose } from '@/components/primitives/useEscapeToClose';
import EndpointCombo from '@/layer/_shared/EndpointCombo.vue';

export interface EndpointPick {
  id: string;
  name: string;
}

export interface NewTraceTaskPayload {
  endpointName: string;
  startTime: number;
  duration: number;
  minDurationThreshold: number;
  dumpPeriod: number;
  maxSamplingCount: number;
}

const props = defineProps<{
  show: boolean;
  serviceName: string | null;
  endpoints: EndpointPick[];
  keyword: string;
  error: string | null;
}>();
const emit = defineEmits<{
  (e: 'update:show', show: boolean): void;
  (e: 'update:keyword', keyword: string): void;
  (e: 'submit', payload: NewTraceTaskPayload): void;
}>();

const newTask = reactive({
  endpointName: '',
  monitorTime: 'now' as 'now' | 'set',
  monitorTimeAt: new Date(),
  monitorDuration: 5,
  minThreshold: 0,
  dumpPeriod: 10,
  maxSamplingCount: 5,
});

function reset(): void {
  newTask.endpointName = '';
  newTask.monitorTime = 'now';
  newTask.monitorTimeAt = new Date();
  newTask.monitorDuration = 5;
  newTask.minThreshold = 0;
  newTask.dumpPeriod = 10;
  newTask.maxSamplingCount = 5;
}

watch(
  () => props.show,
  (open) => {
    if (open) reset();
  },
);

function close(): void {
  emit('update:show', false);
}

useEscapeToClose(
  () => props.show,
  close,
);

function submit(): void {
  const startTime =
    newTask.monitorTime === 'now' ? Date.now() : newTask.monitorTimeAt.getTime();
  emit('submit', {
    endpointName: newTask.endpointName,
    startTime,
    duration: Number(newTask.monitorDuration),
    minDurationThreshold: Number(newTask.minThreshold),
    dumpPeriod: Number(newTask.dumpPeriod),
    maxSamplingCount: Number(newTask.maxSamplingCount),
  });
}
</script>

<template>
  <div v-if="show" class="dlg-mask" @click.self="close">
    <div class="dlg">
      <div class="dlg-head">
        <div>
          New profile task
          <span v-if="serviceName" class="muted">on {{ serviceName }}</span>
        </div>
        <button class="x" @click="close">×</button>
      </div>
      <div class="dlg-body">
        <div class="field">
          <label>Endpoint name</label>
          <EndpointCombo
            :endpoints="endpoints"
            :selected="newTask.endpointName || null"
            placeholder="(any)"
            @update:query="(q: string) => emit('update:keyword', q)"
            @pick="(name: string) => (newTask.endpointName = name)"
            @clear="newTask.endpointName = ''"
          />
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
        <div v-if="error" class="dlg-err">{{ error }}</div>
      </div>
      <div class="dlg-foot">
        <button class="btn-secondary" @click="close">Cancel</button>
        <button class="btn-primary" @click="submit">Create task</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.muted {
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
</style>
