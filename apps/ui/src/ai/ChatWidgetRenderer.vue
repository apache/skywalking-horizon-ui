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
<!-- Renders one figure (widget spec + resolved result) via the dashboards' own leaf
     components. Line x-labels are synthesised from the epoch range + step (no timestamps). -->
<script setup lang="ts">
import { computed } from 'vue';
import TimeChart from '@/components/charts/TimeChart.vue';
import TopList from '@/components/charts/TopList.vue';
import TableWidget from '@/render/widgets/TableWidget.vue';
import RecordList from '@/render/widgets/RecordList.vue';
import { fmtMetricAs, bucketTimeLabel } from '@/utils/formatters';
import type { ChatFigure } from './types';

const props = defineProps<{ figure: ChatFigure; height?: number }>();

const spec = computed(() => props.figure.spec);
const result = computed(() => props.figure.result);

const xLabels = computed<string[]>(() => {
  const ax = props.figure.xaxis;
  const len = result.value.series?.[0]?.data.length ?? 0;
  if (!ax || len <= 0) return [];
  if (len === 1) return [bucketTimeLabel(ax.step, ax.endMs)];
  return Array.from({ length: len }, (_, i) => bucketTimeLabel(ax.step, ax.startMs + ((ax.endMs - ax.startMs) * i) / (len - 1)));
});

const cardText = computed<string>(() => {
  const v = result.value.value;
  const m = spec.value.valueMap;
  if (spec.value.format === 'enum' && m && v != null) return m[String(Math.round(v))] ?? '—';
  return fmtMetricAs(v, spec.value.format);
});

// Document the captured analysis: the metric's explanation (template tip) + the
// exact MQE that produced this frozen result.
const mqe = computed<string>(() => (spec.value.expressions ?? []).filter(Boolean).join('  ·  '));

// A captured figure is a static file of what was read — if the read had no value
// (empty window or a failed read at capture), replay says so, the same frozen
// no-value contract the map blocks follow. A real 0 is a value, not no-value.
const noValue = computed<boolean>(() => {
  const r = result.value;
  if (r.error) return true;
  switch (spec.value.type) {
    case 'card':
      return r.value == null;
    case 'line':
      return !r.series?.some((s) => s.data?.some((v) => v != null));
    case 'top':
      return !(r.topList?.length || r.topGroups?.length);
    case 'table':
      return !r.table?.length;
    case 'record':
      return !r.records?.length;
    default:
      return false;
  }
});
</script>

<template>
  <div class="cwr">
    <div v-if="noValue" class="cwr-empty">
      {{ result.error ? 'No data — the read failed when this was captured.' : 'No data in the captured window.' }}
    </div>

    <div v-else-if="spec.type === 'card'" class="cwr-card">
      <span class="cwr-card-val">{{ cardText }}</span>
      <span v-if="spec.unit" class="cwr-card-unit">{{ spec.unit }}</span>
    </div>

    <TimeChart
      v-else-if="spec.type === 'line'"
      :series="result.series ?? []"
      :unit="spec.unit"
      :format="spec.format"
      :x-labels="xLabels"
      :height="height ?? 200"
    />

    <TopList
      v-else-if="spec.type === 'top'"
      :groups="result.topGroups"
      :items="result.topList"
      :unit="spec.unit"
      :title="spec.title"
    />

    <TableWidget
      v-else-if="spec.type === 'table'"
      :rows="result.table ?? []"
      :headers="spec.tableHeaders"
      :unit="spec.unit"
      :format="spec.format"
    />

    <RecordList
      v-else-if="spec.type === 'record'"
      :items="result.records ?? []"
      :unit="spec.unit"
    />

    <div v-else class="cwr-unsupported">{{ spec.title }}</div>

    <div v-if="spec.tip || mqe" class="cwr-meta">
      <div v-if="spec.tip" class="cwr-tip">{{ spec.tip }}</div>
      <code v-if="mqe" class="cwr-mqe">{{ mqe }}</code>
    </div>
  </div>
</template>

<style scoped>
.cwr {
  min-width: 0;
}
.cwr-card {
  display: flex;
  align-items: baseline;
  gap: 4px;
  padding: 10px 2px 2px;
}
.cwr-card-val {
  font-size: var(--sw-fs-2xl);
  font-weight: var(--sw-fw-semibold);
  letter-spacing: var(--sw-ls-tight);
  color: var(--sw-fg-0);
  font-variant-numeric: tabular-nums;
}
.cwr-card-unit {
  font-size: var(--sw-fs-base);
  font-weight: var(--sw-fw-medium);
  color: var(--sw-fg-2);
}
.cwr-unsupported {
  font-size: var(--sw-fs-sm);
  color: var(--sw-fg-3);
  padding: 8px;
}
.cwr-empty {
  font-size: var(--sw-fs-sm);
  color: var(--sw-fg-3);
  padding: 14px 8px;
  text-align: center;
}
.cwr-meta {
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px solid var(--sw-line);
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.cwr-tip {
  font-size: var(--sw-fs-xs);
  color: var(--sw-fg-2);
  line-height: 1.4;
}
.cwr-mqe {
  font-family: var(--sw-font-mono);
  font-size: var(--sw-fs-xs);
  color: var(--sw-fg-3);
  word-break: break-word;
}
</style>
