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
  Translation-time preview pane. Renders the picked template with the
  in-progress overlay applied, no MQE / topology fetch.

  Two render paths, dispatched by `kind`:
  - overview: reuses the same widget primitives as OverviewDashboardView,
    passing empty data so every numeric / chart slot shows the widgets'
    own muted placeholder. Layout (sections, grid columns, span,
    rowSpan) matches production.
  - layer: schematic preview. Renders the layer-header columns + overview
    tile groups + scoped widget cards as static placeholders. Sized to
    the production layout. Production renderer for layer dashboards has
    too many data-bound branches to reuse cleanly without a deeper
    preview-mode pass — that's a Phase 2 follow-up.
-->
<script setup lang="ts">
import { computed } from 'vue';
import type { AdminLayerTemplate, DashboardWidget } from '@/api/client';
import type {
  OverviewDashboard,
  OverviewWidget,
} from '@skywalking-horizon-ui/api-client';
import SectionBreak from '@/render/widgets/SectionBreak.vue';
import MetricWidget from '@/render/widgets/MetricWidget.vue';
import KpiTileWidget from '@/render/widgets/KpiTileWidget.vue';
import AlarmsWidget from '@/render/widgets/AlarmsWidget.vue';
import MetricCompositeWidget from '@/render/widgets/MetricCompositeWidget.vue';

type AdminScope = 'service' | 'instance' | 'endpoint';

const props = defineProps<{
  kind: 'overview' | 'layer';
  /** The localized template — operator's in-progress overlay already merged onto the source. */
  overview?: OverviewDashboard;
  layer?: AdminLayerTemplate;
  /** Only meaningful for `kind === 'layer'`. */
  scope?: AdminScope;
}>();

interface OverviewSection {
  title: string;
  cols: number;
  widgets: OverviewWidget[];
}

