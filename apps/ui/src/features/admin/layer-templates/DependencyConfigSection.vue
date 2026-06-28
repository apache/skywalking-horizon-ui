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
  Endpoint-dependency (API dependency) config editor — per-node + per-edge
  server-side metrics for the endpoint-relation topology. Config-local: owns
  the `endpointDependency` block via v-model and seeds an empty one on mount
  so the operator can add rows without hand-editing JSON. Rows reuse
  MetricDefinitionRow. The block is mutated IN PLACE (it is part of the live
  draft), so the model value is the same object the parent's draft holds.
-->
<script setup lang="ts">
import { computed, onMounted } from 'vue';
import type { EndpointDependencyConfig, TopologyMetricDef } from '@skywalking-horizon-ui/api-client';
import { TOPOLOGY_ROLE_OPTIONS } from './layer-dashboards.scopes';
import MetricDefinitionRow from './MetricDefinitionRow.vue';
import { rowKey } from './row-key';

const config = defineModel<EndpointDependencyConfig | undefined>('config');

// Seed an empty block on open (mirrors the legacy ensureEndpointDep, which
// auto-created it on first render) so both metric sections render their
// add affordance even before the operator touches the JSON.
function ensure(): EndpointDependencyConfig {
  if (!config.value) config.value = { nodeMetrics: [], linkMetrics: [] };
  if (!config.value.linkMetrics) config.value.linkMetrics = [];
  return config.value;
}
onMounted(ensure);

const nodeMetrics = computed(() => config.value?.nodeMetrics ?? []);
const linkMetrics = computed(() => config.value?.linkMetrics ?? []);
const showGroup = computed(() => Boolean(config.value?.showGroup));

function toggleShowGroup(): void {
  const c = ensure();
  c.showGroup = !c.showGroup;
}
function blankMetric(n: number): TopologyMetricDef {
  return { id: `metric_${n + 1}`, label: `Metric ${n + 1}`, mqe: '', unit: '', aggregation: 'avg' };
}
function addNode(): void {
  ensure().nodeMetrics.push(blankMetric(nodeMetrics.value.length));
}
function addLink(): void {
  ensure().linkMetrics!.push(blankMetric(linkMetrics.value.length));
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
      <h4>API dependency config</h4>
      <span class="sub">node + line metrics (server-side only — OAP has no endpoint client family).</span>
    </div>
    <div class="naming-prefix-row">
      <label class="comp-toggle" :class="{ on: showGroup }">
        <input type="checkbox" :checked="showGroup" @change="toggleShowGroup" />
        <span class="comp-label">Show <code>&lt;group&gt;::</code> as a chip in the node panel</span>
      </label>
      <span class="naming-prefix-hint">Same semantics as the topology view's flag.</span>
    </div>
    <div class="topo-cfg-body">
      <div class="topo-cfg-section">
        <header class="topo-cfg-head">
          <h5>Node metrics</h5>
          <span class="sub">drives endpoint box center number + SLA-coloured border</span>
          <button class="sw-btn add" type="button" @click="addNode">＋ Add</button>
        </header>
        <div v-if="nodeMetrics.length === 0" class="topo-cfg-empty">No node metrics.</div>
        <div v-else class="metric-list">
          <MetricDefinitionRow
            v-for="(m, i) in nodeMetrics"
            :key="rowKey(m)"
            v-model:metric="nodeMetrics[i]"
            :role-options="TOPOLOGY_ROLE_OPTIONS"
            show-role
            show-thresholds
            mqe-placeholder="endpoint_cpm"
            :can-move-up="i > 0"
            :can-move-down="i < nodeMetrics.length - 1"
            @move-up="move(nodeMetrics, i, -1)"
            @move-down="move(nodeMetrics, i, 1)"
            @remove="remove(nodeMetrics, i)"
          />
        </div>
      </div>

      <div class="topo-cfg-section">
        <header class="topo-cfg-head">
          <h5>Link metrics (server-side)</h5>
          <span class="sub">edge metrics queried as <code>endpoint_relation_*</code></span>
          <button class="sw-btn add" type="button" @click="addLink">＋ Add</button>
        </header>
        <div v-if="linkMetrics.length === 0" class="topo-cfg-empty">No link metrics.</div>
        <div v-else class="metric-list">
          <MetricDefinitionRow
            v-for="(m, i) in linkMetrics"
            :key="rowKey(m)"
            v-model:metric="linkMetrics[i]"
            :can-move-up="i > 0"
            :can-move-down="i < linkMetrics.length - 1"
            @move-up="move(linkMetrics, i, -1)"
            @move-down="move(linkMetrics, i, 1)"
            @remove="remove(linkMetrics, i)"
          />
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
/* Config-editor chrome, duplicated here scoped (parent keeps its copy until
   every config editor is extracted; .sw-card / .sw-btn are global). */
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
.naming-prefix-row { display: flex; align-items: center; gap: 12px; padding: 10px 14px 0; flex-wrap: wrap; }
.naming-prefix-row .comp-toggle { flex: 0 0 auto; }
.naming-prefix-hint { font-size: 11px; color: var(--sw-fg-3); }
.naming-prefix-hint code { font-family: var(--sw-mono); background: var(--sw-bg-2); padding: 1px 4px; border-radius: 3px; color: var(--sw-fg-1); }
.comp-toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11.5px;
  color: var(--sw-fg-2);
  padding: 6px 10px;
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line-2);
  border-radius: 4px;
  cursor: pointer;
  user-select: none;
}
.comp-toggle:hover { background: var(--sw-bg-3); }
.comp-toggle.on { background: var(--sw-accent-soft); border-color: var(--sw-accent-line); color: var(--sw-accent-2); }
.comp-toggle input { accent-color: var(--sw-accent); margin: 0; }
.comp-label { font-weight: 500; }
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
