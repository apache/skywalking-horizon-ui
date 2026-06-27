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
  Native-trace waterfall row list. Shared between the Trace tab
  (`/layer/:key/trace`) and the Trace Profiling tab — both display a
  segment's spans as an indented timeline with service-coloured bars,
  kind glyphs, component icons, and a per-row duration suffix.

  Inputs:
    spans          — flat NativeSpan-like array (parentSpanId + refs)
    selectedSpan   — the currently highlighted span (for trace-profiling)
    markProfiled   — when true, surfaces a "profiled" chip per row
                     based on `span.profiled`; off by default for the
                     trace explorer where the chip is meaningless

  Emits:
    select-span    — row clicked
-->
<script setup lang="ts">
import { computed } from 'vue';
import { componentIconOrNull } from '@/layer/service-map/useTopologyIcons';
import { fmtMetric } from '@/utils/formatters';

/** Structural type covering both NativeSpan (from /trace) and
 *  ProfileSpan (from /trace-profiling). Only the fields the row
 *  renderer touches are required; the rest stay opaque so callers
 *  can pass either without ceremony. */
export interface WaterfallSpan {
  segmentId: string;
  spanId: number;
  parentSpanId: number;
  refs?: Array<{ parentSegmentId: string; parentSpanId: number }>;
  serviceCode: string;
  serviceInstanceName?: string;
  startTime: number;
  endTime: number;
  endpointName: string;
  type?: string | null;
  peer?: string;
  component?: string;
  isError?: boolean;
  attachedEvents?: Array<unknown>;
  profiled?: boolean;
}

const props = withDefaults(
  defineProps<{
    spans: WaterfallSpan[];
    selectedSpan?: WaterfallSpan | null;
    markProfiled?: boolean;
  }>(),
  { selectedSpan: null, markProfiled: false },
);
const emit = defineEmits<{ (e: 'select-span', span: WaterfallSpan): void }>();

const SERVICE_PALETTE = [
  'var(--sw-accent)', 'var(--sw-info)', 'var(--sw-cyan)', 'var(--sw-purple)',
  'var(--sw-ok)', 'var(--sw-warn)', 'var(--sw-pink)',
  '#a78bfa', '#fb7185', '#34d399', '#fbbf24', '#60a5fa',
];
function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
const serviceColors = computed<Map<string, string>>(() => {
  const m = new Map<string, string>();
  for (const s of props.spans) {
    if (!m.has(s.serviceCode)) {
      m.set(s.serviceCode, SERVICE_PALETTE[hashString(s.serviceCode) % SERVICE_PALETTE.length]);
    }
  }
  return m;
});
function serviceColor(c: string): string {
  return serviceColors.value.get(c) ?? 'var(--sw-fg-2)';
}

type KindFamily = 'entry' | 'local' | 'exit' | 'producer' | 'consumer' | 'other';
function kindFamily(type: string | null | undefined): KindFamily {
  const t = (type ?? '').toUpperCase();
  if (t === 'ENTRY' || t.includes('SERVER')) return 'entry';
  if (t === 'EXIT' || t.includes('CLIENT')) return 'exit';
  if (t === 'LOCAL') return 'local';
  if (t.includes('PRODUCER')) return 'producer';
  if (t.includes('CONSUMER')) return 'consumer';
  return 'other';
}
function kindColor(type: string | null | undefined): string {
  const t = (type ?? '').toUpperCase();
  if (t.includes('SERVER') || t === 'ENTRY') return 'var(--sw-accent)';
  if (t.includes('CLIENT') || t === 'EXIT') return 'var(--sw-info)';
  if (t === 'LOCAL') return 'var(--sw-purple)';
  if (t.includes('PRODUCER') || t.includes('CONSUMER')) return 'var(--sw-purple)';
  if (t.includes('DATABASE') || t.includes('SQL') || t.includes('CACHE')) return 'var(--sw-cyan)';
  return 'var(--sw-fg-2)';
}

