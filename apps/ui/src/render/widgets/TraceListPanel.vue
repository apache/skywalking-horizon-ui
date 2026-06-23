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
  Shared trace list / rail. The single browsing-list-of-traces widget
  used by BOTH the per-layer Traces tab and the cross-layer Trace
  inspect view. Each row carries the colored status stripe, OK/ERR
  pill, endpoint name, a duration bar (scaled against `maxDuration`),
  the trace-id snippet, and the relative "ago" timestamp.

  Two layouts share one row model:
    - foldable=false → the full browsing list (the cards a page shows
      before a trace is selected).
    - foldable=true  → the rail. Expanded (`railOpen`) renders compact
      cards; collapsed renders the mini progress-bar rail. A handle in
      the header toggles `toggle-rail`.

  Props:
    rows         — NativeTraceListRow[] to render.
    selectedKey  — the row.key of the active trace (null when none).
    maxDuration  — largest duration across the visible set, for bar
                   scaling. 0 collapses every bar.
    title        — header label ("Traces" / "Segments"); also the
                   row-noun used by the count hint.
    countHint    — optional count to show in the header (the full list
                   shows the total row count; the rail mirrors it).
    foldable     — render as the rail (handle + collapse) vs. the flat
                   browsing list.
    railOpen     — only meaningful when foldable; expanded vs. mini.

  Emits:
    select       — a row was clicked.
    toggle-rail  — the rail handle was clicked (foldable only).
-->
<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import type { NativeTraceListRow } from '@/api/client';

const { t } = useI18n({ useScope: 'global' });

withDefaults(
  defineProps<{
    rows: NativeTraceListRow[];
    selectedKey: string | null;
    maxDuration: number;
    title?: string;
    countHint?: number | null;
    foldable?: boolean;
    railOpen?: boolean;
  }>(),
  { title: '', countHint: null, foldable: false, railOpen: true },
);
const emit = defineEmits<{
  (e: 'select', row: NativeTraceListRow): void;
  (e: 'toggle-rail'): void;
}>();

function parseNativeStart(v: string): number {
  const n = Number(v);
  if (Number.isFinite(n) && n > 0) return n;
  const ts = Date.parse(v);
  return Number.isFinite(ts) ? ts : 0;
}
function fmtRelativeAgo(ts: number | null | undefined): string {
  if (!ts) return '—';
  const ms = Date.now() - ts;
  if (ms < 1000) return t('just now');
  if (ms < 60_000) return t('{n}s ago', { n: Math.round(ms / 1000) });
  if (ms < 3_600_000) return t('{n}m ago', { n: Math.round(ms / 60_000) });
  return t('{n}h ago', { n: Math.round(ms / 3_600_000) });
}
/**
 * Trace-result bar colour. Red is reserved for actual error-status
 * traces; high-duration successful traces stay on a softer palette
 * (info → warn) so a slow-but-ok request isn't read as a failure.
 */
function rowDurationColor(durationMs: number): string {
  if (durationMs >= 500) return 'var(--sw-warn)';
  if (durationMs >= 100) return 'var(--sw-info)';
  return 'var(--sw-ok)';
}
</script>

