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
  Pod Logs — live-tail a Kubernetes pod's container logs, fetched on
  demand from the K8s API through OAP and never persisted. The page is
  instance-pinned: pick a pod (instance) in the header, pick a
  container, tap Start, and the trailing window streams into a read-only
  Monaco pane, polled on the chosen interval until paused.
-->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute } from 'vue-router';
import * as monaco from 'monaco-editor';
import { useSelectedService } from '@/layer/useSelectedService';
import { useSelectedInstance } from '@/layer/useSelectedInstance';
import { useLayerInstances } from '@/layer/useLayerInstances';
import { useLayerPodLogs, WINDOW_OPTS, INTERVAL_OPTS } from './useLayerPodLogs';
import { setupMonaco, RR_THEME_NAME } from '@/monaco/setup';

const { t } = useI18n({ useScope: 'global' });
const route = useRoute();
const layerKey = computed(() => String(route.params.layerKey ?? ''));

// Service comes from the shell header picker; feed its id straight to
// the instances list (the BFF route accepts id OR name).
const { selectedId } = useSelectedService();
const { instances: instanceList } = useLayerInstances(layerKey, selectedId);

// Pod (instance) is the pinned entity; resolve the picked name to its OAP id.
const { selectedInstance, setSelectedInstance } = useSelectedInstance();
const instanceId = computed<string | null>(() => {
  if (!selectedInstance.value) return null;
  return instanceList.value.find((i) => i.name === selectedInstance.value)?.id ?? null;
});
// Clear the pod when the service changes — a pod id from another
// service would never resolve.
watch(selectedId, (next, prev) => {
  if (prev !== undefined && next !== prev && selectedInstance.value) setSelectedInstance(null);
});

const {
  containers,
  selectedContainer,
  windowSeconds,
  intervalSeconds,
  keywords,
  excludes,
  lines,
  errorReason,
  loadingContainers,
  tailing,
  lastUpdatedAt,
  toggleTail,
} = useLayerPodLogs(layerKey, instanceId);

const keywordInput = ref('');
const excludeInput = ref('');
function addKeyword(): void {
  const v = keywordInput.value.trim();
  if (v && !keywords.value.includes(v)) keywords.value = [...keywords.value, v];
  keywordInput.value = '';
}
function removeKeyword(i: number): void {
  keywords.value = keywords.value.filter((_, idx) => idx !== i);
}
function addExclude(): void {
  const v = excludeInput.value.trim();
  if (v && !excludes.value.includes(v)) excludes.value = [...excludes.value, v];
  excludeInput.value = '';
}
function removeExclude(i: number): void {
  excludes.value = excludes.value.filter((_, idx) => idx !== i);
}

const nowTick = ref(Date.now());
let agoTimer: ReturnType<typeof setInterval> | null = null;
const updatedAgo = computed<string | null>(() => {
  if (!lastUpdatedAt.value) return null;
  const s = Math.max(0, Math.round((nowTick.value - lastUpdatedAt.value) / 1000));
  return s < 1 ? t('just now') : t('{seconds}s ago', { seconds: s });
});

const host = ref<HTMLDivElement | null>(null);
let editor: monaco.editor.IStandaloneCodeEditor | null = null;
let model: monaco.editor.ITextModel | null = null;

function renderLines(): void {
  if (!model) return;
  const text = lines.value.map((l) => l.content).join('\n');
  model.setValue(text);
  if (editor && lines.value.length > 0) {
    const last = model.getLineCount();
    editor.revealLine(last);
    editor.setPosition({ lineNumber: last, column: 1 });
  }
}

onMounted(() => {
  setupMonaco();
  if (host.value) {
    model = monaco.editor.createModel('', 'plaintext');
    editor = monaco.editor.create(host.value, {
      model,
      theme: RR_THEME_NAME,
      readOnly: true,
      automaticLayout: true,
      minimap: { enabled: false },
      wordWrap: 'on',
      scrollBeyondLastLine: false,
      lineNumbers: 'on',
      fontSize: 12,
      fontFamily: "'JetBrains Mono', ui-monospace, monospace",
      renderLineHighlight: 'none',
    });
    renderLines();
  }
  agoTimer = setInterval(() => { nowTick.value = Date.now(); }, 1000);
});
onBeforeUnmount(() => {
  editor?.dispose();
  model?.dispose();
  if (agoTimer !== null) clearInterval(agoTimer);
});
watch(lines, renderLines);

const hasService = computed(() => !!selectedId.value);
const hasInstance = computed(() => !!instanceId.value);
</script>

