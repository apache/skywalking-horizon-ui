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
  Bottom-of-page timeline strip for the 3D infra map loading pipeline.

  Five stages run left-to-right:
    services  →  templates  →  topologies  →  layout  →  metrics

  Each icon shows its status (idle / running / ok / warn / error) and a
  one-line summary. Clicking an icon opens a drawer above the strip
  with stage-specific detail (per-layer topology probe rows, services
  diff, metric chunk progress, etc.).

  The strip is 32px tall when expanded and ~6px when collapsed. The
  parent gates mount on the same `ready` flag as the scene — we don't
  want to render a half-state timeline before the config is loaded.
-->
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import type { DeepReadonly } from 'vue';
import type { PipelineStageId, StageState } from './composables/useInfra3dPipeline';

// The pipeline composable exposes `readonly()` wrapped state; we
// accept it deep-readonly to match without forcing the caller to cast.
const props = defineProps<{
  stages: DeepReadonly<Record<PipelineStageId, StageState>>;
  stageOrder: readonly PipelineStageId[];
  running: boolean;
  /** Epoch ms of the next scheduled auto-refresh (parent-owned). Drives
   *  the live countdown beside the refresh button. Null = no countdown. */
  nextRefreshAt?: number | null;
}>();

// Live 1 Hz clock so the countdown ticks down on its own — the parent
// only updates `nextRefreshAt` once per (re)schedule, not every second.
const now = ref(Date.now());
let clockTimer: ReturnType<typeof setInterval> | null = null;
onMounted(() => {
  clockTimer = setInterval(() => { now.value = Date.now(); }, 1000);
});
onUnmounted(() => {
  if (clockTimer !== null) clearInterval(clockTimer);
});
/** `m:ss` until the next auto-refresh; null while a run is in flight
 *  (the strip shows "refreshing…" then) or when no refresh is armed. */
const countdown = computed<string | null>(() => {
  if (props.running || props.nextRefreshAt == null) return null;
  const secs = Math.max(0, Math.ceil((props.nextRefreshAt - now.value) / 1000));
  return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
});

const emit = defineEmits<{
  /** Operator clicked the refresh button — re-run the whole pipeline. */
  (e: 'refresh'): void;
}>();

const openStage = ref<PipelineStageId | null>(null);

function toggleStage(id: PipelineStageId): void {
  openStage.value = openStage.value === id ? null : id;
}

function statusLabel(s: StageState['status']): string {
  switch (s) {
    case 'idle': return '○';
    case 'running': return '●';
    case 'ok': return '✓';
    case 'warn': return '!';
    case 'error': return '×';
  }
}

function elapsedMs(stage: { startedAt: number | null; endedAt: number | null }): number | null {
  if (!stage.startedAt) return null;
  const end = stage.endedAt ?? Date.now();
  return end - stage.startedAt;
}

const stageLabels: Record<PipelineStageId, string> = {
  services: 'Services',
  templates: 'Templates',
  topologies: 'Topologies',
  hierarchy: 'Hierarchy',
  layout: 'Layout',
  metrics: 'Metrics',
};

// Deep-readonly variant of `StageState` — what `props.stages` carries.
// Used for the open-stage computed so we don't fight the readonly
// wrapper from `readonly(...)` upstream. The drawer renders only.
type ROStageState = DeepReadonly<StageState>;
const openStageState = computed<ROStageState | null>(() => {
  if (!openStage.value) return null;
  return (props.stages[openStage.value] as ROStageState | undefined) ?? null;
});
</script>

