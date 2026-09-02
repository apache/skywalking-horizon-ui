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
  Widget editor canvas — the dashboard-canvas editor for a layer's
  widget scopes (service / instance / endpoint). A sticky "+ Add widget"
  header, the 12-col canvas grid of widget tiles (with mock previews,
  drag-to-reorder, drag-to-resize, and inline tab-group editing), and the
  right-hand drawer that edits the selected widget (type, MQE expression
  rows, value-map / colour editors, the structured Visible-when gate, and
  tab / sub-widget management).

  Config-local: it edits the widget list for the CURRENTLY ACTIVE scope of
  the shared reactive `draft` (passed by reference — never cloned). Every
  mutation rewrites `draft.template.dashboards[scope]` in place via
  setWidgetsFor, mirroring the legacy in-parent editor exactly. The canvas
  previews fire NO MQE — they use the mock helpers so the layout reads as a
  real dashboard without a query per keystroke.
-->
<script setup lang="ts">
import { computed, ref, onMounted, onBeforeUnmount, watch, nextTick } from 'vue';
import { useI18n } from 'vue-i18n';
import type { AdminLayerTemplate } from '@/api/client';
import type {
  DashboardWidget,
  DashboardTab,
} from '@skywalking-horizon-ui/api-client';
import { collectWidgetIds } from '@skywalking-horizon-ui/api-client';
import { useExtPages } from './useExtPages';
import { useCanvasResize } from './useCanvasResize';
import { useCanvasReorder } from './useCanvasReorder';
import {
  DRAWER_COL,
  widgetSpan,
  widgetRowSpan,
  widgetGridStyle,
} from '@/features/admin/layer-templates/layer-dashboards.geometry';
import { nextFreeId } from './free-id';
import { type AdminScope, scopeLabelOf } from './layer-dashboards.scopes';
import TimeChart from '@/components/charts/TimeChart.vue';
import TopList from '@/components/charts/TopList.vue';
import { fmtMetric } from '@/utils/formatters';
import { mockCardValue, mockLineSeries, mockRecordRows, mockTopGroups } from './widget-mock';
import MqeExpressionInput from '@/features/admin/_shared/MqeExpressionInput.vue';
import type { MqeSiteScope } from '@/features/admin/_shared/mqeEntity';

// `draft` is the parent's shared reactive wrapper around the live template;
// every edit here mutates it IN PLACE (the draft is shared by reference — never
// clone). `activeScope` is the scope whose widget list the canvas edits, and
// `activePage` picks WHICH of that component's pages — `null` for its default
// grid.
const props = defineProps<{
  draft: { template: AdminLayerTemplate | null };
  activeScope: AdminScope;
  activePage?: string | null;
  readOnly?: boolean;
}>();
const emit = defineEmits<{ (e: 'update:activePage', v: string | null): void }>();

/** Context for running an expression from this canvas. The widget grid only
 *  renders for the three entity scopes, so anything else leaves the run
 *  affordance off rather than guessing. */
const runLayerKey = computed(() => props.draft.template?.key ?? '');
const runScope = computed<MqeSiteScope | undefined>(() =>
  props.activeScope === 'service' || props.activeScope === 'instance' || props.activeScope === 'endpoint'
    ? props.activeScope
    : undefined,
);

const { t } = useI18n();

function scopeLabel(s: AdminScope): string {
  return scopeLabelOf(props.draft.template, s);
}

// Which page of the active scope the canvas edits — `null` is the
// component's DEFAULT grid. Storage lives in `useExtPages`, so every
// mutation below is page-aware without knowing which kind of page it is.
const extPages = useExtPages(
  computed(() => props.draft.template),
  computed(() => props.activeScope as string),
  computed({ get: () => props.activePage ?? null, set: (v) => emit('update:activePage', v) }),
);

function widgetsFor(scope: AdminScope): DashboardWidget[] {
  return extPages.readWidgets(scope, props.activePage ?? null);
}

function setWidgetsFor(scope: AdminScope, widgets: DashboardWidget[]): void {
  extPages.writeWidgets(scope, props.activePage ?? null, widgets);
}

/** Every widget id in the draft — all scopes + tab children. Ids are the wire
 *  key results are addressed by, so generators below scan this to avoid the
 *  collisions a count-based id hits after a delete + re-add. */
function allWidgetIds(): Set<string> {
  const ids = new Set<string>();
  for (const ws of extPages.allWidgetLists()) collectWidgetIds(ws, ids);
  return ids;
}
/** Widget ids are minted against the WHOLE draft, not the list being appended
 *  to, so a widget moved between scopes or tabs can never collide with one it
 *  left behind. */
function nextWidgetId(prefix: string): string {
  return nextFreeId(prefix, allWidgetIds());
}

function addWidget(type: DashboardWidget['type'] = 'card'): void {
  if (props.readOnly) return;
  const widgets = [...widgetsFor(props.activeScope)];
  const idx = widgets.length;
  const id = nextWidgetId('widget_');
  if (type === 'tab') {
    // A tab container carries no MQE; it seeds one empty named tab. Wider/taller
    // default slot since it hosts a sub-grid of widgets.
    widgets.push({
      id, title: `Widget ${idx + 1}`, type, expressions: [], span: 6, rowSpan: 4,
      tabs: [{ name: 'Tab 1', widgets: [] }],
    });
  } else {
    widgets.push({ id, title: `Widget ${idx + 1}`, type, expressions: [''], span: 4, rowSpan: 1 });
  }
  setWidgetsFor(props.activeScope, widgets);
}

function deleteWidget(i: number): void {
  if (props.readOnly) return;
  const widgets = [...widgetsFor(props.activeScope)];
  widgets.splice(i, 1);
  setWidgetsFor(props.activeScope, widgets);
}

function moveWidget(i: number, dir: -1 | 1): void {
  if (props.readOnly) return;
  const widgets = [...widgetsFor(props.activeScope)];
  const j = i + dir;
  if (j < 0 || j >= widgets.length) return;
  [widgets[i], widgets[j]] = [widgets[j], widgets[i]];
  setWidgetsFor(props.activeScope, widgets);
}

/* ------------------------------------------------------------------- *
 * Canvas state — selection + drag.
 *
 * `selectedIdx` is the index of the widget whose config is shown in the
 * right drawer. `resize` / `reorder` are short-lived mutually-exclusive
 * drag sessions: only one is active at a time, both are torn down on
 * window mouseup. We track them at the script level (not on the widget
 * objects) so a re-renderable drag preview can ride along without
 * mutating the saved template until commit.
 * ------------------------------------------------------------------- */

const selectedIdx = ref<number | null>(null);
/* ----------------------------------------------------------------------- *
 * Tab widgets edit INLINE. A `tab` widget holds named tabs, each with its own
 * widgets; the canvas tile renders a segmented bar + the active tab's widgets
 * as editable sub-tiles in place. Selecting a sub-tile (`subSel`) opens it in
 * the same drawer as a top-level widget (`selectedIdx`). No drilling / separate
 * canvas — the tab's slot IS its layout area.
 * ----------------------------------------------------------------------- */
/** Which tab is shown inline per `tab` widget (by widget id; default first). */
const activeTabByWidget = ref<Record<string, number>>({});
function activeTabOf(id: string): number {
  return activeTabByWidget.value[id] ?? 0;
}
/** Selection of a widget INSIDE a tab panel — vs `selectedIdx` for a top-level
 *  widget. Exactly one of the two is set; both null = nothing selected. */
const subSel = ref<{ widgetId: string; tabIdx: number; subIdx: number } | null>(null);
function setActiveTabOf(id: string, ti: number): void {
  activeTabByWidget.value = { ...activeTabByWidget.value, [id]: ti };
  if (subSel.value?.widgetId === id) subSel.value = null;
}
/* Re-fit the drawer to the viewport when the selection (top-level or in-tab)
 * changes; the scroll + resize listeners keep it fitted after. */
watch([selectedIdx, subSel], () => void nextTick(positionDrawer));

/** When the user switches scope or layer we drop the selection so the drawer
 *  doesn't refer to a widget that no longer exists. A layer switch / import /
 *  reset replaces `draft.template` (a fresh object), so watching its reference
 *  reproduces the parent's old `[activeScope, selectedKey]` reset trigger. */
watch([() => props.activeScope, () => props.activePage, () => props.draft.template], () => {
  selectedIdx.value = null;
  subSel.value = null;
  // A different scope/layer has its own tab widgets; a stale per-id active-tab
  // index could point past the new scope's tab count.
  activeTabByWidget.value = {};
});

/** Resolve a `tab` widget by id within the active scope. */
function tabWidgetById(id: string): DashboardWidget | null {
  return widgetsFor(props.activeScope).find((w) => w.id === id && w.type === 'tab') ?? null;
}
/** Widgets of a tab widget's panel `tabIdx`. */
function subWidgetsOf(id: string, tabIdx: number): DashboardWidget[] {
  return tabWidgetById(id)?.tabs?.[tabIdx]?.widgets ?? [];
}
/** Write a tab panel's widget list back to the draft (preserving the others). */
function commitSubWidgets(id: string, tabIdx: number, widgets: DashboardWidget[]): void {
  if (props.readOnly) return;
  const scope = [...widgetsFor(props.activeScope)];
  const i = scope.findIndex((w) => w.id === id && w.type === 'tab');
  const tw = i >= 0 ? scope[i] : null;
  if (tw?.tabs && tw.tabs[tabIdx]) {
    const tabs = [...tw.tabs];
    tabs[tabIdx] = { ...tabs[tabIdx], widgets };
    scope[i] = { ...tw, tabs };
    setWidgetsFor(props.activeScope, scope);
  }
}
/** Select a widget inside a tab panel (opens its config in the drawer). */
function selectSub(widgetId: string, tabIdx: number, subIdx: number): void {
  selectedIdx.value = null;
  subSel.value = { widgetId, tabIdx, subIdx };
}
/** Add a leaf widget into a tab's active panel. */
function addToTab(widgetId: string, type: DashboardWidget['type']): void {
  if (props.readOnly) return;
  const ti = activeTabOf(widgetId);
  const widgets = [...subWidgetsOf(widgetId, ti)];
  const n = widgets.length + 1;
  widgets.push({ id: nextWidgetId(`${widgetId}_t${ti}_w`), title: `Widget ${n}`, type, expressions: [''], span: 6, rowSpan: 2 });
  commitSubWidgets(widgetId, ti, widgets);
  subSel.value = { widgetId, tabIdx: ti, subIdx: widgets.length - 1 };
}

