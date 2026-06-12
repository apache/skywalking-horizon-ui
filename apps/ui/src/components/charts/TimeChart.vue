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
import { formatDuration } from '@/utils/formatters';
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
    /** Numeric format hint — `'int'` rounds all axis labels + tooltip
     *  values to integers (pod counts, replica counts, error counts).
     *  Defaults to the compact-readable rule. */
    format?: 'int' | 'decimal' | 'compact' | 'duration' | 'enum';
    /** Explicit x-axis bucket labels. When provided (and length-matched)
     *  these replace the default relative `-Nm` markers — e.g. a caller
     *  with a known window can pass `mm:ss` elapsed labels. */
    xLabels?: string[];
  }>(),
  {
    height: 180,
    accent: 'var(--sw-accent)',
  },
);

// Scientific notation, trailing mantissa zeros trimmed. Axis and tooltip
// share it so a tick and its hovered value read the same.
function sci(v: number): string {
  if (v === 0) return '0';
  return v.toExponential(2).replace(/\.?0+e/, 'e').replace('e+', 'e');
}
function formatVal(v: number): string {
  if (props.format === 'duration') return `${formatDuration(v)} ago`;
  if (Math.abs(v) >= 10_000) return sci(v);
  if (props.format === 'int') return Math.round(v).toString();
  if (props.format === 'decimal') return v.toFixed(1);
  return v.toFixed(2);
}
function formatAxis(v: number): string {
  if (props.format === 'duration') return formatDuration(v, true);
  if (Math.abs(v) >= 10_000) return sci(v);
  if (props.format === 'int') return Math.round(v).toString();
  return String(v);
}

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
  // X-axis labels: callers that know the window (e.g. the layer
  // dashboard, which reconstructs per-bucket times from the active
  // step + range) pass explicit `xLabels`. When absent, fall back to
  // relative "-Nm" markers.
  const length = props.series[0]?.data.length ?? 0;
  const xLabels =
    props.xLabels && props.xLabels.length === length
      ? props.xLabels
      : Array.from({ length }, (_, i) => `-${length - i - 1}m`);
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
      extraCssText:
        'max-height: 60vh; overflow-y: auto; max-width: 360px; ' +
        'box-shadow: 0 8px 24px rgba(0,0,0,0.45);',
      // Position callback returns an OBJECT form ({top, left/right,
      // bottom}) keyed to the chart's own bbox. With appendToBody:true
      // ECharts translates those chart-local anchors into body-absolute
      // pixels internally — much more reliable than computing
      // page-absolute coordinates by hand, which went wrong when the
      // scroll container was `.sw-main` (not `<body>`) and `window.
      // scrollY` was always 0 so the tooltip ended up at a body offset
      // that no longer matched the visible cursor.
      //
      // Strategy: prefer right-of and below the cursor; flip to the
      // opposite side when the tooltip would overflow the chart's own
      // viewSize. The chart's parent (`.widget`) has overflow that
      // would otherwise clip the tooltip — `appendToBody` solves
      // that. ECharts also clamps the final body position to the
      // viewport so we don't need a separate viewport check.
      position(
        point: [number, number],
        _params: unknown,
        _dom: HTMLElement,
        _rect: unknown,
        size: { contentSize: [number, number]; viewSize: [number, number] },
      ): Record<string, number> {
        const [tw, th] = size.contentSize;
        const [vw, vh] = size.viewSize;
        const gap = 12;
        const obj: Record<string, number> = {};
        if (point[0] + tw + gap * 2 > vw) {
          obj.right = vw - point[0] + gap;
        } else {
          obj.left = point[0] + gap;
        }
        if (point[1] + th + gap * 2 > vh) {
          obj.bottom = vh - point[1] + gap;
        } else {
          obj.top = point[1] + gap;
        }
        return obj;
      },
      valueFormatter: (v: unknown) =>
        typeof v === 'number' && Number.isFinite(v)
          ? `${formatVal(v)}${props.unit ? ` ${props.unit}` : ''}`
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
      // Legend chips need ~16px of their own + ~8px gap before the
      // plot's top axis labels. Without enough top padding the chip
      // baseline ends up sitting on top of the highest axis tick.
      top: props.series.length > 1 ? 36 : 10,
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
     * picks up the unit from the first series on that axis when set.
     *
     * When a legend is visible (multi-series charts) we drop the
     * axis name labels — they crowd against the legend chips and the
     * unit is already conveyed through the legend chip annotation
     * (count (/min) / latency (ms) for dual-axis) or implicit for
     * single-axis multi-series like relabeled percentiles. Bare
     * single-series widgets keep the axis name since the legend is
     * hidden there. */
    yAxis: (() => {
      const hasRight = props.series.some((s) => (s.yAxisIndex ?? 0) === 1);
      const legendVisible = props.series.length > 1;
      const rightUnit = props.series.find((s) => (s.yAxisIndex ?? 0) === 1)?.unit;
      const leftUnit = props.series.find((s) => (s.yAxisIndex ?? 0) === 0)?.unit ?? props.unit;
      const axes: Record<string, unknown>[] = [
        {
          type: 'value',
          name: legendVisible ? '' : leftUnit ?? '',
          // Right-align the unit so it sits directly above the (right-
          // aligned) tick labels at the axis line, not floating left of them.
          nameTextStyle: { color: '#64748b', fontSize: 9, align: 'right', padding: [0, 0, 0, 0] },
          nameGap: 8,
          axisLine: { show: false },
          axisLabel: { color: '#64748b', fontSize: 9, formatter: (v: number) => formatAxis(v) },
          splitLine: { lineStyle: { color: 'rgba(255,255,255,0.06)' } },
        },
      ];
      if (hasRight) {
        axes.push({
          type: 'value',
          name: legendVisible ? '' : rightUnit ?? '',
          // Left-align over the right axis's (left-aligned) tick labels.
          nameTextStyle: { color: '#64748b', fontSize: 9, align: 'left' },
          nameGap: 8,
          axisLine: { show: false },
          axisLabel: { color: '#64748b', fontSize: 9, formatter: (v: number) => formatAxis(v) },
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

/** Track previous series fingerprint so we only do a full-replace when
 *  the series structure changes (count / labels / axes). Polling
 *  refreshes keep the same fingerprint and just shift values, so
 *  ECharts can animate point-to-point instead of re-rendering from
 *  scratch — visually the line slides left and the newest dot drops
 *  in on the right. */
function seriesFingerprint(series: Series[]): string {
  return series
    .map((s) => `${s.label}|${s.yAxisIndex ?? 0}|${s.unit ?? ''}|${s.data.length}`)
    .join('::');
}
let prevFingerprint = '';

onMounted(() => {
  if (!container.value) return;
  chart = echarts.init(container.value, null, { renderer: 'canvas' });
  chart.setOption(buildOption());
  prevFingerprint = seriesFingerprint(props.series);
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
  (next) => {
    if (!chart) return;
    const fp = seriesFingerprint(next);
    if (fp === prevFingerprint) {
      // Same structure — just update data values. ECharts animates
      // point-by-point so a polling refresh reads as a smooth slide,
      // not a full re-render.
      chart.setOption({
        series: next.map((s, i) => ({
          name: s.label,
          data: s.data.map((v) => (v === null ? '-' : v)),
          // Index implicit by position; setOption merges by index.
          ...(i === -1 ? {} : {}),
        })),
      });
    } else {
      // Structure changed (count / axis / label flipped) — full
      // replace so stale series elements don't leak into the chart.
      chart.setOption(buildOption(), { replaceMerge: ['series'] });
      prevFingerprint = fp;
    }
  },
  { deep: true },
);
watch(
  () => props.unit,
  () => chart?.setOption(buildOption()),
);
watch(
  () => props.accent,
  () => {
    chart?.setOption(buildOption(), { replaceMerge: ['series'] });
    prevFingerprint = seriesFingerprint(props.series);
  },
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
