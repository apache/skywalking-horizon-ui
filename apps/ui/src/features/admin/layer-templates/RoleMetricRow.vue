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
  One editable Deployment metric row (id / label / MQE / unit / agg, optional
  role select, optional edge `alias`, optional collapsible thresholds). The MQE
  field uses MqeExpressionInput (the syntax pop-out), NOT a plain input.
  Used in two shapes in the Deployment editor: the role node-metric rows show
  the thresholds block; the role-pair edge-metric rows show the `alias` field
  instead — the per-shape props select which controls render so both call sites
  reproduce their exact original markup. The metric object is mutated in place
  (it's part of the live draft); move/remove are emitted so the parent wires the
  list-specific handler.
-->
<script setup lang="ts">
import type { DeploymentMetricDef } from '@skywalking-horizon-ui/api-client';
import MqeExpressionInput from '@/features/admin/_shared/MqeExpressionInput.vue';

const metric = defineModel<DeploymentMetricDef>('metric', { required: true });
defineProps<{
  roleOptions?: ReadonlyArray<{ value: DeploymentMetricDef['role'] | ''; label: string }>;
  showRole?: boolean;
  showAlias?: boolean;
  showThresholds?: boolean;
  mqePlaceholder?: string;
  mqeTitle?: string;
  unitPlaceholder?: string;
  canMoveUp: boolean;
  canMoveDown: boolean;
}>();
defineEmits<{ moveUp: []; moveDown: []; remove: [] }>();

function toggleThresholds(m: DeploymentMetricDef): void {
  m.thresholds = m.thresholds ? undefined : { ok: 0.1, warn: 1, danger: 5 };
}
</script>

<template>
  <article class="metric-row">
    <div class="metric-row-head">
      <label class="mf"><span>id</span><input v-model="metric.id" type="text" class="mf-input mono" /></label>
      <label class="mf"><span>label</span><input v-model="metric.label" type="text" class="mf-input" /></label>
      <label v-if="showAlias" class="mf mf-narrow"><span>alias</span><input v-model="metric.alias" type="text" class="mf-input mono" placeholder="W" title="Short prefix on the edge, e.g. W / R" /></label>
      <label class="mf mf-wide"><span>MQE</span><MqeExpressionInput v-model="metric.mqe" :placeholder="mqePlaceholder" :title="mqeTitle" /></label>
      <label class="mf mf-narrow"><span>unit</span><input v-model="metric.unit" type="text" class="mf-input" :placeholder="unitPlaceholder" /></label>
      <label v-if="showRole" class="mf"><span>role</span>
        <select v-model="metric.role" class="mf-input">
          <option v-for="o in roleOptions" :key="String(o.value)" :value="o.value || undefined">{{ o.label }}</option>
        </select>
      </label>
      <label class="mf mf-narrow"><span>agg</span>
        <select v-model="metric.aggregation" class="mf-input"><option value="avg">avg</option><option value="sum">sum</option></select>
      </label>
      <div class="metric-row-actions">
        <button class="sw-btn small ghost" type="button" :disabled="!canMoveUp" title="Move up" @click="$emit('moveUp')">↑</button>
        <button class="sw-btn small ghost" type="button" :disabled="!canMoveDown" title="Move down" @click="$emit('moveDown')">↓</button>
        <button class="sw-btn small ghost danger" type="button" title="Remove" @click="$emit('remove')">×</button>
      </div>
    </div>
    <div v-if="showThresholds" class="metric-thresholds">
      <button class="sw-btn small ghost" type="button" @click="toggleThresholds(metric)">{{ metric.thresholds ? '− Thresholds' : '＋ Thresholds' }}</button>
      <template v-if="metric.thresholds">
        <label class="mf mf-narrow"><span>ok ≤</span><input v-model.number="metric.thresholds.ok" type="number" step="0.1" class="mf-input" /></label>
        <label class="mf mf-narrow"><span>warn ≤</span><input v-model.number="metric.thresholds.warn" type="number" step="0.1" class="mf-input" /></label>
        <label class="mf mf-narrow"><span>danger ≤</span><input v-model.number="metric.thresholds.danger" type="number" step="0.1" class="mf-input" /></label>
        <label class="mf mf-checkbox"><input v-model="metric.thresholds.invertHealth" type="checkbox" /><span>invert (higher = better)</span></label>
        <label v-if="metric.thresholds.invertHealth" class="mf mf-narrow"><span>base</span><input v-model.number="metric.thresholds.invertBase" type="number" step="1" class="mf-input" placeholder="100" /></label>
      </template>
    </div>
  </article>
</template>

<style scoped>
/* metric-row chrome, duplicated scoped (parent keeps its copy until every
   config editor is extracted; .sw-btn is global). */
.metric-row {
  background: var(--sw-bg-1);
  border: 1px solid var(--sw-line);
  border-radius: 4px;
  padding: 8px 10px;
}
.metric-row-head {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  flex-wrap: wrap;
}
.metric-row-actions {
  display: inline-flex;
  gap: 4px;
  margin-left: auto;
  align-self: flex-end;
}
.metric-thresholds {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: flex-end;
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px dashed var(--sw-line);
}
.mf {
  display: inline-flex;
  flex-direction: column;
  gap: 3px;
  font-size: 10px;
  color: var(--sw-fg-3);
  letter-spacing: 0.04em;
  text-transform: uppercase;
  min-width: 110px;
}
.mf.mf-wide { min-width: 220px; flex: 1; }
.mf.mf-narrow { min-width: 80px; }
.mf.mf-checkbox {
  flex-direction: row;
  align-items: center;
  text-transform: none;
  letter-spacing: 0;
  font-size: 10.5px;
  color: var(--sw-fg-2);
  min-width: auto;
}
.mf.mf-checkbox input { accent-color: var(--sw-accent); }
.mf-input {
  height: 26px;
  padding: 0 6px;
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line-2);
  border-radius: 4px;
  color: var(--sw-fg-0);
  font: inherit;
  font-size: 11px;
  width: 100%;
  box-sizing: border-box;
}
.mf-input.mono { font-family: var(--sw-mono); }
</style>
