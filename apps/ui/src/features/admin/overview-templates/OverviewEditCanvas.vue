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
  Interactive edit canvas — the LEFT pane of the overview editor. Renders
  the dashboard's section-broken widget grid with the REAL overview widget
  primitives (Metric / KpiTile / MetricComposite) fed deterministic mock
  data, so the layout reads pixel-for-pixel like the live page. On top of
  that read-only preview it layers the editor affordances the live page
  doesn't have:

   - click a cell / section-break / page header to SELECT it (the drawer
     edits the selection); the inner preview is pointer-events:none so a
     click selects rather than following a widget's link.
   - HTML5 drag to REORDER widgets within the flat widgets array.
   - a corner handle to RESIZE (drag updates span / rowSpan).
   - an inline "+ Add widget" composer that gates a new widget on
     (type, width, height) before appending it with per-type defaults.

  Mutations that reorder / add reassign the whole dashboard via
  `update:modelValue`; resize mutates the widget object in place (it's the
  same reactive reference the parent holds).
-->
<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import type { OverviewDashboard, OverviewWidget } from '@skywalking-horizon-ui/api-client';
import KpiTileWidget from '@/render/widgets/KpiTileWidget.vue';
import MetricWidget from '@/render/widgets/MetricWidget.vue';
import MetricCompositeWidget from '@/render/widgets/MetricCompositeWidget.vue';
import { mockAlarms, mockKpiValues, mockNumber } from './widget-mock';
import { META_SEL } from './constants';

const props = defineProps<{
  modelValue: OverviewDashboard;
  selectedWidgetId: string | null;
}>();

const emit = defineEmits<{
  'update:modelValue': [dash: OverviewDashboard];
  'select-widget': [id: string];
}>();

function selectWidget(id: string): void {
  emit('select-widget', id);
}

