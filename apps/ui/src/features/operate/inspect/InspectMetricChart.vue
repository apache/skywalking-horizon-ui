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
/**
 * One MQE-result chart on the Metrics Inspect board. Owns its ECharts
 * instance + lifecycle so the view never instantiates ECharts directly.
 * A ResizeObserver covers both window resize and the density toggle (which
 * changes each card's width), so the view needs no manual resize wiring.
 */
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import * as echarts from 'echarts';
import type { ExpressionResult } from '@skywalking-horizon-ui/api-client';
import { bucketTimeLabel } from '@/utils/formatters';

const props = defineProps<{
  result: ExpressionResult;
  chart: 'line' | 'bar' | 'area';
  /** Query step — drives the time-axis label format (same as the dashboards). */
  step: 'MINUTE' | 'HOUR' | 'DAY';
  /** Fallback series name when a result carries no labels. */
  metricName: string;
}>();

const host = ref<HTMLDivElement | null>(null);
let inst: echarts.ECharts | null = null;
let ro: ResizeObserver | null = null;

const PALETTE = [
  '#6db4d6', '#4ec9b0', '#f0b454', '#b794e4', '#ff7a90',
  '#9ad17a', '#e29ec8', '#6c8ee0', '#d8a064', '#73d4cc',
];

function buildOption(): echarts.EChartsOption {
  if (props.result.results.length === 0) return {};
  const mono = 'JetBrains Mono, ui-monospace, monospace';
  // MQE returns per-series values with an `id` field that is the time-bucket
  // label; use it as the x-axis category, deduped across series so the axis
  // stays consistent when one series has gaps.
  const xSet = new Set<string>();
  for (const r of props.result.results) {
    for (const v of r.values) {
      if (v.id) xSet.add(v.id);
    }
  }
  // Bucket ids are epoch-ms: sort chronologically and format each by the query
  // step, identical to the layer-dashboard line widgets (DAY → MM-DD,
  // HOUR → MM-DD HH:00, MINUTE → HH:MM). Series data aligns to `xIds` by index;
  // the axis renders the parallel `xLabels`. Non-numeric ids fall back to raw.
  const xIds = [...xSet].sort((a, b) => Number(a) - Number(b));
  const xLabels = xIds.map((id) => {
    const ms = Number(id);
    return Number.isFinite(ms) ? bucketTimeLabel(props.step, ms) : id;
  });

  const series: echarts.EChartsOption['series'] = props.result.results.map((r, idx) => {
    const color = PALETTE[idx % PALETTE.length];
    const byId = new Map(r.values.map((v) => [v.id ?? '', v.value]));
    const data = xIds.map((id) => {
      const raw = byId.get(id);
      return raw === null || raw === undefined ? null : Number.parseFloat(raw);
    });
    const name = r.metric.labels.length > 0
      ? r.metric.labels.map((l) => `${l.key}=${l.value}`).join('·')
      : props.metricName;
    if (props.chart === 'bar') {
      return { name, type: 'bar', data, itemStyle: { color }, barMaxWidth: 10 };
    }
    // Always render the marker — with showSymbol:false a non-null point
    // surrounded by nulls draws nothing and the value goes invisible.
    return {
      name,
      type: 'line',
      data,
      smooth: true,
      showSymbol: true,
      symbolSize: 4,
      connectNulls: false,
      lineStyle: { width: 1.5, color },
      itemStyle: { color },
      areaStyle: props.chart === 'area' ? { color, opacity: 0.14 } : undefined,
    };
  });

  const showLegend = series.length > 1;
  return {
    grid: { left: 32, right: 6, top: showLegend ? 30 : 6, bottom: 18 },
    tooltip: {
      trigger: 'axis',
      // Body-level so it isn't clipped by the card overflow or the sidebar.
      appendToBody: true,
      backgroundColor: '#1c2630',
      borderWidth: 0,
      textStyle: { color: '#e6edf3', fontSize: 10.5, fontFamily: mono },
    },
    legend: showLegend
      ? {
          top: 0, left: 0, right: 0, type: 'scroll',
          textStyle: { color: '#c2cbd4', fontSize: 11, fontFamily: mono },
          itemHeight: 8, itemWidth: 14, itemGap: 16,
          pageIconColor: '#c2cbd4',
          pageIconInactiveColor: '#3a4651',
          pageIconSize: 11,
          pageTextStyle: { color: '#8a96a3', fontSize: 10 },
        }
      : undefined,
    xAxis: {
      type: 'category',
      data: xLabels,
      axisLine: { lineStyle: { color: '#232f39' } },
      axisLabel: { color: '#5e6c79', fontSize: 9, hideOverlap: true, fontFamily: mono },
    },
    yAxis: {
      type: 'value',
      axisLine: { show: false },
      axisTick: { show: false },
      splitLine: { lineStyle: { color: '#1c2630' } },
      axisLabel: { color: '#5e6c79', fontSize: 9, fontFamily: mono },
    },
    series,
    animationDuration: 250,
  };
}

function render() {
  inst?.setOption(buildOption(), true);
}

onMounted(() => {
  if (!host.value) return;
  inst = echarts.init(host.value, undefined, { renderer: 'canvas' });
  render();
  ro = new ResizeObserver(() => inst?.resize());
  ro.observe(host.value);
});

watch([() => props.result, () => props.chart], render);

onBeforeUnmount(() => {
  ro?.disconnect();
  inst?.dispose();
  inst = null;
  ro = null;
});
</script>

<template>
  <div ref="host" class="inspect-chart" />
</template>

<style scoped>
.inspect-chart { width: 100%; height: var(--chart-h, 150px); }
</style>
