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
  Tiny inline-SVG sparkline. Designed for the per-row sparkline column on
  Overview landing cards — no ECharts dependency, no animation, no
  interactivity. The full charts/* set wraps ECharts; this one is small
  enough to skip the wrapper.

  `null` entries in `values` are rendered as gaps. When fewer than two
  finite samples are present, falls back to a single muted dot so the
  column visually communicates "data present but not enough to draw".
-->
<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';

const { t } = useI18n();

const props = withDefaults(
  defineProps<{
    values: Array<number | null>;
    width?: number;
    height?: number;
    color?: string;
    /** Stroke width in px. */
    stroke?: number;
    /**
     * When true, the SVG renders at `width: 100%` of its container
     * and `width` is used purely as the internal coordinate space
     * (paths still draw in that resolution; the rendered chart
     * stretches to fill). Use this whenever the Sparkline sits in a
     * flex/grid cell whose width is dynamic.
     */
    fluid?: boolean;
    /**
     * Shared crosshair bucket index (0..values.length-1). When set,
     * draws a vertical hairline + a dot at that bucket so two
     * sparklines in the same panel can stay synced on hover. The
     * parent owns the state; we just render the indicator and emit
     * `bucket-hover` so siblings can follow.
     */
    crosshairBucket?: number | null;
  }>(),
  {
    width: 56,
    height: 14,
    color: 'var(--sw-accent)',
    stroke: 1.25,
    fluid: false,
    crosshairBucket: null,
  },
);

const emit = defineEmits<{
  /** Mouse moved over the chart; argument is the nearest bucket
   *  index. Parent panels use it to drive a shared crosshair across
   *  sibling sparklines + a comparison tooltip. */
  (e: 'bucket-hover', bucket: number): void;
  /** Pointer left the chart. */
  (e: 'bucket-leave'): void;
}>();

function onPointerMove(ev: PointerEvent): void {
  const svg = ev.currentTarget as SVGSVGElement | null;
  if (!svg) return;
  const rect = svg.getBoundingClientRect();
  if (rect.width === 0) return;
  const x = ev.clientX - rect.left;
  const frac = Math.max(0, Math.min(1, x / rect.width));
  const n = props.values.length;
  if (n < 2) return;
  const bucket = Math.round(frac * (n - 1));
  emit('bucket-hover', bucket);
}
function onPointerLeave(): void {
  emit('bucket-leave');
}

interface PlotState {
  d: string;
  fillD: string;
  dotX: number | null;
  dotY: number | null;
  /** Actual internal-coord width the path was computed against. May
   *  differ from `props.width` in fluid mode where we scale up so
   *  high-resolution stretching looks smooth. */
  internalW: number;
  /** Per-bucket (x, y) points for the line, in internal coord space.
   *  Indexed positions match `props.values`. Null entries mark gaps. */
  points: Array<{ x: number; y: number } | null>;
  empty: boolean;
}

