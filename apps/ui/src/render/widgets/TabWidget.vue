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
  `switch` on a tab click. Children render through the SAME host helpers as
  top-level widgets (`host`: color, pop-out, the multi-entity compare fan-out),
  so a widget dragged into a tab behaves exactly as it did outside.
-->
<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { DashboardWidget, DashboardTab, DashboardWidgetResult } from '@skywalking-horizon-ui/api-client';
import TimeChart from '@/components/charts/TimeChart.vue';
import TopList from '@/components/charts/TopList.vue';
import RecordList from '@/render/widgets/RecordList.vue';
import TableWidget from '@/render/widgets/TableWidget.vue';
import WidgetTip from '@/components/primitives/WidgetTip.vue';
import { useTimeRangeStore } from '@/controls/timeRange';
import { bucketTimeLabel, fmtMetricAs, type MetricFormat } from '@/utils/formatters';
import type { TabHostCtx } from '@/render/widgets/tabHostCtx';

const props = defineProps<{
  widget: DashboardWidget;
  activeIndex: number;
  /** Results of every queried widget, keyed by id — the active tab's
   *  widgets resolve their own result from here. */
  results: Map<string, DashboardWidgetResult>;
  isFetching: boolean;
  /** True when the dashboard is comparing a locked cohort. */
  compareMode?: boolean;
  /** Host render helpers (color / pop-out / compare fan-out). */
  host: TabHostCtx;
}>();
const emit = defineEmits<{ (e: 'switch', index: number): void }>();

const { t } = useI18n({ useScope: 'global' });
const timeRange = useTimeRangeStore();

