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
import { ENTITY_PALETTE } from '@/utils/metricColor';
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
  /** Explicit per-series hue (CSS color or var). Overrides the
   *  positional accent/SECONDARY cycle — used by the multi-entity
   *  overlay so each entity keeps its palette hue. */
  color?: string;
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
    clickable?: boolean;
    tipSuppressed?: boolean;
  }>(),
  {
    height: 180,
    accent: 'var(--sw-accent)',
  },
);

const emit = defineEmits<{
  pointClick: [
    { seriesIndex: number; dataIndex: number; value: number; seriesName: string; x: number; y: number },
  ];
}>();

const lastPointer = ref<{ x: number; y: number }>({ x: 0, y: 0 });
function onPointerDown(e: MouseEvent): void {
  lastPointer.value = { x: e.clientX, y: e.clientY };
}

// Compact magnitude with an SI suffix (k / M / G / T), ~3 significant
// figures, trailing zeros trimmed — `45.1k`, not the scientific `4.51e4`
// operators found unreadable. Axis and tooltip share it so a tick and its
// hovered value read the same.
function humanize(v: number): string {
  if (v === 0) return '0';
  const abs = Math.abs(v);
  const units: Array<[number, string]> = [
    [1e12, 'T'],
    [1e9, 'G'],
    [1e6, 'M'],
    [1e3, 'k'],
  ];
  for (let i = 0; i < units.length; i += 1) {
    const [scale, suffix] = units[i];
    if (abs >= scale) {
      const n = v / scale;
      const dec = Math.abs(n) >= 100 ? 0 : Math.abs(n) >= 10 ? 1 : 2;
      const rounded = parseFloat(n.toFixed(dec));
      // Carry across the decade boundary: 999_999 rounds to 1000 at 'k' — show
      // it in the next-larger unit ('1M') instead of the ugly '1000k'.
      if (Math.abs(rounded) >= 1000 && i > 0) {
        const [s2, suf2] = units[i - 1];
        const n2 = v / s2;
        const d2 = Math.abs(n2) >= 100 ? 0 : Math.abs(n2) >= 10 ? 1 : 2;
        return `${parseFloat(n2.toFixed(d2))}${suf2}`;
      }
      return `${rounded}${suffix}`;
    }
  }
  return String(v);
}
function formatVal(v: number): string {
  if (props.format === 'duration') return `${formatDuration(v)} ago`;
  if (Math.abs(v) >= 10_000) return humanize(v);
  if (props.format === 'int') return Math.round(v).toString();
  if (props.format === 'decimal') return v.toFixed(1);
  return v.toFixed(2);
}
function formatAxis(v: number): string {
  if (props.format === 'duration') return formatDuration(v, true);
  if (Math.abs(v) >= 10_000) return humanize(v);
  if (props.format === 'int') return Math.round(v).toString();
  return String(v);
}
// Tooltip rows are hand-built HTML (the tooltip is appendToBody, so scoped
// CSS can't reach it) — escape the OAP-supplied series labels before
// interpolating them in.
function escHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;',
  );
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
const SECONDARY = ENTITY_PALETTE;

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
        'max-height: 60vh; overflow-y: auto; max-width: 420px; ' +
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
        // Returned anchors are CHART-LOCAL; with appendToBody ECharts offsets
        // them by the chart's screen position, so the tooltip's viewport
        // position is `containerRect.{top,left} + local`. We clamp the local
        // anchor against the real VIEWPORT — `size.viewSize` is only the
        // chart's own box (~160px here), far too small to place a tall
        // multi-entity tooltip (N entities × percentile rows), which then
        // bottom-anchored and ran off the top of the page. When the popup is
        // larger than the viewport it pins to the top/left edge and scrolls
        // (max-height + overflow-y in extraCssText above).
        const [tw, th] = size.contentSize;
        const gap = 12;
        const m = 8; // keep this far clear of the viewport edges
        const r = container.value?.getBoundingClientRect();
        const rTop = r ? r.top : 0;
        const rLeft = r ? r.left : 0;
        // Prefer right-of / below the cursor; flip to the other side when
        // that edge would overflow, then clamp into the viewport.
        let left = point[0] + gap;
        if (rLeft + left + tw > window.innerWidth - m) left = point[0] - tw - gap;
        let top = point[1] + gap;
        if (rTop + top + th > window.innerHeight - m) top = point[1] - th - gap;
        const maxLeft = window.innerWidth - m - tw - rLeft;
        const maxTop = window.innerHeight - m - th - rTop;
        return {
          left: Math.max(m - rLeft, Math.min(left, maxLeft)),
          top: Math.max(m - rTop, Math.min(top, maxTop)),
        };
      },
      // Custom row layout: [dot] [name — flex, ellipsized] [value — right,
      // bold, never wraps]. The default item layout collided the value with
      // long multi-entity labels (`service · <hash>@<ip>`), pushing the value
      // onto its own line or dropping it; here the name truncates and the
      // value stays put on the same row.
      formatter(params: unknown): string {
        const arr = (Array.isArray(params) ? params : [params]) as Array<{
          axisValueLabel?: string;
          seriesName?: string;
          value?: unknown;
          color?: string;
        }>;
        const header = arr[0]?.axisValueLabel ? escHtml(arr[0].axisValueLabel) : '';
        // Fixed-layout TABLE — `table-layout:fixed` + a hard `width` is the
        // ONLY layout that deterministically pins the columns here: ECharts'
        // appendToBody tooltip box ignores `max-width`, so any auto/flex/grid
        // sizing lets the long labels balloon the box and the columns run
        // ragged. With fixed layout the column widths are frozen (dot 14 /
        // name rest / value 72) so every name ellipsizes at the SAME boundary
        // and the numbers form one clean right-aligned column. The unit is
        // shown once in the header (not repeated on 22 rows), which also keeps
        // the value column narrow and unit-agnostic (MB / calls·min / ms / %).
        const unitTag = props.unit
          ? ` <span style="opacity:0.55;font-weight:400;">${escHtml(props.unit)}</span>`
          : '';
        const rows = arr
          .map((p) => {
            const val =
              typeof p.value === 'number' && Number.isFinite(p.value) ? formatVal(p.value) : '—';
            return (
              '<tr>' +
              `<td style="width:14px;padding:2px 0;vertical-align:middle;"><span style="display:block;width:9px;height:9px;border-radius:50%;background:${p.color ?? '#888'};"></span></td>` +
              `<td style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:2px 6px 2px 0;vertical-align:middle;">${escHtml(p.seriesName ?? '')}</td>` +
              `<td style="width:72px;text-align:right;font-weight:600;white-space:nowrap;padding:2px 0;vertical-align:middle;">${escHtml(val)}</td>` +
              '</tr>'
            );
          })
          .join('');
        return (
          `<div style="font-weight:600;margin-bottom:4px;">${header}${unitTag}</div>` +
          '<table style="width:360px;table-layout:fixed;border-collapse:collapse;border-spacing:0;">' +
          `${rows}</table>`
        );
      },
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
      // hideOverlap drops any label that would collide — wide HOUR labels
      // ("07-02 05:00") otherwise overlap once the ~length/6 interval isn't
      // enough. interval stays as the density target; hideOverlap is the guard.
      axisLabel: { color: '#64748b', fontSize: 9, interval: Math.floor(length / 6), hideOverlap: true },
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
      const color = s.color
        ? cssVar(s.color)
        : i === 0
          ? accentHex
          : SECONDARY[(i - 1) % SECONDARY.length];
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
        ...(props.clickable ? { triggerLineEvent: true, cursor: 'pointer' } : {}),
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
    .map((s) => `${s.label}|${s.yAxisIndex ?? 0}|${s.unit ?? ''}|${s.color ?? ''}|${s.data.length}`)
    .join('::');
}
let prevFingerprint = '';