interface PreviewSection {
  cols: number;
  /** The section-break widget that opened this section (its id + title),
   *  or null for the implicit first section. Lets the canvas render the
   *  section-break as a selectable header. */
  sb: OverviewWidget | null;
  widgets: OverviewWidget[];
}
const previewSections = computed<PreviewSection[]>(() => {
  const out: PreviewSection[] = [];
  let cur: PreviewSection | null = null;
  for (const w of props.modelValue.widgets) {
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

/** Grid placement for one preview cell — span/rowSpan within the
 *  section's column count. Same clamps as the live renderer
 *  (OverviewDashboardView.widgetStyle): span ∈ [1, cols], rowSpan ∈ [1, 8]. */
function previewCellStyle(w: OverviewWidget, cols: number): Record<string, string> {
  return {
    gridColumn: `span ${Math.min(cols, Math.max(1, w.span ?? cols))}`,
    gridRow: `span ${Math.min(8, Math.max(1, w.rowSpan ?? 1))}`,
  };
}

const dragId = ref<string | null>(null);
function onWidgetDragStart(e: DragEvent, id: string): void {
  dragId.value = id;
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
}
function onWidgetDrop(targetId: string): void {
  const d = props.modelValue;
  if (!d || !dragId.value || dragId.value === targetId) {
    dragId.value = null;
    return;
  }
  const ws = [...d.widgets];
  const from = ws.findIndex((w) => w.id === dragId.value);
  const to = ws.findIndex((w) => w.id === targetId);
  dragId.value = null;
  if (from < 0 || to < 0) return;
  const [moved] = ws.splice(from, 1);
  ws.splice(to, 0, moved!);
  emit('update:modelValue', { ...d, widgets: ws });
}

const resize = reactive({ active: false, id: '', startX: 0, startY: 0, startSpan: 4, startRowSpan: 1, cellW: 1, cellH: 96, cols: 12 });
function onResizeStart(e: MouseEvent, w: OverviewWidget, cols: number): void {
  e.preventDefault();
  e.stopPropagation();
  const grid = (e.target as HTMLElement).closest('.ot__pv-grid') as HTMLElement | null;
  if (!grid) return;
  const gap = 6;
  const cellW = (grid.getBoundingClientRect().width - gap * (cols - 1)) / cols;
  resize.active = true;
  resize.id = w.id;
  resize.startX = e.clientX;
  resize.startY = e.clientY;
  resize.startSpan = w.span ?? 4;
  resize.startRowSpan = w.rowSpan ?? 1;
  resize.cellW = cellW + gap;
  resize.cellH = 96 + gap;
  resize.cols = cols;
  selectWidget(w.id);
  window.addEventListener('mousemove', onResizeMove);
  window.addEventListener('mouseup', onResizeEnd);
}
function onResizeMove(e: MouseEvent): void {
  if (!resize.active || !props.modelValue) return;
  const span = Math.max(1, Math.min(resize.cols, resize.startSpan + Math.round((e.clientX - resize.startX) / resize.cellW)));
  const rowSpan = Math.max(1, Math.min(8, resize.startRowSpan + Math.round((e.clientY - resize.startY) / resize.cellH)));
  const w = props.modelValue.widgets.find((x) => x.id === resize.id);
  if (w && (w.span !== span || w.rowSpan !== rowSpan)) {
    w.span = span;
    w.rowSpan = rowSpan;
  }
}
function onResizeEnd(): void {
  resize.active = false;
  window.removeEventListener('mousemove', onResizeMove);
  window.removeEventListener('mouseup', onResizeEnd);
}

/* Small inline form that gates a new widget on (type, width, height)
 * — the operator picks those first per the spec, then the widget
 * is appended with sensible defaults and the existing per-widget
 * editor handles everything else. */
const WIDGET_TYPE_OPTIONS: ReadonlyArray<{ type: OverviewWidget['type']; label: string }> = [
  { type: 'section-break', label: 'Section break' },
  { type: 'metric', label: 'Metric' },
  { type: 'topology', label: 'Topology' },
  { type: 'alarms', label: 'Alarms' },
  { type: 'kpi-tile', label: 'KPI tile (number + metrics)' },
  { type: 'metric-composite', label: 'Composite metrics (mixed)' },
];

const composerOpen = ref(false);
const composerType = ref<OverviewWidget['type']>('metric');
const composerSpan = ref<number>(3);
const composerRowSpan = ref<number>(1);

function openComposer(): void {
  composerOpen.value = true;
  /* Default sizing matches the most common shape per type so the
   * operator doesn't have to remember "topology wants 9x6" etc. */
  composerType.value = 'metric';
  composerSpan.value = 3;
  composerRowSpan.value = 1;
}
function cancelComposer(): void {
  composerOpen.value = false;
}

/** Auto-id: `<type>_<n>` where n increments to avoid collisions with
 *  any existing widget id in the dashboard. */
function nextWidgetId(type: string): string {
  const existing = new Set(props.modelValue.widgets.map((w) => w.id));
  let n = 1;
  while (existing.has(`${type}_${n}`)) n++;
  return `${type}_${n}`;
}

/** Per-type seed values — title + any required type-specific fields
 *  so the new widget renders something sensible immediately and the
 *  save round-trip passes the BFF's zod schema. */
function widgetDefaults(type: OverviewWidget['type']): Partial<OverviewWidget> {
  switch (type) {
    case 'section-break':
      return { title: 'New section', cols: 12 };
    case 'metric':
      return { title: 'New metric', mqe: '', aggregation: 'avg' };
    case 'topology':
      return { title: 'Topology' };
    case 'alarms':
      return { title: 'Active alarms', limit: 10 };
    case 'kpi-tile':
      return { title: 'KPI tile', kpis: [], showCount: false };
    case 'metric-composite':
      return { title: 'Composite metrics', kpis: [] };
    default:
      return { title: 'New widget' };
  }
}

function createWidget(): void {
  const type = composerType.value;
  const defaults = widgetDefaults(type);
  const widget: OverviewWidget = {
    id: nextWidgetId(type),
    title: defaults.title ?? 'New widget',
    type,
    span: type === 'section-break' ? undefined : composerSpan.value,
    rowSpan: type === 'section-break' ? undefined : composerRowSpan.value,
    ...defaults,
  };
  emit('update:modelValue', { ...props.modelValue, widgets: [...props.modelValue.widgets, widget] });
  composerOpen.value = false;
  selectWidget(widget.id);
}
</script>

<template>
  <!-- Canvas: mock-data widget grid. Click a widget to edit it in the
       drawer; only the live "Preview ▾" page uses real OAP data. -->
  <div class="ot__canvas-pane ot__preview">
    <div class="ot__canvas-hint">layout + mock data · click a widget to edit · the live page uses real data</div>
    <!-- Page heading preview — the dashboard title + description as
         they render on the live overview page. Click to edit the
         dashboard meta in the drawer, like any widget. -->
    <header
      class="ot__canvas-title"
      :class="{ 'ot__cw--sel': selectedWidgetId === META_SEL }"
      @click="selectWidget(META_SEL)"
    >
      <h2>{{ modelValue.title || modelValue.id }}</h2>
      <p v-if="modelValue.description" class="ot__canvas-desc">{{ modelValue.description }}</p>
    </header>
    <div
      v-for="(sec, si) in previewSections"
      :key="si"
      class="ot__pv-section"
    >
      <!-- Section break (a.k.a. line-break / text header) — a real
           selectable widget; click to edit its title + columns. -->
      <div
        v-if="sec.sb"
        class="ot__pv-section-head ot__pv-sb"
        :class="{ 'ot__cw--sel': selectedWidgetId === sec.sb.id, 'ot__cw--drag': dragId === sec.sb.id }"
        draggable="true"
        @click="selectWidget(sec.sb.id)"
        @dragstart="onWidgetDragStart($event, sec.sb.id)"
        @dragend="dragId = null"
        @dragover.prevent
        @drop.prevent="onWidgetDrop(sec.sb.id)"
      >
        <span class="ot__pv-sb-tag">section</span>
        <span class="ot__pv-sb-title">{{ sec.sb.title || '(untitled section)' }}</span>
        <span class="ot__pv-sb-cols">{{ sec.cols }} cols</span>
      </div>
      <div
        class="ot__pv-grid"
        :style="{ gridTemplateColumns: `repeat(${sec.cols}, minmax(0, 1fr))` }"
      >
        <!-- Each widget is wrapped in a selectable cell. The inner
             preview (the real overview component, mock data) is
             pointer-events:none so a click selects the widget for
             editing instead of following KpiTileWidget's link. -->
        <div
          v-for="w in sec.widgets"
          :key="w.id"
          class="ot__cw"
          :class="{ 'ot__cw--sel': selectedWidgetId === w.id, 'ot__cw--drag': dragId === w.id }"
          :style="previewCellStyle(w, sec.cols)"
          draggable="true"
          @click="selectWidget(w.id)"
          @dragstart="onWidgetDragStart($event, w.id)"
          @dragend="dragId = null"
          @dragover.prevent
          @drop.prevent="onWidgetDrop(w.id)"
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
          <article v-else class="ot__pv-card">
            <div class="ot__pv-card-head">
              <span class="ot__pv-kind">{{ widgetKindLabel(w.type) }}</span>
              <span v-if="w.layer" class="ot__pv-layer">{{ w.layer }}</span>
            </div>
            <div class="ot__pv-title">{{ w.title }}</div>
            <template v-if="w.type === 'alarms'">
            <!-- Mock alarm rows — same shape as AlarmsWidget so
                 the operator sees the rail layout, not just a
                 count. Severity / message / scope all mocked. -->
            <ul class="ot__pv-alarms">
              <li
                v-for="row in mockAlarms(w.id, Math.min(w.limit ?? 10, 3))"
                :key="row.key"
                class="ot__pv-alarm"
              >
                <span class="ot__pv-alarm-dot" :class="row.firing ? 'is-err' : 'is-ok'" />
                <div class="ot__pv-alarm-text">
                  <div class="ot__pv-alarm-msg">{{ row.msg }}</div>
                  <div class="ot__pv-alarm-scope">{{ row.scope }}</div>
                </div>
                <span class="ot__pv-alarm-time mono">{{ row.since }}</span>
              </li>
            </ul>
            <div class="ot__pv-sub">
              mock · max {{ w.limit ?? 10 }} rows
            </div>
          </template>
          <template v-else-if="w.type === 'topology'">
            <!-- Mock topology SVG: a small graph of circles + edges
                 so the operator sees the shape of a topology tile
                 in this widget's slot. -->
            <svg class="ot__pv-topo-svg" viewBox="0 0 220 100" preserveAspectRatio="xMidYMid meet">
              <line x1="40"  y1="20" x2="110" y2="50" />
              <line x1="40"  y1="80" x2="110" y2="50" />
              <line x1="110" y1="50" x2="180" y2="25" />
              <line x1="110" y1="50" x2="180" y2="75" />
              <line x1="180" y1="25" x2="180" y2="75" />
              <circle cx="40"  cy="20" r="8" />
              <circle cx="40"  cy="80" r="8" />
              <circle cx="110" cy="50" r="10" class="hub" />
              <circle cx="180" cy="25" r="8" />
              <circle cx="180" cy="75" r="8" />
            </svg>
            <div class="ot__pv-sub">topology · {{ w.layer ?? '—' }}</div>
          </template>
          </article>
          <!-- Corner resize handle (drag to change span / rowSpan). -->
          <span
            class="ot__cw-resize"
            title="Drag to resize"
            @mousedown="onResizeStart($event, w, sec.cols)"
          />
        </div>
      </div>
    </div>
    <div v-if="previewSections.length === 0" class="ot__pv-empty">
      No widgets yet — add one below.
    </div>
    <!-- Add-widget composer, on the canvas (the drawer only shows
         when a widget is selected). -->
    <div class="ot__add-widget">
      <button
        v-if="!composerOpen"
        type="button"
        class="ot__add-trigger"
        @click="openComposer"
      >
        + Add widget
      </button>
      <article v-else class="ot__widget ot__composer">
        <header class="ot__widget-head">
          <span class="ot__widget-kind">New widget</span>
        </header>
        <div class="ot__row">
          <label class="ot__field">
            <span>Type</span>
            <select v-model="composerType" class="ot__in ot__in--narrow">
              <option v-for="opt in WIDGET_TYPE_OPTIONS" :key="opt.type" :value="opt.type">
                {{ opt.label }}
              </option>
            </select>
          </label>
          <label v-if="composerType !== 'section-break'" class="ot__field">
            <span>Width (span)</span>
            <input v-model.number="composerSpan" type="number" min="1" max="12" class="ot__in ot__in--num" />
          </label>
          <label v-if="composerType !== 'section-break'" class="ot__field">
            <span>Height (rows)</span>
            <input v-model.number="composerRowSpan" type="number" min="1" max="12" class="ot__in ot__in--num" />
          </label>
        </div>
        <div class="ot__composer-foot">
          <span class="ot__composer-hint">
            A default title + content scaffold is generated; you can edit everything after creating.
          </span>
          <button type="button" class="ot__btn" @click="cancelComposer">cancel</button>
          <button type="button" class="ot__btn ot__btn--primary" @click="createWidget">create</button>
        </div>
      </article>
    </div>
  </div>
</template>

<style scoped>
.ot__preview {
  margin-top: 14px;
  padding: 12px;
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line);
  border-radius: 6px;
}
.ot__canvas-pane { order: 1; flex: 1 1 0; min-width: 0; }
.ot__canvas-hint { font-size: 10.5px; color: var(--sw-fg-3); margin-bottom: 8px; }
.ot__canvas-title {
  margin-bottom: 12px; padding: 4px 6px 10px; cursor: pointer; border-radius: 6px;
  /* Same selectable hint as the canvas cells. */
  outline: 1px dashed var(--sw-line-2); outline-offset: 2px;
}
.ot__canvas-title:hover { background: var(--sw-bg-2); outline-color: var(--sw-fg-3); }
.ot__canvas-title h2 { margin: 0; font-size: 17px; font-weight: 600; color: var(--sw-fg-0); }
.ot__canvas-desc { margin: 4px 0 0; font-size: 12px; color: var(--sw-fg-2); line-height: 1.5; max-width: 760px; }

.ot__pv-section { margin-bottom: 10px; }
.ot__pv-section-head {
  font-size: 10.5px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--sw-fg-2);
  padding-bottom: 6px;
  border-bottom: 1px dashed var(--sw-line);
  margin-bottom: 6px;
}
/* Mirror the live renderer's section grid (OverviewDashboardView): fixed
   72px auto-rows so `rowSpan` is real height and `span` columns sit
   side-by-side, instead of collapsing to content height (which stacks a
   span-9 topology above a span-3 alarms rather than beside it). */
.ot__pv-grid { display: grid; grid-auto-rows: 72px; gap: 8px; }
/* Inner widget fills its spanned cell, like the live page (grid items
   stretch by default; the inner component must take the full height). */
.ot__cw > *:not(.ot__cw-resize) { height: 100%; box-sizing: border-box; }
.ot__pv-card {
  background: var(--sw-bg-1);
  border: 1px solid var(--sw-line);
  border-radius: 4px;
  padding: 6px 8px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-height: 60px;
  overflow: hidden;
}
.ot__pv-card-head { display: flex; gap: 6px; align-items: baseline; }
.ot__pv-kind {
  font-size: 9px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--sw-accent);
  font-weight: 600;
}
.ot__pv-layer {
  font-family: var(--sw-mono);
  font-size: 9px;
  color: var(--sw-fg-3);
  margin-left: auto;
}
.ot__pv-title { font-size: 11px; color: var(--sw-fg-0); font-weight: 500; }
.ot__pv-sub { font-size: 10px; color: var(--sw-fg-3); }
/* Topology mock — SVG of a few nodes + edges. Uses currentColor /
 * design tokens so the graph reads against the card background. */
