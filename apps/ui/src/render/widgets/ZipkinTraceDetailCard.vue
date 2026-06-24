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
  Shared Zipkin trace-detail card. Given a flat ZipkinSpan[] it renders
  the parent-id-walked waterfall (depth-indented), KPIs, the per-service
  colour legend, and a span-detail modal — mirroring TraceDetailCard's
  chrome but for the Zipkin v2 span shape. Used by BOTH the per-layer
  Traces · Zipkin tab and the cross-layer Trace inspect view.

  Props:
    spans    — the flat ZipkinSpan[] of the resolved trace.
    traceId  — the active trace id (header label + copy).
    loading  — show a "loading…" hint while detail fetches.

  Emits:
    close             — the × was clicked.
    update:modalOpen  — the span-detail modal opened / closed; hosts use
                        this to order their Esc cascade (modal first, then
                        the inline detail).
-->
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { ZipkinSpan } from '@/api/client';

const { t } = useI18n({ useScope: 'global' });

const props = withDefaults(
  defineProps<{
    spans: ZipkinSpan[];
    traceId: string | null;
    loading?: boolean;
  }>(),
  { loading: false },
);
const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'update:modalOpen', open: boolean): void;
}>();

/** Public method so a host can close the span-detail modal as the first
 *  step of its own Esc cascade. */
function closeSpanModal(): void { selectedSpanId.value = null; }
defineExpose({ closeSpanModal });

