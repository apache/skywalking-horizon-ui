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
  Alarms timeline. Single line chart of "alarms-per-minute" across the
  window. Each non-zero bucket gets a pin flag with the count label so
  the operator can read intensity at a glance — empty minutes get a
  zero-baseline point but no flag (label / marker hidden).

  X axis: real epoch-ms (time type). The line steps minute-by-minute.
  Y axis: integer count.

  Interactions:
   - Click a flag                → emits `select-time-range` for that
                                   single one-minute bucket.
   - Drag a region (lineX brush) → emits `select-time-range` with
                                   `{startTime, endTime}` ms.
   - Click empty area / clear    → emits `clear-selection`.
-->
<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import * as echarts from 'echarts/core';
import { LineChart } from 'echarts/charts';
import {
  BrushComponent,
  GridComponent,
  MarkLineComponent,
  ToolboxComponent,
  TooltipComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import { readAccent } from '@/utils/cssVar';
import type { EChartsType } from 'echarts/core';
import type { AlarmMessage } from '@/api/client';

echarts.use([
  LineChart,
  BrushComponent,
  GridComponent,
  MarkLineComponent,
  ToolboxComponent,
  TooltipComponent,
  CanvasRenderer,
]);

const props = defineProps<{
  /** Alarms to bucket into per-minute counts. */
  alarms: AlarmMessage[];
  startTime: number;
  endTime: number;
  height?: number;
  /** Two-way reflection of the parent's brushed range. When `null`,
   *  the chart clears its on-screen brush rectangle programmatically
   *  — lets the parent's own "clear selection" button wipe the
   *  brush, so the operator never gets stuck with a stale band. */
  selectedRange?: { startTime: number; endTime: number } | null;
}>();

const emit = defineEmits<{
  (e: 'select-time-range', range: { startTime: number; endTime: number }): void;
  (e: 'clear-selection'): void;
}>();

const MINUTE_MS = 60_000;

/** Per-minute bucket split by event state. `firing` and `recovered`
 *  are stacked in the chart so the column height matches the total
 *  while the color breakdown surfaces the active vs cleared share. */
interface Bucket {
  ts: number;
  firing: number;
  recovered: number;
}

/* Floor a window to minute boundaries and walk every minute in
 * between, so the line has a point per minute even when the bucket
 * is empty. */
function bucketize(): Bucket[] {
  const startMin = Math.floor(props.startTime / MINUTE_MS) * MINUTE_MS;
  const endMin = Math.floor(props.endTime / MINUTE_MS) * MINUTE_MS;
  const buckets = new Map<number, Bucket>();
  for (let ts = startMin; ts <= endMin; ts += MINUTE_MS) {
    buckets.set(ts, { ts, firing: 0, recovered: 0 });
  }
  for (const a of props.alarms) {
    const bucket = Math.floor(a.startTime / MINUTE_MS) * MINUTE_MS;
    let b = buckets.get(bucket);
    if (!b) {
      b = { ts: bucket, firing: 0, recovered: 0 };
      buckets.set(bucket, b);
    }
    if (a.recoveryTime === null) b.firing += 1;
    else b.recovered += 1;
  }
  return Array.from(buckets.values()).sort((a, b) => a.ts - b.ts);
}

function formatMinute(ts: number): string {
  const d = new Date(ts);
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

const container = ref<HTMLDivElement | null>(null);
let chart: EChartsType | null = null;

function buildOption(): echarts.EChartsCoreOption {
  const buckets = bucketize();
  /* Y-axis max: echarts handles auto-scaling, but pin a floor so an
   * all-zero window doesn't collapse to a 0-height axis. */
  const maxCount = buckets.reduce((m, b) => Math.max(m, b.firing + b.recovered), 0);
  const yMax = maxCount === 0 ? 1 : undefined;

  return {
    animation: false,
    grid: { left: 32, right: 10, top: 18, bottom: 18 },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'line', lineStyle: { color: 'rgba(255,255,255,0.15)' } },
      backgroundColor: 'rgba(15,20,29,0.95)',
      borderColor: 'rgba(255,255,255,0.08)',
      textStyle: { color: '#e8ecf3', fontSize: 11 },
      extraCssText: 'box-shadow: 0 4px 16px rgba(0,0,0,0.4);',
      formatter: (params: unknown): string => {
        const arr = Array.isArray(params) ? params : [params];
        const first = arr[0] as { dataIndex?: number; data?: [number, number] };
        if (!first?.data) return '';
        const [ts] = first.data;
        const b = buckets[first.dataIndex ?? 0];
        const firing = b?.firing ?? 0;
        const recovered = b?.recovered ?? 0;
        const total = firing + recovered;
        return [
          `<div style="font-weight:600;color:${readAccent()};">${formatMinute(ts)}</div>`,
          `<div style="margin-top:4px;font-size:11px;color:var(--sw-fg-0);">${total} event${total === 1 ? '' : 's'}</div>`,
          total > 0
            ? `<div style="margin-top:2px;font-size:10.5px;">
                 <span style="color:#ef4444;">${firing} firing</span>
                 · <span style="color:#22c55e;">${recovered} recovered</span>
               </div>`
            : '',
          `<div style="margin-top:2px;font-size:10.5px;color:var(--sw-fg-3);">${
            total > 0
              ? 'click to filter to this minute · drag to select a range'
              : 'drag to select a range'
          }</div>`,
        ].join('');
      },
    },
    brush: {
      xAxisIndex: 0,
      brushType: 'lineX',
      brushMode: 'single',
      brushStyle: { color: 'rgba(226,232,240,0.10)', borderColor: 'rgba(226,232,240,0.7)' },
      transformable: false,
      throttleType: 'debounce',
      throttleDelay: 200,
    },
    xAxis: {
      type: 'time',
      min: props.startTime,
      max: props.endTime,
      axisLine: { lineStyle: { color: 'rgba(255,255,255,0.08)' } },
      axisLabel: { color: '#64748b', fontSize: 10 },
      splitLine: { show: false },
    },
    yAxis: {
      type: 'value',
      min: 0,
      max: yMax,
      minInterval: 1,
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: {
        color: '#64748b',
        fontSize: 10,
        formatter: (v: number): string => String(Math.round(v)),
      },
      splitLine: { lineStyle: { color: 'rgba(255,255,255,0.04)' } },
    },
    series: [
      /* Firing events first (bottom of the stack — red), then
       * recovered events on top (green). Stack key shared so the
       * column heights add up. Pin label shows count when non-zero,
       * with each stack contributing its own pin so the operator
       * sees the firing/recovered split at a glance. */
      {
        name: 'firing',
        type: 'line',
        stack: 'events',
        smooth: false,
        step: 'middle',
        showSymbol: true,
        symbol: (val: number[]): string => (val[1] > 0 ? 'pin' : 'none'),
        symbolSize: 16,
        lineStyle: { width: 1, color: '#ef4444' },
        itemStyle: { color: '#ef4444', borderColor: '#0f141d', borderWidth: 1 },
        areaStyle: {
          color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
            { offset: 0, color: 'rgba(239,68,68,0.34)' },
            { offset: 1, color: 'rgba(239,68,68,0)' },
          ]),
        },
        label: {
          show: true,
          position: 'inside',
          color: '#fff',
          fontSize: 10,
          fontWeight: 700,
          formatter: (p: { data?: [number, number] }): string => {
            const v = p.data?.[1] ?? 0;
            return v > 0 ? String(v) : '';
          },
        },
        emphasis: { focus: 'series' },
        data: buckets.map((b) => [b.ts, b.firing]),
        z: 3,
      },
      {
        name: 'recovered',
        type: 'line',
        stack: 'events',
        smooth: false,
        step: 'middle',
        showSymbol: true,
        symbol: (val: number[]): string => (val[1] > 0 ? 'pin' : 'none'),
        symbolSize: 16,
        lineStyle: { width: 1, color: '#22c55e' },
        itemStyle: { color: '#22c55e', borderColor: '#0f141d', borderWidth: 1 },
        areaStyle: {
          color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
            { offset: 0, color: 'rgba(34,197,94,0.32)' },
            { offset: 1, color: 'rgba(34,197,94,0)' },
          ]),
        },
        label: {
          show: true,
          position: 'inside',
          color: '#fff',
          fontSize: 10,
          fontWeight: 700,
          formatter: (p: { data?: [number, number] }): string => {
            const v = p.data?.[1] ?? 0;
            return v > 0 ? String(v) : '';
          },
        },
        emphasis: { focus: 'series' },
        data: buckets.map((b) => [b.ts, b.recovered]),
        z: 2,
      },
    ],
  };
}

