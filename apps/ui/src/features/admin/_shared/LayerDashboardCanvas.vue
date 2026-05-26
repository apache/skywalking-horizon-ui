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
  Read-only layer-dashboard canvas. Renders the per-scope widget grid
  in the same 12-col layout the admin LayerDashboardsAdmin uses (same
  mock-data path, same TimeChart / TopList components) but without the
  editor decorations (drag, resize, type chip, grip, size badge).

  Used by the Translations page so the operator sees a real preview of
  how their translation edits look — the LayerDashboardsAdmin editor
  itself remains the source of truth for the rich edit canvas and is
  not yet migrated to use this component.
-->
<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { AdminLayerTemplate } from '@/api/client';
import type { DashboardScope, DashboardWidget } from '@skywalking-horizon-ui/api-client';
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

type AdminScope = DashboardScope;

const { t } = useI18n({ useScope: 'global' });

const props = defineProps<{
  template: AdminLayerTemplate;
  scope: AdminScope;
  /** Selected widget id; the matching cell gets the accent outline. */
  selectedWidgetId?: string | null;
}>();

const emit = defineEmits<{
  'select-widget': [payload: { widget: DashboardWidget; idx: number; el: HTMLElement; event: MouseEvent }];
  'select-header': [payload: { el: HTMLElement; event: MouseEvent }];
}>();

const widgets = computed<DashboardWidget[]>(() => {
  const tpl = props.template as AdminLayerTemplate & { dashboards?: Record<string, DashboardWidget[]> };
  if (tpl.dashboards?.[props.scope]) return tpl.dashboards[props.scope];
  if (props.scope === 'service' && tpl.widgets) return tpl.widgets;
  return [];
});

function widgetSpan(w: DashboardWidget): number {
  return Math.min(12, Math.max(1, w.span ?? 4));
}
function widgetRowSpan(w: DashboardWidget): number {
  return Math.min(8, Math.max(1, w.rowSpan ?? 1));
}
function widgetGridStyle(w: DashboardWidget): Record<string, string> {
  return { gridColumn: `span ${widgetSpan(w)}`, gridRow: `span ${widgetRowSpan(w)}` };
}

function onCellClick(e: MouseEvent, w: DashboardWidget, i: number): void {
  emit('select-widget', { widget: w, idx: i, el: e.currentTarget as HTMLElement, event: e });
}

function onHeaderClick(e: MouseEvent): void {
  emit('select-header', { el: e.currentTarget as HTMLElement, event: e });
}
</script>

<template>
  <header class="ldc-layer-head" @click="onHeaderClick">
    <div class="ldc-layer-head-row">
      <span class="ldc-layer-dot" :style="{ background: template.color || 'var(--sw-fg-3)' }" />
      <h3 class="ldc-layer-alias">{{ template.alias || template.key }}</h3>
      <code class="ldc-layer-key">{{ template.key }}</code>
    </div>
    <p class="ldc-layer-hint">
      {{ t("Click to translate the layer's display name + term aliases (services / instances / endpoints).") }}
    </p>
  </header>
  <div class="ldc-canvas">
    <div v-if="widgets.length === 0" class="ldc-empty">
      No widgets in this scope.
    </div>
    <div
      v-for="(w, i) in widgets"
      :key="`${w.id}-${i}`"
      class="ldc-cell"
      :class="{ 'is-sel': selectedWidgetId === w.id }"
      :style="widgetGridStyle(w)"
      @click="onCellClick($event, w, i)"
    >
      <header class="ldc-head">
        <h5>{{ w.title || w.id || 'untitled' }}</h5>
        <WidgetTip :tip="w.tip" />
      </header>
      <div class="ldc-body">
        <template v-if="w.type === 'line' && w.expressions.length > 0">
          <TimeChart
            :series="mockLineSeries(w)"
            :unit="w.unit"
            :height="Math.max(60, widgetRowSpan(w) * 120 - 50)"
          />
        </template>
        <template v-else-if="w.type === 'top' && w.expressions.length > 0">
          <TopList
            :groups="mockTopGroups(w, Math.max(4, widgetRowSpan(w) * 3))"
            :unit="w.unit"
          />
        </template>
        <template v-else-if="w.type === 'card'">
          <div class="ldc-card-value">
            <span class="num">{{ fmtMetric(mockCardValue(w)) }}</span>
            <span v-if="w.unit" class="unit">{{ w.unit }}</span>
          </div>
        </template>
        <template v-else-if="w.type === 'record' && w.expressions.length > 0">
          <ul class="ldc-records">
            <li
              v-for="(r, ri) in mockRecordRows(w, Math.max(3, widgetRowSpan(w) * 2))"
              :key="ri"
              class="ldc-record-row"
            >
              <span class="rec-name">{{ r.name }}</span>
              <span class="rec-value">
                {{ fmtMetric(r.value ?? null) }}<span v-if="w.unit" class="unit">{{ w.unit }}</span>
              </span>
            </li>
          </ul>
        </template>
        <p v-else class="ldc-empty-cell">No preview for this widget kind.</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ldc-layer-head {
  margin: 8px 12px 0;
  padding: 8px 12px;
  border: 1px solid transparent;
  border-radius: 6px;
  cursor: pointer;
  transition: background 120ms ease, border-color 120ms ease;
}
.ldc-layer-head:hover { background: var(--sw-bg-1); border-color: var(--sw-line-2); }
.ldc-layer-head-row { display: flex; align-items: center; gap: 10px; }
.ldc-layer-dot { width: 8px; height: 8px; border-radius: 50%; flex: 0 0 8px; }
.ldc-layer-alias { margin: 0; font-size: 14px; font-weight: 600; color: var(--sw-fg-0); }
.ldc-layer-key {
  font-family: var(--sw-mono); font-size: 10.5px; color: var(--sw-fg-3);
  background: var(--sw-bg-2); padding: 1px 6px; border-radius: 3px;
}
.ldc-layer-hint {
  margin: 4px 0 0 18px;
  font-size: 10.5px; color: var(--sw-fg-3);
}
.ldc-canvas {
  position: relative;
  padding: 12px;
  background:
    linear-gradient(var(--sw-line) 1px, transparent 1px) 0 0/24px 24px,
    linear-gradient(90deg, var(--sw-line) 1px, transparent 1px) 0 0/24px 24px,
    var(--sw-bg-0);
  display: grid;
  grid-template-columns: repeat(12, 1fr);
  grid-auto-rows: 120px;
  gap: 8px;
  min-height: 360px;
}
.ldc-empty {
  grid-column: span 12;
  border: 1.5px dashed var(--sw-line-2);
  border-radius: 6px;
  display: grid;
  place-items: center;
  color: var(--sw-fg-3);
  font-size: 11.5px;
  padding: 24px;
  min-height: 120px;
}
.ldc-cell {
  position: relative;
  display: flex;
  flex-direction: column;
  background: var(--sw-bg-1);
  border: 1px solid var(--sw-line);
  border-radius: 6px;
  cursor: pointer;
  overflow: hidden;
  transition: border-color 120ms ease, box-shadow 120ms ease;
}
.ldc-cell:hover { border-color: var(--sw-line-2); }
.ldc-cell.is-sel {
  border-color: var(--sw-accent);
  box-shadow: 0 0 0 4px rgba(249, 115, 22, 0.18);
}
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
