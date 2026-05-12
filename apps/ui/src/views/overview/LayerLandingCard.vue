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
<script setup lang="ts">
import { computed, toRef } from 'vue';
import { RouterLink } from 'vue-router';
import type { LayerDef } from '@skywalking-horizon-ui/api-client';
import Icon from '@/components/icons/Icon.vue';
import Sparkline from '@/components/charts/Sparkline.vue';
import { metricMeta } from '@/composables/metricCatalog';
import { useLayerLanding } from '@/composables/useLayerLanding';
import { useSetupStore } from '@/stores/setup';
import { fmtMetric } from '@/utils/formatters';

const props = defineProps<{ layer: LayerDef }>();
const store = useSetupStore();
const cfg = computed(() => store.ensure(props.layer.key, { slots: props.layer.slots, caps: props.layer.caps }));
const slotName = computed(() => cfg.value.slots.services ?? 'Services');
const detailHref = computed(() => `/layer/${props.layer.key}/services`);

// Live top-N rollup — see useLayerLanding for the polling cadence.
const landingCfg = computed(() => cfg.value.landing);
const layerRef = toRef(props, 'layer');
const landing = useLayerLanding(layerRef, landingCfg);
const hasRows = computed(() => landing.rows.value.length > 0);
const placeholderCount = computed(() =>
  Math.max(0, cfg.value.landing.topN - landing.rows.value.length),
);
const serviceHref = (serviceId: string): string =>
  `/layer/${props.layer.key}/services/${encodeURIComponent(serviceId)}`;
</script>

<template>
  <section class="sw-card layer-landing">
    <header class="head">
      <span class="dot" :style="{ background: layer.color }" />
      <div class="title-block">
        <h2>
          <RouterLink :to="detailHref">{{ cfg.displayName || layer.name }}</RouterLink>
        </h2>
        <div class="sub">
          {{ layer.serviceCount }} {{ slotName.toLowerCase() }}
          <span v-if="cfg.landing.priority !== undefined" class="sep">·</span>
          <span class="kicker">priority {{ cfg.landing.priority }}</span>
          <span class="sep">·</span>
          <span class="kicker">top {{ cfg.landing.topN }} by {{ cfg.landing.orderBy }}</span>
        </div>
      </div>
      <RouterLink class="sw-btn" :to="detailHref">
        <span>View all</span>
        <Icon name="chev" :size="10" />
      </RouterLink>
    </header>

    <div class="body">
      <table class="sw-table">
        <thead>
          <tr>
            <th class="svc-col">{{ slotName }}</th>
            <th
              v-for="c in cfg.landing.columns"
              :key="c.metric"
              class="num"
              :title="`${metricMeta(c.metric).longLabel}\n\n${metricMeta(c.metric).tip}`"
            >
              {{ c.label }}<span v-if="c.unit" class="unit">{{ c.unit }}</span>
            </th>
            <th
              v-if="cfg.landing.spark"
              class="spark-col"
              :title="`Trend of ${metricMeta(cfg.landing.spark.metric).longLabel} over the time window`"
            >
              {{ metricMeta(cfg.landing.spark.metric).label }} trend
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in landing.rows.value" :key="row.serviceId" class="data-row">
            <td class="svc-col" :title="row.serviceName">
              <RouterLink :to="serviceHref(row.serviceId)">{{ row.shortName || row.serviceName }}</RouterLink>
            </td>
            <td
              v-for="c in cfg.landing.columns"
              :key="c.metric"
              class="num"
              :class="{ muted: row.metrics[c.metric] == null }"
            >
              {{ fmtMetric(row.metrics[c.metric]) }}
            </td>
            <td v-if="cfg.landing.spark" class="spark-col">
              <Sparkline
                v-if="row.spark && row.spark.length > 1"
                :values="row.spark"
                :width="60"
                :height="cfg.landing.spark.height ?? 14"
                :color="layer.color"
              />
              <span v-else class="empty-cell">—</span>
            </td>
          </tr>
          <tr
            v-for="i in placeholderCount"
            :key="`ph-${i}`"
            class="placeholder-row"
          >
            <td class="svc-col">
              <span v-if="landing.isLoading.value && !hasRows" class="shim w-name" />
              <span v-else class="empty-cell">—</span>
            </td>
            <td v-for="c in cfg.landing.columns" :key="c.metric" class="num">
              <span v-if="landing.isLoading.value && !hasRows" class="shim w-num" />
              <span v-else class="empty-cell">—</span>
            </td>
            <td v-if="cfg.landing.spark" class="spark-col">
              <span v-if="landing.isLoading.value && !hasRows" class="shim w-spark" />
              <span v-else class="empty-cell">—</span>
            </td>
          </tr>
        </tbody>
      </table>
      <div class="card-foot">
        <span v-if="landing.error.value" class="err-note" :title="landing.error.value">
          OAP unreachable — showing last known data.
        </span>
        <span v-else-if="!hasRows && !landing.isLoading.value" class="placeholder-note">
          No services reporting on this layer yet —
          <RouterLink to="/setup">customize this card</RouterLink>.
        </span>
        <span v-else class="placeholder-note">
          <RouterLink to="/setup">Customize this card</RouterLink> ·
          <RouterLink :to="detailHref">all services →</RouterLink>
        </span>
      </div>
    </div>
  </section>
