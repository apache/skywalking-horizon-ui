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
  Browser-error detail popout — the Browser sibling of LogDetailPopout, for
  the cross-layer Log inspect view. Shows one BrowserErrorRow's meta + the
  raw stack alongside the source-map de-obfuscation control (pick a hosted
  map → resolve → original frames + source snippet). The resolve flow mirrors
  the per-layer Browser Logs tab; the host owns the maps list (so it can also
  render the SourceMapManager), this popout owns the per-row resolve call.

  Built on `_shared/Modal.vue` (backdrop + Escape + close).

  Props:
    row     — the BrowserErrorRow to show; `null` keeps the popout closed.
    maps    — the hosted source maps the operator can resolve against.
    enabled — whether source-map de-obfuscation is on (server flag).
  Emits:
    close — dismiss (× button, Escape, backdrop).
-->
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { BrowserErrorRow, ResolveResponse, SourceMapDescriptor } from '@/api/client';
import { bffClient, describeApiError } from '@/api/client';
import Modal from '@/features/operate/_shared/Modal.vue';

const { t } = useI18n();

const props = defineProps<{
  row: BrowserErrorRow | null;
  maps: SourceMapDescriptor[];
}>();
const emit = defineEmits<{ (e: 'close'): void }>();

const selectedMapId = ref<string>('');
const resolved = ref<ResolveResponse | null>(null);
const resolveBusy = ref(false);
const resolveErr = ref<string | null>(null);

// A fresh row drops the prior resolution and auto-seeds the first map so
// the operator can resolve in one click. Same default as the per-layer tab.
watch(
  () => props.row,
  (row) => {
    resolved.value = null;
    resolveErr.value = null;
    if (row && !selectedMapId.value && props.maps.length > 0) selectedMapId.value = props.maps[0].id;
  },
);
// Maps may resolve AFTER a row is already open — seed the first one then too.
watch(
  () => props.maps,
  (maps) => {
    if (props.row && !selectedMapId.value && maps.length > 0) selectedMapId.value = maps[0].id;
  },
);