const overviewSections = computed<OverviewSection[]>(() => {
  const dash = props.overview;
  if (!dash) return [];
  const out: OverviewSection[] = [];
  let current: OverviewSection | null = null;
  for (const w of dash.widgets) {
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

function gridStyle(span?: number, rowSpan?: number, cols = 12): Record<string, string> {
  const out: Record<string, string> = {};
  if (span) out.gridColumn = `span ${Math.min(cols, Math.max(1, span))}`;
  if (rowSpan) out.gridRow = `span ${Math.min(8, Math.max(1, rowSpan))}`;
  return out;
}

const scopeWidgets = computed<DashboardWidget[]>(() => {
  const tpl = props.layer as (AdminLayerTemplate & { dashboards?: Record<string, DashboardWidget[]> }) | undefined;
  if (!tpl) return [];
  const s: AdminScope = props.scope ?? 'service';
  return tpl.dashboards?.[s] ?? tpl.widgets ?? [];
});

const headerColumns = computed(() => props.layer?.metrics?.columns ?? []);
const overviewGroups = computed(() => {
  const ov = props.layer?.overview as { groups?: Array<{ title: string; metrics: Array<{ label: string; tip?: string; unit?: string }> }> } | undefined;
  return ov?.groups ?? [];
});
</script>

<template>
  <div class="prev">
    <!-- Overview-kind: reuse the actual widget primitives with empty
         data so they show their muted placeholders. -->
    <template v-if="kind === 'overview' && overview">
      <header class="prev-head">
        <h2>{{ overview.title }}</h2>
        <p v-if="overview.description" class="lede">{{ overview.description }}</p>
      </header>
      <div class="sections">
        <section v-for="(sec, si) in overviewSections" :key="si" class="section">
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
                :value="null"
                :unit="w.unit"
                :style="gridStyle(w.span, w.rowSpan, sec.cols)"
              />
              <KpiTileWidget
                v-else-if="w.type === 'kpi-tile'"
                :title="w.title"
                :tip="w.tip"
                :layer="w.layer"
                :show-count="w.showCount"
                :count="null"
                :kpis="w.kpis ?? []"
                :kpi-values="{}"
                :style="gridStyle(w.span, w.rowSpan, sec.cols)"
              />
              <AlarmsWidget
                v-else-if="w.type === 'alarms'"
                :title="w.title"
                :tip="w.tip"
                :limit="w.limit"
                :layer="w.layer"
                :style="gridStyle(w.span, w.rowSpan, sec.cols)"
              />
              <div
                v-else-if="w.type === 'topology'"
                class="topo-host sw-card"
                :style="gridStyle(w.span, w.rowSpan, sec.cols)"
              >
                <span class="topo-host__label">{{ w.title || 'Topology' }}</span>
              </div>
              <MetricCompositeWidget
                v-else-if="w.type === 'metric-composite'"
                :title="w.title"
                :tip="w.tip"
                :layer="w.layer"
                :kpis="w.kpis"
                :kpi-values="{}"
                :style="gridStyle(w.span, w.rowSpan, sec.cols)"
              />
            </template>
          </div>
        </section>
      </div>
    </template>

    <!-- Layer-kind: schematic widget cards. Production renderer for
         per-scope dashboards is data-coupled enough that reusing it
         here would force a deeper preview-mode pass; the schematic
         shows every translatable string in its rendered context which
         is what the operator needs to verify. -->
    <template v-else-if="kind === 'layer' && layer">
      <header class="prev-head">
        <h2>{{ layer.alias || layer.key }}</h2>
        <span class="key-tag">{{ layer.key }}</span>
      </header>

      <section v-if="headerColumns.length > 0" class="section">
        <div class="prev-subhead">Service header</div>
        <div class="hdr-strip">
          <div v-for="c in headerColumns" :key="c.metric" class="hdr-col">
            <span class="hdr-label">{{ c.label }}</span>
            <span class="hdr-unit">{{ c.unit ?? '—' }}</span>
          </div>
        </div>
      </section>

      <section v-if="overviewGroups.length > 0" class="section">
        <div class="prev-subhead">Overview tiles</div>
        <div class="ov-grid">
          <div v-for="(g, gi) in overviewGroups" :key="gi" class="ov-group sw-card">
            <div class="ov-title">{{ g.title || ' ' }}</div>
            <div class="ov-metrics">
              <div v-for="m in g.metrics" :key="m.label" class="ov-metric">
                <span class="ov-label">{{ m.label }}</span>
                <span class="ov-value">—</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section v-if="scopeWidgets.length > 0" class="section">
        <div class="prev-subhead">{{ scope }} dashboard widgets</div>
        <div class="widget-grid">
          <div
            v-for="w in scopeWidgets"
            :key="w.id"
            class="widget-card sw-card"
            :style="gridStyle(w.span, w.rowSpan, 12)"
          >
            <header>
              <h4>{{ w.title }}</h4>
              <span v-if="w.tip" class="tip" :title="w.tip">?</span>
            </header>
            <div v-if="w.expressionLabels?.length" class="tabs">
              <span v-for="(l, i) in w.expressionLabels" :key="i" class="tab">{{ l }}</span>
            </div>
            <div v-if="w.tableHeaders?.length" class="tbl-head">
              <span v-for="(h, i) in w.tableHeaders" :key="i" class="tbl-h">{{ h }}</span>
            </div>
            <div class="widget-stub">—</div>
          </div>
        </div>
      </section>
    </template>

    <div v-else class="empty">Pick a template to preview.</div>
  </div>
</template>

<style scoped>
.prev { padding: 12px 14px; display: flex; flex-direction: column; gap: 14px; overflow: auto; }
.prev-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.prev-head h2 { margin: 0; font-size: 18px; font-weight: 600; color: var(--sw-fg-0); }
.prev-head .lede { width: 100%; margin: 4px 0 0; font-size: 12px; color: var(--sw-fg-2); line-height: 1.5; }
.key-tag {
  font-family: var(--sw-mono); font-size: 10.5px;
  padding: 2px 6px; border-radius: 3px; background: var(--sw-bg-2); color: var(--sw-fg-3);
}
.prev-subhead {
  font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--sw-fg-3);
  margin-bottom: 6px;
}
.sections { display: flex; flex-direction: column; gap: 14px; }
.section { display: flex; flex-direction: column; gap: 6px; }
.section-grid { display: grid; grid-auto-rows: 72px; gap: 10px; }

.hdr-strip { display: flex; gap: 8px; flex-wrap: wrap; }
.hdr-col {
  flex: 1 1 auto; min-width: 90px;
  background: var(--sw-bg-1); border: 1px solid var(--sw-line-2); border-radius: 4px;
  padding: 6px 10px; display: flex; flex-direction: column; gap: 2px;
}
.hdr-label { font-size: 11px; font-weight: 600; color: var(--sw-fg-1); }
.hdr-unit { font-size: 10px; color: var(--sw-fg-3); font-family: var(--sw-mono); }

.ov-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 10px; }
.ov-group { padding: 10px 12px; display: flex; flex-direction: column; gap: 6px; }
.ov-title { font-size: 11px; font-weight: 600; color: var(--sw-fg-1); }
.ov-metrics { display: flex; flex-direction: column; gap: 3px; }
.ov-metric { display: flex; justify-content: space-between; font-size: 11.5px; }
.ov-label { color: var(--sw-fg-2); }
.ov-value { color: var(--sw-fg-3); font-family: var(--sw-mono); }

.widget-grid { display: grid; grid-template-columns: repeat(12, minmax(0, 1fr)); grid-auto-rows: 78px; gap: 10px; }
.widget-card { padding: 8px 12px; display: flex; flex-direction: column; gap: 6px; min-height: 0; overflow: hidden; }
.widget-card header { display: flex; align-items: center; gap: 6px; }
.widget-card h4 { margin: 0; font-size: 11.5px; font-weight: 600; color: var(--sw-fg-1); }
.widget-card .tip {
  font-size: 9px; color: var(--sw-fg-3); border: 1px solid var(--sw-line-2);
  border-radius: 50%; width: 13px; height: 13px;
  display: inline-flex; align-items: center; justify-content: center; cursor: help;
}
.tabs { display: flex; gap: 6px; flex-wrap: wrap; }
.tab {
  font-size: 10.5px; padding: 1px 6px; border-radius: 3px;
  background: var(--sw-bg-2); color: var(--sw-fg-2);
}
.tbl-head { display: flex; gap: 12px; font-size: 10.5px; color: var(--sw-fg-3); }
.tbl-h { font-family: var(--sw-mono); }
.widget-stub { flex: 1; display: flex; align-items: center; justify-content: center; color: var(--sw-fg-3); font-size: 18px; }

.topo-host {
  padding: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--sw-fg-3);
  font-size: 12px;
}
.topo-host__label { font-style: italic; }

.empty {
  padding: 60px 20px;
  text-align: center;
  color: var(--sw-fg-3);
  font-size: 13px;
}
</style>