.ot__pv-topo-svg {
  width: 100%;
  flex: 1;
  min-height: 80px;
  max-height: 140px;
}
.ot__pv-topo-svg line {
  stroke: var(--sw-line-2);
  stroke-width: 1;
  opacity: 0.7;
}
.ot__pv-topo-svg circle {
  fill: var(--sw-bg-2);
  stroke: var(--sw-fg-2);
  stroke-width: 1.5;
}
.ot__pv-topo-svg circle.hub {
  fill: var(--sw-accent-soft);
  stroke: var(--sw-accent);
}

.ot__pv-alarms { list-style: none; margin: 0; padding: 0; }
.ot__pv-alarm {
  display: flex; align-items: flex-start; gap: 6px;
  padding: 4px 0;
  border-top: 1px solid var(--sw-line);
  font-size: 10.5px;
}
.ot__pv-alarm:first-child { border-top: none; }
.ot__pv-alarm-dot {
  width: 5px; height: 5px; border-radius: 50%; margin-top: 4px; flex-shrink: 0;
}
.ot__pv-alarm-dot.is-err { background: var(--sw-err); }
.ot__pv-alarm-dot.is-ok { background: var(--sw-ok); }
.ot__pv-alarm-text { flex: 1; min-width: 0; }
.ot__pv-alarm-msg {
  color: var(--sw-fg-1); white-space: nowrap;
  overflow: hidden; text-overflow: ellipsis;
}
.ot__pv-alarm-scope {
  font-family: var(--sw-mono); font-size: 9px;
  color: var(--sw-fg-3); white-space: nowrap;
  overflow: hidden; text-overflow: ellipsis;
}
.ot__pv-alarm-time { color: var(--sw-fg-3); font-size: 9px; flex-shrink: 0; }
.ot__pv-empty {
  padding: 14px; text-align: center;
  font-size: 11px; color: var(--sw-fg-3); font-style: italic;
}

