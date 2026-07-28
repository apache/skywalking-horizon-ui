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
<!-- Captured network process-conversation graph (network profiling's result).
     ProcessTopologyGraph is a stateless renderer (nodes/calls in), so the block
     replays the captured graph directly — no query, frozen on reload. -->
<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import ProcessTopologyGraph from '@/layer/profiling/ProcessTopologyGraph.vue';
import ChatCapturedTag from './ChatCapturedTag.vue';
import type { ProcessTopologySpec } from './types';

const props = defineProps<{ n: number; spec: ProcessTopologySpec; capturedAt?: number }>();
const { t } = useI18n({ useScope: 'global' });

const hasData = computed<boolean>(() => props.spec.replayData.reachable && props.spec.replayData.nodes.length > 0);
</script>

<template>
  <div class="cpt">
    <div class="cpt__cap">
      {{ t('Figure {n}', { n }) }} · {{ spec.title }}<ChatCapturedTag :at="capturedAt" />
    </div>
    <div class="cpt__facts">
      <span v-if="spec.instanceName" class="cpt__fact">{{ spec.instanceName }}</span>
      <span v-if="hasData" class="cpt__fact">{{ t('{n} processes', { n: spec.replayData.nodes.length }) }}</span>
    </div>
    <div v-if="hasData" class="cpt__graph">
      <ProcessTopologyGraph :nodes="spec.replayData.nodes" :calls="spec.replayData.calls" />
    </div>
    <div v-else class="cpt__empty">{{ t('No process-conversation data was captured.') }}</div>
  </div>
</template>

<style scoped>
.cpt {
  border: 1px solid var(--sw-line, #2a2d36);
  border-radius: 8px;
  background: var(--sw-bg-1, #1b1d24);
  overflow: hidden;
  margin: 8px 0;
}
.cpt__cap {
  padding: 8px 12px;
  font-size: 12px;
  color: var(--sw-fg-2, #9aa0ac);
  border-bottom: 1px solid var(--sw-line, #2a2d36);
}
.cpt__facts {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 8px 12px 0;
  font-size: 11px;
  color: var(--sw-fg-2, #9aa0ac);
}
.cpt__fact {
  font-variant-numeric: tabular-nums;
}
.cpt__fact + .cpt__fact::before {
  content: '·';
  margin-right: 6px;
  color: var(--sw-fg-3, #6b6f7a);
}
.cpt__graph {
  height: 420px;
  margin-top: 8px;
}
.cpt__empty {
  padding: 24px 12px;
  text-align: center;
  font-size: 12px;
  color: var(--sw-fg-3, #6b6f7a);
}
</style>