// Declared above the canvas composables that consume it: a `const` used
// before its declaration is a TDZ ReferenceError that aborts setup and
// leaves the page blank with no trace.
const currentWidgets = computed(() => widgetsFor(props.activeScope));

const { canvasEl, resize, onResizeStart: startResize, onSubResizeStart: startSubResize } = useCanvasResize({
  currentWidgets,
  setWidgets: (widgets) => setWidgetsFor(props.activeScope, widgets),
  subWidgetsOf,
  commitSubWidgets,
  selectedIdx,
  selectSub,
});

const {
  reorder,
  onReorderStart: startReorder,
  onSubReorderStart: startSubReorder,
  onCanvasDrop,
  onReorderOver,
  onReorderDrop,
  onReorderEnd,
} = useCanvasReorder({
  currentWidgets,
  readWidgets: () => widgetsFor(props.activeScope),
  setWidgets: (widgets) => setWidgetsFor(props.activeScope, widgets),
  selectedIdx,
  subSel,
  selectSub,
  activeTabOf,
});

/* A read-only viewer still reads the canvas, but opens no drag session: the
 * move / drop handlers below all early-return unless one is active. */
function onResizeStart(e: MouseEvent, i: number): void {
  if (props.readOnly) return;
  startResize(e, i);
}
function onSubResizeStart(e: MouseEvent, widgetId: string, tabIdx: number, subIdx: number): void {
  if (props.readOnly) return;
  startSubResize(e, widgetId, tabIdx, subIdx);
}
function onReorderStart(e: DragEvent, i: number): void {
  if (props.readOnly) return;
  startReorder(e, i);
}
function onSubReorderStart(e: DragEvent, widgetId: string, tabIdx: number, subIdx: number): void {
  if (props.readOnly) return;
  startSubReorder(e, widgetId, tabIdx, subIdx);
}

/** Convenience: the currently-selected widget — a top-level widget
 *  (`selectedIdx`) OR a widget inside a tab panel (`subSel`). Used by the
 *  drawer; the same form edits either with no indirection. */
const selectedWidget = computed<DashboardWidget | null>(() => {
  if (subSel.value) {
    return subWidgetsOf(subSel.value.widgetId, subSel.value.tabIdx)[subSel.value.subIdx] ?? null;
  }
  if (selectedIdx.value === null) return null;
  return widgetsFor(props.activeScope)[selectedIdx.value] ?? null;
});

function selectWidget(i: number): void {
  subSel.value = null;
  selectedIdx.value = i;
}

const editingWidget = computed<DashboardWidget | null>(() => selectedWidget.value);

/** Move-up / move-down bounds for the drawer footer — handles a top-level
 *  widget (`selectedIdx`) or a widget inside a tab panel (`subSel`). */
const selCanMoveUp = computed<boolean>(() =>
  subSel.value ? subSel.value.subIdx > 0 : (selectedIdx.value !== null && selectedIdx.value > 0),
);
const selCanMoveDown = computed<boolean>(() => {
  if (subSel.value) {
    return subSel.value.subIdx < subWidgetsOf(subSel.value.widgetId, subSel.value.tabIdx).length - 1;
  }
  return selectedIdx.value !== null && selectedIdx.value < currentWidgets.value.length - 1;
});

/** Type changes seed a `tab` widget's first (empty) named panel + clear its
 *  own (meaningless) expressions, and restore an expression slot when leaving
 *  `tab`. A tab can't nest a tab — the `tab` type option is hidden while a
 *  widget inside a tab (`subSel`) is selected. */
function onWidgetTypeChange(value: string): void {
  if (props.readOnly) return;
  const w = selectedWidget.value;
  if (!w) return;
  w.type = value as DashboardWidget['type'];
  if (w.type === 'tab') {
    if (!w.tabs || w.tabs.length === 0) w.tabs = [{ name: 'Tab 1', widgets: [] }];
    w.expressions = [];
  } else {
    if (!w.expressions || w.expressions.length === 0) w.expressions = [''];
    // Leaving 'tab' — drop the now-orphaned panels (a non-tab widget must never
    // carry `tabs`, or flattenTabWidgets would still expand them) and forget its
    // inline active-tab index.
    if (w.tabs) {
      w.tabs = undefined;
      if (w.id in activeTabByWidget.value) {
        const next = { ...activeTabByWidget.value };
        delete next[w.id];
        activeTabByWidget.value = next;
      }
    }
  }
}

/* ---- Tab-panel management (by tab widget id). Each tab is a { name, widgets[] }
 *      panel; these run from the inline segmented tab bar on the canvas tile. ---- */
function tabWidgetMut(widgetId: string): { tw: DashboardWidget; tabs: DashboardTab[] } | null {
  const tw = tabWidgetById(widgetId);
  if (!tw) return null;
  return { tw, tabs: [...(tw.tabs ?? [])] };
}
function addTabToWidget(widgetId: string): void {
  if (props.readOnly) return;
  const m = tabWidgetMut(widgetId);
  if (!m) return;
  m.tabs.push({ name: `Tab ${m.tabs.length + 1}`, widgets: [] });
  m.tw.tabs = m.tabs;
  setActiveTabOf(widgetId, m.tabs.length - 1);
}
function renameTabOf(widgetId: string, ti: number, name: string): void {
  if (props.readOnly) return;
  const m = tabWidgetMut(widgetId);
  if (!m || !m.tabs[ti]) return;
  m.tabs[ti] = { ...m.tabs[ti], name };
  m.tw.tabs = m.tabs;
}
function deleteTabOf(widgetId: string, ti: number): void {
  if (props.readOnly) return;
  const m = tabWidgetMut(widgetId);
  if (!m) return;
  m.tabs.splice(ti, 1);
  m.tw.tabs = m.tabs;
  if (subSel.value?.widgetId === widgetId) subSel.value = null;
  // Keep the active panel pointing at the SAME tab: deleting one before it
  // shifts every later index down by one; deleting at/after only needs a clamp.
  const active = activeTabOf(widgetId);
  if (ti < active) setActiveTabOf(widgetId, active - 1);
  else if (active >= m.tabs.length) setActiveTabOf(widgetId, Math.max(0, m.tabs.length - 1));
}
function moveTabOf(widgetId: string, ti: number, dir: -1 | 1): void {
  if (props.readOnly) return;
  const m = tabWidgetMut(widgetId);
  if (!m) return;
  const tj = ti + dir;
  if (tj < 0 || tj >= m.tabs.length) return;
  [m.tabs[ti], m.tabs[tj]] = [m.tabs[tj], m.tabs[ti]];
  m.tw.tabs = m.tabs;
  const a = activeTabOf(widgetId);
  if (a === ti) setActiveTabOf(widgetId, tj);
  else if (a === tj) setActiveTabOf(widgetId, ti);
}

function setWidgetFormat(v: string): void {
  if (props.readOnly) return;
  const w = editingWidget.value;
  if (!w) return;
  if (v === 'int' || v === 'decimal' || v === 'compact' || v === 'duration' || v === 'enum') w.format = v;
  else delete w.format;
}

function setWidgetTraceDrill(v: string): void {
  if (props.readOnly) return;
  const w = editingWidget.value;
  if (!w) return;
  if (v === 'latency' || v === 'error' || v === 'off') w.traceDrill = { mode: v };
  else delete w.traceDrill;
}
const layerTracesEnabled = computed<boolean>(() => {
  const tpl = props.draft.template;
  if (!tpl?.components?.traces) return false;
  const src = tpl.traces?.source ?? 'native';
  return src === 'native' || src === 'both';
});

// `format: 'enum'` value→label editor — the valueMap is a coded-value → label
// table (e.g. 1 → OK). Keys are renamed on blur to avoid focus loss mid-edit.
const valueMapEntries = computed<Array<[string, string]>>(() => {
  const w = editingWidget.value;
  return w?.valueMap ? Object.entries(w.valueMap) : [];
});
function setValueMapLabel(key: string, label: string): void {
  if (props.readOnly) return;
  const w = editingWidget.value;
  if (!w) return;
  if (!w.valueMap) w.valueMap = {};
  w.valueMap[key] = label;
}
function setValueMapKey(oldKey: string, newKey: string): void {
  if (props.readOnly) return;
  const w = editingWidget.value;
  if (!w || !w.valueMap || newKey === oldKey || newKey in w.valueMap) return;
  const label = w.valueMap[oldKey];
  delete w.valueMap[oldKey];
  w.valueMap[newKey] = label;
  if (w.valueColors && oldKey in w.valueColors) {
    w.valueColors[newKey] = w.valueColors[oldKey];
    delete w.valueColors[oldKey];
  }
}
function addValueMapRow(): void {
  if (props.readOnly) return;
  const w = editingWidget.value;
  if (!w) return;
  if (!w.valueMap) w.valueMap = {};
  let k = 0;
  while (String(k) in w.valueMap) k++;
  w.valueMap[String(k)] = '';
}
function removeValueMapRow(key: string): void {
  if (props.readOnly) return;
  const w = editingWidget.value;
  if (!w || !w.valueMap) return;
  delete w.valueMap[key];
  if (Object.keys(w.valueMap).length === 0) delete w.valueMap;
  if (w.valueColors) {
    delete w.valueColors[key];
    if (Object.keys(w.valueColors).length === 0) delete w.valueColors;
  }
}

