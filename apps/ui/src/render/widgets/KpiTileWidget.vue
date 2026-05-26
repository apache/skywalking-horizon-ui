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
import { computed } from 'vue';
import { RouterLink } from 'vue-router';
import type { OverviewKpi } from '@skywalking-horizon-ui/api-client';
import { formatValue } from './ValueFormat';
import WidgetTip from '@/components/primitives/WidgetTip.vue';

const props = defineProps<{
  title: string;
  tip?: string;
  /** Layer key — clicking the tile navigates to the layer's Service page. */
  layer?: string;
  showCount?: boolean;
  count: number | null | undefined;
  kpis: OverviewKpi[];
  /** Value per kpi.label. */
  kpiValues: Record<string, number | null>;
}>();

// BFF /api/menu lowercases layer keys, and that's the casing the sidebar
// and per-layer routes all use. The overview JSON authors uppercase
// (matching OAP's enum), so normalise here so the click-through URL
// matches the rest of the app.
const tileTo = computed(() =>
  props.layer ? `/layer/${props.layer.toLowerCase()}/service` : '',
);

/** Clamp value/max into a 0..100 percentage for the progress-bar
 *  width. `null` / non-finite / max=0 collapse to 0. */
function barPct(value: number | null | undefined, max: number): number {
  if (value === null || value === undefined || !Number.isFinite(value) || max <= 0) return 0;
  const pct = (value / max) * 100;
  if (pct < 0) return 0;
  if (pct > 100) return 100;
  return Math.round(pct);
}
</script>

<template>
  <RouterLink v-if="tileTo" :to="tileTo" class="tile-link">
    <section class="sw-card tile">
      <header>
        <h4>{{ title }}</h4>
        <WidgetTip :tip="tip" />
      </header>
      <div v-if="showCount" class="count">
        <span class="count-label">Services</span>
        <span class="count-value">{{ formatValue(count) }}</span>
      </div>
      <div class="kpis">
        <div v-for="k in kpis" :key="k.label" class="kpi">
          <template v-if="k.style === 'progress-bar' && k.max">
            <span class="kpi-label">{{ k.label }}</span>
            <span class="kpi-value">{{ formatValue(kpiValues[k.label], k.unit) }}</span>
            <div
              class="kpi-bar"
              :style="`--pct: ${barPct(kpiValues[k.label], k.max)}%`"
            />
          </template>
          <template v-else>
            <span class="kpi-label">{{ k.label }}</span>
            <span class="kpi-value">{{ formatValue(kpiValues[k.label], k.unit) }}</span>
          </template>
        </div>
      </div>
    </section>
  </RouterLink>
  <div v-else class="tile-link">
    <section class="sw-card tile">
      <header>
        <h4>{{ title }}</h4>
        <WidgetTip :tip="tip" />
      </header>
      <div v-if="showCount" class="count">
        <span class="count-label">Services</span>
        <span class="count-value">{{ formatValue(count) }}</span>
      </div>
      <div class="kpis">
        <div v-for="k in kpis" :key="k.label" class="kpi">
          <template v-if="k.style === 'progress-bar' && k.max">
            <span class="kpi-label">{{ k.label }}</span>
            <span class="kpi-value">{{ formatValue(kpiValues[k.label], k.unit) }}</span>
            <div
              class="kpi-bar"
              :style="`--pct: ${barPct(kpiValues[k.label], k.max)}%`"
            />
          </template>
          <template v-else>
            <span class="kpi-label">{{ k.label }}</span>
            <span class="kpi-value">{{ formatValue(kpiValues[k.label], k.unit) }}</span>
          </template>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.tile-link { display: block; text-decoration: none; color: inherit; height: 100%; }
.tile-link:hover .sw-card { border-color: var(--sw-line-3); }
.tile { display: flex; flex-direction: column; padding: 10px 12px; gap: 8px; min-height: 0; height: 100%; }
header { display: flex; align-items: center; gap: 6px; }
h4 { margin: 0; font-size: 11px; font-weight: 600; color: var(--sw-fg-1); }
.count {
  display: flex; align-items: baseline; gap: 8px;
  padding: 2px 0 6px;
  border-bottom: 1px dashed var(--sw-line);
}
.count-label { font-size: 10px; color: var(--sw-fg-3); text-transform: uppercase; letter-spacing: 0.08em; }
.count-value {
  font-size: 22px; font-weight: 600; color: var(--sw-fg-0);
  font-variant-numeric: tabular-nums; margin-left: auto;
}
.kpis { display: flex; flex-direction: column; gap: 6px; }
.kpi {
  display: grid;
  grid-template-columns: 1fr auto;
  grid-template-rows: auto auto;
  align-items: baseline;
  column-gap: 8px;
  row-gap: 2px;
}
.kpi-label { font-size: 11px; color: var(--sw-fg-2); }
.kpi-value {
  font-size: 13px; font-weight: 600; color: var(--sw-fg-0);
  font-variant-numeric: tabular-nums;
}
.kpi-bar {
  grid-column: 1 / -1;
  position: relative;
  height: 4px;
  background: var(--sw-bg-2);
  border-radius: 2px;
  overflow: hidden;
}
.kpi-bar::before {
  content: '';
  position: absolute;
  left: 0; top: 0; bottom: 0;
  width: var(--pct, 0%);
  background: var(--sw-accent);
  border-radius: 2px;
}
</style>