<template>
  <!-- Flat browsing list (page default, before a trace is selected). -->
  <ul v-if="!foldable" class="tr-rowlist">
    <li
      v-for="row in rows"
      :key="row.key"
      class="tr-row-card"
      :class="{ err: row.isError, ok: !row.isError, on: selectedKey === row.key }"
      @click="emit('select', row)"
    >
      <div class="tr-row-head">
        <span class="tr-ep mono" :class="{ red: row.isError, blue: !row.isError }">{{ row.endpointNames[0] ?? '—' }}</span>
        <span class="status-flag" :class="row.isError ? 'flag-err' : 'flag-ok'">
          <span class="flag-dot" />
          {{ row.isError ? t('ERR') : t('OK') }}
        </span>
      </div>
      <div class="tr-row-bar" :title="t('{dur} ms — {pct}% of slowest', { dur: row.duration, pct: Math.round((row.duration / (maxDuration || 1)) * 100) })">
        <div
          class="tr-row-bar-fill"
          :style="{
            width: maxDuration > 0 ? Math.max(2, (row.duration / maxDuration) * 100) + '%' : '0%',
            background: row.isError ? 'var(--sw-err)' : rowDurationColor(row.duration),
          }"
        />
        <span class="tr-row-bar-label mono">{{ row.duration }} ms</span>
      </div>
      <div class="tr-row-meta">
        <span class="mono dim trace-id-snip" :title="row.traceIds[0]">{{ (row.traceIds[0] ?? '').slice(0, 18) }}…</span>
        <span class="mono dim ml-auto">{{ fmtRelativeAgo(parseNativeStart(row.start)) }}</span>
      </div>
    </li>
  </ul>

  <!-- Rail layout: handle header + expanded compact cards / mini bars. -->
  <aside v-else class="tr-rail sw-card">
    <header class="tr-rail-head">
      <button class="rail-handle" type="button" :title="railOpen ? t('Collapse list') : t('Expand list')" @click="emit('toggle-rail')">
        <span v-if="railOpen">«</span><span v-else>»</span>
      </button>
      <h4 v-if="railOpen">{{ title }}</h4>
      <span v-if="railOpen && countHint !== null" class="hint">{{ countHint }}</span>
    </header>
    <ul v-if="railOpen && rows.length" class="tr-rowlist rail-list">
      <li
        v-for="row in rows"
        :key="row.key"
        class="tr-row-card compact"
        :class="{ on: selectedKey === row.key, err: row.isError, ok: !row.isError }"
        @click="emit('select', row)"
      >
        <div class="rail-row-top">
          <span
            class="dur-tag mono lg"
            :style="{
              background: rowDurationColor(row.duration) + '22',
              color: rowDurationColor(row.duration),
            }"
          >
            {{ row.duration }} ms
          </span>
          <span class="status-flag" :class="row.isError ? 'flag-err' : 'flag-ok'">
            <span class="flag-dot" />
            {{ row.isError ? t('ERR') : t('OK') }}
          </span>
        </div>
        <div class="tr-ep rail-ep mono" :class="{ red: row.isError }">{{ row.endpointNames[0] ?? '—' }}</div>
        <div class="tr-row-meta">
          <span class="mono dim ml-auto">{{ fmtRelativeAgo(parseNativeStart(row.start)) }}</span>
        </div>
      </li>
    </ul>
    <!-- Folded rail: clickable progress bars per trace. Click switches
         the active trace, doesn't expand the rail. -->
    <ul v-if="!railOpen && rows.length" class="rail-mini">
      <li
        v-for="row in rows"
        :key="row.key"
        class="rail-mini-row"
        :class="{ on: selectedKey === row.key }"
        :title="`${row.endpointNames[0] ?? '—'} · ${row.duration} ms · ${row.isError ? t('err') : t('ok')}`"
        @click="emit('select', row)"
      >
        <div class="rail-mini-bar">
          <div
            class="rail-mini-fill"
            :style="{
              width: maxDuration > 0 ? Math.max(8, (row.duration / maxDuration) * 100) + '%' : '0%',
              background: row.isError ? 'var(--sw-err)' : 'var(--sw-ok)',
            }"
          />
        </div>
      </li>
    </ul>
  </aside>
</template>