// Optional color per valueMap key → `valueColors`, turning the enum card into
// colored status chips (one per matched value/label). Empty = no chip color.
const CHIP_COLORS = ['', 'ok', 'warn', 'err', 'info', 'neutral'] as const;
function valueColorFor(key: string): string {
  return editingWidget.value?.valueColors?.[key] ?? '';
}
function setValueColor(key: string, color: string): void {
  if (props.readOnly) return;
  const w = editingWidget.value;
  if (!w) return;
  if (!color) {
    if (w.valueColors) {
      delete w.valueColors[key];
      if (Object.keys(w.valueColors).length === 0) delete w.valueColors;
    }
    return;
  }
  if (!w.valueColors) w.valueColors = {};
  w.valueColors[key] = color;
}

/** Drawer commits edits in place on the live draft via v-model — no
 *  separate apply step. The button row offers a delete shortcut. Works on a
 *  top-level widget or a widget inside a tab panel. */
function deleteSelected(): void {
  if (props.readOnly) return;
  if (subSel.value) {
    const { widgetId, tabIdx, subIdx } = subSel.value;
    const ws = [...subWidgetsOf(widgetId, tabIdx)];
    ws.splice(subIdx, 1);
    commitSubWidgets(widgetId, tabIdx, ws);
    subSel.value = null;
    return;
  }
  if (selectedIdx.value === null) return;
  deleteWidget(selectedIdx.value);
  selectedIdx.value = null;
}
function moveSelected(dir: -1 | 1): void {
  if (props.readOnly) return;
  if (subSel.value) {
    const { widgetId, tabIdx, subIdx } = subSel.value;
    const ws = [...subWidgetsOf(widgetId, tabIdx)];
    const j = subIdx + dir;
    if (j < 0 || j >= ws.length) return;
    [ws[subIdx], ws[j]] = [ws[j], ws[subIdx]];
    commitSubWidgets(widgetId, tabIdx, ws);
    subSel.value = { widgetId, tabIdx, subIdx: j };
    return;
  }
  if (selectedIdx.value === null) return;
  const i = selectedIdx.value;
  moveWidget(i, dir);
  const j = i + dir;
  if (j >= 0 && j < currentWidgets.value.length) selectedIdx.value = j;
}

/** When a new widget is added, immediately select it so the drawer
 *  opens with empty fields ready for input. */
