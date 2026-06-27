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
  The selected-edge sidebar of the Deployment view: aligned client | server
  rows (same as the instance map), each with a sparkline. The hover crosshair is
  owned here — hovering a bucket in one cell syncs the tip + crosshair across the
  client/server pair of that row.
-->
<script setup lang="ts">
import { ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { DeploymentCall, DeploymentMetricDef, DeploymentNode } from '@/api/client';
import Sparkline from '@/components/charts/Sparkline.vue';
import { useEscapeToClose } from '@/components/primitives/useEscapeToClose';

export interface EdgeRow { id: string; label: string; unit: string; serverDef: DeploymentMetricDef | null; clientDef: DeploymentMetricDef | null }
type EdgeRowKind = 'both' | 'client-only' | 'server-only' | 'none';

const props = defineProps<{
  selectedCall: DeploymentCall;
  edgeRows: EdgeRow[];
  selectedPrimaryIds: Set<string>;
  instById: (id: string) => DeploymentNode | null;
  edgeRowValues: (c: DeploymentCall, row: EdgeRow) => { kind: EdgeRowKind; clientV: number | null; serverV: number | null };
  edgeSeries: (c: DeploymentCall, side: 'server' | 'client', def: DeploymentMetricDef | null) => Array<number | null>;
  fmtEdge: (v: number | null, def: DeploymentMetricDef | null) => string;
  seriesAt: (arr: Array<number | null>, idx: number | null) => number | null;
}>();
const emit = defineEmits<{ (e: 'close'): void }>();
const { t } = useI18n({ useScope: 'global' });

useEscapeToClose(() => true, () => emit('close'));

const hoveredEdgeRowId = ref<string | null>(null);
const hoveredEdgeBucket = ref<number | null>(null);
function onEdgeBucketHover(rowId: string, bucket: number): void { hoveredEdgeRowId.value = rowId; hoveredEdgeBucket.value = bucket; }
function onEdgeBucketLeave(): void { hoveredEdgeRowId.value = null; hoveredEdgeBucket.value = null; }
function rowCrosshair(rowId: string): number | null { return hoveredEdgeRowId.value === rowId ? hoveredEdgeBucket.value : null; }
// A new edge selection clears any stale crosshair.
watch(() => props.selectedCall.id, () => { hoveredEdgeRowId.value = null; hoveredEdgeBucket.value = null; });
</script>

<template>
  <aside class="sit-panel">
    <header class="sit-panel-head">
      <div class="ip-edge mono">
        <span>{{ props.instById(props.selectedCall.source)?.name }}</span>
        <span class="sit-arrow">→</span>
        <span>{{ props.instById(props.selectedCall.target)?.name }}</span>
      </div>
      <button class="sw-btn small ghost" type="button" @click="emit('close')">×</button>
    </header>
    <div class="ip-tags">
      <span class="sw-tag">{{ props.selectedCall.detectPoints.join(' · ') || t('relation') }}</span>
    </div>
    <div class="sit-panel-body">
      <div v-if="props.edgeRows.length > 0" class="ip-edge-rows">
        <div v-for="row in props.edgeRows" :key="row.id" class="ip-edge-row">
          <div class="ip-edge-row-head">
            <span class="ip-edge-row-label">{{ row.label }}<span v-if="row.unit" class="ru"> ({{ row.unit }})</span><span v-if="props.selectedPrimaryIds.has(row.id)" class="ip-edge-prim" :title="t('Shown on the edge (primary)')">{{ t('★ on edge') }}</span></span>
            <span v-if="hoveredEdgeRowId === row.id && hoveredEdgeBucket !== null" class="ip-edge-tip">
              <template v-if="row.clientDef"><span class="tip-tag" style="color: var(--sw-info)">C</span><span class="tip-val">{{ props.fmtEdge(props.seriesAt(props.edgeSeries(props.selectedCall, 'client', row.clientDef), hoveredEdgeBucket), row.clientDef) }}</span></template>
              <template v-if="row.serverDef"><span class="tip-sep">·</span><span class="tip-tag" style="color: var(--sw-accent)">S</span><span class="tip-val">{{ props.fmtEdge(props.seriesAt(props.edgeSeries(props.selectedCall, 'server', row.serverDef), hoveredEdgeBucket), row.serverDef) }}</span></template>
            </span>
          </div>
          <template v-if="props.edgeRowValues(props.selectedCall, row).kind === 'both'">
            <div class="ip-edge-pair">
              <div class="ip-edge-cell">
                <div class="ip-edge-cell-head"><span class="tag c">{{ t('Client') }}</span><span class="num">{{ props.fmtEdge(props.edgeRowValues(props.selectedCall, row).clientV, row.clientDef) }}</span></div>
                <Sparkline :values="props.edgeSeries(props.selectedCall, 'client', row.clientDef)" color="var(--sw-info)" :height="36" :stroke="1.4" fluid :crosshair-bucket="rowCrosshair(row.id)" @bucket-hover="(b: number) => onEdgeBucketHover(row.id, b)" @bucket-leave="onEdgeBucketLeave" />
              </div>
              <div class="ip-edge-cell">
                <div class="ip-edge-cell-head"><span class="tag s">{{ t('Server') }}</span><span class="num">{{ props.fmtEdge(props.edgeRowValues(props.selectedCall, row).serverV, row.serverDef) }}</span></div>
                <Sparkline :values="props.edgeSeries(props.selectedCall, 'server', row.serverDef)" color="var(--sw-accent)" :height="36" :stroke="1.4" fluid :crosshair-bucket="rowCrosshair(row.id)" @bucket-hover="(b: number) => onEdgeBucketHover(row.id, b)" @bucket-leave="onEdgeBucketLeave" />
              </div>
            </div>
          </template>
          <template v-else-if="props.edgeRowValues(props.selectedCall, row).kind === 'client-only'">
            <div class="ip-edge-cell">
              <div class="ip-edge-cell-head"><span class="tag c">{{ t('Client') }}</span><span class="num">{{ props.fmtEdge(props.edgeRowValues(props.selectedCall, row).clientV, row.clientDef) }}</span></div>
              <Sparkline :values="props.edgeSeries(props.selectedCall, 'client', row.clientDef)" color="var(--sw-info)" :height="36" :stroke="1.4" fluid :crosshair-bucket="rowCrosshair(row.id)" @bucket-hover="(b: number) => onEdgeBucketHover(row.id, b)" @bucket-leave="onEdgeBucketLeave" />
            </div>
          </template>
          <template v-else-if="props.edgeRowValues(props.selectedCall, row).kind === 'server-only'">
            <div class="ip-edge-cell">
              <div class="ip-edge-cell-head"><span class="tag s">{{ t('Server') }}</span><span class="num">{{ props.fmtEdge(props.edgeRowValues(props.selectedCall, row).serverV, row.serverDef) }}</span></div>
              <Sparkline :values="props.edgeSeries(props.selectedCall, 'server', row.serverDef)" color="var(--sw-accent)" :height="36" :stroke="1.4" fluid :crosshair-bucket="rowCrosshair(row.id)" @bucket-hover="(b: number) => onEdgeBucketHover(row.id, b)" @bucket-leave="onEdgeBucketLeave" />
            </div>
          </template>
          <template v-else>
            <div class="ip-edge-none">{{ t('no value') }}</div>
          </template>
        </div>
      </div>
      <div v-else class="ip-empty">{{ t('no line metrics configured') }}</div>
    </div>
  </aside>
</template>

<style scoped>
.sit-arrow { color: var(--sw-accent); font-weight: 700; }
.sit-panel { border: 1px solid var(--sw-line); border-radius: 6px; background: var(--sw-bg-1); display: flex; flex-direction: column; min-width: 0; overflow: hidden; }
.sit-panel-head { display: flex; align-items: flex-start; gap: 8px; padding: 8px 12px; border-bottom: 1px solid var(--sw-line); flex: 0 0 auto; }
.ip-edge { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; flex: 1; font-size: 11px; color: var(--sw-fg-0); word-break: break-all; }
.ip-tags { padding: 6px 12px 0; }
.sit-panel-body { flex: 1; overflow-y: auto; padding: 10px 12px 16px; }
.ip-edge-rows { display: flex; flex-direction: column; gap: 10px; }
.ip-edge-row { border: 1px solid var(--sw-line); border-radius: 4px; padding: 6px 8px; background: var(--sw-bg-0); }
.ip-edge-row-head { display: flex; align-items: baseline; justify-content: space-between; gap: 6px; margin-bottom: 4px; }
.ip-edge-row-label { font-size: 10.5px; color: var(--sw-fg-2); }
.ip-edge-row-label .ru { color: var(--sw-fg-3); }
.ip-edge-prim {
  margin-left: 6px;
  padding: 0 5px;
  border-radius: 3px;
  font-size: 9px;
  color: var(--sw-accent);
  background: color-mix(in srgb, var(--sw-accent) 14%, transparent);
}
.ip-edge-tip { display: inline-flex; align-items: baseline; gap: 4px; font-size: 10px; font-family: var(--sw-mono); }
.ip-edge-tip .tip-tag { font-weight: 700; }
.ip-edge-tip .tip-val { color: var(--sw-fg-1); }
.ip-edge-tip .tip-sep { color: var(--sw-fg-3); }
.ip-edge-pair { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.ip-edge-cell { min-width: 0; }
.ip-edge-cell-head { display: flex; align-items: baseline; gap: 6px; margin-bottom: 2px; }
.ip-edge-cell-head .tag { font-size: 8.5px; text-transform: uppercase; letter-spacing: 0.05em; font-weight: 700; }
.ip-edge-cell-head .tag.c { color: var(--sw-info); }
.ip-edge-cell-head .tag.s { color: var(--sw-accent); }
.ip-edge-cell-head .num { font-family: var(--sw-mono); font-size: 11px; color: var(--sw-fg-0); }
.ip-edge-none, .ip-empty { color: var(--sw-fg-3); font-size: 11px; padding: 6px 0; }
.mono { font-family: var(--sw-mono); }
.sw-btn.small { height: 24px; padding: 0 10px; font-size: 11px; }
.sw-btn.ghost { background: transparent; border: 1px solid var(--sw-line-2); color: var(--sw-fg-2); cursor: pointer; }
</style>
