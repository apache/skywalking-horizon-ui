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
  Service-list metrics editor — the columns (+ default sort) shown in the
  picker zone's services table, used across the per-layer page. Config-local:
  owns the template's `metrics` block via v-model and seeds an empty one on
  mount (mirrors the legacy ensureMetrics) so the operator can add columns
  without hand-editing JSON. The block is mutated IN PLACE (it is part of the
  live draft), so the model value is the same object the parent's draft holds.
  The sample-data preview fires no MQE — it shows how the configured columns
  render (label, scale, precision, unit, default-sort marker).
-->
<script setup lang="ts">
import { computed, onMounted } from 'vue';
import type { AdminLayerTemplate } from '@/api/client';
import { fmtMetric } from '@/utils/formatters';
import { rowKey } from './row-key';

const config = defineModel<AdminLayerTemplate['metrics'] | undefined>('config');
defineProps<{ serviceLabel: string }>();

function ensure(): NonNullable<AdminLayerTemplate['metrics']> {
  if (!config.value) config.value = {};
  return config.value;
}
onMounted(ensure);

// Mirrors the legacy metricsModel: seeds the block on access so the orderBy
// control + columns table render even before the operator touches the JSON
// (the block is part of the live draft and is mutated in place).
const metricsModel = computed(() => {
  ensure();
  return config.value;
});
const metricsColumns = computed(() => {
  const m = ensure();
  if (!m.columns) m.columns = [];
  return m.columns;
});
function addMetricColumn(): void {
  const m = ensure();
  if (!m.columns) m.columns = [];
  m.columns.push({
    metric: `metric_${m.columns.length + 1}`,
    label: `Metric ${m.columns.length + 1}`,
    aggregation: 'avg',
  });
}
function deleteMetricColumn(i: number): void {
  if (!config.value?.columns) return;
  config.value.columns.splice(i, 1);
}
// Number inputs clear to undefined, not "" — scale/precision are optional
// numbers, so an empty string would serialize an invalid value into the saved
// template and break the renderer's numeric coercion.
function setNum(col: { scale?: number; precision?: number }, key: 'scale' | 'precision', e: Event): void {
  const v = (e.target as HTMLInputElement).value;
  col[key] = v === '' ? undefined : Number(v);
}

/** Sample rows for the service-list preview — three fake services with
 *  deterministic per-column values so the author sees how the configured
 *  columns render (label, scale, precision, unit, default-sort marker)
 *  without firing any MQE. */
const SAMPLE_SERVICES = ['checkout', 'inventory', 'gateway'];
function previewBase(seed: number): number {
  return [42.37, 1280.5, 0.918][seed % 3] * (1 + (seed % 5) * 0.35);
}
function previewCell(col: { scale?: number; precision?: number; unit?: string }, seed: number): string {
  const v = previewBase(seed) * (col.scale ?? 1);
  const num = col.precision != null ? v.toFixed(col.precision) : fmtMetric(v);
  return col.unit ? `${num} ${col.unit}` : num;
}
/** The metric the service list sorts by — explicit `orderBy`, else the
 *  first column (mirrors the renderer's fallback). */
const effectiveOrderBy = computed(
  () => config.value?.orderBy ?? metricsColumns.value[0]?.metric,
);
</script>

