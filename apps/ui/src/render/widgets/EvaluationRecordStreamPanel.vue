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
<script setup lang="ts">
import { parseServiceName } from '@/utils/serviceName';
import { logRowKey } from '@/utils/logRow';
import type { GenAIEvaluationRecordStreamRow } from '@/layer/evaluation-record/useLayerEvaluationRecord';

defineProps<{
  rows: GenAIEvaluationRecordStreamRow[];
  selectedKey?: string | null;
}>();
const emit = defineEmits<{
  (e: 'select', payload: { row: GenAIEvaluationRecordStreamRow; key: string }): void;
  (e: 'jump-trace', payload: { traceId: string; ts: number }): void;
}>();

type Level = 'fail' | 'warning' | 'good' | 'excellent' | 'undefined';
const LEVEL_COLOR: Record<Level, string> = {
  fail: 'var(--sw-err)',
  warning: 'var(--sw-warn)',
  good: 'var(--sw-info)',
  excellent: 'var(--sw-ok)',
  undefined: 'var(--sw-fg-3)',
};

function levelOf(r: GenAIEvaluationRecordStreamRow): Level {
  const tag = (r.tags ?? []).find((t) => t.key.toLowerCase() === 'evaluation_level');
  const raw = (tag?.value ?? '').toLowerCase();
  if (raw === 'fail') return 'fail';
  if (raw === 'warning') return 'warning';
  if (raw === 'good') return 'good';
  if (raw === 'excellent') return 'excellent';
  return 'undefined';
}

function summariseContent(r: GenAIEvaluationRecordStreamRow): string {
  return (r.content ?? '').replace(/\s+/g, ' ').trim();
}

function fmtTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}
function fmtDate(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function keyOf(r: GenAIEvaluationRecordStreamRow, idx: number): string {
  return logRowKey(r, idx);
}
</script>

<template>
  <div class="lg-stream">
    <div
      v-for="(r, idx) in rows"
      :key="keyOf(r, idx)"
      class="lg-row"
      :class="[`lv-${levelOf(r)}`, { on: selectedKey != null && selectedKey === keyOf(r, idx) }]"
      @click="emit('select', { row: r, key: keyOf(r, idx) })"
    >
      <span class="lg-time mono">{{ fmtTime(r.timestamp) }}</span>
      <span class="lg-date mono dim">{{ fmtDate(r.timestamp) }}</span>
      <span class="lg-task mono dim" :title="r.taskName ?? '-'">{{ r.taskName ?? '-' }}</span>
      <span class="lg-lvl" :style="{ color: LEVEL_COLOR[levelOf(r)] }">{{ levelOf(r) }}</span>
      <span class="lg-svc mono dim">
        <span
          v-if="r.serviceName && parseServiceName(r.serviceName).group"
          class="lg-svc-group"
        >{{ parseServiceName(r.serviceName).group }}</span>
        {{ r.serviceName ? parseServiceName(r.serviceName).base : '-' }}
      </span>
      <span
        v-if="r.traceId"
        class="lg-trace mono"
        @click.stop="emit('jump-trace', { traceId: r.traceId, ts: r.timestamp })"
      >trace</span>
      <span v-else class="lg-trace-spacer" aria-hidden="true"></span>
      <span class="lg-content mono">
        <span v-if="r.valueType" class="lg-value-type">{{ r.valueType }}</span>
        <span class="lg-content-body">{{ summariseContent(r) }}</span>
      </span>
    </div>
  </div>
</template>

<style scoped>
.lg-stream { font-size: 11.5px; }
.lg-row {
  display: grid;
  grid-template-columns: 80px 60px 140px 72px 140px 60px 1fr;
  gap: 10px;
  align-items: center;
  padding: 4px 12px;
  border-bottom: 1px solid var(--sw-line);
  cursor: pointer;
}
.lg-row:hover { background: var(--sw-bg-2); }
.lg-row.on { background: var(--sw-accent-soft); }
.lg-row.lv-fail { box-shadow: inset 3px 0 0 var(--sw-err); }
.lg-row.lv-warning { box-shadow: inset 3px 0 0 var(--sw-warn); }
.lg-row.lv-good { box-shadow: inset 3px 0 0 var(--sw-info); }
.lg-row.lv-excellent { box-shadow: inset 3px 0 0 var(--sw-ok); }
.lg-time { font-family: var(--sw-mono); color: var(--sw-fg-1); }
.lg-date { font-size: 10px; }
.lg-lvl {
  font-size: 9.5px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  font-weight: 700;
}
.lg-task {
  font-size: 10.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.lg-svc { font-size: 10.5px; }
.lg-svc-group {
  display: inline-block;
  padding: 0 5px;
  margin-right: 4px;
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line-2);
  border-radius: 3px;
  font-size: 9.5px;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: var(--sw-fg-2);
  text-transform: uppercase;
}
.lg-trace {
  font-size: 10px;
  color: var(--sw-accent-2);
  cursor: pointer;
  padding: 1px 5px;
  background: var(--sw-accent-soft);
  border: 1px solid var(--sw-accent-line);
  border-radius: 3px;
}
.lg-trace:hover { color: var(--sw-fg-0); }
.lg-content {
  font-family: var(--sw-mono);
  font-size: 11px;
  color: var(--sw-fg-1);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.lg-value-type {
  flex: 0 0 auto;
  display: inline-block;
  padding: 0 5px;
  height: 14px;
  line-height: 14px;
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.04em;
  border-radius: 3px;
  text-transform: uppercase;
  font-family: var(--sw-mono);
  background: var(--sw-info-soft);
  color: var(--sw-info);
}
.lg-content-body {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mono { font-family: var(--sw-mono); }
.dim { color: var(--sw-fg-3); }
</style>
