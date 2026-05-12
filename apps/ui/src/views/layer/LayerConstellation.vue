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
  Polar service-constellation plot. Each service is a dot; angle is
  determined by position in the list, radius by log(traffic), color +
  halo by error band.

  Hand-rolled SVG rather than ECharts — the chart shape is bespoke
  (radial-spokes + concentric-rings + log-scaled radius + error-band
  coloring) and fitting it through ECharts' polar API costs more than
  it saves. The component is small and disposes cleanly.
-->
<script setup lang="ts">
import { computed } from 'vue';
import type { LandingServiceRow } from '@skywalking-horizon-ui/api-client';

const props = withDefaults(
  defineProps<{
    services: ReadonlyArray<LandingServiceRow>;
    /** Metric key the radius is computed from (typically `cpm`). */
    trafficMetric: string;
    /** Metric key the error band is computed from (typically `err`). */
    errorMetric?: string;
    /** Error-band cutoffs: anything > warnAt is "warn", > errAt is "err". */
    warnAt?: number;
    errAt?: number;
    /** SVG viewBox edge in px. */
    size?: number;
  }>(),
  {
    errorMetric: 'err',
    warnAt: 0.5,
    errAt: 1,
    size: 400,
  },
);
const emit = defineEmits<{ (e: 'pick', s: LandingServiceRow): void }>();

/**
 * Build per-service plot rows. Skips services with no traffic value —
 * they can't be placed on a log radius. The angle is uniform (`i / N *
 * 2π`) so the visual emphasis is on the cluster, not on ordering.
 */
const dots = computed(() => {
  const N = props.services.length;
  if (N === 0) return [];
  const traffic = props.services.map((s) => s.metrics[props.trafficMetric] ?? null);
  const maxT = Math.max(...traffic.filter((v): v is number => v !== null && v > 0), 1);
  const cx = props.size / 2;
  const cy = props.size / 2;
  const rMax = props.size * 0.4;
  const rMin = props.size * 0.075;
  return props.services.map((s, i) => {
    const t = traffic[i] ?? 0;
    const radius =
      t > 0 ? rMin + (Math.log10(Math.max(1, t)) / Math.log10(Math.max(2, maxT))) * (rMax - rMin) : rMin;
    const angle = -Math.PI / 2 + (i / N) * Math.PI * 2;
    const err = s.metrics[props.errorMetric] ?? null;
    const status: 'ok' | 'warn' | 'err' =
      err !== null && err > props.errAt
        ? 'err'
        : err !== null && err > props.warnAt
          ? 'warn'
          : 'ok';
    return {
      ...s,
      angle,
      radius,
      x: cx + Math.cos(angle) * radius,
      y: cy + Math.sin(angle) * radius,
      traffic: t,
      err,
      status,
      // Halo size correlates with log(traffic) so high-traffic services
      // visually dominate.
      halo: 4 + (t > 0 ? Math.log10(Math.max(1, t)) : 0) * 1.4,
    };
  });
});

const rings = computed(() => {
  const cx = props.size / 2;
  const cy = props.size / 2;
  const rMax = props.size * 0.4;
  // Decade markers between 1 and 1M-ish — labels are drawn separately.
  return [0.25, 0.5, 0.75, 1].map((f) => ({ cx, cy, r: rMax * f }));
});
const counts = computed(() => {
  const out = { ok: 0, warn: 0, err: 0 };
  for (const d of dots.value) out[d.status]++;
  return out;
});

const center = computed(() => ({ x: props.size / 2, y: props.size / 2 }));
function colorFor(status: 'ok' | 'warn' | 'err'): string {
  return status === 'err' ? 'var(--sw-err)' : status === 'warn' ? 'var(--sw-warn)' : 'var(--sw-ok)';
}

function textAnchorFor(angle: number): 'start' | 'end' | 'middle' {
  const c = Math.cos(angle);
  if (c > 0.3) return 'start';
  if (c < -0.3) return 'end';
  return 'middle';
}
</script>

