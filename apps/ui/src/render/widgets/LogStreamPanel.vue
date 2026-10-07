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
  Shared raw-log STREAM. One dense row per log line — time / date /
  level stripe / service (group-decoded) / trace-id chip / format chip
  + flattened single-line content preview. Used by BOTH the per-layer
  Logs tab and the cross-layer Log inspect view.

  What a click does is the viewer's Inline | Pop out choice
  (LogOpenModeToggle, placed by the host). Inline expands the row in place
  with the whole payload, the entity meta and the tags; several rows can
  be open at once so entries can be compared, and one click anywhere on an
  open row folds it. Pop out hands the row straight to the host, as does
  an expanded row's Pop out button; the host decides what opens (the
  shared LogDetailPopout).

  Props:
    rows         — LogRow[] to render.
    selectedKey  — `logRowKey(...)` of the row the host has popped out
                   (null when none); highlighted in the stream.

  Emits:
    open         — { row, key } from a row click in Pop out mode, or from
                   an expanded row's Pop out button.
    jump-trace   — { traceId, ts } from the trace-id chip, which stops
                   propagation so the jump does not also toggle the row.
-->
<script setup lang="ts">
import { computed, reactive, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { LogRow } from '@/api/client';
import { parseServiceName } from '@/utils/serviceName';
import { logRowKey } from '@/utils/logRow';
import { detectFormat, prettyContent, previewContent, type LogFormat } from './logContent';
import { useLogOpenMode } from './useLogOpenMode';

const { t } = useI18n({ useScope: 'global' });

const props = defineProps<{
  rows: LogRow[];
  selectedKey?: string | null;
}>();
const emit = defineEmits<{
  (e: 'open', payload: { row: LogRow; key: string }): void;
  (e: 'jump-trace', payload: { traceId: string; ts: number }): void;
}>();

const mode = useLogOpenMode();

type Level = 'error' | 'warn' | 'info' | 'debug' | 'other';
const LEVEL_COLOR: Record<Level, string> = {
  error: 'var(--sw-err)',
  warn: 'var(--sw-warn)',
  info: 'var(--sw-info)',
  debug: 'var(--sw-fg-3)',
  other: 'var(--sw-fg-3)',
};

function levelOf(r: LogRow): Level {
  const tag = (r.tags ?? []).find((t) => t.key.toLowerCase() === 'level');
  const raw = (tag?.value ?? '').toLowerCase();
  if (raw.includes('error') || raw === 'err' || raw === 'fatal') return 'error';
  if (raw.includes('warn')) return 'warn';
  if (raw.includes('info')) return 'info';
  if (raw.includes('debug') || raw.includes('trace')) return 'debug';
  return 'other';
}

function fmtTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}
function fmtDate(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

interface StreamItem {
  row: LogRow;
  key: string;
  level: Level;
  fmt: LogFormat;
  text: string;
}
// Worked out once per result — an expand click re-renders the list, and
// sniffing the format parses every JSON payload again.
const items = computed<StreamItem[]>(() =>
  props.rows.map((row, idx) => ({
    row,
    key: logRowKey(row, idx),
    level: levelOf(row),
    fmt: detectFormat(row),
    text: previewContent(row),
  })),
);

// A key carries the row's position, so a new result closes every row rather
// than leaving one open on whatever log now sits at that index.
const expanded = reactive(new Set<string>());
watch(() => props.rows, () => expanded.clear());
watch(mode, () => expanded.clear());

function selectsInside(row: EventTarget | null): boolean {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !(row instanceof Node)) return false;
  // Not `containsNode(row, true)`: by the DOM spec that is false when the
  // whole selection lies inside the row, and Firefox follows the spec.
  for (let i = 0; i < sel.rangeCount; i++) {
    if (sel.getRangeAt(i).intersectsNode(row)) return true;
  }
  return false;
}

function onClick(e: MouseEvent, it: StreamItem): void {
  // Selecting text to copy it ends in a click; that must not act on the row.
  if (selectsInside(e.currentTarget)) return;
  if (mode.value === 'popout') emit('open', { row: it.row, key: it.key });
  else if (expanded.has(it.key)) expanded.delete(it.key);
  else expanded.add(it.key);
}
</script>

