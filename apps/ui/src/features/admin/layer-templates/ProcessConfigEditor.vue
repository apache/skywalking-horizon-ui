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
  `processTopology` block via v-model and seeds an empty one on mount (never
  while read-only). Same pattern as DependencyConfigSection; edge rows are the lean MetricDefinitionRow
  (no role / thresholds).
-->
<script setup lang="ts">
import { computed, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type {
  ProcessRelationSide,
  ProcessTopologyConfig,
  TopologyMetricDef,
} from '@skywalking-horizon-ui/api-client';
import { resolveEdgeMetrics } from '@skywalking-horizon-ui/api-client';

type EdgeMetric = TopologyMetricDef & { side?: ProcessRelationSide };
import { nextFreeId } from './free-id';
import MetricDefinitionRow from './MetricDefinitionRow.vue';
import { rowKey } from './row-key';

const { t } = useI18n({ useScope: 'global' });

const config = defineModel<ProcessTopologyConfig | undefined>('config');
const props = defineProps<{ layerKey?: string; readOnly?: boolean }>();

/** Opens on the RESOLVED list, so a template still written as two side lists
 *  is edited as the one list it means — and the first edit writes that form
 *  out, as the trace-store checklist does. */
function ensure(): ProcessTopologyConfig & { edgeMetrics: EdgeMetric[] } {
  if (!config.value) config.value = {};
  if (!config.value.edgeMetrics) {
    config.value = { edgeMetrics: resolveEdgeMetrics(config.value) };
  }
  return config.value as ProcessTopologyConfig & { edgeMetrics: EdgeMetric[] };
}
const edgeMetrics = computed<EdgeMetric[]>(() => config.value?.edgeMetrics ?? resolveEdgeMetrics(config.value));

/** Normalise whenever the config is REPLACED, not just on mount: switching
 *  layer or resetting to remote reuses this component, and a replacement in
 *  the old spelling would leave the rows bound to `resolveEdgeMetrics`'s
 *  copies — edits landing on a clone the draft never sees. */
watch(
  // `readOnly` too: a config opened read-only is never normalised, so if the
  // same draft becomes editable the rows would still be bound to the
  // resolver's copies and every edit would land on a clone.
  [config, () => props.readOnly] as const,
  ([c, ro]) => {
    if (ro) return;
    if (!c || !c.edgeMetrics) ensure();
  },
  { immediate: true },
);


function blankMetric(taken: readonly TopologyMetricDef[]): TopologyMetricDef {
  const id = nextFreeId('metric_', taken.map((m) => m.id));
  return { id, label: `Metric ${id.slice('metric_'.length)}`, mqe: '', unit: '', aggregation: 'avg' };
}
function addMetric(side?: ProcessRelationSide): void {
  if (props.readOnly) return;
  const m = blankMetric(edgeMetrics.value);
  ensure().edgeMetrics.push(side ? { ...m, side } : m);
}
function setSide(i: number, raw: string): void {
  if (props.readOnly) return;
  const m = ensure().edgeMetrics[i];
  if (!m) return;
  if (raw === 'client' || raw === 'server') m.side = raw;
  else delete m.side;
}
function move(list: TopologyMetricDef[], i: number, dir: -1 | 1): void {
  if (props.readOnly) return;
  const j = i + dir;
  if (j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j], list[i]];
}
function remove(list: TopologyMetricDef[], i: number): void {
  if (props.readOnly) return;
  list.splice(i, 1);
}
</script>

<template>
  <section class="sw-card editor-card topo-cfg-card">
    <div class="card-head">
      <h4>{{ t('Network profiling — process-relation config') }}</h4>
      <span class="sub">{{ t('edge MQE for the process-topology detail panel. Queried under ProcessRelation when an operator clicks a process→process call.') }}</span>
    </div>
    <div class="topo-cfg-body">
      <div class="topo-cfg-section">
        <header class="topo-cfg-head">
          <h5>{{ t('Edge metrics') }}</h5>
          <span class="sub">{{ t('Each names the end of the conversation it describes. The eBPF probe watches both, and a metric that describes the exchange itself — the HTTP/1.x families — belongs to neither.') }}</span>
          <button class="sw-btn add" type="button" :disabled="readOnly" @click="addMetric('client')">{{ t('＋ Add') }}</button>
        </header>
        <div v-if="edgeMetrics.length === 0" class="topo-cfg-empty">{{ t('No edge metrics.') }}</div>
        <div v-else class="metric-list">
          <MetricDefinitionRow
            v-for="(m, i) in edgeMetrics"
            :key="rowKey(m)"
            v-model:metric="edgeMetrics[i]"
            :layer-key="layerKey"
            :read-only="readOnly"
            site-scope="process-relation"
            mqe-placeholder="process_relation_client_write_cpm"
            :can-move-up="i > 0"
            :can-move-down="i < edgeMetrics.length - 1"
            @move-up="move(edgeMetrics, i, -1)"
            @move-down="move(edgeMetrics, i, 1)"
            @remove="remove(edgeMetrics, i)"
          >
            <template #lead>
              <label class="mf side-pick">
                <span>{{ t('side') }}</span>
                <select
                  class="mf-input"
                  :disabled="readOnly"
                  :value="m.side ?? ''"
                  @change="setSide(i, ($event.target as HTMLSelectElement).value)"
                >
                  <option value="client">{{ t('client') }}</option>
                  <option value="server">{{ t('server') }}</option>
                  <option value="">{{ t('both') }}</option>
                </select>
              </label>
            </template>
          </MetricDefinitionRow>
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