<template>
  <div class="constellation">
    <svg :viewBox="`0 0 ${size} ${size}`" :width="size" :height="size" role="img" aria-label="Service constellation">
      <!-- concentric rings -->
      <circle
        v-for="(r, i) in rings"
        :key="`r-${i}`"
        :cx="r.cx"
        :cy="r.cy"
        :r="r.r"
        fill="none"
        stroke="var(--sw-line)"
        stroke-dasharray="3 4"
      />
      <!-- radial spokes -->
      <line
        v-for="(d, i) in dots"
        :key="`s-${i}`"
        :x1="center.x"
        :y1="center.y"
        :x2="center.x + Math.cos(d.angle) * (size * 0.42)"
        :y2="center.y + Math.sin(d.angle) * (size * 0.42)"
        stroke="var(--sw-line)"
        stroke-width="0.4"
        opacity="0.6"
      />
      <!-- dots -->
      <g v-for="(d, i) in dots" :key="`d-${i}`" class="dot-group" @click="emit('pick', d)">
        <title>{{ d.serviceName }} · traffic {{ d.traffic.toFixed(1) }}{{ d.err !== null ? ` · err ${d.err.toFixed(2)}` : '' }}</title>
        <circle :cx="d.x" :cy="d.y" :r="d.halo" :fill="colorFor(d.status)" opacity="0.22" />
        <circle :cx="d.x" :cy="d.y" :r="3.5" :fill="colorFor(d.status)" />
        <text
          :x="d.x + Math.cos(d.angle) * 14"
          :y="d.y + Math.sin(d.angle) * 14 + 3"
          font-size="8.5"
          :text-anchor="textAnchorFor(d.angle)"
          fill="var(--sw-fg-1)"
          class="label"
        >
          {{ d.shortName || d.serviceName }}
        </text>
      </g>
      <!-- center label -->
      <text :x="center.x" :y="center.y - 4" text-anchor="middle" font-size="12" font-weight="700" fill="var(--sw-fg-0)">
        {{ dots.length }}
      </text>
      <text :x="center.x" :y="center.y + 9" text-anchor="middle" font-size="8" fill="var(--sw-fg-3)">
        services
      </text>
    </svg>

    <aside class="legend">
      <div class="legend-row">
        <span class="swatch ok" />
        <span class="legend-label">healthy</span>
        <span class="legend-count">{{ counts.ok }}</span>
      </div>
      <div class="legend-row">
        <span class="swatch warn" />
        <span class="legend-label">warn</span>
        <span class="legend-count">{{ counts.warn }}</span>
      </div>
      <div class="legend-row">
        <span class="swatch err" />
        <span class="legend-label">error</span>
        <span class="legend-count">{{ counts.err }}</span>
      </div>
      <div class="sep" />
      <p class="hint">
        Angle = service order. Radius = log of <code>{{ trafficMetric }}</code>. Halo grows with traffic.
        Color reflects <code>{{ errorMetric }}</code> band.
      </p>
    </aside>
  </div>
</template>

<style scoped>
.constellation {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 14px;
  align-items: center;
}
svg {
  width: 100%;
  height: auto;
  max-width: 360px;
  margin: 0 auto;
  display: block;
}
.dot-group {
  cursor: pointer;
}
.dot-group:hover .label {
  fill: var(--sw-fg-0);
  font-weight: 600;
}
.legend {
  display: grid;
  grid-auto-rows: min-content;
  gap: 6px;
  font-size: 10.5px;
  align-self: start;
  padding-top: 6px;
}
.legend-row {
  display: flex;
  align-items: center;
  gap: 6px;
}
.swatch {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}
.swatch.ok {
  background: var(--sw-ok);
}
.swatch.warn {
  background: var(--sw-warn);
}
.swatch.err {
  background: var(--sw-err);
}
.legend-label {
  color: var(--sw-fg-2);
  width: 50px;
}
.legend-count {
  font-family: var(--sw-mono);
  color: var(--sw-fg-0);
  font-variant-numeric: tabular-nums;
}
.sep {
  height: 1px;
  background: var(--sw-line);
  margin: 2px 0;
}
.hint {
  margin: 0;
  font-size: 9.5px;
  color: var(--sw-fg-3);
  line-height: 1.4;
  max-width: 130px;
}
.hint code {
  font-family: var(--sw-mono);
  font-size: 9px;
  color: var(--sw-fg-2);
  background: var(--sw-bg-2);
  padding: 0 3px;
  border-radius: 2px;
}
</style>
