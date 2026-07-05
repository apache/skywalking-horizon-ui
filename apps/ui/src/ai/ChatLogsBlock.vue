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
<!-- Layer logs, inline. REUSES the real LayerLogsView in its embedded (read-only)
     mode, seeded to focus the service and auto-run — the operator gets the real
     log stream and its row→detail interaction, with the filter chrome hidden. -->
<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import LayerLogsView from '@/layer/logs/LayerLogsView.vue';
import type { LogsSpec } from './types';

defineProps<{ n: number; spec: LogsSpec }>();
const { t } = useI18n({ useScope: 'global' });
</script>

<template>
  <div class="clg">
    <div class="clg__cap">{{ t('Figure {n}', { n }) }} · {{ spec.title }}</div>
    <div class="clg__view">
      <LayerLogsView
        :embedded="true"
        :layer-key="spec.layer.toLowerCase()"
        :focus-service="spec.service"
        :focus-window-minutes="spec.windowMinutes"
      />
    </div>
  </div>
</template>

<style scoped>
.clg {
  border: 1px solid var(--sw-line-2);
  border-radius: 8px;
  background: var(--sw-bg-1);
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.clg__cap {
  font-size: var(--sw-fs-sm);
  color: var(--sw-fg-1);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.clg__view {
  height: 500px;
  position: relative;
  border: 1px solid var(--sw-line-2);
  border-radius: 6px;
  overflow: hidden;
  background: var(--sw-bg-0);
}
</style>
