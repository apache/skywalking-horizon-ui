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
  Record-list widget — slow-SQL / slow-statement samples (a `record`
  widget). Each row is one sampled statement execution:

    - a jump-to-trace icon at the head, shown ONLY when the sample carries
      a trace id (these are sampled, so the trace can be absent);
    - the statement text, click-to-copy;
    - the metric value (latency) + unit.

  Compare mode keeps the plain TopList (no single trace to jump to); this
  is the single-entity drill-in.
-->
<script setup lang="ts">
import { ref } from 'vue';
import Icon from '@/components/icons/Icon.vue';
import { useTracePopout } from '@/layer/traces/useTracePopout';
import { fmtMetric } from '@/utils/formatters';

interface RecordRow {
  name: string;
  value?: number | null;
  traceId?: string;
}
defineProps<{ items: ReadonlyArray<RecordRow>; unit?: string; color?: string }>();

const { openTrace } = useTracePopout();

const copiedIdx = ref<number | null>(null);
let copiedTimer: ReturnType<typeof setTimeout> | null = null;
async function copyStatement(text: string, idx: number): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    /* clipboard blocked (insecure context / no permission) — no-op */
  }
  copiedIdx.value = idx;
  if (copiedTimer) clearTimeout(copiedTimer);
  copiedTimer = setTimeout(() => {
    copiedIdx.value = null;
  }, 1200);
}
</script>

<template>
  <ul class="record-list">
    <li v-for="(r, i) in items" :key="i" class="rec-row">
      <button
        v-if="r.traceId"
        type="button"
        class="rec-trace"
        title="Open the originating trace"
        @click="openTrace(r.traceId!)"
      >
        <Icon name="trace" :size="12" />
      </button>
      <span v-else class="rec-trace-spacer" aria-hidden="true" />
      <button
        type="button"
        class="rec-stmt"
        :title="copiedIdx === i ? 'Copied to clipboard' : 'Click to copy statement'"
        @click="copyStatement(r.name, i)"
      >
        <span class="rec-stmt-text">{{ r.name }}</span>
        <span v-if="copiedIdx === i" class="rec-copied">copied</span>
      </button>
      <span class="rec-val" :style="{ color }">
        {{ fmtMetric(r.value ?? null) }}<span v-if="unit" class="rec-unit">{{ unit }}</span>
      </span>
    </li>
    <li v-if="items.length === 0" class="rec-empty">no records</li>
  </ul>
</template>

<style scoped>
.record-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
}
.rec-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 8px;
  border-bottom: 1px solid var(--sw-line);
  min-width: 0;
}
.rec-row:last-child {
  border-bottom: none;
}
.rec-trace,
.rec-trace-spacer {
  flex: 0 0 auto;
  width: 20px;
  height: 20px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.rec-trace {
  padding: 0;
  border: 1px solid var(--sw-line-2);
  border-radius: 4px;
  background: var(--sw-bg-2);
  color: var(--sw-accent-2);
  cursor: pointer;
}
.rec-trace:hover {
  border-color: var(--sw-accent-line);
  background: var(--sw-accent-soft);
}
.rec-stmt {
  flex: 1;
  min-width: 0;
  display: inline-flex;
  align-items: baseline;
  gap: 6px;
  padding: 0;
  background: transparent;
  border: 0;
  text-align: left;
  cursor: pointer;
  color: var(--sw-fg-1);
}
.rec-stmt-text {
  font-family: var(--sw-mono);
  font-size: 11px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}
.rec-stmt:hover .rec-stmt-text {
  color: var(--sw-fg-0);
}
.rec-copied {
  flex: 0 0 auto;
  font-size: 9.5px;
  color: var(--sw-ok);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
.rec-val {
  flex: 0 0 auto;
  font-family: var(--sw-mono);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  font-weight: 600;
}
.rec-unit {
  margin-left: 2px;
  font-size: 9.5px;
  color: var(--sw-fg-3);
}
.rec-empty {
  padding: 12px;
  text-align: center;
  color: var(--sw-fg-3);
  font-size: 11px;
  font-style: italic;
}
</style>