<template>
  <div class="pl">
    <!-- Drawer (above the strip) -->
    <div v-if="openStageState" class="drawer">
      <header class="drawer-head">
        <span class="drawer-title">{{ stageLabels[openStageState.id] }} · stage</span>
        <span class="drawer-meta" v-if="elapsedMs(openStageState) !== null">
          {{ elapsedMs(openStageState) }} ms
        </span>
        <span class="drawer-status" :data-status="openStageState.status">{{ openStageState.status }}</span>
        <button class="drawer-x" type="button" @click="openStage = null">×</button>
      </header>
      <div class="drawer-body">
        <p v-if="openStageState.summary" class="drawer-summary">{{ openStageState.summary }}</p>

        <!-- Services -->
        <template v-if="openStageState.detail.kind === 'services'">
          <ul class="kv">
            <li><b>services</b><span>{{ openStageState.detail.servicesTotal }}</span></li>
            <li><b>layers</b><span>{{ openStageState.detail.layersTotal }}</span></li>
            <li v-if="openStageState.detail.addedSince !== null">
              <b>added since last run</b><span>{{ openStageState.detail.addedSince }}</span>
            </li>
            <li v-if="openStageState.detail.removedSince !== null">
              <b>removed since last run</b><span>{{ openStageState.detail.removedSince }}</span>
            </li>
          </ul>
          <details v-if="(openStageState.detail.hiddenNoTemplate?.length ?? 0) > 0">
            <summary>hidden — no layer template (refresh to load)</summary>
            <code class="layer-list">{{ openStageState.detail.hiddenNoTemplate?.join(', ') }}</code>
          </details>
        </template>

        <!-- Templates -->
        <template v-else-if="openStageState.detail.kind === 'templates'">
          <ul class="kv">
            <li><b>with topology widget</b><span>{{ openStageState.detail.layersWithTopology.length }}</span></li>
            <li><b>without</b><span>{{ openStageState.detail.layersWithoutTopology.length }}</span></li>
          </ul>
          <details>
            <summary>topology layers</summary>
            <code class="layer-list">{{ openStageState.detail.layersWithTopology.join(', ') || '—' }}</code>
          </details>
        </template>

        <!-- Topologies -->
        <template v-else-if="openStageState.detail.kind === 'topologies'">
          <table class="probes">
            <thead>
              <tr><th>layer</th><th>status</th><th>nodes</th><th>edges</th><th>ms</th></tr>
            </thead>
            <tbody>
              <tr v-for="p in openStageState.detail.probes" :key="p.layerKey" :data-status="p.status">
                <td class="mono">{{ p.layerKey }}</td>
                <td>{{ p.status }}</td>
                <td>{{ p.nodeCount ?? '—' }}</td>
                <td>{{ p.edgeCount ?? '—' }}</td>
                <td>{{ p.ms ?? '—' }}</td>
              </tr>
            </tbody>
          </table>
        </template>

        <!-- Layout -->
        <template v-else-if="openStageState.detail.kind === 'layout'">
          <ul class="kv">
            <li><b>layers re-laid</b><span>{{ openStageState.detail.layersReLaid }}</span></li>
            <li><b>compute</b><span>{{ openStageState.detail.ms }} ms</span></li>
          </ul>
        </template>

        <!-- Metrics -->
        <template v-else-if="openStageState.detail.kind === 'metrics'">
          <ul class="kv">
            <li><b>services done</b><span>{{ openStageState.detail.servicesDone }} / {{ openStageState.detail.servicesTotal }}</span></li>
            <li><b>chunk</b><span>{{ openStageState.detail.chunkIndex }} / {{ openStageState.detail.chunkTotal }}</span></li>
            <li v-if="openStageState.detail.currentLevel">
              <b>current level</b><span>{{ openStageState.detail.currentLevel }}</span>
            </li>
          </ul>
          <div class="bar">
            <span
              class="bar-fill"
              :style="{
                width: openStageState.detail.servicesTotal === 0
                  ? '0%'
                  : `${Math.round((openStageState.detail.servicesDone / openStageState.detail.servicesTotal) * 100)}%`
              }"
            />
          </div>
        </template>

        <template v-else>
          <p class="dim">No detail yet.</p>
        </template>
      </div>
    </div>

    <!-- Strip -->
    <div class="strip">
      <button
        v-for="id in props.stageOrder"
        :key="id"
        type="button"
        class="step"
        :class="['s-' + props.stages[id].status, { open: openStage === id }]"
        @click="toggleStage(id)"
      >
        <span class="step-icon">{{ statusLabel(props.stages[id].status) }}</span>
        <span class="step-label">{{ stageLabels[id] }}</span>
        <span class="step-sum" :title="props.stages[id].summary">{{ props.stages[id].summary }}</span>
      </button>
      <!-- Countdown sits right after the stages — next to the data that
           re-runs on each refresh (Metrics is the live-window stage) —
           rather than by the button, so it reads as "this data refreshes
           in m:ss". -->
      <span
        v-if="props.running"
        class="next-refresh running"
        title="pipeline is running…"
      >refreshing…</span>
      <span
        v-else-if="countdown"
        class="next-refresh"
        title="time until the next auto-refresh"
      >next ↻ {{ countdown }}</span>
      <span class="spacer" />
      <button
        type="button"
        class="refresh"
        :disabled="props.running"
        :title="props.running ? 'pipeline is running…' : 're-run pipeline now'"
        @click="emit('refresh')"
      >↻</button>
    </div>
  </div>
</template>

<style scoped>
.pl {
  display: flex;
  flex-direction: column;
  background: rgba(15, 19, 26, 0.92);
  border-top: 1px solid var(--sw-line);
  backdrop-filter: blur(6px);
  /* Above the bottom-left brand mark (z 70) so the stage-detail drawer,
   *  which expands up into the brand's corner, is never occluded by it. */
  z-index: 80;
}