onMounted(() => {
  if (!container.value) return;
  chart = echarts.init(container.value, null, { renderer: 'canvas' });
  chart.setOption(buildOption());
  prevFingerprint = seriesFingerprint(props.series);
  // A line-body click may lack dataIndex/value — recover from the click pixel
  // and read the value from series data.
  chart.on('click', (p) => {
    if (!props.clickable || p.componentType !== 'series' || !chart) return;
    const si = p.seriesIndex ?? 0;
    let di = typeof p.dataIndex === 'number' ? p.dataIndex : -1;
    if (di < 0 && container.value) {
      const r = container.value.getBoundingClientRect();
      const at = chart.convertFromPixel({ gridIndex: 0 }, [
        lastPointer.value.x - r.left,
        lastPointer.value.y - r.top,
      ]);
      if (Array.isArray(at) && typeof at[0] === 'number') di = Math.round(at[0]);
    }
    const val = props.series[si]?.data[di];
    if (di < 0 || typeof val !== 'number') return;
    emit('pointClick', {
      seriesIndex: si,
      dataIndex: di,
      value: val,
      seriesName: typeof p.seriesName === 'string' ? p.seriesName : '',
      x: lastPointer.value.x,
      y: lastPointer.value.y,
    });
  });
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
watch(
  () => props.clickable,
  () => chart?.setOption(buildOption(), { replaceMerge: ['series'] }),
);
watch(
  () => props.tipSuppressed,
  (suppressed) => {
    if (!chart) return;
    if (suppressed) chart.dispatchAction({ type: 'hideTip' });
    chart.setOption({ tooltip: { show: !suppressed } });
  },
);
</script>

<template>
  <div ref="container" class="time-chart" :style="{ height: `${height}px` }" @mousedown="onPointerDown" />
</template>

<style scoped>
.time-chart {
  width: 100%;
}
</style>
