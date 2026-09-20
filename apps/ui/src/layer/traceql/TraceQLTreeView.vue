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
  The trace as a left-to-right hierarchy, laid out with d3 — the native tree
  view's layout, over OTLP spans. Parentage is `parentSpanId` against `spanId`;
  several roots are wrapped in a synthetic one so d3 treats them as siblings,
  and that synthetic node is dropped before rendering.

  Drag to pan, wheel to zoom, or use the controls — a wide trace does not fit a
  screen, and scrollbars alone cannot follow one branch across it.
-->
<script setup lang="ts">
import { computed, nextTick, watch } from 'vue';
import * as d3 from 'd3';
import { useI18n } from 'vue-i18n';
import type { TraceQLSpan } from '@skywalking-horizon-ui/api-client';
// The d3.zoom lifecycle only — it knows about an SVG and a transform, never
// about a span, so both tree views bind the same behaviour without either
// knowing the other's model.
import { useTraceTreeZoom } from '@/render/widgets/useTraceTreeZoom';
import {
  buildServiceColors,
  fmtMs,
  kindLabel,
  latencyColor,
  serviceColorFrom,
  spanStatus,
  statusColor,
} from './traceqlDetailShared';

/** The selected SPAN OBJECT rather than its id — see the waterfall. */
const props = defineProps<{ spans: TraceQLSpan[]; selectedSpan?: TraceQLSpan | null }>();
const emit = defineEmits<{ (e: 'select-span', span: TraceQLSpan): void }>();
const { t } = useI18n({ useScope: 'global' });

const colors = computed(() => buildServiceColors(props.spans));

const NODE_W = 180;
const NODE_H = 54;
const NODE_GAP_X = 80;
const NODE_GAP_Y = 14;
/** The datum index a synthetic root carries: a forest needs one parent for d3
 *  to lay it out, and it is never drawn. */
const SYNTH = -1;

interface TreeNode { span: TraceQLSpan; x: number; y: number; key: number }
interface TreeLink { d: string }

const layout = computed<{ nodes: TreeNode[]; links: TreeLink[]; width: number; height: number }>(() => {
  const spans = props.spans;
  if (spans.length === 0) return { nodes: [], links: [], width: 0, height: 0 };

  // Identity is a span's POSITION, as in the waterfall: a Zipkin client and
  // server span can share one span id, and both records must be drawn.
  const firstWithId = new Map<string, number>();
  spans.forEach((s, i) => { if (!firstWithId.has(s.spanId)) firstWithId.set(s.spanId, i); });
  const children = new Map<string, number[]>();
  const roots: number[] = [];
  spans.forEach((s, i) => {
    if (s.parentSpanId && s.parentSpanId !== s.spanId && firstWithId.has(s.parentSpanId)) {
      const arr = children.get(s.parentSpanId) ?? [];
      arr.push(i);
      children.set(s.parentSpanId, arr);
    } else {
      roots.push(i);
    }
  });

  interface Datum { span: TraceQLSpan; index: number; children: Datum[] }
  const seen = new Set<number>();
  function build(i: number): Datum {
    const span = spans[i]!;
    if (seen.has(i)) return { span, index: i, children: [] };
    seen.add(i);
    const owns = firstWithId.get(span.spanId) === i;
    return { span, index: i, children: owns ? (children.get(span.spanId) ?? []).map(build) : [] };
  }
  const forest = roots.map(build);
  // Spans left unvisited belong to a component with no root (a cycle, or a
  // self-parent). They are entered at their earliest span rather than
  // vanishing from a view whose own header counts them.
  for (const i of spans.map((_, n) => n).sort((a, b) => spans[a]!.startUs - spans[b]!.startUs)) {
    if (!seen.has(i)) forest.push(build(i));
  }
  const root: Datum =
    forest.length === 1
      ? forest[0]!
      : { span: {} as TraceQLSpan, index: SYNTH, children: forest };

  const hierarchy = d3.hierarchy<Datum>(root, (d) => d.children);
  const tree = d3.tree<Datum>().nodeSize([NODE_H + NODE_GAP_Y, NODE_W + NODE_GAP_X])(hierarchy);

  // d3 gives `y` for depth and `x` for sibling position; a left-to-right tree
  // reads them the other way round.
  const nodes: TreeNode[] = [];
  // Keyed by the DATUM rather than the span id, so two records sharing an id
  // keep their own node and their own links.
  const placed = new Map<Datum, TreeNode>();
  for (const d of tree.descendants()) {
    if (d.data.index === SYNTH) continue;
    const n: TreeNode = { span: d.data.span, x: d.y, y: d.x, key: d.data.index };
    nodes.push(n);
    placed.set(d.data, n);
  }
  if (nodes.length === 0) return { nodes: [], links: [], width: 0, height: 0 };
  const minX = Math.min(...nodes.map((n) => n.x));
  const minY = Math.min(...nodes.map((n) => n.y));
  for (const n of nodes) {
    n.x -= minX;
    n.y -= minY;
  }

  const links: TreeLink[] = [];
  for (const d of tree.descendants()) {
    if (!d.parent || d.parent.data.index === SYNTH || d.data.index === SYNTH) continue;
    const parent = placed.get(d.parent.data);
    const child = placed.get(d.data);
    if (!parent || !child) continue;
    const x1 = parent.x + NODE_W;
    const y1 = parent.y + NODE_H / 2;
    const x2 = child.x;
    const y2 = child.y + NODE_H / 2;
    const mid = (x1 + x2) / 2;
    links.push({ d: `M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2}` });
  }

  return {
    nodes,
    links,
    width: Math.max(...nodes.map((n) => n.x)) + NODE_W + 8,
    height: Math.max(...nodes.map((n) => n.y)) + NODE_H + 8,
  };
});

