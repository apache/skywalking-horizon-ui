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
  d3-flame-graph wrapper for trace profiling analyze results. Mirrors
  the booster-ui Content.vue drawing logic but extracted as a focused
  component the trace + eBPF + async + pprof views can all reuse.

  Inputs:
    trees: ProfileAnalyzationTree[]  — server-returned analyze trees
    metricKey: 'count' | 'duration'  — what value drives the box width
                                       (count for trace, duration for
                                       eBPF / async / pprof). Default
                                       is `count`.
-->
<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, reactive, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import * as d3 from 'd3';
import { flamegraph } from 'd3-flame-graph';
import type { ProfileAnalyzationElement, ProfileAnalyzationTree } from '@/api/client';

const { t } = useI18n({ useScope: 'global' });

interface FlameNode {
  name: string;
  value: number;
  count: number;
  duration: number;
  durationChildExcluded: number;
  codeSignature: string;
  parentId: string;
  originId: string;
  children?: FlameNode[];
}

const props = withDefaults(
  defineProps<{
    trees: ProfileAnalyzationTree[];
    metricKey?: 'count' | 'duration';
  }>(),
  { metricKey: 'count' },
);

const root = ref<HTMLDivElement | null>(null);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let chart: any = null;

// Origin id of the click-selected frame. Drives the persistent outline
// (the zoom itself is d3-flame-graph's default click behavior).
const selectedOriginId = ref<string | null>(null);
function applySelectionHighlight(): void {
  if (!root.value) return;
  const sel = selectedOriginId.value;
  d3.select(root.value)
    .selectAll<SVGGElement, { data?: { originId?: string } }>('g')
    .each(function (d) {
      const isSel = !!sel && d?.data?.originId === sel;
      d3.select(this)
        .select('rect')
        .attr('stroke', isSel ? '#ffffff' : null)
        .attr('stroke-width', isSel ? 2 : null)
        .attr('stroke-opacity', isSel ? 0.95 : null);
    });
}

function metricFor(el: ProfileAnalyzationElement): number {
  if (props.metricKey === 'duration') return Math.max(0, el.duration);
  return Math.max(0, el.count);
}

function buildVirtualRoot(): FlameNode | null {
  if (!props.trees.length) return null;
  const all: number[] = [];
  for (const t of props.trees) for (const el of t.elements) all.push(metricFor(el));
  const min = all.length ? Math.min(...all) : 0;
  const max = all.length ? Math.max(...all) : 1;
  const scale = d3.scaleLinear().domain([min, max]).range([1, 200]);

  function processTree(arr: ProfileAnalyzationElement[]): FlameNode | null {
    const items = arr.map<FlameNode>((el) => ({
      name: el.codeSignature,
      value: Number(scale(metricFor(el)).toFixed(4)),
      count: el.count,
      duration: el.duration,
      durationChildExcluded: el.durationChildExcluded,
      codeSignature: el.codeSignature,
      parentId: String(Number(el.parentId) + 1),
      originId: String(Number(el.id) + 1),
    }));
    const idx: Record<string, FlameNode> = {};
    for (const it of items) idx[it.originId] = it;
    let r: FlameNode | null = null;
    for (const it of items) {
      if (it.parentId === '1') r = it;
      const me = idx[it.originId];
      const parent = idx[me.parentId];
      if (parent) (parent.children ??= []).push(me);
    }
    return r;
  }

  const virtRoot: FlameNode = {
    name: 'Virtual Root',
    value: 0,
    count: 0,
    duration: 0,
    durationChildExcluded: 0,
    codeSignature: 'Virtual Root',
    parentId: '0',
    originId: '1',
    children: [],
  };
  for (const tree of props.trees) {
    const r = processTree(tree.elements);
    if (r) virtRoot.children?.push(r);
  }
  // Roll up so a parent never reports less than the sum of its children
  // — d3-flame-graph requires that to lay frames out correctly.
  function rollup(n: FlameNode): void {
    if (n.children?.length) {
      let s = 0;
      for (const c of n.children) {
        rollup(c);
        s += c.value;
      }
      if (n.value < s) n.value = s;
    }
  }
  for (const c of virtRoot.children ?? []) rollup(c);
  let total = 0;
  for (const c of virtRoot.children ?? []) total += c.value;
  virtRoot.value = total;
  return virtRoot;
}

