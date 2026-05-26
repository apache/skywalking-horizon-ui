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
  Read-only overview-dashboard canvas. Renders the dashboard's section-
  broken widget grid the same way the OverviewTemplatesAdmin editor
  does (same real widget components — MetricWidget, KpiTileWidget,
  MetricCompositeWidget, AlarmsWidget — with deterministic mock data)
  but without drag / resize affordances.

  Used by the Translations page so the operator sees a real preview of
  how their translation edits look. The OverviewTemplatesAdmin editor
  itself remains the source of truth for the rich edit canvas and is
  not yet migrated to use this component.
-->
<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { OverviewDashboard, OverviewWidget } from '@skywalking-horizon-ui/api-client';

const { t } = useI18n({ useScope: 'global' });
import MetricWidget from '@/render/widgets/MetricWidget.vue';
import KpiTileWidget from '@/render/widgets/KpiTileWidget.vue';
import MetricCompositeWidget from '@/render/widgets/MetricCompositeWidget.vue';
import WidgetTip from '@/components/primitives/WidgetTip.vue';

const props = defineProps<{
  dashboard: OverviewDashboard;
  /** Selected widget id; the matching cell gets the accent outline. */
  selectedWidgetId?: string | null;
}>();

const emit = defineEmits<{
  'select-widget': [payload: { widget: OverviewWidget; el: HTMLElement; event: MouseEvent }];
  'select-header': [payload: { el: HTMLElement; event: MouseEvent }];
}>();

interface PreviewSection {
  cols: number;
  sb: OverviewWidget | null;
  widgets: OverviewWidget[];
}

const sections = computed<PreviewSection[]>(() => {
  const out: PreviewSection[] = [];
  let cur: PreviewSection | null = null;
  for (const w of props.dashboard.widgets ?? []) {
    if (w.type === 'section-break') {
      cur = { cols: w.cols ?? 12, sb: w, widgets: [] };
      out.push(cur);
      continue;
    }
    if (!cur) {
      cur = { cols: 12, sb: null, widgets: [] };
      out.push(cur);
    }
    cur.widgets.push(w);
  }
  return out;
});

function cellStyle(w: OverviewWidget, cols: number): Record<string, string> {
  return {
    gridColumn: `span ${Math.min(cols, Math.max(1, w.span ?? cols))}`,
    gridRow: `span ${Math.min(8, Math.max(1, w.rowSpan ?? 1))}`,
  };
}

// Deterministic mocks keyed by widget id + label, so re-renders return
// the same number — operator-driven jitter is distracting in a preview.
function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}
function mockNumber(seed: string, max = 999): number { return hash(seed) % max; }
function mockPercent(seed: string): number { return 10 + (hash(seed) % 85); }

function mockKpiValues(w: OverviewWidget): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const k of w.kpis ?? []) {
    out[k.label] =
      k.unit === '%' || k.style === 'progress-bar'
        ? mockPercent(w.id + k.label)
        : mockNumber(w.id + k.label, k.max ?? 999);
  }
  return out;
}

function mockAlarmRows(): Array<{ msg: string; scope: string; since: string; firing: boolean }> {
  return [
    { msg: t('Response time of service mesh-svr::cart is more than 20ms.'), scope: `${t('Service')} · mesh-svr::cart`, since: '2m', firing: true },
    { msg: t('JVM old-gen GC > 5s/min on agent::orders'), scope: `${t('Instance')} · pod-2 of agent::orders`, since: '14m', firing: true },
    { msg: t('p95 SLA below threshold for service mesh-svr::reviews'), scope: `${t('Service')} · reviews`, since: '47m', firing: false },
  ];
}
function mockAlarms(seed: string, n: number): Array<{ key: string; msg: string; scope: string; since: string; firing: boolean }> {
  const base = mockAlarmRows();
  const cap = Math.max(0, Math.min(n, base.length));
  const rows: Array<{ key: string; msg: string; scope: string; since: string; firing: boolean }> = [];
  for (let i = 0; i < cap; i++) {
    const r = base[i]!;
    rows.push({ key: `${seed}::${i}`, ...r });
  }
  return rows;
}

function onCellClick(e: MouseEvent, w: OverviewWidget): void {
  emit('select-widget', { widget: w, el: e.currentTarget as HTMLElement, event: e });
}

