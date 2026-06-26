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
  Per-widget editor drawer (the right rail of the overview editor). The
  editor is TYPE-AWARE — each widget kind exposes only the fields it
  actually consumes. The drawer mutates widget objects (and their KPI rows)
  IN PLACE — those objects are the same reactive references the parent holds
  in `draft.widgets`, so an in-field edit reflects on the canvas live.
  Array-level operations (reorder / remove a whole widget) reassign the
  widgets array and are owned by the parent, reached via `move` / `remove`.

  A sentinel id (`META_SEL`) selects the dashboard-meta "widget" (title +
  description) instead of a real one.
-->
<script setup lang="ts">
import type { OverviewDashboard, OverviewKpi, OverviewWidget } from '@skywalking-horizon-ui/api-client';
import MqeExpressionInput from '@/features/admin/_shared/MqeExpressionInput.vue';
import { useEscapeToClose } from '@/components/primitives/useEscapeToClose';
import { META_SEL } from './constants';

defineProps<{
  draft: OverviewDashboard;
  selectedWidgetId: string | null;
  /** Live layers + any layer already referenced by the draft. */
  layerOptions: string[];
}>();

const emit = defineEmits<{
  close: [];
  move: [idx: number, dir: -1 | 1];
  remove: [idx: number];
  'update:title': [v: string];
  'update:description': [v: string];
}>();

useEscapeToClose(() => true, () => emit('close'));

function widgetKindLabel(type: OverviewWidget['type']): string {
  switch (type) {
    case 'metric-composite': return 'Composite metrics';
    case 'section-break': return 'Section break';
    case 'metric': return 'Metric';
    case 'topology': return 'Topology';
    case 'alarms': return 'Alarms';
    case 'kpi-tile': return 'KPI tile';
    default: return type;
  }
}

// KPI row helpers — kpi-tile / metric-composite only.
function addKpi(w: OverviewWidget): void {
  const next = [...(w.kpis ?? []), { label: 'new KPI', mqe: '' } as OverviewKpi];
  w.kpis = next;
}
function removeKpi(w: OverviewWidget, idx: number): void {
  if (!w.kpis) return;
  w.kpis = w.kpis.filter((_, i) => i !== idx);
}
function moveKpi(w: OverviewWidget, idx: number, dir: -1 | 1): void {
  if (!w.kpis) return;
  const next = [...w.kpis];
  const j = idx + dir;
  if (j < 0 || j >= next.length) return;
  [next[idx], next[j]] = [next[j], next[idx]];
  w.kpis = next;
}
/* Switching a KPI to progress-bar makes `max` mandatory — seed a
 * sensible default if it isn't set so the BFF doesn't 400 on save. */
function onKpiStyleChange(k: OverviewKpi): void {
  if (k.style === 'progress-bar' && (k.max === undefined || k.max === null)) {
    k.max = 100;
  }
}
</script>

