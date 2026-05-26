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
  Global trace popout — opened by URL `?traceId=<id>` from anywhere
  in the app (shareable links, cross-trace refs, log-row trace links,
  alarm payloads). Distinct from the per-layer trace tab's *in-page*
  detail layout: the popout is single-focus + horizontal split, while
  the in-page detail uses a folded list rail + tabbed multi-view.

  Popout layout (intentionally different from in-page):
    - Waterfall on the left (always List view — no Tree/Table/Stats
      tabs; the popout is a glance-link experience).
    - Span detail in a sticky right panel (no nested modal). Click
      a span row in the waterfall → the right panel updates. Cross-
      trace refs there hot-swap the popout to the linked trace.
-->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { NativeSpan, TraceAttachedEvent, TraceLogEntry } from '@/api/client';
import { useTraceDetail } from '@/layer/traces/useLayerTraces';
import { useTracePopout } from '@/layer/traces/useTracePopout';
import { componentIconOrNull } from '@/layer/service-map/useTopologyIcons';
import { fmtMetric } from '@/utils/formatters';

const { t } = useI18n({ useScope: 'global' });
const { openTraceId, openTraceAtMs, openTrace, closeTrace } = useTracePopout();

const sourceRef = computed<'native'>(() => 'native');
const traceIdRef = computed<string | null>(() => openTraceId.value);
// `openTraceAtMs` is set by callers that know the trace's approximate
// time (e.g. clicking the trace icon on a log row). The detail
// composable widens the BanyanDB lookup window around it so cold-tier
// trace IDs resolve.
const traceAtRef = computed<number | null>(() => openTraceAtMs.value);
const { nativeDetail, isFetching } = useTraceDetail(traceIdRef, sourceRef, traceAtRef);

const spans = computed<NativeSpan[]>(() => nativeDetail.value?.spans ?? []);

// Reset selected span when the trace changes (cross-trace ref jump).
const selectedSpan = ref<NativeSpan | null>(null);
watch(traceIdRef, () => { selectedSpan.value = null; });

interface WaterfallRow {
  span: NativeSpan;
  depth: number;
  startOffset: number;
  duration: number;
}
const waterfall = computed<WaterfallRow[]>(() => {
  const s = spans.value;
  if (s.length === 0) return [];
  const minStart = Math.min(...s.map((x) => x.startTime));
  const key = (segId: string, spanId: number) => `${segId}/${spanId}`;
  const byKey = new Map(s.map((x) => [key(x.segmentId, x.spanId), x]));
  const childMap = new Map<string, NativeSpan[]>();
  const roots: NativeSpan[] = [];
  for (const x of s) {
    if (x.parentSpanId === -1) {
      const r = x.refs?.[0];
      const pk = r ? key(r.parentSegmentId, r.parentSpanId) : null;
      if (pk && byKey.has(pk)) {
        const arr = childMap.get(pk) ?? [];
        arr.push(x);
        childMap.set(pk, arr);
      } else {
        roots.push(x);
      }
    } else {
      const pk = key(x.segmentId, x.parentSpanId);
      const arr = childMap.get(pk) ?? [];
      arr.push(x);
      childMap.set(pk, arr);
    }
  }
  const out: WaterfallRow[] = [];
  function walk(x: NativeSpan, depth: number): void {
    const ck = key(x.segmentId, x.spanId);
    const kids = childMap.get(ck) ?? [];
    out.push({
      span: x,
      depth,
      startOffset: x.startTime - minStart,
      duration: Math.max(0, x.endTime - x.startTime),
    });
    for (const c of kids) walk(c, depth + 1);
  }
  for (const r of roots) walk(r, 0);
  return out;
});
const totalDuration = computed(() => {
  const r = waterfall.value;
  if (r.length === 0) return 0;
  return Math.max(...r.map((x) => x.startOffset + x.duration));
});
const rootStart = computed(() => {
  const s = spans.value;
  return s.length > 0 ? Math.min(...s.map((x) => x.startTime)) : null;
});

