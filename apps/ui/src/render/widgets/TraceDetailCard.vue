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
  Shared trace-detail card. The full SkyWalking-native trace detail
  used by BOTH the per-layer Traces tab and the cross-layer Trace
  inspect view. Given a flat NativeSpan[] it renders:
    • a header — trace-id (a select when the segment spans more than
      one trace id), copy-id / copy-url buttons, the
      Default / Tree / Statistics view toggle, and a × close,
    • KPIs (started / duration / spans / services),
    • a per-service colour legend,
    • the Default service-striped waterfall (TraceWaterfallView),
    • the Tree view (TraceTreeView — d3 horizontal hierarchical layout),
    • the Statistics view (TraceStatsView — per-span-name roll-up),
    • a span-detail modal (SpanDetailModal) opened by clicking a row /
      tree node.

  The card owns its own view-mode, span-modal and copy-flash state;
  each sub-view owns its own sort / zoom state — callers only feed the
  trace + emit the close.

  Props:
    spans     — the flat NativeSpan[] of the resolved trace.
    traceId   — the active trace id (drives the header label + url copy).
    traceIds  — every trace id carried by the selected segment; >1
                renders the trace-id select.
    loading   — show a "loading…" hint in the header while detail fetches.

  Emits:
    close            — the × was clicked.
    change-trace-id  — a different id was picked from the multi-id select.
    update:modalOpen — the span-detail modal opened / closed. Hosts use
                       this to order their own Esc cascade (close the
                       modal first, then the inline detail).
-->
<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { NativeSpan } from '@/api/client';
import TraceWaterfallView from './TraceWaterfallView.vue';
import TraceTreeView from './TraceTreeView.vue';
import TraceStatsView from './TraceStatsView.vue';
import SpanDetailModal from './SpanDetailModal.vue';
import { buildServiceColors, fmtMs, fmtDateTime } from './traceDetailShared';

const { t } = useI18n({ useScope: 'global' });

const props = withDefaults(
  defineProps<{
    spans: NativeSpan[];
    traceId: string | null;
    traceIds: string[];
    loading?: boolean;
  }>(),
  { loading: false },
);
const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'change-trace-id', id: string): void;
  (e: 'update:modalOpen', open: boolean): void;
}>();
/** Public method so a host can close the span-detail modal as the
 *  first step of its own Esc cascade. */
function closeSpanModal(): void { openSpan.value = null; }
defineExpose({ closeSpanModal });

const nativeSpans = computed<NativeSpan[]>(() => props.spans);

const copyFlash = ref<'id' | 'url' | null>(null);
let copyFlashTimer: ReturnType<typeof setTimeout> | null = null;
function flashCopy(kind: 'id' | 'url'): void {
  copyFlash.value = kind;
  if (copyFlashTimer) clearTimeout(copyFlashTimer);
  copyFlashTimer = setTimeout(() => { copyFlash.value = null; }, 1400);
}
function copyTraceId(): void {
  if (!props.traceId) return;
  navigator.clipboard?.writeText(props.traceId).then(() => flashCopy('id'), () => {});
}
function copyShareableUrl(): void {
  if (!props.traceId) return;
  const url = new URL(window.location.href);
  url.searchParams.set('traceId', props.traceId);
  // Tag the source so Trace inspect (one route, two sources) reopens it as
  // native rather than Zipkin.
  url.searchParams.set('source', 'native');
  navigator.clipboard?.writeText(url.toString()).then(() => flashCopy('url'), () => {});
}
onBeforeUnmount(() => { if (copyFlashTimer) clearTimeout(copyFlashTimer); });

type ViewMode = 'default' | 'tree' | 'statistics';
const viewMode = ref<ViewMode>('default');

const serviceColors = computed<Map<string, string>>(() => buildServiceColors(nativeSpans.value));

const nativeWaterfallDuration = computed(() => {
  const spans = nativeSpans.value;
  if (spans.length === 0) return 0;
  const minStart = Math.min(...spans.map((s) => s.startTime));
  return Math.max(...spans.map((s) => (s.startTime - minStart) + Math.max(0, s.endTime - s.startTime)));
});
const nativeRootStart = computed(() => {
  const spans = nativeSpans.value;
  return spans.length > 0 ? Math.min(...spans.map((s) => s.startTime)) : null;
});

// The modal's open/close is surfaced to the host (`update:modalOpen`)
// so the host owns the single Esc cascade (modal first, then inline
// detail) — avoiding two competing capture-phase window listeners.
const openSpan = ref<NativeSpan | null>(null);
function openNativeSpan(s: NativeSpan): void { openSpan.value = s; }
function closeSpan(): void { openSpan.value = null; }
watch(openSpan, (s) => emit('update:modalOpen', !!s));
</script>