<template>
  <aside class="ot__drawer-pane ot__widgets">
    <div class="ot__drawer-head">
      <span class="ot__drawer-title">{{ selectedWidgetId === META_SEL ? 'Dashboard meta' : 'Edit widget' }}</span>
      <button type="button" class="ot__drawer-close" title="Close (Esc)" @click="emit('close')">✕</button>
    </div>
    <section v-if="selectedWidgetId === META_SEL" class="ot__meta">
      <header class="ot__meta-head">
        <span class="ot__meta-kicker">Dashboard meta</span>
        <span class="ot__meta-hint">Shown in the sidebar and as the page sub-heading.</span>
      </header>
      <label class="ot__field">
        <span>Title</span>
        <input
          :value="draft.title"
          type="text"
          class="ot__in"
          @input="emit('update:title', ($event.target as HTMLInputElement).value)"
        />
      </label>
      <label class="ot__field ot__field--wide">
        <span>Description</span>
        <textarea
          :value="draft.description"
          class="ot__in ot__in--ta"
          rows="3"
          placeholder="Short, one-paragraph description shown under the dashboard title."
          @input="emit('update:description', ($event.target as HTMLTextAreaElement).value)"
        />
      </label>
    </section>

    <article
      v-for="(w, wi) in draft.widgets"
      v-show="w.id === selectedWidgetId"
      :key="w.id"
      class="ot__widget"
      :class="`ot__widget--${w.type}`"
    >
      <header class="ot__widget-head">
        <span class="ot__widget-kind">{{ widgetKindLabel(w.type) }}</span>
        <code class="ot__widget-id">{{ w.id }}</code>
        <span class="ot__widget-actions">
          <button
            type="button"
            class="ot__arrow"
            :disabled="wi === 0"
            title="Move up"
            @click="emit('move', wi, -1)"
          >‹</button>
          <button
            type="button"
            class="ot__arrow"
            :disabled="wi === draft.widgets.length - 1"
            title="Move down"
            @click="emit('move', wi, 1)"
          >›</button>
          <button
            type="button"
            class="ot__del"
            title="Remove widget"
            @click="emit('remove', wi)"
          >×</button>
        </span>
      </header>

      <!-- 1. Size (width / height) first per the spec — layout
           decisions before content. section-break has no
           per-cell span (it spans the whole row), so we show
           the grid `cols` field there instead. -->
      <div class="ot__row">
        <label v-if="w.type === 'section-break'" class="ot__field">
          <span>Columns (grid)</span>
          <input v-model.number="w.cols" type="number" min="1" max="12" class="ot__in ot__in--num" />
        </label>
        <template v-else>
          <label class="ot__field">
            <span>Width (span)</span>
            <input v-model.number="w.span" type="number" min="1" max="12" class="ot__in ot__in--num" />
          </label>
          <label class="ot__field">
            <span>Height (rows)</span>
            <input v-model.number="w.rowSpan" type="number" min="1" max="12" class="ot__in ot__in--num" />
          </label>
        </template>
      </div>

      <div class="ot__row">
        <label class="ot__field ot__field--wide">
          <span>Title</span>
          <input v-model="w.title" type="text" class="ot__in" />
        </label>
        <label v-if="w.type !== 'section-break'" class="ot__field ot__field--wide">
          <span>Tip</span>
          <input v-model="w.tip" type="text" class="ot__in" placeholder="(optional)" />
        </label>
      </div>

      <div v-if="w.type !== 'section-break'" class="ot__row">
        <label class="ot__field">
          <span>Layer</span>
          <select v-model="w.layer" class="ot__in ot__in--narrow">
            <option :value="undefined">— any —</option>
            <option v-for="k in layerOptions" :key="k" :value="k">{{ k }}</option>
          </select>
        </label>
      </div>

      <div v-if="w.type === 'metric'" class="ot__row">
        <label class="ot__field ot__field--wide">
          <span>MQE</span>
          <MqeExpressionInput v-model="w.mqe" placeholder="service_cpm" title="Widget MQE" />
        </label>
        <label class="ot__field">
          <span>Unit</span>
          <input v-model="w.unit" type="text" class="ot__in ot__in--narrow" placeholder="rpm / ms / %" />
        </label>
        <label class="ot__field">
          <span>Aggregation</span>
          <select v-model="w.aggregation" class="ot__in ot__in--narrow">
            <option :value="undefined">—</option>
            <option value="avg">avg</option>
            <option value="sum">sum</option>
          </select>
        </label>
      </div>

      <div v-if="w.type === 'alarms'" class="ot__row">
        <label class="ot__field">
          <span>Row limit</span>
          <input v-model.number="w.limit" type="number" min="1" max="100" class="ot__in ot__in--num" />
        </label>
      </div>

      <template v-if="w.type === 'kpi-tile' || w.type === 'metric-composite'">
        <div v-if="w.type === 'kpi-tile'" class="ot__row">
          <label class="ot__field">
            <span>Show service count</span>
            <input type="checkbox" v-model="w.showCount" />
          </label>
        </div>
        <div class="ot__kpis">
          <div class="ot__kpis-head">
            <span>KPI rows ({{ (w.kpis ?? []).length }})</span>
            <button type="button" class="ot__add-btn" @click="addKpi(w)">+ add row</button>
          </div>
          <div v-if="(w.kpis ?? []).length === 0" class="ot__kpis-empty">
            No KPI rows. Add one to surface a metric on the tile.
          </div>
          <!-- One card per KPI. The drawer is narrow (sidebar-only),
               so fields stack vertically instead of a wide table
               row that truncates every column. -->
          <ul v-else class="ot__kpi-cards">
            <li v-for="(k, i) in w.kpis ?? []" :key="i" class="ot__kpi-card">
              <div class="ot__kpi-card-head">
                <span class="ot__kpi-card-idx">#{{ i + 1 }}</span>
                <div class="ot__kpi-card-ord">
                  <button
                    type="button"
                    class="ot__arrow"
                    title="Move up"
                    :disabled="i === 0"
                    @click="moveKpi(w, i, -1)"
                  >↑</button>
                  <button
                    type="button"
                    class="ot__arrow"
                    title="Move down"
                    :disabled="i === (w.kpis ?? []).length - 1"
                    @click="moveKpi(w, i, 1)"
                  >↓</button>
                </div>
                <button type="button" class="ot__del" title="Remove row" @click="removeKpi(w, i)">×</button>
              </div>
              <label class="ot__field ot__field--full">
                <span>Label</span>
                <input v-model="k.label" type="text" class="ot__in" />
              </label>
              <label class="ot__field ot__field--full">
                <span>Source</span>
                <select v-model="k.source" class="ot__in">
                  <option :value="undefined">mqe</option>
                  <option value="mqe">mqe</option>
                  <option value="service-count">service-count</option>
                </select>
              </label>
              <label v-if="(k.source ?? 'mqe') === 'mqe'" class="ot__field ot__field--full">
                <span>MQE</span>
                <MqeExpressionInput v-model="k.mqe" title="KPI MQE" />
              </label>
              <p v-else class="ot__none">Value comes from the service count (listServices) — no MQE.</p>
              <div class="ot__kpi-card-grid">
                <label class="ot__field">
                  <span>Unit</span>
                  <input v-model="k.unit" type="text" class="ot__in" />
                </label>
                <label class="ot__field">
                  <span>Aggr</span>
                  <select v-model="k.aggregation" class="ot__in">
                    <option :value="undefined">—</option>
                    <option value="avg">avg</option>
                    <option value="sum">sum</option>
                  </select>
                </label>
                <label class="ot__field">
                  <span>Style</span>
                  <select v-model="k.style" class="ot__in" @change="onKpiStyleChange(k)">
                    <option :value="undefined">number</option>
                    <option value="number">number</option>
                    <option value="progress-bar">progress-bar</option>
                  </select>
                </label>
                <label v-if="k.style === 'progress-bar'" class="ot__field">
                  <span>Max</span>
                  <input
                    v-model.number="k.max"
                    type="number"
                    min="0"
                    step="any"
                    class="ot__in"
                    placeholder="100"
                  />
                </label>
              </div>
            </li>
          </ul>
        </div>
      </template>
    </article>
  </aside>
