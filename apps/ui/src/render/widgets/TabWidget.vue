<!--
  ~ Licensed to the Apache Software Foundation (ASF) under one or more
  ~ contributor license agreements.  See the NOTICE file distributed with
  ~ this work for additional information regarding copyright ownership.
  ~ The ASF licenses this file to You under the Apache License, Version 2.0
  ~ (the "License"); you may not use this file except in compliance with
  ~ the License.  You may obtain a copy of the License at
  ~
  ~     http://www.apache.org/licenses/LICENSE-2.0
  ~
  ~ Unless required by applicable law or agreed to in writing, software
  ~ distributed under the License is distributed on an "AS IS" BASIS,
  ~ WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
  ~ See the License for the specific language governing permissions and
  ~ limitations under the License.
-->
<!--
  Tabbed container widget. Occupies one grid slot; its `tabs` children are
  full widgets (card / line / top / record / table) shown one at a time. The
  active tab's child is the ONLY one queried — the host flattens it into the
  metrics request, so an inactive tab costs nothing until you open it. The
  active index is owned by the host (it drives that flatten); this component
  is presentational and emits `switch` on a tab click.
-->
<script setup lang="ts">
import { computed } from 'vue';
import type { DashboardWidget, DashboardWidgetResult } from '@skywalking-horizon-ui/api-client';
import TimeChart from '@/components/charts/TimeChart.vue';
import TopList from '@/components/charts/TopList.vue';
import RecordList from '@/render/widgets/RecordList.vue';
import TableWidget from '@/render/widgets/TableWidget.vue';
import { useTimeRangeStore } from '@/controls/timeRange';
import { bucketTimeLabel, fmtMetricAs, type MetricFormat } from '@/utils/formatters';
import { colorForMetric } from '@/utils/metricColor';

const props = defineProps<{
  widget: DashboardWidget;
  activeIndex: number;
  /** Result of the ACTIVE child only (keyed by the child's id upstream). */
  result: DashboardWidgetResult | undefined;
  isFetching: boolean;
}>();
const emit = defineEmits<{ (e: 'switch', index: number): void }>();

const timeRange = useTimeRangeStore();

const tabs = computed<DashboardWidget[]>(() => props.widget.tabs ?? []);
const active = computed<DashboardWidget | null>(() => tabs.value[props.activeIndex] ?? tabs.value[0] ?? null);

// Mirror LayerDashboardsView.widgetColor: pattern-match the metric band off
// id / title / first expression, falling back to the catalog hue helper.
function accentFor(w: DashboardWidget | null): string {
  const candidates = [w?.id, w?.title, w?.expressions?.[0]].filter((c): c is string => !!c);
  for (const c of candidates) {
    const c2 = c.toLowerCase();
    if (/(^|[^a-z])cpm([^a-z]|$)/.test(c2) || c2.includes('traffic') || c2.includes('rpm')) return 'var(--sw-accent)';
    if (c2.includes('apdex')) return 'var(--sw-purple)';
    if (c2.includes('sla') || c2.includes('success')) return 'var(--sw-purple)';
    if (/p\d{2,3}/.test(c2) || c2.includes('percentile') || c2.includes('resp_time') || c2.includes('response time') || c2.includes('latency')) return 'var(--sw-warn)';
    if (c2.includes('err') || c2.includes('error') || c2.includes('failure')) return 'var(--sw-err)';
  }
  return colorForMetric(w?.id || w?.title || w?.expressions?.[0] || '');
}
const accent = computed(() => accentFor(active.value));

// Bucket-time x labels for a line series of `len` points, across the page's
// current range/step (same derivation the main grid uses).
function xLabelsForLen(len: number): string[] {
  if (len <= 0) return [];
  const { startMs, endMs } = timeRange.range;
  const step = timeRange.step;
  if (len === 1) return [bucketTimeLabel(step, endMs)];
  return Array.from({ length: len }, (_, i) =>
    bucketTimeLabel(step, startMs + ((endMs - startMs) * i) / (len - 1)),
  );
}

function cardText(w: DashboardWidget): string {
  const v = props.result?.value ?? null;
  if (v != null && w.format === 'enum' && w.valueMap) {
    const label = w.valueMap[String(Math.round(v))];
    if (label != null) return label;
  }
  return fmtMetricAs(v, w.format as MetricFormat | undefined);
}

