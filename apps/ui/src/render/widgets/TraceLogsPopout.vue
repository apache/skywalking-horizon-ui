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
  A trace's logs — or one native span's — in a box over the trace, opened by
  the trace detail's Logs button or a span's Related logs button. The panel is
  mounted only while the box is open, so a trace costs no log read until the
  operator asks for one.

  Props:
    open                — show the box.
    traceId             — the trace.
    segmentId / spanId  — narrow to one native span.
    otlpSpanId          — narrow to one OTLP or Zipkin span.
    startMs / endMs     — the trace's span range (epoch ms).
  Emits:
    close               — ×, Escape or the backdrop.
-->
<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import Modal from '@/components/primitives/Modal.vue';
import TraceLogsPanel from './TraceLogsPanel.vue';

const { t } = useI18n({ useScope: 'global' });

const props = defineProps<{
  open: boolean;
  traceId: string | null;
  segmentId?: string;
  spanId?: number;
  otlpSpanId?: string;
  altTraceId?: string;
  startMs: number | null;
  endMs: number | null;
}>();
const emit = defineEmits<{ (e: 'close'): void }>();

const title = computed(() =>
  (props.segmentId && props.spanId !== undefined) || props.otlpSpanId ? t('Span logs') : t('Trace logs'),
);
</script>

<template>
  <Modal :open="open" :title="title" width="min(1200px, 94vw)" @close="emit('close')">
    <TraceLogsPanel
      v-if="open"
      class="trl-in-box"
      :trace-id="traceId"
      :segment-id="segmentId"
      :span-id="spanId"
      :otlp-span-id="otlpSpanId"
      :alt-trace-id="altTraceId"
      :start-ms="startMs"
      :end-ms="endMs"
    />
  </Modal>
</template>

<style scoped>
.trl-in-box { border: 1px solid var(--sw-line); border-radius: 4px; }
</style>
