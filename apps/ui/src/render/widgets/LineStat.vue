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
  A `line` widget with `showValue`: one big number and its line, in one of
  two layouts. `stacked` puts the number at the top and starts the line
  `topMargin` below it, bare unless `axes` is on; `sideBySide` gives the
  number the left `split` percent and the line the rest, with its axes.
-->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  LINE_VALUE_DEFAULTS,
  lineShowValue,
  type DashboardSeries,
  type DashboardWidget,
  type LineValueCalculation,
} from '@skywalking-horizon-ui/api-client';
import TimeChart from '@/components/charts/TimeChart.vue';
import { fmtMetricAs, type MetricFormat } from '@/utils/formatters';
import { NEUTRAL_METRIC_COLOR } from '@/utils/metricColor';

/** Height of the number's text row. A top margin below this puts the line
 *  behind the number, and the line is drawn fainter so the number reads. */
const NUMBER_BLOCK_PX = 32;
/** The least height the line keeps, however large the top margin. */
const MIN_CHART_PX = 24;

const props = defineProps<{
  widget: DashboardWidget;
  series: DashboardSeries[];
  /** Height to draw at until the space the widget body really has is
   *  measured; the widget then fills that space. */
  height: number;
  accent?: string;
  xLabels?: string[];
  clickable?: boolean;
  tipSuppressed?: boolean;
}>();
const emit = defineEmits<{
  pointClick: [{ seriesIndex: number; dataIndex: number; value: number; seriesName: string; x: number; y: number }];
}>();

const { t } = useI18n({ useScope: 'global' });

/** Both latest calculations read "latest" on the card; which bucket they
 *  take is the widget author's choice, not something to read at a glance. */
const CAPTION: Record<LineValueCalculation, string> = {
  avg: 'average',
  latest: 'latest',
  latestNotNull: 'latest',
};

const opts = computed(() => props.widget.showValue ?? { calculation: 'avg' as const });
const layout = computed(() => opts.value.layout ?? LINE_VALUE_DEFAULTS.layout);
const topMargin = computed(() => opts.value.topMargin ?? LINE_VALUE_DEFAULTS.topMargin);

const value = computed(() => lineShowValue(props.series[0]?.data, opts.value.calculation));
/** A metric with no colour of its own draws in the theme's series blue, as
 *  the data lines beside it do; the text colour it would otherwise take
 *  reads as black on a light theme. */
const lineColor = computed(() => (!props.accent || props.accent === NEUTRAL_METRIC_COLOR ? 'var(--sw-series-3)' : props.accent));

const root = ref<HTMLElement | null>(null);
const measured = ref<number | null>(null);
let observer: ResizeObserver | null = null;
onMounted(() => {
  if (!root.value || typeof ResizeObserver === 'undefined') return;
  observer = new ResizeObserver(() => {
    const h = root.value?.clientHeight ?? 0;
    if (h > 0) measured.value = h;
  });
  observer.observe(root.value);
});
onBeforeUnmount(() => observer?.disconnect());
const fullHeight = computed(() => measured.value ?? props.height);
/** The margin the card has room for: on a short card a large margin would
 *  push the line out of the body, where it is clipped. */
const top = computed(() => Math.min(topMargin.value, Math.max(0, fullHeight.value - MIN_CHART_PX)));
const behind = computed(() => layout.value === 'stacked' && top.value < NUMBER_BLOCK_PX);
/** The number comes from the first series, so its unit does too: an
 *  expression's own unit overrides the widget's. */
const unit = computed(() => props.series[0]?.unit || props.widget.unit);
const text = computed(() => fmtMetricAs(value.value, props.widget.format as MetricFormat | undefined));
</script>

<template>
  <div
    ref="root"
    class="line-stat"
    :class="layout"
    :style="{ minHeight: `${height}px`, '--split': `${opts.split ?? LINE_VALUE_DEFAULTS.split}%`, '--top': `${top}px` }"
  >
    <div class="ls-num" :class="{ behind }">
      <span class="num" :class="{ muted: value == null }">{{ text }}<span v-if="unit" class="unit">{{ unit }}</span></span>
      <span class="cap">{{ t(CAPTION[opts.calculation]) }}</span>
    </div>
    <div class="ls-chart">
      <TimeChart
        :series="series"
        :unit="widget.unit"
        :height="layout === 'stacked' ? Math.max(MIN_CHART_PX, fullHeight - top) : fullHeight"
        :accent="lineColor"
        :format="widget.format"
        :x-labels="xLabels"
        :clickable="clickable"
        :tip-suppressed="tipSuppressed"
        :sparkline="layout === 'stacked' && !(opts.axes ?? LINE_VALUE_DEFAULTS.axes)"
        :dim="behind"
        @point-click="emit('pointClick', $event)"
      />
    </div>
  </div>
</template>

<style scoped>
.line-stat {
  position: relative;
  flex: 1 1 auto;
}
.ls-num {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  column-gap: 8px;
  row-gap: 2px;
  min-width: 0;
}
.num {
  font-size: 30px;
  line-height: 1;
  font-weight: 700;
  color: var(--sw-fg-0);
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.02em;
  white-space: nowrap;
}
.num.muted {
  /* fg-3 falls under the 3:1 large-text contrast on most themes. */
  color: var(--sw-fg-2);
}
.unit {
  font-size: 12px;
  font-weight: 500;
  color: var(--sw-fg-1);
  margin-left: 3px;
  letter-spacing: 0;
}
.cap {
  font-size: 10px;
  /* Not fainter: small text needs the AA contrast fg-1 gives on both themes. */
  color: var(--sw-fg-1);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  white-space: nowrap;
}

/* stacked: the number over the top of the body, the line from --top down. */
.stacked .ls-num {
  position: absolute;
  top: 0;
  left: 0;
  z-index: 1;
  pointer-events: none;
}
.stacked .ls-num.behind .num,
.stacked .ls-num.behind .cap {
  text-shadow: 0 0 8px var(--sw-bg-1), 0 0 2px var(--sw-bg-1);
}
.stacked .ls-chart {
  position: absolute;
  top: var(--top);
  left: 0;
  right: 0;
  bottom: 0;
}

/* sideBySide: the number in the left --split, the line in the rest. */
.sideBySide {
  display: flex;
  gap: 10px;
}
.sideBySide .ls-num {
  flex: 0 0 var(--split);
  flex-direction: column;
  align-items: flex-start;
  justify-content: center;
}
.sideBySide .ls-chart {
  flex: 1;
  min-width: 0;
}
</style>
