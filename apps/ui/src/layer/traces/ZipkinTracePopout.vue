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
  Zipkin trace popout — span-tree waterfall driven by Zipkin's
  `parentId` linkage. Distinct from `TracePopout.vue` (which renders
  SkyWalking native traces from segment/spanId pairs) because the
  data shape differs:
    - Zipkin spans have a flat `parentId` field instead of segment refs
    - Timestamps + durations are in microseconds (Zipkin convention)
    - Service / endpoint live on `localEndpoint.serviceName` / `name`
    - Kind is CLIENT/SERVER/PRODUCER/CONSUMER/INTERNAL

  Shape stays consistent with the native popout: dark backdrop, fixed-
  width waterfall column, span detail rail on the right when a span
  is picked. ESC closes; backdrop click closes.
-->
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { ZipkinSpan } from '@skywalking-horizon-ui/api-client';

const { t } = useI18n({ useScope: 'global' });
import { useZipkinTracePopout } from '@/layer/traces/useZipkinTracePopout';
import { useZipkinTrace } from '@/layer/traces/useZipkinTraces';
import { readAccent } from '@/utils/cssVar';

const { openTraceId, closeTrace } = useZipkinTracePopout();
const traceIdRef = computed(() => openTraceId.value);
const { spans, isLoading, error } = useZipkinTrace(traceIdRef);

// ── Span tree → flat waterfall rows ────────────────────────────────
interface WaterfallRow {
  span: ZipkinSpan;
  depth: number;
  startOffsetUs: number;
  durationUs: number;
}

/** Window bounds derived from the span set: earliest timestamp →
 *  latest end. Used to compute each row's left% / width%. */
const bounds = computed(() => {
  let t0 = Infinity;
  let t1 = -Infinity;
  for (const s of spans.value) {
    const start = s.timestamp ?? 0;
    const dur = s.duration ?? 0;
    if (start && start < t0) t0 = start;
    if (start && (start + dur) > t1) t1 = start + dur;
  }
  if (!Number.isFinite(t0)) t0 = 0;
  if (!Number.isFinite(t1) || t1 <= t0) t1 = t0 + 1;
  return { t0, t1, totalUs: t1 - t0 };
});

const waterfall = computed<WaterfallRow[]>(() => {
  const list = spans.value;
  if (list.length === 0) return [];
  // Build parent → children map. Some traces have shared spans (same
  // id reported by both sides) — Zipkin merges them via `shared:true`
  // but the wire shape still has both. We just walk parentId; if a
  // span has no parent, it's a root.
  const byParent = new Map<string, ZipkinSpan[]>();
  for (const s of list) {
    const p = s.parentId ?? '';
    if (!byParent.has(p)) byParent.set(p, []);
    byParent.get(p)!.push(s);
  }
  // Sort siblings by timestamp so the waterfall reads top-down in
  // chronological order.
  for (const arr of byParent.values()) {
    arr.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
  }
  const out: WaterfallRow[] = [];
  const { t0 } = bounds.value;
  function walk(spanId: string, depth: number): void {
    const kids = byParent.get(spanId) ?? [];
    for (const s of kids) {
      const start = s.timestamp ?? t0;
      out.push({
        span: s,
        depth,
        startOffsetUs: start - t0,
        durationUs: s.duration ?? 0,
      });
      walk(s.id, depth + 1);
    }
  }
  // Roots = spans with no parentId OR whose parentId isn't in the set.
  const spanIds = new Set(list.map((s) => s.id));
  const rootKey = '';
  const orphanRoots: ZipkinSpan[] = [];
  for (const s of list) {
    if (!s.parentId) continue;
    if (!spanIds.has(s.parentId)) orphanRoots.push(s);
  }
  // Walk the canonical roots first.
  walk(rootKey, 0);
  // Then any orphan roots (parent missing from the response).
  for (const s of orphanRoots) {
    const start = s.timestamp ?? t0;
    out.push({ span: s, depth: 0, startOffsetUs: start - t0, durationUs: s.duration ?? 0 });
    walk(s.id, 1);
  }
  return out;
});

