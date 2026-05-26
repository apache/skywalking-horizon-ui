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
  Admin / Layer dashboards. List every loaded layer template, pick one
  on the left, edit its per-scope widget set on the right. Saves write
  the JSON file back via POST /api/admin/layer-templates/:key so the
  BFF refreshes its in-memory cache.

  Widget editor presents the new span-based fields (12-col flow
  layout): operator picks a column span, optional row span, MQE
  expressions, type, title, unit, and an optional visibility predicate.
  Legacy x/y/w/h are NOT shown — they're kept on the wire for
  back-compat with older JSONs but operators don't edit them.
-->
<script setup lang="ts">
import { computed, reactive, ref, onMounted, onBeforeUnmount, watch, nextTick } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import type { AdminLayerTemplate } from '@/api/client';
import type {
  DashboardScope,
  DashboardWidget,
  EndpointDependencyConfig,
  ProcessTopologyConfig,
  TopologyConfig,
  TopologyMetricDef,
} from '@skywalking-horizon-ui/api-client';

/** Admin-only scope. `networkProfiling` isn't a dashboard-widget scope
 *  (the network-profiling page is the process topology + edge panel, not
 *  a widget grid), so it lives outside `DashboardScope` — but the admin's
 *  scope-tab strip surfaces it as an editable config tab for the
 *  ProcessRelation MQE. */
type AdminScope = DashboardScope | 'networkProfiling';
import { bff, bffClient, BffApiError } from '@/api/client';
import { useLocalTemplateEdits, layerEditName } from '@/controls/localTemplateEdits';
import { useTemplateSources } from '@/features/admin/_shared/useTemplateSources';
import { usePreviewOverride } from '@/controls/previewOverride';
import TimeChart from '@/components/charts/TimeChart.vue';
import TopList from '@/components/charts/TopList.vue';
import Sparkline from '@/components/charts/Sparkline.vue';
import { fmtMetric } from '@/utils/formatters';
import { stableStringify } from '@/utils/stableJson';
import { mockCardValue, mockLineSeries, mockRecordRows, mockTopGroups } from './widget-mock';
import SyncStatusBanner from '@/features/admin/_shared/SyncStatusBanner.vue';
import { refreshConfigBundle } from '@/controls/configBundle';
import TemplateStatusBadge from '@/features/admin/_shared/TemplateStatusBadge.vue';
import { useTemplateSync } from '@/features/admin/_shared/useTemplateSync';
import Modal from '@/features/operate/_shared/Modal.vue';
import MonacoDiff from '@/features/operate/_shared/MonacoDiff.vue';

// OAP UI-template sync status for layer dashboards. Drives the banner +
// Save gating + per-row badge below.
const sync = useTemplateSync({ kind: 'layer' });

const SCOPES: AdminScope[] = [
  'service',
  'instance',
  'endpoint',
  // Topology before dependency — operator order request: service map
  // is the primary canvas; API dependency drills into one endpoint.
  'topology',
  'dependency',
  'trace',
  'logs',
  'traceProfiling',
  'ebpfProfiling',
  'asyncProfiling',
  'networkProfiling',
];
/** Display label for each scope — kebab-cases the profiling scopes
 *  so the scope tab strip reads as "trace profiling" instead of the
 *  camelCase key. */
const SCOPE_LABELS: Record<AdminScope, string> = {
  service: 'service',
  instance: 'instance',
  endpoint: 'endpoint',
  dependency: 'dependency',
  topology: 'topology',
  trace: 'trace',
  logs: 'logs',
  traceProfiling: 'trace profiling',
  ebpfProfiling: 'eBPF profiling',
  asyncProfiling: 'async profiling',
  networkProfiling: 'network profiling',
};

const templates = ref<AdminLayerTemplate[]>([]);
const isLoading = ref(true);
const error = ref<string | null>(null);
const selectedKey = ref<string>('');
const activeScope = ref<AdminScope>('service');
const isSaving = ref(false);
const saveMsg = ref<string | null>(null);

// Picker-bar "refresh from remote" button + post-push 10s countdown
// share this in-flight flag so concurrent clicks can't race.
const refreshingFromRemote = ref(false);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Force OAP re-read: invalidates the BFF's 30s sync cache + refetches
 *  every source the page consults. Bound to the picker-bar button so the
 *  operator can flush stale `synced/diverged` badges without reloading
 *  the SPA. */
async function refreshFromRemote(): Promise<void> {
  if (refreshingFromRemote.value) return;
  refreshingFromRemote.value = true;
  try {
    await bff.templateSync.resync();
    await Promise.all([sources.refetch(), refreshConfigBundle()]);
    reconcileLocalDrafts();
    saveMsg.value = 'Refreshed from OAP.';
    setTimeout(() => (saveMsg.value = null), 4000);
  } catch (err) {
    saveMsg.value = err instanceof Error ? err.message : 'refresh failed';
  } finally {
    refreshingFromRemote.value = false;
  }
}

/** Walk every local-only draft for this kind and remove any whose
 *  content now equals the fresh remote — those are no longer "local-
 *  only" edits, they're already on OAP and the `local` badge would
 *  be misleading. Called after every refresh / push so the badge
 *  state stays honest across sessions and browsers (another operator
 *  may have pushed the same change first, or this operator may have
 *  edited the draft on a different device). */
function reconcileLocalDrafts(): void {
  for (const name of localEdits.names()) {
    if (!name.startsWith('horizon.layer.')) continue;
    const local = localEdits.get(name);
    const remote = sources.remote(name);
    if (
      local !== undefined &&
      remote !== null &&
      stableStringify(local) === stableStringify(remote)
    ) {
      localEdits.remove(name);
    }
  }
}
/** When false the browse rail is hidden entirely and layer switching
 *  moves to the top dropdown inside the editor — the editor claims the
 *  full width. Defaults collapsed; the rail is an opt-in browse mode.
 *  Selecting a layer from the rail re-collapses it (see `selectLayer`). */
const layerListOpen = ref(false);
/** Free-text filter for the layers rail — matches alias or key. */
const layerSearch = ref('');
// When on, the list shows only layers whose bundled copy differs from
// OAP (diverged) or isn't on OAP yet (bundled-fallback) — i.e. the set
// "Sync all to OAP" would push. Off shows every layer.
const divergedOnly = ref(false);
const localOnly = ref(false);
function isDivergedRow(key: string): boolean {
  const s = sync.badgeFor(`horizon.layer.${key}`);
  return s === 'diverged' || s === 'bundled-fallback';
}
const divergedCount = computed(() => templates.value.filter((t) => isDivergedRow(t.key)).length);
const localCount = computed(() => templates.value.filter((t) => localEdits.has(layerEditName(t.key))).length);
const filteredTemplates = computed<AdminLayerTemplate[]>(() => {
  const q = layerSearch.value.trim().toLowerCase();
  return templates.value.filter((t) => {
    if (divergedOnly.value && !isDivergedRow(t.key)) return false;
    if (localOnly.value && !localEdits.has(layerEditName(t.key))) return false;
    if (!q) return true;
    return (t.alias ?? '').toLowerCase().includes(q) || t.key.toLowerCase().includes(q);
  });
});

/** Working copy — reactively edited. Diffs against `templates` to drive
 *  the Save / Reset state. */
const draft = reactive<{ template: AdminLayerTemplate | null }>({ template: null });

// Unpublished edits live in THIS browser (localStorage), not on the BFF
// disk. The editor seeds from the browser draft when one exists, and the
// config bundle overlays it on live pages — see controls/localTemplateEdits.
const localEdits = useLocalTemplateEdits();
// Server-side bundled + remote content for the Reset-to / Preview editor
// sources. Local (browser draft) comes from `localEdits`.
const sources = useTemplateSources('layer');
const previewOverride = usePreviewOverride();

async function loadAll(): Promise<void> {
  isLoading.value = true;
  error.value = null;
  try {
    const res = await bffClient.layerTemplates.list();
    templates.value = res.templates;
    // Hydrate from `?layer=&scope=` first; fall back to the first
    // template only when the URL doesn't pin a layer. This preserves
    // refresh state.
    const queryLayer = String(route.query.layer ?? '').toUpperCase();
    const matchedQuery = res.templates.find((t) => t.key === queryLayer);
    if (matchedQuery) {
      selectedKey.value = matchedQuery.key;
    } else if (res.templates.length > 0 && !selectedKey.value) {
      selectedKey.value = res.templates[0].key;
    }
    const queryScope = String(route.query.scope ?? '');
    if (SCOPES.includes(queryScope as AdminScope)) {
      activeScope.value = queryScope as AdminScope;
    }
    syncDraft();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    isLoading.value = false;
    // Hand control to the URL-sync watcher only after the initial
    // hydrate so it doesn't immediately overwrite the seed query
    // params we just read in.
    nextTick(() => {
      suppressRouteSync = false;
    });
  }
}

// URL ↔ state sync. Pushes `?layer=&scope=` on every selection change
// so refreshing the page (or sharing the URL) keeps the admin focused
// on the same layer + scope. Skipped while initial templates load so
// the boot-up `loadAll()` hydrate doesn't bounce the URL.
const route = useRoute();
const router = useRouter();
let suppressRouteSync = true;
watch(
  [selectedKey, activeScope],
  ([key, scope]) => {
    if (suppressRouteSync) return;
    if (!key) return;
    const q = { ...route.query, layer: key, scope };
    void router.replace({ path: route.path, query: q });
  },
);

/* ── Editor sources ───────────────────────────────────────────────
 * The editor loads from one of three sources: LOCAL (browser draft),
 * BUNDLED (shipped default), or REMOTE (OAP live). `editorSource` tracks
 * which is loaded; `loadedSnapshot` is the content at load/save time and
 * is the baseline for `dirty` (= unsaved edits since the last load/save).
 * Saving always writes LOCAL; you then publish LOCAL → OAP.
 * ─────────────────────────────────────────────────────────────────── */
const editorSource = ref<'local' | 'bundled' | 'remote'>('bundled');
const loadedSnapshot = ref<string>('');
const editName = computed(() => layerEditName(selectedKey.value));
const hasLocalDraft = computed(() => localEdits.has(editName.value));
const remoteAvailable = computed(() => sources.hasRemote(editName.value));
// Ships a bundled default → not deletable (delete would fall back to the
// bundle, so the row reappears). Drives the disabled delete button + the
// guard in deleteCurrentLayer. Effectively true for every shipped layer.
const bundledExists = computed(() => sources.hasBundled(editName.value));
// When the bundled default matches the OAP-live copy ("synced"), the
// BUNDLED and REMOTE views are byte-equal. Surfacing the distinction
// (`from bundled` pill, "Reset to bundled" / "Preview bundled") tells
// the operator nothing — hide it. LOCAL drafts always show; BUNDLED
// resurfaces the moment the layer diverges.
const isSynced = computed<boolean>(() => sync.badgeFor(editName.value) === 'synced');
/** Whether a given layer key has an unpublished local browser draft —
 *  drives the "local" badge in the picker (the sync badge only reflects
 *  bundled-vs-remote, not your local draft). */
function hasLocalDraftFor(key: string): boolean {
  return localEdits.has(layerEditName(key));
}

function bundledContent(): AdminLayerTemplate | undefined {
  return (
    sources.bundled<AdminLayerTemplate>(editName.value) ??
    templates.value.find((t) => t.key === selectedKey.value)
  );
}
function sourceContent(src: 'local' | 'bundled' | 'remote'): AdminLayerTemplate | null | undefined {
  if (src === 'local') return localEdits.get<AdminLayerTemplate>(editName.value);
  if (src === 'remote') return sources.remote<AdminLayerTemplate>(editName.value);
  return bundledContent();
}
function loadFrom(src: 'local' | 'bundled' | 'remote'): void {
  const c = sourceContent(src);
  draft.template = c ? JSON.parse(JSON.stringify(c)) : null;
  loadedSnapshot.value = draft.template ? JSON.stringify(draft.template) : '';
  editorSource.value = src;
  saveMsg.value = null;
}
/** Seed the editor when the selected layer changes: your local draft if
 *  you have one, else the bundled default (always available; "Reset to →
 *  remote" pulls the live version). */
function syncDraft(): void {
  loadFrom(hasLocalDraft.value ? 'local' : 'bundled');
}

/** Write the editor content to the local draft. If it equals remote, the
 *  draft is cleared instead (no point keeping a draft identical to live) —
 *  this is what makes "Reset to remote" + an edit back to remote disable
 *  Push. Drives `hasLocalDraft` / `localDiffersFromRemote` reactively. */
function persistLocal(content: AdminLayerTemplate): void {
  const remote = sources.remote<AdminLayerTemplate>(editName.value);
  if (remote && stableStringify(content) === stableStringify(remote)) {
    localEdits.remove(editName.value);
  } else {
    localEdits.set(editName.value, JSON.parse(JSON.stringify(content)));
  }
  loadedSnapshot.value = JSON.stringify(content);
}

// "Reset to ▾" dropdown — reload the editor from a source AND adopt it as
// the local draft (so the choice persists + Push/diff status updates).
const resetDropdownOpen = ref(false);
function resetTo(src: 'bundled' | 'remote'): void {
  loadFrom(src);
  if (draft.template) persistLocal(draft.template);
  resetDropdownOpen.value = false;
}

/** Rail click: switch layer and collapse the rail so the editor reclaims
 *  the full width (subsequent switching uses the top dropdown). */
function selectLayer(key: string): void {
  selectedKey.value = key;
  layerListOpen.value = false;
}

/** Collapsed-mode switcher dropdown. Reuses the same `layerSearch` +
 *  `filteredTemplates` as the rail so the two browse surfaces filter
 *  identically — no native <select>. */
const layerDropdownOpen = ref(false);
function pickFromDropdown(key: string): void {
  selectedKey.value = key;
  layerDropdownOpen.value = false;
}

/** First per-layer tab segment for the live route, derived from enabled
 *  components (mirrors the sidebar's firstLayerTab fallback order). */
function firstTabFor(tpl: AdminLayerTemplate | null): string {
  const c = tpl?.components ?? {};
  if (c.service) return 'service';
  if (c.instances) return 'instance';
  if (c.endpoints) return 'endpoint';
  if (c.topology) return 'topology';
  if (c.endpointDependency) return 'dependency';
  if (c.traces) return 'trace';
  if (c.logs) return 'logs';
  if (c.traceProfiling) return 'trace-profiling';
  if (c.ebpfProfiling) return 'ebpf-profiling';
  if (c.asyncProfiling) return 'async-profiling';
  return 'service';
}
// "Preview ▾" dropdown — open the REAL layer page in a new tab rendering
// the chosen source (local / bundled / remote). Writes the content to the
// preview-override store so the new tab's overlay renders exactly it
// (?mode=preview also lets LayerShell render layers OAP doesn't list).
const previewDropdownOpen = ref(false);
function previewLive(src: 'local' | 'bundled' | 'remote'): void {
  const content = sourceContent(src);
  if (!content) return;
  previewOverride.set(editName.value, content);
  const href = router.resolve({
    path: `/layer/${selectedKey.value}/${firstTabFor(content)}`,
    query: { mode: 'preview', source: src },
  }).href;
  previewDropdownOpen.value = false;
  window.open(href, '_blank', 'noopener');
}

watch(selectedKey, syncDraft);
onMounted(loadAll);
// Force-refresh the cached config bundle on mount so per-row badges
// (`synced` / `diverged` / `disabled`) reflect actual OAP state. Without
// this, the badges would surface whatever a prior session persisted to
// localStorage. `force: true` also flushes the BFF's 30s OAP sync cache
// so even a fresh fetch sees live OAP state.
onMounted(() => void refreshConfigBundle({ force: true }));

/**
 * Map each DashboardScope to its corresponding `components.*` flag.
 * Used to filter the scope tab strip so admin only surfaces tabs for
 * components the operator has toggled on.
 */
const SCOPE_COMPONENT: Record<AdminScope, ComponentKey> = {
  service: 'service',
  instance: 'instances',
  endpoint: 'endpoints',
  dependency: 'endpointDependency',
  topology: 'topology',
  trace: 'traces',
  logs: 'logs',
  // Profiling scopes: each granular component flag controls one tab.
  // The shared `profiling` flag (legacy) is implied true if any of the
  // three are on — handled by the BFF loader.
  traceProfiling: 'traceProfiling' as ComponentKey,
  ebpfProfiling: 'ebpfProfiling' as ComponentKey,
  asyncProfiling: 'asyncProfiling' as ComponentKey,
  networkProfiling: 'networkProfiling' as ComponentKey,
};
const visibleScopes = computed<AdminScope[]>(() => {
  const tpl = draft.template;
  if (!tpl?.components) return SCOPES;
  return SCOPES.filter((s) => tpl.components[SCOPE_COMPONENT[s]]);
});
watch(visibleScopes, (scopes) => {
  // If the currently-active scope was just toggled off, snap to the
  // first remaining visible scope so the editor stays on solid ground.
  if (!scopes.includes(activeScope.value)) {
    activeScope.value = scopes[0] ?? 'service';
  }
});

// Unsaved keystrokes: editor differs from the content last loaded/saved.
const dirty = computed(() => {
  if (!draft.template) return false;
  return JSON.stringify(draft.template) !== loadedSnapshot.value;
});

function widgetsFor(scope: AdminScope): DashboardWidget[] {
  const tpl = draft.template;
  if (!tpl) return [];
  // Read from `dashboards.<scope>`, falling back to legacy `widgets`
  // for the service scope so the existing JSONs keep their content
  // until we explicitly migrate them.
  const d = (tpl as unknown as { dashboards?: Record<string, DashboardWidget[]> }).dashboards;
  if (d?.[scope]) return d[scope];
  if (scope === 'service' && tpl.widgets) return tpl.widgets;
  return [];
}