function copyTraceId(): void {
  if (!props.traceId) return;
  navigator.clipboard?.writeText(props.traceId).catch(() => {});
}
function copyShareableUrl(): void {
  if (!props.traceId || typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  url.searchParams.set('traceId', props.traceId);
  // Tag the source so Trace inspect (one route, two sources) reopens it as
  // Zipkin rather than native — IDs alone can't disambiguate.
  url.searchParams.set('source', 'zipkin');
  navigator.clipboard?.writeText(url.toString()).catch(() => {});
}

// ── Waterfall (parent-id walk → depth-indented rows) ─────────────
interface DetailRow { span: ZipkinSpan; depth: number; offsetUs: number; durUs: number; }
const detailBounds = computed(() => {
  let t0 = Infinity;
  let t1 = -Infinity;
  for (const s of props.spans) {
    const start = s.timestamp ?? 0;
    const dur = s.duration ?? 0;
    if (start && start < t0) t0 = start;
    if (start && (start + dur) > t1) t1 = start + dur;
  }
  if (!Number.isFinite(t0)) t0 = 0;
  if (!Number.isFinite(t1) || t1 <= t0) t1 = t0 + 1;
  return { t0, t1, totalUs: t1 - t0 };
});
const detailRows = computed<DetailRow[]>(() => {
  const list = props.spans;
  if (list.length === 0) return [];
  const byParent = new Map<string, ZipkinSpan[]>();
  for (const s of list) {
    const p = s.parentId ?? '';
    if (!byParent.has(p)) byParent.set(p, []);
    byParent.get(p)!.push(s);
  }
  for (const arr of byParent.values()) arr.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
  const out: DetailRow[] = [];
  const { t0 } = detailBounds.value;
  const visited = new Set<string>();
  function walk(parentId: string, depth: number): void {
    for (const s of (byParent.get(parentId) ?? [])) {
      if (visited.has(s.id)) continue; // guard against cyclic parentId chains
      visited.add(s.id);
      const start = s.timestamp ?? t0;
      out.push({ span: s, depth, offsetUs: start - t0, durUs: s.duration ?? 0 });
      walk(s.id, depth + 1);
    }
  }
  const ids = new Set(list.map((s) => s.id));
  walk('', 0);
  for (const s of list) {
    if (!s.parentId) continue;
    if (ids.has(s.parentId)) continue;
    if (visited.has(s.id)) continue;
    const start = s.timestamp ?? t0;
    out.push({ span: s, depth: 0, offsetUs: start - t0, durUs: s.duration ?? 0 });
    walk(s.id, 1);
  }
  return out;
});

// ── Service colour palette (matches TraceDetailCard) ─────────────
const SERVICE_PALETTE = [
  'var(--sw-accent)', 'var(--sw-info)', 'var(--sw-cyan)', 'var(--sw-purple)',
  'var(--sw-ok)', 'var(--sw-warn)', 'var(--sw-pink)',
  '#a78bfa', '#fb7185', '#34d399', '#fbbf24', '#60a5fa',
];
function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function detailColor(name: string | null | undefined): string {
  if (!name) return 'var(--sw-fg-2)';
  return SERVICE_PALETTE[hashString(name) % SERVICE_PALETTE.length]!;
}
const detailServiceColors = computed<Map<string, string>>(() => {
  const m = new Map<string, string>();
  for (const s of props.spans) {
    const n = s.localEndpoint?.serviceName ?? '—';
    if (!m.has(n)) m.set(n, detailColor(n));
  }
  return m;
});
const detailRootStart = computed<number | null>(() => {
  const ts = props.spans.map((s) => s.timestamp ?? 0).filter(Boolean);
  return ts.length ? Math.min(...ts) : null;
});
function kindColor(k: string | null | undefined): string {
  const kind = (k ?? '').toUpperCase();
  if (kind.includes('SERVER')) return 'var(--sw-accent)';
  if (kind.includes('CLIENT')) return 'var(--sw-info)';
  if (kind.includes('PRODUCER') || kind.includes('CONSUMER')) return 'var(--sw-purple)';
  return 'var(--sw-fg-2)';
}
// Zipkin/B3 timing codes → human label; unknown values render raw.
const ANNOTATION_LABELS: Record<string, string> = {
  cs: 'client send', cr: 'client receive',
  sr: 'server receive', ss: 'server send',
  ws: 'wire send', wr: 'wire receive',
  error: 'error',
};
function annotationHint(value: string): string | null {
  const label = ANNOTATION_LABELS[value.trim().toLowerCase()];
  return label ? t(label) : null;
}

// ── Render helpers ───────────────────────────────────────────────
function fmtMs(us: number | null | undefined): string {
  if (us == null) return '—';
  if (us < 1000) return `${us}μs`;
  if (us < 1_000_000) return `${(us / 1000).toFixed(2)}ms`;
  return `${(us / 1_000_000).toFixed(2)}s`;
}
function fmtDateTime(usSinceEpoch: number | null | undefined): string {
  if (!usSinceEpoch || !Number.isFinite(usSinceEpoch)) return '—';
  const d = new Date(usSinceEpoch / 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function detailLeftPct(us: number): number {
  return Math.max(0, Math.min(100, (us / (detailBounds.value.totalUs || 1)) * 100));
}
function detailWidthPct(us: number): number {
  if (us <= 0) return 0.8;
  return Math.max(0.8, Math.min(100, (us / (detailBounds.value.totalUs || 1)) * 100));
}

// ── Span detail modal ─────────────────────────────────────────────
const selectedSpanId = ref<string | null>(null);
const selectedSpan = computed<ZipkinSpan | null>(() => {
  if (!selectedSpanId.value) return null;
  return props.spans.find((s) => s.id === selectedSpanId.value) ?? null;
});
function selectSpan(s: ZipkinSpan): void {
  selectedSpanId.value = selectedSpanId.value === s.id ? null : s.id;
}
function clearSpan(): void { selectedSpanId.value = null; }
watch(() => props.traceId, () => { selectedSpanId.value = null; });
watch(selectedSpan, (s) => emit('update:modalOpen', !!s));
</script>

<template>
  <article class="ztr-detail sw-card">
    <header class="ztr-detail-head">
      <span class="kicker">{{ t('Trace') }}</span>
      <code class="ztr-tid mono" :title="traceId ?? ''">{{ traceId }}</code>
      <button class="sw-btn small copy-btn" type="button" :title="t('Copy trace id')" @click="copyTraceId">⧉ {{ t('id') }}</button>
      <button class="sw-btn small copy-btn" type="button" :title="t('Copy shareable URL')" @click="copyShareableUrl">⧉ {{ t('url') }}</button>
      <span v-if="loading" class="hint">{{ t('loading…') }}</span>
      <button class="sw-btn small ghost ztr-detail-close" type="button" :title="t('Close')" @click="emit('close')">×</button>
    </header>
    <div v-if="loading && detailRows.length === 0" class="ztr-empty hint">{{ t('loading spans…') }}</div>
    <div v-else-if="detailRows.length === 0" class="ztr-empty">{{ t('No spans for this trace.') }}</div>
    <template v-else>
      <div class="ztr-kpis">
        <div><div class="kpi-label">{{ t('started') }}</div><div class="kpi-val">{{ fmtDateTime(detailRootStart) }}</div></div>
        <div><div class="kpi-label">{{ t('duration') }}</div><div class="kpi-val">{{ fmtMs(detailBounds.totalUs) }}</div></div>
        <div><div class="kpi-label">{{ t('spans') }}</div><div class="kpi-val">{{ detailRows.length }}</div></div>
        <div><div class="kpi-label">{{ t('services') }}</div><div class="kpi-val">{{ detailServiceColors.size }}</div></div>
      </div>
      <div v-if="detailServiceColors.size > 0" class="ztr-svc-legend">
        <span v-for="[code, color] in detailServiceColors" :key="code" class="svc-chip">
          <span class="svc-swatch" :style="{ background: color }" />
          <span class="mono">{{ code }}</span>
        </span>
      </div>
      <div class="ztr-detail-body">
        <div class="ztr-waterfall">
          <div class="tp-time-axis">
            <span class="t-tick first">0</span>
            <span class="t-tick">{{ fmtMs(detailBounds.totalUs * 0.25) }}</span>
            <span class="t-tick">{{ fmtMs(detailBounds.totalUs * 0.5) }}</span>
            <span class="t-tick">{{ fmtMs(detailBounds.totalUs * 0.75) }}</span>
            <span class="t-tick last">{{ fmtMs(detailBounds.totalUs) }}</span>
          </div>
          <div
            v-for="row in detailRows"
            :key="row.span.id"
            class="tp-row"
            :class="{ err: row.span.tags?.error != null, on: selectedSpanId === row.span.id }"
            @click="selectSpan(row.span)"
          >
            <div class="tp-track">
              <span class="t-grid q1" /><span class="t-grid q2" /><span class="t-grid q3" />
              <div
                class="tp-bar"
                :style="{
                  left: detailLeftPct(row.offsetUs) + '%',
                  width: detailWidthPct(row.durUs) + '%',
                  background: detailColor(row.span.localEndpoint?.serviceName),
                  borderColor: row.span.tags?.error != null ? 'var(--sw-err)' : 'transparent',
                }"
              >
                <span class="bar-inner">
                  <span
                    class="status-flag sm"
                    :class="row.span.tags?.error != null ? 'flag-err' : 'flag-ok'"
                    :title="row.span.tags?.error != null ? t('Span errored') : t('Span OK')"
                  ><span class="flag-dot" /></span>
                  <svg class="comp-icon comp-icon-generic" viewBox="0 0 18 18" :aria-label="t('generic span')">
                    <rect x="3" y="4.5" width="12" height="3" rx="1.5" fill="currentColor" opacity="0.45" />
                    <rect x="5" y="10.5" width="10" height="3" rx="1.5" fill="currentColor" opacity="0.85" />
                  </svg>
                  <span class="bar-text mono">
                    <span class="bar-svc" :title="row.span.localEndpoint?.serviceName ?? ''">{{ row.span.localEndpoint?.serviceName ?? '—' }}</span>
                    <span class="bar-name" :title="row.span.name || row.span.remoteEndpoint?.serviceName || '—'">{{ row.span.name || row.span.remoteEndpoint?.serviceName || '—' }}</span>
                  </span>
                  <span v-if="detailWidthPct(row.durUs) > 12" class="bar-dur-inside mono">{{ fmtMs(row.durUs) }}</span>
                </span>
              </div>
              <span
                v-if="detailWidthPct(row.durUs) <= 12"
                class="bar-dur-outside mono"
                :style="{ left: `calc(${detailLeftPct(row.offsetUs + row.durUs)}% + 6px)` }"
              >{{ fmtMs(row.durUs) }}</span>
            </div>
          </div>
        </div>

        <!-- Span detail opens as a centered modal so it can render long
             tag values without compressing the waterfall bars. -->
        <div v-if="selectedSpan" class="span-modal-backdrop" @click.self="clearSpan">
          <article class="span-modal sw-card">
            <header class="span-modal-head">
              <h4><span class="dim">{{ t('Span detail') }}</span> <span class="mono">{{ selectedSpan.name || '—' }}</span></h4>
              <button class="sw-btn small ghost" type="button" :title="t('Close')" @click="clearSpan">×</button>
            </header>
            <div class="span-modal-body">
              <section class="sd-section">
                <h6>{{ t('Meta') }}</h6>
                <dl class="kv">
                  <dt>{{ t('Service') }}</dt>
                  <dd class="mono" :style="{ color: detailColor(selectedSpan.localEndpoint?.serviceName) }">
                    <span class="svc-swatch inline" :style="{ background: detailColor(selectedSpan.localEndpoint?.serviceName) }" />
                    {{ selectedSpan.localEndpoint?.serviceName ?? '—' }}
                  </dd>
                  <dt>{{ t('Name') }}</dt><dd class="mono wba">{{ selectedSpan.name || '—' }}</dd>
                  <dt>{{ t('Kind') }}</dt><dd><span class="tp-kind" :style="{ color: kindColor(selectedSpan.kind) }">{{ selectedSpan.kind ?? '—' }}</span></dd>
                  <dt>{{ t('Peer') }}</dt><dd class="mono wba">{{ selectedSpan.remoteEndpoint?.serviceName || '—' }}</dd>
                  <dt v-if="selectedSpan.remoteEndpoint?.ipv4 || selectedSpan.remoteEndpoint?.ipv6">{{ t('Peer addr') }}</dt>
                  <dd v-if="selectedSpan.remoteEndpoint?.ipv4 || selectedSpan.remoteEndpoint?.ipv6" class="mono wba">{{ selectedSpan.remoteEndpoint?.ipv4 ?? selectedSpan.remoteEndpoint?.ipv6 }}<template v-if="selectedSpan.remoteEndpoint?.port">:{{ selectedSpan.remoteEndpoint.port }}</template></dd>
                  <dt>{{ t('Span id') }}</dt><dd class="mono wba">{{ selectedSpan.id }}</dd>
                  <dt v-if="selectedSpan.parentId">{{ t('Parent id') }}</dt>
                  <dd v-if="selectedSpan.parentId" class="mono wba">{{ selectedSpan.parentId }}</dd>
                  <dt>{{ t('Start') }}</dt><dd class="mono">{{ fmtDateTime(selectedSpan.timestamp) }}</dd>
                  <dt>{{ t('Duration') }}</dt><dd class="mono">{{ fmtMs(selectedSpan.duration ?? 0) }}</dd>
                  <dt>{{ t('Error') }}</dt><dd><span class="status-flag" :class="selectedSpan.tags?.error != null ? 'flag-err' : 'flag-ok'"><span class="flag-dot" />{{ selectedSpan.tags?.error != null ? t('true') : t('false') }}</span></dd>
                </dl>
              </section>
              <section v-if="selectedSpan.tags && Object.keys(selectedSpan.tags).length > 0" class="sd-section">
                <h6>{{ t('Tags') }}</h6>
                <dl class="kv">
                  <template v-for="(v, k) in selectedSpan.tags" :key="k">
                    <dt class="mono">{{ k }}</dt>
                    <dd class="mono wba" :class="{ err: k === 'error' }">{{ v }}</dd>
                  </template>
                </dl>
              </section>
              <section v-if="selectedSpan.annotations && selectedSpan.annotations.length > 0" class="sd-section">
                <h6>{{ t('Annotations') }}</h6>
                <div v-for="(a, i) in selectedSpan.annotations" :key="i" class="span-event">
                  <div class="span-event-head">
                    <span class="mono">{{ a.value }}<span v-if="annotationHint(a.value)" class="ann-hint" :title="annotationHint(a.value) ?? ''"> ({{ annotationHint(a.value) }})</span></span>
                    <span class="dim mono">{{ fmtDateTime(a.timestamp) }}</span>
                  </div>
                </div>
              </section>
            </div>
          </article>
        </div>
      </div>
    </template>
  </article>
</template>

<style scoped>
.mono { font-family: var(--sw-mono); }
.dim { color: var(--sw-fg-3); }
.wba { word-break: break-all; }
.hint { font-size: 10.5px; color: var(--sw-fg-3); }
.kicker {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--sw-accent);
  font-weight: 600;
}

.ztr-detail {
  display: flex;
  flex-direction: column;
  min-height: 240px;
  max-height: calc(100vh - 80px);
  overflow: hidden;
}
.ztr-detail-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--sw-line);
  flex: 0 0 auto;
}
.ztr-tid { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--sw-fg-2); font-size: 11px; }
.ztr-detail-close { margin-left: auto; }
.ztr-empty {
  padding: 36px;
  text-align: center;
  color: var(--sw-fg-3);
  font-size: 12px;
}