function draw(): void {
  if (!root.value) return;
  if (chart) {
    try {
      chart.destroy();
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (_e) {
      /* no-op */
    }
    chart = null;
  }
  root.value.innerHTML = '';
  const tree = buildVirtualRoot();
  if (!tree) return;
  const width = Math.max(root.value.getBoundingClientRect().width, 600);
  chart = flamegraph()
    .width(width - 12)
    .cellHeight(18)
    .transitionDuration(450)
    .minFrameSize(1)
    .transitionEase(d3.easeCubic as never)
    .sort(true)
    .title('')
    .selfValue(false)
    .inverted(true)
    // Dim, frame-friendly palette. d3-flame-graph's default ramp is a
     // bright yellow→orange→red gradient that overwhelms a dark UI; the
     // mapper below produces deterministic, lower-saturation colors
     // keyed off the frame name so each stack cell stays distinguishable
     // but the overall card reads as part of the dark canvas instead of
     // glowing through it.
    .setColorMapper((d: { highlight: boolean; data?: { name?: string } }, _original: string) => {
      if (d.highlight) return '#6aff8f';
      const name = d.data?.name ?? '';
      let hash = 0;
      for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0;
      // 0–360° hue, fixed mid sat + dark lightness for dark-theme calm.
      const hue = Math.abs(hash) % 360;
      return `hsl(${hue}, 32%, 38%)`;
    });

  chart.tooltip(false);
  // Suppress the library's native <title> tooltip ("name (pct%, N
  // samples)"). With the d3-tip tooltip off, d3-flame-graph still
  // appends an <svg:title> per cell filled from the label handler —
  // it collided with our richer cursor-following .fg-tip card. An empty
  // handler leaves the title text blank (no browser tooltip). Cast: the
  // method exists at runtime but isn't in the shipped d3-flame-graph types.
  (chart as unknown as { setLabelHandler(fn: () => string): unknown }).setLabelHandler(() => '');
  // Click selects + zooms. d3-flame-graph zooms to the clicked frame by
  // default (the "expand"); we additionally pin a persistent outline on
  // the selected frame so the operator can see WHICH cell is focused —
  // re-applied after the zoom transition rebuilds the visible frames.
  chart.onClick((d: { data?: { originId?: string } }) => {
    selectedOriginId.value = d?.data?.originId ?? null;
    applySelectionHighlight();
    window.setTimeout(applySelectionHighlight, 470);
  });
  d3.select(root.value).datum(tree).call(chart);
  applySelectionHighlight();
  const svg = root.value.querySelector('svg');
  if (svg) {
    // Hover a frame → render a cursor-following info card (悬浮信息).
    // The earlier click-driven modal popout was a useful escape hatch
    // while the framework was unstable, but now that the flame draw is
    // settled, an inline tooltip matches operator muscle memory from
    // booster-ui + every other flame viewer. Tracking happens at the
    // SVG layer so each `g` (frame group) is resolved via event-target
    // walk-up — no per-frame listener install (matters at 1000+ frames).
    const onMove = (event: MouseEvent) => {
      const target = (event.target as Element).closest('g');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const data: any = target && (d3.select(target as Element).datum() as any);
      if (!data || !data.data) {
        hoveredFrame.value = null;
        return;
      }
      hoveredFrame.value = data.data as FlameNode;
      tipPos.x = event.clientX;
      tipPos.y = event.clientY;
    };
    const onLeave = () => { hoveredFrame.value = null; };
    svg.addEventListener('mousemove', onMove);
    svg.addEventListener('mouseleave', onLeave);
    // Hold onto handlers so the unmount cleanup detaches them along
    // with the d3 chart, even though the SVG is replaced wholesale on
    // every draw() (a fresh d3.flamegraph render rebuilds the tree).
    svgHandlers = { svg, onMove, onLeave };
  }
}

const hoveredFrame = ref<FlameNode | null>(null);
const tipPos = reactive({ x: 0, y: 0 });
let svgHandlers: { svg: SVGElement; onMove: (e: MouseEvent) => void; onLeave: () => void } | null = null;

// "% of root" denominator = the whole profile's total, measured with
// the SAME metric that sizes the boxes (count for trace, duration for
// async / eBPF / pprof). Each top-level frame's value is cumulative
// (includes its descendants), so the profile total is the sum across
// the top-level roots. (The virtual-root node's own `count`/`duration`
// stay 0 — only `value` is rolled up for d3 layout — so we must sum the
// children here rather than read the virtual root.)
function frameMetric(n: FlameNode): number {
  return props.metricKey === 'duration' ? n.duration : n.count;
}
const rootTotalForPct = computed<number>(() => {
  const tree = buildVirtualRoot();
  if (!tree?.children?.length) return 0;
  return tree.children.reduce((s, c) => s + Math.max(0, frameMetric(c)), 0);
});
const hoveredPctRoot = computed<string>(() => {
  const f = hoveredFrame.value;
  const total = rootTotalForPct.value;
  if (!f || total === 0) return '0';
  return ((frameMetric(f) / total) * 100).toFixed(2);
});

// Tip position with viewport-edge clamping. Width is capped via CSS
// (max-width: 360px), height typically ≤ 140px for the four-row card —
// 380×160 is a defensive overshoot so the flip kicks in early enough
// to avoid clipping. `transform: translate(...)` is on a `position:
// fixed` element so coords are viewport-relative.
const TIP_W = 380;
const TIP_H = 160;
const tipStyle = computed<Record<string, string>>(() => {
  const offset = 14;
  let x = tipPos.x + offset;
  let y = tipPos.y + offset;
  if (x + TIP_W > window.innerWidth - 8) x = tipPos.x - TIP_W - offset;
  if (y + TIP_H > window.innerHeight - 8) y = tipPos.y - TIP_H - offset;
  if (x < 8) x = 8;
  if (y < 8) y = 8;
  return { transform: `translate(${x}px, ${y}px)` };
});

onMounted(() => {
  draw();
});
watch(() => [props.trees, props.metricKey], () => {
  // Drop any stale hover + selection when the data changes — keeps the
  // card and the outline from pointing at a frame that no longer exists.
  hoveredFrame.value = null;
  selectedOriginId.value = null;
  draw();
});
onBeforeUnmount(() => {
  if (svgHandlers) {
    svgHandlers.svg.removeEventListener('mousemove', svgHandlers.onMove);
    svgHandlers.svg.removeEventListener('mouseleave', svgHandlers.onLeave);
    svgHandlers = null;
  }
  if (chart) {
    try {
      chart.destroy();
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (_e) {
      /* no-op */
    }
    chart = null;
  }
});
</script>

<template>
  <div ref="root" class="fg-host"></div>
  <!-- Cursor-following info card. Teleported to <body> so the parent's
       overflow:auto doesn't clip it at the bottom edge of the host.
       `pointer-events: none` keeps the card transparent to the
       underlying SVG so hovering across frames doesn't churn the
       mouseleave/mouseover events that drive `hoveredFrame`. -->
  <Teleport to="body">
    <div
      v-if="hoveredFrame"
      class="fg-tip"
      :style="tipStyle"
      role="tooltip"
    >
      <div class="fg-tip-sig">{{ hoveredFrame.codeSignature }}</div>
      <dl class="fg-tip-rows">
        <div class="fg-tip-row">
          <dt>{{ t('Dump count') }}</dt>
          <dd>{{ hoveredFrame.count }}</dd>
        </div>
        <div class="fg-tip-row">
          <dt>{{ t('Duration') }}</dt>
          <dd>{{ hoveredFrame.duration }} ns</dd>
        </div>
        <div class="fg-tip-row">
          <dt>{{ t('Duration (excl. children)') }}</dt>
          <dd>{{ hoveredFrame.durationChildExcluded }} ns</dd>
        </div>
        <div class="fg-tip-row">
          <dt>{{ t('% of root') }}</dt>
          <dd>{{ hoveredPctRoot }}%</dd>
        </div>
      </dl>
    </div>
  </Teleport>
</template>

<style scoped>
.fg-host {
  width: 100%;
  height: 100%;
  overflow: auto;
}
.fg-host :deep(svg) {
  width: 100%;
}
</style>

<style>
/* Cursor-following hover info. Teleported to <body>, fixed-positioned
 * with `transform: translate(...)` driven by the JS clamp. Width caps
 * at 360px with `overflow-wrap: anywhere` so even the longest stack
 * frame (`org.jboss.threads.EnhancedQueueExecutor$ThreadBody.run:1556`)
 * wraps inside the box instead of pushing past its edge. */
.fg-tip {
  position: fixed;
  top: 0;
  left: 0;
  z-index: 9999;
  width: max-content;
  max-width: 360px;
  pointer-events: none;
  background: var(--sw-bg-1, #1b1d24);
  border: 1px solid var(--sw-line, #2a2d36);
  border-radius: 6px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
  padding: 10px 12px;
  font-family: var(--sw-mono, monospace);
  font-size: 11px;
  color: var(--sw-fg-1, #d4d6de);
  line-height: 1.5;
}
.fg-tip-sig {
  color: var(--sw-fg-0, #f5f7fb);
  font-weight: 600;
  margin-bottom: 8px;
  padding-bottom: 6px;
  border-bottom: 1px dashed var(--sw-line, #2a2d36);
  overflow-wrap: anywhere;
  word-break: break-all;
}
.fg-tip-rows {
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.fg-tip-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}
.fg-tip-row dt {
  margin: 0;
  color: var(--sw-fg-3, #6b6f7a);
  flex: 0 0 auto;
}
.fg-tip-row dd {
  margin: 0;
  color: var(--sw-fg-0, #f5f7fb);
  font-variant-numeric: tabular-nums;
  text-align: right;
  overflow-wrap: anywhere;
}
</style>
