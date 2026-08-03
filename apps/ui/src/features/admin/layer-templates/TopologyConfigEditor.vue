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
  Topology config editor — service-topology node/link metrics plus the optional
  instance-topology drill-down block. Config-local: owns the `topology` block
  via v-model, seeds an empty one on mount, and the instance-topology block is
  created/removed by the Enable toggle (instance buckets never auto-create —
  they read straight off the nested block). Alias-aware nouns (service /
  instance) come in as props because they resolve against the live template's
  slots, which the parent owns.
-->
<script setup lang="ts">
import { computed, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import type { TopologyConfig, TopologyMetricDef } from '@skywalking-horizon-ui/api-client';
import { nextFreeId } from './free-id';
import { TOPOLOGY_ROLE_OPTIONS } from './layer-dashboards.scopes';
import MetricDefinitionRow from './MetricDefinitionRow.vue';
import { rowKey } from './row-key';

const { t } = useI18n();
const config = defineModel<TopologyConfig | undefined>('config');
defineProps<{ serviceNoun: string; instanceNoun: string }>();

function ensure(): TopologyConfig {
  if (!config.value) config.value = { nodeMetrics: [], linkServerMetrics: [], linkClientMetrics: [] };
  if (!config.value.linkServerMetrics) config.value.linkServerMetrics = [];
  if (!config.value.linkClientMetrics) config.value.linkClientMetrics = [];
  return config.value;
}
onMounted(ensure);

const nodeMetrics = computed(() => config.value?.nodeMetrics ?? []);
const serverMetrics = computed(() => config.value?.linkServerMetrics ?? []);
const clientMetrics = computed(() => config.value?.linkClientMetrics ?? []);
const showGroup = computed(() => Boolean(config.value?.showGroup));
const instanceEnabled = computed(() => !!config.value?.instanceTopology);
const instNodeMetrics = computed(() => config.value?.instanceTopology?.nodeMetrics ?? []);
const instServerMetrics = computed(() => config.value?.instanceTopology?.linkServerMetrics ?? []);
const instClientMetrics = computed(() => config.value?.instanceTopology?.linkClientMetrics ?? []);

function toggleShowGroup(): void {
  const t = ensure();
  t.showGroup = !t.showGroup;
}
// Start empty — the operator authors instance-scope metrics
// (service_instance_* / service_instance_relation_*) themselves; we never copy
// the service-scope metrics down (wrong scope, misleading).
function toggleInstance(): void {
  const t = ensure();
  if (t.instanceTopology) delete t.instanceTopology;
  else t.instanceTopology = { nodeMetrics: [], linkServerMetrics: [], linkClientMetrics: [] };
}
function blankMetric(taken: readonly TopologyMetricDef[]): TopologyMetricDef {
  const id = nextFreeId('metric_', taken.map((m) => m.id));
  return { id, label: `Metric ${id.slice('metric_'.length)}`, mqe: '', unit: '', aggregation: 'avg' };
}
function addNode(): void { ensure().nodeMetrics.push(blankMetric(nodeMetrics.value)); }
function addServer(): void { ensure().linkServerMetrics!.push(blankMetric(serverMetrics.value)); }
function addClient(): void { ensure().linkClientMetrics!.push(blankMetric(clientMetrics.value)); }
function addInstNode(): void { ensure().instanceTopology!.nodeMetrics.push(blankMetric(instNodeMetrics.value)); }
function addInstServer(): void { ensure().instanceTopology!.linkServerMetrics!.push(blankMetric(instServerMetrics.value)); }
function addInstClient(): void { ensure().instanceTopology!.linkClientMetrics!.push(blankMetric(instClientMetrics.value)); }
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
      <h4>{{ t('Topology config') }}</h4>
      <span class="sub">{{ t('node + server-side + client-side line metrics. Add rows; bind a metric to a visual role.') }}</span>
    </div>
    <div class="naming-prefix-row">
      <label class="comp-toggle" :class="{ on: showGroup }">
        <input type="checkbox" :checked="showGroup" @change="toggleShowGroup" />
        <span class="comp-label">{{ t('Show') }} <code>&lt;group&gt;::</code> {{ t('as a chip in the node panel') }}</span>
      </label>
      <span class="naming-prefix-hint">
        {{ t('Off:') }} <code>mesh-svr::reviews</code> {{ t('reads as') }} <code>reviews</code> {{ t('everywhere.') }}
        {{ t('On:') }} <code>mesh-svr</code> {{ t('appears as a separate chip in the clicked-node panel.') }}
        {{ t('Topology graph labels are always pure service names.') }}
      </span>
    </div>
    <div class="topo-cfg-body">
      <div class="topo-cfg-group">
        <span class="tg-title">{{ t('Service topology') }}</span>
        <span class="tg-sub">{{ t('node = {noun} · edges = service-to-service relations', { noun: serviceNoun }) }}</span>
      </div>
      <div class="topo-cfg-section">
        <header class="topo-cfg-head">
          <h5>{{ t('{noun} node metrics', { noun: serviceNoun }) }}</h5>
          <span class="sub">{{ t("drives each node's center number + ring colour band") }}</span>
          <button class="sw-btn add" type="button" @click="addNode">{{ t('＋ Add') }}</button>
        </header>
        <div v-if="nodeMetrics.length === 0" class="topo-cfg-empty">{{ t('No node metrics. Click "+ Add" to start.') }}</div>
        <div v-else class="metric-list">
          <MetricDefinitionRow
            v-for="(m, i) in nodeMetrics"
            :key="rowKey(m)"
            v-model:metric="nodeMetrics[i]"
            :role-options="TOPOLOGY_ROLE_OPTIONS"
            show-role
            show-thresholds
            mqe-placeholder="service_cpm"
            unit-placeholder="rpm"
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
          <h5>{{ t('Link · server-side metrics') }}</h5>
          <span class="sub">{{ t('edge metrics queried as') }} <code>service_relation_server_*</code></span>
          <button class="sw-btn add" type="button" @click="addServer">{{ t('＋ Add') }}</button>
        </header>
        <div v-if="serverMetrics.length === 0" class="topo-cfg-empty">{{ t('No server-side metrics.') }}</div>
        <div v-else class="metric-list">
          <MetricDefinitionRow
            v-for="(m, i) in serverMetrics"
            :key="rowKey(m)"
            v-model:metric="serverMetrics[i]"
            :can-move-up="i > 0"
            :can-move-down="i < serverMetrics.length - 1"
            @move-up="move(serverMetrics, i, -1)"
            @move-down="move(serverMetrics, i, 1)"
            @remove="remove(serverMetrics, i)"
          />
        </div>
      </div>

      <div class="topo-cfg-section">
        <header class="topo-cfg-head">
          <h5>{{ t('Link · client-side metrics') }}</h5>
          <span class="sub">{{ t('edge metrics queried as') }} <code>service_relation_client_*</code></span>
          <button class="sw-btn add" type="button" @click="addClient">{{ t('＋ Add') }}</button>
        </header>
        <div v-if="clientMetrics.length === 0" class="topo-cfg-empty">{{ t('No client-side metrics.') }}</div>
        <div v-else class="metric-list">
          <MetricDefinitionRow
            v-for="(m, i) in clientMetrics"
            :key="rowKey(m)"
            v-model:metric="clientMetrics[i]"
            :can-move-up="i > 0"
            :can-move-down="i < clientMetrics.length - 1"
            @move-up="move(clientMetrics, i, -1)"
            @move-down="move(clientMetrics, i, 1)"
            @remove="remove(clientMetrics, i)"
          />
        </div>
      </div>

      <div class="topo-cfg-instance-block" :class="{ enabled: instanceEnabled }">
        <div class="topo-cfg-group with-toggle">
          <div class="tg-text">
            <span class="tg-title">{{ t('Instance topology') }}</span>
            <span class="tg-sub">{{ t("node = {noun} · drill-down between two services' instances", { noun: instanceNoun }) }}</span>
          </div>
          <label class="comp-toggle" :class="{ on: instanceEnabled }">
            <input type="checkbox" :checked="instanceEnabled" @change="toggleInstance" />
            <span class="comp-label">{{ t('Enable instance topology') }}</span>
          </label>
        </div>

        <template v-if="instanceEnabled">
          <div class="topo-cfg-section">
            <header class="topo-cfg-head">
              <h5>{{ t('{noun} node metrics', { noun: instanceNoun }) }}</h5>
              <span class="sub">{{ t('per-instance — queried as') }} <code>service_instance_*</code></span>
              <button class="sw-btn add" type="button" @click="addInstNode">{{ t('＋ Add') }}</button>
            </header>
            <div v-if="instNodeMetrics.length === 0" class="topo-cfg-empty">{{ t('No node metrics. Click "+ Add" to start.') }}</div>
            <div v-else class="metric-list">
              <MetricDefinitionRow
                v-for="(m, i) in instNodeMetrics"
                :key="rowKey(m)"
                v-model:metric="instNodeMetrics[i]"
                :role-options="TOPOLOGY_ROLE_OPTIONS"
                show-role
                show-thresholds
                mqe-placeholder="service_instance_cpm"
                unit-placeholder="rpm"
                :can-move-up="i > 0"
                :can-move-down="i < instNodeMetrics.length - 1"
                @move-up="move(instNodeMetrics, i, -1)"
                @move-down="move(instNodeMetrics, i, 1)"
                @remove="remove(instNodeMetrics, i)"
              />
            </div>
          </div>

          <div class="topo-cfg-section">
            <header class="topo-cfg-head">
              <h5>{{ t('Link · server-side metrics') }}</h5>
              <span class="sub">{{ t('edge metrics queried as') }} <code>service_instance_relation_server_*</code></span>
              <button class="sw-btn add" type="button" @click="addInstServer">{{ t('＋ Add') }}</button>
            </header>
            <div v-if="instServerMetrics.length === 0" class="topo-cfg-empty">{{ t('No server-side metrics.') }}</div>
            <div v-else class="metric-list">
              <MetricDefinitionRow
                v-for="(m, i) in instServerMetrics"
                :key="rowKey(m)"
                v-model:metric="instServerMetrics[i]"
                :can-move-up="i > 0"
                :can-move-down="i < instServerMetrics.length - 1"
                @move-up="move(instServerMetrics, i, -1)"
                @move-down="move(instServerMetrics, i, 1)"
                @remove="remove(instServerMetrics, i)"
              />
            </div>
          </div>

          <div class="topo-cfg-section">
            <header class="topo-cfg-head">
              <h5>{{ t('Link · client-side metrics') }}</h5>
              <span class="sub">{{ t('edge metrics queried as') }} <code>service_instance_relation_client_*</code></span>
              <button class="sw-btn add" type="button" @click="addInstClient">{{ t('＋ Add') }}</button>
            </header>
            <div v-if="instClientMetrics.length === 0" class="topo-cfg-empty">{{ t('No client-side metrics.') }}</div>
            <div v-else class="metric-list">
              <MetricDefinitionRow
                v-for="(m, i) in instClientMetrics"
                :key="rowKey(m)"
                v-model:metric="instClientMetrics[i]"
                :can-move-up="i > 0"
                :can-move-down="i < instClientMetrics.length - 1"
                @move-up="move(instClientMetrics, i, -1)"
                @move-down="move(instClientMetrics, i, 1)"
                @remove="remove(instClientMetrics, i)"
              />
            </div>
          </div>
        </template>
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
.topo-cfg-group {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 4px 16px 2px;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--sw-line);
}
.topo-cfg-group.with-toggle {
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: 22px;
}
.topo-cfg-group .tg-text { display: flex; flex-direction: column; gap: 2px; }
.topo-cfg-group .tg-title { font-size: 12px; font-weight: 700; color: var(--sw-fg-0); }
.topo-cfg-group .tg-sub { font-size: 10.5px; color: var(--sw-fg-3); }
.topo-cfg-instance-block {
  margin: 22px 16px 8px;
  border: 1px solid var(--sw-line-2);
  border-radius: 8px;
  background: var(--sw-bg-1);
  overflow: hidden;
}
.topo-cfg-instance-block .topo-cfg-group.with-toggle {
  margin: 0;
  padding: 10px 14px;
  background: var(--sw-bg-2);
}
.topo-cfg-instance-block.enabled .topo-cfg-group.with-toggle { border-bottom: 1px solid var(--sw-line); }
.topo-cfg-instance-block .topo-cfg-section { padding: 12px 14px; }
.topo-cfg-instance-block .topo-cfg-section:last-child { border-bottom: none; }
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
