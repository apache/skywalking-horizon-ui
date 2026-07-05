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
<!-- Cross-layer hierarchy, inline. REUSES the real ServiceHierarchyOverlay — the
     same Smartscape hex fan the topology page shows on node-select — in its
     standalone mode: no topology underneath, no dim/modal, the fan centred and
     auto-fit into its own viewBox. One renderer across the product. -->
<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import ServiceHierarchyOverlay from '@/layer/service-map/ServiceHierarchyOverlay.vue';
import type { HierarchySpec } from './types';

defineProps<{ n: number; spec: HierarchySpec }>();
const { t } = useI18n({ useScope: 'global' });

// resolveNodePos is unused in standalone mode (the fan centres on the origin),
// but the prop is required for the topology-overlay path.
function noNodePos(): null {
  return null;
}
</script>

<template>
  <div class="chb">
    <div class="chb__cap">{{ t('Figure {n}', { n }) }} · {{ spec.title }}</div>
    <div class="chb__view">
      <ServiceHierarchyOverlay
        :standalone="true"
        :focus="{ serviceId: spec.serviceId, layer: spec.layer, serviceName: spec.service }"
        :view-box-w="0"
        :view-box-h="0"
        :resolve-node-pos="noNodePos"
      />
    </div>
  </div>
</template>

<style scoped>
.chb {
  border: 1px solid var(--sw-line-2);
  border-radius: 8px;
  background: var(--sw-bg-1);
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.chb__cap {
  font-size: var(--sw-fs-sm);
  color: var(--sw-fg-1);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* Stage for the standalone Smartscape fan (position:relative so the overlay's
   absolute fill anchors here; the fan's viewBox scales to this box). */
.chb__view {
  height: 440px;
  position: relative;
  border: 1px solid var(--sw-line-2);
  border-radius: 6px;
  overflow: hidden;
  background: var(--sw-bg-0);
}
</style>