function activateBrush(): void {
  /* Permanent lineX brush cursor. Without this the operator's first
   * drag silently fails (ECharts ships brush mode opt-in via a
   * toolbox icon we removed). Click events on data symbols still
   * fire — ECharts dispatches `click` before the brush sees a
   * mousedown-as-drag-start. */
  chart?.dispatchAction({
    type: 'takeGlobalCursor',
    key: 'brush',
    brushOption: { brushType: 'lineX', brushMode: 'single' },
  });
}

/** Wipe the brush rectangle from the chart. Called when the parent's
 *  selectedRange goes null (e.g. the operator hit "clear selection"
 *  in the list header). */
function clearBrush(): void {
  chart?.dispatchAction({ type: 'brush', areas: [] });
  /* `brush` with empty areas can drop the global cursor — re-arm so
   * the next drag still draws. */
  activateBrush();
}

function attach(): void {
  if (!container.value) return;
  chart = echarts.init(container.value, undefined, { renderer: 'canvas' });
  chart.setOption(buildOption());
  activateBrush();

  /* Click on either series' non-zero point → narrow the list to that
   * one minute. Click on a zero point or off-data → clear selection
   * (and the brush rectangle via the parent's prop sync). */
  chart.on('click', (params: unknown) => {
    const p = params as { seriesType?: string; data?: [number, number] };
    if (p.seriesType === 'line' && p.data) {
      const [ts, count] = p.data;
      if (count > 0) {
        emit('select-time-range', { startTime: ts, endTime: ts + MINUTE_MS - 1 });
        return;
      }
    }
    emit('clear-selection');
  });

  /* `brushEnd` is the drag-finished event — fires once per gesture
   * after mouseup, so we emit exactly one `select-time-range` per
   * drag. The "drag cleared" case (release on the same pixel) shows
   * up as a zero-width area; treat it as a clear. */
  chart.on('brushEnd', (params: unknown) => {
    const p = params as {
      areas?: Array<{ brushType: string; coordRange: [number, number] }>;
    };
    const area = p.areas?.[0];
    if (!area || area.brushType !== 'lineX') {
      emit('clear-selection');
      return;
    }
    const [a, b] = area.coordRange;
    if (a === b) {
      emit('clear-selection');
      return;
    }
    /* Snap the brushed range to whole minutes so the BFF query keys
     * + the per-minute bucket lookup line up cleanly. */
    const start = Math.floor(Math.min(a, b) / MINUTE_MS) * MINUTE_MS;
    const end = Math.ceil(Math.max(a, b) / MINUTE_MS) * MINUTE_MS - 1;
    emit('select-time-range', { startTime: start, endTime: end });
  });
}