async function addAndSelectWidget(type: DashboardWidget['type'] = 'card'): Promise<void> {
  if (props.readOnly) return;
  addWidget(type);
  await nextTick();
  selectedIdx.value = currentWidgets.value.length - 1;
  await nextTick();
  /* The new widget is appended at the canvas bottom — on a tall board it lands
   * below the fold. Scroll it into view so the operator sees the widget next to
   * the editor that just opened, instead of an empty drawer over off-screen
   * canvas. block:'center' keeps the editor header + footer in frame too. */
  canvasEl.value
    ?.querySelector('.canvas-widget.selected')
    ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

/** The five leaf widget kinds offered by the "+ Add widget" picker. The `tab`
 *  group is a container offered separately (first, above a divider). */
const WIDGET_KINDS = computed<ReadonlyArray<{ type: DashboardWidget['type']; label: string; hint: string }>>(() => [
  { type: 'card', label: t('Card'), hint: t('A single scalar number') },
  { type: 'line', label: t('Line'), hint: t('A time-series chart') },
  { type: 'top', label: t('Top list'), hint: t('A sorted top-N list') },
  { type: 'record', label: t('Record'), hint: t('Tabular records (slow SQL, statements)') },
  { type: 'table', label: t('Table'), hint: t('A labeled key → value table') },
]);
const addMenuOpen = ref(false);
function pickAddKind(type: DashboardWidget['type']): void {
  addMenuOpen.value = false;
  void addAndSelectWidget(type);
}

/* ------------------------------------------------------------------- *
 * Per-expression rows. Each MQE expression carries its own label / unit
 * / y-axis on one row, so the three used to be index-aligned by line
 * number across separate textareas — now they're edited together and
 * can't drift. Label / unit / axis arrays are kept padded to the
 * expression count so index i always lines up.
 * ------------------------------------------------------------------- */
/** Label + unit only matter for tab-switching `top` widgets and
 *  multi-series `line` widgets; a single-expression card/line hides
 *  them to keep the row compact. */
const showExprMeta = computed(() => {
  const w = editingWidget.value;
  return !!w && (w.type === 'top' || (w.expressions?.length ?? 0) > 1);
});
function padTo<T>(arr: T[] | undefined, len: number, fill: T): T[] {
  const a = [...(arr ?? [])];
  while (a.length < len) a.push(fill);
  return a;
}
function updateExpr(i: number, v: string): void {
  if (props.readOnly) return;
  const w = editingWidget.value;
  if (!w) return;
  const a = [...w.expressions];
  a[i] = v;
  w.expressions = a;
}
function updateExprLabel(i: number, v: string): void {
  if (props.readOnly) return;
  const w = editingWidget.value;
  if (!w) return;
  const a = padTo(w.expressionLabels, w.expressions.length, '');
  a[i] = v;
  w.expressionLabels = a;
}
function updateExprUnit(i: number, v: string): void {
  if (props.readOnly) return;
  const w = editingWidget.value;
  if (!w) return;
  const a = padTo(w.expressionUnits, w.expressions.length, '');
  a[i] = v;
  w.expressionUnits = a;
}
function updateExprAxis(i: number, v: number): void {
  if (props.readOnly) return;
  const w = editingWidget.value;
  if (!w) return;
  const a = padTo(w.expressionAxes, w.expressions.length, 0);
  a[i] = v === 1 ? 1 : 0;
  w.expressionAxes = a;
}
function addExpr(): void {
  if (props.readOnly) return;
  const w = editingWidget.value;
  if (!w) return;
  w.expressions = [...w.expressions, ''];
}
function removeExpr(i: number): void {
  if (props.readOnly) return;
  const w = editingWidget.value;
  if (!w || w.expressions.length <= 1) return;
  const drop = <T>(arr: T[] | undefined): T[] | undefined =>
    arr ? arr.filter((_, j) => j !== i) : arr;
  w.expressions = w.expressions.filter((_, j) => j !== i);
  w.expressionLabels = drop(w.expressionLabels);
  w.expressionUnits = drop(w.expressionUnits);
  w.expressionAxes = drop(w.expressionAxes);
}


/**
 * Structured `visibleWhen` editor. The gate is one of:
 *   - none   — always visible
 *   - mqe    — exists / > / < over an MQE expression's result
 *   - entity — exists / equals against the selected instance's attributes
 * The five computeds below bridge the discriminated-union shape to flat
 * v-model bindings; switching kind / op rebuilds the object so its fields
 * always match (e.g. `exists` carries no `value`).
 */
type VwKind = 'none' | 'mqe' | 'entity';

function visibleWhenHint(scope: AdminScope): string {
  const base =
    t('Hide this widget unless the gate passes.') + '\n' +
    t('MQE — has value: the expression returns any value; > / <: any value above / below the threshold.') + '\n' +
    t("A gate naming one of the widget's own expressions self-gates (free); a different metric gates the whole group (probed once, skips the group when empty).");
  const entity =
    scope === 'instance'
      ? '\n' + t('Entity — matches the selected instance’s attributes (e.g. language equals JAVA). exists = present & non-empty; equals is case-insensitive.')
      : '\n' + t('Entity gates apply only on the Instance scope (Service / Endpoint entities carry no attributes) and are ignored elsewhere.');
  return base + entity;
}

const vwKindModel = computed<VwKind>({
  get() {
    const vw = editingWidget.value?.visibleWhen;
    if (!vw) return 'none';
    return vw.kind === 'entity' ? 'entity' : 'mqe';
  },
  set(k) {
    const w = editingWidget.value;
    if (!w || props.readOnly) return;
    if (k === 'none') w.visibleWhen = undefined;
    else if (k === 'mqe') w.visibleWhen = { kind: 'mqe', expression: w.expressions?.[0] ?? '', op: 'exists' };
    else w.visibleWhen = { kind: 'entity', attribute: 'language', op: 'eq', value: 'JAVA' };
  },
});
const vwTarget = computed<string>({
  get() {
    const vw = editingWidget.value?.visibleWhen;
    if (!vw) return '';
    return vw.kind === 'mqe' ? vw.expression : vw.attribute;
  },
  set(v) {
    const vw = editingWidget.value?.visibleWhen;
    if (!vw || props.readOnly) return;
    if (vw.kind === 'mqe') vw.expression = v;
    else vw.attribute = v;
  },
});
const vwOp = computed<string>({
  get() {
    return editingWidget.value?.visibleWhen?.op ?? 'exists';
  },
  set(op) {
    const w = editingWidget.value;
    const vw = w?.visibleWhen;
    if (!w || !vw || props.readOnly) return;
    if (vw.kind === 'mqe') {
      w.visibleWhen =
        op === 'exists'
          ? { kind: 'mqe', expression: vw.expression, op: 'exists' }
          : { kind: 'mqe', expression: vw.expression, op: op === 'lt' ? 'lt' : 'gt', value: 'value' in vw ? vw.value : 0 };
    } else {
      w.visibleWhen =
        op === 'eq'
          ? { kind: 'entity', attribute: vw.attribute, op: 'eq', value: 'value' in vw ? String(vw.value) : '' }
          : { kind: 'entity', attribute: vw.attribute, op: 'exists' };
    }
  },
});
const vwNeedsValue = computed(() => {
  const op = editingWidget.value?.visibleWhen?.op;
  return op === 'gt' || op === 'lt' || op === 'eq';
});
const vwValue = computed<string>({
  get() {
    const vw = editingWidget.value?.visibleWhen;
    return vw && 'value' in vw ? String(vw.value) : '';
  },
  set(v) {
    const vw = editingWidget.value?.visibleWhen;
    if (!vw || !('value' in vw) || props.readOnly) return;
    if (vw.kind === 'mqe') vw.value = Number(v) || 0;
    else vw.value = v;
  },
});

// Editor drawer position. The drawer edits the selected widget. A sticky
// drawer gets clipped once you scroll past the bottom of the tall widget canvas
// (its containing block), so a bottom-row widget opens with the editor's top
// off-screen. Pin it to the viewport with `position: fixed` instead, overlaying
// the grid column the layout already reserves for it — so it's always fully
// visible IN PLACE wherever you click in the canvas, without scrolling the page.
// JS owns top/left/width/height because the column's x-position tracks the
// canvas width (re-measured on layout change), while the y-extent is the
// viewport below the topbar.
const drawerEl = ref<HTMLElement | null>(null);
const editorCardEl = ref<HTMLElement | null>(null);
function positionDrawer(): void {
  const el = drawerEl.value;
  const card = editorCardEl.value;
  const split = el?.closest('.editor-split') as HTMLElement | null;
  const main = document.querySelector('.sw-main');
  if (!el || !card || !split || !main) return;
  // Hide the floating drawer when the editor card is scrolled out of view, so it
  // doesn't float over the scope-config cards above it.
  const cr = card.getBoundingClientRect();
  if (cr.bottom < 80 || cr.top > window.innerHeight) {
    el.style.display = 'none';
    return;
  }
  el.style.display = 'flex';
  // The canvas shrinks to reserve a 360px column on the right (so widget
  // proportions read at their real size); the drawer overlays that column,
  // pinned BELOW the sticky header so it doesn't cover + Add widget.
  const headEl = card.querySelector('.card-head') as HTMLElement | null;
  const mainTop = Math.round(main.getBoundingClientRect().top);
  const top = Math.max(0, headEl ? Math.round(headEl.getBoundingClientRect().bottom) : mainTop, mainTop);
  el.style.top = `${top}px`;
  el.style.right = 'auto';
  el.style.left = `${Math.round(split.getBoundingClientRect().right - DRAWER_COL)}px`;
  el.style.width = `${DRAWER_COL}px`;
  el.style.height = `${window.innerHeight - top}px`;
}
// Re-place the drawer when the editor card resizes (window resize, sidebar
// collapse, scope switch) — its right column moves with the canvas width.
let drawerLayoutObs: ResizeObserver | null = null;
watch(editorCardEl, (el) => {
  drawerLayoutObs?.disconnect();
  drawerLayoutObs = null;
  if (el && typeof ResizeObserver !== 'undefined') {
    drawerLayoutObs = new ResizeObserver(() => positionDrawer());
    drawerLayoutObs.observe(el);
  }
});
onMounted(() => {
  window.addEventListener('resize', positionDrawer, { passive: true });
  // Scroll only toggles the drawer's visibility (its x/width are fixed); capture
  // so the inner content pane's scroll fires it too.
  window.addEventListener('scroll', positionDrawer, { capture: true, passive: true });
});
onBeforeUnmount(() => {
  window.removeEventListener('resize', positionDrawer);
  window.removeEventListener('scroll', positionDrawer, { capture: true });
  drawerLayoutObs?.disconnect();
  drawerLayoutObs = null;
});
</script>

<template>
  <section ref="editorCardEl" class="sw-card editor-card">
    <!-- Sticky header: pins to the top while the canvas scrolls, so
         + Add widget stays reachable. -->
    <div class="card-head sticky-head">
      <h4>{{ t('{scope} widgets', { scope: scopeLabel(activeScope) }) }}</h4>
      <span class="sub">
        {{ t('click a widget to edit · drag corner to resize · drag header to reorder') }}
      </span>
      <div class="add-widget-wrap">
        <button
          class="sw-btn add"
          type="button"
          :aria-expanded="addMenuOpen"
          :disabled="readOnly"
          @click="addMenuOpen = !addMenuOpen"
        >{{ t('＋ Add widget ▾') }}</button>
        <div v-if="addMenuOpen" class="add-menu-backdrop" @click="addMenuOpen = false" />
        <div v-if="addMenuOpen" class="add-menu" role="menu">
          <button type="button" class="add-menu-item" role="menuitem" @click="pickAddKind('tab')">
            <span class="ami-type t-tab">tab</span>
            <span class="ami-text">
              <span class="ami-label">{{ t('Tab group') }}</span>
              <span class="ami-hint">{{ t('Several widgets in one slot, as tabs') }}</span>
            </span>
          </button>
          <div class="add-menu-div" />
          <button
            v-for="k in WIDGET_KINDS"
            :key="k.type"
            type="button"
            class="add-menu-item"
            role="menuitem"
            @click="pickAddKind(k.type)"
          >
            <span class="ami-type" :class="`t-${k.type}`">{{ k.type }}</span>
            <span class="ami-text">
              <span class="ami-label">{{ k.label }}</span>
              <span class="ami-hint">{{ k.hint }}</span>
            </span>
          </button>
        </div>
      </div>
    </div>

    <div class="editor-split" :class="{ 'has-drawer': !!selectedWidget }">
      <div
        ref="canvasEl"
        class="canvas"
        :class="{ resizing: resize.active }"
        @dragover.prevent
        @drop="onCanvasDrop"
      >
        <div v-if="currentWidgets.length === 0" class="canvas-empty">
          {{ t('No widgets yet. Click "+ Add widget" or drag here later — the canvas renders widgets as a 12-col grid with mock previews.') }}
        </div>
        <div
          v-for="(w, i) in currentWidgets"
          :key="`${w.id}-${i}`"
          class="canvas-widget"
          :data-drop-hint="t('drop to add as a tab')"
          :class="{
            selected: selectedIdx === i,
            'is-tab': w.type === 'tab',
            dragging: reorder.active && reorder.from === i,
            'drop-target': reorder.active && reorder.over === i && reorder.from !== i && !(!reorder.sub && w.type === 'tab' && currentWidgets[reorder.from]?.type !== 'tab'),
            'drop-into-tab': reorder.active && !reorder.sub && reorder.over === i && reorder.from !== i && w.type === 'tab' && currentWidgets[reorder.from]?.type !== 'tab',
          }"
          :style="widgetGridStyle(w)"
          @click="selectWidget(i)"
          @dragover.prevent="onReorderOver($event, i)"
          @drop="onReorderDrop($event, i)"
        >
          <header
            class="cw-head"
            :draggable="!readOnly && w.type !== 'tab'"
            @dragstart="w.type !== 'tab' && onReorderStart($event, i)"
            @dragend="onReorderEnd"
          >
            <span
              class="cw-grip"
              :draggable="!readOnly && w.type === 'tab' ? true : undefined"
              aria-hidden="true"
              @dragstart="w.type === 'tab' && onReorderStart($event, i)"
              @dragend="onReorderEnd"
            >
              <svg viewBox="0 0 10 14" width="6" height="10">
                <circle cx="2" cy="2" r="1" fill="currentColor"/>
                <circle cx="8" cy="2" r="1" fill="currentColor"/>
                <circle cx="2" cy="7" r="1" fill="currentColor"/>
                <circle cx="8" cy="7" r="1" fill="currentColor"/>
                <circle cx="2" cy="12" r="1" fill="currentColor"/>
                <circle cx="8" cy="12" r="1" fill="currentColor"/>
              </svg>
            </span>
            <!-- Tab widget: the tab bar IS the header — tabs + the type chip
                 sit in the head row, with the boundary line under them. -->
            <div v-if="w.type === 'tab'" class="cw-segbar" @click.stop @mousedown.stop>
              <div class="seg">
                <button
                  v-for="(tab, ti) in w.tabs ?? []"
                  :key="ti"
                  type="button"
                  class="seg-pill"
                  :class="{ on: ti === activeTabOf(w.id) }"
                  @click.stop="setActiveTabOf(w.id, ti)"
                >{{ tab.name || t('Tab {n}', { n: ti + 1 }) }} <span class="seg-n">{{ tab.widgets.length }}</span></button>
              </div>
              <button v-if="!readOnly" type="button" class="seg-add" :title="t('Add a tab')" @click.stop="addTabToWidget(w.id)">{{ t('+ tab') }}</button>
            </div>
            <h5 v-else>{{ w.title || w.id || t('untitled') }}</h5>
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
            <template v-else-if="(w.type === 'record' || w.type === 'table') && w.expressions.length > 0">
              <!-- Record / table preview — mock name → value rows. The
                   real record renderer surfaces trace / segment id
                   columns; the canvas shows the name + value only. -->
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
            <template v-else-if="w.type === 'tab'">
              <!-- Inline tab editing: the segmented bar lives in the header;
                   here we render the active panel's widgets, edited in place
                   (click to select → drawer). -->
              <div class="cw-subgrid" @click.stop>
                <div
                  v-for="(sw, j) in subWidgetsOf(w.id, activeTabOf(w.id))"
                  :key="`${sw.id}-${j}`"
                  class="canvas-widget sub"
                  :class="{ selected: subSel && subSel.widgetId === w.id && subSel.tabIdx === activeTabOf(w.id) && subSel.subIdx === j }"
                  :style="widgetGridStyle(sw)"
                  @click.stop="selectSub(w.id, activeTabOf(w.id), j)"
                >
                  <header
                    class="cw-head sub-head"
                    :draggable="!readOnly"
                    :title="t('Drag out of the tab to move to the top level')"
                    @dragstart.stop="onSubReorderStart($event, w.id, activeTabOf(w.id), j)"
                    @dragend="onReorderEnd"
                  >
                    <h5>{{ sw.title || sw.id || t('untitled') }}</h5>
                    <span class="cw-type" :class="`t-${sw.type}`">{{ sw.type }}</span>
                  </header>
                  <div class="cw-body sub-body">
                    <template v-if="sw.type === 'card'">
                      <div class="cw-card-value"><span class="num">{{ fmtMetric(mockCardValue(sw)) }}</span><span v-if="sw.unit" class="unit">{{ sw.unit }}</span></div>
                    </template>
                    <template v-else-if="sw.type === 'line' && sw.expressions.length > 0">
                      <TimeChart :series="mockLineSeries(sw)" :unit="sw.unit" :height="Math.max(48, widgetRowSpan(sw) * 100 - 44)" />
                    </template>
                    <template v-else-if="sw.type === 'top' && sw.expressions.length > 0">
                      <TopList :groups="mockTopGroups(sw, Math.max(3, widgetRowSpan(sw) * 3))" :unit="sw.unit" />
                    </template>
                    <p v-else class="cw-empty">{{ sw.expressions.length ? sw.type : t('add an MQE in the drawer') }}</p>
                  </div>
                  <span v-if="!readOnly" class="cw-resize" :title="t('Drag to resize')" @mousedown.stop="onSubResizeStart($event, w.id, activeTabOf(w.id), j)">
                    <svg viewBox="0 0 12 12" width="12" height="12" fill="currentColor">
                      <circle cx="3" cy="9" r="0.8"/><circle cx="6" cy="9" r="0.8"/><circle cx="9" cy="9" r="0.8"/>
                      <circle cx="6" cy="6" r="0.8"/><circle cx="9" cy="6" r="0.8"/><circle cx="9" cy="3" r="0.8"/>
                    </svg>
                  </span>
                </div>
                <button v-if="!readOnly" type="button" class="cw-subadd" :title="t('Add a widget to this tab')" @click.stop="addToTab(w.id, 'card')">{{ t('＋ widget') }}</button>
              </div>
            </template>
            <p v-else class="cw-empty">
              {{ t('Add an MQE expression in the drawer to preview.') }}
            </p>
          </div>
          <!-- Resize handle: 12×12 dotted glyph in the bottom-
               right corner. Mouse-down captures the drag and
               updates span/rowSpan as the cursor moves. -->
          <span
            v-if="!readOnly"
            class="cw-resize"
            :title="t('Drag to resize')"
            @mousedown="onResizeStart($event, i)"
          >
            <svg viewBox="0 0 12 12" width="12" height="12" fill="currentColor">
              <circle cx="3" cy="9" r="0.8"/>
              <circle cx="6" cy="9" r="0.8"/>
              <circle cx="9" cy="9" r="0.8"/>
              <circle cx="6" cy="6" r="0.8"/>
              <circle cx="9" cy="6" r="0.8"/>
              <circle cx="9" cy="3" r="0.8"/>
            </svg>
          </span>
          <span v-if="selectedIdx === i" class="cw-size-badge">
            {{ widgetSpan(w) }} × {{ widgetRowSpan(w) }}
          </span>
        </div>
      </div>

      <aside v-if="selectedWidget" ref="drawerEl" class="drawer">
        <div class="drawer-head">
          <h4>{{ t('Edit widget') }}</h4>
          <span class="sub">{{ scopeLabel(activeScope) }}<template v-if="subSel">{{ ' ' + t('· in tab') }}</template><template v-if="selectedWidget.type === 'tab'">{{ ' ' + t('· tab group') }}</template></span>
          <button class="sw-btn ghost close" type="button" :title="t('Close')" @click="selectedIdx = null; subSel = null">✕</button>
        </div>
        <div class="drawer-body">
          <div class="d-row">
            <label :class="{ grow: selectedWidget.type === 'tab' }">
              <span>{{ t('id') }}</span>
              <input class="mono" v-model="selectedWidget.id" :disabled="readOnly" />
            </label>
            <!-- A tab group has no title of its own — the tabs are the labels. -->
            <label v-if="selectedWidget.type !== 'tab'" class="grow">
              <span>{{ t('Title') }}</span>
              <input v-model="selectedWidget.title" :disabled="readOnly" />
            </label>
          </div>
          <div v-if="selectedWidget.type !== 'tab'" class="d-row">
            <label class="grow">
              <span>{{ t('Tip (hover hint)') }}</span>
              <input v-model="selectedWidget.tip" placeholder="—" :disabled="readOnly" />
            </label>
          </div>
          <div class="d-row">
            <label>
              <span>{{ t('Type') }}</span>
              <select :value="selectedWidget.type" :disabled="readOnly" @change="onWidgetTypeChange(($event.target as HTMLSelectElement).value)">
                <option value="card">card</option>
                <option value="line">line</option>
                <option value="top">top</option>
                <option value="record">record</option>
                <option value="table">table</option>
                <!-- A tab can't nest a tab — not offered for a widget inside a tab. -->
                <option v-if="!subSel" value="tab">tab</option>
              </select>
            </label>
            <template v-if="selectedWidget.type !== 'tab'">
              <label>
                <span>{{ t('Unit') }}</span>
                <input v-model="selectedWidget.unit" placeholder="—" :disabled="readOnly" />
              </label>
              <label>
                <span>{{ t('Format') }}</span>
                <select :value="selectedWidget.format ?? ''" :disabled="readOnly" @change="setWidgetFormat(($event.target as HTMLSelectElement).value)">
                  <option value="">{{ t('auto') }}</option>
                  <option value="int">int</option>
                  <option value="decimal">decimal</option>
                  <option value="compact">compact</option>
                  <option value="duration">duration</option>
                  <option v-if="selectedWidget.type === 'card'" value="enum">enum</option>
                </select>
              </label>
            </template>
            <label>
              <span>{{ t('Span') }}</span>
              <input type="number" min="1" max="12" v-model.number="selectedWidget.span" :disabled="readOnly" />
            </label>
            <label>
              <span>{{ t('Row span') }}</span>
              <input type="number" min="1" max="8" v-model.number="selectedWidget.rowSpan" :disabled="readOnly" />
            </label>
          </div>

          <!-- TAB widget: manage its named panels. Switching / editing each
               panel's widgets happens inline on the canvas tile. -->
          <template v-if="selectedWidget.type === 'tab'">
            <div class="d-section">
              <span class="d-label">{{ t('Tabs') }}</span>
              <div class="tab-mgr">
                <div v-for="(tab, ti) in selectedWidget.tabs ?? []" :key="ti" class="tab-mgr-row">
                  <input
                    class="tm-name"
                    :value="tab.name"
                    :placeholder="t('Tab name')"
                    :disabled="readOnly"
                    @input="renameTabOf(selectedWidget.id, ti, ($event.target as HTMLInputElement).value)"
                  />
                  <span class="tm-count">{{ t('{n}w', { n: tab.widgets.length }) }}</span>
                  <button type="button" class="tm-ctl" :title="t('Show on canvas')" @click="setActiveTabOf(selectedWidget.id, ti)">{{ t('show') }}</button>
                  <button type="button" class="tm-ctl" :disabled="readOnly" :title="t('Move up')" @click="moveTabOf(selectedWidget.id, ti, -1)">↑</button>
                  <button type="button" class="tm-ctl" :disabled="readOnly" :title="t('Move down')" @click="moveTabOf(selectedWidget.id, ti, 1)">↓</button>
                  <button type="button" class="tm-ctl del" :disabled="readOnly" :title="t('Delete tab')" @click="deleteTabOf(selectedWidget.id, ti)">×</button>
                </div>
              </div>
              <button type="button" class="sw-btn ghost small" :disabled="readOnly" @click="addTabToWidget(selectedWidget.id)">{{ t('+ tab') }}</button>
              <p class="d-hint">{{ t('Each tab holds its own widgets — switch tabs and add / edit their widgets right on the canvas tile. Only the active tab is queried at runtime.') }}</p>
            </div>
          </template>

          <template v-else>
            <template v-if="editingWidget">
              <div v-if="editingWidget.format === 'enum'" class="d-section">
                <span class="d-label">{{ t('Value map (enum → label, color)') }}</span>
                <div class="vm-rows">
                  <div v-for="(row, i) in valueMapEntries" :key="i" class="vm-row">
                    <input
                      class="mono vm-key"
                      :value="row[0]"
                      :disabled="readOnly"
                      @change="setValueMapKey(row[0], ($event.target as HTMLInputElement).value)"
                      placeholder="0"
                    />
                    <span class="vm-arrow">→</span>
                    <input
                      class="vm-label"
                      :value="row[1]"
                      :disabled="readOnly"
                      @input="setValueMapLabel(row[0], ($event.target as HTMLInputElement).value)"
                      :placeholder="t('Failed')"
                    />
                    <select
                      class="vm-color"
                      :value="valueColorFor(row[0])"
                      :title="t('Chip color')"
                      :disabled="readOnly"
                      @change="setValueColor(row[0], ($event.target as HTMLSelectElement).value)"
                    >
                      <option v-for="c in CHIP_COLORS" :key="c" :value="c">{{ c || '—' }}</option>
                    </select>
                    <button type="button" class="expr-del" :disabled="readOnly" :title="t('Remove')" @click="removeValueMapRow(row[0])">×</button>
                  </div>
                </div>
                <button type="button" class="sw-btn ghost small" :disabled="readOnly" @click="addValueMapRow">{{ t('+ value') }}</button>
                <p class="d-hint">{{ t('Map a coded value — or a metric label such as a K8s node condition — to a label and an optional chip color') }} (<code>ok</code> {{ t('green') }} / <code>warn</code> {{ t('amber') }} / <code>err</code> {{ t('red') }} / <code>info</code> {{ t('blue') }} / <code>neutral</code> {{ t('grey') }}). {{ t('With a color set, the card renders colored status chips, one per matched value. Card widgets only; labels are translatable per locale.') }}</p>
              </div>
              <div class="d-section">
                <span class="d-label">{{ t('MQE expressions') }}</span>
                <div v-if="showExprMeta" class="expr-cols">
                  <span class="expr-col-mqe">{{ t('expression') }}</span>
                  <span class="expr-col-label">{{ editingWidget.type === 'top' ? t('tab label') : t('series label') }}</span>
                  <span class="expr-col-unit">{{ t('unit') }}</span>
                  <span v-if="editingWidget.type === 'line'" class="expr-col-axis">{{ t('axis') }}</span>
                  <span class="expr-col-del"></span>
                </div>
                <div class="expr-rows">
                  <div v-for="(expr, i) in editingWidget.expressions" :key="i" class="expr-row">
                    <MqeExpressionInput
                      class="expr-mqe"
                      :model-value="expr"
                      placeholder="instance_jvm_cpu"
                      :title="t('Expression {n}', { n: i + 1 })"
                      :layer-key="runLayerKey"
                      :site-scope="runScope"
                      :readonly="readOnly"
                      @update:model-value="updateExpr(i, $event)"
                    />
                    <input
                      v-if="showExprMeta"
                      class="expr-label"
                      :value="editingWidget.expressionLabels?.[i] ?? ''"
                      :disabled="readOnly"
                      @input="updateExprLabel(i, ($event.target as HTMLInputElement).value)"
                      :placeholder="editingWidget.type === 'top' ? t('Traffic') : 'p99'"
                    />
                    <input
                      v-if="showExprMeta"
                      class="mono expr-unit"
                      :value="editingWidget.expressionUnits?.[i] ?? ''"
                      :disabled="readOnly"
                      @input="updateExprUnit(i, ($event.target as HTMLInputElement).value)"
                      :placeholder="editingWidget.unit || 'ms'"
                    />
                    <select
                      v-if="showExprMeta && editingWidget.type === 'line'"
                      class="mono expr-axis"
                      :value="String(editingWidget.expressionAxes?.[i] ?? 0)"
                      :disabled="readOnly"
                      @change="updateExprAxis(i, Number(($event.target as HTMLSelectElement).value))"
                      :title="t('Y-axis (Left / Right) — for dual-axis line widgets')"
                    >
                      <option value="0">L</option>
                      <option value="1">R</option>
                    </select>
                    <button
                      type="button"
                      class="expr-del"
                      :title="t('Remove expression')"
                      :disabled="readOnly || editingWidget.expressions.length <= 1"
                      @click="removeExpr(i)"
                    >×</button>
                  </div>
                </div>
                <button type="button" class="sw-btn ghost small expr-add" :disabled="readOnly" @click="addExpr">{{ t('+ expression') }}</button>
                <p class="d-hint">
                  {{ t('For') }} <code>top</code> {{ t('widgets each expression is a switchable tab; for') }}
                  <code>line</code> {{ t('each is a series. Label / unit / axis apply per expression.') }}
                </p>
              </div>
              <div v-if="editingWidget.type === 'line'" class="d-section">
                <span class="d-label">{{ t('Trace drill') }}</span>
                <div class="d-row">
                  <label>
                    <span>{{ t('Mode') }}</span>
                    <select
                      :value="editingWidget.traceDrill?.mode ?? ''"
                      :disabled="readOnly || !layerTracesEnabled"
                      @change="setWidgetTraceDrill(($event.target as HTMLSelectElement).value)"
                    >
                      <option value="">{{ t('none') }}</option>
                      <option value="latency">{{ t('latency → slow traces') }}</option>
                      <option value="error">{{ t('error → error traces') }}</option>
                    </select>
                  </label>
                </div>
                <p v-if="!layerTracesEnabled" class="d-hint drill-off">
                  {{ t("Disabled — metric→trace drill needs this layer's") }} <b>{{ t('Traces') }}</b> {{ t("component on in native mode; the Zipkin trace view can't consume the drill filter.") }}
                </p>
                <p v-else class="d-hint">
                  {{ t('Click a datapoint on this widget to open the pre-filtered Traces tab.') }} <code>latency</code> {{ t('⇒ slowest traces ≥ the clicked value;') }} <code>error</code> {{ t('⇒ error-status traces. Centered on the clicked time bucket.') }}
                </p>
              </div>
              <div class="d-section">
                <span class="d-label" :title="visibleWhenHint(activeScope)">
                  {{ t('Visible when (optional)') }}
                </span>
                <div class="vw-row">
                  <select class="mono" v-model="vwKindModel" :disabled="readOnly">
                    <option value="none">{{ t('Always visible') }}</option>
                    <option value="mqe">{{ t('MQE metric…') }}</option>
                    <option value="entity">{{ t('Entity attribute…') }}</option>
                  </select>
                  <template v-if="vwKindModel === 'mqe'">
                    <MqeExpressionInput
                      class="vw-target"
                      v-model="vwTarget"
                      placeholder="instance_jvm_cpu"
                      :title="t('Gate expression')"
                      :layer-key="runLayerKey"
                      :site-scope="runScope"
                      :readonly="readOnly"
                    />
                    <select class="mono" v-model="vwOp" :disabled="readOnly">
                      <option value="exists">{{ t('has value') }}</option>
                      <option value="gt">&gt;</option>
                      <option value="lt">&lt;</option>
                    </select>
                  </template>
                  <template v-else-if="vwKindModel === 'entity'">
                    <input class="mono vw-target" v-model="vwTarget" placeholder="language" :disabled="readOnly" />
                    <select class="mono" v-model="vwOp" :disabled="readOnly">
                      <option value="exists">{{ t('exists') }}</option>
                      <option value="eq">{{ t('equals') }}</option>
                    </select>
                  </template>
                  <input
                    v-if="vwNeedsValue"
                    class="mono vw-val"
                    v-model="vwValue"
                    :type="vwKindModel === 'mqe' ? 'number' : 'text'"
                    :placeholder="vwKindModel === 'entity' ? 'JAVA' : '0'"
                    :disabled="readOnly"
                  />
                </div>
                <p v-if="vwKindModel === 'mqe' && !vwTarget.trim()" class="d-hint" style="color: var(--sw-warn)">
                  {{ t('Set a metric expression — an empty gate is ignored and the widget always shows.') }}
                </p>
                <p class="d-hint" style="white-space: pre-line">{{ visibleWhenHint(activeScope) }}</p>
              </div>
            </template>
          </template>
        </div>
        <!-- Pinned footer: move/delete stay visible no matter how long
             the form scrolls (the body above owns the overflow). -->
        <div class="drawer-foot">
          <div class="d-actions">
            <button
              class="sw-btn"
              type="button"
              :disabled="readOnly || !selCanMoveUp"
              :title="t('Move up')"
              @click="moveSelected(-1)"
            >{{ t('↑ Up') }}</button>
            <button
              class="sw-btn"
              type="button"
              :disabled="readOnly || !selCanMoveDown"
              :title="t('Move down')"
              @click="moveSelected(1)"
            >{{ t('↓ Down') }}</button>
            <button
              class="sw-btn danger"
              type="button"
              :disabled="readOnly"
              :title="t('Delete widget')"
              @click="deleteSelected"
            >{{ t('✕ Delete') }}</button>
          </div>
        </div>
      </aside>
    </div>
  </section>
