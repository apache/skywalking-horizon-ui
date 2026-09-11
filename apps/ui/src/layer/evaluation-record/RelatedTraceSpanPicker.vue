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
  The related-trace picker: the spans of one trace (native or OTLP), the ones
  OAP's judge samples marked LLM and shown first, so the operator picks the
  span an evaluation record points at instead of copying ids out of logs.
-->
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { NativeSpan, ZipkinSpan } from '@skywalking-horizon-ui/api-client';
import Modal from '@/components/primitives/Modal.vue';
import { useTraceDetail } from '@/layer/traces/useLayerTraces';
import { useZipkinTrace } from '@/layer/traces/useZipkinTraces';
import { useEmptyTraceRetry } from '@/layer/traces/useEmptyTraceRetry';
import { genAIContextOfNativeSpan, genAIContextOfZipkinSpan, type GenAISpanContext } from './genaiSpan';

/** One span, as the query condition addresses it. `null` means the whole trace. */
export type RelatedSpanPick =
  | { type: 'SKYWALKING_NATIVE'; segmentId: string; spanIndex: number }
  | { type: 'OTLP'; spanId: string };

const props = defineProps<{
  open: boolean;
  traceId: string;
  traceType: 'SKYWALKING_NATIVE' | 'OTLP';
  /** The tab's window: bounds the lookup where the trace is, which is what
   *  finds it at all with the cold stage on. */
  window: { startMs: number; endMs: number } | null;
}>();
const emit = defineEmits<{ close: []; pick: [pick: RelatedSpanPick | null] }>();
const { t } = useI18n();

// One source fetches at a time; the other's id is null so it fires nothing.
const nativeTraceId = computed(() => (props.open && props.traceType === 'SKYWALKING_NATIVE' ? props.traceId : null));
const otlpTraceId = computed(() => (props.open && props.traceType === 'OTLP' ? props.traceId : null));
// The window as it is, padded an hour each side so the HOUR-step bounds the
// BFF formats never round the trace out. A midpoint would search only the
// middle day of a range longer than one.
const HOUR_MS = 60 * 60_000;
const lookup = computed(() =>
  props.window ? { startMs: props.window.startMs - HOUR_MS, endMs: props.window.endMs + HOUR_MS } : null,
);
const native = useTraceDetail(nativeTraceId, computed(() => 'native' as const), lookup);
const otlp = useZipkinTrace(otlpTraceId, undefined, {
  endTs: computed(() => props.window?.endMs ?? null),
  lookback: computed(() => (props.window ? props.window.endMs - props.window.startMs : null)),
});

interface PickerRow {
  key: string;
  service: string;
  operation: string;
  startOffsetMs: number;
  durationMs: number;
  error: boolean;
  genAI: GenAISpanContext | null;
  pick: RelatedSpanPick;
}

function nativeRows(spans: NativeSpan[]): PickerRow[] {
  const t0 = Math.min(...spans.map((s) => s.startTime));
  return spans.map((s) => ({
    key: `${s.segmentId}/${s.spanId}`,
    service: s.serviceCode,
    operation: s.endpointName,
    startOffsetMs: s.startTime - t0,
    durationMs: Math.max(0, s.endTime - s.startTime),
    error: s.isError,
    genAI: genAIContextOfNativeSpan(s),
    pick: { type: 'SKYWALKING_NATIVE', segmentId: s.segmentId, spanIndex: s.spanId },
  }));
}
function otlpRows(spans: ZipkinSpan[]): PickerRow[] {
  const t0 = Math.min(...spans.map((s) => s.timestamp ?? Infinity));
  return spans.map((s) => ({
    key: s.id,
    service: s.localEndpoint?.serviceName ?? '',
    operation: s.name ?? '',
    startOffsetMs: Number.isFinite(t0) && s.timestamp != null ? (s.timestamp - t0) / 1000 : 0,
    durationMs: (s.duration ?? 0) / 1000,
    error: s.tags?.error != null,
    genAI: genAIContextOfZipkinSpan(s),
    pick: { type: 'OTLP', spanId: s.id },
  }));
}
const rows = computed<PickerRow[]>(() => {
  const list = props.traceType === 'OTLP' ? otlpRows(otlp.spans.value) : nativeRows(native.nativeDetail.value?.spans ?? []);
  return list.sort((a, b) => a.startOffsetMs - b.startOffsetMs);
});
const llmRows = computed(() => rows.value.filter((r) => r.genAI));
// Defaults to the judged spans; a trace with none shows everything, so the
// operator still sees what the id resolved to.
const llmOnly = ref(true);
watch(() => props.open, (open) => { if (open) llmOnly.value = true; });
const shown = computed(() => (llmOnly.value && llmRows.value.length > 0 ? llmRows.value : rows.value));
const loading = computed(() => (props.traceType === 'OTLP' ? otlp.isFetching.value : native.isFetching.value));
// Both trace routes answer 200 with `reachable: false` and an `error` when
// OAP cannot be read; that is a failure to show, not an empty trace to retry.
// A trace OAP has no record of yet is an empty answer to re-read, not a
// failure: the Zipkin route marks that case `notFound`.
const failure = computed<string | null>(() => {
  const thrown = props.traceType === 'OTLP' ? otlp.error.value : native.error.value;
  if (thrown) return String(thrown);
  if (props.traceType === 'OTLP') {
    const answer = otlp.data.value;
    return answer && answer.reachable === false && !answer.notFound ? (answer.error || t('Backend unreachable.')) : null;
  }
  const answer = native.nativeDetail.value;
  return answer && answer.reachable === false ? (answer.error || t('Backend unreachable.')) : null;
});

