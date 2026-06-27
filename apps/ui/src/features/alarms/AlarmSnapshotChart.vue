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
  Per-metric snapshot chart for the alarm detail panel.

  OAP's `AlarmSnapshot` carries the metric values from the rule's
  evaluation window at firing time — one value per MINUTE bucket. The
  snapshot DOES NOT include per-bucket timestamps, so we reconstruct
  them: the last bucket aligns to the trigger minute, prior buckets
  step back one minute each.

  Two reference markers ride on top of the line:
   - **Trigger time** — vertical solid line at `alarm.startTime`. The
     moment the rule's evaluation crossed threshold.
   - **Rule window** — when `rulePeriod` is supplied (from the admin
     `/status/alarm/{ruleId}` fetch), shade the trailing `period`
     buckets. Anything earlier is the rule's `additionalPeriod`
     padding — context only, not in the threshold check.
-->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import * as echarts from 'echarts/core';
import { LineChart } from 'echarts/charts';
import {
  GridComponent,
  MarkAreaComponent,
  MarkLineComponent,
  TooltipComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { EChartsType } from 'echarts/core';
import type { AlarmMqeMetric } from '@/api/client';
import { readAccent } from '@/utils/cssVar';

echarts.use([
  LineChart,
  GridComponent,
  MarkLineComponent,
  MarkAreaComponent,
  TooltipComponent,
  CanvasRenderer,
]);

const props = withDefaults(
  defineProps<{
    metric: AlarmMqeMetric;
    /** Alarm fire time, ms epoch. Reconstructs bucket timestamps and
     *  anchors the trigger marker. */
    triggerTime: number;
    /** Alarm recovery time, ms epoch, or null when the alarm is
     *  still firing. When present, a green vertical line marks the
     *  moment OAP cleared the alarm (after `recoveryObservationPeriod`
     *  of clean buckets). */
    recoveryTime?: number | null;
    /** Rule's `period` (MINUTE buckets in the evaluation window).
     *  When known, the trailing `period` buckets get a soft band so
     *  the operator sees which slice was actually compared against
     *  the threshold. */
    rulePeriod?: number | null;
    height?: number;
  }>(),
  {
    height: 120,
    recoveryTime: null,
    rulePeriod: null,
  },
);

const MINUTE_MS = 60_000;

/** Series palette. First entry tracks the active theme's `--sw-accent`
 *  so the dominant series re-colors with the theme; the remaining
 *  entries are intentionally varied for service-distinguishing. They
 *  stay constant across themes because their job is "be a distinct
 *  color," not "match brand". */
function buildPalette(): string[] {
  return [
    readAccent('#f97316'),
    '#60a5fa',
    '#a78bfa',
    '#22d3ee',
    '#34d399',
    '#f472b6',
  ];
}

interface SeriesIn {
  label: string;
  data: Array<[number, number | null]>;
}

function buildSeries(): { series: SeriesIn[]; bucketCount: number; latestMinute: number } {
  const results = props.metric.results;
  const bucketCount = Math.max(...results.map((r) => r.values.length), 0);
  /* `T` — the latest value's minute. The trigger's own minute IS the
   * last bucket in the snapshot (OAP records the latest bucket value
   * as part of the evaluation that fires the alarm). Earlier
   * buckets step back one minute each from T. */
  const latestMinute = Math.floor(props.triggerTime / MINUTE_MS) * MINUTE_MS;
  const startMin = latestMinute - (bucketCount - 1) * MINUTE_MS;
  const series: SeriesIn[] = results.map((r, i) => {
    const labels = (r.metric?.labels ?? []).map((l) => `${l.key}=${l.value}`).join(',');
    const data: Array<[number, number | null]> = r.values.map((v, j) => {
      const ts = startMin + j * MINUTE_MS;
      if (v.value === null) return [ts, null];
      const n = Number(v.value);
      return [ts, Number.isFinite(n) ? n : null];
    });
    return { label: labels.length > 0 ? labels : `series ${i + 1}`, data };
  });
  return { series, bucketCount, latestMinute };
}

function fmtMinute(ts: number): string {
  const d = new Date(ts);
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

/** Caption above the canvas — mirrors what the shaded band represents
 *  (rule period when admin supplied it, else the full snapshot). */
const windowCaption = computed<string>(() => {
  const bucketCount = Math.max(
    ...props.metric.results.map((r) => r.values.length),
    0,
  );
  if (bucketCount === 0) return '';
  const haveRulePeriod = !!(
    props.rulePeriod && props.rulePeriod > 0 && props.rulePeriod <= bucketCount
  );
  const minutes = haveRulePeriod ? props.rulePeriod! : bucketCount;
  return haveRulePeriod
    ? `rule window · ${minutes}m`
    : `snapshot window · ${minutes}m`;
});

function buildOption(): echarts.EChartsCoreOption {
  const { series, bucketCount, latestMinute } = buildSeries();
  const startMin = latestMinute - (bucketCount - 1) * MINUTE_MS;
  /* X-axis padding — half a minute on each side so the first / last
   * dots aren't flush against the axis edges. Right side extends
   * past whichever event sits latest (trigger or recovery), so
   * neither marker spills off the plot. */
  const xMin = startMin - MINUTE_MS / 2;
  const rightAnchor = Math.max(
    latestMinute,
    props.triggerTime,
    props.recoveryTime ?? 0,
  );
  const xMax = rightAnchor + MINUTE_MS;

  /* Always shade the evaluated window so the operator sees the time
   * range that informed the alarm. When the admin-server fetch gave
   * us the rule's `period`, shade exactly that many trailing buckets
   * (the slice the rule compared against its threshold). When it
   * didn't (admin unreachable / legacy OAP / rule not matched), fall
   * back to the full snapshot — every bucket OAP captured. The
   * label reflects which mode is in effect.
   *
   * Span: `[T - window, T]` — anchored to the latest-bucket minute
   * `T` and walking back `window` minutes. The band ends at T
   * exactly so the trigger marker (at triggerTime, slightly past T)
   * sits visibly OUTSIDE the band — the operator reads "data inside
   * the band, fire moment right after". */
  const haveRulePeriod = !!(
    props.rulePeriod && props.rulePeriod > 0 && props.rulePeriod <= bucketCount
  );
  const windowMinutes = haveRulePeriod ? props.rulePeriod! : bucketCount;
  const winStart = latestMinute - windowMinutes * MINUTE_MS;
  const winEnd = latestMinute;
  const markArea = {
    silent: true,
    itemStyle: {
      color: 'rgba(249,115,22,0.14)',
      borderColor: 'rgba(249,115,22,0.5)',
      borderWidth: 1,
      borderType: 'dashed',
    },
    /* Label is rendered OUTSIDE the chart canvas (see the caption
     * above the container in the template) so it doesn't crowd the
     * y-axis labels or sit on top of data lines. The markArea only
     * paints the shaded region itself. */
    label: { show: false },
    data: [[{ xAxis: winStart }, { xAxis: winEnd }]],
  };

  return {
    animation: false,
    backgroundColor: 'transparent',
    grid: { left: 36, right: 8, top: 18, bottom: 22 },
    tooltip: {
      trigger: 'axis',
      backgroundColor: 'rgba(20,20,24,0.92)',
      borderColor: 'rgba(255,255,255,0.08)',
      textStyle: { color: '#e5e7eb', fontSize: 11 },
      valueFormatter: (v: unknown) =>
        typeof v === 'number' && Number.isFinite(v) ? v.toFixed(2) : '—',
    },
    xAxis: {
      type: 'time',
      min: xMin,
      max: xMax,
      axisLine: { lineStyle: { color: 'rgba(255,255,255,0.08)' } },
      axisLabel: {
        color: '#64748b',
        fontSize: 9,
        hideOverlap: true,
        formatter: (ts: number) => fmtMinute(ts),
      },
      splitLine: { show: false },
    },
    yAxis: {
      type: 'value',
      axisLine: { show: false },
      axisLabel: { color: '#64748b', fontSize: 9 },
      splitLine: { lineStyle: { color: 'rgba(255,255,255,0.06)' } },
    },
    series: series.map((s, i) => {
      const palette = buildPalette();
      const color = palette[i % palette.length];
      const isOnly = series.length === 1;
      return {
        name: s.label,
        type: 'line',
        smooth: true,
        symbol: 'circle',
        symbolSize: 4,
        showSymbol: true,
        lineStyle: { width: 1.5, color },
        itemStyle: { color, borderColor: color, borderWidth: 1 },
        data: s.data.map(([ts, v]) => [ts, v === null ? '-' : v]),
        areaStyle: isOnly ? { color, opacity: 0.1 } : undefined,
        /* Trigger marker + window band ride on the first series only.
         * ECharts collapses markLines / markAreas across series, so
         * declaring them once on series[0] avoids duplicate rendering.
         * The recovery marker (green) is added as a second markLine
         * entry only when the alarm has actually recovered. */
        ...(i === 0
          ? {
              markLine: {
                silent: true,
                symbol: 'none',
                /* Per-line style — orange for trigger, green for
                 * recovered. ECharts reads `lineStyle` on each datum
                 * when present; the series-level lineStyle is the
                 * fallback for the trigger line. */
                lineStyle: { color: 'rgba(249,115,22,0.95)', width: 1.5, type: 'solid' },
                label: {
                  show: true,
                  position: 'insideEndTop',
                  fontSize: 10,
                  fontWeight: 600,
                },
                data: [
                  {
                    xAxis: props.triggerTime,
                    label: {
                      color: readAccent(),
                      formatter: `trigger ${fmtMinute(props.triggerTime)}`,
                    },
                  },
                  ...(props.recoveryTime !== null && props.recoveryTime !== undefined
                    ? [
                        {
                          xAxis: props.recoveryTime,
                          lineStyle: { color: 'rgba(34,197,94,0.95)', width: 1.5, type: 'solid' },
                          label: {
                            color: '#22c55e',
                            position: 'insideStartTop',
                            formatter: `recovered ${fmtMinute(props.recoveryTime)}`,
                          },
                        },
                      ]
                    : []),
                ],
              },
              markArea,
            }
          : {}),
      };
    }),
  };
}

const container = ref<HTMLDivElement | null>(null);
let chart: EChartsType | null = null;

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
  () => [props.metric, props.triggerTime, props.recoveryTime, props.rulePeriod],
  () => {
    if (!chart) return;
    chart.setOption(buildOption(), { replaceMerge: ['series', 'xAxis', 'yAxis'] });
  },
  { deep: true },
);
</script>

<template>
  <div class="alarm-snapshot-wrap">
    <div v-if="windowCaption" class="alarm-snapshot__caption">{{ windowCaption }}</div>
    <div ref="container" class="alarm-snapshot" :style="{ height: `${height}px` }" />
  </div>
</template>

<style scoped>
.alarm-snapshot-wrap {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.alarm-snapshot__caption {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--sw-accent);
  font-weight: 600;
}
.alarm-snapshot {
  width: 100%;
}
</style>