</template>

<style scoped>
.ot__widgets { display: flex; flex-direction: column; gap: 10px; }
.ot__drawer-pane {
  order: 2;
  flex: 0 0 380px;
  max-width: 380px;
  position: sticky;
  top: 12px;
  max-height: calc(100vh - 90px);
  overflow-y: auto;
  border-left: 1px solid var(--sw-line);
  padding-left: 14px;
}
.ot__drawer-head { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; padding-bottom: 8px; border-bottom: 1px solid var(--sw-line); }
.ot__drawer-title { font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--sw-fg-2); font-weight: 600; }
.ot__drawer-close { margin-left: auto; background: transparent; border: none; color: var(--sw-fg-3); font-size: 14px; cursor: pointer; width: 22px; height: 22px; border-radius: 4px; }
.ot__drawer-close:hover { background: var(--sw-bg-2); color: var(--sw-fg-0); }

.ot__widget {
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line);
  border-radius: 6px;
  padding: 10px 12px;
}
.ot__widget--section-break { border-left: 3px solid var(--sw-accent); }
.ot__widget-head {
  display: flex; align-items: baseline; gap: 8px;
  margin-bottom: 8px;
}
.ot__widget-kind {
  font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em;
  color: var(--sw-accent); font-weight: 600;
}
.ot__widget-id {
  font-family: var(--sw-mono); font-size: 10.5px; color: var(--sw-fg-3);
  margin-left: auto;
}
.ot__widget-actions { display: inline-flex; gap: 2px; }
.ot__widget-actions .ot__arrow { width: 22px; height: 22px; }
.ot__widget-actions .ot__del { font-size: 16px; }