// A record is written when the judge answers; its trace's spans land on their
// own cycle, so a record judged seconds ago can name a trace that reads as
// empty for a moment.
const { pending: stillLooking } = useEmptyTraceRetry({
  active: computed(() => props.open),
  empty: computed(() => rows.value.length === 0),
  busy: loading,
  failed: computed(() => failure.value != null),
  refetch: () => (props.traceType === 'OTLP' ? otlp.refetch() : native.refetch()),
});

function fmtMs(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)} s`;
  return `${ms < 10 ? ms.toFixed(1) : Math.round(ms)} ms`;
}
</script>

<template>
  <Modal :open="open" :title="t('Pick a span in the trace')" width="min(1000px, 92vw)" fit-body @close="emit('close')">
    <div class="sp">
      <div class="sp-head">
        <code class="sp-tid mono" :title="traceId">{{ traceId }}</code>
        <span class="sp-type">{{ traceType === 'OTLP' ? 'OTLP' : 'SkyWalking Native' }}</span>
        <label class="sp-toggle" :class="{ off: llmRows.length === 0 }">
          <input v-model="llmOnly" type="checkbox" :disabled="llmRows.length === 0" />
          {{ t('LLM spans only') }}
        </label>
        <span class="hint">{{ t('{n} of {total} spans', { n: shown.length, total: rows.length }) }}</span>
        <button class="sw-btn small ghost sp-whole" type="button" @click="emit('pick', null)">{{ t('Use whole trace') }}</button>
      </div>
      <div v-if="loading && rows.length === 0" class="sp-empty">{{ t('Reading data…') }}</div>
      <div v-else-if="failure" class="banner err">{{ failure }}</div>
      <div v-else-if="rows.length === 0" class="sp-empty">
        {{ stillLooking ? t('No spans yet — the trace may still be landing; looking again…') : t('no span data') }}
      </div>
      <div v-else class="sp-scroll">
        <table class="sp-table">
          <thead>
            <tr>
              <th></th>
              <th>{{ t('Service') }}</th>
              <th>{{ t('Operation') }}</th>
              <th>{{ t('Model') }}</th>
              <th class="num">{{ t('Start') }}</th>
              <th class="num">{{ t('Duration') }}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in shown" :key="r.key" :class="{ llm: r.genAI != null, err: r.error }">
              <td><span v-if="r.genAI" class="sp-llm">LLM</span></td>
              <td class="mono" :title="r.service">{{ r.service || '—' }}</td>
              <td class="mono" :title="r.operation">{{ r.operation || '—' }}</td>
              <td class="mono">{{ r.genAI ? [r.genAI.provider, r.genAI.model].filter(Boolean).join(' / ') : '—' }}</td>
              <td class="mono num">+{{ fmtMs(r.startOffsetMs) }}</td>
              <td class="mono num">{{ fmtMs(r.durationMs) }}</td>
              <td><button class="sw-btn small primary sp-use" type="button" @click="emit('pick', r.pick)">{{ t('Use') }}</button></td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </Modal>
</template>

<style scoped>
.sp { display: flex; flex-direction: column; min-height: 200px; max-height: 70vh; }
.sp-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--sw-line);
  flex-wrap: wrap;
}
.sp-tid { font-family: var(--sw-mono); font-size: 11.5px; color: var(--sw-fg-1); max-width: 40ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sp-type {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--sw-accent-2);
  background: var(--sw-accent-soft);
  border: 1px solid var(--sw-accent-line);
  padding: 1px 6px;
  border-radius: 4px;
}
.sp-toggle { display: inline-flex; align-items: center; gap: 6px; font-size: 11.5px; color: var(--sw-fg-2); }
.sp-toggle.off { color: var(--sw-fg-3); }
.hint { font-size: 10.5px; color: var(--sw-fg-3); }
.sp-whole { margin-left: auto; }
.sp-empty { padding: 24px 12px; font-size: 11.5px; color: var(--sw-fg-3); text-align: center; }
.banner.err { margin: 12px; }
.sp-scroll { overflow: auto; }
.sp-table { width: 100%; border-collapse: collapse; font-size: 11.5px; }
.sp-table th {
  position: sticky;
  top: 0;
  background: var(--sw-bg-2);
  text-align: left;
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--sw-fg-3);
  font-weight: 600;
  padding: 6px 10px;
  border-bottom: 1px solid var(--sw-line);
}
.sp-table td { padding: 5px 10px; border-bottom: 1px solid var(--sw-line-soft, var(--sw-line)); color: var(--sw-fg-2); max-width: 32ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sp-table .num { text-align: right; }
.sp-table tr.llm td { color: var(--sw-fg-1); }
.sp-table tr.llm { background: var(--sw-accent-soft); }
.sp-table tr.err td.mono:nth-child(3) { color: var(--sw-err); }
.sp-llm {
  font-size: 9.5px;
  font-weight: 700;
  letter-spacing: 0.08em;
  color: var(--sw-accent-2);
  border: 1px solid var(--sw-accent-line);
  border-radius: 3px;
  padding: 0 4px;
}
</style>