const selectedSpanId = ref<string | null>(null);
const selectedSpan = computed<ZipkinSpan | null>(() => {
  if (!selectedSpanId.value) return null;
  return spans.value.find((s) => s.id === selectedSpanId.value) ?? null;
});
function selectSpan(s: ZipkinSpan): void {
  selectedSpanId.value = s.id;
}
function clearSpan(): void {
  selectedSpanId.value = null;
}
// Drop the selection when the trace changes.
watch(traceIdRef, () => { selectedSpanId.value = null; });

// ── Color per service so each row reads as a band ────────────────
// First entry tracks `--sw-accent` so the brand color in the trace
// waterfall follows the active theme. Rest stay constant for service
// differentiation.
function serviceColor(name: string | null | undefined): string {
  if (!name) return 'var(--sw-fg-3)';
  const palette = [
    readAccent('#f97316'), '#60a5fa', '#a78bfa', '#22d3ee',
    '#f472b6', '#34d399', '#fbbf24', '#fb7185',
  ];
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return palette[Math.abs(h) % palette.length]!;
}

// ── Formatting ────────────────────────────────────────────────────
function fmtMs(us: number): string {
  if (us < 1000) return `${us}μs`;
  if (us < 1_000_000) return `${(us / 1000).toFixed(2)}ms`;
  return `${(us / 1_000_000).toFixed(2)}s`;
}
function fmtAbsTime(usSinceEpoch: number): string {
  if (!usSinceEpoch) return '';
  return new Date(usSinceEpoch / 1000).toLocaleString();
}
function offsetPct(us: number): number {
  const total = bounds.value.totalUs || 1;
  return Math.max(0, Math.min(100, (us / total) * 100));
}
function widthPct(us: number): number {
  if (us <= 0) return 0.4; // give zero-duration spans a sliver so they render
  const total = bounds.value.totalUs || 1;
  return Math.max(0.4, Math.min(100, (us / total) * 100));
}

// ── ESC + backdrop close ─────────────────────────────────────────
function onKeydown(ev: KeyboardEvent): void {
  if (ev.key === 'Escape' && openTraceId.value) {
    ev.preventDefault();
    closeTrace();
  }
}
if (typeof window !== 'undefined') {
  window.addEventListener('keydown', onKeydown);
}
function copyTraceId(): void {
  if (!traceIdRef.value) return;
  navigator.clipboard?.writeText(traceIdRef.value).catch(() => {});
}
</script>