/* Canvas cell: selectable wrapper. The inner preview is pointer-events:none
   so clicking selects the widget (instead of following its link). */
.ot__cw {
  position: relative;
  min-width: 0;
  cursor: grab;
  border-radius: 8px;
  /* Dashed hint that the tile is selectable; firms up on hover, becomes a
     solid accent outline when selected. */
  outline: 1px dashed var(--sw-line-2);
  outline-offset: 2px;
}
.ot__cw:hover { outline-color: var(--sw-fg-3); }
.ot__cw:active { cursor: grabbing; }
.ot__cw > * { pointer-events: none; }
.ot__cw--sel { outline: 2px solid var(--sw-accent) !important; outline-offset: 1px; border-radius: 8px; }
.ot__cw--drag { opacity: 0.45; }
/* Corner resize handle — overrides the cell's pointer-events:none so it
   can capture its own mousedown. */
.ot__cw-resize {
  pointer-events: auto;
  position: absolute;
  right: 2px;
  bottom: 2px;
  width: 14px;
  height: 14px;
  cursor: nwse-resize;
  border-right: 2px solid var(--sw-fg-3);
  border-bottom: 2px solid var(--sw-fg-3);
  border-bottom-right-radius: 3px;
  opacity: 0.5;
}
.ot__cw:hover .ot__cw-resize { opacity: 0.9; }
/* Section-break rendered as a selectable header in the canvas. */
.ot__pv-sb {
  display: flex; align-items: center; gap: 8px; cursor: pointer;
  border-radius: 5px; padding: 5px 8px; margin-bottom: 6px;
  /* Same selectable hint as the canvas cells. */
  outline: 1px dashed var(--sw-line-2); outline-offset: 2px;
}
.ot__pv-sb:hover { background: var(--sw-bg-2); outline-color: var(--sw-fg-3); }
.ot__pv-sb-tag {
  font-size: 8.5px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em;
  color: var(--sw-accent); border: 1px solid var(--sw-accent-line, var(--sw-accent));
  border-radius: 3px; padding: 0 4px;
}
.ot__pv-sb-title { flex: 1; font-weight: 600; color: var(--sw-fg-0); text-transform: none; letter-spacing: 0; }
.ot__pv-sb-cols { font-size: 9.5px; color: var(--sw-fg-3); font-family: var(--sw-mono); }