<style scoped>
.tr-empty { padding: 24px; text-align: center; color: var(--sw-fg-3); font-size: 11.5px; }
.hint { font-size: 10.5px; color: var(--sw-fg-3); }
.tr-rowlist {
  list-style: none;
  margin: 0;
  padding: 0;
  overflow-y: auto;
  flex: 1;
}
.tr-row-card {
  cursor: pointer;
  padding: 8px 14px;
  border-left: 3px solid transparent;
  border-bottom: 1px solid var(--sw-line);
}
.tr-row-card.compact { padding: 6px 10px; }
.tr-row-card.ok { border-left-color: var(--sw-ok); }
.tr-row-card.err { border-left-color: var(--sw-err); }
.tr-row-card:hover { background: var(--sw-bg-2); }
.tr-row-card.on { background: var(--sw-accent-soft); }
.tr-row-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 5px;
}
.tr-ep {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
  font-size: 12px;
  font-weight: 600;
}
.tr-ep.red { color: var(--sw-err); }
.tr-ep.blue { color: var(--sw-info); }
.tr-row-bar {
  position: relative;
  height: 10px;
  background: var(--sw-bg-2);
  border-radius: 3px;
  overflow: hidden;
  margin-bottom: 4px;
}
/* Bar fill is intentionally muted — the colour reads as a tint, not
   a saturated alert. Error traces (`.err`) keep the full saturation
   so they pop on the page. */
.tr-row-bar-fill {
  height: 100%;
  border-radius: 3px;
  transition: width 0.18s ease;
  opacity: 0.55;
}
.tr-row-card.err .tr-row-bar-fill { opacity: 0.9; }
.tr-row-bar-label {
  position: absolute;
  right: 6px;
  top: 50%;
  transform: translateY(-50%);
  font-size: 9.5px;
  color: var(--sw-fg-0);
  font-weight: 600;
  pointer-events: none;
  text-shadow: 0 0 2px var(--sw-bg-0);
}
.tr-row-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 10.5px;
}
.ml-auto { margin-left: auto; }
.trace-id-snip { max-width: 220px; overflow: hidden; text-overflow: ellipsis; }
.dur-tag {
  display: inline-block;
  padding: 1px 6px;
  border-radius: 3px;
  font-weight: 600;
  font-size: 10.5px;
}
.dur-tag.lg {
  padding: 3px 10px;
  font-size: 12px;
  font-weight: 700;
  border-radius: 4px;
  font-family: var(--sw-mono);
}
.rail-row-top {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 4px;
}
.rail-row-top .status-flag { margin-left: auto; }
.rail-ep {
  display: block;
  font-size: 11px;
  color: var(--sw-fg-1);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  margin-bottom: 2px;
}
.rail-ep.red { color: var(--sw-err); }

/* Rail shell */
.tr-rail {
  padding: 0;
  display: flex;
  flex-direction: column;
  position: sticky;
  top: 12px;
  max-height: calc(100vh - 80px);
  overflow: hidden;
}
.tr-rail-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--sw-line);
  flex: 0 0 auto;
}
.tr-rail-head h4 { margin: 0; font-size: 11.5px; font-weight: 600; color: var(--sw-fg-0); }
.tr-rail-head .hint { margin-left: auto; }
.rail-handle {
  background: transparent;
  border: 1px solid var(--sw-line-2);
  color: var(--sw-fg-2);
  width: 22px;
  height: 22px;
  border-radius: 3px;
  cursor: pointer;
  font-size: 12px;
  line-height: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.rail-handle:hover { color: var(--sw-accent); border-color: var(--sw-accent); }
.rail-list { padding: 0; }

/* Folded rail — wider clickable progress bars per trace. */
.rail-mini {
  list-style: none;
  margin: 0;
  padding: 6px 4px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  overflow-y: auto;
  flex: 1;
}
.rail-mini-row {
  padding: 4px 6px;
  cursor: pointer;
  border-left: 2px solid transparent;
  border-radius: 2px;
}
.rail-mini-row:hover { background: var(--sw-bg-2); }
.rail-mini-row.on {
  background: var(--sw-accent-soft);
  border-left-color: var(--sw-accent);
}
.rail-mini-bar {
  height: 10px;
  background: var(--sw-bg-2);
  border-radius: 2px;
  overflow: hidden;
}
.rail-mini-fill {
  height: 100%;
  border-radius: 2px;
  transition: width 0.18s ease;
}

.mono { font-family: var(--sw-mono); }
.dim { color: var(--sw-fg-3); }

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
