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
  Logs tab and the cross-layer Log inspect view (both click → the shared
  LogDetailPopout). The component is purely presentational: it owns row
  rendering + level/format detection and emits `select`; the host decides
  what a click opens.

  Props:
    rows         — LogRow[] to render.
    selectedKey  — `rowKey(...)` of the active row (null when none); the
                   host computes the same key via the exported helper.

  Emits:
    select       — { row, key } for a clicked row. The trace-id chip
                   emits `jump-trace` instead (and stops propagation) so
                   the host can open the trace without selecting the row.
-->
<script setup lang="ts">
import type { LogRow } from '@/api/client';
import { parseServiceName } from '@/utils/serviceName';
import { logRowKey } from '@/utils/logRow';

defineProps<{
  rows: LogRow[];
  selectedKey?: string | null;
}>();
const emit = defineEmits<{
  (e: 'select', payload: { row: LogRow; key: string }): void;
  (e: 'jump-trace', payload: { traceId: string; ts: number }): void;
}>();

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

type LogFormat = 'json' | 'yaml' | 'text';
function detectFormat(r: LogRow): LogFormat {
  if (r.contentType === 'application/json') return 'json';
  const trimmed = r.content?.trim() ?? '';
  if (!trimmed) return 'text';
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) ||
      (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    try { JSON.parse(trimmed); return 'json'; } catch { /* fallthrough */ }
  }
  if (trimmed.startsWith('---') || trimmed.startsWith('apiVersion:')) return 'yaml';
  const lines = trimmed.split('\n');
  if (lines.length >= 2) {
    const topLevelMaps = lines.filter((l) => /^[A-Za-z_][\w.-]*\s*:\s*(\S|$)/.test(l)).length;
    if (topLevelMaps >= 2) return 'yaml';
  }
  return 'text';
}

/** Single-line preview. JSON re-serialises tight; YAML/text collapse
 *  whitespace so the row stays one line (full payload lives in the
 *  host's detail / popout). */
function summariseContent(r: LogRow): string {
  if (!r.content) return '';
  const fmt = detectFormat(r);
  if (fmt === 'json') {
    try { return JSON.stringify(JSON.parse(r.content)); } catch { /* fall through */ }
  }
  if (fmt === 'yaml') return r.content.replace(/\n+/g, ' ').trim();
  return r.content.replace(/\s+/g, ' ').trim();
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

function keyOf(r: LogRow, idx: number): string {
  return logRowKey(r, idx);
}
</script>

<template>
  <div class="lg-stream">
    <div
      v-for="(r, idx) in rows"
      :key="keyOf(r, idx)"
      class="lg-row"
      :class="[`lv-${levelOf(r)}`, { on: selectedKey != null && selectedKey === keyOf(r, idx) }]"
      @click="emit('select', { row: r, key: keyOf(r, idx) })"
    >
      <span class="lg-time mono">{{ fmtTime(r.timestamp) }}</span>
      <span class="lg-date mono dim">{{ fmtDate(r.timestamp) }}</span>
      <span class="lg-lvl" :style="{ color: LEVEL_COLOR[levelOf(r)] }">{{ levelOf(r) }}</span>
      <span class="lg-svc mono dim">
        <span
          v-if="r.serviceName && parseServiceName(r.serviceName).group"
          class="lg-svc-group"
        >{{ parseServiceName(r.serviceName).group }}</span>
        {{ r.serviceName ? parseServiceName(r.serviceName).base : '—' }}
      </span>
      <span
        v-if="r.traceId"
        class="lg-trace mono"
        @click.stop="emit('jump-trace', { traceId: r.traceId, ts: r.timestamp })"
      >↗ trace</span>
      <span v-else class="lg-trace-spacer" aria-hidden="true"></span>
      <span class="lg-content mono">
        <span class="lg-fmt-chip" :class="`fmt-${detectFormat(r)}`">{{ detectFormat(r).toUpperCase() }}</span>
        <span class="lg-content-body">{{ summariseContent(r) }}</span>
      </span>
    </div>
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
.lg-row.on { background: var(--sw-accent-soft); }
.lg-row.lv-error { box-shadow: inset 3px 0 0 var(--sw-err); }
.lg-row.lv-warn { box-shadow: inset 3px 0 0 var(--sw-warn); }
.lg-time { font-family: var(--sw-mono); color: var(--sw-fg-1); }
.lg-date { font-size: 10px; }
.lg-lvl {
  font-size: 9.5px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  font-weight: 700;
}
.lg-svc { font-size: 10.5px; }
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
.lg-fmt-chip.fmt-yaml { background: rgba(251, 191, 36, 0.18); color: #fbbf24; }
.lg-fmt-chip.fmt-text { background: var(--sw-bg-3); color: var(--sw-fg-2); }
.lg-content-body {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mono { font-family: var(--sw-mono); }
.dim { color: var(--sw-fg-3); }
</style>
