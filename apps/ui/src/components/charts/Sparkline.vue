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

const props = withDefaults(
  defineProps<{
    values: Array<number | null>;
    width?: number;
    height?: number;
    color?: string;
    /** Stroke width in px. */
    stroke?: number;
  }>(),
  {
    width: 56,
    height: 14,
    color: 'var(--sw-accent)',
    stroke: 1.25,
  },
);

interface PlotState {
  d: string;
  fillD: string;
  dotX: number | null;
  dotY: number | null;
  empty: boolean;
}

const plot = computed<PlotState>(() => {
  const n = props.values.length;
  if (n < 2) {
    return { d: '', fillD: '', dotX: null, dotY: null, empty: true };
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
    return { d: '', fillD: '', dotX: null, dotY: null, empty: true };
  }
  const range = max - min || 1;
  // Inset a half-pixel so strokes don't get clipped by the SVG edge.
  const padY = props.stroke;
  const w = props.width;
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
    empty: false,
  };
});
</script>

<template>
  <svg
    v-if="!plot.empty"
    class="sparkline"
    :width="width"
    :height="height"
    :viewBox="`0 0 ${width} ${height}`"
    role="img"
    aria-label="trend"
  >
    <path :d="plot.fillD" :fill="color" fill-opacity="0.12" stroke="none" />
    <path
      :d="plot.d"
      fill="none"
      :stroke="color"
      :stroke-width="stroke"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
    <circle
      v-if="plot.dotX !== null && plot.dotY !== null"
      :cx="plot.dotX"
      :cy="plot.dotY"
      :r="stroke + 0.5"
      :fill="color"
    />
  </svg>
  <span v-else class="sparkline-empty" :style="{ width: `${width}px`, height: `${height}px` }">—</span>
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
