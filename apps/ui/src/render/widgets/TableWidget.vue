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
  `table` dashboard widget: a labeled latest(...) metric rendered as a
  scrollable name→value table. Each row is one label combination
  (status / phase / condition / entity dimension). The value column is
  optional (showValues=false renders a presence list, e.g. node
  conditions whose value is always 1).
-->
<script setup lang="ts">
import { computed } from 'vue';
import type { DashboardTableRow } from '@skywalking-horizon-ui/api-client';
import { fmtMetricAs } from '@/utils/formatters';

const props = withDefaults(
  defineProps<{
    rows: DashboardTableRow[];
    headers?: [string, string];
    showValues?: boolean;
    unit?: string;
    format?: 'int' | 'decimal' | 'compact';
  }>(),
  { showValues: true },
);

const cols = computed(() => props.headers ?? ['Name', 'Value']);
function fmt(v: number | null): string {
  if (v === null || v === undefined) return '—';
  const s = fmtMetricAs(v, props.format);
  return props.unit ? `${s} ${props.unit}` : s;
}
</script>

<template>
  <div class="tw">
    <table class="tw__table">
      <thead>
        <tr>
          <th>{{ cols[0] }}</th>
          <th v-if="showValues" class="tw__num">{{ cols[1] }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="(r, i) in rows" :key="`${r.name}-${i}`">
          <td class="tw__name mono" :title="r.name">{{ r.name }}</td>
          <td v-if="showValues" class="tw__num mono">{{ fmt(r.value) }}</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.tw { height: 100%; overflow: auto; }
.tw__table {
  width: 100%;
  border-collapse: collapse;
  font-size: 11.5px;
}
.tw__table th {
  position: sticky;
  top: 0;
  text-align: left;
  font-weight: 600;
  color: var(--sw-fg-2);
  background: var(--sw-bg-1);
  padding: 4px 8px;
  border-bottom: 1px solid var(--sw-line);
  white-space: nowrap;
}
.tw__table td {
  padding: 3px 8px;
  border-bottom: 1px solid var(--sw-line-2, var(--sw-line));
  color: var(--sw-fg-1);
}
.tw__name {
  max-width: 0;
  width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tw__num { text-align: right; white-space: nowrap; color: var(--sw-fg-0); }
.tw__table tbody tr:hover td { background: var(--sw-bg-2); }
</style>