function setWidgetsFor(scope: AdminScope, widgets: DashboardWidget[]): void {
  const tpl = draft.template;
  if (!tpl) return;
  const dashboards =
    (tpl as unknown as { dashboards?: Record<string, DashboardWidget[]> }).dashboards ?? {};
  dashboards[scope] = widgets;
  (tpl as unknown as { dashboards?: Record<string, DashboardWidget[]> }).dashboards = dashboards;
  // Drop the legacy `widgets` once we've split — keeps the JSON clean.
  if (scope === 'service' && tpl.widgets) {
    (tpl as unknown as { widgets?: DashboardWidget[] }).widgets = undefined;
  }
}

function addWidget(): void {
  const widgets = [...widgetsFor(activeScope.value)];
  const idx = widgets.length;
  widgets.push({
    id: `widget_${idx + 1}`,
    title: `Widget ${idx + 1}`,
    type: 'card',
    expressions: [''],
    span: 4,
    rowSpan: 1,
  });
  setWidgetsFor(activeScope.value, widgets);
}

function deleteWidget(i: number): void {
  const widgets = [...widgetsFor(activeScope.value)];
  widgets.splice(i, 1);
  setWidgetsFor(activeScope.value, widgets);
}

function moveWidget(i: number, dir: -1 | 1): void {
  const widgets = [...widgetsFor(activeScope.value)];
  const j = i + dir;
  if (j < 0 || j >= widgets.length) return;
  [widgets[i], widgets[j]] = [widgets[j], widgets[i]];
  setWidgetsFor(activeScope.value, widgets);
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

/** When the user switches scope or layer we drop the selection so the
 *  drawer doesn't refer to a widget that no longer exists. */
watch([activeScope, selectedKey], () => {
  selectedIdx.value = null;
});

const canvasEl = ref<HTMLDivElement | null>(null);

/** Active resize session: tracks the starting span/rowSpan + pixel
 *  origin so we can compute the new span from the mouse delta. */
const resize = reactive<{
  active: boolean;
  idx: number;
  startX: number;
  startY: number;
  startSpan: number;
  startRowSpan: number;
  cellW: number;
  cellH: number;
}>({
  active: false,
  idx: -1,
  startX: 0,
  startY: 0,
  startSpan: 1,
  startRowSpan: 1,
  cellW: 1,
  cellH: 1,
});

const CANVAS_COLS = 12;
const CANVAS_ROW_PX = 120;
const CANVAS_GAP_PX = 8;

function widgetSpan(w: DashboardWidget): number {
  return Math.min(CANVAS_COLS, Math.max(1, w.span ?? 4));
}
function widgetRowSpan(w: DashboardWidget): number {
  return Math.max(1, w.rowSpan ?? 2);
}
function widgetGridStyle(w: DashboardWidget): Record<string, string> {
  return {
    gridColumn: `span ${widgetSpan(w)}`,
    gridRow: `span ${widgetRowSpan(w)}`,
  };
}

function onResizeStart(e: MouseEvent, i: number): void {
  e.preventDefault();
  e.stopPropagation();
  const widgets = currentWidgets.value;
  const w = widgets[i];
  if (!w || !canvasEl.value) return;
  const rect = canvasEl.value.getBoundingClientRect();
  // The canvas grid uses 12 equal-width columns with a fixed gap. Column
  // width is therefore (canvasWidth - 11 gaps - 2 padding) / 12. We snap
  // the dragged span based on this cell pitch.
  const cellW = (rect.width - 2 * 12 - CANVAS_GAP_PX * (CANVAS_COLS - 1)) / CANVAS_COLS;
  resize.active = true;
  resize.idx = i;
  resize.startX = e.clientX;
  resize.startY = e.clientY;
  resize.startSpan = widgetSpan(w);
  resize.startRowSpan = widgetRowSpan(w);
  resize.cellW = cellW + CANVAS_GAP_PX;
  resize.cellH = CANVAS_ROW_PX + CANVAS_GAP_PX;
  selectedIdx.value = i;
  window.addEventListener('mousemove', onResizeMove);
  window.addEventListener('mouseup', onResizeEnd);
}
function onResizeMove(e: MouseEvent): void {
  if (!resize.active) return;
  const dx = e.clientX - resize.startX;
  const dy = e.clientY - resize.startY;
  const newSpan = Math.max(1, Math.min(CANVAS_COLS, resize.startSpan + Math.round(dx / resize.cellW)));
  const newRowSpan = Math.max(1, Math.min(8, resize.startRowSpan + Math.round(dy / resize.cellH)));
  const widgets = [...currentWidgets.value];
  const w = widgets[resize.idx];
  if (!w) return;
  if (w.span !== newSpan || w.rowSpan !== newRowSpan) {
    widgets[resize.idx] = { ...w, span: newSpan, rowSpan: newRowSpan };
    setWidgetsFor(activeScope.value, widgets);
  }
}
function onResizeEnd(): void {
  resize.active = false;
  window.removeEventListener('mousemove', onResizeMove);
  window.removeEventListener('mouseup', onResizeEnd);
}

/** Active reorder session: tracks the dragged widget index and the
 *  current hover target. Drop reorders the array — no live mutation
 *  during the drag (the dragged widget keeps its slot but dims, the
 *  hover target gets a leading marker). */
const reorder = reactive<{
  active: boolean;
  from: number;
  over: number;
}>({
  active: false,
  from: -1,
  over: -1,
});

function onReorderStart(e: DragEvent, i: number): void {
  // Only allow drag from the widget's header. The header sets
  // draggable=true; resize handles + drawer inputs do not.
  reorder.active = true;
  reorder.from = i;
  reorder.over = i;
  selectedIdx.value = i;
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(i));
  }
}
function onReorderOver(e: DragEvent, i: number): void {
  if (!reorder.active) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
  if (reorder.over !== i) reorder.over = i;
}
function onReorderDrop(e: DragEvent, i: number): void {
  if (!reorder.active) return;
  e.preventDefault();
  const from = reorder.from;
  const to = i;
  if (from !== to) {
    const widgets = [...currentWidgets.value];
    const [moved] = widgets.splice(from, 1);
    widgets.splice(to, 0, moved);
    setWidgetsFor(activeScope.value, widgets);
    selectedIdx.value = to;
  }
  reorder.active = false;
  reorder.from = -1;
  reorder.over = -1;
}
function onReorderEnd(): void {
  reorder.active = false;
  reorder.from = -1;
  reorder.over = -1;
}

onBeforeUnmount(() => {
  window.removeEventListener('mousemove', onResizeMove);
  window.removeEventListener('mouseup', onResizeEnd);
});

/** Convenience: the currently-selected widget. Used by the drawer. */
const selectedWidget = computed<DashboardWidget | null>(() => {
  if (selectedIdx.value === null) return null;
  return currentWidgets.value[selectedIdx.value] ?? null;
});

function selectWidget(i: number): void {
  selectedIdx.value = i;
}

/** Drawer commits edits in place on the live draft via v-model — no
 *  separate apply step. The button row offers a delete shortcut. */
function deleteSelected(): void {
  if (selectedIdx.value === null) return;
  deleteWidget(selectedIdx.value);
  selectedIdx.value = null;
}
function moveSelected(dir: -1 | 1): void {
  if (selectedIdx.value === null) return;
  const i = selectedIdx.value;
  moveWidget(i, dir);
  const j = i + dir;
  if (j >= 0 && j < currentWidgets.value.length) selectedIdx.value = j;
}

/** When a new widget is added, immediately select it so the drawer
 *  opens with empty fields ready for input. */
async function addAndSelectWidget(): Promise<void> {
  addWidget();
  await nextTick();
  selectedIdx.value = currentWidgets.value.length - 1;
}

function expressionsToText(arr: string[]): string {
  return arr.join('\n');
}
function textToExpressions(s: string): string[] {
  return s
    .split('\n')
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
}


/** Save the current editor state to the browser local draft. This is the
 *  only "save" — it never writes OAP. Publish later with "Push local → OAP". */
function save(): void {
  if (!draft.template) return;
  persistLocal(draft.template);
  editorSource.value = 'local';
  saveMsg.value = 'Saved to your browser (local). Publish with “Check diff & push”.';
  setTimeout(() => (saveMsg.value = null), 6000);
}

// Push = publish local → remote. Available only when a local draft exists
// AND differs from remote; the confirm modal shows the remote→local diff.
const pushDiffOpen = ref(false);
// Key-stable so a one-field edit doesn't read as "everything changed" —
// OAP stores keys alphabetically; the local draft is in authored order.
function prettyJson(o: unknown): string {
  return o ? stableStringify(o, 2) : '';
}
const localDiffersFromRemote = computed<boolean>(() => {
  const local = localEdits.get<AdminLayerTemplate>(editName.value);
  if (!local) return false;
  return stableStringify(local) !== stableStringify(sources.remote<AdminLayerTemplate>(editName.value) ?? null);
});
const pushLocalPretty = computed(() => prettyJson(localEdits.get(editName.value)));
const pushRemotePretty = computed(() => prettyJson(sources.remote(editName.value)));

/** Publish the local draft to OAP. The BFF waits for the new row to
 *  become visible to OAP's own list (BanyanDB has a read-after-write
 *  window — up to ~5s). A live count-up is shown while we're waiting.
 *  On the BFF's 504 propagation-timeout, refetch sync state anyway —
 *  the row may have appeared moments later. */
async function pushToOap(): Promise<void> {
  const local = localEdits.get<AdminLayerTemplate>(editName.value);
  if (!local || isSaving.value) return;
  isSaving.value = true;
  saveMsg.value = 'Saving to OAP…';
  let elapsed = 0;
  const ticker = setInterval(() => {
    elapsed++;
    saveMsg.value = `Saving to OAP… ${elapsed}s`;
  }, 1000);
  try {
    await bff.templateSync.save(editName.value, local);
    clearInterval(ticker);
    localEdits.remove(editName.value);
    previewOverride.clear(editName.value);
    pushDiffOpen.value = false;
    for (let n = 10; n > 0; n--) {
      saveMsg.value = `Pushed. Refreshing in ${n}s…`;
      await sleep(1000);
    }
    await bff.templateSync.resync();
    await Promise.all([sources.refetch(), refreshConfigBundle()]);
    reconcileLocalDrafts();
    loadFrom('remote');
    saveMsg.value = 'Published your local draft to OAP — now live for everyone.';
    setTimeout(() => (saveMsg.value = null), 6000);
  } catch (err) {
    clearInterval(ticker);
    if (err instanceof BffApiError && err.status === 504) {
      saveMsg.value = 'Timeout waiting for OAP propagation. Refetching…';
      try {
        await bff.templateSync.resync();
        await Promise.all([sources.refetch(), refreshConfigBundle()]);
        reconcileLocalDrafts();
      } catch {
        /* refetch best-effort */
      }
      saveMsg.value = 'Refetched after timeout — the push may have completed; please verify.';
      setTimeout(() => (saveMsg.value = null), 10000);
    } else {
      saveMsg.value = err instanceof Error ? err.message : String(err);
    }
  } finally {
    isSaving.value = false;
  }
}

// ── Disable / reactivate (OAP has no hard DELETE) ──────────────────
// Disabling soft-disables the layer on OAP: a disabled template drops out
// of the bundle AND the menu, so the layer disappears from the sidebar.
// Reactivating re-pushes the bundled default to OAP, which clears the
// disabled flag and the layer reappears. A purely local draft (no OAP
// presence) is just removed from the browser.
//
// Styled confirm (replaces window.confirm — native box breaks the dark
// design). One modal serves both actions via a stored `confirmFn`.
const isLayerDisabled = computed(() => sync.badgeFor(editName.value) === 'disabled');
const deleteOpen = ref(false);
const confirmTitle = ref('');
const confirmMessage = ref('');
const confirmLabel = ref('');
const confirmIsDanger = ref(true);
let confirmFn: (() => void | Promise<void>) | null = null;
function runConfirm(): void {
  deleteOpen.value = false;
  const fn = confirmFn;
  confirmFn = null;
  if (fn) void fn();
}
function askDeleteLayer(): void {
  const key = selectedKey.value;
  if (!key || !editName.value) return;
  const onOap = remoteAvailable.value || bundledExists.value;
  if (!onOap) {
    confirmTitle.value = 'Remove local draft?';
    confirmMessage.value = `Remove the local draft for “${key}”? It was never published — this clears it from this browser only.`;
    confirmLabel.value = 'Remove draft';
  } else if (bundledExists.value) {
    confirmTitle.value = 'Disable built-in layer?';
    confirmMessage.value = `Disable the built-in “${key}” layer? It's soft-disabled on OAP and disappears from the sidebar for everyone. You can bring it back later with Reactivate.`;
    confirmLabel.value = 'Disable';
  } else {
    confirmTitle.value = 'Delete layer template?';
    confirmMessage.value = `Delete the “${key}” layer template? OAP has no hard delete, so it's soft-disabled — hidden from everyone.`;
    confirmLabel.value = 'Delete';
  }
  confirmIsDanger.value = true;
  confirmFn = doDeleteLayer;
  deleteOpen.value = true;
}
function askReactivateLayer(): void {
  const key = selectedKey.value;
  if (!key || !editName.value) return;
  confirmTitle.value = 'Reactivate layer?';
  confirmMessage.value = `Reactivate the “${key}” layer? This re-enables it on OAP from the bundled default — it reappears in the sidebar for everyone.`;
  confirmLabel.value = 'Reactivate';
  confirmIsDanger.value = false;
  confirmFn = doReactivateLayer;
  deleteOpen.value = true;
}
async function doDeleteLayer(): Promise<void> {
  const key = selectedKey.value;
  const name = editName.value;
  if (!key || !name) return;
  const onOap = remoteAvailable.value || bundledExists.value;
  if (!onOap) {
    localEdits.remove(name);
    saveMsg.value = `Removed local draft for "${key}".`;
    setTimeout(() => (saveMsg.value = null), 6000);
    return;
  }
  isSaving.value = true;
  saveMsg.value = null;
  try {
    await bff.templateSync.disable(name);
    localEdits.remove(name);
    await Promise.all([sources.refetch(), refreshConfigBundle()]);
    saveMsg.value = `Disabled "${key}" on OAP.`;
    setTimeout(() => (saveMsg.value = null), 6000);
  } catch (err) {
    saveMsg.value = err instanceof Error ? err.message : String(err);
  } finally {
    isSaving.value = false;
  }
}
async function doReactivateLayer(): Promise<void> {
  const key = selectedKey.value;
  const name = editName.value;
  if (!key || !name) return;
  // Re-push the bundled default; the BFF update clears OAP's disabled flag.
  const content = bundledContent();
  if (!content) return;
  isSaving.value = true;
  saveMsg.value = null;
  try {
    await bff.templateSync.save(name, content);
    localEdits.remove(name);
    await Promise.all([sources.refetch(), refreshConfigBundle()]);
    loadFrom('remote');
    saveMsg.value = `Reactivated "${key}".`;
    setTimeout(() => (saveMsg.value = null), 6000);
  } catch (err) {
    saveMsg.value = err instanceof Error ? err.message : String(err);
  } finally {
    isSaving.value = false;
  }
}

const selectedTpl = computed(() => draft.template);
const currentWidgets = computed(() => widgetsFor(activeScope.value));

/* ------------------------------------------------------------------- *
 * Topology / Endpoint-dependency config editor.
 *
 * Topology has three metric lists: nodeMetrics, linkServerMetrics,
 * linkClientMetrics. Endpoint-dependency only has two: nodeMetrics,
 * linkMetrics (OAP has no client family for endpoint relations).
 *
 * Each list edits an array of TopologyMetricDef objects. The form
 * surfaces id / label / mqe / unit / role / aggregation + thresholds.
 *
 * Initial state: when the template has no `topology` /
 * `endpointDependency` block the helpers seed an empty one so the
 * operator can start adding rows without manual JSON edits.
 * ------------------------------------------------------------------- */

const TOPOLOGY_ROLE_OPTIONS: Array<{ value: TopologyMetricDef['role'] | ''; label: string }> = [
  { value: '', label: '(tooltip only)' },
  { value: 'center', label: 'center · node big number' },
  { value: 'ring', label: 'ring · node colour band' },
  { value: 'secondary', label: 'secondary · detail panel' },
  { value: 'lineServer', label: 'lineServer · edge server side' },
  { value: 'lineClient', label: 'lineClient · edge client side' },
];

function emptyTopology(): TopologyConfig {
  return { nodeMetrics: [], linkServerMetrics: [], linkClientMetrics: [] };
}
function emptyEndpointDep(): EndpointDependencyConfig {
  return { nodeMetrics: [], linkMetrics: [] };
}
function emptyProcessTopology(): ProcessTopologyConfig {
  return { edgeClientMetrics: [], edgeServerMetrics: [] };
}

function ensureTopology(): TopologyConfig {
  if (!draft.template) throw new Error('no template selected');
  const tpl = draft.template;
  if (!tpl.topology) tpl.topology = emptyTopology();
  if (!tpl.topology.linkServerMetrics) tpl.topology.linkServerMetrics = [];
  if (!tpl.topology.linkClientMetrics) tpl.topology.linkClientMetrics = [];
  return tpl.topology;
}
function ensureEndpointDep(): EndpointDependencyConfig {
  if (!draft.template) throw new Error('no template selected');
  const tpl = draft.template;
  if (!tpl.endpointDependency) tpl.endpointDependency = emptyEndpointDep();
  if (!tpl.endpointDependency.linkMetrics) tpl.endpointDependency.linkMetrics = [];
  return tpl.endpointDependency;
}
function ensureProcessTopology(): ProcessTopologyConfig {
  if (!draft.template) throw new Error('no template selected');
  const tpl = draft.template;
  if (!tpl.processTopology) tpl.processTopology = emptyProcessTopology();
  if (!tpl.processTopology.edgeClientMetrics) tpl.processTopology.edgeClientMetrics = [];
  if (!tpl.processTopology.edgeServerMetrics) tpl.processTopology.edgeServerMetrics = [];
  return tpl.processTopology;
}

