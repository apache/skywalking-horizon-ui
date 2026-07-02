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
  One dashboard tile in the layer grid. Dispatches by widget type (card /
  line / top / record / table / tab) and renders both the single-entity and
  the multi-entity compare view inline. A `tab` widget delegates to TabWidget
  (whose children render through the SAME host helpers, via `host`), so a
  widget moved into a tab behaves exactly as it does at the top level. The
  render helpers (color / compare fan-out / pop-out) are passed down from the
  host; this component owns no data, only layout.
-->
<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import type { DashboardWidget, DashboardWidgetResult } from '@skywalking-horizon-ui/api-client';
import TimeChart from '@/components/charts/TimeChart.vue';
import Icon from '@/components/icons/Icon.vue';
import TopList from '@/components/charts/TopList.vue';
import RecordList from '@/render/widgets/RecordList.vue';
import WidgetTip from '@/components/primitives/WidgetTip.vue';
import TableWidget from '@/render/widgets/TableWidget.vue';
import TabWidget from '@/render/widgets/TabWidget.vue';
import type { TabHostCtx } from '@/render/widgets/tabHostCtx';
import type { CompareSeries } from '@/render/layer-dashboard/useCompareEngine';
import { fmtMetricAs, type MetricFormat } from '@/utils/formatters';

interface CardWidget {
  id: string;
  format?: MetricFormat;
  valueMap?: Record<string, string>;
}
interface CompareTopGroup {
  label: string;
  expression: string;
  items: Array<{ name: string; value: number | null }>;
}
interface CompareTableEntity {
  key: string;
  name: string;
  hue: string;
}
type TableRow = NonNullable<DashboardWidgetResult['table']>[number] & { entityKey: string };

const props = defineProps<{
  widget: DashboardWidget;
  compareMode: boolean;
  isFetching: boolean;
  compareLoading: boolean;
  compareEntities: string[];
  results: Map<string, DashboardWidgetResult>;
  /** Active-tab index resolved + clamped by the host (drives the lazy query). */
  activeTabIndex: number;
  tabHost: TabHostCtx;
  // Render helpers — the canonical host helpers shared with TabWidget's children.
  gridStyle: (w: DashboardWidget) => Record<string, string>;
  widgetColor: (w: DashboardWidget) => string;
  xLabelsForLen: (len: number) => string[];
  cardText: (w: CardWidget) => string;
  hasTopData: (w: { id: string; type: string }) => boolean;
  popOutTopList: (id: string) => void;
  setTopListRef: (id: string, el: unknown) => void;
  traceDrillMode: (w: DashboardWidget) => 'latency' | 'error' | null;
  onDrillPoint: (
    w: DashboardWidget,
    p: { seriesIndex: number; dataIndex: number; value: number; seriesName: string; x: number; y: number },
  ) => void;
  drillOpenId: string | null;
  // Compare-mode helpers (null-safe: only read when compareMode is true).
  compareHue: (key: string) => string;
  entityLabel: (key: string) => string;
  cardValueFor: (id: string, key: string) => number | null;
  cardTextFor: (w: CardWidget, key: string) => string;
  multiLineSeries: (id: string) => CompareSeries[];
  lineLen: (id: string) => number;
  multiTopGroups: (id: string) => CompareTopGroup[];
  hasMultiTopData: (id: string) => boolean;
  compareTableRows: (id: string) => TableRow[];
  compareTableEntities: CompareTableEntity[];
}>();
const emit = defineEmits<{ (e: 'switch-tab', index: number): void }>();

const { t } = useI18n({ useScope: 'global' });

function result(id: string): DashboardWidgetResult | undefined {
  return props.results.get(id);
}