const { treeSvgEl, treeTransform, ensureZoom, zoomBy, zoomReset } = useTraceTreeZoom();
// The view is mounted only while it is the chosen one, so mount is activation;
// re-attach if the element swaps under a re-render.
watch(treeSvgEl, async () => {
  await nextTick();
  ensureZoom();
}, { immediate: true });
</script>

<template>
  <div class="tqt">
    <div class="tqt-zoom">
      <button class="sw-btn small ghost" type="button" :title="t('Zoom in')" @click="zoomBy(1.25)">+</button>
      <button class="sw-btn small ghost" type="button" :title="t('Zoom out')" @click="zoomBy(1 / 1.25)">−</button>
      <button class="sw-btn small ghost" type="button" :title="t('Reset')" @click="zoomReset">⊙</button>
      <span class="tqt-pct mono">{{ Math.round(treeTransform.k * 100) }}%</span>
    </div>
    <svg
      v-if="layout.nodes.length"
      ref="treeSvgEl"
      class="tqt-svg"
      width="100%"
      height="100%"
      :viewBox="`0 0 ${layout.width} ${layout.height}`"
      preserveAspectRatio="xMidYMid meet"
    >
      <g :transform="`translate(${treeTransform.x}, ${treeTransform.y}) scale(${treeTransform.k})`">
      <path v-for="(l, i) in layout.links" :key="i" :d="l.d" class="tqt-link" />
      <g
        v-for="n in layout.nodes"
        :key="n.key"
        :transform="`translate(${n.x}, ${n.y})`"
        class="tqt-node"
        :class="{ on: selectedSpan === n.span }"
        @click="emit('select-span', n.span)"
      >
        <rect :width="NODE_W" :height="NODE_H" rx="4" class="tqt-box" :style="{ stroke: serviceColorFrom(colors, n.span.service) }" />
        <rect :width="3" :height="NODE_H" rx="1" :style="{ fill: serviceColorFrom(colors, n.span.service) }" />
        <circle :cx="NODE_W - 8" :cy="10" :r="3.5" :style="{ fill: statusColor(spanStatus(n.span)) }" />
        <!-- The text lives in HTML, not in <text>: an SVG string neither wraps
             nor ellipsizes, so a long span name ran straight out of its box. -->
        <foreignObject :x="0" :y="0" :width="NODE_W" :height="NODE_H">
          <div xmlns="http://www.w3.org/1999/xhtml" class="tqt-body">
            <span class="tqt-svc" :style="{ color: serviceColorFrom(colors, n.span.service) }">{{ n.span.service || '—' }}</span>
            <span class="tqt-name" :title="n.span.name || ''">{{ n.span.name || '—' }}</span>
            <span class="tqt-meta" :style="{ color: latencyColor(n.span.durationUs) }">
              {{ fmtMs(n.span.durationUs) }} · {{ kindLabel(n.span.kind) }}
            </span>
          </div>
        </foreignObject>
      </g>
      </g>
    </svg>
  </div>
</template>

<style scoped>
.tqt {
  position: relative;
  padding: 8px;
  height: clamp(420px, 60vh, 720px);
  overflow: hidden;
}
.tqt-svg { display: block; cursor: grab; }
.tqt-svg:active { cursor: grabbing; }
/* The control cluster floats over the canvas, top-right, as the native tree's does. */
.tqt-zoom {
  position: absolute;
  top: 12px;
  right: 12px;
  z-index: 2;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 6px;
  background: rgba(15, 18, 30, 0.85);
  border: 1px solid var(--sw-line-2);
  border-radius: 6px;
  backdrop-filter: blur(6px);
}
.tqt-pct { font-size: 10.5px; color: var(--sw-fg-2); min-width: 36px; text-align: right; padding-right: 2px; }
.tqt-link { fill: none; stroke: var(--sw-line-2); stroke-width: 1.2; }
.tqt-node { cursor: pointer; }
.tqt-box { fill: var(--sw-bg-2); stroke-width: 1; }
.tqt-node.on .tqt-box { fill: var(--sw-bg-3); stroke-width: 2; }
/* The node's three lines, on the native tree's type scale. Each clips rather
   than overflowing: a span name is as long as the instrumentation made it. */
.tqt-body {
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 1px;
  height: 100%;
  padding: 4px 16px 4px 10px;
  box-sizing: border-box;
  overflow: hidden;
  font-family: var(--sw-mono);
  line-height: 1.25;
}
.tqt-body > span {
  display: block;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tqt-svc { font-size: 9.5px; font-weight: 700; }
.tqt-name { font-size: 11px; font-weight: 500; color: var(--sw-fg-0); }
.tqt-meta { font-size: 9.5px; font-weight: 700; }
foreignObject { pointer-events: none; }
</style>