const tabs = computed<DashboardTab[]>(() => props.widget.tabs ?? []);
// Clamp a stale / out-of-range active index so the highlighted tab and the
// rendered panel always agree (a different scope template may reuse this
// widget id with fewer tabs than the persisted index assumes).
const effectiveIndex = computed<number>(() => {
  const n = tabs.value.length;
  return n === 0 ? 0 : Math.min(Math.max(props.activeIndex, 0), n - 1);
});
const activeTab = computed<DashboardTab | null>(() => tabs.value[effectiveIndex.value] ?? null);
const activeWidgets = computed<DashboardWidget[]>(() => activeTab.value?.widgets ?? []);
// Gate children by the host's canonical `visibleWhen` rule (compare-aware
// union), not a local primary-only check. Only the children — never the slot.
const visibleWidgets = computed<DashboardWidget[]>(() =>
  activeWidgets.value.filter((w) => !props.host.isHidden(w.id)),
);
/** Compare helpers when a cohort is locked, else null (single-entity view). */
const compare = computed(() => (props.compareMode ? props.host.compare : null));

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
function lineDataLen(w: DashboardWidget): number {
  return compare.value ? compare.value.lineLen(w.id) : (resultOf(w)?.series?.[0]?.data.length ?? 0);
}
/** Whether a top/record child has a list worth a pop-out (single or compare). */
function hasTopData(w: DashboardWidget): boolean {
  return props.host.hasTopData(w);
}
function loadingOrEmpty(w: DashboardWidget): string {
  const loading = compare.value ? compare.value.loading : props.isFetching && !props.results.has(w.id);
  return loading ? t('loading…') : t('no data');
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
        :class="{ on: i === effectiveIndex }"
        role="tab"
        :aria-selected="i === effectiveIndex"
        @click="emit('switch', i)"
      >{{ tab.name || `Tab ${i + 1}` }}</button>
    </div>
    <div class="tw-panel">
      <div v-if="visibleWidgets.length" class="tw-grid">
        <div v-for="w in visibleWidgets" :key="w.id" class="tw-cell" :style="cellStyle(w)">
          <div class="tw-cell-head">
            <span class="tw-cell-title">{{ w.title }}</span>
            <WidgetTip :tip="w.tip" />
            <span class="tw-cell-right">
              <span v-if="w.unit && w.type !== 'card'" class="tw-cell-unit">{{ w.unit }}</span>
              <!-- record only pops out in compare mode (its single-entity body is
                   a RecordList, which has no expandable list to pop). -->
              <button
                v-if="(w.type === 'top' || (w.type === 'record' && compare)) && hasTopData(w)"
                type="button"
                class="tw-popout"
                :title="t('Pop out — full list')"
                :aria-label="t('Pop out — full list')"
                @click="host.popOutTopList(w.id)"
              >⤢</button>
            </span>
          </div>
          <div class="tw-cell-body" :class="`type-${w.type}`">
            <template v-if="!compare && resultOf(w)?.error">
              <span class="muted">{{ resultOf(w)!.error }}</span>
            </template>
            <template v-else-if="w.type === 'card'">
              <div v-if="compare" class="tw-card-compare">
                <div v-for="e in compare.entities" :key="e" class="tw-cc-row">
                  <span class="tw-cc-dot" :style="{ background: compare.hue(e) }" />
                  <span class="tw-cc-name" :title="compare.label(e)">{{ compare.label(e) }}</span>
                  <span class="tw-cc-val" :class="{ muted: compare.cardValue(w.id, e) == null }">{{ compare.cardText(w, e) }}</span>
                </div>
              </div>
              <div v-else class="card-value">
                <span class="num" :class="{ muted: resultOf(w)?.value == null }">
                  {{ results.has(w.id) ? cardText(w) : (isFetching ? '…' : fmtMetricAs(null, w.format)) }}
                </span>
                <span v-if="w.unit" class="unit">{{ w.unit }}</span>
              </div>
            </template>
            <template v-else-if="w.type === 'line'">
              <TimeChart
                v-if="compare ? compare.lineSeries(w.id).length : resultOf(w)?.series?.length"
                :series="compare ? compare.lineSeries(w.id) : resultOf(w)!.series!"
                :unit="w.unit"
                :height="chartHeight(w)"
                :accent="host.widgetColor(w)"
                :format="w.format"
                :x-labels="xLabelsForLen(lineDataLen(w))"
              />
              <span v-else class="muted">{{ loadingOrEmpty(w) }}</span>
            </template>
            <template v-else-if="w.type === 'top'">
              <TopList
                v-if="compare && compare.hasTop(w.id)"
                :ref="(el) => host.setTopListRef(w.id, el)"
                :groups="compare.topGroups(w.id)"
                :unit="w.unit"
                :color="host.widgetColor(w)"
                :title="w.title"
              />
              <TopList
                v-else-if="!compare && resultOf(w)?.topGroups?.length"
                :ref="(el) => host.setTopListRef(w.id, el)"
                :groups="resultOf(w)!.topGroups!"
                :unit="w.unit"
                :color="host.widgetColor(w)"
                :title="w.title"
              />
              <TopList
                v-else-if="!compare && resultOf(w)?.topList?.length"
                :ref="(el) => host.setTopListRef(w.id, el)"
                :items="resultOf(w)!.topList!"
                :unit="w.unit"
                :color="host.widgetColor(w)"
                :title="w.title"
              />
              <span v-else class="muted">{{ loadingOrEmpty(w) }}</span>
            </template>
            <template v-else-if="w.type === 'record'">
              <TopList
                v-if="compare && compare.hasTop(w.id)"
                :ref="(el) => host.setTopListRef(w.id, el)"
                :groups="compare.topGroups(w.id)"
                :unit="w.unit"
                :color="host.widgetColor(w)"
                :title="w.title"
              />
              <RecordList
                v-else-if="!compare && resultOf(w)?.records?.length"
                :items="resultOf(w)!.records!"
                :unit="w.unit"
                :color="host.widgetColor(w)"
              />
              <span v-else class="muted">{{ loadingOrEmpty(w) }}</span>
            </template>
            <template v-else-if="w.type === 'table'">
              <TableWidget
                v-if="compare ? compare.tableRows(w.id).length : resultOf(w)?.table?.length"
                :rows="compare ? compare.tableRows(w.id) : resultOf(w)!.table!"
                :entities="compare ? compare.tableEntities : undefined"
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
      <div v-else class="tw-empty">{{ activeWidgets.length ? t('No widgets visible in this tab.') : t('This tab has no widgets.') }}</div>
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
  background: var(--sw-accent-soft);
  border-bottom-color: var(--sw-accent);
  border-radius: 6px 6px 0 0;
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
.tw-cell-right {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-left: auto;
}
.tw-cell-unit {
  font-size: 9.5px;
  color: var(--sw-fg-3);
}
.tw-popout {
  border: none;
  background: transparent;
  color: var(--sw-fg-3);
  cursor: pointer;
  font-size: 12px;
  line-height: 1;
  padding: 0 2px;
}
.tw-popout:hover { color: var(--sw-accent); }
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
/* Per-entity compare rows for a card child (mirrors the top-level card-compare). */
.tw-card-compare {
  display: flex;
  flex-direction: column;
  gap: 3px;
  width: 100%;
  padding: 0 2px;
}
.tw-cc-row {
  display: flex;
  align-items: baseline;
  gap: 6px;
  font-size: 11px;
}
.tw-cc-dot {
  flex: 0 0 auto;
  width: 7px;
  height: 7px;
  border-radius: 2px;
  align-self: center;
}
.tw-cc-name {
  color: var(--sw-fg-2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.tw-cc-val {
  margin-left: auto;
  font-weight: 700;
  color: var(--sw-fg-0);
  font-variant-numeric: tabular-nums;
}
.tw-cc-val.muted { color: var(--sw-fg-3); font-weight: 400; }
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
