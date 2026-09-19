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
  TraceQL trace detail.

  A thin fetch around {@link TraceQLDetailCard}: the views are TraceQL's own,
  because converting OTLP into SkyWalking's span model is OAP's job rather than
  Horizon's. The two detail stacks look alike on purpose and share no code.
-->
<script setup lang="ts">
import { computed, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { TraceQLDatasource } from '@skywalking-horizon-ui/api-client';
import TraceQLDetailCard from './TraceQLDetailCard.vue';
import { useTraceQLTrace } from './useTraceQL';

const props = defineProps<{ ds: TraceQLDatasource; traceId: string }>();
const emit = defineEmits<{
  (e: 'close'): void;
  /** A trace's status, derived from its spans, once they are known. The list
   *  cannot answer this — the search response carries no failure marker — so
   *  the row stays unknown until a detail says otherwise. */
  (e: 'status', value: { traceId: string; isError: boolean }): void;
}>();

const { t } = useI18n({ useScope: 'global' });
const traceId = computed(() => props.traceId);
const ds = computed(() => props.ds);
// A lookup by id needs no window: this API answers one across its whole
// history, which is what an id pasted from a log row wants.
const detail = useTraceQLTrace(ds, traceId, computed(() => null));

// A trace is failed when any of its spans is: that is what the spans say, and
// it is the same rule the Zipkin list applies to its own error tag.
watch(
  () => detail.spans.value,
  (list) => {
    if (list.length === 0) return;
    // `unset` is OTLP's absence of a verdict: a trace of only-unset spans
    // stays unknown, exactly as the deferred check leaves it. Reporting
    // `false` here would turn opening a trace into a claim of success.
    if (!list.some((s) => s.status !== 'unset')) return;
    emit('status', { traceId: props.traceId, isError: list.some((s) => s.status === 'error') });
  },
  { immediate: true },
);
</script>

<template>
  <div class="tqd">
    <p v-if="detail.notFound.value" class="tqd-note sw-card">{{ t('No trace with that id.') }}</p>
    <p v-else-if="!detail.reachable.value" class="tqd-note sw-card err">
      {{ t('The trace source is not answering.') }}
    </p>
    <TraceQLDetailCard
      v-else
      :ds="ds"
      :trace-id="traceId"
      :spans="detail.spans.value"
      :loading="detail.isFetching.value"
      @close="emit('close')"
    />
  </div>
</template>

<style scoped>
.tqd { min-width: 0; }
.tqd-note { padding: 14px; font-size: 12px; color: var(--sw-fg-3); }
.tqd-note.err { color: var(--sw-err); border-color: var(--sw-err); }
</style>
