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
  Tree view of the trace-detail card — a d3 horizontal flowing tree.
  Root left, children to the right; cards joined by Bezier paths. Click
  a card to open the span detail modal. Wheel-zoom + drag-pan via
  d3.zoom (owned by useTraceTreeZoom); explicit +/-/⊙ controls top-right.
-->
<script setup lang="ts">
import { computed, nextTick, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import * as d3 from 'd3';
import type { NativeSpan } from '@/api/client';
import { componentIconOrNull } from '@/layer/service-map/useTopologyIcons';
import {
  buildServiceColors, serviceColorFrom, fmtMs, latencyColor,
} from './traceDetailShared';
import { useTraceTreeZoom } from './useTraceTreeZoom';

const { t } = useI18n({ useScope: 'global' });

const props = defineProps<{ spans: NativeSpan[] }>();
const emit = defineEmits<{ (e: 'select-span', span: NativeSpan): void }>();

const serviceColors = computed(() => buildServiceColors(props.spans));
function serviceColor(c: string): string { return serviceColorFrom(serviceColors.value, c); }

interface TreeNode {
  span: NativeSpan;
  x: number; // horizontal coord (left-to-right)
  y: number; // vertical coord
  parent: TreeNode | null;
}
interface TreeLink {
  parent: TreeNode;
  child: TreeNode;
  d: string;
}
interface TreeLayout {
  nodes: TreeNode[];
  links: TreeLink[];
  width: number;
  height: number;
}
const NODE_W = 180;
/** Card height — three rows: service code, span name, latency. */
const NODE_H = 54;
const NODE_GAP_X = 80;
const NODE_GAP_Y = 14;

const nativeWaterfallDuration = computed(() => {
  const spans = props.spans;
  if (spans.length === 0) return 0;
  const minStart = Math.min(...spans.map((s) => s.startTime));
  return Math.max(...spans.map((s) => (s.startTime - minStart) + Math.max(0, s.endTime - s.startTime)));
});

const nativeTreeLayout = computed<TreeLayout>(() => {
  const spans = props.spans;
  if (spans.length === 0) return { nodes: [], links: [], width: 0, height: 0 };
  const key = (segId: string, spanId: number) => `${segId}/${spanId}`;
  const byKey = new Map(spans.map((s) => [key(s.segmentId, s.spanId), s]));
  const childMap = new Map<string, NativeSpan[]>();
  const roots: NativeSpan[] = [];
  function resolveParentKey(s: NativeSpan): string | null {
    if (s.parentSpanId !== -1) {
      const k = key(s.segmentId, s.parentSpanId);
      return byKey.has(k) ? k : null;
    }
    for (const r of s.refs ?? []) {
      const k = key(r.parentSegmentId, r.parentSpanId);
      if (byKey.has(k)) return k;
    }
    return null;
  }
  for (const s of spans) {
    const parentKey = resolveParentKey(s);
    if (parentKey) {
      const arr = childMap.get(parentKey) ?? [];
      arr.push(s);
      childMap.set(parentKey, arr);
    } else {
      roots.push(s);
    }
  }
  interface Datum { span: NativeSpan; children: Datum[]; }
  function build(s: NativeSpan): Datum {
    const k = key(s.segmentId, s.spanId);
    const kids = childMap.get(k) ?? [];
    return { span: s, children: kids.map(build) };
  }
  // Multiple roots → wrap them in a synthetic root so the d3 layout
  // treats them as siblings. The synthetic root is filtered out at
  // render time.
  const synthRoot: Datum = roots.length === 1
    ? build(roots[0])
    : {
        span: { segmentId: '__synth__', spanId: -1 } as NativeSpan,
        children: roots.map(build),
      };
  const hierarchy = d3.hierarchy<Datum>(synthRoot, (d) => d.children);
  const layout = d3.tree<Datum>().nodeSize([NODE_H + NODE_GAP_Y, NODE_W + NODE_GAP_X])(hierarchy);
  // d3.tree() produces y for depth and x for sibling. For a
  // left-to-right tree we use d.y as horizontal and d.x as vertical.
  const nodes: TreeNode[] = [];
  const nodeMap = new Map<string, TreeNode>();
  let minY = Infinity;
  let maxY = -Infinity;
  let maxX = 0;
  layout.descendants().forEach((d) => {
    if (d.data.span.segmentId === '__synth__') return;
    const tn: TreeNode = { span: d.data.span, x: d.y, y: d.x, parent: null };
    nodes.push(tn);
    nodeMap.set(key(tn.span.segmentId, tn.span.spanId), tn);
    if (tn.y < minY) minY = tn.y;
    if (tn.y > maxY) maxY = tn.y;
    if (tn.x > maxX) maxX = tn.x;
  });
  // Re-anchor so the layout starts at (0, 0).
  const offsetX = nodes.length > 0 ? Math.min(...nodes.map((n) => n.x)) : 0;
  for (const n of nodes) {
    n.x -= offsetX;
    n.y -= minY;
  }
  const links: TreeLink[] = [];
  layout.descendants().forEach((d) => {
    if (!d.parent) return;
    if (d.parent.data.span.segmentId === '__synth__') return;
    if (d.data.span.segmentId === '__synth__') return;
    const child = nodeMap.get(key(d.data.span.segmentId, d.data.span.spanId));
    const parent = nodeMap.get(key(d.parent.data.span.segmentId, d.parent.data.span.spanId));
    if (!child || !parent) return;
    child.parent = parent;
    const x1 = parent.x + NODE_W;
    const y1 = parent.y + NODE_H / 2;
    const x2 = child.x;
    const y2 = child.y + NODE_H / 2;
    const midX = (x1 + x2) / 2;
    const d_ = `M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}`;
    links.push({ parent, child, d: d_ });
  });
  return {
    nodes,
    links,
    width: maxX - offsetX + NODE_W + 20,
    height: maxY - minY + NODE_H + 20,
  };
});

const { treeSvgEl, treeTransform, ensureZoom, zoomBy, zoomReset } = useTraceTreeZoom();
// Attach d3.zoom once the SVG mounts. The tree view only renders while
// active, so mount == active; re-attach if the SVG ref swaps.
watch(treeSvgEl, async () => {
  await nextTick();
  ensureZoom();
}, { immediate: true });
</script>

<template>
  <div v-if="nativeTreeLayout.nodes.length === 0" class="tr-empty">{{ t('no span data') }}</div>
  <div v-else class="tr-tree-canvas">
    <div class="tree-zoom-ctrls">
      <button class="sw-btn small ghost" type="button" :title="t('Zoom in')" @click="zoomBy(1.25)">+</button>
      <button class="sw-btn small ghost" type="button" :title="t('Zoom out')" @click="zoomBy(1 / 1.25)">−</button>
      <button class="sw-btn small ghost" type="button" :title="t('Reset')" @click="zoomReset">⊙</button>
      <span class="zoom-pct mono">{{ Math.round(treeTransform.k * 100) }}%</span>
    </div>
    <svg
      ref="treeSvgEl"
      class="tree-svg"
      width="100%"
      height="100%"
      :viewBox="`0 0 ${nativeTreeLayout.width} ${nativeTreeLayout.height}`"
      preserveAspectRatio="xMidYMid meet"
    >
      <g :transform="`translate(${treeTransform.x}, ${treeTransform.y}) scale(${treeTransform.k})`">
      <path
        v-for="(lnk, i) in nativeTreeLayout.links"
        :key="`l${i}`"
        :d="lnk.d"
        class="tree-link"
        fill="none"
        stroke="var(--sw-fg-3)"
        stroke-width="1.4"
      />
      <g
        v-for="n in nativeTreeLayout.nodes"
        :key="`${n.span.segmentId}/${n.span.spanId}`"
        :transform="`translate(${n.x}, ${n.y})`"
        class="tree-node"
        :class="{ err: n.span.isError }"
        @click="emit('select-span', n.span)"
      >
        <rect
          :width="NODE_W"
          :height="NODE_H"
          rx="4"
          fill="var(--sw-bg-2)"
          fill-opacity="0.7"
          :stroke="n.span.isError ? 'var(--sw-err)' : serviceColor(n.span.serviceCode)"
          stroke-width="1.6"
        />
        <clipPath :id="`tree-clip-${n.span.segmentId}-${n.span.spanId}`">
          <rect :width="NODE_W" :height="NODE_H" rx="4" />
        </clipPath>
        <rect
          :clip-path="`url(#tree-clip-${n.span.segmentId}-${n.span.spanId})`"
          :width="nativeWaterfallDuration > 0
            ? Math.max(2, ((n.span.endTime - n.span.startTime) / nativeWaterfallDuration) * NODE_W)
            : 0"
          :height="NODE_H"
          :fill="latencyColor(n.span.endTime - n.span.startTime)"
          fill-opacity="0.42"
        />
        <foreignObject :x="0" :y="0" :width="NODE_W" :height="NODE_H">
          <div
            xmlns="http://www.w3.org/1999/xhtml"
            class="tree-node-body"
          >
            <span
              class="status-flag sm"
              :class="n.span.isError ? 'flag-err' : 'flag-ok'"
            ><span class="flag-dot" /></span>
            <img
              v-if="componentIconOrNull(n.span.component)"
              class="comp-icon"
              :src="componentIconOrNull(n.span.component) ?? ''"
              :alt="n.span.component || ''"
            />
            <svg
              v-else
              class="comp-icon comp-icon-generic"
              viewBox="0 0 18 18"
              :aria-label="n.span.component || t('generic span')"
            >
              <rect x="3" y="4.5" width="12" height="3" rx="1.5" fill="currentColor" opacity="0.45" />
              <rect x="5" y="10.5" width="10" height="3" rx="1.5" fill="currentColor" opacity="0.85" />
            </svg>
            <span class="tree-node-text mono">
              <span class="tree-node-svc" :style="{ color: serviceColor(n.span.serviceCode) }">{{ n.span.serviceCode }}</span>
              <span class="tree-node-name" :title="n.span.endpointName || n.span.component || n.span.peer || '—'">{{ n.span.endpointName || n.span.component || n.span.peer || '—' }}</span>
              <span
                class="tree-node-lat-text"
                :style="{ color: latencyColor(n.span.endTime - n.span.startTime) }"
              >{{ fmtMs(n.span.endTime - n.span.startTime) }}</span>
            </span>
          </div>
        </foreignObject>
      </g>
      </g>
    </svg>
  </div>
</template>

<style scoped>
.tr-empty { padding: 24px; text-align: center; color: var(--sw-fg-3); font-size: 11.5px; }
.mono { font-family: var(--sw-mono); }
.sw-btn.small { height: 24px; padding: 0 10px; font-size: 11px; }
.sw-btn.ghost { background: transparent; border: 1px solid var(--sw-line-2); color: var(--sw-fg-2); }

/* Tree view — d3 horizontal layout. */
.tr-tree-canvas {
  position: relative;
  padding: 12px;
  height: clamp(420px, 60vh, 720px);
  background:
    linear-gradient(var(--sw-bg-1), var(--sw-bg-1)) padding-box,
    repeating-linear-gradient(
      45deg,
      transparent 0 8px,
      var(--sw-line) 8px 9px
    ) border-box;
}
.tree-svg { display: block; cursor: grab; }
.tree-svg:active { cursor: grabbing; }
/* Floating zoom control cluster — top-right of the tree canvas. */
.tree-zoom-ctrls {
  position: sticky;
  top: 8px;
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 6px;
  background: rgba(15, 18, 30, 0.85);
  border: 1px solid var(--sw-line-2);
  border-radius: 6px;
  z-index: 2;
  width: fit-content;
  float: right;
  backdrop-filter: blur(6px);
}
.tree-zoom-ctrls .zoom-pct {
  font-size: 10.5px;
  color: var(--sw-fg-2);
  min-width: 36px;
  text-align: right;
  padding-right: 2px;
}
.tree-link { transition: stroke 0.12s ease; }
.tree-node { cursor: pointer; }
.tree-node:hover rect { fill-opacity: 0.35; }
.tree-node.err rect { stroke: var(--sw-err); }
.tree-node-body {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  height: 100%;
  font-size: 11px;
  color: var(--sw-fg-0);
  overflow: hidden;
  box-sizing: border-box;
}
.tree-node-text {
  display: inline-flex;
  flex-direction: column;
  min-width: 0;
  flex: 1 1 auto;
  line-height: 1.25;
  gap: 1px;
}
.tree-node-svc {
  font-size: 9.5px;
  font-weight: 700;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tree-node-name {
  font-size: 11px;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--sw-fg-0);
}
.tree-node-lat-text {
  font-size: 9.5px;
  font-weight: 700;
  font-family: var(--sw-mono);
}

/* Technology component icon — same PNG set as the topology map. */
.comp-icon {
  width: 18px;
  height: 18px;
  flex: 0 0 auto;
  object-fit: contain;
  background: transparent;
}
.comp-icon-generic { color: var(--sw-fg-2); }
.tree-node-body .comp-icon-generic { color: var(--sw-fg-1); }

/* Status flag */
.status-flag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 18px;
  padding: 0 6px;
  border-radius: 9px;
  font-size: 9.5px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  flex: 0 0 auto;
}
.status-flag.sm {
  height: 12px;
  width: 12px;
  padding: 0;
  border-radius: 50%;
  justify-content: center;
}
.status-flag.sm .flag-dot { margin: 0; }
.flag-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
  flex: 0 0 auto;
}
.status-flag.flag-ok { background: rgba(34, 197, 94, 0.14); color: var(--sw-ok); }
.status-flag.flag-err { background: rgba(239, 68, 68, 0.18); color: var(--sw-err); }
</style>
