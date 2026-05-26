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
  Bottom-fixed framework-event drawer. Renders only when the
  Admin → "Debug events" toggle (controls/debugPanel.ts) is on.
  Default visibility is hostname-driven: enabled on localhost /
  127.0.0.1 / 0.0.0.0, disabled in production.

  Collapsed: one-line ticker showing the latest event.
  Expanded: ~10 rows visible, scroll for the rest (last 200 events).
-->
<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useEventLog } from '@/controls/eventLog';
import { useDebugPanel } from '@/controls/debugPanel';

const { t } = useI18n({ useScope: 'global' });
const { latest, all } = useEventLog();
const { enabled, toggle } = useDebugPanel();
const open = ref(false);
function toggleOpen(): void {
  open.value = !open.value;
}

function fmtTime(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}
function kindGlyph(k: 'start' | 'ok' | 'err' | 'info'): string {
  return k === 'ok' ? '✓' : k === 'err' ? '✕' : k === 'start' ? '…' : '·';
}

const latestText = computed<string>(() => {
  const e = latest.value;
  if (!e) return t('idle');
  const dur = e.durationMs != null ? ` · ${e.durationMs}ms` : '';
  return `${kindGlyph(e.kind)} ${e.text}${dur}`;
});
const latestKind = computed<string>(() => latest.value?.kind ?? 'info');
const eventCount = computed<number>(() => all.value.length);
</script>

<template>
  <!-- v-show (not v-if) so the toggle responds instantly — the
       VNode tree stays mounted, only display flips. Saves the
       re-mount + sticky-listener re-attach cost on every click. -->
  <div v-show="enabled" class="dbg" :class="['dbg-kind-' + latestKind, { open }]" data-no-event-track>
    <div v-show="open" class="dbg-popover">
      <header class="dbg-pop-head">
        <span class="dbg-title">{{ t('Framework events') }}</span>
        <span class="dbg-tag">{{ t('last {n}', { n: eventCount }) }}</span>
        <button class="dbg-x" type="button" :title="t('Hide panel')" @click="toggle">{{ t('hide') }}</button>
      </header>
      <div v-if="all.length === 0" class="dbg-empty">{{ t('no events yet') }}</div>
      <ol v-else class="dbg-list">
        <li
          v-for="e in [...all].reverse()"
          :key="e.id"
          :class="'dbg-row dbg-kind-' + e.kind"
        >
          <span class="dbg-row-time">{{ fmtTime(e.ts) }}</span>
          <span class="dbg-row-glyph">{{ kindGlyph(e.kind) }}</span>
          <span class="dbg-row-topic">{{ e.topic }}</span>
          <span class="dbg-row-text">{{ e.text }}</span>
          <span v-if="e.durationMs != null" class="dbg-row-dur">{{ e.durationMs }}ms</span>
        </li>
      </ol>
    </div>
    <button class="dbg-bar" type="button" @click="toggleOpen" :aria-expanded="open">
      <span class="dbg-caret" :class="{ open }">▾</span>
      <span class="dbg-bar-text">{{ latestText }}</span>
      <span v-if="eventCount > 0" class="dbg-bar-count">({{ eventCount }})</span>
      <span class="dbg-bar-label">{{ t('framework events') }}</span>
    </button>
  </div>
</template>

<style scoped>
.dbg {
  position: fixed;
  /* Start past the 220px sidebar so the sidebar's bottom (Admin
   * section + sw-side-foot with user/logout) isn't covered. The
   * sidebar already has its own scroll if its contents exceed
   * the viewport height. */
  left: 220px;
  right: 0;
  bottom: 0;
  z-index: 60;
  font-variant-numeric: tabular-nums;
  pointer-events: none;
}
.dbg > * { pointer-events: auto; }
.dbg-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  height: 26px;
  padding: 0 14px;
  background: var(--sw-bg-2);
  border: none;
  border-top: 1px solid var(--sw-line);
  color: var(--sw-fg-1);
  font: inherit;
  font-size: 11.5px;
  cursor: pointer;
  text-align: left;
  overflow: hidden;
  box-shadow: 0 -2px 12px rgba(0, 0, 0, 0.35);
}
.dbg-bar:hover { background: var(--sw-bg-1); }
.dbg-bar-text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--sw-mono);
}
.dbg-bar-count {
  color: var(--sw-fg-3);
  font-size: 10.5px;
}
.dbg-bar-label {
  color: var(--sw-fg-3);
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
.dbg-caret {
  color: var(--sw-fg-3);
  font-size: 10px;
  transition: transform 0.12s;
}
.dbg-caret.open { transform: rotate(180deg); }
.dbg-kind-start .dbg-bar-text { color: var(--sw-accent-2); }
.dbg-kind-ok    .dbg-bar-text { color: var(--sw-ok); }
.dbg-kind-err   .dbg-bar-text { color: var(--sw-err); }
.dbg-kind-info  .dbg-bar-text { color: var(--sw-fg-2); }

.dbg-popover {
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line-2);
  border-bottom: none;
  max-height: 260px;
  overflow-y: auto;
  box-shadow: 0 -8px 24px rgba(0, 0, 0, 0.45);
}
.dbg-pop-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 14px;
  border-bottom: 1px solid var(--sw-line);
  font-size: 10.5px;
  position: sticky;
  top: 0;
  background: var(--sw-bg-2);
  z-index: 1;
}
.dbg-title {
  color: var(--sw-fg-0);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  font-size: 10px;
}
.dbg-tag { color: var(--sw-fg-3); font-size: 10px; }
.dbg-x {
  margin-left: auto;
  background: transparent;
  border: 1px solid var(--sw-line-2);
  color: var(--sw-fg-2);
  border-radius: 3px;
  padding: 2px 8px;
  font: inherit;
  font-size: 10.5px;
  cursor: pointer;
}
.dbg-x:hover { color: var(--sw-fg-0); border-color: var(--sw-fg-3); }
.dbg-empty { padding: 12px; font-size: 11px; color: var(--sw-fg-3); text-align: center; }
.dbg-list { list-style: none; margin: 0; padding: 4px 0; }
.dbg-row {
  display: grid;
  grid-template-columns: auto auto auto 1fr auto;
  align-items: baseline;
  gap: 8px;
  padding: 4px 14px;
  font-size: 11px;
  font-family: var(--sw-mono);
  color: var(--sw-fg-1);
  border-bottom: 1px solid var(--sw-line);
}
.dbg-row:last-child { border-bottom: none; }
.dbg-row-time  { color: var(--sw-fg-3); font-size: 10px; }
.dbg-row-glyph { color: var(--sw-fg-2); width: 12px; text-align: center; }
.dbg-row-topic { color: var(--sw-fg-3); font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em; }
.dbg-row-text  { color: var(--sw-fg-1); overflow: hidden; text-overflow: ellipsis; }
.dbg-row-dur   { color: var(--sw-fg-3); font-size: 10px; }
.dbg-row.dbg-kind-ok    .dbg-row-glyph { color: var(--sw-ok); }
.dbg-row.dbg-kind-err   .dbg-row-glyph { color: var(--sw-err); }
.dbg-row.dbg-kind-err   .dbg-row-text  { color: var(--sw-err); }
.dbg-row.dbg-kind-start .dbg-row-glyph { color: var(--sw-accent-2); }
</style>