// Colored enum card: the BFF keeps the metric's labels (one row per active
// label — e.g. a K8s node's Ready / *Pressure conditions) instead of
// collapsing to a scalar, so we render them as status chips. The chip key is
// whichever label value the operator mapped in valueColors / valueMap.
type ChipRow = NonNullable<DashboardWidgetResult['table']>[number];
function chipKey(w: DashboardWidget, row: ChipRow): string {
  for (const l of row.labels) {
    if (l.value in (w.valueColors ?? {}) || l.value in (w.valueMap ?? {})) return l.value;
  }
  return row.labels.map((l) => l.value).join(' ') || String(row.value ?? '');
}
function chipLabel(w: DashboardWidget, row: ChipRow): string {
  const k = chipKey(w, row);
  return w.valueMap?.[k] ?? k;
}
function chipColor(w: DashboardWidget, row: ChipRow): 'ok' | 'warn' | 'err' | 'info' | 'neutral' {
  const c = w.valueColors?.[chipKey(w, row)];
  return c === 'ok' || c === 'warn' || c === 'err' || c === 'info' ? c : 'neutral';
}
// Only conditions the operator mapped are shown — keeps the status card on the
// health conditions (Ready / *Pressure) and drops informational K8s noise.
function chipRows(w: DashboardWidget, res: DashboardWidgetResult | undefined): ChipRow[] {
  return (res?.table ?? []).filter((r) =>
    r.labels.some((l) => l.value in (w.valueColors ?? {}) || l.value in (w.valueMap ?? {})),
  );
}
</script>

