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
  Tabbed container widget. Occupies one grid slot; each tab (a `name` + its
  own `widgets`) is a little dashboard. The active tab's widgets render in a
  12-col sub-grid; switching a tab swaps the whole set. Only the active tab's
  widgets are queried — the host flattens them into the metrics request, so
  inactive tabs cost nothing until opened. The active index is owned by the
  host (it drives that flatten); this component is presentational and emits
  `switch` on a tab click. The boundary is drawn with a top rule + corner
  brackets rather than a full box, so the inner widgets stay grid-aligned.
-->
<script setup lang="ts">
import { computed } from 'vue';
import type { DashboardWidget, DashboardTab, DashboardWidgetResult } from '@skywalking-horizon-ui/api-client';
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
  /** Results of every queried widget, keyed by id — the active tab's
   *  widgets resolve their own result from here. */
  results: Map<string, DashboardWidgetResult>;
  isFetching: boolean;
}>();
const emit = defineEmits<{ (e: 'switch', index: number): void }>();

const timeRange = useTimeRangeStore();

const tabs = computed<DashboardTab[]>(() => props.widget.tabs ?? []);
const activeTab = computed<DashboardTab | null>(() => tabs.value[props.activeIndex] ?? tabs.value[0] ?? null);
const activeWidgets = computed<DashboardWidget[]>(() => activeTab.value?.widgets ?? []);

function resultOf(w: DashboardWidget): DashboardWidgetResult | undefined {
  return props.results.get(w.id);
}
function cellStyle(w: DashboardWidget): Record<string, string> {
  const span = w.span ?? 4;
  const rowSpan = w.rowSpan ?? 2;
  return { gridColumn: `span ${Math.max(1, Math.min(12, span))}`, gridRow: `span ${Math.max(1, rowSpan)}` };
}
function chartHeight(w: DashboardWidget): number {
  return Math.max(60, (w.rowSpan ?? 2) * 110 - 46);
}

// Mirror LayerDashboardsView.widgetColor band matching.
function accentFor(w: DashboardWidget): string {
  const candidates = [w.id, w.title, w.expressions?.[0]].filter((c): c is string => !!c);
  for (const c of candidates) {
    const c2 = c.toLowerCase();
    if (/(^|[^a-z])cpm([^a-z]|$)/.test(c2) || c2.includes('traffic') || c2.includes('rpm')) return 'var(--sw-accent)';
    if (c2.includes('apdex')) return 'var(--sw-purple)';
    if (c2.includes('sla') || c2.includes('success')) return 'var(--sw-purple)';
    if (/p\d{2,3}/.test(c2) || c2.includes('percentile') || c2.includes('resp_time') || c2.includes('response time') || c2.includes('latency')) return 'var(--sw-warn)';
    if (c2.includes('err') || c2.includes('error') || c2.includes('failure')) return 'var(--sw-err)';
  }
  return colorForMetric(w.id || w.title || w.expressions?.[0] || '');
}
function xLabelsForLen(len: number): string[] {
  if (len <= 0) return [];
  const { startMs, endMs } = timeRange.range;
  const step = timeRange.step;
  if (len === 1) return [bucketTimeLabel(step, endMs)];
  return Array.from({ length: len }, (_, i) => bucketTimeLabel(step, startMs + ((endMs - startMs) * i) / (len - 1)));
}
function cardText(w: DashboardWidget): string {
  const v = resultOf(w)?.value ?? null;
  if (v != null && w.format === 'enum' && w.valueMap) {
    const label = w.valueMap[String(Math.round(v))];
    if (label != null) return label;
  }
  return fmtMetricAs(v, w.format as MetricFormat | undefined);
}
function loadingOrEmpty(w: DashboardWidget): string {
  return props.isFetching && !props.results.has(w.id) ? 'loading…' : 'no data';
}
</script>

