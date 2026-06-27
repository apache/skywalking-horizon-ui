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
  Default view of the trace-detail card — a single combined row per
  span. Each row carries the service-coloured stripe, status flag +
  kind glyph + component icon, a name band with the start/duration bar
  rendered as the band BACKGROUND, depth guides, and a duration suffix.
  Service code is colour-only — no text. Click a row to open the span
  detail modal.
-->
<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { NativeSpan } from '@/api/client';
import { componentIconOrNull } from '@/layer/service-map/useTopologyIcons';
import {
  buildServiceColors, serviceColorFrom, kindColor, kindFamily, fmtMs,
} from './traceDetailShared';

const { t } = useI18n({ useScope: 'global' });

const props = defineProps<{ spans: NativeSpan[] }>();
const emit = defineEmits<{ (e: 'select-span', span: NativeSpan): void }>();

interface WaterfallRow {
  span: NativeSpan;
  depth: number;
  startOffset: number;
  duration: number;
}
const serviceColors = computed(() => buildServiceColors(props.spans));
function serviceColor(c: string): string { return serviceColorFrom(serviceColors.value, c); }

const nativeWaterfall = computed<WaterfallRow[]>(() => {
  const spans = props.spans;
  if (spans.length === 0) return [];
  const minStart = Math.min(...spans.map((s) => s.startTime));
  const key = (segId: string, spanId: number) => `${segId}/${spanId}`;
  const byKey = new Map(spans.map((s) => [key(s.segmentId, s.spanId), s]));
  const childMap = new Map<string, NativeSpan[]>();
  const roots: NativeSpan[] = [];
  // Resolve parent: intra-segment via parentSpanId, cross-segment via
  // any of the span's refs. If no resolvable parent is in the response,
  // the span becomes a root (orphan -> depth 0).
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
  const out: WaterfallRow[] = [];
  function walk(s: NativeSpan, depth: number): void {
    const childKey = key(s.segmentId, s.spanId);
    const children = childMap.get(childKey) ?? [];
    out.push({
      span: s,
      depth,
      startOffset: s.startTime - minStart,
      duration: Math.max(0, s.endTime - s.startTime),
    });
    for (const c of children) walk(c, depth + 1);
  }
  for (const r of roots) walk(r, 0);
  return out;
});
const nativeWaterfallDuration = computed(() => {
  const rows = nativeWaterfall.value;
  if (rows.length === 0) return 0;
  return Math.max(...rows.map((r) => r.startOffset + r.duration));
});
</script>

<template>
  <div v-if="nativeWaterfall.length === 0" class="tr-empty">{{ t('no span data') }}</div>
  <div v-else class="tr-default-list">
    <div
      v-for="row in nativeWaterfall"
      :key="`${row.span.segmentId}/${row.span.spanId}`"
      class="tr-default-row"
      :class="{ err: row.span.isError }"
      @click="emit('select-span', row.span)"
    >
      <span class="svc-stripe" :style="{ background: serviceColor(row.span.serviceCode) }" />
      <span
        class="status-flag sm"
        :class="row.span.isError ? 'flag-err' : 'flag-ok'"
        :title="row.span.isError ? t('Span errored') : t('Span OK')"
      ><span class="flag-dot" /></span>
      <!-- Inline kind glyph: → (entry), ← (exit), ◯ (local),
           speech-bubble (producer/consumer), generic (other). -->
      <svg
        class="kind-glyph"
        viewBox="0 0 14 14"
        :style="{ color: kindColor(row.span.type) }"
        :aria-label="row.span.type || t('span')"
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
        v-if="componentIconOrNull(row.span.component)"
        class="comp-icon"
        :src="componentIconOrNull(row.span.component) ?? ''"
        :alt="row.span.component || ''"
        :title="row.span.component || ''"
      />
      <svg
        v-else
        class="comp-icon comp-icon-generic"
        viewBox="0 0 18 18"
        :aria-label="row.span.component || t('generic span')"
      >
        <rect x="3" y="4.5" width="12" height="3" rx="1.5" fill="currentColor" opacity="0.45" />
        <rect x="5" y="10.5" width="10" height="3" rx="1.5" fill="currentColor" opacity="0.85" />
      </svg>
      <!-- Name band — the bar is rendered as the band's background
           (absolute), so its left+width encode the span's
           start+duration on the trace timeline. Depth indent is
           rendered as faint vertical guide lines AND a flex
           spacer that shifts the text right. -->
      <div class="tr-name-band">
        <span
          class="tr-name-band-bg"
          :style="{
            left: nativeWaterfallDuration > 0 ? (row.startOffset / nativeWaterfallDuration * 100) + '%' : '0%',
            width: nativeWaterfallDuration > 0 ? Math.max(0.8, row.duration / nativeWaterfallDuration * 100) + '%' : '0%',
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
          :title="t('peer · {peer}', { peer: row.span.peer })"
        >→ {{ row.span.peer }}</span>
        <span
          v-if="row.span.attachedEvents && row.span.attachedEvents.length > 0"
          class="evt-badge"
          :title="t('{n} attached events', { n: row.span.attachedEvents.length })"
        >
          <span class="evt-flag">⚑</span>
          <span class="evt-count">{{ row.span.attachedEvents.length }}</span>
        </span>
      </div>
      <span class="tr-row-dur mono">{{ fmtMs(row.duration) }}</span>
    </div>
  </div>
