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
  The stored log lines that carry a trace's id, paged and oldest first — or
  one span's: a native span by segment id and span id, an OTLP or Zipkin span
  by its hex id.

  Props:
    traceId    — the trace.
    segmentId  — with spanId, narrows to one native span.
    spanId     — the span's id within that segment.
    otlpSpanId — narrows to one OTLP or Zipkin span.
    startMs    — the trace's earliest span start (epoch ms).
    endMs      — the trace's latest span end (epoch ms).
-->
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { LogRow } from '@/api/client';
import LogStreamPanel from './LogStreamPanel.vue';
import LogDetailPopout from './LogDetailPopout.vue';
import LogOpenModeToggle from './LogOpenModeToggle.vue';
import Icon from '@/components/icons/Icon.vue';
import { useTraceLogs, type TraceLogsScope } from './useTraceLogs';

const { t } = useI18n({ useScope: 'global' });

const props = defineProps<{
  traceId: string | null;
  segmentId?: string;
  spanId?: number;
  otlpSpanId?: string;
  altTraceId?: string;
  startMs: number | null;
  endMs: number | null;
}>();

const forNativeSpan = computed(() => !!props.segmentId && props.spanId !== undefined);
const forSpan = computed(() => forNativeSpan.value || !!props.otlpSpanId);
const scope = computed<TraceLogsScope | null>(() => {
  if (!props.traceId || props.startMs == null || props.endMs == null) return null;
  return {
    traceId: props.traceId,
    startMs: props.startMs,
    endMs: props.endMs,
    ...(forNativeSpan.value ? { segmentId: props.segmentId, spanId: props.spanId } : {}),
    ...(props.otlpSpanId ? { otlpSpanId: props.otlpSpanId } : {}),
    ...(props.altTraceId ? { altTraceId: props.altTraceId } : {}),
  };
});
// A re-read over cached rows (a reopened box, a flipped Cold pill) hides them
// until it lands: rows from the previous read under a spinner read as the new ones.
const { page, data, logs, hasNext, withheld, isFetching, error } = useTraceLogs(scope);

const popoutRow = ref<LogRow | null>(null);
watch(scope, () => { popoutRow.value = null; });

function fmt(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
const searched = computed(() => (data.value ? `${fmt(data.value.startMs)} → ${fmt(data.value.endMs)}` : null));
</script>

<template>
  <section class="trl">
    <div class="trl-head">
      <span class="trl-scope">
        <template v-if="forNativeSpan">{{ t('Logs of this span') }} <span class="mono dim">{{ t('segment') }} {{ segmentId }} · {{ t('span') }} {{ spanId }}</span></template>
        <template v-else-if="otlpSpanId">{{ t('Logs of this span') }} <span class="mono dim">{{ t('span') }} {{ otlpSpanId }}</span></template>
        <template v-else>{{ t('Logs carrying this trace id') }}</template>
      </span>
      <span v-if="searched" class="trl-window mono" :title="t('The span range of the trace, widened by 5 minutes on each side')">{{ t('searched') }} {{ searched }}</span>
      <LogOpenModeToggle class="trl-mode" />
    </div>

    <div v-if="data?.windowClipped && !isFetching" class="trl-notice">{{ t('The trace runs longer than one read can search, so only its last week was searched.') }}</div>
    <div v-if="!scope" class="trl-empty">{{ t('The trace has no span times to search around.') }}</div>
    <div v-else-if="isFetching" class="trl-empty trl-loading"><Icon name="refresh" :size="14" class="trl-spin" />{{ t('Reading logs…') }}</div>
    <div v-else-if="error !== null" class="trl-empty err">{{ t('The log read failed') }}<template v-if="error"> — {{ error }}</template></div>
    <!-- Lines are left out after OAP pages them, so an empty page says only
         what is true of this page; "no logs carry this trace" needs the first
         and only page, with nothing left out. -->
    <div v-else-if="logs.length === 0 && withheld > 0" class="trl-empty">
      <div>{{ t('Every line on this page comes from a service you may not read ({n} left out).', { n: withheld }) }}</div>
      <div v-if="hasNext" class="trl-note">{{ t('Later pages may hold lines you can read.') }}</div>
    </div>
    <div v-else-if="logs.length === 0 && page > 1" class="trl-empty">{{ t('No more lines.') }}</div>
    <div v-else-if="logs.length === 0" class="trl-empty">
      <div>{{ forSpan ? t('No logs carry this span in the searched window.') : t('No logs carry this trace id in the searched window.') }}</div>
      <div class="trl-note">{{ t('A log links to a trace only when its reporter or a LAL rule sets the trace id.') }}</div>
    </div>
    <template v-else>
      <div v-if="withheld > 0" class="trl-notice">{{ t('{n} lines on this page come from services you may not read and are left out.', { n: withheld }) }}</div>
      <LogStreamPanel :rows="logs" :trace-links="false" @open="popoutRow = $event.row" />
    </template>

    <div v-if="scope && (page > 1 || hasNext)" class="trl-pager">
      <span class="hint">{{ t('page {page} · showing {shown}', { page, shown: logs.length }) }}</span>
      <div class="trl-pager-ctrls">
        <button class="sw-btn small" type="button" :disabled="page <= 1" @click="page--">{{ t('Prev') }}</button>
        <button class="sw-btn small" type="button" :disabled="!hasNext" @click="page++">{{ t('Next') }}</button>
      </div>
    </div>

    <LogDetailPopout :row="popoutRow" :trace-link="false" @close="popoutRow = null" />
  </section>
</template>

<style scoped>
.trl { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
.mono { font-family: var(--sw-mono); }
.dim { color: var(--sw-fg-3); }
.trl-head {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  padding: 6px 12px;
  border-bottom: 1px solid var(--sw-line);
  font-size: 11px;
  color: var(--sw-fg-2);
}
.trl-scope { font-weight: 600; }
.trl-scope .mono { font-weight: 400; margin-left: 6px; font-size: 10.5px; overflow-wrap: anywhere; }
.trl-window { font-size: 10.5px; color: var(--sw-fg-3); }
.trl-mode { margin-left: auto; }
.trl-empty {
  padding: 24px 12px;
  text-align: center;
  color: var(--sw-fg-3);
  font-size: 11.5px;
}
.trl-empty.err { color: var(--sw-err); }
.trl-loading { display: flex; align-items: center; justify-content: center; gap: 8px; }
.trl-loading :deep(svg.trl-spin) { animation: trl-spin 0.9s linear infinite; }
@keyframes trl-spin { to { transform: rotate(360deg); } }
.trl-note { margin-top: 6px; font-size: 10.5px; }
.trl-notice { padding: 6px 12px; font-size: 10.5px; color: var(--sw-fg-3); border-bottom: 1px solid var(--sw-line); }
.trl-pager {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 12px;
  border-top: 1px solid var(--sw-line);
}
.trl-pager .hint { font-size: 10.5px; color: var(--sw-fg-3); }
.trl-pager-ctrls { margin-left: auto; display: inline-flex; gap: 6px; }
.sw-btn.small { height: 24px; padding: 0 10px; font-size: 11px; }
</style>