</template>

<style scoped>
/* editor chrome (duplicated scoped; .sw-card / .sw-btn are global) */
.editor-card { padding: 0; overflow: visible; }
.editor-card .card-head.sticky-head {
  position: sticky;
  top: 0;
  z-index: 6;
  background: var(--sw-bg-1);
}
.card-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--sw-line);
}
.card-head h4 {
  margin: 0;
  font-size: 12px;
  font-weight: 600;
  color: var(--sw-fg-0);
  text-transform: capitalize;
}
.card-head .sub {
  font-size: 10.5px;
  color: var(--sw-fg-3);
}
.card-head .add {
  margin-left: auto;
  font-size: 11.5px;
  background: var(--sw-accent-soft);
  color: var(--sw-accent-2);
  border-color: var(--sw-accent-line);
}
.sw-btn.danger {
  border-color: rgba(239, 68, 68, 0.3);
  color: #f87171;
}
.sw-btn.danger:hover {
  background: var(--sw-err-soft);
}

/* Editor split: canvas (left, flex 1) + drawer (right, 360px when
 * a widget is selected). When nothing is selected, the canvas takes
 * the full width so the operator sees the layout as it would render. */
.editor-split {
  display: grid;
  grid-template-columns: 1fr;
  gap: 0;
  min-height: 480px;
}
/* When a widget is selected the canvas shrinks to reserve the drawer column,
 * so widgets render at their true proportions next to the editor. */