type MetricBucket = 'node' | 'linkServer' | 'linkClient' | 'link' | 'edgeClient' | 'edgeServer';

function getMetricList(bucket: MetricBucket): TopologyMetricDef[] {
  if (!draft.template) return [];
  if (activeScope.value === 'topology') {
    const t = ensureTopology();
    if (bucket === 'node') return t.nodeMetrics;
    if (bucket === 'linkServer') return t.linkServerMetrics ?? [];
    if (bucket === 'linkClient') return t.linkClientMetrics ?? [];
  } else if (activeScope.value === 'dependency') {
    const t = ensureEndpointDep();
    if (bucket === 'node') return t.nodeMetrics;
    if (bucket === 'link') return t.linkMetrics ?? [];
  } else if (activeScope.value === 'networkProfiling') {
    const t = ensureProcessTopology();
    if (bucket === 'edgeClient') return t.edgeClientMetrics;
    if (bucket === 'edgeServer') return t.edgeServerMetrics;
  }
  return [];
}

function addMetric(bucket: MetricBucket): void {
  if (!draft.template) return;
  const list = getMetricList(bucket);
  const next: TopologyMetricDef = {
    id: `metric_${list.length + 1}`,
    label: `Metric ${list.length + 1}`,
    mqe: '',
    unit: '',
    aggregation: 'avg',
  };
  list.push(next);
}
function removeMetric(bucket: MetricBucket, i: number): void {
  const list = getMetricList(bucket);
  list.splice(i, 1);
}
function moveMetric(bucket: MetricBucket, i: number, dir: -1 | 1): void {
  const list = getMetricList(bucket);
  const j = i + dir;
  if (j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j], list[i]];
}
function toggleThresholds(m: TopologyMetricDef): void {
  if (m.thresholds) {
    m.thresholds = undefined;
  } else {
    m.thresholds = { ok: 0.1, warn: 1, danger: 5 };
  }
}

const topologyNodeMetrics = computed(() => getMetricList('node'));
const topologyServerMetrics = computed(() => getMetricList('linkServer'));
const topologyClientMetrics = computed(() => getMetricList('linkClient'));
const epDepNodeMetrics = computed(() => activeScope.value === 'dependency' ? getMetricList('node') : []);
const epDepLinkMetrics = computed(() => getMetricList('link'));
const processEdgeClientMetrics = computed(() =>
  activeScope.value === 'networkProfiling' ? getMetricList('edgeClient') : [],
);
const processEdgeServerMetrics = computed(() =>
  activeScope.value === 'networkProfiling' ? getMetricList('edgeServer') : [],
);

/* Trace backend selector. `traces.source` decides which trace store the
 * per-layer Trace tab dispatches to: `native` (SkyWalking query-protocol),
 * `zipkin` (Envoy ALS / rover spans), or `both` (parallel tables). The
 * field IS live — `LayerTracesEntry` reads `layer.traces.source` at
 * runtime — so it belongs in the config UI. Default `both` when unset. */
type TraceSource = 'native' | 'zipkin' | 'both';
const traceSource = computed<TraceSource>({
  get: () => draft.template?.traces?.source ?? 'both',
  set: (v: TraceSource) => {
    if (!draft.template) return;
    if (draft.template.traces) draft.template.traces.source = v;
    else draft.template.traces = { source: v };
  },
});
const TRACE_SOURCE_OPTIONS: Array<{ value: TraceSource; label: string; hint: string }> = [
  { value: 'native', label: 'Native', hint: 'SkyWalking query-protocol traces (agent-instrumented).' },
  { value: 'zipkin', label: 'OpenTelemetry & Zipkin', hint: 'Traces emitted from the OpenTelemetry & Zipkin ecosystem.' },
  { value: 'both', label: 'Both', hint: 'Layer carries both native and OpenTelemetry/Zipkin traces — their span formats and query conditions differ, so each gets its own trace tab.' },
];

/* Logs has no per-layer config beyond the enable/disable Components
 * toggle. Trace carries one setting — `traces.source` (native / zipkin /
 * both), edited via `traceSource` above — which the per-layer Trace tab
 * honors at runtime to pick the trace backend. */

/**
 * Metrics block editor — drives the service-list columns + default
 * sort. Overview-only fields (throughput, spark) live in a separate
 * block, so they're edited in their own card.
 */
function ensureMetrics(): NonNullable<AdminLayerTemplate['metrics']> {
  if (!draft.template) throw new Error('no template selected');
  if (!draft.template.metrics) {
    (draft.template as AdminLayerTemplate).metrics = {};
  }
  return draft.template.metrics as NonNullable<AdminLayerTemplate['metrics']>;
}
function ensureOverview(): NonNullable<AdminLayerTemplate['overview']> {
  if (!draft.template) throw new Error('no template selected');
  if (!draft.template.overview) {
    (draft.template as AdminLayerTemplate).overview = {};
  }
  return draft.template.overview as NonNullable<AdminLayerTemplate['overview']>;
}
const metricsModel = computed(() => {
  if (!draft.template) return null;
  ensureMetrics();
  return draft.template.metrics as NonNullable<AdminLayerTemplate['metrics']>;
});
const overviewModel = computed(() => {
  if (!draft.template) return null;
  ensureOverview();
  return draft.template.overview as NonNullable<AdminLayerTemplate['overview']>;
});
const metricsColumns = computed(() => {
  if (!draft.template) return [];
  const m = ensureMetrics();
  if (!m.columns) m.columns = [];
  return m.columns;
});
function addMetricColumn(): void {
  if (!draft.template) return;
  const m = ensureMetrics();
  if (!m.columns) m.columns = [];
  m.columns.push({
    metric: `metric_${m.columns.length + 1}`,
    label: `Metric ${m.columns.length + 1}`,
    aggregation: 'avg',
  });
}
function deleteMetricColumn(i: number): void {
  if (!draft.template?.metrics?.columns) return;
  draft.template.metrics.columns.splice(i, 1);
}

/** Sample rows for the service-list preview — three fake services with
 *  deterministic per-column values so the author sees how the configured
 *  columns render (label, scale, precision, unit, default-sort marker)
 *  without firing any MQE. */
const SAMPLE_SERVICES = ['checkout', 'inventory', 'gateway'];
function previewBase(seed: number): number {
  return [42.37, 1280.5, 0.918][seed % 3] * (1 + (seed % 5) * 0.35);
}
function previewCell(col: { scale?: number; precision?: number; unit?: string }, seed: number): string {
  const v = previewBase(seed) * (col.scale ?? 1);
  const num = col.precision != null ? v.toFixed(col.precision) : fmtMetric(v);
  return col.unit ? `${num} ${col.unit}` : num;
}
/** The metric the service list sorts by — explicit `orderBy`, else the
 *  first column (mirrors the renderer's fallback). */
const effectiveOrderBy = computed(
  () => metricsModel.value?.orderBy ?? metricsColumns.value[0]?.metric,
);

type MetricColumn = NonNullable<NonNullable<AdminLayerTemplate['metrics']>['columns']>[number];
/** Headline column for the landing KPI tile: explicit `overview.throughput`,
 *  else the default-sort column. */
const kpiHeadlineCol = computed<MetricColumn | undefined>(() => {
  const key = overviewModel.value?.throughput ?? effectiveOrderBy.value;
  return metricsColumns.value.find((c) => c.metric === key) ?? metricsColumns.value[0];
});
/** Trend column for the sparkline: explicit `overview.spark`, else the
 *  headline column. */
const kpiSparkCol = computed<MetricColumn | undefined>(() => {
  const key = overviewModel.value?.spark ?? overviewModel.value?.throughput ?? effectiveOrderBy.value;
  return metricsColumns.value.find((c) => c.metric === key) ?? kpiHeadlineCol.value;
});
/** Headline number — fmtMetric of a mock aggregate for the headline
 *  column (the real tile shows the value bare; unit lives in the label). */
const kpiHeadlineValue = computed(() =>
  kpiHeadlineCol.value ? fmtMetric(previewBase(1) * (kpiHeadlineCol.value.scale ?? 1)) : '—',
);
/** Mock sparkline series for the real Sparkline component — deterministic
 *  per spark-column so the trend reads as real movement without MQE. */
const kpiSparkValues = computed<number[]>(() => {
  const seed = (kpiSparkCol.value?.metric ?? 'x').length;
  const n = 24;
  const a: number[] = [];
  for (let i = 0; i < n; i++) a.push(14 + Math.sin(i * 0.7 + seed) * 7 + Math.sin(i * 0.23 + seed) * 4);
  return a;
});
/** Two-letter mark for the header icon tile (mirrors the live header). */
const previewInitials = computed(() => (selectedTpl.value?.key ?? '??').slice(0, 2).toUpperCase());

/**
 * Scope-aware `visibleWhen` placeholder + hover hint. Two supported
 * predicate forms:
 *
 *   <metric> has value     The SPA evaluates this against the widget's
 *                          own MQE result. If at least one bucket is
 *                          non-null, the widget renders. Useful when
 *                          the metric only exists for some services
 *                          (e.g. service_mq_consume_count only on MQ
 *                          producers).
 *
 *   #entity.<attr>         The SPA evaluates this against the *entity's*
 *                          attributes. Only meaningful on scopes where
 *                          entities carry attributes — i.e. INSTANCE
 *                          (jvm / language / host etc.) and to a lesser
 *                          extent ENDPOINT. Service-scope entities
 *                          don't expose attributes, so the predicate is
 *                          a no-op there.
 *
 * The placeholder / tooltip swap so operators editing an instance
 * widget see entity-attribute syntax, and service-widget operators see
 * the metric-has-value form.
 */
function visibleWhenPlaceholder(scope: DashboardScope): string {
  if (scope === 'instance') return "#entity.jvm   or   instance_jvm_cpu has value";
  if (scope === 'endpoint') return 'endpoint_cpm has value';
  return 'service_mq_consume_count has value';
}
function visibleWhenHint(scope: DashboardScope): string {
  const common =
    'Hide the widget unless this predicate is truthy.\n' +
    '\n' +
    "  <metric> has value   — the widget's own MQE returned non-null data.";
  const entityHint =
    '\n  #entity.<attr>       — the active entity has the named attribute (e.g. #entity.jvm,\n' +
    '                         #entity.language). Only meaningful for instance / endpoint scopes;\n' +
    "                         service-scope entities don't carry attributes.";
  if (scope === 'instance' || scope === 'endpoint') return common + entityHint;
  return common + '\n  (#entity.* predicates are entity-attribute-based and apply best on Instance scope.)';
}

/**
 * Component toggles surfaced in the admin editor. Each entry binds to
 * a key on the template's `components` block; flipping the toggle
 * shows / hides the matching sidebar entry + per-layer route.
 */
type ComponentKey = keyof AdminLayerTemplate['components'];
const COMPONENT_TOGGLES: Array<{ key: ComponentKey; label: string; hint: string }> = [
  { key: 'service', label: 'Service', hint: "The layer's primary landing — widget grid driven by dashboards.service." },
  { key: 'instances', label: 'Instances', hint: 'Per-instance dashboard (dashboards.instance widget set).' },
  { key: 'endpoints', label: 'Endpoints', hint: 'Per-endpoint dashboard (dashboards.endpoint widget set).' },
  { key: 'endpointDependency', label: 'API dependency', hint: 'Endpoint-to-endpoint dependency view.' },
  { key: 'topology', label: 'Topology', hint: 'Service topology graph for this layer.' },
  { key: 'traces', label: 'Traces', hint: 'Trace explorer scoped to this layer.' },
  { key: 'logs', label: 'Logs', hint: 'Log explorer scoped to this layer.' },
  { key: 'traceProfiling', label: 'Trace Profiling', hint: 'Trace-driven thread profiling — the original SkyWalking profile.' },
  { key: 'ebpfProfiling', label: 'eBPF Profiling', hint: 'Kernel-level CPU / off-CPU profiling via eBPF agents.' },
  { key: 'asyncProfiling', label: 'Async Profiling', hint: 'JVM async-profiler integration (Java-only).' },
];

function ensureComponents(): AdminLayerTemplate['components'] {
  if (!draft.template) throw new Error('no template selected');
  if (!draft.template.components) {
    (draft.template as AdminLayerTemplate).components = {};
  }
  return draft.template.components;
}
function toggleComponent(key: ComponentKey): void {
  const c = ensureComponents();
  c[key] = !c[key];
}

/** Inverse of SCOPE_COMPONENT, narrowed to the toggle keys — maps each
 *  Components checkbox to the editor scope its config lives under, so a
 *  menu-preview click can jump straight to that scope's widget editor. */
const COMPONENT_SCOPE: Record<ComponentKey, AdminScope> = {
  service: 'service',
  instances: 'instance',
  endpoints: 'endpoint',
  endpointDependency: 'dependency',
  topology: 'topology',
  traces: 'trace',
  logs: 'logs',
  traceProfiling: 'traceProfiling',
  ebpfProfiling: 'ebpfProfiling',
  asyncProfiling: 'asyncProfiling',
  // Legacy umbrella flag — no checkbox of its own (the three granular
  // profiling toggles drive the menu), so this entry only satisfies the
  // exhaustive Record; it is never surfaced as a menu item.
  profiling: 'traceProfiling',
};
/** Component → slot-alias key. The layer's `slots` carry per-layer term
 *  aliases (services → "ClickHouse clusters", instances → "Nodes", …);
 *  the menu preview shows these instead of the generic component label,
 *  matching what the real sidebar renders. */
const COMPONENT_SLOT: Partial<Record<ComponentKey, keyof NonNullable<AdminLayerTemplate['slots']>>> = {
  service: 'services',
  instances: 'instances',
  endpoints: 'endpoints',
  endpointDependency: 'endpointDependency',
};
/** The layer's sidebar menu as the operator would see it — only the
 *  enabled components, in COMPONENT_TOGGLES order, labelled with the
 *  layer's slot aliases where defined. Drives the menu preview. */
const menuItems = computed(() => {
  const slots = draft.template?.slots ?? {};
  return COMPONENT_TOGGLES.filter((t) => !!draft.template?.components?.[t.key]).map((t) => {
    const slotKey = COMPONENT_SLOT[t.key];
    return {
      key: t.key,
      label: (slotKey && slots[slotKey]) || t.label,
      scope: COMPONENT_SCOPE[t.key],
    };
  });
});
/** Menu-preview click: focus the component's scope (if surfaced) and
 *  scroll the scope editor into view so config + preview follow the
 *  selection. */