</template>

<style scoped>
.tr-empty { padding: 24px; text-align: center; color: var(--sw-fg-3); font-size: 11.5px; }
.mono { font-family: var(--sw-mono); }

/* Default view — single combined row. The bar sits as the
   *background* of the name band (encoding start + duration on the
   trace timeline). */
.tr-default-list { padding: 6px 0; }
.tr-default-row {
  display: grid;
  grid-template-columns: 4px auto auto auto minmax(0, 1fr) auto;
  gap: 8px;
  align-items: center;
  padding: 3px 14px 3px 0;
  font-size: 11px;
  cursor: pointer;
}
.tr-default-row:hover { background: var(--sw-bg-2); }
.tr-default-row.err { background: rgba(239, 68, 68, 0.06); }
.svc-stripe { width: 4px; height: 18px; flex: 0 0 auto; }
.kind-glyph {
  width: 14px;
  height: 14px;
  flex: 0 0 auto;
  color: var(--sw-fg-2);
}
.tr-name-band {
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  height: 22px;
}
.tr-name-band-bg {
  position: absolute;
  top: 2px;
  bottom: 2px;
  border-radius: 3px;
  opacity: 0.3;
  outline: 1px solid transparent;
  outline-offset: -1px;
  pointer-events: none;
}
.tr-default-row.err .tr-name-band-bg { opacity: 0.45; }
/* Vertical guide for each ancestor depth — drawn behind the band
   content. Makes call hierarchy readable without shifting the bar. */
.tr-depth-guide {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 1px;
  background: var(--sw-line-2);
  opacity: 0.45;
  pointer-events: none;
}
.tr-name-indent {
  flex: 0 0 auto;
  align-self: stretch;
}
.tr-name {
  position: relative;
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--sw-fg-0);
  font-size: 12px;
  font-weight: 500;
  padding-left: 4px;
}
.tr-peer {
  position: relative;
  flex: 0 0 auto;
  white-space: nowrap;
  font-size: 10.5px;
  color: var(--sw-fg-2);
}
.tr-row-dur {
  font-size: 10.5px;
  color: var(--sw-fg-1);
  font-weight: 600;
  flex: 0 0 auto;
  text-align: right;
  min-width: 56px;
  padding-left: 6px;
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
/* Attached-event badge. */
.evt-badge {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  height: 16px;
  padding: 0 5px;
  border-radius: 8px;
  background: var(--sw-accent-soft);
  color: var(--sw-accent-2);
  font-size: 9.5px;
  font-weight: 700;
  flex: 0 0 auto;
}
.evt-flag { font-size: 10px; line-height: 1; }
.evt-count { font-family: var(--sw-mono); }

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