async function resolveRow(): Promise<void> {
  const row = props.row;
  if (!row || !selectedMapId.value) return;
  resolveBusy.value = true;
  resolveErr.value = null;
  resolved.value = null;
  try {
    const res = await bffClient.browserErrors.resolve({
      stack: row.stack ?? undefined,
      line: row.line ?? undefined,
      col: row.col ?? undefined,
      errorUrl: row.errorUrl ?? undefined,
      category: row.category,
      sourceMapId: selectedMapId.value,
    });
    resolved.value = res;
    if (!res.ok) resolveErr.value = t('Could not resolve: {reason}', { reason: res.error ?? t('unknown') });
  } catch (err) {
    resolveErr.value = describeApiError(err);
  } finally {
    resolveBusy.value = false;
  }
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
// Browser line/col are 1-based; OAP reports 0 for categories carrying no
// top-level position (PROMISE/AJAX/…), so a positive line is the signal.
const loc = computed<string>(() => {
  const r = props.row;
  if (!r?.line) return '';
  return `${r.line}:${r.col ?? 0}`;
});
</script>

<template>
  <Modal :open="row != null" :title="t('Browser error')" width="min(1100px, 92vw)" fit-body @close="emit('close')">
    <div v-if="row" class="be">
      <div class="be-head">
        <div class="be-head-l">
          <span class="be-time mono">{{ fmtTime(row.time) }} · {{ fmtDate(row.time) }}</span>
          <span class="be-cat">{{ row.category }}</span>
          <span v-if="loc" class="be-loc mono">{{ loc }}</span>
        </div>
      </div>
      <div class="be-meta">
        <span class="be-msg">{{ row.message || t('(no message)') }}</span>
      </div>
      <div class="be-meta be-meta-sub">
        <span v-if="row.pagePath" class="be-meta-item">{{ t('Page') }} <code class="mono" :title="row.pagePath">{{ row.pagePath }}</code></span>
        <span v-if="row.serviceVersion" class="be-meta-item">{{ t('Version') }} <code class="mono">{{ row.serviceVersion }}</code></span>
        <span v-if="row.errorUrl" class="be-meta-item">{{ t('URL') }} <code class="mono" :title="row.errorUrl">{{ row.errorUrl }}</code></span>
        <span v-if="row.grade" class="be-meta-item">{{ t('grade') }} <code>{{ row.grade }}</code></span>
        <span v-if="row.firstReportedError" class="be-meta-item be-first">{{ t('first occurrence') }}</span>
      </div>

      <div class="be-cols">
        <div class="be-col">
          <div class="be-col-head">{{ t('Raw stack') }}</div>
          <pre class="be-pre">{{ row.stack || t('(no stack)') }}</pre>
        </div>
        <div class="be-col">
          <div class="be-col-head">
            <span>{{ t('Resolved') }}</span>
            <select v-model="selectedMapId" class="be-map-pick" :disabled="maps.length === 0">
              <option value="" disabled>{{ maps.length ? t('Pick a source map…') : t('No maps loaded') }}</option>
              <option v-for="m in maps" :key="m.id" :value="m.id">
                {{ m.label }}{{ m.origin === 'upload' ? ' ' + t('(temp)') : '' }}
              </option>
            </select>
            <button class="be-btn primary" type="button" :disabled="!selectedMapId || resolveBusy" @click="resolveRow">{{ t('Resolve') }}</button>
          </div>
          <p v-if="resolveErr" class="be-err">{{ resolveErr }}</p>
          <p v-else-if="resolveBusy" class="be-dim">{{ t('Resolving…') }}</p>
          <div v-else-if="resolved && resolved.ok" class="be-frames">
            <div v-for="(f, fi) in resolved.frames" :key="fi" class="be-frame">
              <div class="be-frame-line">
                <span class="be-frame-fn">{{ f.generated.fn || t('(anonymous)') }}</span>
                <span v-if="f.original" class="be-frame-orig">
                  {{ f.original.source }}:{{ f.original.line }}:{{ f.original.col }}
                  <span v-if="f.original.name" class="be-frame-name">→ {{ f.original.name }}</span>
                </span>
                <span v-else class="be-frame-unmapped">{{ t('unmapped ({line}:{col})', { line: f.generated.line, col: f.generated.col }) }}</span>
              </div>
              <pre v-if="f.snippet" class="be-snippet"><code v-for="(ln, li) in f.snippet.lines" :key="li" class="be-snip-line" :class="{ 'is-hit': f.original && f.snippet.startLine + li === f.original.line }"><span class="be-snip-no">{{ f.snippet.startLine + li }}</span><span class="be-snip-code">{{ ln }}</span></code></pre>
            </div>
          </div>
          <p v-else class="be-dim">{{ t('Pick a source map and resolve to de-obfuscate this stack.') }}</p>
        </div>
      </div>
    </div>
  </Modal>
</template>

<style scoped>
.be { flex: 1; display: flex; flex-direction: column; min-height: 0; gap: 8px; }
.be-head {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding-bottom: 8px; border-bottom: 1px solid var(--sw-line); flex: 0 0 auto;
}
.be-head-l { display: inline-flex; align-items: center; gap: 10px; min-width: 0; }
.be-time { font-size: 11px; color: var(--sw-fg-2); }
.be-cat {
  display: inline-block; padding: 1px 8px; border-radius: 10px;
  background: var(--sw-accent-soft); color: var(--sw-accent-2);
  font-size: 10px; font-weight: 600; letter-spacing: 0.04em;
}
.be-loc {
  font-size: 10px; color: var(--sw-fg-3); background: var(--sw-bg-3);
  border-radius: 3px; padding: 0 5px; font-variant-numeric: tabular-nums;
}
.be-meta { display: flex; flex-wrap: wrap; gap: 12px; flex: 0 0 auto; }
.be-msg { font-family: var(--sw-mono); font-size: 12px; color: var(--sw-fg-0); word-break: break-word; }
.be-meta-sub {
  padding-bottom: 8px; border-bottom: 1px dashed var(--sw-line);
  font-size: 11px; color: var(--sw-fg-3);
}
.be-meta-item code {
  font-family: var(--sw-mono); color: var(--sw-fg-1);
  padding: 0 4px; background: var(--sw-bg-2); border-radius: 3px;
  max-width: 360px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  display: inline-block; vertical-align: bottom;
}
.be-first { color: var(--sw-warn); }
.be-cols { flex: 1; min-height: 0; display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.be-col { display: flex; flex-direction: column; gap: 4px; min-width: 0; min-height: 0; }
.be-col-head { display: flex; align-items: center; gap: 6px; min-height: 28px; font-size: 11px; font-weight: 600; color: var(--sw-fg-2); }
.be-map-pick {
  margin-left: auto; max-width: 220px; height: 26px; padding: 0 6px;
  background: var(--sw-bg-2); border: 1px solid var(--sw-line-2); border-radius: 4px;
  color: var(--sw-fg-0); font: inherit; font-size: 11px;
}
.be-map-pick:disabled { opacity: 0.5; cursor: not-allowed; }
.be-pre {
  flex: 1; min-height: 0; margin: 0; background: var(--sw-bg-0);
  border: 1px solid var(--sw-line); border-radius: 4px; padding: 8px;
  font-family: var(--sw-mono); font-size: 11px; line-height: 1.5; color: var(--sw-fg-1);
  overflow: auto; white-space: pre;
}
.be-frames { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; }
.be-frame { display: flex; flex-direction: column; border: 1px solid var(--sw-line); border-radius: 5px; overflow: hidden; background: var(--sw-bg-0); }
.be-frame-line { font-family: var(--sw-mono); font-size: 11px; display: flex; flex-wrap: wrap; gap: 8px; align-items: baseline; padding: 5px 9px; background: var(--sw-bg-1); }
.be-frame-fn { color: var(--sw-fg-0); font-weight: 600; }
.be-frame-orig { color: var(--sw-cyan); }
.be-frame-name { color: var(--sw-info); }
.be-frame-unmapped { color: var(--sw-fg-3); margin-left: auto; font-style: italic; }
.be-snippet {
  display: flex; flex-direction: column; margin: 0;
  font-family: var(--sw-mono); font-size: 11px; line-height: 1.6;
  border-top: 1px solid var(--sw-line); overflow-x: auto;
}
.be-snip-line { display: flex; white-space: pre; }
.be-snip-no {
  flex: 0 0 auto; width: 30px; text-align: right; padding: 0 8px;
  color: var(--sw-fg-3); background: var(--sw-bg-1); border-right: 1px solid var(--sw-line);
  user-select: none;
}
.be-snip-code { padding: 0 10px; color: var(--sw-fg-1); white-space: pre; }
.be-snip-line.is-hit { background: color-mix(in srgb, var(--sw-accent) 13%, transparent); }
.be-snip-line.is-hit .be-snip-no { color: var(--sw-accent-2); background: color-mix(in srgb, var(--sw-accent) 22%, transparent); font-weight: 700; }
.be-snip-line.is-hit .be-snip-code { color: var(--sw-fg-0); }
.be-err { margin: 0; font-size: 11.5px; color: var(--sw-err); }
.be-dim { color: var(--sw-fg-3); font-size: 11px; padding: 4px 0; }
.be-btn {
  height: 26px; padding: 0 12px; border-radius: 4px; font: inherit; font-size: 11px;
  font-weight: 500; border: 1px solid var(--sw-line-2); background: var(--sw-bg-2);
  color: var(--sw-fg-1); cursor: pointer;
}
.be-btn:hover { color: var(--sw-fg-0); border-color: var(--sw-line); }
.be-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.be-btn.primary { background: var(--sw-accent); color: var(--sw-bg-0); border: none; font-weight: 600; }
.be-btn.primary:hover { background: var(--sw-accent-2); color: var(--sw-bg-0); }
.mono { font-family: var(--sw-mono); }
@media (max-width: 900px) {
  .be-cols { grid-template-columns: 1fr; }
}
</style>