.ot__row { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 6px; }
.ot__field {
  display: flex; flex-direction: column; gap: 3px;
  min-width: 140px;
}
.ot__field--wide { flex: 1 1 220px; }
.ot__field > span {
  font-size: 9.5px; text-transform: uppercase; letter-spacing: 0.08em;
  color: var(--sw-fg-3); font-weight: 600;
}
.ot__in {
  background: var(--sw-bg-1); border: 1px solid var(--sw-line);
  color: var(--sw-fg-0); font: inherit; font-size: 11.5px;
  padding: 4px 6px; border-radius: 4px;
}
.ot__in--narrow { width: 160px; }
.ot__in--num { width: 80px; font-variant-numeric: tabular-nums; }
.ot__in--ta {
  /* Textarea variant of `.ot__in`. Three lines is the sweet spot for a
     description paragraph — enough to read the whole sentence without
     scrolling, not so tall it pushes the widget list down. The base
     `.ot__in` 4px vertical padding is cramped for multi-line text;
     restore comfortable line-height + padding here. */
  width: 100%;
  min-height: 72px;
  padding: 8px 10px;
  resize: vertical;
  line-height: 1.5;
  font-family: var(--sw-sans);
  font-size: 12px;
}
.ot__field input[type='checkbox'] { width: 14px; height: 14px; margin: 4px 0 0; cursor: pointer; }
.ot__none { color: var(--sw-fg-3); font-size: 11px; }

.ot__meta {
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line);
  border-radius: 6px;
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.ot__meta-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
}
.ot__meta-kicker {
  font-size: 9.5px;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--sw-fg-3);
  font-weight: 700;
}
.ot__meta-hint {
  font-size: 10.5px;
  color: var(--sw-fg-3);
}

.ot__kpis {
  margin-top: 8px;
  background: var(--sw-bg-1);
  border: 1px solid var(--sw-line);
  border-radius: 5px;
  padding: 8px;
}
.ot__kpis-head {
  display: flex; align-items: center; gap: 8px;
  font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em;
  color: var(--sw-fg-3); font-weight: 600;
  margin-bottom: 6px;
}
.ot__kpis-empty {
  padding: 14px; text-align: center;
  font-size: 11.5px; color: var(--sw-fg-3);
}
.ot__add-btn {
  margin-left: auto;
  background: transparent; border: 1px dashed var(--sw-line-2);
  color: var(--sw-fg-2); font: inherit; font-size: 11px;
  padding: 2px 10px; border-radius: 4px; cursor: pointer;
}
.ot__add-btn:hover { color: var(--sw-fg-0); border-style: solid; }
/* KPI rows as stacked cards (the drawer is sidebar-narrow — a wide table
   row truncates every column). One bordered card per row; full-width
   Label/Source/MQE, then a 2-col Unit/Aggr/Style/Max grid. */
.ot__kpi-cards { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.ot__kpi-card {
  background: var(--sw-bg-2); border: 1px solid var(--sw-line);
  border-radius: 5px; padding: 8px 10px;
  display: flex; flex-direction: column; gap: 8px;
}
.ot__kpi-card-head { display: flex; align-items: center; gap: 6px; }
.ot__kpi-card-idx {
  font-size: 10px; font-weight: 700; font-family: var(--sw-mono);
  color: var(--sw-fg-3);
}
.ot__kpi-card-ord { display: inline-flex; gap: 2px; margin-left: auto; }
.ot__kpi-card-grid {
  display: grid; grid-template-columns: 1fr 1fr; gap: 8px;
}
.ot__kpi-card .ot__field { min-width: 0; }
.ot__kpi-card .ot__field--full { grid-column: 1 / -1; }
.ot__kpi-card .ot__in { width: 100%; box-sizing: border-box; }
.ot__kpi-card .ot__none { margin: 0; }
.ot__arrow {
  background: transparent; border: 0;
  color: var(--sw-fg-2); font: inherit; font-size: 12px;
  width: 20px; height: 22px; cursor: pointer;
}
.ot__arrow:disabled { opacity: 0.3; cursor: not-allowed; }
.ot__arrow:not(:disabled):hover { color: var(--sw-fg-0); }
.ot__del {
  background: transparent; border: 0;
  color: var(--sw-fg-3); font: inherit; font-size: 14px; line-height: 1;
  width: 22px; height: 22px; cursor: pointer; border-radius: 3px;
}
.ot__del:hover { color: var(--sw-err); background: var(--sw-bg-2); }
</style>