function refresh(): void {
  if (!chart) return;
  chart.setOption(buildOption(), { replaceMerge: ['series', 'yAxis'] });
  /* `setOption` can reset the global cursor — re-arm brush so a
   * subsequent drag still works after a data refresh. */
  activateBrush();
}

onMounted(() => {
  attach();
  if (typeof window !== 'undefined') window.addEventListener('resize', resize);
});
function resize(): void {
  chart?.resize();
}
onBeforeUnmount(() => {
  if (typeof window !== 'undefined') window.removeEventListener('resize', resize);
  chart?.dispose();
  chart = null;
});

watch(
  () => [props.alarms, props.startTime, props.endTime],
  () => refresh(),
  { deep: true },
);

/** Draw the orange selection band for a range (or wipe it when null).
 *  Keeps the chart's rectangle in sync with the parent's `selectedRange`
 *  whatever the source — a drag (snaps to the whole-minute range), a flag
 *  click (a single-minute band, so the operator sees which slice is
 *  active, not just the narrowed list), or the parent's clear button. */
function drawBrush(range: { startTime: number; endTime: number } | null | undefined): void {
  if (!chart) return;
  if (range === null || range === undefined) {
    clearBrush();
    return;
  }
  chart.dispatchAction({
    type: 'brush',
    areas: [{ brushType: 'lineX', xAxisIndex: 0, coordRange: [range.startTime, range.endTime] }],
  });
}
watch(() => props.selectedRange, (next) => drawBrush(next));
</script>

<template>
  <div class="alarms-timeline-wrap">
    <div ref="container" class="alarms-timeline" :style="{ height: `${height ?? 110}px` }" />
    <!-- Legend — the stack is firing (red) on the bottom, recovered (green)
         on top; without this the colored areas / pins read ambiguously. -->
    <div class="atl-legend">
      <span class="atl-leg"><i class="atl-swatch firing" /> firing</span>
      <span class="atl-leg"><i class="atl-swatch recovered" /> recovered</span>
    </div>
  </div>
</template>

<style scoped>
.alarms-timeline-wrap { width: 100%; }
.alarms-timeline { width: 100%; }
.atl-legend {
  display: flex;
  gap: 16px;
  padding: 2px 4px 0;
  font-size: 10.5px;
  color: var(--sw-fg-3);
}
.atl-leg { display: inline-flex; align-items: center; gap: 5px; }
.atl-swatch { width: 9px; height: 9px; border-radius: 2px; display: inline-block; }
.atl-swatch.firing { background: #ef4444; }
.atl-swatch.recovered { background: #22c55e; }
</style>
