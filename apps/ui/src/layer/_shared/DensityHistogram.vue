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
  Feature-agnostic density histogram — Loki/Datadog style. `bins` stacked
  bars on top (color per category lane), a custom hover tooltip (NOT the
  native `title`: the `?` help-cursor it forced read like a UI bug), and a
  5-tick x-axis time strip underneath. The host feeds the binned data (see
  `useDensityBins`), the ordered keys + a color map; binning + querying stay
  outside. Reused by both the Logs (level) and Browser Logs (category) tabs.

  The tooltip's "total" line is a slot (`#tipTotal`, scoped with `{ total }`)
  so each host owns its own wording / i18n; the default slot renders the
  Logs phrasing (`N log(s)`).
-->
<script setup lang="ts" generic="K extends string">
import { ref } from 'vue';
import type { DensityBins } from '@/layer/_shared/useDensityBins';

const props = defineProps<{
  data: DensityBins<K>;
  keys: readonly K[];
  colors: Record<K, string>;
  labelCase?: 'capitalize' | 'uppercase';
}>();

const hoveredBin = ref<number | null>(null);

function binTotal(b: Record<K, number>): number {
  let t = 0;
  for (const k of props.keys) t += b[k];
  return t;
}

const pad = (n: number): string => String(n).padStart(2, '0');

function fmtBucketRange(idx: number, t0: number, t1: number): string {
  if (!t0 || !t1) return '';
  const span = (t1 - t0) || 1;
  const start = new Date(t0 + (span * idx) / props.data.bins.length);
  const end = new Date(t0 + (span * (idx + 1)) / props.data.bins.length);
  const fmt = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  return `${fmt(start)} – ${fmt(end)}`;
}

function fmtAxisTime(ts: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
</script>

<template>
  <div class="lg-density-wrap" v-if="data.bins.length > 0" @mouseleave="hoveredBin = null">
    <div class="lg-density">
      <div
        v-for="(bin, i) in data.bins"
        :key="i"
        class="lg-density-bin"
        @mouseenter="hoveredBin = i"
      >
        <span
          v-for="k in keys"
          :key="k"
          class="lg-density-segment"
          :style="{
            background: colors[k],
            height: data.max ? (bin[k] / data.max * 100) + '%' : '0%',
          }"
        />
      </div>
      <div
        v-if="hoveredBin !== null"
        class="lg-density-tip"
        :style="{ left: ((hoveredBin + 0.5) / data.bins.length) * 100 + '%' }"
      >
        <div class="lg-density-tip-time">
          {{ fmtBucketRange(hoveredBin, data.t0, data.t1) }}
        </div>
        <div class="lg-density-tip-total">
          <slot name="tipTotal" :total="binTotal(data.bins[hoveredBin])">
            {{ binTotal(data.bins[hoveredBin]) }} log<template v-if="binTotal(data.bins[hoveredBin]) !== 1">s</template>
          </slot>
        </div>
        <div class="lg-density-tip-rows">
          <span v-for="k in keys" :key="k" v-show="data.bins[hoveredBin][k] > 0" class="lg-density-tip-row">
            <span class="lvl-dot" :style="{ background: colors[k] }" />
            <span class="lg-density-tip-name" :class="{ upper: props.labelCase === 'uppercase' }">{{ k }}</span>
            <span class="lg-density-tip-val mono">{{ data.bins[hoveredBin][k] }}</span>
          </span>
        </div>
      </div>
    </div>
    <div class="lg-density-axis">
      <span class="t-tick">{{ fmtAxisTime(data.t0) }}</span>
      <span class="t-tick">{{ fmtAxisTime(data.t0 + (data.t1 - data.t0) * 0.25) }}</span>
      <span class="t-tick">{{ fmtAxisTime(data.t0 + (data.t1 - data.t0) * 0.5) }}</span>
      <span class="t-tick">{{ fmtAxisTime(data.t0 + (data.t1 - data.t0) * 0.75) }}</span>
      <span class="t-tick">{{ fmtAxisTime(data.t1) }}</span>
    </div>
  </div>
</template>

<style scoped>
.lg-density-wrap {
  padding: 8px 12px 4px;
  border-bottom: 1px solid var(--sw-line);
  background: var(--sw-bg-1);
}
.lg-density {
  display: grid;
  grid-template-columns: repeat(60, 1fr);
  align-items: end;
  gap: 1px;
  height: 60px;
  position: relative;
}
.lg-density-bin {
  display: flex;
  flex-direction: column-reverse;
  height: 100%;
  background: var(--sw-bg-2);
  border-radius: 1px;
  overflow: hidden;
  /* No `cursor: help` — the `?` cursor was misread as a UI error.
     The bin reads as informational (hover surfaces a count tooltip),
     so a default pointer is the right affordance. */
}
.lg-density-bin:hover { outline: 1px solid var(--sw-accent-line); }
.lg-density-segment { display: block; }
.lg-density-tip {
  position: absolute;
  bottom: calc(100% + 6px);
  transform: translateX(-50%);
  min-width: 160px;
  padding: 6px 9px;
  background: var(--sw-bg-0);
  border: 1px solid var(--sw-line-2);
  border-radius: 4px;
  box-shadow: 0 8px 20px rgba(0,0,0,0.45);
  font-size: 11px;
  color: var(--sw-fg-1);
  pointer-events: none;
  z-index: 5;
}
.lg-density-tip-time { color: var(--sw-fg-3); font-family: var(--sw-mono); font-size: 10px; margin-bottom: 2px; }
.lg-density-tip-total { color: var(--sw-fg-0); font-weight: 700; font-size: 12px; margin-bottom: 4px; }
.lg-density-tip-rows { display: flex; flex-direction: column; gap: 2px; }
.lg-density-tip-row { display: inline-flex; align-items: center; gap: 6px; font-size: 10.5px; }
.lg-density-tip-row .lvl-dot { width: 7px; height: 7px; border-radius: 50%; flex: 0 0 7px; }
.lg-density-tip-name { color: var(--sw-fg-2); flex: 1; text-transform: capitalize; }
.lg-density-tip-name.upper { text-transform: uppercase; letter-spacing: 0.04em; }
.lg-density-tip-val { color: var(--sw-fg-0); font-weight: 600; font-variant-numeric: tabular-nums; }
.lg-density-axis {
  display: flex;
  justify-content: space-between;
  font-family: var(--sw-mono);
  font-size: 9.5px;
  color: var(--sw-fg-3);
  font-variant-numeric: tabular-nums;
  margin-top: 4px;
  padding: 0 2px;
}
.lg-density-axis .t-tick:first-child { text-align: left; }
.lg-density-axis .t-tick:last-child { text-align: right; }
.lvl-dot {
  width: 8px;
  height: 8px;
  border-radius: 2px;
  flex: 0 0 auto;
}
.mono { font-family: var(--sw-mono); }
</style>