interface WaterfallRow {
  span: WaterfallSpan;
  depth: number;
  startOffset: number;
  duration: number;
}
const waterfall = computed<WaterfallRow[]>(() => {
  const spans = props.spans;
  if (spans.length === 0) return [];
  const minStart = Math.min(...spans.map((s) => s.startTime));
  const key = (segId: string, spanId: number) => `${segId}/${spanId}`;
  const byKey = new Map(spans.map((s) => [key(s.segmentId, s.spanId), s]));
  const childMap = new Map<string, WaterfallSpan[]>();
  const roots: WaterfallSpan[] = [];
  function resolveParentKey(s: WaterfallSpan): string | null {
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
  const out: WaterfallRow[] = [];
  function walk(s: WaterfallSpan, depth: number): void {
    out.push({
      span: s,
      depth,
      startOffset: s.startTime - minStart,
      duration: Math.max(0, s.endTime - s.startTime),
    });
    const children = childMap.get(key(s.segmentId, s.spanId)) ?? [];
    for (const c of children) walk(c, depth + 1);
  }
  for (const r of roots) walk(r, 0);
  return out;
});
const totalDuration = computed(() => {
  const rows = waterfall.value;
  if (rows.length === 0) return 0;
  return Math.max(...rows.map((r) => r.startOffset + r.duration));
});

function fmtMs(v: number | null | undefined): string {
  if (v === null || v === undefined) return '—';
  return `${fmtMetric(v)} ms`;
}
function rowKey(span: WaterfallSpan): string {
  return `${span.segmentId}/${span.spanId}`;
}
function onPick(span: WaterfallSpan): void {
  emit('select-span', span);
}
</script>

<template>
  <div>
    <div v-if="waterfall.length === 0" class="tr-empty">no span data</div>
    <div v-else class="tr-default-list">
      <div
        v-for="row in waterfall"
        :key="rowKey(row.span)"
        class="tr-default-row"
        :class="{
          err: row.span.isError,
          'is-active': selectedSpan && rowKey(selectedSpan) === rowKey(row.span),
        }"
        @click="onPick(row.span)"
      >
        <span class="svc-stripe" :style="{ background: serviceColor(row.span.serviceCode) }" />
        <span
          class="status-flag sm"
          :class="row.span.isError ? 'flag-err' : 'flag-ok'"
          :title="row.span.isError ? 'Span errored' : 'Span OK'"
        ><span class="flag-dot" /></span>
        <svg
          class="kind-glyph"
          viewBox="0 0 14 14"
          :style="{ color: kindColor(row.span.type) }"
          :aria-label="row.span.type || 'span'"
          :title="row.span.type || ''"
        >
          <template v-if="kindFamily(row.span.type) === 'entry'">
            <path d="M1 7 L9 7 M6 4 L9 7 L6 10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
            <line x1="11.5" y1="3" x2="11.5" y2="11" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
          </template>
          <template v-else-if="kindFamily(row.span.type) === 'exit'">
            <line x1="2.5" y1="3" x2="2.5" y2="11" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
            <path d="M5 7 L13 7 M10 4 L13 7 L10 10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
          </template>
          <template v-else-if="kindFamily(row.span.type) === 'local'">
            <circle cx="7" cy="7" r="4" fill="none" stroke="currentColor" stroke-width="1.6" />
            <circle cx="7" cy="7" r="1.4" fill="currentColor" />
          </template>
          <template v-else-if="kindFamily(row.span.type) === 'producer'">
            <path d="M2 4 L11 4 L11 9 L7 9 L4 11.5 L4 9 L2 9 Z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" />
            <path d="M9 7 L12.5 7 M11 5.5 L12.5 7 L11 8.5" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" />
          </template>
          <template v-else-if="kindFamily(row.span.type) === 'consumer'">
            <path d="M12 4 L3 4 L3 9 L7 9 L10 11.5 L10 9 L12 9 Z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" />
            <path d="M5 7 L1.5 7 M3 5.5 L1.5 7 L3 8.5" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" />
          </template>
          <template v-else>
            <rect x="2.5" y="2.5" width="9" height="9" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.4" />
            <circle cx="7" cy="7" r="1.6" fill="currentColor" />
          </template>
        </svg>
        <img
          v-if="componentIconOrNull(row.span.component ?? '')"
          class="comp-icon"
          :src="componentIconOrNull(row.span.component ?? '') ?? ''"
          :alt="row.span.component || ''"
          :title="row.span.component || ''"
        />
        <svg
          v-else
          class="comp-icon comp-icon-generic"
          viewBox="0 0 18 18"
          :aria-label="row.span.component || 'generic span'"
        >
          <rect x="3" y="4.5" width="12" height="3" rx="1.5" fill="currentColor" opacity="0.45" />
          <rect x="5" y="10.5" width="10" height="3" rx="1.5" fill="currentColor" opacity="0.85" />
        </svg>
        <div class="tr-name-band">
          <span
            class="tr-name-band-bg"
            :style="{
              left: totalDuration > 0 ? (row.startOffset / totalDuration * 100) + '%' : '0%',
              width: totalDuration > 0 ? Math.max(0.8, row.duration / totalDuration * 100) + '%' : '0%',
              background: serviceColor(row.span.serviceCode),
              outlineColor: row.span.isError ? 'var(--sw-err)' : 'transparent',
            }"
          />
          <span
            v-for="g in row.depth"
            :key="g"
            class="tr-depth-guide"
            :style="{ left: (g - 1) * 22 + 10 + 'px' }"
          />
          <span class="tr-name-indent" :style="{ width: row.depth * 22 + 'px' }" />
          <span
            class="tr-name mono"
            :title="row.span.endpointName || row.span.component || row.span.peer || '—'"
          >{{ row.span.endpointName || row.span.component || row.span.peer || '—' }}</span>
          <span
            v-if="row.span.peer"
            class="tr-peer mono"
            :title="`peer · ${row.span.peer}`"
          >→ {{ row.span.peer }}</span>
          <!-- Profile-only marker. Trace explorer hides it (the field is
               undefined on NativeSpan); trace-profiling sets
               `mark-profiled` and renders the chip from `span.profiled`. -->
          <span
            v-if="markProfiled"
            class="prof-chip"
            :class="row.span.profiled ? 'on' : 'off'"
            :title="row.span.profiled ? 'Span was profiled' : 'Span not profiled'"
          >{{ row.span.profiled ? 'profiled' : '—' }}</span>
          <span
            v-if="!markProfiled && row.span.attachedEvents && row.span.attachedEvents.length > 0"
            class="evt-badge"
            :title="`${row.span.attachedEvents.length} attached event${row.span.attachedEvents.length === 1 ? '' : 's'}`"
          >
            <span class="evt-flag">⚑</span>
            <span class="evt-count">{{ row.span.attachedEvents.length }}</span>
          </span>
        </div>
        <span class="tr-row-dur mono">{{ fmtMs(row.duration) }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.tr-empty { padding: 24px; text-align: center; color: var(--sw-fg-3); font-size: 11.5px; }
.tr-default-list { padding: 6px 0; }
.tr-default-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 8px 4px 0;
  border-bottom: 1px solid var(--sw-line);
  cursor: pointer;
  position: relative;
  /* Browser-level virtualization: off-screen rows skip render/layout/paint.
   * Big traces (5k+ spans) used to freeze the main thread for seconds on
   * open because every row's SVG glyph + icon + name-band mounted upfront.
   * `contain-intrinsic-size` needs a hint for the collapsed height — rows
   * are near-fixed at ~32px (24 band + 8 vertical padding). Unsupported
   * browsers degrade to normal rendering. */
  content-visibility: auto;
  contain-intrinsic-size: auto 32px;
}
.tr-default-row:hover { background: var(--sw-bg-2); }
.tr-default-row.err { background: rgba(239, 68, 68, 0.06); }
.tr-default-row.is-active {
  background: var(--sw-bg-3, var(--sw-bg-2));
  box-shadow: inset 3px 0 0 var(--sw-accent);
}
.svc-stripe { width: 4px; height: 18px; flex: 0 0 auto; }
.kind-glyph {
  width: 14px; height: 14px; flex: 0 0 auto;
}
.status-flag {
  display: inline-flex; align-items: center; justify-content: center;
  flex: 0 0 auto;
}
.status-flag.sm {
  width: 12px; height: 12px; border-radius: 50%;
}
.status-flag.sm .flag-dot { margin: 0; }
.flag-dot {
  width: 6px; height: 6px; border-radius: 50%;
  background: currentColor;
}
.status-flag.flag-ok { background: rgba(34, 197, 94, 0.14); color: var(--sw-ok); }
.status-flag.flag-err { background: rgba(239, 68, 68, 0.18); color: var(--sw-err); }
.comp-icon { width: 16px; height: 16px; flex: 0 0 auto; opacity: 0.9; }
.comp-icon-generic { color: var(--sw-fg-2); }

