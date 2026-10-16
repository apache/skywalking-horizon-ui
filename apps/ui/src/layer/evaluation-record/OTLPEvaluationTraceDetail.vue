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
import { computed, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useQueryClient } from '@tanstack/vue-query';
import { useI18n } from 'vue-i18n';
import TraceQLDetailCard from '@/layer/traceql/TraceQLDetailCard.vue';
import { clearTraceQLPopout, TRACEQL_EVALUATION_QUERY } from '@/layer/traceql/useTraceQLTracePopout';
import { TRACEQL_POPOUT_QUERY } from '@/layer/traceql/traceqlDetailShared';
import { withTraceFocus } from '@/layer/traces/tracePopoutQuery';
import { useEmptyTraceRetry } from '@/layer/traces/useEmptyTraceRetry';
import { useEvaluationOTLPTrace } from './useEvaluationOTLPTrace';

const props = defineProps<{ traceId: string; spanId?: string; atMs?: number }>();
const emit = defineEmits<{ close: [] }>();
const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const client = useQueryClient();
const HALF_DAY_MS = 12 * 60 * 60_000;
const window = computed(() => props.atMs ? { startMs: props.atMs - HALF_DAY_MS, endMs: props.atMs + HALF_DAY_MS } : null);
const detail = useEvaluationOTLPTrace(computed(() => props.traceId), window);
const { pending } = useEmptyTraceRetry({
  active: computed(() => !!props.traceId),
  empty: computed(() => detail.otlpSpans.value.length === 0 && detail.zipkinSpans.value.length === 0),
  busy: detail.isFetching,
  failed: computed(() => !!detail.failure.value),
  refetch: detail.refetch,
});

watch(detail.data, (data) => {
  if (data?.source !== 'zipkin' || data.detail.spans.length === 0) return;
  if (route.query[TRACEQL_POPOUT_QUERY] !== props.traceId || route.query[TRACEQL_EVALUATION_QUERY] !== '1') return;
  const endTs = window.value?.endMs ?? null;
  const lookback = window.value ? window.value.endMs - window.value.startMs : null;
  client.setQueryData(['zipkin-trace', props.traceId, endTs, lookback], data.detail);
  const query = withTraceFocus(clearTraceQLPopout(route.query), { spanId: props.spanId });
  query.traceId = props.traceId;
  query.traceType = 'OTLP';
  delete query.traceAt;
  delete query.traceEnd;
  delete query.traceLookback;
  if (props.atMs) query.traceAt = String(props.atMs);
  void router.replace({ path: route.path, query });
}, { immediate: true });
</script>

<template>
  <div class="evaluation-trace">
    <div v-if="detail.failure.value" class="sw-card note" role="alert">
      <p>{{ detail.failure.value }}</p>
      <button class="sw-btn" type="button" @click="emit('close')">{{ t('Close') }}</button>
    </div>
    <div v-else-if="detail.otlpSpans.value.length === 0" class="sw-card note">
      <p>{{ detail.isFetching.value || pending ? t('Reading data…') : t('No trace with that id.') }}</p>
      <button class="sw-btn" type="button" @click="emit('close')">{{ t('Close') }}</button>
    </div>
    <TraceQLDetailCard v-else ds="otlp" :trace-id="traceId" :spans="detail.otlpSpans.value" :focus-span-id="spanId" @close="emit('close')" />
  </div>
</template>

<style scoped>
.evaluation-trace { min-width: 0; }
.note { padding: 14px; }
</style>