function jumpToComponent(scope: AdminScope): void {
  if (visibleScopes.value.includes(scope)) activeScope.value = scope;
  void nextTick(() => {
    document.getElementById('scope-editor')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}

type SlotKey = keyof NonNullable<AdminLayerTemplate['slots']>;
/** Scope → slot-alias key, for the scopes that carry a configurable
 *  noun. Drives alias-aware scope-tab + section-heading labels so the
 *  admin reads in the layer's own vocabulary (e.g. "Nodes" not
 *  "instance"). */
const SCOPE_SLOT: Partial<Record<AdminScope, SlotKey>> = {
  service: 'services',
  instance: 'instances',
  endpoint: 'endpoints',
  dependency: 'endpointDependency',
};
function scopeLabel(s: AdminScope): string {
  const sk = SCOPE_SLOT[s];
  return (sk && draft.template?.slots?.[sk]) || SCOPE_LABELS[s];
}

/** The four configurable slot aliases. Shown for the components the
 *  layer actually exposes so the editor mirrors the menu. */
const ALIAS_FIELDS: Array<{ slot: SlotKey; label: string; comp: ComponentKey; def: string }> = [
  { slot: 'services', label: 'Services', comp: 'service', def: 'Service' },
  { slot: 'instances', label: 'Instances', comp: 'instances', def: 'Instance' },
  { slot: 'endpoints', label: 'Endpoints', comp: 'endpoints', def: 'Endpoint' },
  { slot: 'endpointDependency', label: 'API dependency', comp: 'endpointDependency', def: 'Dependency' },
];
const visibleAliasFields = computed(() =>
  ALIAS_FIELDS.filter((f) => !!draft.template?.components?.[f.comp]),
);
function ensureSlots(): NonNullable<AdminLayerTemplate['slots']> {
  if (!draft.template) throw new Error('no template selected');
  if (!draft.template.slots) (draft.template as AdminLayerTemplate).slots = {};
  return draft.template.slots;
}
/** Write a slot alias. `slots` is the canonical field the loader reads;
 *  mirror to the JSON's legacy `aliases` so the saved file stays
 *  internally consistent (the loader prefers `slots`, but keeping both
 *  in step avoids a confusing stale `aliases` block in the bundle). */
function setSlot(slot: SlotKey, value: string): void {
  const s = ensureSlots();
  const v = value.trim();
  if (v) s[slot] = v;
  else delete s[slot];
  const a = ((draft.template as { aliases?: Record<string, string> }).aliases ??= {});
  if (v) a[slot] = v;
  else delete a[slot];
}
function setVisibility(v: 'public' | 'operate'): void {
  if (!draft.template) return;
  // `public` is the implicit default — drop the field rather than
  // emit a redundant value, so saved JSON stays minimal.
  if (v === 'public') {
    delete (draft.template as { visibility?: string }).visibility;
  } else {
    (draft.template as { visibility?: string }).visibility = 'operate';
  }
}

// ── Topology cluster setup — rule editor + live tester.
// The rule is a named-capture regex run against every service name in
// the topology + service pickers. Operators bind which capture maps to
// the display label vs the cluster value (e.g. k8s namespace), and
// pick a human-readable alias (`namespace`, `tenant`, …). The tester
// evaluates the live draft against a sample name so operators can see
// the resolved `{ display, cluster, alias }` before saving. Distinct
// from OAP's layer-agnostic `<group>::<base>` prefix (which is a
// global naming convention, never produces a cluster box).
type NamingRule = NonNullable<AdminLayerTemplate['naming']>;
function namingDefault(): NamingRule {
  return {
    pattern: '^(?<service>[^.]+)\\.(?<namespace>[^.]+)(?:\\..*)?$',
    flags: '',
    displayGroup: 'service',
    valueGroup: 'namespace',
    alias: 'namespace',
  };
}
function enableNaming(): void {
  if (!draft.template) return;
  draft.template.naming = namingDefault();
}
function disableNaming(): void {
  if (!draft.template) return;
  draft.template.naming = undefined;
}
/**
 * Toggle the `showGroup` flag on the current scope's config block
 * (topology or endpoint-dependency). Controls whether the legacy
 * `<group>::` prefix surfaces as a separate chip in the node detail
 * panel of that scope. Default off everywhere.
 */
function toggleShowGroup(): void {
  if (!draft.template) return;
  if (activeScope.value === 'topology') {
    const t = ensureTopology();
    t.showGroup = !t.showGroup;
  } else if (activeScope.value === 'dependency') {
    const t = ensureEndpointDep();
    t.showGroup = !t.showGroup;
  }
}
const showGroupForScope = computed<boolean>(() => {
  const t = draft.template;
  if (!t) return false;
  if (activeScope.value === 'topology') return Boolean(t.topology?.showGroup);
  if (activeScope.value === 'dependency') return Boolean(t.endpointDependency?.showGroup);
  return false;
});

// Pointer from the topology scope panel ⤴ to the always-visible
// Topology cluster card. Smooth-scrolls and briefly highlights so the
// operator's eye lands on it without ambiguity.
function scrollToClusterCard(): void {
  const el = document.getElementById('topology-cluster');
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  el.classList.add('cluster-pulse');
  setTimeout(() => el.classList.remove('cluster-pulse'), 1400);
}
const namingSample = ref<string>('songs.sample.svc.cluster.local');
interface NamingTestResult {
  ok: boolean;
  display: string | null;
  group: string | null;
  alias: string | null;
  error: string | null;
}
const namingTest = computed<NamingTestResult>(() => {
  const rule = draft.template?.naming;
  if (!rule) return { ok: false, display: null, group: null, alias: null, error: 'no rule configured' };
  if (!rule.pattern) return { ok: false, display: null, group: null, alias: null, error: 'pattern required' };
  let re: RegExp;
  try {
    re = new RegExp(rule.pattern, rule.flags ?? '');
  } catch (err) {
    return { ok: false, display: null, group: null, alias: null, error: err instanceof Error ? err.message : 'invalid regex' };
  }
  const m = namingSample.value.match(re);
  if (!m || !m.groups) {
    return { ok: false, display: null, group: null, alias: rule.alias, error: 'no match' };
  }
  const displayKey = rule.displayGroup || 'service';
  const valueKey = rule.valueGroup || 'group';
  const display = m.groups[displayKey] ?? null;
  const group = m.groups[valueKey] ?? null;
  if (!display && !group) {
    return { ok: false, display: null, group: null, alias: rule.alias, error: `neither capture "${displayKey}" nor "${valueKey}" resolved` };
  }
  return { ok: true, display, group, alias: rule.alias, error: null };
});
</script>

<template>
  <div class="admin-page">
    <header class="page-head">
      <div>
        <div class="kicker">Admin</div>
        <h1>Layer dashboards</h1>
        <p class="lede">
          Each layer ships with a JSON template (alias, components, metric columns, widgets).
          Pick a layer on the left, switch scopes (service / instance / endpoint / trace /
          profiling), edit widgets in place. Edits write to OAP via the UI-template REST
          surface — bundled JSON is the seed + read-only fallback.
        </p>
      </div>
    </header>

    <SyncStatusBanner :banner="sync.banner.value" />

    <div v-if="error" class="banner err">{{ error }}</div>
    <div v-if="isLoading" class="empty">Loading templates…</div>
    <div v-else-if="templates.length === 0" class="empty">No layer templates loaded.</div>

    <div v-else class="grid" :class="{ 'list-collapsed': !layerListOpen }">
      <!-- Browse rail. Shown only while expanded; selecting a layer
           collapses it so the editor claims the full width. Once
           collapsed, layer switching moves to the top dropdown inside
           the detail pane (no left zone consumed). -->
      <aside v-if="layerListOpen" class="sw-card layer-list">
        <div class="list-head">
          <button
            class="list-toggle"
            type="button"
            title="Collapse the layers list"
            @click="layerListOpen = false"
          >
            <span class="caret open">›</span>
          </button>
          <h4>Layers</h4>
          <span class="sub">
            {{ layerSearch.trim()
              ? `${filteredTemplates.length} / ${templates.length}`
              : `${templates.length} template${templates.length === 1 ? '' : 's'}` }}
          </span>
        </div>
        <div class="list-search">
          <input
            v-model="layerSearch"
            type="text"
            class="list-search-input"
            placeholder="Search layers…"
            autocomplete="off"
            spellcheck="false"
          />
        </div>
        <div class="dd-filters">
          <label class="diverged-filter" :class="{ on: divergedOnly }" :title="divergedCount === 0 ? 'No layers differ from OAP' : `${divergedCount} layer(s) differ from the OAP-stored copy`">
            <input v-model="divergedOnly" type="checkbox" :disabled="divergedCount === 0" />
            Diverged<span v-if="divergedCount" class="diverged-count">{{ divergedCount }}</span>
          </label>
          <label class="diverged-filter local" :class="{ on: localOnly }" :title="localCount === 0 ? 'No unpublished local drafts in this browser' : `${localCount} layer(s) with an unpublished local draft`">
            <input v-model="localOnly" type="checkbox" :disabled="localCount === 0" />
            Local<span v-if="localCount" class="diverged-count local">{{ localCount }}</span>
          </label>
        </div>
        <button
          v-for="t in filteredTemplates"
          :key="t.key"
          class="layer-row"
          :class="{ active: selectedKey === t.key }"
          @click="selectLayer(t.key)"
        >
          <span class="dot" :style="{ background: t.color || 'var(--sw-fg-3)' }" />
          <span class="name">{{ t.alias || t.key }}</span>
          <code v-if="t.alias && t.alias !== t.key" class="key-tag">{{ t.key }}</code>
          <span v-if="hasLocalDraftFor(t.key)" class="local-badge" title="Unpublished local draft">local</span>
          <TemplateStatusBadge :status="sync.badgeFor(`horizon.layer.${t.key}`)" />
        </button>
        <p v-if="filteredTemplates.length === 0" class="list-empty">
          {{ divergedOnly && !layerSearch.trim() ? 'No layers differ from OAP.' : `No layers match “${layerSearch}”.` }}
        </p>
      </aside>

      <main v-if="selectedTpl" class="detail">
        <!-- Collapsed-rail layer switcher: a filterable dropdown at the
             top of the editor so the left zone stays free. Same search +
             filter as the rail (not a native select). -->
        <div v-if="!layerListOpen" class="layer-switch-bar">
            <div class="layer-dd">
              <button
                class="layer-dd-btn"
                type="button"
                @click="layerDropdownOpen = !layerDropdownOpen"
              >
              <span class="dot inline" :style="{ background: selectedTpl.color || 'var(--sw-fg-3)' }" />
              <span class="layer-dd-name">{{ selectedTpl.alias || selectedTpl.key }}</span>
              <code v-if="selectedTpl.alias && selectedTpl.alias !== selectedTpl.key" class="key-tag">{{ selectedTpl.key }}</code>
              <span v-if="hasLocalDraftFor(selectedTpl.key)" class="local-badge" title="Unpublished local draft in this browser">local</span>
              <TemplateStatusBadge :status="sync.badgeFor(`horizon.layer.${selectedTpl.key}`)" />
              <span class="caret dd-caret" :class="{ open: layerDropdownOpen }">›</span>
            </button>
            <template v-if="layerDropdownOpen">
              <div class="layer-dd-backdrop" @click="layerDropdownOpen = false" />
              <div class="layer-dd-pop sw-card">
                <div class="list-search">
                  <input
                    v-model="layerSearch"
                    type="text"
                    class="list-search-input"
                    placeholder="Search layers…"
                    autocomplete="off"
                    spellcheck="false"
                  />
                </div>
                <div class="dd-filters">
                  <label class="diverged-filter" :class="{ on: divergedOnly }" :title="divergedCount === 0 ? 'No layers differ from OAP' : `${divergedCount} layer(s) differ from the OAP-stored copy`">
                    <input v-model="divergedOnly" type="checkbox" :disabled="divergedCount === 0" />
                    Diverged<span v-if="divergedCount" class="diverged-count">{{ divergedCount }}</span>
                  </label>
                  <label class="diverged-filter local" :class="{ on: localOnly }" :title="localCount === 0 ? 'No unpublished local drafts in this browser' : `${localCount} layer(s) with an unpublished local draft`">
                    <input v-model="localOnly" type="checkbox" :disabled="localCount === 0" />
                    Local<span v-if="localCount" class="diverged-count local">{{ localCount }}</span>
                  </label>
                </div>
                <div class="layer-dd-list">
                  <button
                    v-for="t in filteredTemplates"
                    :key="t.key"
                    class="layer-row"
                    :class="{ active: selectedKey === t.key }"
                    @click="pickFromDropdown(t.key)"
                  >
                    <span class="dot" :style="{ background: t.color || 'var(--sw-fg-3)' }" />
                    <span class="name">{{ t.alias || t.key }}</span>
                    <code v-if="t.alias && t.alias !== t.key" class="key-tag">{{ t.key }}</code>
                    <span v-if="hasLocalDraftFor(t.key)" class="local-badge" title="Unpublished local draft">local</span>
                    <TemplateStatusBadge :status="sync.badgeFor(`horizon.layer.${t.key}`)" />
                  </button>
                  <p v-if="filteredTemplates.length === 0" class="list-empty">
                    {{ divergedOnly && !layerSearch.trim() ? 'No layers differ from OAP.' : `No layers match “${layerSearch}”.` }}
                  </p>
                </div>
                <div class="layer-dd-foot">
                  <span class="sub">{{ templates.length }} layer{{ templates.length === 1 ? '' : 's' }}</span>
                  <button
                    type="button"
                    class="sw-btn refresh-btn"
                    :disabled="refreshingFromRemote || sync.readOnly.value"
                    :title="sync.readOnly.value
                      ? 'OAP unreachable — cannot refresh'
                      : 'Force the BFF to re-read every UI-template from OAP (clears the 30s cache)'"
                    @click="refreshFromRemote"
                  >{{ refreshingFromRemote ? 'refreshing…' : 'refresh from remote' }}</button>
                </div>
              </div>
            </template>
            </div>
        </div>
        <!-- Identity strip + save controls -->
        <section class="sw-card identity-card">
          <div class="identity-row">
            <span class="dot inline" :style="{ background: selectedTpl.color || 'var(--sw-fg-3)' }" />
            <!-- Single-line identity: Layer: <name> <key> <local> <status>. -->
            <div class="identity-title">
              <span class="identity-label">Layer:</span>
              <h2>{{ selectedTpl.alias || selectedTpl.key }}</h2>
              <code>{{ selectedTpl.key }}</code>
              <!-- Same sync status the picker shows, so the editor and the
                   dropdown agree (e.g. both read DISABLED, not one BUNDLED). -->
              <span v-if="hasLocalDraft" class="local-badge" title="Unpublished local draft in this browser">local</span>
              <TemplateStatusBadge :status="sync.badgeFor(editName)" />
            </div>
            <!-- Disable / Reactivate. Sits by the title, away from the
                 save/push cluster. A disabled layer offers Reactivate
                 (re-enable on OAP); otherwise Disable/Delete. -->
            <div class="identity-delete">
              <button
                v-if="isLayerDisabled"
                class="sw-btn"
                type="button"
                :disabled="isSaving || sync.readOnly.value"
                :title="sync.readOnly.value
                  ? 'OAP unreachable — cannot reactivate'
                  : `Reactivate the ${selectedTpl.key} layer (re-enable on OAP)`"
                @click="askReactivateLayer"
              >
                Reactivate
              </button>
              <button
                v-else
                class="sw-btn danger"
                type="button"
                :disabled="isSaving || (sync.readOnly.value && (remoteAvailable || bundledExists))"
                :title="(sync.readOnly.value && (remoteAvailable || bundledExists))
                  ? 'OAP unreachable — cannot delete'
                  : bundledExists
                    ? `Disable the built-in ${selectedTpl.key} layer (hidden from the sidebar; Reactivate to bring it back)`
                    : remoteAvailable
                      ? `Delete the ${selectedTpl.key} layer template (soft-disabled on OAP)`
                      : `Remove the local draft for ${selectedTpl.key}`"
                @click="askDeleteLayer"
              >
                {{ bundledExists ? 'Disable' : 'Delete' }}
              </button>
            </div>
            <div class="actions">
              <span v-if="saveMsg" class="save-msg">{{ saveMsg }}</span>
              <!-- Where the editor content was loaded from — distinct from
                   the sync-status chip by the title (prefixed "from "). -->
              <span
                v-if="editorSource === 'local' || !isSynced"
                class="src-tag"
                :title="`Editing from: ${editorSource}`"
              >from {{ editorSource }}</span>
              <!-- Reset the editor to a source (discard current content). -->
              <div class="reset-dd">
                <button class="sw-btn" type="button" @click="resetDropdownOpen = !resetDropdownOpen">
                  Reset to <span class="caret" :class="{ open: resetDropdownOpen }">›</span>
                </button>
                <template v-if="resetDropdownOpen">
                  <div class="reset-dd-backdrop" @click="resetDropdownOpen = false" />
                  <div class="reset-dd-pop">
                    <button
                      v-if="!isSynced"
                      class="reset-dd-item"
                      type="button"
                      title="Discard current edits and reload the bundled (shipped) default."
                      @click="resetTo('bundled')"
                    >
                      Bundled
                    </button>
                    <button
                      class="reset-dd-item"
                      type="button"
                      :disabled="!remoteAvailable"
                      :title="remoteAvailable ? 'Discard current edits and reload OAP\'s live version.' : 'OAP has no copy of this template yet.'"
                      @click="resetTo('remote')"
                    >
                      Remote
                    </button>
                  </div>
                </template>
              </div>
              <!-- Preview the real page rendering a chosen source. -->
              <div class="reset-dd">
                <button class="sw-btn" type="button" @click="previewDropdownOpen = !previewDropdownOpen">
                  Preview <span class="caret" :class="{ open: previewDropdownOpen }">›</span>
                </button>
                <template v-if="previewDropdownOpen">
                  <div class="reset-dd-backdrop" @click="previewDropdownOpen = false" />
                  <div class="reset-dd-pop">
                    <button class="reset-dd-item" type="button" :disabled="!hasLocalDraft" title="Preview your unpublished local draft." @click="previewLive('local')">Local</button>
                    <button v-if="!isSynced" class="reset-dd-item" type="button" title="Preview the bundled (shipped) default." @click="previewLive('bundled')">Bundled</button>
                    <button class="reset-dd-item" type="button" :disabled="!remoteAvailable" title="Preview OAP's live version." @click="previewLive('remote')">Remote</button>
                  </div>
                </template>
              </div>
              <!-- Publish local → remote. Enabled only when local differs
                   from remote; click shows the diff before pushing. -->
              <button
                v-if="!sync.readOnly.value"
                class="sw-btn"
                type="button"
                :disabled="!localDiffersFromRemote || isSaving"
                :title="localDiffersFromRemote ? 'Review the local → remote diff, then publish to OAP.' : 'No local changes to publish — local matches remote.'"
                @click="pushDiffOpen = true"
              >
                Check diff &amp; push
              </button>
              <button
                class="sw-btn is-primary"
                type="button"
                :disabled="!dirty || isSaving"
                title="Save the editor to your browser (local). Publish later with “Push local → OAP”."
                @click="save"
              >
                {{ isSaving ? 'Saving…' : 'Save (local)' }}
              </button>
            </div>
          </div>
          <!-- Sidebar placement: `public` (default) → regular Layers
               section. `operate` → operations block (alongside Cluster,
               DSL Management, etc.). Use for layers that an operator
               manages but a regular UI user doesn't need surfaced
               next to user-facing application layers — self-obs
               (OAP / Satellite / agent self-obs) is the canonical
               example. -->
          <div class="visibility-row">
            <label class="vis-label">Sidebar placement</label>
            <div class="vis-options">
              <label
                class="vis-opt"
                :class="{ on: (selectedTpl.visibility ?? 'public') === 'public' }"
              >
                <input
                  type="radio"
                  name="visibility"
                  value="public"
                  :checked="(selectedTpl.visibility ?? 'public') === 'public'"
                  @change="setVisibility('public')"
                />
                <span class="vis-opt-body">
                  <span class="vis-opt-title">Public</span>
                  <span class="vis-opt-hint">Shows in the user-facing Layers section</span>
                </span>
              </label>
              <label
                class="vis-opt"
                :class="{ on: selectedTpl.visibility === 'operate' }"
              >
                <input
                  type="radio"
                  name="visibility"
                  value="operate"
                  :checked="selectedTpl.visibility === 'operate'"
                  @change="setVisibility('operate')"
                />
                <span class="vis-opt-body">
                  <span class="vis-opt-title">Operate</span>
                  <span class="vis-opt-hint">Shows in the operations / self-observability section</span>
                </span>
              </label>
            </div>
          </div>
        </section>

        <!-- Layer setup: left = live menu preview (alias header + the
             enabled components, in checkbox order — clicking an item
             jumps to that component's config + preview below). Right =
             alias edit (before Components, per request) + the Components
             toggles that drive which menu entries exist. -->
        <section class="sw-card setup-card">
          <div class="setup-grid">
            <div class="menu-preview">
              <div class="menu-preview-head">
                <span class="dot inline" :style="{ background: selectedTpl.color || 'var(--sw-fg-3)' }" />
                <span class="menu-preview-title">{{ selectedTpl.alias || selectedTpl.key }}</span>
                <code v-if="selectedTpl.alias && selectedTpl.alias !== selectedTpl.key" class="key-tag">{{ selectedTpl.key }}</code>
              </div>
              <p v-if="menuItems.length === 0" class="menu-preview-empty">
                No components enabled — toggle one on the right to populate the menu.
              </p>
              <button
                v-for="m in menuItems"
                :key="m.key"
                type="button"
                class="menu-item"
                :class="{ on: activeScope === m.scope }"
                :title="`Jump to ${m.label} config`"
                @click="jumpToComponent(m.scope)"
              >
                <span class="menu-item-label">{{ m.label }}</span>
                <span class="menu-item-arrow">›</span>
              </button>
            </div>
            <div class="setup-right">
              <label class="alias-field">
                <span>Alias</span>
                <input
                  v-model="selectedTpl.alias"
                  type="text"
                  class="alias-input"
                  :placeholder="selectedTpl.key"
                  spellcheck="false"
                />
                <span class="alias-hint">Display name in the sidebar, layer list, and landing KPI tile. Defaults to the layer key.</span>
              </label>
              <div class="setup-section-head">
                <h4>Components</h4>
                <span class="sub">which sub-views this layer exposes</span>
              </div>
              <div class="comp-grid">
                <label
                  v-for="t in COMPONENT_TOGGLES"
                  :key="t.key"
                  class="comp-toggle"
                  :class="{ on: !!selectedTpl.components?.[t.key] }"
                  :title="t.hint"
                >
                  <input
                    type="checkbox"
                    :checked="!!selectedTpl.components?.[t.key]"
                    @change="toggleComponent(t.key)"
                  />
                  <span class="comp-label">{{ t.label }}</span>
                </label>
              </div>
              <!-- Menu labels (slot aliases): rename the per-component
                   nouns the way the layer's own vocabulary reads (e.g.
                   services → "ClickHouse clusters", instances → "Nodes").
                   Shown only for enabled components; drives the menu
                   preview, scope tabs, and section headings live. -->
              <template v-if="visibleAliasFields.length > 0">
                <div class="setup-section-head">
                  <h4>Menu labels</h4>
                  <span class="sub">rename the nouns shown in the menu &amp; tabs (optional)</span>
                </div>
                <div class="alias-grid">
                  <label v-for="f in visibleAliasFields" :key="f.slot" class="alias-grid-field">
                    <span>{{ f.label }}</span>
                    <input
                      type="text"
                      class="alias-input sm"
                      :value="selectedTpl.slots?.[f.slot] ?? ''"
                      :placeholder="f.def"
                      spellcheck="false"
                      @input="setSlot(f.slot, ($event.target as HTMLInputElement).value)"
                    />
                  </label>
                </div>
              </template>
            </div>
          </div>
        </section>

        <!-- Topology cluster setup: a named-capture regex run against
             every service name. The topology view buckets nodes by the
             resolved cluster value (e.g. k8s namespace) and renders an
             `<alias · value>` chip next to the service display label.
             Distinct from the layer-agnostic OAP `<group>::<base>`
             prefix convention, which is global and never produces a
             topology cluster — clusters are explicit per-layer opt-in.
             Live tester at the bottom evaluates the current draft
             against a sample name so the operator can see the result
             before saving. -->
        <section
          v-if="selectedTpl.components?.topology"
          id="topology-cluster"
          class="sw-card components-card"
        >
          <div class="card-head">
            <h4>Topology cluster setup</h4>
            <span class="sub">parse service name → display label + cluster dimension (k8s/mesh namespace, tenant, fleet, …)</span>
            <button
              v-if="!selectedTpl.naming"
              class="sw-btn add"
              type="button"
              @click="enableNaming"
            >＋ Enable rule</button>
            <button
              v-else
              class="sw-btn small ghost danger"
              type="button"
              @click="disableNaming"
            >Remove rule</button>
          </div>
          <div v-if="!selectedTpl.naming" class="topo-cfg-help" style="padding: 12px 16px;">
            No cluster rule configured — the topology view renders without cluster bounding
            boxes. Enable a rule for layers whose service names encode a cluster dimension
            (k8s namespace, fleet, tenant) so topology can cluster nodes accordingly.
          </div>
          <div v-else class="naming-body">
            <div class="naming-row">
              <label class="mf mf-wide">
                <span>regex pattern</span>
                <input
                  v-model="selectedTpl.naming.pattern"
                  class="mf-input mono"
                  type="text"
                  spellcheck="false"
                  placeholder="^(?<service>[^.]+)\.(?<namespace>[^.]+)$"
                />
              </label>
              <label class="mf mf-narrow" title="JavaScript regex flags: i = case-insensitive, m = multiline, s = dotall, u = unicode. Service names are case-sensitive single-line strings, so this is almost always empty.">
                <span>regex flags</span>
                <input
                  v-model="selectedTpl.naming.flags"
                  class="mf-input mono"
                  type="text"
                  spellcheck="false"
                  placeholder="(empty)"
                />
              </label>
            </div>
            <div class="naming-flags-hint">
              <code>flags</code> are passed as the second argument to
              <code>new RegExp(pattern, flags)</code>. Common values: <code>i</code>
              (case-insensitive), <code>m</code> (multiline). Leave empty for typical
              k8s/mesh service names.
            </div>
            <div class="naming-row">
              <label class="mf">
                <span>display capture</span>
                <input
                  v-model="selectedTpl.naming.displayGroup"
                  class="mf-input mono"
                  type="text"
                  placeholder="service"
                />
              </label>
              <label class="mf">
                <span>cluster capture</span>
                <input
                  v-model="selectedTpl.naming.valueGroup"
                  class="mf-input mono"
                  type="text"
                  placeholder="namespace"
                />
              </label>
              <label class="mf">
                <span>alias (cluster label)</span>
                <input
                  v-model="selectedTpl.naming.alias"
                  class="mf-input"
                  type="text"
                  placeholder="namespace"
                />
              </label>
            </div>
            <div class="naming-test">
              <label class="mf mf-wide">
                <span>test service name</span>
                <input
                  v-model="namingSample"
                  class="mf-input mono"
                  type="text"
                  spellcheck="false"
                  placeholder="songs.sample"
                />
              </label>
              <div class="naming-result" :class="{ ok: namingTest.ok, err: !namingTest.ok }">
                <div v-if="namingTest.error" class="naming-error">
                  <span class="naming-tag">error</span>
                  <span>{{ namingTest.error }}</span>
                </div>
                <template v-else>
                  <div class="naming-result-row">
                    <span class="naming-tag">display</span>
                    <span class="mono">{{ namingTest.display ?? '—' }}</span>
                  </div>
                  <div class="naming-result-row">
                    <span class="naming-tag">{{ namingTest.alias ?? 'group' }}</span>
                    <span class="mono accent">{{ namingTest.group ?? '—' }}</span>
                  </div>
                </template>
              </div>
            </div>
          </div>
        </section>

        <!-- Service-list metrics: the columns shown in the picker
             zone's services table + the default sort. Used across
             the per-layer page. -->
        <section class="sw-card metrics-card">
          <div class="card-head">
            <h4>Service list metrics</h4>
            <span class="sub">columns + default sort for the service list (picker zone)</span>
            <button class="sw-btn add" type="button" @click="addMetricColumn">＋ Add column</button>
          </div>
          <div v-if="metricsModel" class="metrics-keys">
            <label>
              <span>Default sort (orderBy)</span>
              <select v-model="metricsModel.orderBy">
                <option :value="undefined">(first column)</option>
                <option v-for="c in metricsColumns" :key="c.metric" :value="c.metric">{{ c.metric }}</option>
              </select>
            </label>
          </div>
          <div v-if="metricsColumns.length === 0" class="empty inset">
            No metric columns defined. Click "Add column" to start.
          </div>
          <table v-else class="sw-table metrics-table">
            <thead>
              <tr>
                <th>metric</th>
                <th>label</th>
                <th>unit</th>
                <th>aggregation</th>
                <th class="grow">mqe</th>
                <th>scale</th>
                <th>precision</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(c, i) in metricsColumns" :key="i">
                <td><input class="mono" v-model="c.metric" /></td>
                <td><input v-model="c.label" /></td>
                <td><input v-model="c.unit" placeholder="—" /></td>
                <td>
                  <select v-model="c.aggregation">
                    <option value="sum">sum</option>
                    <option value="avg">avg</option>
                  </select>
                </td>
                <td><input class="mono" v-model="c.mqe" placeholder="catalog default" /></td>
                <td><input type="number" step="any" v-model.number="c.scale" placeholder="1" /></td>
                <td><input type="number" min="0" max="6" v-model.number="c.precision" placeholder="auto" /></td>
                <td>
                  <button class="sw-btn is-icon danger" type="button" title="Remove column" @click="deleteMetricColumn(i)">✕</button>
                </td>
              </tr>
            </tbody>
          </table>
          <!-- Preview: the per-layer landing KPI tile (headline + trend)
               at the head — its config picks WHICH service-list column
               feeds the tile, no new metrics — then the service-list
               sample table. Mock values, no MQE fired. -->
          <div v-if="metricsColumns.length > 0" class="metrics-preview">
            <div class="metrics-preview-head">
              Preview <span class="sub">how this layer’s landing KPI tile + service list render (sample data)</span>
            </div>
            <div v-if="overviewModel" class="kpi-block">
              <div class="kpi-config">
                <div class="kpi-config-title">Landing KPI tile <span class="sub">which column is the headline + trend</span></div>
                <label>
                  <span>Headline (throughput)</span>
                  <select v-model="overviewModel.throughput">
                    <option :value="undefined">(default sort)</option>
                    <option v-for="c in metricsColumns" :key="c.metric" :value="c.metric">{{ c.label || c.metric }}</option>
                  </select>
                </label>
                <label>
                  <span>Trend line (spark)</span>
                  <select v-model="overviewModel.spark">
                    <option :value="undefined">(headline)</option>
                    <option v-for="c in metricsColumns" :key="c.metric" :value="c.metric">{{ c.label || c.metric }}</option>
                  </select>
                </label>
              </div>
              <!-- Faithful copy of the real layer header (LayerShell):
                   icon tile + identity + the kpi-strip. Reuses the same
                   class names + the Sparkline component so the preview
                   matches the live page. -->
              <header class="sw-card preview-layer-head">
                <div class="layer-id-row">
                  <div class="icon-tile" :style="{ background: selectedTpl.color || 'var(--sw-fg-3)' }">{{ previewInitials }}</div>
                  <div class="identity-text">
                    <div class="title-row"><h1>{{ selectedTpl.alias || selectedTpl.key }}</h1></div>
                    <div class="sub">{{ SAMPLE_SERVICES.length }} {{ (selectedTpl.slots?.services || 'services').toLowerCase() }}</div>
                  </div>
                  <div class="kpi-strip">
                    <div class="kpi">
                      <div class="kpi-label">
                        {{ kpiHeadlineCol?.label || kpiHeadlineCol?.metric || '—' }}<span v-if="kpiHeadlineCol?.unit" class="unit">({{ kpiHeadlineCol.unit }})</span>
                      </div>
                      <div class="kpi-value">{{ kpiHeadlineValue }}</div>
                      <Sparkline class="kpi-spark" :values="kpiSparkValues" :width="84" :height="18" color="var(--sw-accent)" :stroke="1.25" />
                    </div>
                  </div>
                </div>
              </header>
            </div>
            <div class="metrics-preview-scroll">
              <table class="sw-table preview-table">
                <thead>
                  <tr>
                    <th>{{ scopeLabel('service') }}</th>
                    <th v-for="c in metricsColumns" :key="c.metric" class="num">
                      {{ c.label || c.metric }}
                      <span v-if="effectiveOrderBy === c.metric" class="sort-ind" title="default sort">↓</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="(svc, r) in SAMPLE_SERVICES" :key="svc">
                    <td class="svc">{{ svc }}</td>
                    <td v-for="(c, ci) in metricsColumns" :key="c.metric" class="num">{{ previewCell(c, r + ci) }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </section>

        <!-- Scope tabs -->
        <nav id="scope-editor" class="scope-tabs sw-card">
          <button
            v-for="s in visibleScopes"
            :key="s"
            class="scope-tab"
            :class="{ on: activeScope === s }"
            type="button"
            @click="activeScope = s"
          >
            {{ scopeLabel(s) }}
            <span class="count">{{ widgetsFor(s).length }}</span>
          </button>
        </nav>

        <!-- Widget editor: canvas + drawer.
             Canvas (left): 12-col grid background, widgets placed at
             their span/rowSpan. Click selects, drag header reorders,
             drag bottom-right corner resizes. Previews use mock data
             so the layout reads as a real dashboard without firing
             MQE per keystroke.
             Drawer (right): config fields for the selected widget.
             Hidden when nothing is selected so the canvas gets the
             full width. -->
        <!-- Topology + API dependency config editor — node + line
             metric definitions, with optional 4-band thresholds.
             Each metric edits id / label / MQE / unit / role /
             aggregation; thresholds are a collapsible block. -->
        <section
          v-if="activeScope === 'topology'"
          class="sw-card editor-card topo-cfg-card"
        >
          <div class="card-head">
            <h4>Topology config</h4>
            <span class="sub">node + server-side + client-side line metrics. Add rows; bind a metric to a visual role.</span>
          </div>
          <div class="topo-cluster-pointer">
            <span class="topo-cluster-pointer-icon">⤴</span>
            <span>
              Cluster setup (k8s/mesh namespace grouping) lives in
              <a href="#topology-cluster" @click.prevent="scrollToClusterCard">Topology cluster setup</a>
              above.
            </span>
          </div>
          <!-- showGroup: per-topology toggle for the legacy `<group>::`
               prefix chip in the node detail panel. Off (default) ⇒
               prefix never appears in the UI. On ⇒ surfaces as its own
               chip in the panel header. Topology node labels stay
               clean regardless. -->
          <div class="naming-prefix-row">
            <label class="comp-toggle" :class="{ on: showGroupForScope }">
              <input
                type="checkbox"
                :checked="showGroupForScope"
                @change="toggleShowGroup"
              />
              <span class="comp-label">Show <code>&lt;group&gt;::</code> as a chip in the node panel</span>
            </label>
            <span class="naming-prefix-hint">
              Off: <code>mesh-svr::reviews</code> reads as <code>reviews</code> everywhere.
              On: <code>mesh-svr</code> appears as a separate chip in the clicked-node panel.
              Topology graph labels are always pure service names.
            </span>
          </div>
          <div class="topo-cfg-body">
            <div class="topo-cfg-section">
              <header class="topo-cfg-head">
                <h5>Node metrics</h5>
                <span class="sub">drives node center number + ring colour band</span>
                <button class="sw-btn add" type="button" @click="addMetric('node')">＋ Add</button>
              </header>
              <div v-if="topologyNodeMetrics.length === 0" class="topo-cfg-empty">No node metrics. Click "+ Add" to start.</div>
              <div v-else class="metric-list">
                <article v-for="(m, i) in topologyNodeMetrics" :key="i" class="metric-row">
                  <div class="metric-row-head">
                    <label class="mf">
                      <span>id</span>
                      <input v-model="m.id" type="text" class="mf-input mono" />
                    </label>
                    <label class="mf">
                      <span>label</span>
                      <input v-model="m.label" type="text" class="mf-input" />
                    </label>
                    <label class="mf mf-wide">
                      <span>MQE</span>
                      <input v-model="m.mqe" type="text" class="mf-input mono" placeholder="service_cpm" />
                    </label>
                    <label class="mf mf-narrow">
                      <span>unit</span>
                      <input v-model="m.unit" type="text" class="mf-input" placeholder="rpm" />
                    </label>
                    <label class="mf">
                      <span>role</span>
                      <select v-model="m.role" class="mf-input">
                        <option v-for="o in TOPOLOGY_ROLE_OPTIONS" :key="String(o.value)" :value="o.value || undefined">{{ o.label }}</option>
                      </select>
                    </label>
                    <label class="mf mf-narrow">
                      <span>agg</span>
                      <select v-model="m.aggregation" class="mf-input">
                        <option value="avg">avg</option>
                        <option value="sum">sum</option>
                      </select>
                    </label>
                    <div class="metric-row-actions">
                      <button class="sw-btn small ghost" type="button" :disabled="i === 0" title="Move up" @click="moveMetric('node', i, -1)">↑</button>
                      <button class="sw-btn small ghost" type="button" :disabled="i === topologyNodeMetrics.length - 1" title="Move down" @click="moveMetric('node', i, 1)">↓</button>
                      <button class="sw-btn small ghost danger" type="button" title="Remove" @click="removeMetric('node', i)">×</button>
                    </div>
                  </div>
                  <div class="metric-thresholds">
                    <button class="sw-btn small ghost" type="button" @click="toggleThresholds(m)">
                      {{ m.thresholds ? '− Thresholds' : '＋ Thresholds' }}
                    </button>
                    <template v-if="m.thresholds">
                      <label class="mf mf-narrow"><span>ok ≤</span><input v-model.number="m.thresholds.ok" type="number" step="0.1" class="mf-input" /></label>
                      <label class="mf mf-narrow"><span>warn ≤</span><input v-model.number="m.thresholds.warn" type="number" step="0.1" class="mf-input" /></label>
                      <label class="mf mf-narrow"><span>danger ≤</span><input v-model.number="m.thresholds.danger" type="number" step="0.1" class="mf-input" /></label>
                      <label class="mf mf-checkbox">
                        <input v-model="m.thresholds.invertHealth" type="checkbox" />
                        <span>invert (higher = better)</span>
                      </label>
                      <label v-if="m.thresholds.invertHealth" class="mf mf-narrow">
                        <span>base</span>
                        <input v-model.number="m.thresholds.invertBase" type="number" step="1" class="mf-input" placeholder="100" />
                      </label>
                    </template>
                  </div>
                </article>
              </div>
            </div>

            <div class="topo-cfg-section">
              <header class="topo-cfg-head">
                <h5>Link · server-side metrics</h5>
                <span class="sub">edge metrics queried as <code>service_relation_server_*</code></span>
                <button class="sw-btn add" type="button" @click="addMetric('linkServer')">＋ Add</button>
              </header>
              <div v-if="topologyServerMetrics.length === 0" class="topo-cfg-empty">No server-side metrics.</div>
              <div v-else class="metric-list">
                <article v-for="(m, i) in topologyServerMetrics" :key="i" class="metric-row">
                  <div class="metric-row-head">
                    <label class="mf"><span>id</span><input v-model="m.id" type="text" class="mf-input mono" /></label>
                    <label class="mf"><span>label</span><input v-model="m.label" type="text" class="mf-input" /></label>
                    <label class="mf mf-wide"><span>MQE</span><input v-model="m.mqe" type="text" class="mf-input mono" /></label>
                    <label class="mf mf-narrow"><span>unit</span><input v-model="m.unit" type="text" class="mf-input" /></label>
                    <label class="mf mf-narrow"><span>agg</span>
                      <select v-model="m.aggregation" class="mf-input">
                        <option value="avg">avg</option>
                        <option value="sum">sum</option>
                      </select>
                    </label>
                    <div class="metric-row-actions">
                      <button class="sw-btn small ghost" type="button" :disabled="i === 0" @click="moveMetric('linkServer', i, -1)">↑</button>
                      <button class="sw-btn small ghost" type="button" :disabled="i === topologyServerMetrics.length - 1" @click="moveMetric('linkServer', i, 1)">↓</button>
                      <button class="sw-btn small ghost danger" type="button" @click="removeMetric('linkServer', i)">×</button>
                    </div>
                  </div>
                </article>
              </div>
            </div>

            <div class="topo-cfg-section">
              <header class="topo-cfg-head">
                <h5>Link · client-side metrics</h5>
                <span class="sub">edge metrics queried as <code>service_relation_client_*</code></span>
                <button class="sw-btn add" type="button" @click="addMetric('linkClient')">＋ Add</button>
              </header>
              <div v-if="topologyClientMetrics.length === 0" class="topo-cfg-empty">No client-side metrics.</div>
              <div v-else class="metric-list">
                <article v-for="(m, i) in topologyClientMetrics" :key="i" class="metric-row">
                  <div class="metric-row-head">
                    <label class="mf"><span>id</span><input v-model="m.id" type="text" class="mf-input mono" /></label>
                    <label class="mf"><span>label</span><input v-model="m.label" type="text" class="mf-input" /></label>
                    <label class="mf mf-wide"><span>MQE</span><input v-model="m.mqe" type="text" class="mf-input mono" /></label>
                    <label class="mf mf-narrow"><span>unit</span><input v-model="m.unit" type="text" class="mf-input" /></label>
                    <label class="mf mf-narrow"><span>agg</span>
                      <select v-model="m.aggregation" class="mf-input">
                        <option value="avg">avg</option>
                        <option value="sum">sum</option>
                      </select>
                    </label>
                    <div class="metric-row-actions">
                      <button class="sw-btn small ghost" type="button" :disabled="i === 0" @click="moveMetric('linkClient', i, -1)">↑</button>
                      <button class="sw-btn small ghost" type="button" :disabled="i === topologyClientMetrics.length - 1" @click="moveMetric('linkClient', i, 1)">↓</button>
                      <button class="sw-btn small ghost danger" type="button" @click="removeMetric('linkClient', i)">×</button>
                    </div>
                  </div>
                </article>
              </div>
            </div>
          </div>
        </section>

        <section
          v-else-if="activeScope === 'dependency'"
          class="sw-card editor-card topo-cfg-card"
        >
          <div class="card-head">
            <h4>API dependency config</h4>
            <span class="sub">node + line metrics (server-side only — OAP has no endpoint client family).</span>
          </div>
          <div class="naming-prefix-row">
            <label class="comp-toggle" :class="{ on: showGroupForScope }">
              <input
                type="checkbox"
                :checked="showGroupForScope"
                @change="toggleShowGroup"
              />
              <span class="comp-label">Show <code>&lt;group&gt;::</code> as a chip in the node panel</span>
            </label>
            <span class="naming-prefix-hint">Same semantics as the topology view's flag.</span>
          </div>
          <div class="topo-cfg-body">
            <div class="topo-cfg-section">
              <header class="topo-cfg-head">
                <h5>Node metrics</h5>
                <span class="sub">drives endpoint box center number + SLA-coloured border</span>
                <button class="sw-btn add" type="button" @click="addMetric('node')">＋ Add</button>
              </header>
              <div v-if="epDepNodeMetrics.length === 0" class="topo-cfg-empty">No node metrics.</div>
              <div v-else class="metric-list">
                <article v-for="(m, i) in epDepNodeMetrics" :key="i" class="metric-row">
                  <div class="metric-row-head">
                    <label class="mf"><span>id</span><input v-model="m.id" type="text" class="mf-input mono" /></label>
                    <label class="mf"><span>label</span><input v-model="m.label" type="text" class="mf-input" /></label>
                    <label class="mf mf-wide"><span>MQE</span><input v-model="m.mqe" type="text" class="mf-input mono" placeholder="endpoint_cpm" /></label>
                    <label class="mf mf-narrow"><span>unit</span><input v-model="m.unit" type="text" class="mf-input" /></label>
                    <label class="mf">
                      <span>role</span>
                      <select v-model="m.role" class="mf-input">
                        <option v-for="o in TOPOLOGY_ROLE_OPTIONS" :key="String(o.value)" :value="o.value || undefined">{{ o.label }}</option>
                      </select>
                    </label>
                    <label class="mf mf-narrow"><span>agg</span>
                      <select v-model="m.aggregation" class="mf-input">
                        <option value="avg">avg</option>
                        <option value="sum">sum</option>
                      </select>
                    </label>
                    <div class="metric-row-actions">
                      <button class="sw-btn small ghost" type="button" :disabled="i === 0" @click="moveMetric('node', i, -1)">↑</button>
                      <button class="sw-btn small ghost" type="button" :disabled="i === epDepNodeMetrics.length - 1" @click="moveMetric('node', i, 1)">↓</button>
                      <button class="sw-btn small ghost danger" type="button" @click="removeMetric('node', i)">×</button>
                    </div>
                  </div>
                  <div class="metric-thresholds">
                    <button class="sw-btn small ghost" type="button" @click="toggleThresholds(m)">
                      {{ m.thresholds ? '− Thresholds' : '＋ Thresholds' }}
                    </button>
                    <template v-if="m.thresholds">
                      <label class="mf mf-narrow"><span>ok ≤</span><input v-model.number="m.thresholds.ok" type="number" step="0.1" class="mf-input" /></label>
                      <label class="mf mf-narrow"><span>warn ≤</span><input v-model.number="m.thresholds.warn" type="number" step="0.1" class="mf-input" /></label>
                      <label class="mf mf-narrow"><span>danger ≤</span><input v-model.number="m.thresholds.danger" type="number" step="0.1" class="mf-input" /></label>
                      <label class="mf mf-checkbox">
                        <input v-model="m.thresholds.invertHealth" type="checkbox" />
                        <span>invert (higher = better)</span>
                      </label>
                      <label v-if="m.thresholds.invertHealth" class="mf mf-narrow">
                        <span>base</span>
                        <input v-model.number="m.thresholds.invertBase" type="number" step="1" class="mf-input" placeholder="100" />
                      </label>
                    </template>
                  </div>
                </article>
              </div>
            </div>

            <div class="topo-cfg-section">
              <header class="topo-cfg-head">
                <h5>Link metrics (server-side)</h5>
                <span class="sub">edge metrics queried as <code>endpoint_relation_*</code></span>
                <button class="sw-btn add" type="button" @click="addMetric('link')">＋ Add</button>
              </header>
              <div v-if="epDepLinkMetrics.length === 0" class="topo-cfg-empty">No link metrics.</div>
              <div v-else class="metric-list">
                <article v-for="(m, i) in epDepLinkMetrics" :key="i" class="metric-row">
                  <div class="metric-row-head">
                    <label class="mf"><span>id</span><input v-model="m.id" type="text" class="mf-input mono" /></label>
                    <label class="mf"><span>label</span><input v-model="m.label" type="text" class="mf-input" /></label>
                    <label class="mf mf-wide"><span>MQE</span><input v-model="m.mqe" type="text" class="mf-input mono" /></label>
                    <label class="mf mf-narrow"><span>unit</span><input v-model="m.unit" type="text" class="mf-input" /></label>
                    <label class="mf mf-narrow"><span>agg</span>
                      <select v-model="m.aggregation" class="mf-input">
                        <option value="avg">avg</option>
                        <option value="sum">sum</option>
                      </select>
                    </label>
                    <div class="metric-row-actions">
                      <button class="sw-btn small ghost" type="button" :disabled="i === 0" @click="moveMetric('link', i, -1)">↑</button>
                      <button class="sw-btn small ghost" type="button" :disabled="i === epDepLinkMetrics.length - 1" @click="moveMetric('link', i, 1)">↓</button>
                      <button class="sw-btn small ghost danger" type="button" @click="removeMetric('link', i)">×</button>
                    </div>
                  </div>
                </article>
              </div>
            </div>
          </div>
        </section>

        <section
          v-else-if="activeScope === 'networkProfiling'"
          class="sw-card editor-card topo-cfg-card"
        >
          <div class="card-head">
            <h4>Network profiling — process-relation config</h4>
            <span class="sub">edge MQE for the process-topology detail panel. Queried under ProcessRelation when an operator clicks a process→process call.</span>
          </div>
          <div class="topo-cfg-body">
            <div class="topo-cfg-section">
              <header class="topo-cfg-head">
                <h5>Client-side metrics</h5>
                <span class="sub">edge metrics queried as <code>process_relation_client_*</code></span>
                <button class="sw-btn add" type="button" @click="addMetric('edgeClient')">＋ Add</button>
              </header>
              <div v-if="processEdgeClientMetrics.length === 0" class="topo-cfg-empty">No client-side metrics.</div>
              <div v-else class="metric-list">
                <article v-for="(m, i) in processEdgeClientMetrics" :key="i" class="metric-row">
                  <div class="metric-row-head">
                    <label class="mf"><span>id</span><input v-model="m.id" type="text" class="mf-input mono" /></label>
                    <label class="mf"><span>label</span><input v-model="m.label" type="text" class="mf-input" /></label>
                    <label class="mf mf-wide"><span>MQE</span><input v-model="m.mqe" type="text" class="mf-input mono" placeholder="process_relation_client_write_cpm" /></label>
                    <label class="mf mf-narrow"><span>unit</span><input v-model="m.unit" type="text" class="mf-input" /></label>
                    <label class="mf mf-narrow"><span>agg</span>
                      <select v-model="m.aggregation" class="mf-input">
                        <option value="avg">avg</option>
                        <option value="sum">sum</option>
                      </select>
                    </label>
                    <div class="metric-row-actions">
                      <button class="sw-btn small ghost" type="button" :disabled="i === 0" @click="moveMetric('edgeClient', i, -1)">↑</button>
                      <button class="sw-btn small ghost" type="button" :disabled="i === processEdgeClientMetrics.length - 1" @click="moveMetric('edgeClient', i, 1)">↓</button>
                      <button class="sw-btn small ghost danger" type="button" @click="removeMetric('edgeClient', i)">×</button>
                    </div>
                  </div>
                </article>
              </div>
            </div>

            <div class="topo-cfg-section">
              <header class="topo-cfg-head">
                <h5>Server-side metrics</h5>
                <span class="sub">edge metrics queried as <code>process_relation_server_*</code></span>
                <button class="sw-btn add" type="button" @click="addMetric('edgeServer')">＋ Add</button>
              </header>
              <div v-if="processEdgeServerMetrics.length === 0" class="topo-cfg-empty">No server-side metrics.</div>
              <div v-else class="metric-list">
                <article v-for="(m, i) in processEdgeServerMetrics" :key="i" class="metric-row">
                  <div class="metric-row-head">
                    <label class="mf"><span>id</span><input v-model="m.id" type="text" class="mf-input mono" /></label>
                    <label class="mf"><span>label</span><input v-model="m.label" type="text" class="mf-input" /></label>
                    <label class="mf mf-wide"><span>MQE</span><input v-model="m.mqe" type="text" class="mf-input mono" placeholder="process_relation_server_write_cpm" /></label>
                    <label class="mf mf-narrow"><span>unit</span><input v-model="m.unit" type="text" class="mf-input" /></label>
                    <label class="mf mf-narrow"><span>agg</span>
                      <select v-model="m.aggregation" class="mf-input">
                        <option value="avg">avg</option>
                        <option value="sum">sum</option>
                      </select>
                    </label>
                    <div class="metric-row-actions">
                      <button class="sw-btn small ghost" type="button" :disabled="i === 0" @click="moveMetric('edgeServer', i, -1)">↑</button>
                      <button class="sw-btn small ghost" type="button" :disabled="i === processEdgeServerMetrics.length - 1" @click="moveMetric('edgeServer', i, 1)">↓</button>
                      <button class="sw-btn small ghost danger" type="button" @click="removeMetric('edgeServer', i)">×</button>
                    </div>
                  </div>
                </article>
              </div>
            </div>
          </div>
        </section>

        <!-- Trace + Logs are built-in views with no per-layer config
             other than enable/disable, which is already handled via
             the Components toggle in the right sidebar. -->
        <section
          v-else-if="activeScope === 'trace' || activeScope === 'logs'"
          class="sw-card editor-card topo-cfg-card"
        >
          <div class="card-head">
            <h4>{{ scopeLabel(activeScope) }} tab</h4>
            <span class="sub">
              {{ activeScope === 'trace'
                ? 'Pick the trace backend this layer reads from.'
                : 'No per-layer config required — toggle visibility via Components in the right sidebar.' }}
            </span>
          </div>
          <div class="topo-cfg-body">
            <div v-if="activeScope === 'trace'" class="trace-source-cfg">
              <div class="trace-source-head">Trace source</div>
              <div class="trace-source-opts">
                <label
                  v-for="o in TRACE_SOURCE_OPTIONS"
                  :key="o.value"
                  class="trace-source-opt"
                  :class="{ on: traceSource === o.value }"
                >
                  <input
                    type="radio"
                    name="trace-source"
                    :value="o.value"
                    :checked="traceSource === o.value"
                    @change="traceSource = o.value"
                  />
                  <span class="ts-label">{{ o.label }}</span>
                  <span class="ts-hint">{{ o.hint }}</span>
                </label>
              </div>
            </div>
            <p v-else class="topo-cfg-help">
              The <b>{{ scopeLabel(activeScope) }}</b> tab is a built-in view that uses
              SkyWalking-native query-protocol APIs directly. Operators configure filters
              and time range at runtime from the page itself; nothing to wire up here.
            </p>
          </div>
        </section>

        <section v-else class="sw-card editor-card">
          <div class="card-head">
            <h4>{{ scopeLabel(activeScope) }} widgets</h4>
            <span class="sub">
              click a widget to edit · drag corner to resize · drag header to reorder
            </span>
            <button class="sw-btn add" type="button" @click="addAndSelectWidget">＋ Add widget</button>
          </div>

          <div class="editor-split" :class="{ 'has-drawer': !!selectedWidget }">
            <div
              ref="canvasEl"
              class="canvas"
              :class="{ resizing: resize.active }"
            >
              <div v-if="currentWidgets.length === 0" class="canvas-empty">
                No widgets yet. Click "+ Add widget" or drag here later — the canvas
                renders widgets as a 12-col grid with mock previews.
              </div>
              <div
                v-for="(w, i) in currentWidgets"
                :key="`${w.id}-${i}`"
                class="canvas-widget"
                :class="{
                  selected: selectedIdx === i,
                  dragging: reorder.active && reorder.from === i,
                  'drop-target': reorder.active && reorder.over === i && reorder.from !== i,
                }"
                :style="widgetGridStyle(w)"
                @click="selectWidget(i)"
                @dragover.prevent="onReorderOver($event, i)"
                @drop="onReorderDrop($event, i)"
              >
                <header
                  class="cw-head"
                  :draggable="true"
                  @dragstart="onReorderStart($event, i)"
                  @dragend="onReorderEnd"
                >
                  <span class="cw-grip" aria-hidden="true">
                    <svg viewBox="0 0 10 14" width="6" height="10">
                      <circle cx="2" cy="2" r="1" fill="currentColor"/>
                      <circle cx="8" cy="2" r="1" fill="currentColor"/>
                      <circle cx="2" cy="7" r="1" fill="currentColor"/>
                      <circle cx="8" cy="7" r="1" fill="currentColor"/>
                      <circle cx="2" cy="12" r="1" fill="currentColor"/>
                      <circle cx="8" cy="12" r="1" fill="currentColor"/>
                    </svg>
                  </span>
                  <h5>{{ w.title || w.id || 'untitled' }}</h5>
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
                    <!-- Record preview — mock slow-statement-like rows.
                         The real runtime renderer will surface trace
                         id / segment id columns; for the admin canvas
                         we show the statement + latency only. -->
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
                  <p v-else class="cw-empty">
                    Add an MQE expression in the drawer to preview.
                  </p>
                </div>
                <!-- Resize handle: 12×12 dotted glyph in the bottom-
                     right corner. Mouse-down captures the drag and
                     updates span/rowSpan as the cursor moves. -->
                <span
                  class="cw-resize"
                  title="Drag to resize"
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

            <aside v-if="selectedWidget" class="drawer">
              <div class="drawer-head">
                <h4>Edit widget</h4>
                <span class="sub">{{ scopeLabel(activeScope) }} · #{{ (selectedIdx ?? 0) + 1 }}</span>
                <button class="sw-btn ghost close" type="button" title="Close" @click="selectedIdx = null">✕</button>
              </div>
              <div class="drawer-body">
                <div class="d-row">
                  <label>
                    <span>id</span>
                    <input class="mono" v-model="selectedWidget.id" />
                  </label>
                  <label class="grow">
                    <span>Title</span>
                    <input v-model="selectedWidget.title" />
                  </label>
                </div>
                <div class="d-row">
                  <label class="grow">
                    <span>Tip (hover hint)</span>
                    <input v-model="selectedWidget.tip" placeholder="—" />
                  </label>
                </div>
                <div class="d-row">
                  <label>
                    <span>Type</span>
                    <select v-model="selectedWidget.type">
                      <option value="card">card</option>
                      <option value="line">line</option>
                      <option value="top">top</option>
                      <option value="record">record</option>
                    </select>
                  </label>
                  <label>
                    <span>Unit</span>
                    <input v-model="selectedWidget.unit" placeholder="—" />
                  </label>
                  <label>
                    <span>Span</span>
                    <input type="number" min="1" max="12" v-model.number="selectedWidget.span" />
                  </label>
                  <label>
                    <span>Row span</span>
                    <input type="number" min="1" max="8" v-model.number="selectedWidget.rowSpan" />
                  </label>
                </div>
                <div class="d-section">
                  <span class="d-label">MQE expressions</span>
                  <textarea
                    class="mono"
                    rows="4"
                    :value="expressionsToText(selectedWidget.expressions)"
                    @input="selectedWidget.expressions = textToExpressions(($event.target as HTMLTextAreaElement).value)"
                    placeholder="one expression per line"
                  ></textarea>
                  <p class="d-hint">
                    For <code>top</code> widgets, each expression becomes a tab.
                    For <code>line</code>, each becomes a series.
                  </p>
                </div>
                <div
                  v-if="selectedWidget.type === 'top' || (selectedWidget.expressions?.length ?? 0) > 1"
                  class="d-section"
                >
                  <span class="d-label">Expression labels (one per line)</span>
                  <textarea
                    rows="3"
                    :value="expressionsToText(selectedWidget.expressionLabels ?? [])"
                    @input="selectedWidget.expressionLabels = textToExpressions(($event.target as HTMLTextAreaElement).value)"
                    :placeholder="selectedWidget.type === 'top' ? 'Traffic\nSlow\nSuccessful Rate' : 'count\nlatency'"
                  ></textarea>
                </div>
                <div
                  v-if="selectedWidget.type === 'top' || (selectedWidget.expressions?.length ?? 0) > 1"
                  class="d-section"
                >
                  <span class="d-label">Expression units (one per line)</span>
                  <textarea
                    class="mono"
                    rows="2"
                    :value="expressionsToText(selectedWidget.expressionUnits ?? [])"
                    @input="selectedWidget.expressionUnits = textToExpressions(($event.target as HTMLTextAreaElement).value)"
                    placeholder="rpm&#10;ms&#10;%"
                  ></textarea>
                </div>
                <div v-if="selectedWidget.type === 'line'" class="d-section">
                  <span class="d-label">Y-axis index per expression (0 = left, 1 = right)</span>
                  <input
                    class="mono"
                    :value="(selectedWidget.expressionAxes ?? []).join(',')"
                    @input="selectedWidget.expressionAxes = (($event.target as HTMLInputElement).value || '').split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n))"
                    placeholder="0,1"
                  />
                  <p class="d-hint">Comma-separated. Use for dual-axis line widgets.</p>
                </div>
                <div class="d-section">
                  <span class="d-label" :title="visibleWhenHint(activeScope)">
                    Visible when (optional)
                  </span>
                  <input
                    class="mono"
                    v-model="selectedWidget.visibleWhen"
                    :placeholder="visibleWhenPlaceholder(activeScope)"
                  />
                </div>
                <div class="d-section">
                  <label class="d-check">
                    <input type="checkbox" v-model="selectedWidget.layerScope" />
                    <span>Layer-scoped (run MQE across the whole layer, ignore selected service)</span>
                  </label>
                </div>
                <div class="d-actions">
                  <button
                    class="sw-btn"
                    type="button"
                    :disabled="(selectedIdx ?? 0) === 0"
                    title="Move up"
                    @click="moveSelected(-1)"
                  >↑ Up</button>
                  <button
                    class="sw-btn"
                    type="button"
                    :disabled="(selectedIdx ?? 0) >= currentWidgets.length - 1"
                    title="Move down"
                    @click="moveSelected(1)"
                  >↓ Down</button>
                  <button
                    class="sw-btn danger"
                    type="button"
                    title="Delete widget"
                    @click="deleteSelected"
                  >✕ Delete</button>
                </div>
              </div>
            </aside>
          </div>
        </section>
      </main>
    </div>

    <!-- Push confirm: shows the remote → local diff before publishing. -->
    <Modal :open="pushDiffOpen" title="Publish local → OAP?" width="min(1100px, 94vw)" @close="pushDiffOpen = false">
      <p class="push-lede">
        This replaces the live (remote) version with your local draft — live for everyone. Review the
        diff (left = remote, right = your local):
      </p>
      <div class="push-diff">
        <MonacoDiff :original="pushRemotePretty" :modified="pushLocalPretty" language="json" />
      </div>
      <template #footer>
        <button class="sw-btn" type="button" @click="pushDiffOpen = false">Cancel</button>
        <button class="sw-btn is-primary" type="button" :disabled="isSaving" @click="pushToOap">
          {{ isSaving ? 'Pushing…' : 'Confirm push' }}
        </button>
      </template>
    </Modal>

    <!-- Disable / delete / reactivate confirm — styled (not native). -->
    <Modal :open="deleteOpen" :title="confirmTitle" width="min(520px, 92vw)" @close="deleteOpen = false">
      <p class="confirm-msg">{{ confirmMessage }}</p>
      <template #footer>
        <button class="sw-btn" type="button" @click="deleteOpen = false">Cancel</button>
        <button class="sw-btn" :class="{ danger: confirmIsDanger, 'is-primary': !confirmIsDanger }" type="button" :disabled="isSaving" @click="runConfirm">
          {{ confirmLabel }}
        </button>
      </template>
    </Modal>
  </div>
</template>

<style scoped>
.admin-page {
  padding: 20px 20px 60px;
  max-width: 1440px;
  margin: 0 auto;
}
.page-head { margin-bottom: 18px; }
.kicker {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--sw-accent);
  margin-bottom: 6px;
}
.page-head h1 {
  font-size: 22px;
  font-weight: 600;
  letter-spacing: -0.02em;
  color: var(--sw-fg-0);
  margin: 0 0 8px;
}
.lede {
  font-size: 12.5px;
  color: var(--sw-fg-1);
  line-height: 1.5;
  margin: 0;
  max-width: 720px;
}
.banner.err {
  padding: 8px 12px;
  background: var(--sw-err-soft);
  border: 1px solid rgba(239, 68, 68, 0.3);
  border-radius: 6px;
  color: #f87171;
  font-size: 12px;
  margin-bottom: 14px;
}
.empty {
  padding: 32px;
  text-align: center;
  color: var(--sw-fg-3);
  font-size: 12px;
}
.empty.inset {
  padding: 18px;
  font-size: 11.5px;
}
.grid {
  display: grid;
  grid-template-columns: 220px 1fr;
  gap: 14px;
  align-items: start;
  transition: grid-template-columns 160ms ease;
}
.grid.list-collapsed {
  grid-template-columns: 1fr;
}
.layer-list {
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  align-self: start;
  position: sticky;
  top: 16px;
}
.list-toggle {
  flex: 0 0 auto;
  width: 22px;
  height: 22px;
  margin-right: 4px;
  background: transparent;
  border: none;
  color: var(--sw-fg-3);
  cursor: pointer;
  font: inherit;
  border-radius: 3px;
  display: inline-grid;
  place-items: center;
}
.list-toggle:hover {
  background: var(--sw-bg-2);
  color: var(--sw-fg-1);
}
.list-toggle .caret {
  display: inline-block;
  font-size: 13px;
  line-height: 1;
  transition: transform 0.15s;
}
.list-toggle .caret.open {
  transform: rotate(90deg);
}
/* Collapsed-rail layer switcher — a compact dropdown bar at the top of
   the editor pane so layer switching costs no left-zone width. */
.layer-switch-bar {
  display: flex;
  align-items: center;
  gap: 8px;
}
.layer-switch-bar .list-toggle {
  margin-right: 0;
}
.layer-switch-bar .caret {
  display: inline-block;
  font-size: 13px;
  line-height: 1;
}
/* Filterable layer dropdown — same search + rows as the pinned rail.
   The sole layer switcher (no separate expand toggle). */
.layer-dd { position: relative; display: flex; }
.layer-dd-btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  height: 30px;
  padding: 0 10px;
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line-2);
  border-radius: 6px;
  color: var(--sw-fg-0);
  font: inherit;
  font-size: 12px;
  font-weight: 600;
  min-width: 200px;
  cursor: pointer;
}
.layer-dd-btn:hover { background: var(--sw-bg-3); }
.layer-dd-name {
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dd-caret {
  margin-left: auto;
  transform: rotate(90deg);
  transition: transform 0.15s;
}
.dd-caret.open { transform: rotate(-90deg); }
.layer-dd-backdrop {
  position: fixed;
  inset: 0;
  z-index: 40;
}
.layer-dd-pop {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  z-index: 41;
  /* Wide enough to read alias + key + badge on one line per row. */
  width: min(80vw, 760px);
  max-height: 360px;
  display: flex;
  flex-direction: column;
  padding: 8px 0;
  box-shadow: 0 12px 32px -8px rgba(0, 0, 0, 0.5);
}
.layer-dd-pop .list-search { padding: 0 10px 8px; }
.layer-dd-list {
  overflow-y: auto;
  padding: 0 6px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.layer-dd-foot {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border-top: 1px solid var(--sw-line-2);
}
.layer-dd-foot .sub {
  font-size: 10.5px;
  color: var(--sw-fg-3);
}
.layer-dd-foot .refresh-btn {
  margin-left: auto;
  font-size: 11px;
  height: 24px;
  padding: 0 8px;
}
.list-head {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 10px 10px;
  border-bottom: 1px solid var(--sw-line);
  margin-bottom: 6px;
}
.list-head h4 {
  margin: 0;
  font-size: 11.5px;
  font-weight: 600;
  color: var(--sw-fg-0);
}
.list-head .sub {
  font-size: 10px;
  color: var(--sw-fg-3);
  margin-left: auto;
}
.list-search {
  padding: 0 10px 8px;
}
.list-search-input {
  width: 100%;
  box-sizing: border-box;
  background: var(--sw-bg-1);
  border: 1px solid var(--sw-line-2);
  border-radius: 5px;
  color: var(--sw-fg-0);
  font: inherit;
  font-size: 11.5px;
  padding: 5px 8px;
}
.list-search-input:focus {
  outline: none;
  border-color: var(--sw-accent);
}
.list-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 10px 8px;
}
/* Diverged / Local filters, co-located with the search inside the layer
   picker (rail + dropdown), same as the overview dashboards admin —
   keeps filter + selector + count read as one connected control instead
   of floating in a separate page-level row. */
.dd-filters {
  display: flex;
  gap: 14px;
  padding: 0 10px 8px;
  margin-bottom: 6px;
  border-bottom: 1px solid var(--sw-line);
}
.layer-dd-pop .dd-filters { padding: 0 10px 8px; }
.diverged-filter {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  color: var(--sw-fg-2);
  cursor: pointer;
  user-select: none;
}
.diverged-filter input:disabled { cursor: not-allowed; }
.diverged-filter.on { color: var(--sw-fg-0); }
.diverged-count {
  margin-left: 2px;
  padding: 0 5px;
  border-radius: 8px;
  background: var(--sw-warn, var(--sw-accent));
  color: #1a1a1a;
  font-size: 10px;
  font-weight: 700;
}
.list-actions .sw-btn { margin-left: auto; }
.list-empty {
  padding: 8px 10px;
  font-size: 11px;
  color: var(--sw-fg-3);
}
.layer-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  border-radius: 5px;
  background: transparent;
  border: none;
  color: var(--sw-fg-1);
  font-size: 12px;
  cursor: pointer;
  text-align: left;
  font: inherit;
}
.layer-row:hover { background: var(--sw-bg-2); }
.layer-row.active {
  background: var(--sw-bg-3);
  color: var(--sw-fg-0);
  box-shadow: inset 2px 0 0 var(--sw-accent);
}
.layer-row .dot {
  width: 7px; height: 7px;
  border-radius: 50%;
  flex: 0 0 7px;
}
.layer-row .name {
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.detail {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-width: 0;
}
.identity-card {
  padding: 12px 16px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.identity-row {
  display: flex;
  align-items: center;
  gap: 14px;
}
.identity-row h2 {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  color: var(--sw-fg-0);
}
/* Single-line identity strip: label + name + key + badges all inline. */
.identity-title {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: nowrap;
  min-width: 0;
}
.identity-label {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--sw-fg-3);
  font-weight: 600;
}
.identity-title h2 { white-space: nowrap; }
.identity-title code {
  font-family: var(--sw-mono);
  font-size: 10.5px;
  background: var(--sw-bg-2);
  padding: 1px 6px;
  border-radius: 3px;
  color: var(--sw-fg-1);
}
.visibility-row {
  display: flex; align-items: center; gap: 16px;
  padding: 12px 0 0;
  margin-top: 10px;
  border-top: 1px dashed var(--sw-line);
}
.vis-label {
  font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.08em;
  color: var(--sw-fg-3); flex: 0 0 auto;
}
.vis-options { display: flex; gap: 10px; flex: 1; flex-wrap: wrap; }
.vis-opt {
  display: flex; align-items: flex-start; gap: 8px;
  padding: 8px 12px;
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line-2);
  border-radius: 5px;
  cursor: pointer; user-select: none;
  min-width: 220px;
}
.vis-opt:hover { background: var(--sw-bg-3); }
.vis-opt.on {
  background: var(--sw-accent-soft);
  border-color: var(--sw-accent-line, var(--sw-accent));
}
.vis-opt input { margin-top: 2px; accent-color: var(--sw-accent); }
.vis-opt-body { display: flex; flex-direction: column; gap: 2px; }
.vis-opt-title { font-size: 12px; font-weight: 600; color: var(--sw-fg-0); }
.vis-opt.on .vis-opt-title { color: var(--sw-accent-2); }
.vis-opt-hint { font-size: 10.5px; color: var(--sw-fg-3); line-height: 1.4; }
.chip {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 3px;
  background: var(--sw-bg-2);
  color: var(--sw-fg-2);
}
.chip.on {
  background: var(--sw-accent-soft);
  color: var(--sw-accent-2);
}
.dot.inline {
  width: 12px; height: 12px;
  border-radius: 50%;
  display: inline-block;
}
.actions {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 8px;
}
.actions .sw-btn { font-size: 11.5px; }
.src-tag {
  font-size: 9.5px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--sw-fg-3);
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line-2);
  border-radius: 4px;
  padding: 2px 7px;
}
/* "Reset to ▾" merged dropdown (Bundled / Remote sources). */
.reset-dd { position: relative; display: inline-flex; }
.reset-dd .caret { display: inline-block; transform: rotate(90deg); font-size: 11px; }
.reset-dd .caret.open { transform: rotate(-90deg); }
.reset-dd-backdrop { position: fixed; inset: 0; z-index: 40; }
.reset-dd-pop {
  position: absolute;
  top: calc(100% + 4px);
  right: 0;
  z-index: 41;
  min-width: 130px;
  padding: 4px;
  background: var(--sw-bg-1);
  border: 1px solid var(--sw-line);
  border-radius: 6px;
  box-shadow: 0 10px 28px -8px rgba(0, 0, 0, 0.5);
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.reset-dd-item {
  text-align: left;
  padding: 6px 10px;
  background: transparent;
  border: none;
  border-radius: 4px;
  color: var(--sw-fg-1);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.reset-dd-item:hover:not(:disabled) { background: var(--sw-bg-2); color: var(--sw-fg-0); }
.reset-dd-item:disabled { opacity: 0.4; cursor: not-allowed; }
.push-lede { margin: 0 0 10px; font-size: 12px; color: var(--sw-fg-2); line-height: 1.5; }
.confirm-msg { margin: 0; font-size: 13px; line-height: 1.55; color: var(--sw-fg-1); }
.push-diff { height: 50vh; min-height: 320px; border: 1px solid var(--sw-line); border-radius: 6px; overflow: hidden; }
.actions .sw-btn[disabled] { opacity: 0.4; pointer-events: none; }
.save-msg {
  font-size: 11px;
  color: var(--sw-ok);
}
.identity-delete { display: flex; align-items: center; gap: 8px; }
.del-note { font-size: 10.5px; color: var(--sw-fg-3); font-style: italic; }

.scope-tabs {
  display: flex;
  gap: 2px;
  padding: 6px;
}
.scope-tab {
  flex: 1;
  padding: 8px 12px;
  font-size: 11.5px;
  font-weight: 500;
  color: var(--sw-fg-2);
  background: transparent;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  text-transform: capitalize;
  font: inherit;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
}
.scope-tab:hover { background: var(--sw-bg-2); color: var(--sw-fg-1); }
.scope-tab.on {
  background: var(--sw-accent-soft);
  color: var(--sw-accent-2);
  font-weight: 600;
}
.scope-tab .count {
  font-family: var(--sw-mono);
  font-size: 10px;
  color: var(--sw-fg-3);
}
.scope-tab.on .count { color: var(--sw-accent-2); }

/* Layer setup card — menu preview (left) + alias/components (right). */
.setup-card { padding: 0; }
.setup-grid {
  display: grid;
  grid-template-columns: 240px 1fr;
  align-items: stretch;
}
.menu-preview {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 12px 12px 14px;
  border-right: 1px solid var(--sw-line);
  background: var(--sw-bg-1);
  border-radius: var(--sw-radius, 8px) 0 0 var(--sw-radius, 8px);
}
.menu-preview-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 8px 10px;
  margin-bottom: 4px;
  border-bottom: 1px solid var(--sw-line);
}
.menu-preview-title {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--sw-fg-0);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.menu-preview-empty {
  margin: 4px 8px;
  font-size: 10.5px;
  color: var(--sw-fg-3);
  line-height: 1.5;
}
/* Amber "local" chip — surfaces an unpublished local browser draft in the
 * picker (the sync badge only reflects bundled-vs-remote). */
.local-badge {
  flex: 0 0 auto;
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: #1a1a1a;
  background: var(--sw-warn, #f59e0b);
  padding: 1px 6px;
  border-radius: 8px;
}
/* Dim mono chip for the raw layer key, shown next to the alias so the
 * operator sees both the display name and the OAP layer identity. */
.key-tag {
  flex: 0 0 auto;
  font-family: var(--sw-mono);
  font-size: 9.5px;
  letter-spacing: 0.02em;
  color: var(--sw-fg-3);
  background: var(--sw-bg-2);
  padding: 1px 5px;
  border-radius: 3px;
}
.menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  border-radius: 5px;
  background: transparent;
  border: none;
  color: var(--sw-fg-1);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  text-align: left;
}
.menu-item:hover { background: var(--sw-bg-2); color: var(--sw-fg-0); }
.menu-item.on {
  background: var(--sw-accent-soft);
  color: var(--sw-accent-2);
  font-weight: 600;
  box-shadow: inset 2px 0 0 var(--sw-accent);
}
.menu-item-label { flex: 1; }
.menu-item-arrow { color: var(--sw-fg-3); font-size: 13px; }
.menu-item.on .menu-item-arrow { color: var(--sw-accent-2); }
.setup-right {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 12px 14px 14px;
  min-width: 0;
}
.alias-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.alias-field > span:first-child {
  font-size: 10.5px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--sw-fg-3);
}
.alias-input {
  height: 30px;
  padding: 0 10px;
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line-2);
  border-radius: 5px;
  color: var(--sw-fg-0);
  font: inherit;
  font-size: 13px;
  max-width: 320px;
}
.alias-input:focus { outline: none; border-color: var(--sw-accent); }
.alias-hint { font-size: 10.5px; color: var(--sw-fg-3); line-height: 1.4; }
.setup-section-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding-top: 4px;
  border-top: 1px dashed var(--sw-line);
}
.setup-section-head h4 {
  margin: 0;
  font-size: 12px;
  font-weight: 600;
  color: var(--sw-fg-0);
}
.setup-section-head .sub { font-size: 10.5px; color: var(--sw-fg-3); }
.setup-right .comp-grid { padding: 0; }

