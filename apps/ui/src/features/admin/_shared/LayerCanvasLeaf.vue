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
  One chart of the read-only layer canvas — its title, tip and a mock-data
  body. Drawn the same way at the top level and inside a tab panel; the
  caller owns the cell, its size and what a click opens.
-->
<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import type { DashboardWidget } from '@skywalking-horizon-ui/api-client';
import TimeChart from '@/components/charts/TimeChart.vue';
import TopList from '@/components/charts/TopList.vue';
import WidgetTip from '@/components/primitives/WidgetTip.vue';
import { fmtMetric } from '@/utils/formatters';
import {
  mockCardValue,
  mockLineSeries,
  mockRecordRows,
  mockTopGroups,
} from '@/features/admin/layer-templates/widget-mock';

defineProps<{
  widget: DashboardWidget;
  /** Rows the cell spans, and the height of one row in its grid. */
  rowSpan: number;
  rowPx: number;
}>();

const { t } = useI18n({ useScope: 'global' });
</script>

<template>
  <header class="ldc-head">
    <h5>{{ widget.title || widget.id || t('untitled') }}</h5>
    <WidgetTip :tip="widget.tip" />
  </header>
  <div class="ldc-body">
    <template v-if="widget.type === 'line' && widget.expressions.length > 0">
      <TimeChart
        :series="mockLineSeries(widget)"
        :unit="widget.unit"
        :height="Math.max(60, rowSpan * rowPx - 50)"
      />
    </template>
    <template v-else-if="widget.type === 'top' && widget.expressions.length > 0">
      <TopList
        :groups="mockTopGroups(widget, Math.max(4, rowSpan * 3))"
        :unit="widget.unit"
      />
    </template>
    <template v-else-if="widget.type === 'card'">
      <div class="ldc-card-value">
        <span class="num">{{ fmtMetric(mockCardValue(widget)) }}</span>
        <span v-if="widget.unit" class="unit">{{ widget.unit }}</span>
      </div>
    </template>
    <template v-else-if="widget.type === 'record' && widget.expressions.length > 0">
      <ul class="ldc-records">
        <li
          v-for="(r, ri) in mockRecordRows(widget, Math.max(3, rowSpan * 2))"
          :key="ri"
          class="ldc-record-row"
        >
          <span class="rec-name">{{ r.name }}</span>
          <span class="rec-value">
            {{ fmtMetric(r.value ?? null) }}<span v-if="widget.unit" class="unit">{{ widget.unit }}</span>
          </span>
        </li>
      </ul>
    </template>
    <p v-else class="ldc-empty-cell">{{ t('No preview for this widget kind.') }}</p>
  </div>
</template>

<style scoped>
.ldc-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--sw-line);
  background: var(--sw-bg-2);
  min-width: 0;
}
.ldc-head h5 {
  margin: 0;
  font-size: 11px;
  font-weight: 600;
  color: var(--sw-fg-0);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 1;
  min-width: 0;
}
.ldc-body {
  flex: 1;
  min-height: 0;
  padding: 6px 8px 12px;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}
.ldc-empty-cell {
  margin: auto;
  font-size: 10.5px;
  color: var(--sw-fg-3);
  text-align: center;
  padding: 8px 12px;
}
.ldc-card-value {
  flex: 1;
  display: grid;
  place-items: center;
  gap: 4px;
  padding: 8px;
}
.ldc-card-value .num {
  font-family: var(--sw-mono);
  font-size: 28px;
  font-weight: 700;
  color: var(--sw-fg-0);
  font-variant-numeric: tabular-nums;
}
.ldc-card-value .unit {
  font-size: 11px;
  color: var(--sw-fg-3);
}
.ldc-records {
  list-style: none;
  margin: 0;
  padding: 0;
  overflow-y: auto;
  flex: 1;
  min-height: 0;
}
.ldc-record-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 3px 4px;
  border-bottom: 1px dashed var(--sw-line);
}
.ldc-record-row:last-child { border-bottom: none; }
.rec-name {
  flex: 1;
  font-family: var(--sw-mono);
  font-size: 10.5px;
  color: var(--sw-fg-1);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.rec-value {
  font-family: var(--sw-mono);
  font-size: 10.5px;
  color: var(--sw-fg-0);
  font-variant-numeric: tabular-nums;
}
.rec-value .unit {
  margin-left: 2px;
  color: var(--sw-fg-3);
  font-size: 9.5px;
}
</style>
