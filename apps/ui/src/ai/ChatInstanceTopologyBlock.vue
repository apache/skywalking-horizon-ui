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
<!-- Per-pair instance map, inline. REUSES the real instance-topology view — the
     same LayerInstanceTopologyView the Topology tab opens from a call edge — in
     its embedded (read-only) mode, seeded with the resolved client + server
     service ids + the chat window. Two columns (source instances | dest
     instances) with the calls between them; pan/zoom + node/edge detail intact.
     No bespoke graph: one renderer across the product. -->
<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import LayerInstanceTopologyView from '@/layer/service-map/LayerInstanceTopologyView.vue';
import ChatCapturedTag from './ChatCapturedTag.vue';
import type { InstanceTopologySpec } from './types';

defineProps<{ n: number; spec: InstanceTopologySpec; capturedAt?: number }>();
const { t } = useI18n({ useScope: 'global' });
</script>

<template>
  <div class="cit">
    <div class="cit__cap">
      <span class="cit__cap-t">{{ t('Figure {n}', { n }) }} · {{ spec.title }}</span><ChatCapturedTag :at="capturedAt" />
    </div>
    <div class="cit__view">
      <LayerInstanceTopologyView
        :embedded="true"
        :layer-key="spec.layer.toLowerCase()"
        :focus-client-service-id="spec.clientServiceId"
        :focus-server-service-id="spec.serverServiceId"
        :focus-window-minutes="spec.windowMinutes"
        :replay="true"
        :replay-data="spec.replayData"
      />
    </div>
  </div>
</template>

<style scoped>
.cit {
  border: 1px solid var(--sw-line-2);
  border-radius: 8px;
  background: var(--sw-bg-1);
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.cit__cap {
  display: flex;
  align-items: baseline;
  min-width: 0;
  font-size: var(--sw-fs-sm);
  color: var(--sw-fg-1);
}
.cit__cap-t {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
/* The embedded view fills its host (.imv is height:100%), so give it a bounded
   fixed stage; fit-to-screen + the zoom controls handle a wider graph. */
.cit__view {
  height: 480px;
  position: relative;
  border: 1px solid var(--sw-line-2);
  border-radius: 6px;
  overflow: hidden;
  background: var(--sw-bg-0);
}
</style>