.components-card { padding: 0; }
.components-card .card-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--sw-line);
}
.components-card .card-head h4 {
  margin: 0;
  font-size: 12px;
  font-weight: 600;
  color: var(--sw-fg-0);
}
.components-card .card-head .sub {
  font-size: 10.5px;
  color: var(--sw-fg-3);
}
.comp-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(170px, 1fr));
  gap: 6px;
  padding: 12px 14px;
}
.comp-toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11.5px;
  color: var(--sw-fg-2);
  padding: 6px 10px;
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line-2);
  border-radius: 4px;
  cursor: pointer;
  user-select: none;
}
.comp-toggle:hover {
  background: var(--sw-bg-3);
}
.comp-toggle.on {
  background: var(--sw-accent-soft);
  border-color: var(--sw-accent-line);
  color: var(--sw-accent-2);
}
/* Topology-config → cluster-setup pointer banner. */
.topo-cluster-pointer {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 10px 14px 0;
  padding: 8px 12px;
  background: var(--sw-accent-soft);
  border: 1px solid var(--sw-accent-line);
  border-radius: 6px;
  font-size: 11.5px;
  color: var(--sw-fg-1);
}
.topo-cluster-pointer-icon {
  font-size: 14px;
  color: var(--sw-accent-2);
}
.topo-cluster-pointer a {
  color: var(--sw-accent-2);
  text-decoration: underline;
}
/* Brief pulse when arrowed-into from the topology config panel. */
@keyframes cluster-pulse-frames {
  0%   { box-shadow: 0 0 0 0 var(--sw-accent-line); }
  40%  { box-shadow: 0 0 0 6px var(--sw-accent-line); }
  100% { box-shadow: 0 0 0 0 transparent; }
}
.cluster-pulse {
  animation: cluster-pulse-frames 1.2s ease-out;
}
.naming-flags-hint {
  margin: -4px 0 4px;
  font-size: 11px;
  color: var(--sw-fg-3);
  padding: 0 4px;
}
.naming-flags-hint code {
  font-family: var(--sw-mono);
  background: var(--sw-bg-2);
  padding: 1px 4px;
  border-radius: 3px;
  color: var(--sw-fg-1);
}
/* Always-visible legacy-prefix toggle inside the cluster card. */
.naming-prefix-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 14px 0;
  flex-wrap: wrap;
}
.naming-prefix-row .comp-toggle { flex: 0 0 auto; }
.naming-prefix-hint {
  font-size: 11px;
  color: var(--sw-fg-3);
}
.naming-prefix-hint code {
  font-family: var(--sw-mono);
  background: var(--sw-bg-2);
  padding: 1px 4px;
  border-radius: 3px;
  color: var(--sw-fg-1);
}
/* Service-naming rule editor — pattern + capture mapping + live test. */
.naming-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px 14px;
}
.naming-row {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}
.naming-row .mf {
  flex: 1 1 160px;
}
.naming-test {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: flex-end;
  margin-top: 6px;
  padding-top: 10px;
  border-top: 1px dashed var(--sw-line);
}
.naming-result {
  display: flex;
  gap: 14px;
  align-items: center;
  padding: 8px 12px;
  border-radius: 6px;
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line-2);
  font-size: 11.5px;
  flex: 1 1 280px;
}
.naming-result.ok { border-color: var(--sw-accent-line); }
.naming-result.err { border-color: var(--sw-err); background: rgba(239, 68, 68, 0.06); }
.naming-result-row {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.naming-tag {
  font-size: 9.5px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--sw-fg-3);
  background: var(--sw-bg-1);
  border: 1px solid var(--sw-line);
  padding: 1px 6px;
  border-radius: 4px;
}
.naming-result .mono { font-family: var(--sw-mono); color: var(--sw-fg-0); font-weight: 600; }
.naming-result .mono.accent { color: var(--sw-accent-2); }
.naming-error {
  display: inline-flex;
  gap: 6px;
  align-items: center;
  color: var(--sw-err);
}
.comp-toggle input {
  accent-color: var(--sw-accent);
  margin: 0;
}
.comp-label {
  font-weight: 500;
}