// Chart fills the container slot minus the tab strip. Container owns the
// grid footprint (rowSpan); children ignore their own span/rowSpan.
const chartHeight = computed(() => Math.max(60, (props.widget.rowSpan ?? 1) * 110 - 50 - 34));
</script>

<template>
  <div class="tab-widget">
    <div class="tw-strip" role="tablist">
      <button
        v-for="(tab, i) in tabs"
        :key="tab.id"
        type="button"
        class="tw-tab"
        :class="{ on: i === activeIndex }"
        role="tab"
        :aria-selected="i === activeIndex"
        @click="emit('switch', i)"
      >{{ tab.title || tab.id }}</button>
    </div>
    <div v-if="active" class="tw-body" :class="`type-${active.type}`">
      <template v-if="result?.error">
        <span class="muted">{{ result.error }}</span>
      </template>
      <template v-else-if="active.type === 'card'">
        <div class="card-value">
          <span class="num" :class="{ muted: result?.value == null }">
            {{ result ? cardText(active) : (isFetching ? '…' : fmtMetricAs(null, active.format)) }}
          </span>
          <span v-if="active.unit" class="unit">{{ active.unit }}</span>
        </div>
      </template>
      <template v-else-if="active.type === 'line'">
        <TimeChart
          v-if="result?.series?.length"
          :series="result.series"
          :unit="active.unit"
          :height="chartHeight"
          :accent="accent"
          :format="active.format"
          :x-labels="xLabelsForLen(result.series[0]?.data.length ?? 0)"
        />
        <span v-else class="muted">{{ isFetching && !result ? 'loading…' : 'no data' }}</span>
      </template>
      <template v-else-if="active.type === 'top'">
        <TopList
          v-if="result?.topGroups?.length"
          :groups="result.topGroups"
          :unit="active.unit"
          :color="accent"
          :title="active.title"
        />
        <TopList
          v-else-if="result?.topList?.length"
          :items="result.topList"
          :unit="active.unit"
          :color="accent"
          :title="active.title"
        />
        <span v-else class="muted">{{ isFetching && !result ? 'loading…' : 'no data' }}</span>
      </template>
      <template v-else-if="active.type === 'record'">
        <RecordList
          v-if="result?.records?.length"
          :items="result.records"
          :unit="active.unit"
          :color="accent"
        />
        <span v-else class="muted">{{ isFetching && !result ? 'loading…' : 'no data' }}</span>
      </template>
      <template v-else-if="active.type === 'table'">
        <TableWidget
          v-if="result?.table?.length"
          :rows="result.table"
          :label-top-n="active.labelTopN"
          :headers="active.tableHeaders"
          :show-values="active.showTableValues !== false"
          :unit="active.unit"
          :format="active.format"
        />
        <span v-else class="muted">{{ isFetching && !result ? 'loading…' : 'no data' }}</span>
      </template>
    </div>
  </div>
</template>

<style scoped>
.tab-widget {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.tw-strip {
  display: flex;
  gap: 2px;
  padding: 0 0 4px;
  border-bottom: 1px solid var(--sw-line);
  margin-bottom: 4px;
  flex: 0 0 auto;
  overflow-x: auto;
}
.tw-tab {
  padding: 3px 8px;
  font-size: 11px;
  font-weight: 500;
  color: var(--sw-fg-2);
  background: transparent;
  border: none;
  border-radius: 3px;
  cursor: pointer;
  font: inherit;
  white-space: nowrap;
}
.tw-tab:hover {
  background: var(--sw-bg-2);
  color: var(--sw-fg-1);
}
.tw-tab.on {
  background: var(--sw-bg-3);
  color: var(--sw-fg-0);
  font-weight: 600;
}
.tw-body {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
}
.tw-body.type-card {
  align-items: center;
  justify-content: center;
}
.tw-body :deep(.top-list) {
  flex: 1;
  min-height: 0;
}
.tw-body :deep(.top-list .rows) {
  min-height: 0;
}
.card-value {
  display: flex;
  align-items: baseline;
  gap: 4px;
}
.card-value .num {
  font-size: 26px;
  font-weight: 700;
  color: var(--sw-fg-0);
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.02em;
}
.card-value .num.muted {
  color: var(--sw-fg-3);
}
.card-value .unit {
  font-size: 11px;
  color: var(--sw-fg-3);
}
.muted {
  color: var(--sw-fg-3);
  font-size: 11px;
}
</style>
