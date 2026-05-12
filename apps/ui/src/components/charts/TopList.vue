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
  Compact sorted-list renderer for `top_n(...)` MQE results. Each row
  has a name + value + a horizontal bar normalized to the row's value
  vs the list max. Designed for the per-layer Service dashboard's
  "Top N endpoints" widget — fits a tall narrow card.
-->
<script setup lang="ts">
import { computed } from 'vue';
import type { DashboardTopItem } from '@skywalking-horizon-ui/api-client';
import { fmtMetric } from '@/utils/formatters';

const props = withDefaults(
  defineProps<{
    items: ReadonlyArray<DashboardTopItem>;
    unit?: string;
    /** Bar color — defaults to the accent. */
    color?: string;
  }>(),
  {
    color: 'var(--sw-accent)',
  },
);

const max = computed(() => {
  let m = 0;
  for (const it of props.items) {
    const v = it.value;
    if (v !== null && Number.isFinite(v) && v > m) m = v;
  }
  return m || 1;
});
function pct(v: number | null): number {
  if (v === null || !Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(100, (v / max.value) * 100));
}
</script>

<template>
  <div class="top-list">
    <div v-for="(it, i) in items" :key="i" class="row" :title="it.name">
      <span class="rank">{{ i + 1 }}</span>
      <span class="name">{{ it.name }}</span>
      <div class="bar"><div class="fill" :style="{ width: `${pct(it.value)}%`, background: color }" /></div>
      <span class="value">
        {{ fmtMetric(it.value) }}<span v-if="unit" class="unit">{{ unit }}</span>
      </span>
    </div>
    <p v-if="items.length === 0" class="empty">No data</p>
  </div>
</template>

<style scoped>
.top-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 4px 2px;
  width: 100%;
  height: 100%;
  overflow-y: auto;
}
.row {
  display: grid;
  grid-template-columns: 18px 1fr 48px 64px;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  padding: 1px 0;
}
.rank {
  font-family: var(--sw-mono);
  font-size: 9.5px;
  color: var(--sw-fg-3);
  text-align: right;
}
.name {
  font-family: var(--sw-mono);
  font-size: 11px;
  color: var(--sw-fg-1);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.bar {
  height: 5px;
  background: var(--sw-bg-3);
  border-radius: 2px;
  overflow: hidden;
}
.fill {
  height: 100%;
  border-radius: 2px;
  transition: width 0.2s ease-out;
}
.value {
  font-family: var(--sw-mono);
  font-size: 10.5px;
  color: var(--sw-fg-1);
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.value .unit {
  margin-left: 2px;
  color: var(--sw-fg-3);
  font-size: 9.5px;
}
.empty {
  font-size: 11px;
  color: var(--sw-fg-3);
  text-align: center;
  margin: 12px 0;
}
</style>