.metrics-card,
.overview-card { padding: 0; }
.overview-card .card-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--sw-line);
}
.overview-card .card-head h4 {
  margin: 0;
  font-size: 12px;
  font-weight: 600;
  color: var(--sw-fg-0);
}
.overview-card .card-head .sub {
  font-size: 10.5px;
  color: var(--sw-fg-3);
}
.metrics-card .card-head .add {
  margin-left: auto;
  font-size: 11.5px;
  background: var(--sw-accent-soft);
  color: var(--sw-accent-2);
  border-color: var(--sw-accent-line);
}
.metrics-keys {
  display: flex;
  gap: 14px;
  padding: 10px 16px;
  border-bottom: 1px dashed var(--sw-line);
}
.metrics-keys label {
  display: flex;
  flex-direction: column;
  gap: 3px;
  font-size: 10.5px;
  color: var(--sw-fg-3);
  min-width: 120px;
}
.metrics-keys select {
  height: 26px;
  padding: 0 8px;
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line-2);
  border-radius: 4px;
  color: var(--sw-fg-0);
  font: inherit;
  font-size: 11.5px;
}
.metrics-table {
  width: 100%;
}
.metrics-table th {
  text-align: left;
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--sw-fg-3);
  font-weight: 500;
  padding: 8px 10px 6px;
  border-bottom: 1px solid var(--sw-line);
}
.metrics-table th.grow {
  width: 35%;
}
.metrics-table td {
  padding: 6px 10px;
  border-bottom: 1px solid var(--sw-line);
}
.metrics-table input,
.metrics-table select {
  width: 100%;
  height: 26px;
  padding: 0 6px;
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line-2);
  border-radius: 3px;
  color: var(--sw-fg-0);
  font: inherit;
  font-size: 11.5px;
}
.metrics-table input.mono {
  font-family: var(--sw-mono);
  font-size: 11px;
}
.metrics-table .sw-btn.danger {
  width: 26px;
  height: 26px;
  padding: 0;
  font-size: 11px;
  border-color: rgba(239, 68, 68, 0.3);
  color: #f87171;
}