<template>
  <div v-if="openTraceId" class="zk-popout-backdrop" @click.self="closeTrace">
    <article class="zk-popout sw-card">
      <header class="zk-head">
        <span class="kicker">{{ t('Zipkin trace') }}</span>
        <code class="zk-tid mono">{{ openTraceId }}</code>
        <button class="sw-btn small" type="button" @click="copyTraceId">{{ t('Copy id') }}</button>
        <span v-if="isLoading" class="hint">{{ t('loading…') }}</span>
        <span v-if="error" class="hint err">{{ String(error) }}</span>
        <button class="sw-btn small ghost zk-close" type="button" @click="closeTrace">×</button>
      </header>

      <div v-if="!isLoading && spans.length === 0" class="zk-empty">
        {{ t('No spans returned for this trace.') }}
      </div>

      <div v-else class="zk-split" :class="{ 'no-detail': !selectedSpan }">
        <!-- Waterfall column -->
        <div class="zk-waterfall">
          <div class="zk-time-axis">
            <span class="t-tick first">0</span>
            <span class="t-tick">{{ fmtMs(bounds.totalUs * 0.25) }}</span>
            <span class="t-tick">{{ fmtMs(bounds.totalUs * 0.5) }}</span>
            <span class="t-tick">{{ fmtMs(bounds.totalUs * 0.75) }}</span>
            <span class="t-tick last">{{ fmtMs(bounds.totalUs) }}</span>
          </div>
          <div
            v-for="row in waterfall"
            :key="row.span.id"
            class="zk-row"
            :class="{ on: selectedSpanId === row.span.id, err: row.span.tags?.error != null }"
            @click="selectSpan(row.span)"
          >
            <span class="zk-row-label mono" :style="{ paddingLeft: row.depth * 14 + 'px' }">
              <span class="zk-row-svc" :style="{ color: serviceColor(row.span.localEndpoint?.serviceName) }">
                {{ row.span.localEndpoint?.serviceName ?? '—' }}
              </span>
              <span class="zk-row-name">{{ row.span.name || t('(unnamed)') }}</span>
            </span>
            <div class="zk-track">
              <span class="t-grid q1" /><span class="t-grid q2" /><span class="t-grid q3" />
              <div
                class="zk-bar"
                :style="{
                  left: offsetPct(row.startOffsetUs) + '%',
                  width: widthPct(row.durationUs) + '%',
                  background: serviceColor(row.span.localEndpoint?.serviceName),
                  borderColor: row.span.tags?.error != null ? 'var(--sw-err)' : 'transparent',
                }"
              />
              <span class="zk-dur mono" :style="{ left: `calc(${offsetPct(row.startOffsetUs + row.durationUs)}% + 6px)` }">
                {{ fmtMs(row.durationUs) }}
              </span>
            </div>
          </div>
        </div>

        <!-- Span detail rail -->
        <aside v-if="selectedSpan" class="zk-detail">
          <header class="zk-detail-head">
            <h5>{{ t('Span detail') }}</h5>
            <button class="sw-btn small ghost" type="button" @click="clearSpan">×</button>
          </header>
          <dl class="zk-kv">
            <dt>{{ t('Service') }}</dt>
            <dd class="mono" :style="{ color: serviceColor(selectedSpan.localEndpoint?.serviceName) }">
              {{ selectedSpan.localEndpoint?.serviceName ?? '—' }}
            </dd>
            <dt>{{ t('Name') }}</dt><dd class="mono wba">{{ selectedSpan.name ?? '—' }}</dd>
            <dt>{{ t('Kind') }}</dt><dd>{{ selectedSpan.kind ?? '—' }}</dd>
            <dt>{{ t('Span id') }}</dt><dd class="mono wba">{{ selectedSpan.id }}</dd>
            <dt v-if="selectedSpan.parentId">{{ t('Parent id') }}</dt>
            <dd v-if="selectedSpan.parentId" class="mono wba">{{ selectedSpan.parentId }}</dd>
            <dt>{{ t('Start') }}</dt><dd class="mono">{{ fmtAbsTime(selectedSpan.timestamp ?? 0) }}</dd>
            <dt>{{ t('Duration') }}</dt><dd class="mono">{{ fmtMs(selectedSpan.duration ?? 0) }}</dd>
            <dt v-if="selectedSpan.remoteEndpoint?.serviceName">{{ t('Peer') }}</dt>
            <dd v-if="selectedSpan.remoteEndpoint?.serviceName" class="mono wba">
              {{ selectedSpan.remoteEndpoint.serviceName }}
            </dd>
          </dl>
          <section v-if="selectedSpan.tags && Object.keys(selectedSpan.tags).length > 0" class="zk-tags">
            <h6>{{ t('Tags') }}</h6>
            <dl class="zk-kv">
              <template v-for="(v, k) in selectedSpan.tags" :key="k">
                <dt class="mono">{{ k }}</dt>
                <dd class="mono wba">{{ v }}</dd>
              </template>
            </dl>
          </section>
          <section
            v-if="selectedSpan.annotations && selectedSpan.annotations.length > 0"
            class="zk-annotations"
          >
            <h6>{{ t('Annotations') }}</h6>
            <ul>
              <li v-for="(a, i) in selectedSpan.annotations" :key="i" class="mono">
                <span class="dim">{{ fmtAbsTime(a.timestamp) }}</span>
                <span class="zk-ann-val">{{ a.value }}</span>
              </li>
            </ul>
          </section>
        </aside>
      </div>
    </article>
  </div>
</template>