<template>
  <div class="pod-logs">
    <header class="bar">
      <div class="ctrls">
        <label class="ctrl">
          <span class="lbl">{{ t('Pod') }}</span>
          <select
            class="inp"
            :value="selectedInstance ?? ''"
            :disabled="!hasService"
            @change="setSelectedInstance(($event.target as HTMLSelectElement).value || null)"
          >
            <option value="">{{ hasService ? t('Select a pod…') : t('Select a service first') }}</option>
            <option v-for="i in instanceList" :key="i.id" :value="i.name">{{ i.name }}</option>
          </select>
        </label>

        <label class="ctrl">
          <span class="lbl">{{ t('Container') }}</span>
          <select
            class="inp"
            :value="selectedContainer ?? ''"
            :disabled="!hasInstance || containers.length === 0"
            @change="selectedContainer = ($event.target as HTMLSelectElement).value || null"
          >
            <option value="">{{ loadingContainers ? t('Loading…') : t('Select a container…') }}</option>
            <option v-for="c in containers" :key="c" :value="c">{{ c }}</option>
          </select>
        </label>

        <label class="ctrl">
          <span class="lbl">{{ t('Window') }}</span>
          <select class="inp" v-model.number="windowSeconds">
            <option v-for="o in WINDOW_OPTS" :key="o.value" :value="o.value">{{ t(o.label) }}</option>
          </select>
        </label>

        <label class="ctrl">
          <span class="lbl">{{ t('Interval') }}</span>
          <select class="inp" v-model.number="intervalSeconds">
            <option v-for="o in INTERVAL_OPTS" :key="o.value" :value="o.value">{{ o.label }}</option>
          </select>
        </label>

        <button
          class="tail-btn"
          :class="{ on: tailing }"
          :disabled="!selectedContainer"
          @click="toggleTail"
        >
          <span class="dot" :class="{ live: tailing }" />
          {{ tailing ? t('Pause') : t('Start') }}
        </button>
      </div>

      <div class="filters">
        <div class="kw">
          <span class="lbl">{{ t('Include') }}</span>
          <span v-for="(k, i) in keywords" :key="`kw${i}`" class="chip">
            {{ k }}<button class="x" @click="removeKeyword(i)">×</button>
          </span>
          <input
            class="kw-inp"
            v-model="keywordInput"
            :placeholder="t('regex (e.g. .*error.*) + Enter')"
            @keydown.enter.prevent="addKeyword"
          />
        </div>
        <div class="kw">
          <span class="lbl">{{ t('Exclude') }}</span>
          <span v-for="(k, i) in excludes" :key="`ex${i}`" class="chip ex">
            {{ k }}<button class="x" @click="removeExclude(i)">×</button>
          </span>
          <input
            class="kw-inp"
            v-model="excludeInput"
            :placeholder="t('regex (e.g. .*error.*) + Enter')"
            @keydown.enter.prevent="addExclude"
          />
        </div>
      </div>
    </header>

    <div v-if="errorReason" class="banner">
      <strong>{{ t('Logs unavailable:') }}</strong> {{ errorReason }}
      <span class="hint">{{ t('— pick a currently-running pod, or check that on-demand pod logs are enabled on OAP.') }}</span>
    </div>

    <div v-if="selectedContainer && hasInstance" class="pane-head">
      <span class="ph-name">{{ selectedContainer }}</span>
      <span class="ph-count">{{ lines.length }} {{ t('lines') }}</span>
      <span class="ph-right">
        <span class="dot" :class="{ live: tailing }" />
        <span class="ph-state">{{ tailing ? t('Live') : t('Paused') }}</span>
        <span v-if="updatedAgo" class="ph-ago">· {{ t('updated') }} {{ updatedAgo }}</span>
      </span>
    </div>

    <div class="pane-wrap">
      <div
        v-if="!hasService || !hasInstance || !selectedContainer"
        class="empty"
      >
        <template v-if="!hasService">{{ t('Select a service to begin.') }}</template>
        <template v-else-if="!hasInstance">{{ t('Select a pod to list its containers.') }}</template>
        <template v-else>{{ t('Select a container, then press Start to tail its logs.') }}</template>
      </div>
      <div ref="host" class="pane" :class="{ hidden: !hasService || !hasInstance || !selectedContainer }" />
    </div>
  </div>
</template>

