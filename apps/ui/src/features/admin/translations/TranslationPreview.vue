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
  in-progress overlay applied; no live MQE — chart bodies come from
  the same deterministic mock generators the LayerDashboards admin
  editor uses, so the preview here matches that view's chart shapes.

  Overview kind reuses the actual overview widget primitives with empty
  data. Layer kind renders per-scope widgets via TimeChart / TopList /
  inline card / record, all mock-fed. Clicking any widget emits
  `select-widget` so the parent can focus the corresponding row in the
  editor.

  Nothing in this pane navigates — RouterLink isn't used and clicks
  don't escape the preview surface.
-->
<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { AdminLayerTemplate, DashboardWidget } from '@/api/client';

const { t } = useI18n({ useScope: 'global' });
import type {
  OverviewDashboard,
  OverviewWidget,
} from '@skywalking-horizon-ui/api-client';
import SectionBreak from '@/render/widgets/SectionBreak.vue';
import MetricWidget from '@/render/widgets/MetricWidget.vue';
import KpiTileWidget from '@/render/widgets/KpiTileWidget.vue';
import AlarmsWidget from '@/render/widgets/AlarmsWidget.vue';
import MetricCompositeWidget from '@/render/widgets/MetricCompositeWidget.vue';
import TimeChart from '@/components/charts/TimeChart.vue';
import TopList from '@/components/charts/TopList.vue';
import { fmtMetric } from '@/utils/formatters';
import {
  mockCardValue,
  mockLineSeries,
  mockRecordRows,
  mockTopGroups,
} from '@/features/admin/layer-templates/widget-mock';

type AdminScope = 'service' | 'instance' | 'endpoint';

const props = defineProps<{
  kind: 'overview' | 'layer';
  overview?: OverviewDashboard;
  layer?: AdminLayerTemplate;
  scope?: AdminScope;
}>();

const emit = defineEmits<{
  /** Operator clicked a widget — the parent should focus the
   *  corresponding row in the editor. */
  'select-widget': [widgetId: string];
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
  const ov = props.layer?.overview as
    | { groups?: Array<{ title: string; metrics: Array<{ label: string; tip?: string; unit?: string }> }> }
    | undefined;
  return ov?.groups ?? [];
});

function widgetRowSpan(w: DashboardWidget): number {
  return Math.min(8, Math.max(1, w.rowSpan ?? 1));
}
</script>

<template>
  <div class="prev">
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
              <!-- Intercept clicks in the CAPTURE phase. The overview
                   widget primitives (KpiTileWidget,
                   MetricCompositeWidget, AlarmsWidget) contain
                   RouterLinks that would navigate to /layer/... or
                   /alarms. We don't want any navigation off this page;
                   capture-prevent stops the inner link from firing
                   and lets us emit `select-widget` instead. -->
              <div
                class="ovw-cell"
                :style="gridStyle(w.span, w.rowSpan, sec.cols)"
                @click.capture.prevent.stop="emit('select-widget', w.id)"
              >
                <MetricWidget
                  v-if="w.type === 'metric'"
                  :title="w.title"
                  :tip="w.tip"
                  :value="null"
                  :unit="w.unit"
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
                />
                <AlarmsWidget
                  v-else-if="w.type === 'alarms'"
                  :title="w.title"
                  :tip="w.tip"
                  :limit="w.limit"
                  :layer="w.layer"
                />
                <div v-else-if="w.type === 'topology'" class="topo-host sw-card">
                  <span class="topo-host__label">{{ w.title || t('Topology') }}</span>
                </div>
                <MetricCompositeWidget
                  v-else-if="w.type === 'metric-composite'"
                  :title="w.title"
                  :tip="w.tip"
                  :layer="w.layer"
                  :kpis="w.kpis"
                  :kpi-values="{}"
                />
              </div>
            </template>
          </div>
        </section>
      </div>
    </template>

    <template v-else-if="kind === 'layer' && layer">
      <header class="prev-head">
        <h2>{{ layer.alias || layer.key }}</h2>
        <span class="key-tag">{{ layer.key }}</span>
      </header>

      <section v-if="headerColumns.length > 0" class="section">
        <div class="prev-subhead">{{ t('Service header') }}</div>
        <div class="hdr-strip">
          <div v-for="c in headerColumns" :key="c.metric" class="hdr-col" @click="emit('select-widget', `header:${c.metric}`)">
            <span class="hdr-label">{{ c.label }}</span>
            <span class="hdr-unit">{{ c.unit ?? '—' }}</span>
          </div>
        </div>
      </section>

      <section v-if="overviewGroups.length > 0" class="section">
        <div class="prev-subhead">{{ t('Overview tiles') }}</div>
        <div class="ov-grid">
          <div
            v-for="(g, gi) in overviewGroups"
            :key="gi"
            class="ov-group sw-card"
            @click="emit('select-widget', `ovgroup:${gi}`)"
          >
            <div class="ov-title">{{ g.title || ' ' }}</div>
            <div class="ov-metrics">
              <div
                v-for="(m, mi) in g.metrics"
                :key="m.label"
                class="ov-metric"
                @click.stop="emit('select-widget', `ovmetric:${gi}:${mi}`)"
              >
                <span class="ov-label">{{ m.label }}</span>
                <span class="ov-value">—</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section v-if="scopeWidgets.length > 0" class="section">
        <div class="prev-subhead">{{ t('{scope} dashboard widgets', { scope: scope ?? '' }) }}</div>
        <div class="widget-grid">
          <div
            v-for="w in scopeWidgets"
            :key="w.id"
            class="canvas-widget"
            :style="gridStyle(w.span, w.rowSpan, 12)"
            @click="emit('select-widget', w.id)"
          >
            <header class="cw-head">
              <h5>{{ w.title }}</h5>
              <span class="cw-type" :class="`t-${w.type}`">{{ w.type }}</span>
            </header>
            <div class="cw-body">
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
                <div class="cw-card-value">
                  <span class="num">{{ fmtMetric(mockCardValue(w)) }}</span>
                  <span v-if="w.unit" class="unit">{{ w.unit }}</span>
                </div>
              </template>
              <template v-else-if="w.type === 'record' && w.expressions.length > 0">
                <ul class="cw-records">
                  <li
                    v-for="(r, ri) in mockRecordRows(w, Math.max(3, widgetRowSpan(w) * 2))"
                    :key="ri"
                    class="cw-record-row"
                  >
                    <span class="rec-name">{{ r.name }}</span>
                    <span class="rec-value">
                      {{ fmtMetric(r.value ?? null) }}<span v-if="w.unit" class="unit">{{ w.unit }}</span>
                    </span>
                  </li>
                </ul>
              </template>
              <p v-else class="cw-empty">{{ t('No preview shape for this widget type.') }}</p>
            </div>
          </div>
        </div>
      </section>
    </template>

    <div v-else class="empty">{{ t('Pick a template to preview.') }}</div>
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