// Service color palette (matches the trace tab so the operator sees
// the same colours across the in-page detail and the popout).
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
  return (h >>> 0);
}
const serviceColors = computed<Map<string, string>>(() => {
  const m = new Map<string, string>();
  for (const s of spans.value) {
    if (!m.has(s.serviceCode)) {
      m.set(s.serviceCode, SERVICE_PALETTE[hashString(s.serviceCode) % SERVICE_PALETTE.length]);
    }
  }
  return m;
});
function serviceColor(c: string): string {
  return serviceColors.value.get(c) ?? 'var(--sw-fg-2)';
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
function fmtMs(v: number | null | undefined): string {
  if (v === null || v === undefined) return '—';
  return `${fmtMetric(v)} ms`;
}
function fmtDateTime(ts: number | null | undefined): string {
  if (!ts || !Number.isFinite(ts)) return '—';
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function fmtAttachedTs(t: { seconds: number; nanos: number }): string {
  const ms = t.seconds * 1000 + t.nanos / 1_000_000;
  return fmtDateTime(ms) + '.' + String(t.nanos).padStart(9, '0').slice(0, 6);
}

// Copy affordances.
const copyFlash = ref<'id' | 'url' | null>(null);
let copyFlashTimer: ReturnType<typeof setTimeout> | null = null;
function flashCopy(kind: 'id' | 'url'): void {
  copyFlash.value = kind;
  if (copyFlashTimer) clearTimeout(copyFlashTimer);
  copyFlashTimer = setTimeout(() => { copyFlash.value = null; }, 1400);
}
function copyId(): void {
  if (!openTraceId.value) return;
  navigator.clipboard?.writeText(openTraceId.value).then(() => flashCopy('id'), () => {});
}
function copyShareableUrl(): void {
  if (!openTraceId.value) return;
  navigator.clipboard?.writeText(window.location.href).then(() => flashCopy('url'), () => {});
}

function selectSpan(s: NativeSpan): void { selectedSpan.value = s; }
function clearSpan(): void { selectedSpan.value = null; }

/** Esc-to-close. If a span is selected the first Esc closes the
 *  side panel (keeps the popout open). A second Esc — or Esc with
 *  no span selected — closes the popout itself. Always listening
 *  while the component is mounted; the no-op guard prevents
 *  intercepting Esc when the popout isn't open. */
function onKeyDown(e: KeyboardEvent): void {
  if (e.key !== 'Escape') return;
  if (!openTraceId.value) return;
  if (selectedSpan.value) {
    selectedSpan.value = null;
    e.preventDefault();
    e.stopPropagation();
  } else {
    closeTrace();
    e.preventDefault();
    e.stopPropagation();
  }
}
onMounted(() => window.addEventListener('keydown', onKeyDown, true));
onBeforeUnmount(() => window.removeEventListener('keydown', onKeyDown, true));
function isSelfRef(refTraceId: string): boolean { return refTraceId === openTraceId.value; }
function jumpToTrace(id: string): void { openTrace(id); }
function nativeSpanError(s: NativeSpan): boolean { return s.isError; }
</script>

<template>
  <div v-if="openTraceId" class="tp-backdrop" @click.self="closeTrace">
    <article class="tp-card sw-card">
      <header class="tp-head">
        <div class="tp-title">
          <span class="dim">{{ t('Trace') }}</span>
          <span class="mono trace-id-text" :title="openTraceId">{{ openTraceId }}</span>
          <button class="sw-btn small ghost copy-btn" type="button" :title="t('Copy trace id')" @click="copyId">⧉ {{ t('id') }}</button>
          <button class="sw-btn small ghost copy-btn" type="button" :title="t('Copy shareable URL')" @click="copyShareableUrl">⧉ {{ t('url') }}</button>
          <transition name="copy-flash">
            <span v-if="copyFlash" class="copy-flash-chip">{{ copyFlash === 'url' ? t('url copied') : t('id copied') }}</span>
          </transition>
          <span v-if="isFetching" class="hint">{{ t('loading…') }}</span>
        </div>
        <button class="sw-btn small ghost" type="button" :title="t('Close')" @click="closeTrace">×</button>
      </header>

      <div class="tp-kpis">
        <div><div class="kpi-label">{{ t('started') }}</div><div class="kpi-val">{{ fmtDateTime(rootStart) }}</div></div>
        <div><div class="kpi-label">{{ t('duration') }}</div><div class="kpi-val">{{ fmtMs(totalDuration) }}</div></div>
        <div><div class="kpi-label">{{ t('spans') }}</div><div class="kpi-val">{{ waterfall.length }}</div></div>
        <div><div class="kpi-label">{{ t('services') }}</div><div class="kpi-val">{{ serviceColors.size }}</div></div>
      </div>

      <div v-if="serviceColors.size > 0" class="tp-svc-legend">
        <span v-for="[code, color] in serviceColors" :key="code" class="svc-chip">
          <span class="svc-swatch" :style="{ background: color }" />
          <span class="mono">{{ code }}</span>
        </span>
      </div>

      <!-- Body: waterfall (left) + sticky span detail panel (right).
           Distinct from the per-layer trace tab's modal-on-tabbed
           detail; here the right panel is always visible, swapping
           contents on span row click. -->
      <div class="tp-body">
        <div v-if="waterfall.length === 0 && !isFetching" class="tp-empty">{{ t('no span data') }}</div>
        <div v-else class="tp-split" :class="{ 'no-selection': !selectedSpan }">
          <div class="tp-waterfall">
            <!-- Time axis at the top of the waterfall column. -->
            <div class="tp-time-axis">
              <span class="t-tick first">0</span>
              <span class="t-tick">{{ fmtMs(totalDuration * 0.25) }}</span>
              <span class="t-tick">{{ fmtMs(totalDuration * 0.5) }}</span>
              <span class="t-tick">{{ fmtMs(totalDuration * 0.75) }}</span>
              <span class="t-tick last">{{ fmtMs(totalDuration) }}</span>
            </div>
            <div
              v-for="row in waterfall"
              :key="`${row.span.segmentId}/${row.span.spanId}`"
              class="tp-row"
              :class="{ err: row.span.isError, on: selectedSpan && selectedSpan.segmentId === row.span.segmentId && selectedSpan.spanId === row.span.spanId }"
              @click="selectSpan(row.span)"
            >
              <div class="tp-track">
                <span class="t-grid q1" />
                <span class="t-grid q2" />
                <span class="t-grid q3" />
                <div
                  class="tp-bar"
                  :style="{
                    left: totalDuration > 0 ? (row.startOffset / totalDuration * 100) + '%' : '0%',
                    width: totalDuration > 0 ? Math.max(0.8, row.duration / totalDuration * 100) + '%' : '0%',
                    background: serviceColor(row.span.serviceCode),
                    borderColor: row.span.isError ? 'var(--sw-err)' : 'transparent',
                  }"
                >
                  <span class="bar-inner">
                    <span
                      class="status-flag sm"
                      :class="row.span.isError ? 'flag-err' : 'flag-ok'"
                      :title="row.span.isError ? t('Span errored') : t('Span OK')"
                    ><span class="flag-dot" /></span>
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
                    <span class="bar-text mono">
                      <span class="bar-svc" :title="row.span.serviceCode">{{ row.span.serviceCode }}</span>
                      <span class="bar-name" :title="row.span.endpointName || row.span.component || row.span.peer || '—'">{{ row.span.endpointName || row.span.component || row.span.peer || '—' }}</span>
                    </span>
                    <span
                      v-if="row.span.attachedEvents && row.span.attachedEvents.length > 0"
                      class="evt-badge inside"
                      :title="t('{n} attached events', { n: row.span.attachedEvents.length })"
                    >
                      <span class="evt-flag">⚑</span>
                      <span class="evt-count">{{ row.span.attachedEvents.length }}</span>
                    </span>
                  </span>
                </div>
                <span
                  class="bar-dur-outside mono"
                  :style="{
                    left: totalDuration > 0
                      ? `calc(${((row.startOffset + row.duration) / totalDuration) * 100}% + 6px)`
                      : '0%',
                  }"
                >{{ fmtMs(row.duration) }}</span>
              </div>
            </div>
          </div>

          <!-- Span detail panel — replaces the nested modal used in
               the per-layer trace tab. Shown when a span is picked;
               hidden otherwise to let the waterfall claim full width. -->
          <aside v-if="selectedSpan" class="tp-span-panel">
            <header class="tp-span-head">
              <h5>{{ t('Span detail') }}</h5>
              <button class="sw-btn small ghost" type="button" @click="clearSpan">×</button>
            </header>
            <div class="tp-span-body">
              <section class="sd-section">
                <h6>{{ t('Meta') }}</h6>
                <dl class="kv">
                  <dt>{{ t('Service') }}</dt>
                  <dd class="mono" :style="{ color: serviceColor(selectedSpan.serviceCode) }">
                    <span class="svc-swatch inline" :style="{ background: serviceColor(selectedSpan.serviceCode) }" />
                    {{ selectedSpan.serviceCode }}
                  </dd>
                  <dt>{{ t('Instance') }}</dt><dd class="mono wba">{{ selectedSpan.serviceInstanceName }}</dd>
                  <dt>{{ t('Endpoint') }}</dt><dd class="mono wba">{{ selectedSpan.endpointName || '—' }}</dd>
                  <dt>{{ t('Type') }}</dt><dd><span class="tp-kind" :style="{ color: kindColor(selectedSpan.type) }">{{ selectedSpan.type }}</span></dd>
                  <dt>{{ t('Component') }}</dt><dd class="mono">{{ selectedSpan.component || '—' }}</dd>
                  <dt>{{ t('Peer') }}</dt><dd class="mono wba">{{ selectedSpan.peer || '—' }}</dd>
                  <dt>{{ t('Layer') }}</dt><dd class="mono dim">{{ selectedSpan.layer || '—' }}</dd>
                  <dt>{{ t('Start') }}</dt><dd class="mono">{{ fmtDateTime(selectedSpan.startTime) }}</dd>
                  <dt>{{ t('Duration') }}</dt><dd class="mono">{{ fmtMs(selectedSpan.endTime - selectedSpan.startTime) }}</dd>
                  <dt>{{ t('Error') }}</dt><dd><span class="status-flag" :class="nativeSpanError(selectedSpan) ? 'flag-err' : 'flag-ok'"><span class="flag-dot" />{{ nativeSpanError(selectedSpan) ? t('true') : t('false') }}</span></dd>
                </dl>
              </section>
              <section
                v-if="(selectedSpan.refs ?? []).some((r) => !isSelfRef(r.traceId))"
                class="sd-section"
              >
                <h6>{{ t('Cross-trace refs') }}</h6>
                <table class="kv-table">
                  <thead><tr><th>{{ t('Trace ID') }}</th><th class="num">{{ t('Parent span') }}</th></tr></thead>
                  <tbody>
                    <template v-for="(r, i) in selectedSpan.refs" :key="i">
                      <tr v-if="!isSelfRef(r.traceId)">
                        <td>
                          <button class="trace-link mono" type="button" @click="jumpToTrace(r.traceId)">{{ r.traceId }} ↗</button>
                        </td>
                        <td class="num mono">{{ r.parentSpanId }}</td>
                      </tr>
                    </template>
                  </tbody>
                </table>
              </section>
              <section v-if="selectedSpan.tags && selectedSpan.tags.length > 0" class="sd-section">
                <h6>{{ t('Tags') }}</h6>
                <dl class="kv">
                  <template v-for="(tag, i) in selectedSpan.tags" :key="i">
                    <dt class="mono">{{ tag.key }}</dt>
                    <dd class="mono wba">{{ tag.value }}</dd>
                  </template>
                </dl>
              </section>
              <section v-if="selectedSpan.logs && selectedSpan.logs.length > 0" class="sd-section">
                <h6>{{ t('Logs') }}</h6>
                <div v-for="(log, i) in (selectedSpan.logs as TraceLogEntry[])" :key="i" class="span-log">
                  <div class="span-log-time mono dim">{{ fmtDateTime(log.time) }}</div>
                  <dl class="kv">
                    <template v-for="(d, j) in log.data" :key="j">
                      <dt class="mono">{{ d.key }}</dt>
                      <dd><pre class="mono pre wba">{{ d.value }}</pre></dd>
                    </template>
                  </dl>
                </div>
              </section>
              <section v-if="selectedSpan.attachedEvents && selectedSpan.attachedEvents.length > 0" class="sd-section">
                <h6>{{ t('Attached Events') }}</h6>
                <div v-for="(ev, i) in (selectedSpan.attachedEvents as TraceAttachedEvent[])" :key="i" class="span-event">
                  <div class="span-event-head">
                    <span class="mono">{{ ev.event }}</span>
                    <span class="dim mono">{{ fmtAttachedTs(ev.startTime) }} → {{ fmtAttachedTs(ev.endTime) }}</span>
                  </div>
                  <dl v-if="ev.summary && ev.summary.length > 0" class="kv">
                    <template v-for="(s, j) in ev.summary" :key="`s${j}`">
                      <dt class="mono">{{ s.key }}</dt>
                      <dd class="mono wba">{{ s.value }}</dd>
                    </template>
                  </dl>
                  <dl v-if="ev.tags && ev.tags.length > 0" class="kv">
                    <template v-for="(tag, j) in ev.tags" :key="`t${j}`">
                      <dt class="mono dim">{{ t('tag') }} · {{ tag.key }}</dt>
                      <dd class="mono wba">{{ tag.value }}</dd>
                    </template>
                  </dl>
                </div>
              </section>
            </div>
          </aside>
        </div>
      </div>
    </article>
  </div>
