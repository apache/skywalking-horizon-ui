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
</script>

<template>
  <div class="cwr">
    <div v-if="spec.type === 'card'" class="cwr-card">
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
</style>