<style scoped>
.pod-logs {
  display: flex;
  flex-direction: column;
  background: var(--sw-bg-0);
}
.bar {
  flex: 0 0 auto;
  padding: 10px 14px;
  border-bottom: 1px solid var(--sw-line);
  background: var(--sw-bg-1);
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.ctrls { display: flex; align-items: flex-end; gap: 10px; flex-wrap: wrap; }
.ctrl  { display: flex; flex-direction: column; gap: 3px; }
.lbl   { font-size: 11px; color: var(--sw-fg-3); }
.inp {
  height: 26px;
  padding: 0 24px 0 8px;
  background: var(--sw-bg-2)
    url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 6' width='10' height='6'><path d='M1 1l4 4 4-4' stroke='%23818a9c' stroke-width='1.4' fill='none' stroke-linecap='round'/></svg>")
    right 8px center / 9px no-repeat;
  border: 1px solid var(--sw-line-2);
  border-radius: 4px;
  color: var(--sw-fg-0);
  font-size: 12px;
  min-width: 150px;
  -webkit-appearance: none;
  -moz-appearance: none;
  appearance: none;
  cursor: pointer;
}
.inp:hover:not(:disabled) { border-color: var(--sw-line); }
.inp:focus { outline: none; border-color: var(--sw-accent); }
.inp:disabled { opacity: 0.5; cursor: not-allowed; background-image: none; }
.tail-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 26px;
  padding: 0 14px;
  border: 1px solid var(--sw-accent);
  border-radius: 4px;
  background: var(--sw-accent);
  color: #1a1106;
  font-size: 12px;
  font-weight: 700;
  cursor: pointer;
}
.tail-btn.on { background: transparent; color: var(--sw-accent); }
.tail-btn:disabled { opacity: 0.45; cursor: default; border-color: var(--sw-line-2); background: var(--sw-bg-2); color: var(--sw-fg-3); }
.dot { width: 7px; height: 7px; border-radius: 50%; background: var(--sw-fg-3); }
.dot.live { background: #4ade80; animation: pulse 1.2s infinite ease-in-out; }
@keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.35; } }
.tail-btn .dot { background: currentColor; }
.tail-btn .dot.live { background: #4ade80; }

.filters { display: flex; gap: 18px; flex-wrap: wrap; }
.kw { flex: 1 1 340px; display: flex; align-items: center; gap: 5px; flex-wrap: wrap; }
.chip {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 1px 4px 1px 7px;
  border-radius: 10px;
  background: rgba(125, 211, 252, 0.16);
  color: #7dd3fc;
  font-size: 11px;
}
.chip.ex { background: rgba(248, 113, 113, 0.16); color: #f87171; }
.chip .x { border: none; background: transparent; color: inherit; cursor: pointer; font-size: 13px; line-height: 1; padding: 0 2px; }
.kw-inp {
  height: 22px;
  flex: 1 1 200px;
  min-width: 200px;
  padding: 0 8px;
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line-2);
  border-radius: 4px;
  color: var(--sw-fg-0);
  font-size: 11.5px;
}

.banner {
  flex: 0 0 auto;
  margin: 8px 14px 0;
  padding: 7px 10px;
  border: 1px solid rgba(240, 160, 75, 0.5);
  background: rgba(240, 160, 75, 0.1);
  border-radius: 4px;
  font-size: 11.5px;
  color: #f0a04b;
}
.banner .hint { color: var(--sw-fg-3); }

.pane-head {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 10px 14px 0;
  padding: 5px 10px;
  border: 1px solid var(--sw-line);
  border-bottom: 0;
  border-radius: 4px 4px 0 0;
  background: var(--sw-bg-1);
  font-size: 11px;
}
.ph-name { font-family: 'JetBrains Mono', ui-monospace, monospace; color: var(--sw-fg-0); font-weight: 600; }
.ph-count { color: var(--sw-fg-3); font-variant-numeric: tabular-nums; }
.ph-right { margin-left: auto; display: inline-flex; align-items: center; gap: 6px; }
.ph-state { color: var(--sw-fg-2); }
.ph-ago { color: var(--sw-fg-3); font-variant-numeric: tabular-nums; }

/* Fixed height, not flex: the shell's tab-body is content-height, so flex:1 collapses the absolute Monaco pane. */
.pane-wrap { position: relative; height: min(68vh, 720px); min-height: 360px; margin: 0 14px 14px; }
.pane { position: absolute; inset: 0; border: 1px solid var(--sw-line); border-radius: 0 0 4px 4px; overflow: hidden; }
.pane.hidden { visibility: hidden; }
.empty {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  color: var(--sw-fg-3);
  font-size: 12.5px;
  z-index: 1;
}
</style>