/* Strip */
.strip {
  display: flex;
  align-items: stretch;
  height: 32px;
  padding: 0 8px;
  gap: 2px;
}
.step {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 0 10px;
  height: 100%;
  background: transparent;
  border: none;
  color: var(--sw-fg-2);
  cursor: pointer;
  font-size: 11px;
  border-bottom: 2px solid transparent;
}
.step:hover { background: var(--sw-bg-2); }
.step.open  { background: var(--sw-bg-2); border-bottom-color: var(--sw-accent); }
.step-icon {
  display: inline-block;
  width: 14px;
  text-align: center;
  font-weight: 700;
}
.step-label { font-weight: 600; color: var(--sw-fg-1); }
.step-sum   {
  font-size: 10.5px;
  color: var(--sw-fg-3);
  max-width: 200px;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.step.s-idle    .step-icon { color: var(--sw-fg-3); }
.step.s-running .step-icon { color: #fcc419; animation: pulse 1.2s infinite ease-in-out; }
.step.s-ok      .step-icon { color: #4ade80; }
.step.s-warn    .step-icon { color: #f0a04b; }
.step.s-error   .step-icon { color: #f87171; }
@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.45; } }

.spacer { flex: 1; }
.next-refresh {
  display: inline-flex;
  align-items: center;
  align-self: center;
  font-size: 10.5px;
  color: var(--sw-fg-3);
  margin-right: 8px;
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.02em;
  white-space: nowrap;
}
.next-refresh.running { color: #fcc419; }
.refresh {
  width: 28px;
  border: 1px solid var(--sw-line-2);
  background: var(--sw-bg-2);
  color: var(--sw-fg-1);
  border-radius: 3px;
  font-size: 14px;
  cursor: pointer;
  margin: 4px 0;
}
.refresh:hover:not([disabled]) { background: var(--sw-bg-3); color: var(--sw-fg-0); }
.refresh[disabled] { opacity: 0.4; cursor: default; }

/* Drawer */
.drawer {
  border-bottom: 1px solid var(--sw-line);
  background: var(--sw-bg-1);
  max-height: 280px;
  overflow-y: auto;
}
.drawer-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 12px;
  border-bottom: 1px solid var(--sw-line);
  background: var(--sw-bg-2);
  position: sticky;
  top: 0;
}
.drawer-title { font-size: 11.5px; font-weight: 700; color: var(--sw-fg-0); }
.drawer-meta  { font-size: 10.5px; color: var(--sw-fg-3); }
.drawer-status {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 8px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.drawer-status[data-status='ok']    { background: rgba(74, 222, 128, 0.15); color: #4ade80; }
.drawer-status[data-status='warn']  { background: rgba(240, 160, 75, 0.15); color: #f0a04b; }
.drawer-status[data-status='error'] { background: rgba(248, 113, 113, 0.15); color: #f87171; }
.drawer-status[data-status='running'] { background: rgba(252, 196, 25, 0.15); color: #fcc419; }
.drawer-status[data-status='idle']   { background: var(--sw-bg-3); color: var(--sw-fg-3); }
.drawer-x {
  margin-left: auto;
  width: 22px;
  height: 20px;
  border: none;
  background: transparent;
  color: var(--sw-fg-3);
  font-size: 14px;
  cursor: pointer;
}
.drawer-x:hover { color: var(--sw-fg-0); }

.drawer-body { padding: 10px 14px; font-size: 11px; color: var(--sw-fg-1); }
.drawer-summary { margin: 0 0 8px; color: var(--sw-fg-2); }
.kv {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 4px 14px;
}
.kv li { display: flex; justify-content: space-between; }
.kv b { color: var(--sw-fg-3); font-weight: 400; }
.kv span { font-family: var(--sw-mono-font, monospace); color: var(--sw-fg-0); }
.dim { color: var(--sw-fg-3); margin: 0; font-style: italic; }
.bar {
  margin-top: 6px;
  height: 6px;
  border-radius: 3px;
  background: var(--sw-bg-3);
  overflow: hidden;
}
.bar-fill {
  display: block;
  height: 100%;
  background: var(--sw-accent);
  transition: width 0.18s ease-out;
}
details summary { font-size: 10.5px; color: var(--sw-fg-3); cursor: pointer; margin-top: 6px; }
.layer-list { display: block; margin: 6px 0; font-size: 10.5px; color: var(--sw-fg-1); }
.probes {
  width: 100%;
  border-collapse: collapse;
  font-size: 10.5px;
}
.probes th, .probes td { text-align: left; padding: 3px 6px; border-bottom: 1px dashed var(--sw-line); }
.probes th { font-weight: 600; color: var(--sw-fg-3); }
.probes tr[data-status='ok']     td { color: var(--sw-fg-1); }
.probes tr[data-status='empty']  td { color: var(--sw-fg-3); }
.probes tr[data-status='failed'] td { color: #f87171; }
.mono { font-family: var(--sw-mono-font, monospace); }
</style>
