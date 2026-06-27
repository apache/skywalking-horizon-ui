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
  Flows sub-tab of the Deployment view — every edge's role-pair metrics in one
  grid (the Grafana FODC "Flows" board), grouped BY role-pair so heterogeneous
  pairs never collapse into one sparse grid. Rows click through to the topology
  edge (the parent flips back to the topology sub-tab + selects it).
-->
<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import type { DeploymentCall, DeploymentMetricDef, DeploymentNode, RolePairMetrics } from '@/api/client';

export interface FlowGroup { key: string; label: string; pair: RolePairMetrics; calls: DeploymentCall[] }

const props = defineProps<{
  showPickPrompt: boolean;
  flowGroups: FlowGroup[];
  minHeightPx: number;
  instById: (id: string) => DeploymentNode | null;
  flowCell: (c: DeploymentCall, def: DeploymentMetricDef) => string;
  primaryIds: (pair: RolePairMetrics) => string[];
}>();
const emit = defineEmits<{ (e: 'select-edge', id: string): void }>();
const { t } = useI18n({ useScope: 'global' });
</script>

<template>
  <div class="sit-flows" :style="{ minHeight: props.minHeightPx + 'px' }">
    <div v-if="props.showPickPrompt" class="sit-state-inline">{{ t('Pick a service to see its deployment topology.') }}</div>
    <div v-else-if="props.flowGroups.length === 0" class="sit-state-inline">{{ t('No flows in this window.') }}</div>
    <div v-else class="sit-flow-groups">
      <section v-for="g in props.flowGroups" :key="g.key" class="sit-flow-group">
        <header class="sit-flow-group-head">
          <span class="fg-pair mono">{{ g.label }}</span>
          <span class="fg-count">{{ g.calls.length }} {{ g.calls.length === 1 ? t('edge') : t('edges') }}</span>
        </header>
        <div class="sit-flow-scroll">
          <table class="sit-flow-table">
            <thead>
              <tr>
                <th>{{ t('Source') }}</th>
                <th>{{ t('Target') }}</th>
                <th v-for="col in g.pair.metrics" :key="col.id" class="fl-num">
                  {{ col.label }}<span v-if="col.unit" class="fl-unit"> ({{ col.unit }})</span>
                </th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="c in g.calls" :key="c.id" @click="emit('select-edge', c.id)">
                <td class="mono fl-ep" :title="props.instById(c.source)?.name">{{ props.instById(c.source)?.name }}</td>
                <td class="mono fl-ep" :title="props.instById(c.target)?.name">{{ props.instById(c.target)?.name }}</td>
                <td v-for="col in g.pair.metrics" :key="col.id" class="mono fl-num" :class="{ 'fl-primary': props.primaryIds(g.pair).includes(col.id) }">{{ props.flowCell(c, col) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
/* Flows — one aligned sub-table PER role-pair (a "liaison → data" group, a
   "lifecycle → data" group, …), each with its own metric columns. Rows click
   through to the topology edge. Outer scrolls vertically across groups; each
   group scrolls horizontally if its columns overflow. */
.sit-flows { min-width: 0; border: 1px solid var(--sw-line); border-radius: 6px; background: var(--sw-bg-1); overflow-y: auto; padding: 10px; }
.sit-state-inline { display: flex; align-items: center; justify-content: center; min-height: 240px; color: var(--sw-fg-3); font-size: 12px; padding: 24px; text-align: center; }
.sit-flow-groups { display: flex; flex-direction: column; gap: 14px; }
.sit-flow-group { border: 1px solid var(--sw-line); border-radius: 6px; overflow: hidden; background: var(--sw-bg-0); }
.sit-flow-group-head { display: flex; align-items: baseline; gap: 8px; padding: 6px 10px; background: var(--sw-bg-2); border-bottom: 1px solid var(--sw-line); }
.fg-pair { font-size: 11px; font-weight: 700; color: var(--sw-accent); }
.fg-count { font-size: 9.5px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--sw-fg-3); }
.sit-flow-scroll { overflow-x: auto; }
.sit-flow-table { width: 100%; border-collapse: collapse; font-size: 11px; }
.sit-flow-table th, .sit-flow-table td { padding: 5px 10px; text-align: left; white-space: nowrap; border-bottom: 1px solid var(--sw-line); }
.sit-flow-table tbody tr:last-child td { border-bottom: none; }
.sit-flow-table th { background: var(--sw-bg-1); color: var(--sw-fg-2); font-weight: 600; font-size: 9.5px; text-transform: uppercase; letter-spacing: 0.04em; }
.sit-flow-table th.fl-num, .sit-flow-table td.fl-num { text-align: right; }
.sit-flow-table .fl-unit { color: var(--sw-fg-3); text-transform: none; letter-spacing: 0; }
.sit-flow-table tbody tr { cursor: pointer; }
.sit-flow-table tbody tr:hover { background: var(--sw-bg-2); }
.sit-flow-table td.fl-ep { color: var(--sw-fg-0); max-width: 240px; overflow: hidden; text-overflow: ellipsis; }
.sit-flow-table td.fl-num { color: var(--sw-fg-1); }
.sit-flow-table td.fl-primary { color: var(--sw-fg-0); font-weight: 700; }
.mono { font-family: var(--sw-mono); }
</style>
