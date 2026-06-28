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
  Network-profiling process-relation config editor — client + server edge
  metrics for the process-topology detail panel. Config-local: owns the
  `processTopology` block via v-model and seeds an empty one on mount. Same
  pattern as DependencyConfigSection; edge rows are the lean MetricDefinitionRow
  (no role / thresholds).
-->
<script setup lang="ts">
import { computed, onMounted } from 'vue';
import type { ProcessTopologyConfig, TopologyMetricDef } from '@skywalking-horizon-ui/api-client';
import MetricDefinitionRow from './MetricDefinitionRow.vue';
import { rowKey } from './row-key';

const config = defineModel<ProcessTopologyConfig | undefined>('config');

function ensure(): ProcessTopologyConfig {
  if (!config.value) config.value = { edgeClientMetrics: [], edgeServerMetrics: [] };
  if (!config.value.edgeClientMetrics) config.value.edgeClientMetrics = [];
  if (!config.value.edgeServerMetrics) config.value.edgeServerMetrics = [];
  return config.value;
}
onMounted(ensure);

const clientMetrics = computed(() => config.value?.edgeClientMetrics ?? []);
const serverMetrics = computed(() => config.value?.edgeServerMetrics ?? []);

function blankMetric(n: number): TopologyMetricDef {
  return { id: `metric_${n + 1}`, label: `Metric ${n + 1}`, mqe: '', unit: '', aggregation: 'avg' };
}
function addClient(): void {
  ensure().edgeClientMetrics.push(blankMetric(clientMetrics.value.length));
}
function addServer(): void {
  ensure().edgeServerMetrics.push(blankMetric(serverMetrics.value.length));
}
function move(list: TopologyMetricDef[], i: number, dir: -1 | 1): void {
  const j = i + dir;
  if (j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j], list[i]];
}
function remove(list: TopologyMetricDef[], i: number): void {
  list.splice(i, 1);
}
</script>

<template>
  <section class="sw-card editor-card topo-cfg-card">
    <div class="card-head">
      <h4>Network profiling — process-relation config</h4>
      <span class="sub">edge MQE for the process-topology detail panel. Queried under ProcessRelation when an operator clicks a process→process call.</span>
    </div>
    <div class="topo-cfg-body">
      <div class="topo-cfg-section">
        <header class="topo-cfg-head">
          <h5>Client-side metrics</h5>
          <span class="sub">edge metrics queried as <code>process_relation_client_*</code></span>
          <button class="sw-btn add" type="button" @click="addClient">＋ Add</button>
        </header>
        <div v-if="clientMetrics.length === 0" class="topo-cfg-empty">No client-side metrics.</div>
        <div v-else class="metric-list">
          <MetricDefinitionRow
            v-for="(m, i) in clientMetrics"
            :key="rowKey(m)"
            v-model:metric="clientMetrics[i]"
            mqe-placeholder="process_relation_client_write_cpm"
            :can-move-up="i > 0"
            :can-move-down="i < clientMetrics.length - 1"
            @move-up="move(clientMetrics, i, -1)"
            @move-down="move(clientMetrics, i, 1)"
            @remove="remove(clientMetrics, i)"
          />
        </div>
      </div>

      <div class="topo-cfg-section">
        <header class="topo-cfg-head">
          <h5>Server-side metrics</h5>
          <span class="sub">edge metrics queried as <code>process_relation_server_*</code></span>
          <button class="sw-btn add" type="button" @click="addServer">＋ Add</button>
        </header>
        <div v-if="serverMetrics.length === 0" class="topo-cfg-empty">No server-side metrics.</div>
        <div v-else class="metric-list">
          <MetricDefinitionRow
            v-for="(m, i) in serverMetrics"
            :key="rowKey(m)"
            v-model:metric="serverMetrics[i]"
            mqe-placeholder="process_relation_server_write_cpm"
            :can-move-up="i > 0"
            :can-move-down="i < serverMetrics.length - 1"
            @move-up="move(serverMetrics, i, -1)"
            @move-down="move(serverMetrics, i, 1)"
            @remove="remove(serverMetrics, i)"
          />
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
/* config-editor chrome (duplicated scoped; .sw-card / .sw-btn are global) */
.editor-card { padding: 0; overflow: visible; }
.topo-cfg-card .topo-cfg-body { padding: 4px 0 0; }
.card-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--sw-line);
}
.card-head h4 { margin: 0; font-size: 12px; font-weight: 600; color: var(--sw-fg-0); text-transform: capitalize; }
.card-head .sub { font-size: 10.5px; color: var(--sw-fg-3); }
.topo-cfg-body { padding: 12px 14px 16px; }
.topo-cfg-section { padding: 12px 16px; border-bottom: 1px solid var(--sw-line); }
.topo-cfg-section:last-child { border-bottom: none; }
.topo-cfg-head { display: flex; align-items: baseline; gap: 10px; margin-bottom: 8px; }
.topo-cfg-head h5 {
  margin: 0;
  font-size: 11.5px;
  font-weight: 700;
  color: var(--sw-accent);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
.topo-cfg-head .sub { font-size: 10.5px; color: var(--sw-fg-3); flex: 1; }
.topo-cfg-head .sub code { font-family: var(--sw-mono); color: var(--sw-fg-1); background: var(--sw-bg-2); padding: 0 4px; border-radius: 3px; }
.topo-cfg-head .sw-btn.add {
  background: var(--sw-accent);
  color: var(--sw-bg-0);
  border: none;
  height: 24px;
  padding: 0 10px;
  font-size: 11px;
  border-radius: 4px;
  cursor: pointer;
}
.topo-cfg-empty {
  font-size: 11.5px;
  color: var(--sw-fg-3);
  padding: 12px;
  text-align: center;
  background: var(--sw-bg-2);
  border-radius: 4px;
}
.metric-list { display: flex; flex-direction: column; gap: 8px; }
</style>