<template>
  <div
    class="widget sw-card"
    :class="{ 'is-tab': widget.type === 'tab' }"
    :style="{ ...gridStyle(widget), '--widget-accent': widgetColor(widget) }"
  >
    <!-- Tab widgets carry no title — the tab bar is their header. -->
    <div v-if="widget.type !== 'tab'" class="w-head">
      <div class="w-head-title">
        <h4>{{ widget.title }}</h4>
        <WidgetTip :tip="widget.tip" />
      </div>
      <div class="w-head-right">
        <span
          v-if="!compareMode && traceDrillMode(widget)"
          class="drill-flag"
          :class="`df-${traceDrillMode(widget)}`"
          :title="traceDrillMode(widget) === 'latency'
            ? t('Click a point to view the slowest traces at that time')
            : t('Click a point to view error traces at that time')"
        >
          <Icon name="trace" :size="11" />
          <span>{{ t('traces') }}</span>
        </span>
        <!-- Card widgets render the unit beneath the big value;
             surfacing it here too is a duplicate. Other types
             (line / top / record) need the unit hint here because
             their bodies don't reprint it. -->
        <span v-if="widget.unit && widget.type !== 'card'" class="unit">{{ widget.unit }}</span>
        <button
          v-if="(widget.type === 'top' || (widget.type === 'record' && compareMode)) && hasTopData(widget)"
          type="button"
          class="w-popout"
          :title="t('Pop out — full list')"
          :aria-label="t('Pop out — full list')"
          @click="popOutTopList(widget.id)"
        >⤢</button>
      </div>
    </div>
    <div class="w-body" :class="`type-${widget.type}`">
      <!-- The primary query's per-widget error gates ONLY the single-
           entity view. In compare mode the grid renders from the
           per-entity fan-out (errors are isolated per entity — a bad
           primary, or a primary outside the locked cohort, must not
           blank valid locked-entity results). -->
      <template v-if="!compareMode && result(widget.id)?.error">
        <span class="muted">{{ result(widget.id)!.error }}</span>
      </template>
      <template v-else-if="widget.type === 'card'">
        <div v-if="!compareMode && widget.valueColors && chipRows(widget, result(widget.id)).length" class="card-chips">
          <span
            v-for="(row, ci) in chipRows(widget, result(widget.id))"
            :key="ci"
            class="status-chip"
            :class="`sc-${chipColor(widget, row)}`"
          >{{ chipLabel(widget, row) }}</span>
        </div>
        <div v-else-if="compareMode" class="card-compare">
          <div v-for="e in compareEntities" :key="e" class="cc-row">
            <span class="cc-dot" :style="{ background: compareHue(e) }" />
            <span class="cc-name" :title="entityLabel(e)">{{ entityLabel(e) }}</span>
            <span class="cc-val" :class="{ muted: cardValueFor(widget.id, e) == null }">{{ cardTextFor(widget, e) }}</span>
          </div>
        </div>
        <div v-else class="card-value">
          <span class="num" :class="{ muted: result(widget.id)?.value == null }">
            {{ results.has(widget.id)
              ? cardText(widget)
              : (isFetching ? '…' : fmtMetricAs(null, widget.format)) }}
          </span>
          <span v-if="widget.unit" class="unit">{{ widget.unit }}</span>
        </div>
      </template>
      <template v-else-if="widget.type === 'line'">
        <TimeChart
          v-if="compareMode ? multiLineSeries(widget.id).length : result(widget.id)?.series?.length"
          :series="compareMode ? multiLineSeries(widget.id) : result(widget.id)!.series!"
          :unit="widget.unit"
          :height="(widget.rowSpan ?? 1) * 110 - 50"
          :accent="widgetColor(widget)"
          :format="widget.format"
          :x-labels="xLabelsForLen(compareMode ? lineLen(widget.id) : (result(widget.id)!.series![0]?.data.length ?? 0))"
          :clickable="!compareMode && !!traceDrillMode(widget)"
          :tip-suppressed="drillOpenId === widget.id"
          @point-click="onDrillPoint(widget, $event)"
        />
        <span v-else class="muted">{{ (compareMode ? compareLoading : (isFetching && !results.has(widget.id))) ? t('loading…') : t('no data') }}</span>
      </template>
      <template v-else-if="widget.type === 'top'">
        <TopList
          v-if="compareMode && hasMultiTopData(widget.id)"
          :ref="(el) => setTopListRef(widget.id, el)"
          :groups="multiTopGroups(widget.id)"
          :unit="widget.unit"
          :color="widgetColor(widget)"
          :title="widget.title"
        />
        <TopList
          v-else-if="!compareMode && result(widget.id)?.topGroups?.length"
          :ref="(el) => setTopListRef(widget.id, el)"
          :groups="result(widget.id)!.topGroups!"
          :unit="widget.unit"
          :color="widgetColor(widget)"
          :title="widget.title"
        />
        <TopList
          v-else-if="!compareMode && result(widget.id)?.topList?.length"
          :ref="(el) => setTopListRef(widget.id, el)"
          :items="result(widget.id)!.topList!"
          :unit="widget.unit"
          :color="widgetColor(widget)"
          :title="widget.title"
        />
        <span v-else class="muted">{{ (compareMode ? compareLoading : (isFetching && !results.has(widget.id))) ? t('loading…') : t('no data') }}</span>
      </template>
      <template v-else-if="widget.type === 'record'">
        <!-- Slow-statement / record list. Compare mode falls back to
             the plain TopList (name + value, no single trace to jump
             to); single-entity uses RecordList, which adds the per-row
             jump-to-trace icon (only when the sample carries a trace
             id) and click-to-copy on the statement. -->
        <TopList
          v-if="compareMode && hasMultiTopData(widget.id)"
          :ref="(el) => setTopListRef(widget.id, el)"
          :groups="multiTopGroups(widget.id)"
          :unit="widget.unit"
          :color="widgetColor(widget)"
          :title="widget.title"
        />
        <RecordList
          v-else-if="!compareMode && result(widget.id)?.records?.length"
          :items="result(widget.id)!.records!"
          :unit="widget.unit"
          :color="widgetColor(widget)"
        />
        <span v-else class="muted">{{ (compareMode ? compareLoading : (isFetching && !results.has(widget.id))) ? t('loading…') : t('no data') }}</span>
      </template>
      <template v-else-if="widget.type === 'table'">
        <TableWidget
          v-if="compareMode ? compareTableRows(widget.id).length : result(widget.id)?.table?.length"
          :rows="compareMode ? compareTableRows(widget.id) : result(widget.id)!.table!"
          :entities="compareMode ? compareTableEntities : undefined"
          :label-top-n="widget.labelTopN"
          :headers="widget.tableHeaders"
          :show-values="widget.showTableValues !== false"
          :unit="widget.unit"
          :format="widget.format"
        />
        <span v-else class="muted">{{ (compareMode ? compareLoading : (isFetching && !results.has(widget.id))) ? t('loading…') : t('no data') }}</span>
      </template>
      <template v-else-if="widget.type === 'tab'">
        <TabWidget
          :widget="widget"
          :active-index="activeTabIndex"
          :results="results"
          :is-fetching="isFetching"
          :compare-mode="compareMode"
          :host="tabHost"
          @switch="emit('switch-tab', $event)"
        />
      </template>
    </div>
  </div>
</template>

<style scoped>
.widget {
  display: flex;
  flex-direction: column;
  min-width: 0;
  overflow: hidden;
}
/* Tab container (runtime): no title (the tab bar is the header). The boundary is
 * top + bottom rules with four rounded corner brackets and NO left/right side —
 * drawn as absolute caps so it takes no layout width and the inner widgets stay
 * flush-aligned. */