<template>
  <!-- Service-list metrics: the columns shown in the picker
       zone's services table + the default sort. Used across
       the per-layer page. -->
  <section class="sw-card metrics-card">
    <div class="card-head">
      <h4>Service list metrics</h4>
      <span class="sub">columns + default sort for the service list (picker zone)</span>
      <button class="sw-btn add" type="button" @click="addMetricColumn">＋ Add column</button>
    </div>
    <div v-if="metricsModel" class="metrics-keys">
      <label>
        <span>Default sort (orderBy)</span>
        <select v-model="metricsModel.orderBy">
          <option :value="undefined">(first column)</option>
          <option v-for="c in metricsColumns" :key="c.metric" :value="c.metric">{{ c.metric }}</option>
        </select>
      </label>
    </div>
    <div v-if="metricsColumns.length === 0" class="empty inset">
      No metric columns defined. Click "Add column" to start.
    </div>
    <table v-else class="sw-table metrics-table">
      <thead>
        <tr>
          <th>metric</th>
          <th>label</th>
          <th>unit</th>
          <th>aggregation</th>
          <th class="grow">mqe</th>
          <th>scale</th>
          <th>precision</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="(c, i) in metricsColumns" :key="rowKey(c)">
          <td><input class="mono" v-model="c.metric" /></td>
          <td><input v-model="c.label" /></td>
          <td><input v-model="c.unit" placeholder="—" /></td>
          <td>
            <select v-model="c.aggregation">
              <option value="sum">sum</option>
              <option value="avg">avg</option>
            </select>
          </td>
          <td><input class="mono" v-model="c.mqe" placeholder="catalog default" /></td>
          <td><input type="number" step="any" :value="c.scale" placeholder="1" @input="setNum(c, 'scale', $event)" /></td>
          <td><input type="number" min="0" max="6" :value="c.precision" placeholder="auto" @input="setNum(c, 'precision', $event)" /></td>
          <td>
            <button class="sw-btn is-icon danger" type="button" title="Remove column" @click="deleteMetricColumn(i)">✕</button>
          </td>
        </tr>
      </tbody>
    </table>
    <!-- Preview: the service-list sample table — shows how the
         configured columns render (label, scale, precision, unit,
         default-sort marker). Mock values, no MQE fired. -->
    <div v-if="metricsColumns.length > 0" class="metrics-preview">
      <div class="metrics-preview-head">
        Preview <span class="sub">how this layer’s service list renders (sample data)</span>
      </div>
      <div class="metrics-preview-scroll">
        <table class="sw-table preview-table">
          <thead>
            <tr>
              <th>{{ serviceLabel }}</th>
              <th v-for="c in metricsColumns" :key="c.metric" class="num">
                {{ c.label || c.metric }}
                <span v-if="effectiveOrderBy === c.metric" class="sort-ind" title="default sort">↓</span>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(svc, r) in SAMPLE_SERVICES" :key="svc">
              <td class="svc">{{ svc }}</td>
              <td v-for="(c, ci) in metricsColumns" :key="c.metric" class="num">{{ previewCell(c, r + ci) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </section>
</template>

<style scoped>
/* config-editor chrome (duplicated scoped; .sw-card / .sw-btn / .sw-table are global) */
.metrics-card { padding: 0; }
.card-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--sw-line);
}
.card-head h4 {
  margin: 0;
  font-size: 12px;
  font-weight: 600;
  color: var(--sw-fg-0);
  text-transform: capitalize;
}
.card-head .sub {
  font-size: 10.5px;
  color: var(--sw-fg-3);
}
.card-head .add {
  margin-left: auto;
  font-size: 11.5px;
  background: var(--sw-accent-soft);
  color: var(--sw-accent-2);
  border-color: var(--sw-accent-line);
}
.empty {
  padding: 32px;
  text-align: center;
  color: var(--sw-fg-3);
  font-size: 12px;
}
.empty.inset {
  padding: 18px;
  font-size: 11.5px;
}
.metrics-keys {
  display: flex;
  gap: 14px;
  padding: 10px 16px;
  border-bottom: 1px dashed var(--sw-line);
}
.metrics-keys label {
  display: flex;
  flex-direction: column;
  gap: 3px;
  font-size: 10.5px;
  color: var(--sw-fg-3);
  min-width: 120px;
}
.metrics-keys select {
  height: 26px;
  padding: 0 8px;
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line-2);
  border-radius: 4px;
  color: var(--sw-fg-0);
  font: inherit;
  font-size: 11.5px;
}
.metrics-table {
  width: 100%;
}
.metrics-table th {
  text-align: left;
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--sw-fg-3);
  font-weight: 500;
  padding: 8px 10px 6px;
  border-bottom: 1px solid var(--sw-line);
}
.metrics-table th.grow {
  width: 35%;
}
.metrics-table td {
  padding: 6px 10px;
  border-bottom: 1px solid var(--sw-line);
}
.metrics-table input,
.metrics-table select {
  width: 100%;
  height: 26px;
  padding: 0 6px;
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line-2);
  border-radius: 3px;
  color: var(--sw-fg-0);
  font: inherit;
  font-size: 11.5px;
}
.metrics-table input.mono {
  font-family: var(--sw-mono);
  font-size: 11px;
}
.metrics-table .sw-btn.danger {
  width: 26px;
  height: 26px;
  padding: 0;
  font-size: 11px;
  border-color: rgba(239, 68, 68, 0.3);
  color: #f87171;
}

/* Sample-data preview of the service list. */
.metrics-preview {
  border-top: 1px solid var(--sw-line);
  padding: 12px 10px 6px;
}
.metrics-preview-head {
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--sw-fg-3);
  padding: 0 4px 8px;
}
.metrics-preview-head .sub {
  margin-left: 8px;
  font-weight: 500;
  text-transform: none;
  letter-spacing: 0;
  color: var(--sw-fg-3);
}
.metrics-preview-scroll { overflow-x: auto; }
.preview-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 11.5px;
}
.preview-table th {
  text-align: left;
  font-size: 10px;
  font-weight: 600;
  color: var(--sw-fg-2);
  padding: 6px 10px;
  border-bottom: 1px solid var(--sw-line);
  white-space: nowrap;
}
.preview-table th.num,
.preview-table td.num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.preview-table td {
  padding: 6px 10px;
  border-bottom: 1px solid var(--sw-line);
  color: var(--sw-fg-1);
}
.preview-table td.svc {
  color: var(--sw-fg-0);
  font-weight: 500;
}
.preview-table tbody tr:last-child td { border-bottom: none; }
.sort-ind {
  margin-left: 3px;
  color: var(--sw-accent-2);
  font-size: 10px;
}
</style>