<template>
  <div class="tab-widget">
    <div class="tw-strip" role="tablist">
      <button
        v-for="(tab, i) in tabs"
        :key="i"
        type="button"
        class="tw-tab"
        :class="{ on: i === activeIndex }"
        role="tab"
        :aria-selected="i === activeIndex"
        @click="emit('switch', i)"
      >{{ tab.name || `Tab ${i + 1}` }}</button>
    </div>
    <div class="tw-panel">
      <div v-if="activeWidgets.length" class="tw-grid">
        <div v-for="w in activeWidgets" :key="w.id" class="tw-cell" :style="cellStyle(w)">
          <div class="tw-cell-head">
            <span class="tw-cell-title">{{ w.title }}</span>
            <span v-if="w.unit && w.type !== 'card'" class="tw-cell-unit">{{ w.unit }}</span>
          </div>
          <div class="tw-cell-body" :class="`type-${w.type}`">
            <template v-if="resultOf(w)?.error">
              <span class="muted">{{ resultOf(w)!.error }}</span>
            </template>
            <template v-else-if="w.type === 'card'">
              <div class="card-value">
                <span class="num" :class="{ muted: resultOf(w)?.value == null }">
                  {{ results.has(w.id) ? cardText(w) : (isFetching ? '…' : fmtMetricAs(null, w.format)) }}
                </span>
                <span v-if="w.unit" class="unit">{{ w.unit }}</span>
              </div>
            </template>
            <template v-else-if="w.type === 'line'">
              <TimeChart
                v-if="resultOf(w)?.series?.length"
                :series="resultOf(w)!.series!"
                :unit="w.unit"
                :height="chartHeight(w)"
                :accent="accentFor(w)"
                :format="w.format"
                :x-labels="xLabelsForLen(resultOf(w)!.series![0]?.data.length ?? 0)"
              />
              <span v-else class="muted">{{ loadingOrEmpty(w) }}</span>
            </template>
            <template v-else-if="w.type === 'top'">
              <TopList
                v-if="resultOf(w)?.topGroups?.length"
                :groups="resultOf(w)!.topGroups!"
                :unit="w.unit"
                :color="accentFor(w)"
                :title="w.title"
              />
              <TopList
                v-else-if="resultOf(w)?.topList?.length"
                :items="resultOf(w)!.topList!"
                :unit="w.unit"
                :color="accentFor(w)"
                :title="w.title"
              />
              <span v-else class="muted">{{ loadingOrEmpty(w) }}</span>
            </template>
            <template v-else-if="w.type === 'record'">
              <RecordList
                v-if="resultOf(w)?.records?.length"
                :items="resultOf(w)!.records!"
                :unit="w.unit"
                :color="accentFor(w)"
              />
              <span v-else class="muted">{{ loadingOrEmpty(w) }}</span>
            </template>
            <template v-else-if="w.type === 'table'">
              <TableWidget
                v-if="resultOf(w)?.table?.length"
                :rows="resultOf(w)!.table!"
                :label-top-n="w.labelTopN"
                :headers="w.tableHeaders"
                :show-values="w.showTableValues !== false"
                :unit="w.unit"
                :format="w.format"
              />
              <span v-else class="muted">{{ loadingOrEmpty(w) }}</span>
            </template>
          </div>
        </div>
      </div>
      <div v-else class="tw-empty">This tab has no widgets.</div>
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
  padding: 0;
  /* The ONE frame: a line under the tab names. */
  border-bottom: 1px solid var(--sw-line);
  flex: 0 0 auto;
  overflow-x: auto;
}
.tw-tab {
  padding: 8px 15px;
  font-size: 13.5px;
  font-weight: 600;
  color: var(--sw-fg-2);
  background: transparent;
  border: none;
  border-bottom: 2px solid transparent;
  margin-bottom: -1px;
  cursor: pointer;
  font-family: inherit;
  white-space: nowrap;
}
.tw-tab:hover { color: var(--sw-fg-0); }
.tw-tab.on {
  color: var(--sw-fg-0);
  border-bottom-color: var(--sw-accent);
}
/* Content sits flush under the tab line — no side frame, so its widgets align. */
.tw-panel {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 8px 0 2px;
}
.tw-grid {
  display: grid;
  grid-template-columns: repeat(12, minmax(0, 1fr));
  grid-auto-rows: 110px;
  gap: 6px;
}
.tw-cell {
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--sw-bg-0);
  border: 1px solid var(--sw-line);
  border-radius: 5px;
  overflow: hidden;
}
.tw-cell-head {
  display: flex;
  align-items: baseline;
  gap: 6px;
  padding: 4px 8px;
  border-bottom: 1px solid var(--sw-line);
}
.tw-cell-title {
  font-size: 10.5px;
  font-weight: 600;
  color: var(--sw-fg-1);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.tw-cell-unit {
  font-size: 9.5px;
  color: var(--sw-fg-3);
  margin-left: auto;
}
.tw-cell-body {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  padding: 6px 8px;
  overflow: hidden;
}
.tw-cell-body.type-card {
  align-items: center;
  justify-content: center;
}
.tw-cell-body :deep(.top-list),
.tw-cell-body :deep(.top-list .rows) {
  flex: 1;
  min-height: 0;
}
.card-value {
  display: flex;
  align-items: baseline;
  gap: 4px;
}
.card-value .num {
  font-size: 22px;
  font-weight: 700;
  color: var(--sw-fg-0);
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.02em;
}
.card-value .num.muted { color: var(--sw-fg-3); }
.card-value .unit {
  font-size: 10px;
  color: var(--sw-fg-3);
}
.muted {
  color: var(--sw-fg-3);
  font-size: 11px;
}
.tw-empty {
  margin: auto;
  color: var(--sw-fg-3);
  font-size: 11px;
}
</style>