function onHeaderClick(e: MouseEvent): void {
  emit('select-header', { el: e.currentTarget as HTMLElement, event: e });
}
</script>

<template>
  <div class="odc">
    <header class="odc__head" @click="onHeaderClick">
      <h2 class="odc__title">{{ dashboard.title }}</h2>
      <p v-if="dashboard.description" class="odc__desc">{{ dashboard.description }}</p>
    </header>
    <div v-if="sections.length === 0" class="odc__empty">{{ t('No widgets in this dashboard.') }}</div>
    <div v-for="(sec, si) in sections" :key="si" class="odc__section">
      <div
        v-if="sec.sb"
        class="odc__sb"
        :class="{ 'is-sel': selectedWidgetId === sec.sb.id }"
        @click="onCellClick($event, sec.sb)"
      >
        <span class="odc__sb-tag">{{ t('SECTION') }}</span>
        <span class="odc__sb-title">{{ sec.sb.title || t('(untitled section)') }}</span>
      </div>
      <div class="odc__grid" :style="{ gridTemplateColumns: `repeat(${sec.cols}, minmax(0, 1fr))` }">
        <div
          v-for="w in sec.widgets"
          :key="w.id"
          class="odc__cell"
          :class="{ 'is-sel': selectedWidgetId === w.id }"
          :style="cellStyle(w, sec.cols)"
          @click.capture.prevent.stop="onCellClick($event, w)"
        >
          <MetricWidget
            v-if="w.type === 'metric'"
            :title="w.title"
            :tip="w.tip"
            :value="mockNumber(w.id)"
            :unit="w.unit"
          />
          <KpiTileWidget
            v-else-if="w.type === 'kpi-tile'"
            :title="w.title"
            :tip="w.tip"
            :layer="w.layer"
            :show-count="w.showCount ?? false"
            :count="mockNumber(w.id, 30)"
            :kpis="w.kpis ?? []"
            :kpi-values="mockKpiValues(w)"
          />
          <MetricCompositeWidget
            v-else-if="w.type === 'metric-composite'"
            :title="w.title"
            :tip="w.tip"
            :layer="w.layer"
            :kpis="w.kpis ?? []"
            :kpi-values="mockKpiValues(w)"
          />
          <article v-else class="odc__pv">
            <div class="odc__pv-head">
              <span class="odc__pv-kind">{{ w.type }}</span>
              <span v-if="w.layer" class="odc__pv-layer">{{ w.layer }}</span>
            </div>
            <div class="odc__pv-title">
              <span class="odc__pv-title-text">{{ w.title }}</span>
              <WidgetTip :tip="w.tip" />
            </div>
            <template v-if="w.type === 'alarms'">
              <ul class="odc__pv-alarms">
                <li v-for="r in mockAlarms(w.id, Math.min(w.limit ?? 10, 3))" :key="r.key" class="odc__pv-alarm">
                  <span class="odc__pv-dot" :class="r.firing ? 'is-err' : 'is-ok'" />
                  <div class="odc__pv-alarm-text">
                    <div class="odc__pv-alarm-msg">{{ r.msg }}</div>
                    <div class="odc__pv-alarm-scope">{{ r.scope }}</div>
                  </div>
                  <span class="odc__pv-alarm-time mono">{{ r.since }}</span>
                </li>
              </ul>
            </template>
            <template v-else-if="w.type === 'topology'">
              <svg class="odc__pv-topo" viewBox="0 0 220 100" preserveAspectRatio="xMidYMid meet">
                <line x1="40" y1="20" x2="110" y2="50" />
                <line x1="40" y1="80" x2="110" y2="50" />
                <line x1="110" y1="50" x2="180" y2="25" />
                <line x1="110" y1="50" x2="180" y2="75" />
                <line x1="180" y1="25" x2="180" y2="75" />
                <circle cx="40" cy="20" r="8" />
                <circle cx="40" cy="80" r="8" />
                <circle cx="110" cy="50" r="10" class="hub" />
                <circle cx="180" cy="25" r="8" />
                <circle cx="180" cy="75" r="8" />
              </svg>
              <div class="odc__pv-sub">{{ t('topology · {layer}', { layer: w.layer ?? '—' }) }}</div>
            </template>
          </article>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.odc {
  padding: 14px 16px 18px;
  background: var(--sw-bg-0);
  min-height: 360px;
}
.odc__head {
  margin-bottom: 14px;
  padding: 8px 10px;
  border-radius: 6px;
  cursor: pointer;
  border: 1px solid transparent;
  transition: border-color 120ms ease, background 120ms ease;
}
.odc__head:hover { background: var(--sw-bg-1); border-color: var(--sw-line-2); }
.odc__title { margin: 0 0 4px; font-size: 18px; color: var(--sw-fg-0); }
.odc__desc { margin: 0; font-size: 12px; color: var(--sw-fg-2); line-height: 1.5; max-width: 880px; }
.odc__empty {
  padding: 40px; text-align: center; font-size: 12.5px; color: var(--sw-fg-3);
  border: 1.5px dashed var(--sw-line-2); border-radius: 6px;
}
.odc__section { margin-bottom: 12px; }
.odc__sb {
  display: inline-flex; align-items: center; gap: 8px;
  padding: 6px 10px;
  background: var(--sw-bg-1);
  border: 1px solid var(--sw-line-2); border-radius: 4px;
  margin-bottom: 8px;
  cursor: pointer;
  transition: border-color 120ms ease, box-shadow 120ms ease;
}
.odc__sb:hover { border-color: var(--sw-fg-3); }
.odc__sb.is-sel { border-color: var(--sw-accent); box-shadow: 0 0 0 3px rgba(249, 115, 22, 0.18); }
.odc__sb-tag {
  font-size: 9.5px; font-family: var(--sw-mono); letter-spacing: 0.06em;
  color: var(--sw-accent); background: var(--sw-accent-soft);
  padding: 1px 6px; border-radius: 3px;
}
.odc__sb-title { font-size: 12.5px; color: var(--sw-fg-1); font-weight: 600; }
.odc__grid { display: grid; grid-auto-rows: minmax(120px, auto); gap: 8px; }
.odc__cell {
  position: relative;
  cursor: pointer;
  border: 1px solid transparent;
  border-radius: 6px;
  transition: border-color 120ms ease, box-shadow 120ms ease;
  min-width: 0;
}
.odc__cell:hover { border-color: var(--sw-line-2); }
.odc__cell.is-sel { border-color: var(--sw-accent); box-shadow: 0 0 0 3px rgba(249, 115, 22, 0.18); }
.odc__pv {
  background: var(--sw-bg-1); border: 1px solid var(--sw-line);
  border-radius: 6px; padding: 8px 10px;
  display: flex; flex-direction: column; gap: 6px;
  min-height: 100%;
}
.odc__pv-head { display: flex; align-items: center; gap: 6px; font-size: 10px; color: var(--sw-fg-3); }
.odc__pv-kind { font-family: var(--sw-mono); text-transform: uppercase; letter-spacing: 0.06em; }
.odc__pv-layer { font-family: var(--sw-mono); }
.odc__pv-title { font-size: 12.5px; font-weight: 600; color: var(--sw-fg-0); display: flex; align-items: center; gap: 6px; min-width: 0; }
.odc__pv-title-text { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.odc__pv-sub { margin-top: auto; font-size: 10.5px; color: var(--sw-fg-3); }
.odc__pv-alarms { list-style: none; margin: 0; padding: 0; }
.odc__pv-alarm { display: flex; gap: 8px; padding: 4px 0; align-items: baseline; border-bottom: 1px dashed var(--sw-line); }
.odc__pv-alarm:last-child { border-bottom: none; }
.odc__pv-dot { width: 6px; height: 6px; border-radius: 50%; flex: 0 0 6px; align-self: center; }
.odc__pv-dot.is-err { background: var(--sw-danger, #c0392b); }
.odc__pv-dot.is-ok { background: var(--sw-ok, #2e7d4e); }
.odc__pv-alarm-text { flex: 1; min-width: 0; }
.odc__pv-alarm-msg { font-size: 11.5px; color: var(--sw-fg-1); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.odc__pv-alarm-scope { font-size: 10.5px; color: var(--sw-fg-3); }
.odc__pv-alarm-time { font-size: 10.5px; color: var(--sw-fg-3); flex: 0 0 auto; }
.odc__pv-topo { width: 100%; height: 90px; color: var(--sw-fg-3); stroke: currentColor; fill: var(--sw-bg-2); stroke-width: 1; }
.odc__pv-topo .hub { fill: var(--sw-accent); stroke: var(--sw-accent); }
</style>
