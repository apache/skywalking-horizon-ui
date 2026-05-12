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
  One tile in the per-layer KPI strip at the top of the Overview. Adopts
  the design's `KPI` card style (label · big value · sparkline) but
  binds to a single layer's service count + throughput rather than a
  global rollup.

  Visually denser than LayerKpiTile so 6 fit in a single horizontal row.
  Clicking the tile drills into the layer's services page.
-->
<script setup lang="ts">
import { computed, toRef } from 'vue';
import { RouterLink } from 'vue-router';
import type { LayerDef } from '@skywalking-horizon-ui/api-client';
import { metricMeta } from '@/composables/metricCatalog';
import { useLayerLanding } from '@/composables/useLayerLanding';
import { useSetupStore } from '@/stores/setup';
import { fmtMetric } from '@/utils/formatters';
import Sparkline from '@/components/charts/Sparkline.vue';

const props = defineProps<{ layer: LayerDef }>();
const store = useSetupStore();
const cfg = computed(() =>
  store.ensure(props.layer.key, { slots: props.layer.slots, caps: props.layer.caps }),
);
const landingCfg = computed(() => cfg.value.landing);
const layerRef = toRef(props, 'layer');
const landing = useLayerLanding(layerRef, landingCfg);

const aggregates = computed(() => landing.data.value?.aggregates ?? null);
const serviceCount = computed(() => aggregates.value?.serviceCount ?? props.layer.serviceCount);
const throughputKey = computed(() => aggregates.value?.throughputMetric ?? cfg.value.landing.orderBy);
const throughputValue = computed(() => {
  const a = aggregates.value;
  if (!a) return null;
  if (a.throughputValue !== undefined && a.throughputValue !== null) return a.throughputValue;
  return a.metrics?.[throughputKey.value] ?? null;
});
const throughputMeta = computed(() => metricMeta(throughputKey.value));
const throughputSeries = computed(() => aggregates.value?.spark ?? null);
const detailHref = computed(() => `/layer/${props.layer.key}/services`);
const slotName = computed(() => cfg.value.slots.services ?? 'services');
</script>

<template>
  <RouterLink class="sw-card strip-card" :to="detailHref">
    <header class="head">
      <span class="dot" :style="{ background: layer.color }" />
      <span class="name">{{ cfg.displayName || layer.name }}</span>
    </header>

    <div class="value-row">
      <span class="count" :class="{ muted: serviceCount < 0 }">{{
        serviceCount >= 0 ? fmtMetric(serviceCount) : '—'
      }}</span>
      <span class="count-unit">{{ slotName.toLowerCase() }}</span>
    </div>

    <div class="traffic-block" :title="`${throughputMeta.longLabel}\n\n${throughputMeta.tip}`">
      <div class="traffic-meta">
        <span class="traffic-label">{{ throughputMeta.label }}</span>
        <span class="traffic-value" :class="{ muted: throughputValue == null }">
          {{ fmtMetric(throughputValue) }}<span v-if="throughputMeta.unit" class="unit">{{ throughputMeta.unit }}</span>
        </span>
      </div>
      <Sparkline
        v-if="throughputSeries && throughputSeries.length > 1"
        class="trend"
        :values="throughputSeries"
        :width="160"
        :height="32"
        :color="layer.color"
        :stroke="1.5"
      />
      <span v-else class="spark-empty">—</span>
    </div>
  </RouterLink>
</template>

<style scoped>
.strip-card {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 9px 11px;
  text-decoration: none;
  min-width: 0;
  transition: border-color 0.12s, background 0.12s;
}
.strip-card:hover {
  border-color: var(--sw-line-3);
  background: var(--sw-bg-1);
}
.head {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 10.5px;
  color: var(--sw-fg-2);
  min-width: 0;
}
.head .dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex: 0 0 6px;
}
.head .name {
  color: var(--sw-fg-1);
  font-weight: 600;
  letter-spacing: -0.01em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 1;
  min-width: 0;
}
.value-row {
  display: flex;
  align-items: baseline;
  gap: 4px;
  margin-top: 1px;
}
.count {
  font-size: 19px;
  font-weight: 600;
  color: var(--sw-fg-0);
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.02em;
}
.count.muted {
  color: var(--sw-fg-3);
}
.count-unit {
  font-size: 10.5px;
  color: var(--sw-fg-3);
}
.traffic-block {
  margin-top: 3px;
  border-top: 1px dashed var(--sw-line);
  padding-top: 5px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.traffic-meta {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 6px;
  font-size: 10.5px;
}
.traffic-label {
  color: var(--sw-fg-3);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  font-size: 9.5px;
}
.traffic-value {
  color: var(--sw-fg-0);
  font-variant-numeric: tabular-nums;
  font-weight: 500;
}
.traffic-value.muted {
  color: var(--sw-fg-3);
}
.traffic-value .unit {
  color: var(--sw-fg-3);
  font-size: 9.5px;
  margin-left: 1px;
}
.trend {
  width: 100%;
  height: 32px;
  display: block;
}
.spark-empty {
  color: var(--sw-fg-3);
  font-size: 10px;
  min-height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
}
</style>