const plot = computed<PlotState>(() => {
  const n = props.values.length;
  if (n < 2) {
    return { d: '', fillD: '', dotX: null, dotY: null, internalW: props.width, points: [], empty: true };
  }
  let min = Infinity;
  let max = -Infinity;
  let finiteCount = 0;
  for (const v of props.values) {
    if (v === null || !Number.isFinite(v)) continue;
    finiteCount++;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (finiteCount < 2) {
    return { d: '', fillD: '', dotX: null, dotY: null, internalW: props.width, points: [], empty: true };
  }
  const range = max - min || 1;
  // Inset a half-pixel so strokes don't get clipped by the SVG edge.
  const padY = props.stroke;
  // In fluid mode the SVG stretches to its container width via
  // `preserveAspectRatio="none"`. If we kept the default 56-unit
  // internal width, the line would look blocky when n > 30 (xStep
  // < 1, segments collapsing). Bump the internal coord space to a
  // generous data-proportional value so the path is high-resolution
  // and the stretch looks smooth.
  const w = props.fluid ? Math.max(props.width, n * 12) : props.width;
  const h = props.height;
  const xStep = (w - 1) / (n - 1);

  const points: Array<{ x: number; y: number } | null> = props.values.map((v, i) => {
    if (v === null || !Number.isFinite(v)) return null;
    const norm = (v - min) / range;
    const x = 0.5 + i * xStep;
    const y = h - padY - norm * (h - padY * 2);
    return { x, y };
  });

  // Build the line path, breaking on null gaps. The fill area path
  // shadows the line and closes to the baseline.
  const dParts: string[] = [];
  const fillParts: string[] = [];
  let starting = true;
  let lastFinite: { x: number; y: number } | null = null;
  let segStart: { x: number; y: number } | null = null;
  for (const p of points) {
    if (!p) {
      // Close out any in-flight fill segment.
      if (segStart && lastFinite) {
        fillParts.push(`L ${lastFinite.x.toFixed(2)} ${(h - 0.5).toFixed(2)} L ${segStart.x.toFixed(2)} ${(h - 0.5).toFixed(2)} Z`);
      }
      starting = true;
      segStart = null;
      continue;
    }
    if (starting) {
      dParts.push(`M ${p.x.toFixed(2)} ${p.y.toFixed(2)}`);
      fillParts.push(`M ${p.x.toFixed(2)} ${(h - 0.5).toFixed(2)} L ${p.x.toFixed(2)} ${p.y.toFixed(2)}`);
      segStart = p;
      starting = false;
    } else {
      dParts.push(`L ${p.x.toFixed(2)} ${p.y.toFixed(2)}`);
      fillParts.push(`L ${p.x.toFixed(2)} ${p.y.toFixed(2)}`);
    }
    lastFinite = p;
  }
  if (segStart && lastFinite) {
    fillParts.push(`L ${lastFinite.x.toFixed(2)} ${(h - 0.5).toFixed(2)} L ${segStart.x.toFixed(2)} ${(h - 0.5).toFixed(2)} Z`);
  }

  return {
    d: dParts.join(' '),
    fillD: fillParts.join(' '),
    dotX: lastFinite?.x ?? null,
    dotY: lastFinite?.y ?? null,
    internalW: w,
    points,
    empty: false,
  };
});

/** The crosshair (x, y) on the path for `crosshairBucket`. Null when
 *  no bucket is hovered or the bucket has no data. */
const crosshairPos = computed<{ x: number; y: number } | null>(() => {
  const b = props.crosshairBucket;
  if (b === null || b === undefined) return null;
  const pt = plot.value.points[b];
  if (!pt) return null;
  return pt;
});
</script>

<template>
  <svg
    v-if="!plot.empty"
    class="sparkline"
    :width="fluid ? '100%' : width"
    :height="height"
    :viewBox="`0 0 ${plot.internalW} ${height}`"
    :preserveAspectRatio="fluid ? 'none' : 'xMidYMid meet'"
    role="img"
    :aria-label="t('trend')"
    @pointermove="onPointerMove"
    @pointerleave="onPointerLeave"
  >
    <!-- Fill area below the line. Kept faint and skipped in fluid
         mode where the line-only look reads better at chart size. -->
    <path v-if="!fluid" :d="plot.fillD" :fill="color" fill-opacity="0.12" stroke="none" />
    <path
      :d="plot.d"
      fill="none"
      :stroke="color"
      :stroke-width="stroke"
      stroke-linecap="round"
      stroke-linejoin="round"
      vector-effect="non-scaling-stroke"
    />
    <!-- End dot only on the compact (non-fluid) variant — at chart
         size it reads as an oddly thick endpoint. -->
    <circle
      v-if="!fluid && plot.dotX !== null && plot.dotY !== null"
      :cx="plot.dotX"
      :cy="plot.dotY"
      :r="stroke + 0.5"
      :fill="color"
    />
    <!-- Shared crosshair driven by the parent's hover state. The
         hairline is drawn full height; the dot marks the point on
         this series' line. Both render in non-scaling stroke so
         they stay 1px regardless of the SVG's stretch. -->
    <template v-if="crosshairPos">
      <line
        :x1="crosshairPos.x"
        :x2="crosshairPos.x"
        :y1="0"
        :y2="height"
        stroke="var(--sw-fg-3)"
        stroke-width="1"
        stroke-dasharray="2 3"
        vector-effect="non-scaling-stroke"
        pointer-events="none"
      />
      <circle
        :cx="crosshairPos.x"
        :cy="crosshairPos.y"
        r="2.6"
        :fill="color"
        stroke="var(--sw-bg-0)"
        stroke-width="1"
        vector-effect="non-scaling-stroke"
        pointer-events="none"
      />
    </template>
  </svg>
  <span
    v-else
    class="sparkline-empty"
    :style="{
      width: fluid ? '100%' : `${width}px`,
      height: `${height}px`,
    }"
  >—</span>
</template>

<style scoped>
.sparkline {
  display: inline-block;
  vertical-align: middle;
}
.sparkline-empty {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--sw-fg-3);
  font-size: 10px;
}
</style>
