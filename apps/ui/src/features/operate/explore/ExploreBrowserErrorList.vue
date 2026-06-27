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
  Browser source result pane for Log inspect — a dense error list in the
  same dark vocabulary as the per-layer Browser Logs stream; row-click
  emits `select` so the host opens the browser-error popout. Owns its own
  empty / loading / error states + presentation helpers + `.be-*` CSS.
-->
<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import type { BrowserErrorRow } from '@/api/client';

const props = defineProps<{
  rows: BrowserErrorRow[];
  selectedRow: BrowserErrorRow | null;
  hasQueried: boolean;
  running: boolean;
  errorMsg: string | null;
}>();

const emit = defineEmits<{ (e: 'select', row: BrowserErrorRow): void }>();

const { t } = useI18n();

const CATEGORY_COLOR: Record<string, string> = {
  js: 'var(--sw-err)',
  promise: 'var(--sw-warn)',
  vue: 'var(--sw-info)',
  ajax: 'var(--sw-accent-2)',
  resource: 'var(--sw-cyan)',
  unknown: 'var(--sw-fg-3)',
};
function catColor(r: BrowserErrorRow): string {
  return CATEGORY_COLOR[(r.category ?? '').toLowerCase()] ?? 'var(--sw-fg-3)';
}
function fmtRowTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function fmtRowDate(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function rowLoc(r: BrowserErrorRow): string {
  if (!r.line) return '';
  return `${r.line}:${r.col ?? 0}`;
}
function browserRowKey(r: BrowserErrorRow, idx: number): string {
  return `${r.time}-${r.category}-${idx}`;
}
</script>

<template>
  <div class="iq-result">
    <div v-if="!props.hasQueried" class="iq-empty">{{ t('Run a query — pick a BROWSER service, type a name, or leave it blank.') }}</div>
    <div v-else-if="props.running && props.rows.length === 0" class="iq-empty">{{ t('Reading data…') }}</div>
    <div v-else-if="props.errorMsg" class="iq-err">{{ props.errorMsg }}</div>
    <div v-else-if="props.rows.length === 0" class="iq-empty">{{ t('No browser logs in this window.') }}</div>

    <article v-else class="iq-list-card sw-card">
      <header class="iq-list-head">
        <h4>{{ t('Browser errors') }}</h4>
        <span class="hint">{{ props.rows.length }} {{ t('errors') }}</span>
      </header>
      <div class="iq-stream-scroll">
        <div class="be-stream">
          <div
            v-for="(r, idx) in props.rows"
            :key="browserRowKey(r, idx)"
            class="be-row"
            :class="{ 'is-open': props.selectedRow === r }"
            :style="{ boxShadow: `inset 3px 0 0 ${catColor(r)}` }"
            @click="emit('select', r)"
          >
            <span class="be-time mono">{{ fmtRowTime(r.time) }}</span>
            <span class="be-date mono dim">{{ fmtRowDate(r.time) }}</span>
            <span class="be-cat" :style="{ color: catColor(r) }">{{ r.category }}</span>
            <span class="be-page mono dim" :title="r.pagePath">{{ r.pagePath || '—' }}</span>
            <span class="be-ver mono dim" :title="r.serviceVersion">{{ r.serviceVersion || '—' }}</span>
            <span class="be-msg mono">
              <span v-if="rowLoc(r)" class="be-loc">{{ rowLoc(r) }}</span>
              <span class="be-msg-body">{{ r.message || t('(no message)') }}</span>
            </span>
          </div>
        </div>
      </div>
    </article>
  </div>
</template>

<style scoped>
.iq-result { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.iq-result > .iq-list-card { flex: 1; }
.iq-empty, .iq-err { padding: 24px; text-align: center; color: var(--sw-fg-3); font-size: 12px; }
.iq-err { color: var(--sw-err); }
.iq-list-card { padding: 0; display: flex; flex-direction: column; min-height: 0; max-height: calc(100vh - 80px); overflow: hidden; }
.iq-list-head { display: flex; align-items: baseline; gap: 8px; padding: 10px 14px; border-bottom: 1px solid var(--sw-line); flex: 0 0 auto; }
.iq-list-head h4 { margin: 0; font-size: 12px; font-weight: 600; color: var(--sw-fg-0); }
.iq-list-head .hint { margin-left: auto; font-size: 10.5px; color: var(--sw-fg-3); }
.iq-stream-scroll { flex: 1; overflow-y: auto; min-height: 0; }
.mono { font-family: var(--sw-mono); }
.dim { color: var(--sw-fg-3); }

/* Browser-error list rows — same dense grid vocabulary as the per-layer
   Browser Logs stream so the two read identically. */
.be-stream { font-size: 11.5px; }
.be-row {
  display: grid;
  grid-template-columns: 76px 40px 74px 150px 90px 1fr;
  gap: 10px;
  align-items: center;
  padding: 4px 12px;
  border-bottom: 1px solid var(--sw-line);
  cursor: pointer;
}
.be-row:hover, .be-row.is-open { background: var(--sw-bg-2); }
.be-time { color: var(--sw-fg-1); }
.be-date { font-size: 10px; }
.be-cat { font-size: 9.5px; text-transform: uppercase; letter-spacing: 0.06em; font-weight: 700; }
.be-page, .be-ver { font-size: 10.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.be-msg {
  font-size: 11px; color: var(--sw-fg-1); overflow: hidden; text-overflow: ellipsis;
  white-space: nowrap; display: inline-flex; align-items: center; gap: 6px; min-width: 0;
}
.be-loc {
  flex: 0 0 auto; font-size: 9.5px; color: var(--sw-fg-3); background: var(--sw-bg-3);
  border-radius: 3px; padding: 0 5px; font-variant-numeric: tabular-nums;
}
.be-msg-body { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