</template>

<style scoped>
.tp-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.66);
  z-index: 999;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 4vh 0;
}
.tp-card {
  width: 80vw;
  height: 92vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.tp-head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--sw-line);
  flex: 0 0 auto;
  flex-wrap: wrap;
}
.tp-title { display: flex; align-items: center; gap: 8px; flex: 1; min-width: 0; }
.tp-title .dim { font-size: 12px; font-weight: 500; color: var(--sw-fg-3); }
.trace-id-text {
  font-family: var(--sw-mono);
  color: var(--sw-fg-1);
  font-size: 12px;
  max-width: 360px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tp-kpis {
  display: flex;
  gap: 28px;
  padding: 8px 14px;
  border-bottom: 1px solid var(--sw-line);
  flex: 0 0 auto;
}
.kpi-label {
  font-size: 9.5px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--sw-fg-3);
}
.kpi-val {
  font-family: var(--sw-mono);
  font-size: 14px;
  color: var(--sw-fg-0);
  font-weight: 700;
}
.tp-svc-legend {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  padding: 6px 14px;
  border-bottom: 1px solid var(--sw-line);
  background: var(--sw-bg-1);
  flex: 0 0 auto;
}
.svc-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 10.5px;
  color: var(--sw-fg-2);
  padding: 1px 6px 1px 4px;
  border: 1px solid var(--sw-line-2);
  border-radius: 10px;
  background: var(--sw-bg-2);
}
.svc-swatch {
  width: 8px;
  height: 8px;
  border-radius: 2px;
  flex: 0 0 auto;
}
.svc-swatch.inline {
  display: inline-block;
  margin-right: 4px;
  vertical-align: middle;
}
.tp-empty {
  padding: 40px;
  text-align: center;
  color: var(--sw-fg-3);
  font-size: 12px;
}
.tp-body { flex: 1; overflow: hidden; min-height: 0; display: flex; }