.editor-split.has-drawer {
  grid-template-columns: 1fr 360px;
}

/* Canvas — 12-col grid with dotted-line background to evoke the
 * underlying layout. Cell pitch matches the runtime dashboard
 * (120px rows, 8px gap). */
.canvas {
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
  min-height: 480px;
}
.canvas.resizing {
  cursor: nwse-resize;
  user-select: none;
}
.canvas-empty {
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

/* Widget tile — clickable card with title, type chip, preview, and
 * resize handle. Selected state mirrors the design draft: orange
 * outline + soft glow. */
.canvas-widget {
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
.canvas-widget:hover {
  border-color: var(--sw-line-2);
}
.canvas-widget.selected {
  border-color: var(--sw-accent);
  box-shadow: 0 0 0 4px rgba(249, 115, 22, 0.18);
}
.canvas-widget.dragging {
  opacity: 0.35;
}
.canvas-widget.drop-target {
  border-color: var(--sw-accent-line);
  box-shadow: inset 0 0 0 1px var(--sw-accent-line);
}
/* Dropping a leaf widget onto a tab container moves it IN as a tab — a
 * distinct green target so the gesture reads differently from a reorder. */
.canvas-widget.drop-into-tab {
  border-color: #34d399;
  box-shadow: inset 0 0 0 2px #34d399, 0 0 0 4px rgba(52, 211, 153, 0.18);
}
.canvas-widget.drop-into-tab::after {
  content: attr(data-drop-hint);
  position: absolute;
  inset: auto 0 0 0;
  text-align: center;
  font-size: 10px;
  font-weight: 600;
  color: #34d399;
  background: rgba(52, 211, 153, 0.12);
  padding: 2px 0;
  pointer-events: none;
}
/* Tab container tile (editor): a real frame so its extent is clear and the
 * resize handle is grabbable; the tab bar sits in the header with an underline,
 * and the bordered body below is the tab's internal content area. */
.canvas-widget.is-tab {
  background: var(--sw-bg-1);
  border: 1px solid var(--sw-line);
  border-radius: 7px;
  overflow: hidden;
}
.canvas-widget.is-tab:hover { border-color: var(--sw-line-2); }
.canvas-widget.is-tab.selected {
  border-color: var(--sw-accent);
  box-shadow: 0 0 0 3px rgba(249, 115, 22, 0.18);
}
/* The tab bar IS the header. Its bottom rule is the ONLY frame — the line under
 * the tab names. The grip (drag handle), tabs, and the `tab` chip share the row. */
.canvas-widget.is-tab > .cw-head {
  background: transparent;
  border-left: none;
  border-bottom: 1px solid var(--sw-line);
  align-items: stretch;
  gap: 4px;
  padding: 0 6px 0 4px;
  cursor: default;
}
.canvas-widget.is-tab > .cw-head .cw-grip { align-self: center; cursor: grab; }
.canvas-widget.is-tab > .cw-head .cw-type { align-self: center; }
/* Internal content area — a slightly inset panel so the tab's own widgets read
 * as a group distinct from the surrounding canvas. */
.canvas-widget.is-tab > .cw-body {
  padding: 8px;
  background: var(--sw-bg-0);
}
.cw-segbar {
  display: flex;
  align-items: stretch;
  gap: 2px;
  flex: 1;
  min-width: 0;
  overflow-x: auto;
}
.cw-segbar .seg {
  display: inline-flex;
  gap: 2px;
  flex-wrap: nowrap;
}
.seg-pill {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  border: none;
  border-bottom: 2px solid transparent;
  margin-bottom: -1px;
  background: transparent;
  color: var(--sw-fg-2);
  cursor: pointer;
  font-family: inherit;
  font-size: 13.5px;
  font-weight: 600;
  padding: 8px 14px;
  white-space: nowrap;
}
.seg-pill:hover { color: var(--sw-fg-0); }
.seg-pill.on {
  color: var(--sw-fg-0);
  background: var(--sw-accent-soft);
  border-bottom-color: var(--sw-accent);
  border-radius: 6px 6px 0 0;
}
.seg-pill .seg-n {
  font-size: 9px;
  font-weight: 500;
  color: var(--sw-fg-3);
  background: var(--sw-bg-3);
  border-radius: 6px;
  padding: 0 4px;
}
.seg-add {
  border: none;
  background: transparent;
  color: var(--sw-fg-3);
  cursor: pointer;
  font-family: inherit;
  font-size: 11px;
  padding: 5px 9px;
  margin-left: 2px;
}
.seg-add:hover { color: var(--sw-accent); }
/* The active tab's widgets — a 12-col sub-grid of editable tiles, full width. */
.cw-subgrid {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: repeat(12, 1fr);
  grid-auto-rows: 84px;
  gap: 6px;
  padding: 0 0 8px;
  align-content: start;
}
.canvas-widget.sub {
  min-height: 0;
  background: var(--sw-bg-1);
  border-radius: 5px;
}
.canvas-widget.sub.selected {
  border-color: var(--sw-accent);
  box-shadow: 0 0 0 3px rgba(249, 115, 22, 0.18);
}
.canvas-widget.sub .sub-head {
  cursor: pointer;
  padding: 3px 8px;
}
.canvas-widget.sub .sub-head h5 { font-size: 10px; }
.canvas-widget.sub .sub-body { padding: 4px 8px; }
.cw-subadd {
  grid-column: span 3;
  border: 1.5px dashed var(--sw-line-2);
  border-radius: 5px;
  background: transparent;
  color: var(--sw-fg-3);
  cursor: pointer;
  font: inherit;
  font-size: 11px;
  display: grid;
  place-items: center;
  min-height: 60px;
}
.cw-subadd:hover { border-color: var(--sw-accent); color: var(--sw-accent); }
.cw-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px 6px 6px;
  border-bottom: 1px solid var(--sw-line);
  background: var(--sw-bg-2);
  cursor: grab;
  user-select: none;
}
.cw-head:active { cursor: grabbing; }
.cw-head h5 {
  margin: 0;
  flex: 1;
  font-size: 11px;
  font-weight: 600;
  color: var(--sw-fg-0);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.cw-grip {
  display: inline-grid;
  place-items: center;
  width: 14px;
  height: 14px;
  color: var(--sw-fg-3);
  flex: 0 0 14px;
}
.cw-type {
  font-size: 9.5px;
  font-family: var(--sw-mono);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  padding: 1px 5px;
  border-radius: 3px;
  background: var(--sw-bg-3);
  color: var(--sw-fg-2);
}
.cw-type.t-line   { color: #60a5fa; background: rgba(96, 165, 250, 0.12); }
.cw-type.t-top    { color: #a78bfa; background: rgba(167, 139, 250, 0.12); }
.cw-type.t-card   { color: var(--sw-accent-2); background: var(--sw-accent-soft); }
.cw-type.t-record { color: #22d3ee; background: rgba(34, 211, 238, 0.12); }
.cw-type.t-tab    { color: #34d399; background: rgba(52, 211, 153, 0.12); }
/* Tabs manager in the drawer (rename / reorder / delete / open each panel). */
.tab-mgr {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 4px;
}
.tab-mgr-row {
  display: flex;
  align-items: center;
  gap: 4px;
}
.tab-mgr-row .tm-name {
  flex: 1;
  min-width: 0;
}
.tab-mgr-row .tm-count {
  font-size: 10px;
  color: var(--sw-fg-3);
  white-space: nowrap;
}
.tab-mgr-row .tm-ctl {
  border: 1px solid var(--sw-line);
  background: var(--sw-bg-1);
  color: var(--sw-fg-2);
  cursor: pointer;
  font-size: 11px;
  line-height: 1;
  padding: 2px 5px;
  border-radius: 3px;
}
.tab-mgr-row .tm-ctl:hover { border-color: var(--sw-line-2); color: var(--sw-fg-0); }
.tab-mgr-row .tm-ctl.del:hover { color: var(--sw-err); border-color: var(--sw-err); }
/* Rich "+ Add widget" picker. */
.add-widget-wrap {
  position: relative;
}
.add-menu-backdrop {
  position: fixed;
  inset: 0;
  z-index: 30;
}
.add-menu {
  position: absolute;
  top: calc(100% + 4px);
  right: 0;
  z-index: 31;
  min-width: 230px;
  background: var(--sw-bg-1);
  border: 1px solid var(--sw-line-2);
  border-radius: 6px;
  box-shadow: 0 8px 24px -8px rgba(0, 0, 0, 0.6);
  padding: 4px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.add-menu-div {
  height: 1px;
  background: var(--sw-line);
  margin: 3px 6px;
}
.add-menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--sw-fg-1);
  cursor: pointer;
  text-align: left;
  font: inherit;
}
.add-menu-item:hover {
  background: var(--sw-bg-2);
}
.add-menu-item .ami-type {
  flex: 0 0 auto;
  font-size: 9.5px;
  font-family: var(--sw-mono);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  padding: 1px 5px;
  border-radius: 3px;
  background: var(--sw-bg-3);
  color: var(--sw-fg-2);
  min-width: 46px;
  text-align: center;
}
.add-menu-item .ami-type.t-line   { color: #60a5fa; background: rgba(96, 165, 250, 0.12); }
.add-menu-item .ami-type.t-top    { color: #a78bfa; background: rgba(167, 139, 250, 0.12); }
.add-menu-item .ami-type.t-card   { color: var(--sw-accent-2); background: var(--sw-accent-soft); }
.add-menu-item .ami-type.t-record { color: #22d3ee; background: rgba(34, 211, 238, 0.12); }
.add-menu-item .ami-type.t-table  { color: #f59e0b; background: rgba(245, 158, 11, 0.12); }
.add-menu-item .ami-type.t-tab    { color: #34d399; background: rgba(52, 211, 153, 0.12); }
.add-menu-item .ami-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.add-menu-item .ami-label {
  font-size: 11.5px;
  font-weight: 600;
  color: var(--sw-fg-0);
}
.add-menu-item .ami-hint {
  font-size: 10px;
  color: var(--sw-fg-3);
}
.cw-body {
  flex: 1;
  min-height: 0;
  padding: 6px 8px 12px;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}
.cw-empty {
  margin: auto;
  font-size: 10.5px;
  color: var(--sw-fg-3);
  text-align: center;
  padding: 8px 12px;
}
.cw-card-value {
  flex: 1;
  display: grid;
  place-items: center;
  gap: 4px;
  padding: 8px;
}
.cw-card-value .num {
  font-family: var(--sw-mono);
  font-size: 28px;
  font-weight: 700;
  color: var(--sw-fg-0);
  font-variant-numeric: tabular-nums;
}
.cw-card-value .unit {
  font-size: 11px;
  color: var(--sw-fg-3);
}
.cw-records {
  list-style: none;
  margin: 0;
  padding: 0;
  overflow-y: auto;
  flex: 1;
  min-height: 0;
}
.cw-record-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 3px 4px;
  border-bottom: 1px dashed var(--sw-line);
}
.cw-record-row:last-child { border-bottom: none; }
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
.cw-resize {
  position: absolute;
  right: 2px;
  bottom: 2px;
  width: 16px;
  height: 16px;
  display: inline-grid;
  place-items: end;
  padding: 2px;
  color: var(--sw-fg-3);
  cursor: nwse-resize;
  border-radius: 3px;
  z-index: 2;
}
.cw-resize:hover { color: var(--sw-accent); background: rgba(249, 115, 22, 0.08); }
.cw-size-badge {
  position: absolute;
  top: 6px;
  right: 26px;
  font-family: var(--sw-mono);
  font-size: 9.5px;
  padding: 1px 6px;
  background: var(--sw-accent);
  color: #0a0d12;
  border-radius: 3px;
  font-weight: 700;
  letter-spacing: 0.04em;
  pointer-events: none;
}

/* Right-side drawer — config fields. Sticky inside the card so it
 * stays in view as the operator scrolls through long expression
 * lists. */
.drawer {
  display: flex;
  flex-direction: column;
  background: var(--sw-bg-1);
  /* Butts flush UNDER the sticky header (positionDrawer starts it at the
   * header's bottom) and carries borders on every edge so the header + drawer
   * read as one connected editor surface, not two floating pieces. */
  border: 1px solid var(--sw-line);
  border-top: none;
  /* Pinned to the viewport (positionDrawer sets top/left/width/height) so the
   * editor is always fully visible IN PLACE wherever you click in the canvas,
   * overlaying the reserved grid column — a sticky drawer clips past the bottom
   * of the tall canvas. The values below are a pre-JS fallback, refined on the
   * next tick. */
  position: fixed;
  z-index: 5;
  top: 44px;
  right: 28px;
  width: 360px;
  height: calc(100vh - 44px);
  box-shadow: -8px 0 24px -12px rgba(0, 0, 0, 0.5);
}
.drawer-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--sw-line);
}
.drawer-head h4 {
  margin: 0;
  font-size: 12px;
  font-weight: 600;
  color: var(--sw-fg-0);
}
.drawer-head .sub {
  font-size: 10.5px;
  color: var(--sw-fg-3);
  text-transform: capitalize;
}
.drawer-head .close {
  margin-left: auto;
  width: 24px;
  height: 24px;
  padding: 0;
  display: inline-grid;
  place-items: center;
  font-size: 12px;
}
.drawer-body {
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  overflow-y: auto;
  flex: 1 1 auto;
  min-height: 0;
}
.d-row {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.d-row label {
  display: flex;
  flex-direction: column;
  gap: 3px;
  font-size: 10.5px;
  color: var(--sw-fg-3);
  flex: 0 1 auto;
}
.d-row label.grow { flex: 1 1 100%; min-width: 0; }
.d-row input,
.d-row select {
  height: 26px;
  padding: 0 8px;
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line-2);
  border-radius: 4px;
  color: var(--sw-fg-0);
  font: inherit;
  font-size: 11.5px;
  min-width: 0;
}
.d-row input.mono {
  font-family: var(--sw-mono);
  font-size: 11px;
}
.d-row input:focus,
.d-row select:focus {
  outline: none;
  border-color: var(--sw-accent-line);
}
.d-section {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.d-label {
  font-size: 10.5px;
  color: var(--sw-fg-3);
}
.d-section input,
.d-section textarea {
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line-2);
  border-radius: 4px;
  color: var(--sw-fg-0);
  font: inherit;
  font-size: 11.5px;
  padding: 6px 8px;
}
.d-section input { height: 26px; padding: 0 8px; }
.d-section textarea { resize: vertical; }
.d-section input.mono,
.d-section textarea.mono {
  font-family: var(--sw-mono);
  font-size: 11px;
}
.d-section input:focus,
.d-section textarea:focus {
  outline: none;
  border-color: var(--sw-accent-line);
}
.d-section select {
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line-2);
  border-radius: 4px;
  color: var(--sw-fg-0);
  font: inherit;
  font-size: 11px;
  height: 26px;
  padding: 0 6px;
}
.d-section select.mono { font-family: var(--sw-mono); }
.d-section select:focus { outline: none; border-color: var(--sw-accent-line); }
.vw-row {
  display: flex;
  gap: 6px;
  align-items: center;
  flex-wrap: wrap;
}
.vw-row .vw-target { flex: 1 1 140px; min-width: 90px; }
.vw-row .vw-val { flex: 1 1 120px; min-width: 96px; }
.vw-row select { flex: 0 0 auto; }
.vm-rows { display: flex; flex-direction: column; gap: 6px; margin-bottom: 6px; }
.vm-row { display: flex; align-items: center; gap: 6px; }
.vm-row .vm-key { width: 64px; flex: 0 0 auto; }
.vm-row .vm-arrow { color: var(--sw-fg-3); }
.vm-row .vm-label { flex: 1 1 auto; min-width: 0; }
.vm-row .vm-color { width: 84px; flex: 0 0 auto; }
.expr-rows { display: flex; flex-direction: column; gap: 4px; }
.expr-row { display: flex; gap: 6px; align-items: center; }
.expr-row .expr-mqe { flex: 1 1 auto; min-width: 0; }
.expr-row .expr-label { flex: 0 0 84px; width: 84px; }
.expr-row .expr-unit { flex: 0 0 52px; width: 52px; }
.expr-row .expr-axis { flex: 0 0 46px; width: 46px; padding: 0 4px; }
.expr-del {
  flex: 0 0 auto;
  width: 24px;
  height: 26px;
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line-2);
  border-radius: 4px;
  color: var(--sw-fg-3);
  cursor: pointer;
  font-size: 14px;
  line-height: 1;
}
.expr-del:hover:not([disabled]) { color: var(--sw-err); border-color: var(--sw-err); }
.expr-del[disabled] { opacity: 0.35; cursor: default; }
.expr-cols {
  display: flex;
  gap: 6px;
  margin-bottom: 1px;
  font-size: 9.5px;
  color: var(--sw-fg-3);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.expr-cols .expr-col-mqe { flex: 1 1 auto; }
.expr-cols .expr-col-label { flex: 0 0 84px; }
.expr-cols .expr-col-unit { flex: 0 0 52px; }
.expr-cols .expr-col-axis { flex: 0 0 46px; }
.expr-cols .expr-col-del { flex: 0 0 24px; }
.expr-add { margin-top: 4px; align-self: flex-start; }
.d-hint {
  font-size: 10px;
  color: var(--sw-fg-3);
  margin: 2px 0 0;
  line-height: 1.4;
}
.d-hint code {
  font-family: var(--sw-mono);
  padding: 0 3px;
  background: var(--sw-bg-2);
  border-radius: 2px;
  color: var(--sw-fg-1);
}
.d-hint.drill-off {
  color: var(--sw-warn);
}
.d-check {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  font-size: 11px;
  color: var(--sw-fg-1);
  cursor: pointer;
  user-select: none;
  line-height: 1.4;
}
.d-check input {
  margin-top: 2px;
  accent-color: var(--sw-accent);
}
.drawer-foot {
  flex-shrink: 0;
  padding: 8px 14px;
  border-top: 1px solid var(--sw-line);
  background: var(--sw-bg-1);
}
.d-actions {
  display: flex;
  gap: 6px;
}
.d-actions .sw-btn { font-size: 11px; }
.d-actions .sw-btn.danger { margin-left: auto; }
.d-actions .sw-btn[disabled] { opacity: 0.35; pointer-events: none; }
</style>