.ztr-detail-body {
  flex: 1;
  position: relative;
  display: flex;
  min-height: 0;
  overflow: hidden;
}
.ztr-kpis {
  display: flex;
  gap: 24px;
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
  font-size: 13px;
  color: var(--sw-fg-0);
  font-weight: 700;
}
.ztr-svc-legend {
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
.svc-swatch { width: 8px; height: 8px; border-radius: 2px; flex: 0 0 auto; }
.svc-swatch.inline { display: inline-block; margin-right: 4px; vertical-align: middle; }

/* Inline waterfall — each span is a row with absolute-positioned bar. */
.ztr-waterfall {
  flex: 1 1 0;
  min-width: 0;
  overflow-x: hidden;
  overflow-y: auto;
  padding: 4px 0;
}
.tp-time-axis {
  position: sticky;
  top: 0;
  z-index: 10;
  display: flex;
  justify-content: space-between;
  padding: 6px 12px;
  background-color: var(--sw-bg-1);
  border-bottom: 1px solid var(--sw-line);
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.35);
  font-family: var(--sw-mono);
  font-size: 10px;
  color: var(--sw-fg-3);
}
.t-tick { white-space: nowrap; }
.t-tick.first { text-align: left; }
.t-tick.last { text-align: right; }
.tp-row { padding: 3px 12px; cursor: pointer; }
.tp-row:hover { background: var(--sw-bg-2); }
.tp-row.err { background: rgba(239, 68, 68, 0.06); }
.tp-row.on { background: var(--sw-accent-soft); }
.tp-track { position: relative; height: 22px; background: transparent; }
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
.comp-icon { width: 18px; height: 18px; flex: 0 0 auto; object-fit: contain; background: transparent; }
.comp-icon-generic { color: var(--sw-fg-2); }
.bar-inner .comp-icon-generic { color: rgba(0, 0, 0, 0.72); }
.bar-inner .status-flag.sm { background: rgba(255, 255, 255, 0.35); color: var(--sw-bg-0); }
.bar-inner .status-flag.flag-err { background: var(--sw-err); color: #fff; }
.bar-dur-outside {
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  font-size: 10px;
  color: var(--sw-fg-2);
  white-space: nowrap;
  pointer-events: none;
}
.bar-dur-inside {
  flex: 0 0 auto;
  margin-left: auto;
  padding-left: 8px;
  font-size: 10px;
  color: var(--sw-bg-0);
  opacity: 0.82;
  white-space: nowrap;
}

/* Status flag */
.status-flag {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 18px;
  padding: 0 6px;
  border-radius: 9px;
  font-size: 9.5px;
  font-weight: 700;
  letter-spacing: 0.04em;
  flex: 0 0 auto;
}
.status-flag .flag-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.status-flag.flag-ok { background: rgba(34, 197, 94, 0.14); color: var(--sw-ok); }
.status-flag.flag-err { background: rgba(239, 68, 68, 0.18); color: var(--sw-err); }
.status-flag.sm { height: 12px; width: 12px; padding: 0; border-radius: 50%; justify-content: center; }
.status-flag.sm .flag-dot { margin: 0; }

/* Span detail modal */
.span-modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  z-index: 1000;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: 40px 20px;
  overflow-y: auto;
}
.span-modal {
  width: 100%;
  max-width: 920px;
  max-height: calc(100vh - 80px);
  display: flex;
  flex-direction: column;
}
.span-modal-head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--sw-line);
  flex: 0 0 auto;
}
.span-modal-head h4 {
  margin: 0;
  font-size: 12px;
  font-weight: 600;
  display: inline-flex;
  gap: 10px;
  align-items: baseline;
  flex: 1;
  min-width: 0;
}
.span-modal-head h4 .dim { color: var(--sw-fg-3); font-weight: 500; }
.span-modal-head h4 .mono {
  font-family: var(--sw-mono);
  color: var(--sw-fg-1);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.span-modal-body { padding: 12px 14px 16px; overflow-y: auto; }
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
.kv dt { color: var(--sw-fg-3); font-size: 10.5px; min-width: 0; overflow-wrap: anywhere; }
.kv dd { margin: 0; color: var(--sw-fg-1); min-width: 0; }
.kv dd.wba { word-break: break-all; }
.kv dd.err { color: var(--sw-err); }
.tp-kind { font-family: var(--sw-mono); font-size: 11px; font-weight: 600; }
.span-event {
  border: 1px solid var(--sw-line);
  border-radius: 4px;
  padding: 6px 10px;
  margin-bottom: 6px;
  background: var(--sw-bg-0);
}
.span-event-head {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  font-size: 11px;
}
.ann-hint { color: var(--sw-fg-3); }

/* Detail-head buttons. */
.sw-btn.small {
  height: 22px;
  padding: 0 8px;
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line-2);
  color: var(--sw-fg-1);
  border-radius: 3px;
  font-size: 10.5px;
  cursor: pointer;
}
.sw-btn.small:hover { background: var(--sw-bg-3); border-color: var(--sw-accent); color: var(--sw-accent); }
.sw-btn.small.ghost {
  background: transparent;
  border-color: transparent;
  color: var(--sw-fg-3);
  width: 22px;
  padding: 0;
  font-size: 14px;
}
.sw-btn.small.ghost:hover { color: var(--sw-err); background: var(--sw-bg-2); }
.sw-btn.small.copy-btn { background: transparent; color: var(--sw-fg-2); white-space: nowrap; }
</style>
