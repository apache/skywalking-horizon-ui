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
<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { LogRow } from '@/api/client';
import Modal from '@/features/operate/_shared/Modal.vue';

const { t } = useI18n();

const props = withDefaults(defineProps<{
  row: LogRow | null;
  modalTitle?: string;
  endpointLabel?: string;
  badgeTagKey?: string;
}>(), {
  modalTitle: 'Evaluation Record Entry',
  endpointLabel: 'Task Name',
  badgeTagKey: 'value_type',
});
const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'jump-trace', payload: { traceId: string; ts: number }): void;
}>();

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
function prettyContent(r: LogRow): string {
  if (detectFormat(r) === 'json') {
    try { return JSON.stringify(JSON.parse(r.content), null, 2); } catch { /* fall through */ }
  }
  return r.content;
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

const fmt = computed<LogFormat | null>(() => (props.row ? detectFormat(props.row) : null));
const badgeText = computed(() => {
  if (!props.row) return '';
  if (props.badgeTagKey) {
    const tag = props.row.tags.find((item) => item.key.toLowerCase() === props.badgeTagKey.toLowerCase());
    if (tag?.value) return tag.value;
  }
  return fmt.value?.toUpperCase() ?? '';
});

const copied = ref(false);
let copyTimer: ReturnType<typeof setTimeout> | null = null;
async function copyContent(): Promise<void> {
  if (!props.row) return;
  try {
    await navigator.clipboard.writeText(props.row.content);
    copied.value = true;
    if (copyTimer) clearTimeout(copyTimer);
    copyTimer = setTimeout(() => {
      copied.value = false;
      copyTimer = null;
    }, 1500);
  } catch {
    /* clipboard may be blocked; silently no-op */
  }
}
watch(() => props.row, () => { copied.value = false; });
onBeforeUnmount(() => { if (copyTimer) clearTimeout(copyTimer); });
function onJumpTrace(): void {
  if (props.row?.traceId) emit('jump-trace', { traceId: props.row.traceId, ts: props.row.timestamp });
}
</script>

<template>
  <Modal :open="row != null" :title="t(props.modalTitle)" width="min(1100px, 92vw)" fit-body @close="emit('close')">
    <div v-if="row" class="ld">
      <div class="ld-head">
        <div class="ld-head-l">
          <span class="ld-time mono">{{ fmtTime(row.timestamp) }} · {{ fmtDate(row.timestamp) }}</span>
          <span class="ld-fmt">{{ badgeText }}</span>
        </div>
        <div class="ld-ctrls">
          <button class="sw-btn small" :class="{ 'is-copied': copied }" type="button" @click="copyContent">{{ copied ? t('Copied') : t('Copy') }}</button>
          <button v-if="row.traceId" class="sw-btn small" type="button" @click="onJumpTrace">↗ {{ t('trace') }}</button>
        </div>
      </div>
      <div class="ld-meta">
        <span v-if="row.serviceName" class="ld-meta-item">{{ t('Service') }} <code>{{ row.serviceName }}</code></span>
        <span v-if="row.serviceInstanceName" class="ld-meta-item">{{ t('Instance') }} <code>{{ row.serviceInstanceName }}</code></span>
        <span v-if="row.endpointName" class="ld-meta-item">{{ t(props.endpointLabel) }} <code>{{ row.endpointName }}</code></span>
        <span v-if="row.traceId" class="ld-meta-item">{{ t('Trace ID') }} <code class="mono">{{ row.traceId }}</code></span>
      </div>
      <div class="ld-split">
        <pre class="ld-body" :class="`fmt-${fmt}`">{{ prettyContent(row) }}</pre>
        <aside v-if="row.tags.length > 0" class="ld-tags">
          <table class="ld-tag-tbl">
            <thead><tr><th>{{ t('Key') }}</th><th>{{ t('Value') }}</th></tr></thead>
            <tbody>
              <tr v-for="tg in row.tags" :key="`${tg.key}=${tg.value}`">
                <td class="mono">{{ tg.key }}</td>
                <td class="mono">{{ tg.value }}</td>
              </tr>
            </tbody>
          </table>
        </aside>
      </div>
    </div>
  </Modal>
</template>

<style scoped>
.ld { flex: 1; display: flex; flex-direction: column; min-height: 0; }
.ld-head {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding-bottom: 8px; border-bottom: 1px solid var(--sw-line); flex: 0 0 auto;
}
.ld-head-l { display: inline-flex; align-items: center; gap: 10px; min-width: 0; }
.ld-time { font-size: 11px; color: var(--sw-fg-2); }
.ld-fmt {
  display: inline-block; padding: 1px 8px; border-radius: 10px;
  background: var(--sw-accent-soft); color: var(--sw-accent-2);
  font-size: 10px; font-weight: 600; letter-spacing: 0.04em;
}
.ld-ctrls { display: inline-flex; gap: 6px; flex: 0 0 auto; }
.ld-meta {
  display: flex; flex-wrap: wrap; gap: 12px; padding: 8px 0;
  border-bottom: 1px dashed var(--sw-line); font-size: 11px; color: var(--sw-fg-3); flex: 0 0 auto;
}
.ld-meta-item code {
  font-family: var(--sw-mono); color: var(--sw-fg-1);
  padding: 0 4px; background: var(--sw-bg-2); border-radius: 3px;
}
.ld-split { flex: 1; min-height: 0; display: flex; margin-top: 8px; }
.ld-body {
  flex: 1; min-height: 0; min-width: 0; margin: 0; padding: 12px 14px;
  background: var(--sw-bg-0); font-family: var(--sw-mono); font-size: 12px; line-height: 1.55;
  color: var(--sw-fg-0); white-space: pre-wrap; word-break: break-all; overflow: auto;
  border-radius: 4px;
}
.ld-body.fmt-json { color: var(--sw-cyan); }
.ld-body.fmt-yaml { color: #fbbf24; }
.ld-tags {
  flex: 0 0 340px; border-left: 1px solid var(--sw-line); padding: 8px 14px 12px;
  overflow: auto; background: var(--sw-bg-1);
}
.ld-tag-tbl { width: 100%; table-layout: fixed; border-collapse: collapse; font-size: 11px; }
.ld-tag-tbl td { word-break: break-all; vertical-align: top; }
.ld-tag-tbl th, .ld-tag-tbl td {
  padding: 4px 10px; text-align: left; border-bottom: 1px solid var(--sw-line);
}
.ld-tag-tbl th { color: var(--sw-fg-3); font-weight: 500; }
.ld-tag-tbl td { color: var(--sw-fg-1); font-family: var(--sw-mono); }
.sw-btn.small {
  height: 24px; padding: 0 10px; background: var(--sw-bg-2); border: 1px solid var(--sw-line-2);
  color: var(--sw-fg-1); border-radius: 4px; font: inherit; font-size: 11px; cursor: pointer;
}
.sw-btn.small:hover { color: var(--sw-fg-0); border-color: var(--sw-fg-3); }
.sw-btn.small.is-copied { color: var(--sw-accent-2); background: var(--sw-accent-soft); border-color: var(--sw-accent-2); }
.mono { font-family: var(--sw-mono); }
@media (max-width: 900px) {
  .ld-split { flex-direction: column; }
  .ld-tags { flex: 0 0 auto; border-left: none; border-top: 1px solid var(--sw-line); }
}
</style>
