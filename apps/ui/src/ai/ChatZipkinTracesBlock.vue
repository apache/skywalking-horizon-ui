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
<!-- Zipkin traces, inline. REUSES the real Zipkin trace view — the same
     LayerZipkinTracesView the /zipkin-trace tab renders — in its embedded
     (read-only) mode, seeded with the ZIPKIN service name the assistant matched
     via list_zipkin_services (Zipkin keys on its OWN service universe) + the chat
     window. The trace list + span waterfall + its list→detail interaction are
     the real ones; no bespoke view. -->
<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import LayerZipkinTracesView from '@/layer/traces/LayerZipkinTracesView.vue';
import type { ZipkinTracesSpec } from './types';

defineProps<{ n: number; spec: ZipkinTracesSpec }>();
const { t } = useI18n({ useScope: 'global' });
</script>

<template>
  <div class="czt">
    <div class="czt__cap">{{ t('Figure {n}', { n }) }} · {{ spec.title }}</div>
    <div class="czt__view">
      <LayerZipkinTracesView
        :embedded="true"
        :layer-key="spec.layer.toLowerCase()"
        :focus-service="spec.service"
        :focus-window-minutes="spec.windowMinutes"
      />
    </div>
  </div>
</template>

<style scoped>
.czt {
  border: 1px solid var(--sw-line-2);
  border-radius: 8px;
  background: var(--sw-bg-1);
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.czt__cap {
  font-size: var(--sw-fs-sm);
  color: var(--sw-fg-1);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* The embedded view fills its host (.ztr-tab is height:100% embedded), so give it
   a bounded fixed stage; the list + waterfall scroll inside. */
.czt__view {
  height: 520px;
  position: relative;
  border: 1px solid var(--sw-line-2);
  border-radius: 6px;
  overflow: hidden;
  background: var(--sw-bg-0);
}
</style>