<template>
  <article class="tr-detail sw-card">
    <header class="tr-detail-head">
      <div class="tr-detail-title">
        <span class="dim">{{ t('trace') }}</span>
        <select v-if="traceIds.length > 1" :value="traceId ?? ''" class="trace-id-select mono" @change="emit('change-trace-id', ($event.target as HTMLSelectElement).value)">
          <option v-for="id in traceIds" :key="id" :value="id">{{ id }}</option>
        </select>
        <span v-else class="mono trace-id-text" :title="traceId ?? ''">{{ traceId }}</span>
        <button class="sw-btn small ghost copy-btn" type="button" :title="t('Copy trace id')" @click="copyTraceId">⧉ {{ t('id') }}</button>
        <button class="sw-btn small ghost copy-btn" type="button" :title="t('Copy shareable URL')" @click="copyShareableUrl">⧉ {{ t('url') }}</button>
        <transition name="copy-flash">
          <span v-if="copyFlash" class="copy-flash-chip">{{ copyFlash === 'url' ? t('url copied') : t('id copied') }}</span>
        </transition>
      </div>
      <div class="tr-detail-tools">
        <span v-if="loading" class="hint">{{ t('loading…') }}</span>
        <div class="view-toggle">
          <button :class="['vt-btn', { on: viewMode === 'default' }]" type="button" @click="viewMode = 'default'">{{ t('Default') }}</button>
          <button :class="['vt-btn', { on: viewMode === 'tree' }]" type="button" @click="viewMode = 'tree'">{{ t('Tree') }}</button>
          <button :class="['vt-btn', { on: viewMode === 'statistics' }]" type="button" @click="viewMode = 'statistics'">{{ t('Statistics') }}</button>
        </div>
        <button class="sw-btn small ghost" type="button" :title="t('Back to list')" @click="emit('close')">×</button>
      </div>
    </header>

    <div class="tr-kpis">
      <div><div class="kpi-label">{{ t('started') }}</div><div class="kpi-val">{{ fmtDateTime(nativeRootStart) }}</div></div>
      <div><div class="kpi-label">{{ t('duration') }}</div><div class="kpi-val">{{ fmtMs(nativeWaterfallDuration) }}</div></div>
      <div><div class="kpi-label">{{ t('spans') }}</div><div class="kpi-val">{{ nativeSpans.length }}</div></div>
      <div><div class="kpi-label">{{ t('services') }}</div><div class="kpi-val">{{ serviceColors.size }}</div></div>
    </div>

    <div v-if="serviceColors.size > 0" class="tr-svc-legend">
      <span v-for="[code, color] in serviceColors" :key="code" class="svc-chip">
        <span class="svc-swatch" :style="{ background: color }" />
        <span class="mono">{{ code }}</span>
      </span>
    </div>

    <TraceWaterfallView
      v-if="viewMode === 'default'"
      :spans="nativeSpans"
      @select-span="openNativeSpan"
    />
    <TraceTreeView
      v-else-if="viewMode === 'tree'"
      :spans="nativeSpans"
      @select-span="openNativeSpan"
    />
    <TraceStatsView v-else :spans="nativeSpans" />
  </article>

  <SpanDetailModal
    v-if="openSpan"
    :span="openSpan"
    :trace-id="traceId"
    :service-colors="serviceColors"
    @close="closeSpan"
  />
</template>

<style scoped>
.hint { font-size: 10.5px; color: var(--sw-fg-3); }
.mono { font-family: var(--sw-mono); }
.dim { color: var(--sw-fg-3); }

.sw-btn.small { height: 24px; padding: 0 10px; font-size: 11px; }
.sw-btn.ghost { background: transparent; border: 1px solid var(--sw-line-2); color: var(--sw-fg-2); }

/* Detail card — height adapts to content. */
.tr-detail {
  padding: 0;
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.tr-detail-head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--sw-line);
  flex-wrap: wrap;
  flex: 0 0 auto;
}
.tr-detail-title { display: flex; align-items: center; gap: 8px; flex: 1; min-width: 0; }
.tr-detail-title .dim { font-size: 12px; font-weight: 500; color: var(--sw-fg-3); }
.tr-detail-title .mono { font-family: var(--sw-mono); color: var(--sw-fg-1); font-size: 12px; }
.trace-id-text {
  max-width: 320px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.trace-id-select {
  height: 24px;
  padding: 0 6px;
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line-2);
  border-radius: 4px;
  color: var(--sw-fg-1);
  font-family: var(--sw-mono);
  font-size: 11px;
  min-width: 320px;
}
.tr-detail-tools { display: flex; align-items: center; gap: 10px; }
.view-toggle {
  display: inline-flex;
  border: 1px solid var(--sw-line-2);
  border-radius: 4px;
  overflow: hidden;
  background: var(--sw-bg-2);
}
.vt-btn {
  background: transparent;
  border: none;
  color: var(--sw-fg-2);
  padding: 0 10px;
  height: 24px;
  font-size: 11px;
  cursor: pointer;
  border-right: 1px solid var(--sw-line-2);
}
.vt-btn:last-child { border-right: none; }
.vt-btn:hover { background: var(--sw-bg-3); }
.vt-btn.on { background: var(--sw-accent); color: var(--sw-bg-0); font-weight: 600; }

.tr-kpis {
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
.tr-svc-legend {
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
</style>