/* Each cell wraps the real widget primitive. Capture-phase click
   handler on the wrapper swallows nav clicks before they reach
   the widget's inner RouterLink. The wrapper also forwards the
   grid-position style so the layout matches OverviewDashboardView. */
.ovw-cell { cursor: pointer; display: contents; }
.ovw-cell > * { cursor: pointer; }
/* Restore the grid placement on the actual widget (display:contents
   above means the inner element is the grid item). */
.ovw-cell { display: block; }

.hdr-strip { display: flex; gap: 8px; flex-wrap: wrap; }
.hdr-col {
  flex: 1 1 auto; min-width: 90px;
  background: var(--sw-bg-1); border: 1px solid var(--sw-line-2); border-radius: 4px;
  padding: 6px 10px; display: flex; flex-direction: column; gap: 2px;
  cursor: pointer;
}
.hdr-col:hover { border-color: var(--sw-accent); }
.hdr-label { font-size: 11px; font-weight: 600; color: var(--sw-fg-1); }
.hdr-unit { font-size: 10px; color: var(--sw-fg-3); font-family: var(--sw-mono); }

.ov-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 10px; }
.ov-group { padding: 10px 12px; display: flex; flex-direction: column; gap: 6px; cursor: pointer; }
.ov-title { font-size: 11px; font-weight: 600; color: var(--sw-fg-1); }
.ov-metrics { display: flex; flex-direction: column; gap: 3px; }
.ov-metric { display: flex; justify-content: space-between; font-size: 11.5px; }
.ov-label { color: var(--sw-fg-2); }
.ov-value { color: var(--sw-fg-3); font-family: var(--sw-mono); }

/* Layer widget cards — copy of LayerDashboardsAdmin's `.canvas-widget`
   visual vocabulary so this preview looks indistinguishable from the
   admin editor's canvas. Mock data via the shared widget-mock helpers. */
.widget-grid {
  display: grid;
  grid-template-columns: repeat(12, minmax(0, 1fr));
  /* `auto` rather than a fixed track height so the grid grows to fit
     widgets with longer content (long top-N lists, dense record
     widgets, wide line charts). Each widget's `rowSpan` still spans
     the right number of rows, but each row sizes to its largest
     occupant rather than to a hard-coded 120 px. */
  grid-auto-rows: minmax(120px, auto);
  gap: 10px;
}
.canvas-widget {
  background: var(--sw-bg-1);
  border: 1px solid var(--sw-line-2);
  border-radius: 6px;
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  cursor: pointer;
  overflow: hidden;
  min-height: 0;
}
.canvas-widget:hover { border-color: var(--sw-accent); }
.cw-head { display: flex; align-items: center; gap: 8px; }
.cw-head h5 { margin: 0; font-size: 12px; font-weight: 600; color: var(--sw-fg-1); flex: 1; }
.cw-type {
  font-size: 9.5px; padding: 1px 6px; border-radius: 3px; text-transform: uppercase;
  background: var(--sw-bg-2); color: var(--sw-fg-3);
  letter-spacing: 0.05em;
}
.cw-body { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; }
.cw-card-value { display: flex; align-items: baseline; gap: 6px; padding: 12px 4px; }
.cw-card-value .num { font-size: 22px; font-weight: 600; color: var(--sw-fg-0); }
.cw-card-value .unit { font-size: 11px; color: var(--sw-fg-3); }
.cw-records { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 3px; overflow: auto; }
.cw-record-row { display: flex; justify-content: space-between; gap: 8px; font-size: 11.5px; }
.rec-name { color: var(--sw-fg-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.rec-value { color: var(--sw-fg-1); font-family: var(--sw-mono); }
.rec-value .unit { color: var(--sw-fg-3); margin-left: 2px; }
.cw-empty { color: var(--sw-fg-3); font-size: 11px; padding: 16px; text-align: center; margin: 0; }

.topo-host {
  padding: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--sw-fg-3);
  font-size: 12px;
  cursor: pointer;
}
.topo-host__label { font-style: italic; }

.empty {
  padding: 60px 20px;
  text-align: center;
  color: var(--sw-fg-3);
  font-size: 13px;
}
</style>
