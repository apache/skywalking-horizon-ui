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
  Compact per-layer KPI tile used for the lower 4 layers on the Overview
  grid. Shows the layer's aggregated throughput value + sparkline + a
  short row of inline aggregated metrics. No top-N service table — for
  that the operator clicks through to the layer detail page (which is
  also the title link).

  Aggregations come from /api/layer/:key/landing.aggregates, which the
  BFF computes using the per-column setup config.
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
const throughputKey = computed(() => aggregates.value?.throughputMetric ?? cfg.value.landing.orderBy);
const throughputValue = computed(() => {
  const a = aggregates.value;
  if (!a) return null;
  if (a.throughputValue !== undefined && a.throughputValue !== null) return a.throughputValue;
  return a.metrics?.[throughputKey.value] ?? null;
});
const throughputMeta = computed(() => metricMeta(throughputKey.value));
const throughputSeries = computed(() => aggregates.value?.spark ?? null);

// Inline mini-row: up to 3 secondary metrics, skipping the throughput
// one so we don't double-count it on a narrow tile.
const secondaryMetrics = computed(() =>
  cfg.value.landing.columns
    .filter((c) => c.metric !== throughputKey.value)
    .slice(0, 3),
);
const serviceCount = computed(() => aggregates.value?.serviceCount ?? props.layer.serviceCount);
const detailHref = computed(() => `/layer/${props.layer.key}/services`);
const isLoading = computed(() => landing.isLoading.value && !aggregates.value);
const hasError = computed(() => !!landing.error.value);
</script>

<template>
  <section class="sw-card kpi-tile" :class="{ loading: isLoading }">
    <header class="head">
      <span class="dot" :style="{ background: layer.color }" />
      <RouterLink class="title" :to="detailHref">{{ cfg.displayName || layer.name }}</RouterLink>
      <span class="svc-count">{{ serviceCount >= 0 ? `${serviceCount} svc` : '—' }}</span>
    </header>

    <div class="primary">
      <div class="primary-stack">
        <div class="primary-label" :title="throughputMeta.tip">
          {{ aggregates?.throughputMetric ? 'Throughput' : throughputMeta.label }}
        </div>
        <div class="primary-value">
          <span class="num" :class="{ muted: throughputValue == null }">
            {{ fmtMetric(throughputValue) }}
          </span>
          <span v-if="throughputMeta.unit" class="unit">{{ throughputMeta.unit }}</span>
        </div>
        <div class="primary-sub">
          {{ throughputMeta.longLabel }} ·
          <span class="kicker">avg of top {{ landing.rows.value.length || cfg.landing.topN }}</span>
        </div>
      </div>
      <div class="primary-spark">
        <Sparkline
          v-if="throughputSeries && throughputSeries.length > 1"
          :values="throughputSeries"
          :width="84"
          :height="26"
          :color="layer.color"
        />
        <span v-else class="empty-spark">—</span>
      </div>
    </div>

    <div class="secondary">
      <div
        v-for="m in secondaryMetrics"
        :key="m.metric"
        class="metric-pill"
        :title="`${metricMeta(m.metric).longLabel}\n\n${metricMeta(m.metric).tip}`"
      >
        <span class="metric-label">{{ m.label }}</span>
        <span class="metric-value" :class="{ muted: aggregates?.metrics?.[m.metric] == null }">
          {{ fmtMetric(aggregates?.metrics?.[m.metric]) }}<span v-if="m.unit" class="unit">{{ m.unit }}</span>
        </span>
      </div>
      <span v-if="hasError" class="err-chip" :title="landing.error.value">err</span>
    </div>
  </section>
</template>

<style scoped>
.kpi-tile {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  min-width: 0;
}
.kpi-tile.loading {
  opacity: 0.75;
}
.head {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11.5px;
}
.head .dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex: 0 0 7px;
}
.head .title {
  color: var(--sw-fg-0);
  font-weight: 600;
  text-decoration: none;
  letter-spacing: -0.01em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 1;
  min-width: 0;
}
.head .title:hover {
  color: var(--sw-accent-2);
}
.svc-count {
  font-size: 10px;
  color: var(--sw-fg-3);
  font-variant-numeric: tabular-nums;
}
.primary {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  border-top: 1px solid var(--sw-line);
  padding-top: 8px;
  min-height: 50px;
}
.primary-stack {
  flex: 1;
  min-width: 0;
}
.primary-label {
  font-size: 9.5px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--sw-fg-3);
}
.primary-value {
  display: flex;
  align-items: baseline;
  gap: 3px;
  margin-top: 2px;
}
.primary-value .num {
  font-size: 18px;
  font-weight: 600;
  color: var(--sw-fg-0);
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.02em;
}
.primary-value .num.muted {
  color: var(--sw-fg-3);
}
.primary-value .unit {
  color: var(--sw-fg-3);
  font-size: 10.5px;
}
.primary-sub {
  font-size: 10px;
  color: var(--sw-fg-3);
  margin-top: 1px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.primary-sub .kicker {
  color: var(--sw-fg-3);
}
.primary-spark {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
}
.empty-spark {
  color: var(--sw-fg-3);
  font-size: 10px;
  width: 84px;
  text-align: center;
}
.secondary {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  border-top: 1px dashed var(--sw-line);
  padding-top: 6px;
}
.metric-pill {
  display: inline-flex;
  align-items: baseline;
  gap: 4px;
  font-size: 10.5px;
  padding: 2px 6px;
  background: var(--sw-bg-2);
  border-radius: 4px;
}
.metric-label {
  color: var(--sw-fg-3);
}
.metric-value {
  color: var(--sw-fg-0);
  font-variant-numeric: tabular-nums;
  font-weight: 500;
}
.metric-value.muted {
  color: var(--sw-fg-3);
}
.metric-value .unit {
  color: var(--sw-fg-3);
  font-size: 9.5px;
  margin-left: 1px;
}
.err-chip {
  margin-left: auto;
  font-size: 10px;
  color: var(--sw-warn);
}
</style>
