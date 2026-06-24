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
  Shared trace duration-distribution scatter. The single dot-plot used by
  BOTH the per-layer Traces tab and the cross-layer Trace inspect view:
  X is the trace start time, Y the trace duration. The Y axis is omitted —
  the duration is surfaced on the dot's tooltip and the list-row bar below.

  Two operator gestures, both emitted upward so the host decides the
  effect:
    - Click a dot   → `select(row)`. (Traces tab toggles its in-page pick
      filter; Trace inspect opens the trace detail.)
    - Drag a region → `brush(keys)` with every row.key whose dot falls in
      the rectangle. (Traces tab merges them into the pick set; hosts that
      don't filter in-page simply ignore it.)

  Presentational only: no selection / filter state lives here. `selectedKey`
  (the host's active/picked row) drives the highlighted dot rendering; the
  host owns the truth.
-->
<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { NativeTraceListRow } from '@/api/client';
import { fmtMetric } from '@/utils/formatters';

const { t } = useI18n({ useScope: 'global' });

const props = withDefaults(
  defineProps<{
    rows: NativeTraceListRow[];
    maxDuration: number;
    /** The host's active/picked row key. Renders the matching dot enlarged
     *  + outlined; null dims nothing. */
    selectedKey: string | null;
    /** Optional multi-highlight set (the Traces tab's in-page pick set).
     *  Every dot whose key is here renders enlarged + outlined, and the
     *  rest dim — the brush picks more than one trace at a time. When
     *  empty the `selectedKey` single-highlight applies instead. */
    highlightKeys?: string[];
  }>(),
  { highlightKeys: () => [] },
);
const emit = defineEmits<{
  (e: 'select', row: NativeTraceListRow): void;
  (e: 'brush', keys: string[]): void;
}>();

const highlightSet = computed(() => new Set(props.highlightKeys));
/** A dot is highlighted when it's the single `selectedKey` or a member of
 *  the multi-highlight set. */
function isHot(rowKey: string): boolean {
  return props.selectedKey === rowKey || highlightSet.value.has(rowKey);
}
/** True when something is highlighted (single or set) — non-hot dots dim. */
const hasHot = computed(() => props.selectedKey !== null || highlightSet.value.size > 0);

function fmtMs(v: number | null | undefined): string {
  if (v === null || v === undefined) return '—';
  return `${fmtMetric(v)} ms`;
}
function parseNativeStart(v: string): number {
  const n = Number(v);
  if (Number.isFinite(n) && n > 0) return n;
  const ts = Date.parse(v);
  return Number.isFinite(ts) ? ts : 0;
}

interface ScatterPoint { id: string; rowKey: string; x: number; y: number; isError: boolean; label: string; row: NativeTraceListRow; }
const scatterPoints = computed<ScatterPoint[]>(() => {
  const out: ScatterPoint[] = [];
  for (const tr of props.rows) {
    const ts = parseNativeStart(tr.start);
    out.push({
      id: tr.key,
      rowKey: tr.key,
      x: ts,
      y: tr.duration,
      isError: tr.isError,
      label: tr.endpointNames[0] ?? '—',
      row: tr,
    });
  }
  return out;
});
const scatterBounds = computed(() => {
  const pts = scatterPoints.value.filter((p) => p.x > 0 && Number.isFinite(p.y));
  if (pts.length === 0) return null;
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const rawYMax = Math.max(...ys, 1);
  const yMax = rawYMax || 1;
  return { xMin: Math.min(...xs), xMax: Math.max(...xs), yMin: 0, yMax };
});
// Pre-place each point in viewBox space so the template (and its
// transparent hit-target) share one cx/cy instead of recomputing it.
const placedPoints = computed(() => {
  const b = scatterBounds.value;
  if (!b) return [];
  const xSpan = b.xMax - b.xMin;
  return scatterPoints.value.map((p) => ({
    ...p,
    cx: xSpan === 0 ? 500 : ((p.x - b.xMin) / xSpan) * 1000,
    cy: 1000 - ((p.y - b.yMin) / (b.yMax - b.yMin || 1)) * 990,
  }));
});
const scatterXTicks = computed(() => {
  const b = scatterBounds.value;
  if (!b) return [];
  const xCount = 3;
  const span = Math.max(1, b.xMax - b.xMin);
  return Array.from({ length: xCount }, (_, i) => {
    const at = b.xMin + (span * i) / (xCount - 1);
    const d = new Date(at);
    const pad = (n: number) => String(n).padStart(2, '0');
    return { frac: i / (xCount - 1), label: `${pad(d.getHours())}:${pad(d.getMinutes())}` };
  });
});

// Drag-to-select state. Coords are SVG-space (viewBox 0..1000 in x,
// 1000..0 in y). The drag rect renders while pointer is down.
const scatterSvgRef = ref<SVGSVGElement | null>(null);
const dragState = ref<{
  active: boolean;
  pending: boolean;
  startVx: number; startVy: number; curVx: number; curVy: number;
}>({ active: false, pending: false, startVx: 0, startVy: 0, curVx: 0, curVy: 0 });
function clientToViewbox(ev: PointerEvent): { vx: number; vy: number } | null {
  const svg = scatterSvgRef.value;
  if (!svg) return null;
  const rect = svg.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return null;
  const vx = ((ev.clientX - rect.left) / rect.width) * 1000;
  const vy = ((ev.clientY - rect.top) / rect.height) * 1000;
  return { vx, vy };
}
// Set when a brush drag completes, so the click the browser synthesizes after
// pointerup — landing on the same fat hit-circle — doesn't ALSO open a trace
// detail. Cleared at the start of the next gesture.
let justBrushed = false;
function onScatterDown(ev: PointerEvent): void {
  justBrushed = false;
  const pt = clientToViewbox(ev);
  if (!pt) return;
  // Record a potential drag; do NOT preventDefault yet, so a plain click on
  // a dot still fires its @click. The brush activates only once the pointer
  // actually moves (onScatterMove) — the fat hit-circles otherwise swallow
  // the drag-start.
  dragState.value = { active: false, pending: true, startVx: pt.vx, startVy: pt.vy, curVx: pt.vx, curVy: pt.vy };
}
function onScatterMove(ev: PointerEvent): void {
  const s = dragState.value;
  if (!s.pending && !s.active) return;
  const pt = clientToViewbox(ev);
  if (!pt) return;
  if (!s.active) {
    if (Math.abs(pt.vx - s.startVx) < 6 && Math.abs(pt.vy - s.startVy) < 6) {
      dragState.value = { ...s, curVx: pt.vx, curVy: pt.vy };
      return;
    }
    ev.preventDefault();
    try { (ev.currentTarget as SVGSVGElement).setPointerCapture(ev.pointerId); } catch { /* noop */ }
    dragState.value = { ...s, active: true, curVx: pt.vx, curVy: pt.vy };
    return;
  }
  dragState.value = { ...s, curVx: pt.vx, curVy: pt.vy };
}
function onScatterUp(ev: PointerEvent): void {
  const s = dragState.value;
  const wasActive = s.active;
  dragState.value = { active: false, pending: false, startVx: 0, startVy: 0, curVx: 0, curVy: 0 };
  if (!wasActive) return;
  justBrushed = true;
  try { (ev.currentTarget as SVGSVGElement).releasePointerCapture(ev.pointerId); } catch { /* noop */ }
  const { startVx, startVy, curVx, curVy } = s;
  const b = scatterBounds.value;
  if (!b) return;
  const vxMin = Math.min(startVx, curVx);
  const vxMax = Math.max(startVx, curVx);
  const vyMin = Math.min(startVy, curVy);
  const vyMax = Math.max(startVy, curVy);
  const keys: string[] = [];
  for (const p of scatterPoints.value) {
    const cx = b.xMax === b.xMin ? 500 : ((p.x - b.xMin) / (b.xMax - b.xMin)) * 1000;
    const cy = 1000 - ((p.y - b.yMin) / (b.yMax - b.yMin || 1)) * 990;
    if (cx >= vxMin && cx <= vxMax && cy >= vyMin && cy <= vyMax) keys.push(p.rowKey);
  }
  if (keys.length > 0) emit('brush', keys);
}
const dragRect = computed(() => {
  const s = dragState.value;
  if (!s.active) return null;
  return {
    x: Math.min(s.startVx, s.curVx),
    y: Math.min(s.startVy, s.curVy),
    w: Math.abs(s.curVx - s.startVx),
    h: Math.abs(s.curVy - s.startVy),
  };
});
function onScatterDot(p: ScatterPoint, ev: MouseEvent): void {
  ev.stopPropagation();
  if (justBrushed) return;
  emit('select', p.row);
}
</script>

<template>
  <div v-if="scatterPoints.length > 0 && scatterBounds" class="scatter-wrap">
    <svg
      ref="scatterSvgRef"
      class="scatter-svg"
      viewBox="0 0 1000 1000"
      preserveAspectRatio="none"
      @pointerdown="onScatterDown"
      @pointermove="onScatterMove"
      @pointerup="onScatterUp"
      @pointercancel="onScatterUp"
    >
      <line x1="0" y1="998" x2="1000" y2="998" stroke="var(--sw-line-2)" stroke-width="1" vector-effect="non-scaling-stroke" />
      <g v-for="p in placedPoints" :key="p.id">
        <circle
          :cx="p.cx"
          :cy="p.cy"
          :r="isHot(p.rowKey) ? 6 : 3.2"
          :fill="p.isError ? 'var(--sw-err)' : 'var(--sw-accent)'"
          :fill-opacity="isHot(p.rowKey) ? 1 : (hasHot ? 0.35 : 0.9)"
          :stroke="isHot(p.rowKey) ? 'var(--sw-fg-0)' : (p.isError ? 'var(--sw-err)' : 'var(--sw-accent-2)')"
          :stroke-width="isHot(p.rowKey) ? 1.8 : 0.8"
          vector-effect="non-scaling-stroke"
          pointer-events="none"
        />
        <!-- A fat transparent hit-target: the visible dot is ~1-2px once the
             1000-unit viewBox is squashed to the card, far too small to click. -->
        <circle :cx="p.cx" :cy="p.cy" r="18" fill="transparent" class="scatter-dot" @click="onScatterDot(p, $event)">
          <title>{{ p.label }} · {{ fmtMs(p.y) }}{{ isHot(p.rowKey) ? ` · ${t('selected')}` : '' }}</title>
        </circle>
      </g>
      <!-- Drag-select rectangle. -->
      <rect
        v-if="dragRect"
        :x="dragRect.x"
        :y="dragRect.y"
        :width="dragRect.w"
        :height="dragRect.h"
        fill="var(--sw-accent)"
        fill-opacity="0.12"
        stroke="var(--sw-accent)"
        stroke-width="1"
        stroke-dasharray="4 3"
        vector-effect="non-scaling-stroke"
        pointer-events="none"
      />
    </svg>
    <div class="scatter-x-axis">
      <span
        v-for="(tick, i) in scatterXTicks"
        :key="`x${i}`"
        class="x-tick"
        :class="{ first: i === 0, last: i === scatterXTicks.length - 1 }"
      >{{ tick.label }}</span>
    </div>
  </div>
  <div v-else class="scatter-empty">{{ t('no traces') }}</div>
</template>

<style scoped>
.scatter-svg { cursor: crosshair; }
.scatter-wrap {
  padding: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.scatter-svg {
  width: 100%;
  flex: 1;
  min-height: 140px;
  display: block;
}
.scatter-dot { cursor: pointer; transition: r 0.12s ease; }
.scatter-dot:hover { stroke: var(--sw-fg-0); stroke-width: 1.6; }
.scatter-x-axis {
  display: flex;
  justify-content: space-between;
  padding: 4px 0 0;
  font-size: 11px;
  color: var(--sw-fg-2);
  font-family: var(--sw-mono);
  flex: 0 0 auto;
}
.x-tick { white-space: nowrap; }
.x-tick.first { text-align: left; }
.x-tick.last { text-align: right; }
.scatter-empty {
  flex: 1;
  min-height: 140px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  color: var(--sw-fg-3);
}
</style>
