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
<!-- Focused topology, inline. REUSES the real topology view — the very same
     LayerServiceMapView the Topology tab and the overview widget render — in its
     embedded (read-only) mode, seeded to focus the one service at depth 1 for a
     one-hop map. No bespoke graph: one renderer across the product, so the hex
     nodes, edges, health colours and metrics are identical to the page. -->
<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import LayerServiceMapView from '@/layer/service-map/LayerServiceMapView.vue';
import type { TopologySpec } from './types';

defineProps<{ n: number; spec: TopologySpec }>();
const { t } = useI18n({ useScope: 'global' });
</script>

<template>
  <div class="ctp">
    <div class="ctp__cap">{{ t('Figure {n}', { n }) }} · {{ spec.title }}</div>
    <div class="ctp__view">
      <LayerServiceMapView
        :embedded="true"
        :layer-key="spec.layer.toLowerCase()"
        :focus-services="[spec.service]"
        :focus-depth="1"
        :fit-scale="1.2"
        :zoom-controls="true"
        :focus-window-minutes="spec.windowMinutes"
      />
    </div>
  </div>
</template>

<style scoped>
.ctp {
  border: 1px solid var(--sw-line-2);
  border-radius: 8px;
  background: var(--sw-bg-1);
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.ctp__cap {
  font-size: var(--sw-fs-sm);
  color: var(--sw-fg-1);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* The embedded map fills its host (height:100%), so give it a bounded stage.
   Taller than a dashboard cell so a focused one-hop graph reads at a usable
   size; the higher fit-scale cap + zoom controls handle the rest. */
.ctp__view {
  height: 480px;
  position: relative;
  border: 1px solid var(--sw-line-2);
  border-radius: 6px;
  overflow: hidden;
  background: var(--sw-bg-0);
}
</style>