.widget.is-tab {
  position: relative;
  background: transparent;
  border: none;
  overflow: visible;
}
.widget.is-tab::before,
.widget.is-tab::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  height: 12px;
  border: 2px solid var(--sw-line-2);
  pointer-events: none;
}
.widget.is-tab::before { top: 0; border-bottom: none; border-radius: 8px 8px 0 0; }
.widget.is-tab::after { bottom: 0; border-top: none; border-radius: 0 0 8px 8px; }
.widget.is-tab > .w-body { padding: 0; }
.w-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 10px;
  border-bottom: 1px solid var(--sw-line);
  /* Subtle left-edge accent tinted to the widget's primary metric
   * color — ties each card to the matching KPI in the layer header. */
  border-left: 3px solid var(--widget-accent, var(--sw-accent));
}
.w-head-title {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  flex: 1;
}
.w-head h4 {
  margin: 0;
  font-size: 12px;
  font-weight: 600;
  color: var(--widget-accent, var(--sw-fg-0));
  letter-spacing: -0.01em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.w-head-right {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-left: auto;
  flex: 0 0 auto;
}
.w-head .unit {
  font-size: 10.5px;
  color: var(--sw-fg-3);
  flex: 0 0 auto;
}
/* Pop-out trigger for top / record widgets — lives in the title bar so it
 * never overlaps the in-widget tab row. */
.w-popout {
  width: 18px;
  height: 18px;
  padding: 0;
  font-size: 12px;
  line-height: 1;
  color: var(--sw-fg-3);
  background: transparent;
  border: 1px solid var(--sw-line);
  border-radius: 4px;
  cursor: pointer;
  transition: color 0.12s, border-color 0.12s;
}
.w-popout:hover {
  color: var(--sw-fg-0);
  border-color: var(--sw-line-2);
}
.drill-flag {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 1px 6px 1px 4px;
  border-radius: 999px;
  font-size: 9.5px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  white-space: nowrap;
  border: 1px solid transparent;
}
.drill-flag.df-latency {
  color: var(--sw-warn);
  background: var(--sw-warn-soft);
  border-color: color-mix(in srgb, var(--sw-warn) 30%, transparent);
}
.drill-flag.df-error {
  color: var(--sw-err);
  background: var(--sw-err-soft);
  border-color: color-mix(in srgb, var(--sw-err) 30%, transparent);
}
.w-body {
  /* Column-flex so charts / lists / records can flex: 1 and claim the
   * full widget height. Card-type widgets opt into centering via the
   * `.type-card` modifier (single scalar number reads better when
   * vertically centered). */
  flex: 1;
  display: flex;
  flex-direction: column;
  padding: 8px 12px;
  min-height: 0;
  overflow: hidden;
}
.w-body.type-card {
  align-items: center;
  justify-content: center;
}
.w-body :deep(.top-list) {
  flex: 1;
  min-height: 0;
}
.w-body :deep(.top-list .rows) {
  /* Inside TopList, the .rows wrapper already has `flex: 1` + scroll —
   * but it needs an explicit `min-height: 0` so the rows region can
   * shrink past its intrinsic content height when the widget is
   * shorter than the data. Without this, a 3-row-span widget renders
   * all 10 rows uncropped and the chrome distorts. */
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
.card-chips {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  align-content: center;
  gap: 6px;
  height: 100%;
  padding: 6px 0;
}
.status-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 10px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
}
.status-chip::before {
  content: '';
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: currentColor;
}
.sc-ok { color: var(--sw-ok); background: var(--sw-ok-soft); }
.sc-warn { color: var(--sw-warn); background: var(--sw-warn-soft); }
.sc-err { color: var(--sw-err); background: var(--sw-err-soft); }
.sc-info { color: var(--sw-info); background: var(--sw-info-soft); }
.sc-neutral { color: var(--sw-fg-3); background: var(--sw-bg-2); }
.muted {
  color: var(--sw-fg-3);
  font-size: 11px;
}
.w-body :deep(.time-chart) {
  width: 100%;
}

/* Below the breakpoint every tile drops to full width — the grid is
 * 12-col but each widget claims all 12 columns so the layout stacks. */
@media (max-width: 1100px) {
  .widget {
    grid-column: span 12 !important;
  }
}
</style>