/* Horizontal split: waterfall + sticky span panel. */
.tp-split {
  display: grid;
  grid-template-columns: 1fr 420px;
  gap: 0;
  flex: 1;
  min-height: 0;
  width: 100%;
}
.tp-split.no-selection { grid-template-columns: 1fr; }

/* Waterfall */
.tp-waterfall {
  padding: 6px 0;
  overflow-y: auto;
  min-width: 0;
}
.tp-time-axis {
  position: sticky;
  top: 0;
  /* High enough to clear the `.tp-bar` (position: absolute) inside
   * scrolled rows; z-index 2 was being rendered behind the bars on
   * scroll because absolute-positioned siblings can paint above
   * sticky in some webkit stacking quirks. 10 is plenty. */
  z-index: 10;
  display: flex;
  justify-content: space-between;
  padding: 6px 12px;
  /* Solid color (not shorthand) so the row content underneath is
   * fully obscured when the axis sticks during scroll. */
  background-color: var(--sw-bg-1);
  border-bottom: 1px solid var(--sw-line);
  /* Soft shadow under the axis once scrolled — gives the axis a
   * "floating header" feel and visually separates it from the first
   * row even on dense traces. */
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.35);
  font-family: var(--sw-mono);
  font-size: 10px;
  color: var(--sw-fg-3);
}
.t-tick { white-space: nowrap; }
.t-tick.first { text-align: left; }
.t-tick.last { text-align: right; }
.tp-row {
  padding: 3px 12px;
  cursor: pointer;
}
.tp-row:hover { background: var(--sw-bg-2); }
.tp-row.err { background: rgba(239, 68, 68, 0.06); }
.tp-row.on { background: var(--sw-accent-soft); }
.tp-track {
  position: relative;
  height: 22px;
  background: transparent;
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
.tp-bar {
  position: absolute;
  top: 2px;
  bottom: 2px;
  border-radius: 3px;
  border: 1px solid transparent;
  display: flex;
  align-items: center;
  overflow: hidden;
  cursor: pointer;
  transition: filter 0.12s ease;
}
.tp-bar:hover { filter: brightness(1.12); }
.bar-inner {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 0 6px;
  height: 100%;
  width: 100%;
  min-width: 0;
}
.bar-text {
  display: inline-flex;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
  flex: 1 1 auto;
  overflow: hidden;
  color: var(--sw-bg-0);
  text-shadow: 0 0 1px rgba(0, 0, 0, 0.25);
}
.bar-svc {
  font-weight: 700;
  font-size: 10.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 0 1 auto;
  max-width: 40%;
  opacity: 0.9;
}
.bar-name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  font-weight: 500;
}
.comp-icon {
  width: 18px;
  height: 18px;
  flex: 0 0 auto;
  object-fit: contain;
  background: transparent;
}
.comp-icon-generic { color: var(--sw-fg-2); }
.bar-inner .comp-icon-generic { color: rgba(0, 0, 0, 0.72); }
.bar-inner .status-flag.sm {
  background: rgba(255, 255, 255, 0.35);
  color: var(--sw-bg-0);
}
.bar-inner .status-flag.flag-err {
  background: var(--sw-err);
  color: #fff;
}
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
.evt-badge.inside {
  background: rgba(255, 255, 255, 0.85);
  color: var(--sw-bg-0);
}
.evt-flag { font-size: 10px; line-height: 1; }
.evt-count { font-family: var(--sw-mono); }
.bar-dur-outside {
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  font-size: 10px;
  color: var(--sw-fg-2);
  white-space: nowrap;
  pointer-events: none;
}

