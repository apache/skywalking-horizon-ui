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
<!-- Native traces, inline. REUSES the real LayerTracesView in its embedded
     (read-only) mode, seeded to focus the service and auto-run — the operator
     gets the actual trace LIST + span WATERFALL and its list→detail interaction.
     Trace support is per-layer: the layer template's `traces.source` decides
     native vs Zipkin. We embed the NATIVE view (which keys on the SkyWalking
     service). A pure-Zipkin layer keys traces on Zipkin's OWN service names, so
     it can't be focused on a SkyWalking service inline — we link out instead. A
     layer without the traces component gets an honest note. -->
<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import LayerTracesView from '@/layer/traces/LayerTracesView.vue';
import { useLayers } from '@/shell/useLayers';
import type { TracesSpec } from './types';

const props = defineProps<{ n: number; spec: TracesSpec }>();
const { t } = useI18n({ useScope: 'global' });
const router = useRouter();
const { layers } = useLayers();

const layerDef = computed(() =>
  layers.value.find((L) => L.key.toUpperCase() === props.spec.layer.toUpperCase()),
);
const hasTraces = computed(() => Boolean(layerDef.value?.caps?.traces));
// 'native' | 'zipkin' | 'both' — only pure-'zipkin' can't be embedded here.
const isZipkinOnly = computed(() => (layerDef.value?.traces?.source ?? 'native') === 'zipkin');

function openZipkinTab(): void {
  const href = router.resolve({ path: `/layer/${props.spec.layer.toLowerCase()}/zipkin-trace` }).href;
  window.open(href, '_blank', 'noopener');
}
</script>

<template>
  <div class="ctr">
    <div class="ctr__cap">{{ t('Figure {n}', { n }) }} · {{ spec.title }}</div>

    <div v-if="!hasTraces" class="ctr__note">{{ t('This layer has no traces component.') }}</div>
    <div v-else-if="isZipkinOnly" class="ctr__note ctr__note--act">
      <span>{{ t('This layer uses Zipkin tracing.') }}</span>
      <button type="button" class="ctr__btn" @click="openZipkinTab">{{ t('Open in a new tab') }}</button>
    </div>
    <div v-else class="ctr__view">
      <LayerTracesView
        :embedded="true"
        :layer-key="spec.layer.toLowerCase()"
        :focus-service="spec.service"
        :focus-window-minutes="spec.windowMinutes"
      />
    </div>
  </div>
</template>

<style scoped>
.ctr {
  border: 1px solid var(--sw-line-2);
  border-radius: 8px;
  background: var(--sw-bg-1);
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.ctr__cap {
  font-size: var(--sw-fs-sm);
  color: var(--sw-fg-1);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ctr__note {
  font-size: var(--sw-fs-sm);
  color: var(--sw-fg-2);
  font-family: var(--sw-mono);
}
.ctr__note--act {
  display: flex;
  align-items: center;
  gap: 10px;
  justify-content: space-between;
}
.ctr__btn {
  flex: 0 0 auto;
  height: 28px;
  padding: 0 10px;
  border: 1px solid var(--sw-line-2);
  border-radius: 6px;
  background: var(--sw-bg-2);
  color: var(--sw-fg-1);
  font: inherit;
  font-size: var(--sw-fs-sm);
  cursor: pointer;
}
.ctr__btn:hover {
  border-color: var(--sw-accent);
  color: var(--sw-fg-0);
}
/* Bounded stage — the embedded view fills it (list, and list→waterfall split). */
.ctr__view {
  height: 520px;
  position: relative;
  border: 1px solid var(--sw-line-2);
  border-radius: 6px;
  overflow: hidden;
  background: var(--sw-bg-0);
}
</style>