<template>
  <div class="lg-stream">
    <template v-for="it in items" :key="it.key">
      <div
        class="lg-row"
        :class="[`lv-${it.level}`, { on: selectedKey != null && selectedKey === it.key, 'is-open': expanded.has(it.key) }]"
        :aria-expanded="mode === 'inline' ? expanded.has(it.key) : undefined"
        @click="onClick($event, it)"
      >
        <span class="lg-time mono">{{ fmtTime(it.row.timestamp) }}</span>
        <span class="lg-date mono dim">{{ fmtDate(it.row.timestamp) }}</span>
        <span class="lg-lvl" :style="{ color: LEVEL_COLOR[it.level] }">{{ it.level }}</span>
        <span class="lg-svc mono dim" :title="it.row.serviceName ?? undefined">
          <span
            v-if="it.row.serviceName && parseServiceName(it.row.serviceName).group"
            class="lg-svc-group"
          >{{ parseServiceName(it.row.serviceName).group }}</span>
          {{ it.row.serviceName ? parseServiceName(it.row.serviceName).base : '—' }}
        </span>
        <span
          v-if="it.row.traceId"
          class="lg-trace mono"
          @click.stop="emit('jump-trace', { traceId: it.row.traceId, ts: it.row.timestamp })"
        >{{ t('↗ trace') }}</span>
        <span v-else class="lg-trace-spacer" aria-hidden="true"></span>
        <span class="lg-content mono">
          <span class="lg-fmt-chip" :class="`fmt-${it.fmt}`">{{ it.fmt.toUpperCase() }}</span>
          <span class="lg-content-body">{{ it.text }}</span>
        </span>
      </div>
      <div v-if="expanded.has(it.key)" class="lg-expand" :class="`lv-${it.level}`" @click="onClick($event, it)">
        <div class="lg-expand-meta">
          <span v-if="it.row.serviceName" class="lg-meta-item">{{ t('Service') }} <span class="lg-meta-val">{{ it.row.serviceName }}</span></span>
          <span v-if="it.row.serviceInstanceName" class="lg-meta-item">{{ t('Instance') }} <span class="lg-meta-val">{{ it.row.serviceInstanceName }}</span></span>
          <span v-if="it.row.endpointName" class="lg-meta-item">{{ t('Endpoint') }} <span class="lg-meta-val">{{ it.row.endpointName }}</span></span>
          <span v-if="it.row.traceId" class="lg-meta-item">{{ t('Trace ID') }} <span class="lg-meta-val">{{ it.row.traceId }}</span></span>
          <button type="button" class="lg-popout" @click.stop="emit('open', { row: it.row, key: it.key })">{{ t('Pop out') }} ⤢</button>
        </div>
        <div v-if="it.row.tags.length > 0" class="lg-expand-tags">
          <span v-for="tg in it.row.tags" :key="`${tg.key}=${tg.value}`" class="lg-tag"><span class="lg-tag-k">{{ tg.key }}=</span>{{ tg.value }}</span>
        </div>
        <pre class="lg-expand-body">{{ prettyContent(it.row) }}</pre>
      </div>
    </template>
  </div>
</template>

<style scoped>
.lg-stream { font-size: 11.5px; }
.lg-row {
  display: grid;
  grid-template-columns: 80px 60px 56px 140px 60px 1fr;
  gap: 10px;
  align-items: center;
  padding: 4px 12px;
  border-bottom: 1px solid var(--sw-line);
  cursor: pointer;
}
.lg-row:hover { background: var(--sw-bg-2); }
.lg-row.is-open { background: var(--sw-bg-2); border-bottom-color: transparent; }
.lg-row.on { background: var(--sw-accent-soft); }
.lg-row.lv-error, .lg-expand.lv-error { box-shadow: inset 3px 0 0 var(--sw-err); }
.lg-row.lv-warn, .lg-expand.lv-warn { box-shadow: inset 3px 0 0 var(--sw-warn); }
.lg-time { font-family: var(--sw-mono); color: var(--sw-fg-1); }
.lg-date { font-size: 10px; }
.lg-lvl {
  font-size: 9.5px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  font-weight: 700;
}
.lg-svc { font-size: 10.5px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lg-svc-group {
  display: inline-block;
  padding: 0 5px;
  margin-right: 4px;
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line-2);
  border-radius: 3px;
  font-size: 9.5px;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: var(--sw-fg-2);
  text-transform: uppercase;
}
.lg-trace {
  font-size: 10px;
  color: var(--sw-accent-2);
  cursor: pointer;
  padding: 1px 5px;
  background: var(--sw-accent-soft);
  border: 1px solid var(--sw-accent-line);
  border-radius: 3px;
}
.lg-trace:hover { color: var(--sw-fg-0); }
.lg-content {
  font-family: var(--sw-mono);
  font-size: 11px;
  color: var(--sw-fg-1);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.lg-fmt-chip {
  flex: 0 0 auto;
  display: inline-block;
  padding: 0 5px;
  height: 14px;
  line-height: 14px;
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.04em;
  border-radius: 3px;
  text-transform: uppercase;
  font-family: var(--sw-mono);
}
.lg-fmt-chip.fmt-json { background: var(--sw-info-soft); color: var(--sw-info); }
.lg-fmt-chip.fmt-yaml { background: var(--sw-warn-soft); color: var(--sw-warn); }
.lg-fmt-chip.fmt-text { background: var(--sw-bg-3); color: var(--sw-fg-2); }
.lg-content-body {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.lg-expand {
  padding: 6px 14px 12px 28px;
  border-bottom: 1px solid var(--sw-line);
  background: var(--sw-bg-2);
  cursor: pointer;
}
.lg-expand-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 12px;
  margin-bottom: 8px;
  font-size: 10.5px;
  color: var(--sw-fg-3);
}
.lg-meta-val {
  font-family: var(--sw-mono);
  color: var(--sw-fg-1);
  overflow-wrap: anywhere;
}
.lg-expand-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 6px;
  margin-bottom: 8px;
}
.lg-tag {
  padding: 1px 6px;
  border: 1px solid var(--sw-line-2);
  border-radius: 3px;
  font-family: var(--sw-mono);
  font-size: 10.5px;
  color: var(--sw-fg-1);
  overflow-wrap: anywhere;
}
.lg-tag-k { color: var(--sw-fg-3); }
.lg-popout {
  margin-left: auto;
  height: 22px;
  padding: 0 10px;
  background: transparent;
  border: 1px solid var(--sw-line-2);
  border-radius: 4px;
  color: var(--sw-fg-1);
  font: inherit;
  font-size: 11px;
  cursor: pointer;
}
.lg-popout:hover { color: var(--sw-fg-0); background: var(--sw-bg-3); border-color: var(--sw-fg-3); }
.lg-expand-body {
  margin: 0;
  max-height: 320px;
  overflow: auto;
  padding: 8px 10px;
  background: var(--sw-bg-0);
  border: 1px solid var(--sw-line);
  border-radius: 4px;
  font-family: var(--sw-mono);
  font-size: 11px;
  line-height: 1.5;
  color: var(--sw-fg-0);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  tab-size: 4;
}
.mono { font-family: var(--sw-mono); }
.dim { color: var(--sw-fg-3); }
</style>