/* Span panel (sticky right side) */
.tp-span-panel {
  border-left: 1px solid var(--sw-line);
  background: var(--sw-bg-1);
  display: flex;
  flex-direction: column;
  min-width: 0;
  overflow: hidden;
}
.tp-span-head {
  display: flex;
  align-items: center;
  padding: 8px 12px;
  border-bottom: 1px solid var(--sw-line);
  flex: 0 0 auto;
}
.tp-span-head h5 {
  margin: 0;
  font-size: 11.5px;
  font-weight: 600;
  color: var(--sw-fg-0);
  flex: 1;
}
.tp-span-body {
  flex: 1;
  overflow-y: auto;
  padding: 10px 12px 14px;
}
.sd-section { margin-bottom: 14px; }
.sd-section h6 {
  margin: 0 0 6px;
  font-size: 9.5px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--sw-accent);
  font-weight: 700;
}
.kv {
  display: grid;
  grid-template-columns: 100px 1fr;
  gap: 4px 10px;
  margin: 0;
  font-size: 11px;
}
.kv dt { color: var(--sw-fg-3); font-size: 10.5px; }
.kv dd { margin: 0; color: var(--sw-fg-1); }
.kv-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 11px;
}
.kv-table th {
  text-align: left;
  font-size: 9.5px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--sw-fg-3);
  font-weight: 600;
  padding: 4px 6px;
  border-bottom: 1px solid var(--sw-line);
}
.kv-table th.num { text-align: right; }
.kv-table td { padding: 4px 6px; border-bottom: 1px solid var(--sw-line); }
.kv-table td.num { text-align: right; }
.trace-link {
  background: transparent;
  border: none;
  color: var(--sw-cyan);
  cursor: pointer;
  padding: 0;
  font: inherit;
  text-decoration: underline;
  text-underline-offset: 2px;
}
.trace-link:hover { color: var(--sw-accent); }
.span-log, .span-event {
  border: 1px solid var(--sw-line);
  border-radius: 4px;
  padding: 6px 10px;
  margin-bottom: 6px;
  background: var(--sw-bg-0);
}
.span-log-time { font-size: 10px; margin-bottom: 4px; }
.span-event-head {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  font-size: 11px;
  margin-bottom: 4px;
}
.pre {
  background: var(--sw-bg-2);
  padding: 4px 6px;
  border-radius: 3px;
  font-size: 10.5px;
  margin: 0;
  white-space: pre-wrap;
  word-break: break-all;
  color: var(--sw-fg-1);
}

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
}
.status-flag.flag-ok { background: rgba(34, 197, 94, 0.14); color: var(--sw-ok); }
.status-flag.flag-err { background: rgba(239, 68, 68, 0.18); color: var(--sw-err); }

/* Copy affordance */
.copy-btn:active { transform: scale(0.94); }
.copy-flash-chip {
  display: inline-flex;
  align-items: center;
  height: 18px;
  padding: 0 8px;
  border-radius: 9px;
  font-size: 9.5px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  background: rgba(34, 197, 94, 0.18);
  color: var(--sw-ok);
}
.copy-flash-enter-from { opacity: 0; transform: translateX(-4px); }
.copy-flash-enter-active { transition: opacity 0.18s ease, transform 0.18s ease; }
.copy-flash-leave-to { opacity: 0; transform: translateX(4px); }
.copy-flash-leave-active { transition: opacity 0.3s ease, transform 0.3s ease; }

.dim { color: var(--sw-fg-3); }
.mono { font-family: var(--sw-mono); }
.wba { word-break: break-all; }
.hint { font-size: 10.5px; color: var(--sw-fg-3); }
.sw-btn.small { height: 24px; padding: 0 10px; font-size: 11px; }
.sw-btn.ghost {
  background: transparent;
  border: 1px solid var(--sw-line-2);
  color: var(--sw-fg-2);
  cursor: pointer;
}
</style>