/* Sample-data preview of the service list. */
.metrics-preview {
  border-top: 1px solid var(--sw-line);
  padding: 12px 10px 6px;
}
.metrics-preview-head {
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--sw-fg-3);
  padding: 0 4px 8px;
}
.metrics-preview-head .sub {
  margin-left: 8px;
  font-weight: 500;
  text-transform: none;
  letter-spacing: 0;
  color: var(--sw-fg-3);
}
.metrics-preview-scroll { overflow-x: auto; }
.preview-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 11.5px;
}
.preview-table th {
  text-align: left;
  font-size: 10px;
  font-weight: 600;
  color: var(--sw-fg-2);
  padding: 6px 10px;
  border-bottom: 1px solid var(--sw-line);
  white-space: nowrap;
}
.preview-table th.num,
.preview-table td.num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.preview-table td {
  padding: 6px 10px;
  border-bottom: 1px solid var(--sw-line);
  color: var(--sw-fg-1);
}
.preview-table td.svc {
  color: var(--sw-fg-0);
  font-weight: 500;
}
.preview-table tbody tr:last-child td { border-bottom: none; }
.sort-ind {
  margin-left: 3px;
  color: var(--sw-accent-2);
  font-size: 10px;
}

/* Landing KPI tile preview: config head + a faithful copy of the real
 * layer header. The header classes below mirror LayerShell so the
 * preview matches the live page (kept in sync intentionally). */