</template>

<style scoped>
.layer-landing {
  /* margin-bottom dropped — parent grid owns the spacing now. */
  min-width: 0; /* allow the grid track to shrink */
}
.head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--sw-line);
}
.head .dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex: 0 0 8px;
}
.title-block {
  flex: 1;
  min-width: 0;
}
h2 {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--sw-fg-0);
  letter-spacing: -0.01em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
h2 a {
  color: inherit;
  text-decoration: none;
}
h2 a:hover {
  color: var(--sw-accent-2);
}
.sub {
  font-size: 10.5px;
  color: var(--sw-fg-2);
  display: flex;
  gap: 5px;
  align-items: center;
  flex-wrap: wrap;
  margin-top: 2px;
}
.sub .kicker {
  color: var(--sw-fg-3);
}
.sub .sep {
  color: var(--sw-fg-3);
  opacity: 0.5;
}
.head .sw-btn {
  height: 26px;
  font-size: 11px;
  text-decoration: none;
}
.body {
  padding: 4px 0 8px;
}
.svc-col {
  width: 36%;
  min-width: 110px;
  max-width: 160px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.spark-col {
  width: 60px;
}
th .unit {
  margin-left: 3px;
  color: var(--sw-fg-3);
  font-weight: 400;
}
td.num {
  font-variant-numeric: tabular-nums;
  text-align: right;
}
.data-row .svc-col a {
  color: var(--sw-fg-0);
  text-decoration: none;
  display: inline-block;
  max-width: 100%;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  vertical-align: middle;
}
.data-row .svc-col a:hover {
  color: var(--sw-accent-2);
}
.num.muted {
  color: var(--sw-fg-3);
}
.empty-cell {
  color: var(--sw-fg-3);
}
.placeholder-row .shim {
  display: inline-block;
  height: 9px;
  background: var(--sw-bg-3);
  border-radius: 3px;
}
.placeholder-row .w-name {
  width: 60%;
}
.placeholder-row .w-num {
  width: 36px;
}
.placeholder-row .w-spark {
  width: 64px;
  height: 14px;
}
.card-foot {
  padding: 8px 14px 4px;
  border-top: 1px dashed var(--sw-line);
  font-size: 10.5px;
  color: var(--sw-fg-3);
}
.placeholder-note a {
  color: var(--sw-accent-2);
  text-decoration: none;
}
.err-note {
  color: var(--sw-warn);
}
</style>
