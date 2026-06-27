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
  Kubernetes Pod logs result pane for Log inspect — a read-only dense pane
  of on-demand log lines (timestamp + content), matching the per-layer Pod
  Logs look. OAP's errorReason (feature disabled / stale pod) shows as a
  hint, not a blank pane. Owns its own empty / loading / error states +
  `.pl-*` CSS.
-->
<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import type { PodLogLine } from '@/api/scopes/log';

const props = defineProps<{
  rows: PodLogLine[];
  hasQueried: boolean;
  running: boolean;
  errorMsg: string | null;
  podErrorReason: string | null;
}>();

const { t } = useI18n();

/** Pod log line timestamp (ms epoch from the BFF) → HH:MM:SS, browser-local. */
function fmtPodTime(ts: number | null): string {
  if (ts == null) return '';
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
</script>

<template>
  <div class="iq-result">
    <div v-if="!props.hasQueried" class="iq-empty">{{ t('Pick a pod and a container, then run a query.') }}</div>
    <div v-else-if="props.running && props.rows.length === 0" class="iq-empty">{{ t('Reading data…') }}</div>
    <div v-else-if="props.errorMsg" class="iq-err">{{ props.errorMsg }}</div>
    <div v-else-if="props.podErrorReason" class="iq-pod-banner">
      <strong>{{ t('Logs unavailable:') }}</strong> {{ props.podErrorReason }}
      <span class="dim">{{ t('— pick a currently-running pod, or check that on-demand pod logs are enabled on OAP.') }}</span>
    </div>
    <div v-else-if="props.rows.length === 0" class="iq-empty">{{ t('No logs in this window.') }}</div>

    <article v-else class="iq-list-card sw-card">
      <header class="iq-list-head">
        <h4>{{ t('Kubernetes Pod logs') }}</h4>
        <span class="hint">{{ props.rows.length }} {{ t('lines') }}</span>
      </header>
      <div class="iq-stream-scroll">
        <div class="pl-stream">
          <div v-for="(l, idx) in props.rows" :key="`pl-${idx}`" class="pl-row">
            <span class="pl-time mono dim">{{ fmtPodTime(l.timestamp) }}</span>
            <span class="pl-content mono">{{ l.content }}</span>
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

/* Pod-log line list — read-only dense lines (timestamp + content) in the
   same dark vocabulary as the per-layer Pod Logs pane. Plain text, no
   row-click popout (each line is just a string). */
.pl-stream { font-size: 11.5px; }
.pl-row {
  display: grid;
  grid-template-columns: 70px 1fr;
  gap: 10px;
  align-items: baseline;
  padding: 2px 12px;
  border-bottom: 1px solid var(--sw-line);
}
.pl-row:hover { background: var(--sw-bg-2); }
.pl-time { font-size: 10.5px; flex: 0 0 auto; font-variant-numeric: tabular-nums; }
.pl-content { color: var(--sw-fg-1); white-space: pre-wrap; word-break: break-word; }

/* On-demand pod logs return OAP's errorReason when the feature is disabled
   or the pod can't be resolved — surface it as a hint, not a blank pane. */
.iq-pod-banner {
  margin: 8px 0 0;
  padding: 8px 12px;
  border: 1px solid rgba(240, 160, 75, 0.5);
  background: rgba(240, 160, 75, 0.1);
  border-radius: 4px;
  font-size: 11.5px;
  color: #f0a04b;
}
.iq-pod-banner .dim { color: var(--sw-fg-3); }
</style>