<style scoped>
.zk-popout-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
  padding: 24px;
}
.zk-popout {
  width: min(1200px, 96vw);
  max-height: 90vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.zk-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--sw-line);
}
.zk-tid { color: var(--sw-fg-2); font-size: 11px; }
.zk-close { margin-left: auto; }
.hint { font-size: 10.5px; color: var(--sw-fg-3); }
.hint.err { color: var(--sw-err); }
.zk-empty {
  padding: 32px;
  text-align: center;
  color: var(--sw-fg-3);
  font-size: 12px;
}

.zk-split {
  display: grid;
  grid-template-columns: 1fr 360px;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}
.zk-split.no-detail { grid-template-columns: 1fr; }

.zk-waterfall {
  overflow-y: auto;
  border-right: 1px solid var(--sw-line);
  padding: 0;
}
.zk-time-axis {
  position: sticky;
  top: 0;
  z-index: 10;
  display: flex;
  justify-content: space-between;
  padding: 6px 12px;
  /* Solid background + shadow so the axis cleanly overlays the
   * scrolling rows underneath rather than letting the first row's
   * bar bleed through (sibling rendering on scroll). */
  background-color: var(--sw-bg-1);
  border-bottom: 1px solid var(--sw-line);
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.35);
  font-size: 10px;
  color: var(--sw-fg-3);
  font-family: var(--sw-mono);
}
.zk-row {
  display: grid;
  grid-template-columns: 280px 1fr;
  align-items: center;
  gap: 8px;
  padding: 3px 12px;
  border-bottom: 1px solid var(--sw-line);
  cursor: pointer;
}
.zk-row:hover { background: var(--sw-bg-2); }
.zk-row.on { background: var(--sw-bg-3); }
.zk-row.err { box-shadow: inset 3px 0 0 var(--sw-err); }
.zk-row-label {
  display: inline-flex;
  align-items: baseline;
  gap: 6px;
  font-size: 10.5px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}
.zk-row-svc {
  flex: 0 0 auto;
  font-weight: 700;
  max-width: 100px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.zk-row-name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--sw-fg-1);
}
.zk-track {
  position: relative;
  height: 18px;
  background: var(--sw-bg-1);
  border-radius: 2px;
  overflow: visible;
}
.t-grid {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 1px;
  background: var(--sw-line);
  opacity: 0.55;
  pointer-events: none;
}
.t-grid.q1 { left: 25%; }
.t-grid.q2 { left: 50%; }
.t-grid.q3 { left: 75%; }
.zk-bar {
  position: absolute;
  top: 2px;
  bottom: 2px;
  border-radius: 2px;
  border: 1px solid transparent;
}
.zk-dur {
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  font-size: 10px;
  color: var(--sw-fg-2);
  pointer-events: none;
  white-space: nowrap;
}

.zk-detail {
  overflow-y: auto;
  padding: 12px 14px;
}
.zk-detail-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}
.zk-detail-head h5 {
  margin: 0;
  font-size: 12px;
  color: var(--sw-fg-0);
}
.zk-tags, .zk-annotations { margin-top: 12px; }
.zk-tags h6, .zk-annotations h6 {
  margin: 0 0 6px;
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--sw-fg-3);
  font-weight: 600;
}
.zk-kv {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 4px 12px;
  font-size: 11px;
}
.zk-kv dt { color: var(--sw-fg-3); }
.zk-kv dd { margin: 0; color: var(--sw-fg-1); }
.zk-kv dd.wba { word-break: break-all; }
.zk-annotations ul {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.zk-annotations li {
  display: grid;
  grid-template-columns: 110px 1fr;
  gap: 8px;
  font-size: 10.5px;
}
.zk-annotations .dim { color: var(--sw-fg-3); }
.zk-ann-val { color: var(--sw-fg-1); word-break: break-all; }
.mono { font-family: var(--sw-mono); }
.kicker {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--sw-accent);
  font-weight: 600;
}
.sw-btn.primary {
  background: var(--sw-accent);
  color: var(--sw-bg-0);
  border: none;
  height: 26px;
  padding: 0 14px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
}
.sw-btn.small { height: 24px; padding: 0 10px; font-size: 11px; }
.sw-btn.ghost { background: transparent; border: 1px solid var(--sw-line-2); color: var(--sw-fg-2); }
</style>
