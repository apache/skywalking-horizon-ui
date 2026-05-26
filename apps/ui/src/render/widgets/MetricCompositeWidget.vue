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
  Composable multi-metric tile. Renders an operator-supplied KPI list
  as two visual sections:
    - Number-style KPIs → count grid (auto-fit tiles, big number on top,
      small label underneath).
    - Progress-bar style KPIs → bar grid (label + value on the same row,
      a horizontal fill below).

  Replaces the bespoke k8s-summary / pilot-summary widgets — those
  shipped as hardcoded KPI sets; this widget defers to the bundled
  JSON's `kpis` array so operators can edit them inline through the
  Overview templates admin. The bundled JSONs that used to ship
  k8s-summary / pilot-summary now ship metric-composite + explicit
  KPI lists.

  Routing: clicking the tile navigates to the layer's Service tab —
  same affordance the prior summary widgets had.
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
  layer?: string;
  kpiValues: Record<string, number | null>;
  /** Required — the widget renders exactly what the operator
   *  configures. Omitting this on a bundled JSON leaves the tile
   *  empty (no fallback defaults). */
  kpis?: OverviewKpi[];
}>();

const rows = computed<readonly OverviewKpi[]>(() => props.kpis ?? []);

/* Split treatment: explicit progress-bar style OR percent unit goes
 * to the bar section; everything else renders as a count tile. */
function isBar(k: OverviewKpi): boolean {
  return k.style === 'progress-bar' || k.unit === '%';
}
const counts = computed(() => rows.value.filter((k) => !isBar(k)));
const bars = computed(() => rows.value.filter(isBar));

const tileTo = computed(() =>
  props.layer ? `/layer/${props.layer.toLowerCase()}/service` : '',
);

/* Bar fill: when `max` is set the bar plots `value / max`; otherwise
 * the value is assumed to already be a 0..100 percentage (matches
 * the convention for `unit: '%'` metrics). */
function pct(v: number | null | undefined, max?: number): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '0%';
  const ratio = max && max > 0 ? (v / max) * 100 : v;
  return `${Math.max(0, Math.min(100, ratio)).toFixed(1)}%`;
}
</script>

<template>
  <component :is="tileTo ? RouterLink : 'div'" :to="tileTo || undefined" class="tile-link">
    <section class="sw-card mc">
      <header>
        <h4>{{ title }}</h4>
        <WidgetTip :tip="tip" />
      </header>
      <div v-if="rows.length === 0" class="empty">
        No metrics configured yet — open <code>/admin/overview-templates</code> to add KPI rows.
      </div>
      <template v-else>
        <div v-if="counts.length > 0" class="counts">
          <div v-for="k in counts" :key="k.label" class="count">
            <span class="count-value">{{ formatValue(kpiValues[k.label], k.unit) }}</span>
            <span class="count-label">{{ k.label }}</span>
          </div>
        </div>
        <div v-if="bars.length > 0" class="bars">
          <div v-for="k in bars" :key="k.label" class="bar-row">
            <div class="bar-head">
              <span class="bar-label">{{ k.label }}</span>
              <span class="bar-value">{{ formatValue(kpiValues[k.label], k.unit ?? '%') }}</span>
            </div>
            <div class="bar">
              <span class="fill" :style="{ width: pct(kpiValues[k.label], k.max) }" />
            </div>
          </div>
        </div>
      </template>
    </section>
  </component>
</template>

<style scoped>
.tile-link { display: block; text-decoration: none; color: inherit; height: 100%; }
.tile-link:hover .sw-card { border-color: var(--sw-line-3); }
.mc { display: flex; flex-direction: column; padding: 12px 14px; gap: 12px; min-height: 0; height: 100%; }
header { display: flex; align-items: center; gap: 6px; }
h4 { margin: 0; font-size: 12px; font-weight: 600; color: var(--sw-fg-0); }
.empty {
  font-size: 11px; color: var(--sw-fg-3); font-style: italic;
  padding: 14px 8px; text-align: center;
}
.empty code {
  font-family: var(--sw-mono); font-size: 10.5px;
  color: var(--sw-fg-2); background: var(--sw-bg-2);
  padding: 1px 4px; border-radius: 3px;
}
/* Auto-fit count tiles: as many as fit at ~100px min width per
 * tile — same layout principle as the prior k8s-summary widget
 * but generalised, so 4 KPIs sit in a 4-up row and 8 KPIs wrap to
 * two rows of 4 (depending on widget width). */
.counts {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(100px, 1fr));
  gap: 8px;
}
.count {
  display: flex; flex-direction: column; gap: 2px;
  padding: 8px 10px;
  background: var(--sw-bg-1);
  border: 1px solid var(--sw-line);
  border-radius: 6px;
}
.count-value {
  font-size: 18px; font-weight: 600; color: var(--sw-fg-0);
  font-variant-numeric: tabular-nums;
}
.count-label {
  font-size: 10px; color: var(--sw-fg-3);
  text-transform: uppercase; letter-spacing: 0.05em;
}
.bars {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 12px;
}
.bar-head { display: flex; justify-content: space-between; margin-bottom: 4px; }
.bar-label { font-size: 11px; color: var(--sw-fg-2); }
.bar-value {
  font-size: 12px; font-weight: 600; color: var(--sw-fg-0);
  font-variant-numeric: tabular-nums;
}
.bar { height: 4px; background: var(--sw-bg-2); border-radius: 2px; overflow: hidden; }
.fill { display: block; height: 100%; background: var(--sw-accent); transition: width 0.3s; }
</style>