/* Field primitives reused by the composer. */
.ot__widget {
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line);
  border-radius: 6px;
  padding: 10px 12px;
}
.ot__widget-head {
  display: flex; align-items: baseline; gap: 8px;
  margin-bottom: 8px;
}
.ot__widget-kind {
  font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em;
  color: var(--sw-accent); font-weight: 600;
}
.ot__row { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 6px; }
.ot__field {
  display: flex; flex-direction: column; gap: 3px;
  min-width: 140px;
}
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

.ot__add-widget { margin-top: 8px; }
.ot__add-trigger {
  width: 100%;
  background: transparent;
  border: 1px dashed var(--sw-line-2);
  color: var(--sw-fg-2);
  font: inherit;
  font-size: 12px;
  padding: 10px;
  border-radius: 6px;
  cursor: pointer;
}
.ot__add-trigger:hover {
  border-color: var(--sw-accent);
  color: var(--sw-fg-0);
  background: var(--sw-bg-2);
}
.ot__composer { border-color: var(--sw-accent); }
.ot__composer-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
}
.ot__composer-hint {
  font-size: 10.5px;
  color: var(--sw-fg-3);
  flex: 1;
  font-style: italic;
}
.ot__btn {
  background: var(--sw-bg-1); border: 1px solid var(--sw-line-2);
  color: var(--sw-fg-0); font: inherit; font-size: 12px;
  padding: 6px 14px; border-radius: 4px; cursor: pointer;
}
.ot__btn:not(:disabled):hover { background: var(--sw-bg-2); }
.ot__btn--primary {
  background: var(--sw-accent); border-color: var(--sw-accent);
  color: #0a0d12; font-weight: 600;
}
.ot__btn--primary:not(:disabled):hover { background: var(--sw-accent-light, #fb923c); }
</style>