.kpi-block {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 4px 4px 14px;
}
.kpi-config {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 10px;
}
.kpi-config-title {
  flex: 1 0 100%;
  font-size: 11px;
  font-weight: 600;
  color: var(--sw-fg-1);
}
.kpi-config-title .sub {
  margin-left: 6px;
  font-weight: 400;
  font-size: 10px;
  color: var(--sw-fg-3);
}
.kpi-config label {
  display: flex;
  flex-direction: column;
  gap: 3px;
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--sw-fg-3);
}
.kpi-config select {
  height: 28px;
  padding: 0 8px;
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line-2);
  border-radius: 4px;
  color: var(--sw-fg-0);
  font: inherit;
  font-size: 11.5px;
}
.kpi-config select:focus { outline: none; border-color: var(--sw-accent); }
/* ↓ mirrors LayerShell.vue .layer-head / .layer-id-row / .kpi-strip. */
.preview-layer-head { padding: 14px; }
.preview-layer-head .layer-id-row {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}
.preview-layer-head .icon-tile {
  width: 40px;
  height: 40px;
  border-radius: 10px;
  display: grid;
  place-items: center;
  color: #fff;
  font-weight: 700;
  font-size: 14px;
  letter-spacing: -0.02em;
  flex: 0 0 40px;
  background-blend-mode: multiply;
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.08);
}
.preview-layer-head .identity-text { min-width: 0; }
.preview-layer-head .title-row h1 {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
  color: var(--sw-fg-0);
  letter-spacing: -0.02em;
}
.preview-layer-head .sub {
  margin-top: 4px;
  font-size: 11.5px;
  color: var(--sw-fg-3);
}
.preview-layer-head .kpi-strip {
  display: flex;
  gap: 22px;
  flex-wrap: wrap;
  align-items: flex-end;
  margin-left: auto;
}
.preview-layer-head .kpi { text-align: right; min-width: 80px; }
.preview-layer-head .kpi-label {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--sw-fg-3);
  margin-bottom: 2px;
}
.preview-layer-head .kpi-label .unit {
  text-transform: none;
  letter-spacing: 0;
  margin-left: 2px;
  font-size: 9.5px;
}
.preview-layer-head .kpi-value {
  font-size: 18px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.02em;
  color: var(--sw-fg-1);
}
.preview-layer-head .kpi-spark { display: block; margin-top: 4px; margin-left: auto; }

/* Menu-label (slot alias) editor grid. */
.alias-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 8px;
}
.alias-grid-field {
  display: flex;
  flex-direction: column;
  gap: 3px;
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--sw-fg-3);
}
.alias-input.sm { height: 28px; font-size: 12px; max-width: none; }

.editor-card { padding: 0; }
/* Topology / endpoint-dep config preview — read-only JSON view. */
.topo-cfg-body { padding: 12px 14px 16px; }
.topo-cfg-help {
  margin: 0 0 10px;
  font-size: 11.5px;
  color: var(--sw-fg-3);
  line-height: 1.5;
}
.trace-source-cfg { display: flex; flex-direction: column; gap: 8px; }
.trace-source-head {
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--sw-fg-3);
}
.trace-source-opts { display: flex; flex-direction: column; gap: 6px; }
.trace-source-opt {
  display: grid;
  grid-template-columns: 16px 64px 1fr;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border: 1px solid var(--sw-line);
  border-radius: 4px;
  background: var(--sw-bg-1);
  cursor: pointer;
  font-size: 11.5px;
}
.trace-source-opt.on { border-color: var(--sw-accent); background: var(--sw-bg-2); }
.trace-source-opt .ts-label { font-weight: 600; color: var(--sw-fg-0); }
.trace-source-opt .ts-hint { color: var(--sw-fg-3); }
.topo-cfg-help code {
  font-family: var(--sw-mono);
  color: var(--sw-fg-1);
  background: var(--sw-bg-2);
  padding: 1px 5px;
  border-radius: 3px;
}
.topo-cfg-json {
  margin: 0;
  padding: 12px;
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line);
  border-radius: 6px;
  font-family: var(--sw-mono);
  font-size: 11.5px;
  color: var(--sw-fg-1);
  line-height: 1.55;
  overflow-x: auto;
  white-space: pre;
  max-height: 540px;
}
/* Topology / endpoint-dep form editor */
.topo-cfg-card .topo-cfg-body { padding: 4px 0 0; }
.topo-cfg-section {
  padding: 12px 16px;
  border-bottom: 1px solid var(--sw-line);
}
.topo-cfg-section:last-child { border-bottom: none; }
.topo-cfg-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin-bottom: 8px;
}
.topo-cfg-head h5 {
  margin: 0;
  font-size: 11.5px;
  font-weight: 700;
  color: var(--sw-accent);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
.topo-cfg-head .sub {
  font-size: 10.5px;
  color: var(--sw-fg-3);
  flex: 1;
}
.topo-cfg-head .sub code {
  font-family: var(--sw-mono);
  color: var(--sw-fg-1);
  background: var(--sw-bg-2);
  padding: 0 4px;
  border-radius: 3px;
}
.topo-cfg-head .sw-btn.add {
  background: var(--sw-accent);
  color: var(--sw-bg-0);
  border: none;
  height: 24px;
  padding: 0 10px;
  font-size: 11px;
  border-radius: 4px;
  cursor: pointer;
}
.topo-cfg-empty {
  font-size: 11.5px;
  color: var(--sw-fg-3);
  padding: 12px;
  text-align: center;
  background: var(--sw-bg-2);
  border-radius: 4px;
}
.metric-list { display: flex; flex-direction: column; gap: 8px; }
.metric-row {
  background: var(--sw-bg-1);
  border: 1px solid var(--sw-line);
  border-radius: 4px;
  padding: 8px 10px;
}
.metric-row-head {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  flex-wrap: wrap;
}
.metric-row-actions {
  display: inline-flex;
  gap: 4px;
  margin-left: auto;
  align-self: flex-end;
}
.metric-thresholds {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: flex-end;
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px dashed var(--sw-line);
}
.mf {
  display: inline-flex;
  flex-direction: column;
  gap: 3px;
  font-size: 10px;
  color: var(--sw-fg-3);
  letter-spacing: 0.04em;
  text-transform: uppercase;
  min-width: 110px;
}
.mf.mf-wide { min-width: 220px; flex: 1; }
.mf.mf-narrow { min-width: 80px; }
.mf.mf-checkbox {
  flex-direction: row;
  align-items: center;
  text-transform: none;
  letter-spacing: 0;
  font-size: 10.5px;
  color: var(--sw-fg-2);
  min-width: auto;
}
.mf.mf-checkbox input { accent-color: var(--sw-accent); }
.mf-input {
  height: 26px;
  padding: 0 6px;
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line-2);
  border-radius: 4px;
  color: var(--sw-fg-0);
  font: inherit;
  font-size: 11px;
  width: 100%;
  box-sizing: border-box;
}
.mf-input.mono { font-family: var(--sw-mono); }
.sw-btn.small.ghost {
  background: transparent;
  border: 1px solid var(--sw-line-2);
  color: var(--sw-fg-2);
  height: 22px;
  padding: 0 8px;
  font-size: 11px;
  border-radius: 3px;
  cursor: pointer;
}
.sw-btn.small.ghost.danger { color: var(--sw-err); border-color: rgba(239, 68, 68, 0.3); }
.sw-btn.small.ghost[disabled] { opacity: 0.4; cursor: not-allowed; }
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
  border-right: 1px solid var(--sw-line);
}
.editor-split:not(.has-drawer) .canvas { border-right: none; }
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
  border-left: 1px solid var(--sw-line);
  max-height: calc(100vh - 120px);
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
.d-actions {
  display: flex;
  gap: 6px;
  padding-top: 4px;
  border-top: 1px dashed var(--sw-line);
  margin-top: 4px;
}
.d-actions .sw-btn { font-size: 11px; }
.d-actions .sw-btn.danger { margin-left: auto; }
.d-actions .sw-btn[disabled] { opacity: 0.35; pointer-events: none; }
</style>
