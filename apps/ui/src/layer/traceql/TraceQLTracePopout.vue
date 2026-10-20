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
  Global TraceQL trace popout: a trace read through a TraceQL store, opened
  over the current page by `useTraceQLTracePopout().openTrace(id, ds)`, as the
  native popout opens a native trace.
-->
<script setup lang="ts">
import { useEscapeToClose } from '@/components/primitives/useEscapeToClose';
import TraceQLTraceDetail from './TraceQLTraceDetail.vue';
import { useTraceQLTracePopout } from './useTraceQLTracePopout';

const { open, closeTrace } = useTraceQLTracePopout();
useEscapeToClose(() => open.value !== null, closeTrace);
</script>

<template>
  <div v-if="open" class="tqp-overlay" @click.self="closeTrace">
    <TraceQLTraceDetail class="tqp-card" :ds="open.ds" :trace-id="open.traceId" :focus-span-id="open.spanId" @close="closeTrace" />
  </div>
</template>

<style scoped>
/* The layer TraceQL view's URL overlay, over any page. */
.tqp-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  /* With the native and Zipkin popouts, above the AI drawer (420). */
  z-index: 999;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: 40px 16px;
  overflow: auto;
}
.tqp-card {
  width: min(1100px, 100%);
  min-height: min(640px, calc(100vh - 80px));
  display: flex;
  flex-direction: column;
}
.tqp-card :deep(> *) { flex: 1 1 auto; min-height: 0; }
</style>