.tr-name-band {
  position: relative;
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  height: 24px;
  padding: 0 6px;
}
.tr-name-band-bg {
  position: absolute;
  top: 4px; bottom: 4px;
  border-radius: 3px;
  opacity: 0.22;
  outline: 1px solid transparent;
}
.tr-default-row.err .tr-name-band-bg { opacity: 0.45; }
.tr-depth-guide {
  position: absolute;
  top: 0; bottom: 0;
  width: 1px;
  background: var(--sw-line-2);
  opacity: 0.5;
}
.tr-name-indent { flex: 0 0 auto; }
.tr-name {
  font-size: 11.5px;
  color: var(--sw-fg-0);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  position: relative; z-index: 1;
  min-width: 0; flex: 0 1 auto;
}
.tr-peer {
  font-size: 10.5px;
  color: var(--sw-fg-3);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  position: relative; z-index: 1;
  min-width: 0; flex: 0 1 auto;
}
.tr-row-dur {
  font-size: 10.5px;
  color: var(--sw-fg-2);
  flex: 0 0 auto;
  padding-right: 4px;
}
.evt-badge {
  display: inline-flex; align-items: center; gap: 2px;
  background: rgba(234, 179, 8, 0.15);
  color: var(--sw-warn);
  font-size: 10px;
  padding: 1px 5px;
  border-radius: 8px;
  position: relative; z-index: 1;
  flex: 0 0 auto;
}
.evt-flag { font-size: 10px; line-height: 1; }
.evt-count { font-family: var(--sw-mono); }
.prof-chip {
  display: inline-flex;
  align-items: center;
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 8px;
  font-family: var(--sw-mono);
  position: relative; z-index: 1;
  flex: 0 0 auto;
}
.prof-chip.on { background: var(--sw-accent-soft, rgba(249, 115, 22, 0.18)); color: var(--sw-accent-2, var(--sw-accent)); }
.prof-chip.off { color: var(--sw-fg-3); }
</style>
