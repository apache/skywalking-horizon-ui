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
<!-- Per-endpoint API-dependency chain, inline. REUSES the real API-dependency
     view — the same LayerEndpointDependencyView the dependency tab renders — in
     its embedded (read-only) mode, seeded with the resolved serviceId + the chat
     window. The embedded view auto-picks the service's top endpoint and draws its
     upstream/downstream chain; node expand + node/edge detail stay intact. No
     bespoke graph: one renderer across the product. -->
<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import LayerEndpointDependencyView from '@/layer/endpoint-dependency/LayerEndpointDependencyView.vue';
import type { EndpointDependencySpec } from './types';

defineProps<{ n: number; spec: EndpointDependencySpec }>();
const { t } = useI18n({ useScope: 'global' });
</script>

<template>
  <div class="ced">
    <div class="ced__cap">{{ t('Figure {n}', { n }) }} · {{ spec.title }}</div>
    <div class="ced__view">
      <LayerEndpointDependencyView
        :embedded="true"
        :layer-key="spec.layer.toLowerCase()"
        :focus-service="spec.service"
        :focus-service-id="spec.serviceId"
        :focus-window-minutes="spec.windowMinutes"
      />
    </div>
  </div>
</template>

<style scoped>
.ced {
  border: 1px solid var(--sw-line-2);
  border-radius: 8px;
  background: var(--sw-bg-1);
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.ced__cap {
  font-size: var(--sw-fs-sm);
  color: var(--sw-fg-1);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* The embedded view is content-sized (its graph card carries a bounded pixel
   height); the block clips any overflow and keeps its own rounded edge. */
.ced__view {
  border: 1px solid var(--sw-line-2);
  border-radius: 6px;
  overflow: hidden;
  background: var(--sw-bg-0);
}
</style>
