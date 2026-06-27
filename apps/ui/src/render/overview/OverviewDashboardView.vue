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
  Per-overview dashboard renderer. Routed by id (`/overview/:id`), pulls
  the dashboard definition + layer-aggregated KPI data from the BFF, and
  dispatches each widget to its component based on `widget.type`.

  Widgets are grouped into SECTIONS: each `section-break` starts a new
  section whose `cols` field decides the local grid column count
  (default 12). Widget `span`/`rowSpan` position within the local grid.
  This lets a Services row pack 5 tiles equally while a Topology row
  splits 9:3.
-->
<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import type { OverviewWidget } from '@skywalking-horizon-ui/api-client';
import { useOverviewDashboard } from '@/render/overview/useOverviewDashboard';
import SectionBreak from '@/render/widgets/SectionBreak.vue';
import MetricWidget from '@/render/widgets/MetricWidget.vue';
import KpiTileWidget from '@/render/widgets/KpiTileWidget.vue';
import AlarmsWidget from '@/render/widgets/AlarmsWidget.vue';
import MetricCompositeWidget from '@/render/widgets/MetricCompositeWidget.vue';
import LayerServiceMapView from '@/layer/service-map/LayerServiceMapView.vue';

const route = useRoute();
const dashId = computed(() => String(route.params.id ?? ''));
const { dashboard, widgets, values, isLoading, isLoadingData } = useOverviewDashboard(dashId);

interface Section { title: string; cols: number; widgets: OverviewWidget[] }
const sections = computed<Section[]>(() => {
  const out: Section[] = [];
  let current: Section | null = null;
  for (const w of widgets.value) {
    if (w.type === 'section-break') {
      current = { title: w.title, cols: w.cols ?? 12, widgets: [] };
      out.push(current);
    } else {
      if (!current) {
        current = { title: '', cols: 12, widgets: [] };
        out.push(current);
      }
      current.widgets.push(w);
    }
  }
  return out;
});

function widgetStyle(span?: number, rowSpan?: number, cols = 12): Record<string, string> {
  const out: Record<string, string> = {};
  if (span) out.gridColumn = `span ${Math.min(cols, Math.max(1, span))}`;
  if (rowSpan) out.gridRow = `span ${Math.min(8, Math.max(1, rowSpan))}`;
  return out;
}
</script>

<template>
  <div class="dash-view">
    <header v-if="dashboard" class="dash-head">
      <h1>{{ dashboard.title }}</h1>
      <p v-if="dashboard.description" class="lede">{{ dashboard.description }}</p>
      <span v-if="isLoadingData" class="loading">Loading data…</span>
    </header>

    <div v-if="isLoading" class="empty">Loading dashboard…</div>
    <div v-else-if="!dashboard" class="empty">Dashboard not found.</div>
    <div v-else class="sections">
      <section v-for="(sec, si) in sections" :key="si" class="section">
        <SectionBreak v-if="sec.title" :title="sec.title" />
        <div
          class="section-grid"
          :style="{ gridTemplateColumns: `repeat(${sec.cols}, minmax(0, 1fr))` }"
        >
          <template v-for="w in sec.widgets" :key="w.id">
            <MetricWidget
              v-if="w.type === 'metric'"
              :title="w.title"
              :tip="w.tip"
              :value="values.values[w.id]"
              :unit="w.unit"
              :style="widgetStyle(w.span, w.rowSpan, sec.cols)"
            />
            <KpiTileWidget
              v-else-if="w.type === 'kpi-tile'"
              :title="w.title"
              :tip="w.tip"
              :layer="w.layer"
              :show-count="w.showCount"
              :count="values.values[w.id]"
              :kpis="w.kpis ?? []"
              :kpi-values="values.kpiValues[w.id] ?? {}"
              :style="widgetStyle(w.span, w.rowSpan, sec.cols)"
            />
            <AlarmsWidget
              v-else-if="w.type === 'alarms'"
              :title="w.title"
              :tip="w.tip"
              :limit="w.limit"
              :layer="w.layer"
              :style="widgetStyle(w.span, w.rowSpan, sec.cols)"
            />
            <!-- The SAME LayerServiceMapView the per-layer Topology tab
                 uses, in embedded mode — one topology rendering across
                 the product. -->
            <div
              v-else-if="w.type === 'topology' && w.layer"
              class="topo-host sw-card"
              :style="widgetStyle(w.span, w.rowSpan, sec.cols)"
            >
              <!-- Lowercase to match the /api/menu casing the layer
                   composables look up by. -->
              <LayerServiceMapView :layer-key="w.layer.toLowerCase()" :embedded="true" />
            </div>
            <MetricCompositeWidget
              v-else-if="w.type === 'metric-composite'"
              :title="w.title"
              :tip="w.tip"
              :layer="w.layer"
              :kpis="w.kpis"
              :kpi-values="values.kpiValues[w.id] ?? {}"
              :style="widgetStyle(w.span, w.rowSpan, sec.cols)"
            />
          </template>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.dash-view { padding: 20px 20px 60px; max-width: 1440px; margin: 0 auto; }
.dash-head { margin-bottom: 18px; display: flex; flex-direction: column; gap: 6px; }
.dash-head h1 {
  margin: 0; font-size: 22px; font-weight: 600; letter-spacing: -0.02em; color: var(--sw-fg-0);
}
.lede { margin: 0; font-size: 12.5px; color: var(--sw-fg-2); line-height: 1.5; max-width: 720px; }
.loading { font-size: 11px; color: var(--sw-fg-3); }
.empty {
  padding: 60px 20px; text-align: center; color: var(--sw-fg-3); font-size: 13px;
}
.sections { display: flex; flex-direction: column; gap: 18px; }
.section { display: flex; flex-direction: column; gap: 8px; }
.section-grid {
  display: grid;
  grid-auto-rows: 72px;
  gap: 12px;
}
.topo-host {
  padding: 0;
  overflow: hidden;
  min-height: 0;
}
.topo-host > * {
  height: 100%;
}
</style>
