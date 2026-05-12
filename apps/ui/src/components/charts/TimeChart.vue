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
  Thin ECharts wrapper for multi-series line charts. Used by the
  per-layer Dashboards widgets. Owns its instance lifecycle and resizes
  with the container — the parent gives us a fixed pixel height.

  Per project convention this is the *only* place ECharts is touched —
  no view component imports echarts directly. Swap-out point if we
  decide to move away from ECharts later.
-->
<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import * as echarts from 'echarts/core';
import { LineChart } from 'echarts/charts';
import { GridComponent, LegendComponent, TooltipComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { EChartsType } from 'echarts/core';

echarts.use([LineChart, GridComponent, LegendComponent, TooltipComponent, CanvasRenderer]);

interface Series {
  label: string;
  data: Array<number | null>;
  /** `0` = left axis (default), `1` = right axis. */
  yAxisIndex?: number;
  unit?: string;
}

const props = withDefaults(
  defineProps<{
    series: Series[];
    height?: number;
    /** Optional unit suffix shown in the tooltip. */
    unit?: string;
    /** Color hint for the first series (subsequent series cycle through
     *  a default palette so percentile lines remain distinguishable). */
    accent?: string;
  }>(),
  {
    height: 180,
    accent: 'var(--sw-accent)',
  },
);

/**
 * Resolve a CSS variable like `var(--sw-accent)` to its computed RGB
 * by querying the document root. ECharts doesn't honor CSS vars on
 * canvas-rendered series, so we evaluate once and feed the hex. Falls
 * back to the orange accent when the variable resolves empty.
 */
function cssVar(token: string): string {
  if (!token.startsWith('var(')) return token;
  if (typeof window === 'undefined') return '#f97316';
  const name = token.replace(/^var\(\s*/, '').replace(/\s*\)\s*$/, '');
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || '#f97316';
}

/**
 * Secondary palette for multi-line widgets (e.g., percentile relabels
 * → 5 series). The first series uses the widget's accent (or the
 * accent prop); subsequent lines pick from this palette so the lines
 * are distinguishable. Picks deliberately don't reuse the accent.
 */
const SECONDARY = [
  '#60a5fa', // info-ish (blue)
  '#a78bfa', // purple
  '#22d3ee', // cyan
  '#f472b6', // pink
  '#34d399', // ok-ish (green)
  '#fbbf24', // amber
];

const container = ref<HTMLDivElement | null>(null);
let chart: EChartsType | null = null;

function buildOption(): echarts.EChartsCoreOption {
  // Generate equal-spaced bucket indices for the x-axis. We don't have
  // explicit timestamps from the BFF response (the duration window is
  // implied to be MINUTE-stepped over the last 15m), so we label the
  // axis with relative "-Nm" markers.
  const length = props.series[0]?.data.length ?? 0;
  const xLabels = Array.from({ length }, (_, i) => `-${length - i - 1}m`);
  return {
    backgroundColor: 'transparent',
    tooltip: {
      trigger: 'axis',
      backgroundColor: 'rgba(20,20,24,0.92)',
      borderColor: 'rgba(255,255,255,0.08)',
      textStyle: { color: '#e5e7eb', fontSize: 11 },
      // Append to document.body so the popup isn't clipped by the
      // widget card's overflow:hidden. Otherwise the tooltip cuts off
      // at the card edge whenever a chart sits near the boundary.
      appendToBody: true,
      confine: false,
      valueFormatter: (v: unknown) =>
        typeof v === 'number' && Number.isFinite(v)
          ? `${v.toFixed(2)}${props.unit ? ` ${props.unit}` : ''}`
          : '—',
    },
    legend: {
      show: props.series.length > 1,
      top: 2,
      left: 4,
      right: 4,
      padding: [0, 0, 0, 0],
      textStyle: { color: '#94a3b8', fontSize: 10, lineHeight: 12 },
      itemWidth: 10,
      itemHeight: 8,
      itemGap: 14,
      icon: 'roundRect',
      type: 'scroll',
    },
    grid: {
      left: 36,
      right: props.series.some((s) => (s.yAxisIndex ?? 0) === 1) ? 32 : 8,
      // When legend renders we need ~18px above the plot for the chips
      // and a few px breathing room before the top axis label kicks in.
      top: props.series.length > 1 ? 28 : 10,
      bottom: 8,
      containLabel: false,
    },
    xAxis: {
      type: 'category',
      data: xLabels,
      axisLine: { lineStyle: { color: 'rgba(255,255,255,0.08)' } },
      axisLabel: { color: '#64748b', fontSize: 9, interval: Math.floor(length / 6) },
      splitLine: { show: false },
    },
    /* Dual y-axis when any series asks for axis 1. Right axis label
     * picks up the unit from the first series on that axis when set. */
    yAxis: (() => {
      const hasRight = props.series.some((s) => (s.yAxisIndex ?? 0) === 1);
      const rightUnit = props.series.find((s) => (s.yAxisIndex ?? 0) === 1)?.unit;
      const leftUnit = props.series.find((s) => (s.yAxisIndex ?? 0) === 0)?.unit ?? props.unit;
      const axes: Record<string, unknown>[] = [
        {
          type: 'value',
          name: leftUnit ?? '',
          nameTextStyle: { color: '#64748b', fontSize: 9, padding: [0, 0, 0, 0] },
          nameGap: 6,
          axisLine: { show: false },
          axisLabel: { color: '#64748b', fontSize: 9 },
          splitLine: { lineStyle: { color: 'rgba(255,255,255,0.06)' } },
        },
      ];
      if (hasRight) {
        axes.push({
          type: 'value',
          name: rightUnit ?? '',
          nameTextStyle: { color: '#64748b', fontSize: 9 },
          nameGap: 6,
          axisLine: { show: false },
          axisLabel: { color: '#64748b', fontSize: 9 },
          splitLine: { show: false },
        });
      }
      return axes;
    })(),
    series: props.series.map((s, i) => {
      const accentHex = cssVar(props.accent);
      const color = i === 0 ? accentHex : SECONDARY[(i - 1) % SECONDARY.length];
      // For dual-axis widgets, append the per-series unit to the
      // legend label so operators can tell which line is on which
      // axis at a glance (e.g. "count (/min)" vs "latency (ms)").
      // Single-axis widgets keep the bare label — unit lives on the
      // single y-axis annotation already.
      const hasDualAxis = props.series.some((x) => (x.yAxisIndex ?? 0) === 1);
      const name = hasDualAxis && s.unit ? `${s.label} (${s.unit})` : s.label;
      return {
        name,
        type: 'line',
        smooth: true,
        // Small circle markers on every data point so values are
        // visually anchored even before hover; the marker grows on
        // emphasis (hover) for the active point.
        symbol: 'circle',
        symbolSize: 4,
        showSymbol: true,
        yAxisIndex: s.yAxisIndex ?? 0,
        lineStyle: { width: 1.5 },
        data: s.data.map((v) => (v === null ? '-' : v)),
        itemStyle: { color, borderColor: color, borderWidth: 1 },
        emphasis: {
          focus: 'series',
          scale: false,
          itemStyle: {
            borderColor: color,
            borderWidth: 2,
            color: '#fff',
          },
        },
        areaStyle:
          props.series.length === 1
            ? { color: accentHex, opacity: 0.12 }
            : undefined,
      };
    }),
  };
}

onMounted(() => {
  if (!container.value) return;
  chart = echarts.init(container.value, null, { renderer: 'canvas' });
  chart.setOption(buildOption());
  const ro = new ResizeObserver(() => chart?.resize());
  ro.observe(container.value);
  onBeforeUnmount(() => {
    ro.disconnect();
    chart?.dispose();
    chart = null;
  });
});

watch(
  () => props.series,
  () => chart?.setOption(buildOption(), { replaceMerge: ['series'] }),
  { deep: true },
);
watch(
  () => props.unit,
  () => chart?.setOption(buildOption()),
);
watch(
  () => props.accent,
  () => chart?.setOption(buildOption(), { replaceMerge: ['series'] }),
);
</script>

<template>
  <div ref="container" class="time-chart" :style="{ height: `${height}px` }" />
</template>

<style scoped>
.time-chart {
  width: 100%;
}
</style>
