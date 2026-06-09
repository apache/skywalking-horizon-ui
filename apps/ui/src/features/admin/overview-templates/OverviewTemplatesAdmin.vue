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
  Admin: overview-dashboard templates. List on the left, per-widget
  editor on the right. The editor is TYPE-AWARE — each widget kind
  exposes only the fields it actually consumes, so the operator
  isn't asked to set a `limit` on a topology card or an MQE on a
  metric-composite card.

  Editable per type:
   - section-break  : title, cols
   - metric         : layer, title, tip, mqe, unit, aggregation, span/rowSpan
   - topology       : layer, title, tip, span/rowSpan
   - alarms         : layer, title, tip, limit, span/rowSpan
   - kpi-tile       : layer, title, tip, showCount, KPI rows (add/remove +
                      label/MQE/unit/aggregation/style/max), span/rowSpan
   - metric-composite : layer, title, tip, KPI rows (mixed MQE +
                        service-count source, number / progress-bar
                        style), span/rowSpan

  Widget type / id / order stay frozen — those are code-shape
  decisions, not config tweaks.
-->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch, watchEffect } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import { useQuery } from '@tanstack/vue-query';
import type {
  OverviewDashboard,
  OverviewKpi,
  OverviewWidget,
} from '@skywalking-horizon-ui/api-client';
import { bff, BffApiError } from '@/api/client';
import type { OverviewTemplateSummary } from '@/api/scopes/overview';
import { useLocalTemplateEdits, overviewEditName } from '@/controls/localTemplateEdits';
import { usePreviewOverride } from '@/controls/previewOverride';
import { useTemplateSources } from '@/features/admin/_shared/useTemplateSources';
import { buildExportEnvelope, downloadJson, pickJsonFile, validateImport } from '@/features/admin/_shared/templatePortability';
import { useLayers } from '@/shell/useLayers';
import SyncStatusBanner from '@/features/admin/_shared/SyncStatusBanner.vue';
import { refreshConfigBundle } from '@/controls/configBundle';
import { stableStringify } from '@/utils/stableJson';
import TemplateStatusBadge from '@/features/admin/_shared/TemplateStatusBadge.vue';
import MqeExpressionInput from '@/features/admin/_shared/MqeExpressionInput.vue';
import { useTemplateSync } from '@/features/admin/_shared/useTemplateSync';
// Real overview widget primitives — the preview renders these with mock
// data so it matches the live page pixel-for-pixel (no bespoke copy).
import KpiTileWidget from '@/render/widgets/KpiTileWidget.vue';
import MetricWidget from '@/render/widgets/MetricWidget.vue';
import MetricCompositeWidget from '@/render/widgets/MetricCompositeWidget.vue';
import Modal from '@/features/operate/_shared/Modal.vue';
import MonacoDiff from '@/features/operate/_shared/MonacoDiff.vue';

// OAP UI-template sync status for the Overview kind. Drives the
// page-level banner + read-only mode + per-row badge lookup.
const { t } = useI18n();
const sync = useTemplateSync({ kind: 'overview' });

const listQuery = useQuery({
  queryKey: ['admin/overview-templates'],
  queryFn: () => bff.overview.adminList(),
  staleTime: 60_000,
});

// Template sources + local-draft store. Declared here (not lower with the
// editor-source helpers) because the picker computeds below — read
// synchronously by the auto-select watchEffect during setup — depend on
// them; declaring them later would hit a temporal-dead-zone ReferenceError.
const router = useRouter();
const localEdits = useLocalTemplateEdits();
const previewOverride = usePreviewOverride();
const sources = useTemplateSources('overview');
// See LayerDashboardsAdmin: the source pill stays hidden until the
// config-bundle settles so the initial pill state isn't a guess that
// flips moments later.
const sourcesReady = computed(() => !sources.isLoading.value);

const OV_PREFIX = 'horizon.overview.';
function summaryFrom(
  id: string,
  content: OverviewDashboard | null | undefined,
): OverviewTemplateSummary | null {
  if (!content) return null;
  return {
    id,
    title: content.title || id,
    ...(content.description ? { description: content.description } : {}),
    widgetCount: content.widgets?.length ?? 0,
    editable: true,
  };
}

// On-disk dashboards (bundled + overlaid remote), from the BFF.
const serverDashboards = computed(() => listQuery.data.value?.dashboards ?? []);

// Remote-only: dashboards that live on OAP with no on-disk base — created
// in this admin and pushed. The server list (disk) can't see them, so
// surface them from the OAP sync rows.
const remoteOnlyDashboards = computed<OverviewTemplateSummary[]>(() => {
  const serverIds = new Set(serverDashboards.value.map((d) => d.id));
  const out: OverviewTemplateSummary[] = [];
  for (const name of sources.remoteNames()) {
    if (!name.startsWith(OV_PREFIX)) continue;
    const id = name.slice(OV_PREFIX.length);
    if (serverIds.has(id)) continue;
    const s = summaryFrom(id, sources.remote<OverviewDashboard>(name));
    if (s) out.push(s);
  }
  return out;
});

// Local-only drafts: dashboards created in THIS browser that aren't on the
// server or OAP yet. They surface in the picker like any dashboard —
// flagged `local` — so create mirrors edit: draft locally, preview, then
// "Check diff & push" publishes them. Once pushed they become remote-only
// (then server-backed once OAP serves them) and drop out of this list.
const localOnlyDrafts = computed<OverviewTemplateSummary[]>(() => {
  const known = new Set([
    ...serverDashboards.value.map((d) => d.id),
    ...remoteOnlyDashboards.value.map((d) => d.id),
  ]);
  const out: OverviewTemplateSummary[] = [];
  for (const name of localEdits.names()) {
    if (!name.startsWith(OV_PREFIX)) continue;
    const id = name.slice(OV_PREFIX.length);
    if (known.has(id)) continue;
    const s = summaryFrom(id, localEdits.get<OverviewDashboard>(name));
    if (s) out.push(s);
  }
  return out;
});
const dashboards = computed(() => [
  ...serverDashboards.value,
  ...remoteOnlyDashboards.value,
  ...localOnlyDrafts.value,
]);

const selectedId = ref<string>('');
const selectedDash = computed(() => dashboards.value.find((d) => d.id === selectedId.value) ?? null);
// True when the selected dashboard exists on the server (disk/remote) — a
// local-only draft has no server detail to fetch, so the detail query must
// stay disabled for it (it would 404).
const isServerBacked = computed(() =>
  serverDashboards.value.some((d) => d.id === selectedId.value),
);

// Top dropdown picker (replaces the left list — same pattern as the layer
// dashboards switcher). Filterable; "+ New dashboard" lives inside it.
const listDropdownOpen = ref(false);
const listSearch = ref('');
const divergedOnly = ref(false);
const localOnly = ref(false);
function isDivergedRow(id: string): boolean {
  const s = sync.badgeFor(`horizon.overview.${id}`);
  return s === 'diverged' || s === 'bundled-fallback';
}
const divergedCount = computed(() => dashboards.value.filter((d) => isDivergedRow(d.id)).length);
const localDraftCount = computed(() => dashboards.value.filter((d) => hasLocalDraftFor(d.id)).length);

// Auto-uncheck the picker filter when its underlying set drops to
// zero. Without this the operator can hit Reset / Push / Sync — which
// removes the matching row from the filtered set — and end up stuck
// on an empty list with the checkbox itself disabled (since
// divergedCount / localDraftCount === 0). Same guard as the Layer
// Dashboards admin page.
watch(divergedCount, (n) => { if (n === 0) divergedOnly.value = false; });
watch(localDraftCount, (n) => { if (n === 0) localOnly.value = false; });
const filteredDashboards = computed(() => {
  const q = listSearch.value.trim().toLowerCase();
  return dashboards.value.filter((d) => {
    if (divergedOnly.value && !isDivergedRow(d.id)) return false;
    if (localOnly.value && !hasLocalDraftFor(d.id)) return false;
    if (!q) return true;
    return d.title.toLowerCase().includes(q) || d.id.toLowerCase().includes(q);
  });
});
function pickDashboard(id: string): void {
  selectedId.value = id;
  listDropdownOpen.value = false;
}
/** Whether a dashboard id has an unpublished local browser draft — drives
 *  the "local" badge in the picker. */
function hasLocalDraftFor(id: string): boolean {
  return localEdits.has(overviewEditName(id));
}
/* Auto-select rule: if nothing is selected (cold start), pick the
 * first dashboard. If the currently-selected id disappears from the
 * list (just deleted by the operator), fall back to the new first.
 *
 * `watchEffect` instead of `watch(immediate:true)` because the watch
 * variant missed the transition when `listQuery` was already cached
 * by vue-query at mount time (staleTime: 60_000) — the watcher fired
 * once with the populated list and once with the empty fallback, in
 * an order that left selectedId blank. watchEffect re-runs eagerly
 * whenever its reactive deps change AND on first paint. */
watchEffect(() => {
  const list = dashboards.value;
  if (list.length === 0) {
    if (selectedId.value !== '') selectedId.value = '';
    return;
  }
  if (!selectedId.value || !list.some((d) => d.id === selectedId.value)) {
    selectedId.value = list[0]!.id;
  }
});

// ── New-dashboard composer ─────────────────────────────────────────
const newDashOpen = ref(false);
const newDashId = ref('');
const newDashTitle = ref('');
const newDashDescription = ref('');
const newDashError = ref<string | null>(null);

function openNewDash(): void {
  newDashOpen.value = true;
  newDashId.value = '';
  newDashTitle.value = '';
  newDashDescription.value = '';
  newDashError.value = null;
}
function cancelNewDash(): void {
  newDashOpen.value = false;
  newDashError.value = null;
}
function createDash(): void {
  const id = newDashId.value.trim();
  const title = newDashTitle.value.trim();
  if (!id) {
    newDashError.value = 'id is required';
    return;
  }
  if (!/^[a-z0-9_-]+$/i.test(id)) {
    newDashError.value = 'id may only contain letters, digits, _ and -';
    return;
  }
  if (!title) {
    newDashError.value = 'title is required';
    return;
  }
  // The id IS the template name (horizon.overview.<id>) — must be unique
  // across server, remote-only, and local drafts. Case-insensitive since
  // OAP keys on the name string.
  const idLc = id.toLowerCase();
  if (dashboards.value.some((d) => d.id.toLowerCase() === idLc)) {
    newDashError.value = `a dashboard with id "${id}" already exists`;
    return;
  }
  // Create mirrors edit: write a LOCAL browser draft, don't touch the
  // server. The dashboard is immediately selectable + previewable; "Check
  // diff & push" publishes it to OAP (create-or-update, server-side).
  const description = newDashDescription.value.trim();
  const dash: OverviewDashboard = {
    id,
    title,
    ...(description ? { description } : {}),
    widgets: [],
  };
  localEdits.set(overviewEditName(id), dash);
  selectedId.value = id;
  newDashOpen.value = false;
  setFlash(`created local draft · ${id} — edit, preview, then “Check diff & push”.`);
}

// ── Preview pane ──────────────────────────────────────────────────
/* Lightweight layout preview — recreates the dashboard's grid + a
 * summary card per widget (kind / title / KPI labels) so the
 * operator can see "is the layout right?" without saving + tab-
 * switching to the actual overview. Mock values fill anywhere the
 * widget would normally show a number (random 0..999 for counts,
 * 0..100 for percent / progress-bar). Not pixel-fidelity vs the real
 * widget components — that would require running the orchestrator
 * against mock OAP data — but enough to validate placement + scope. */
// Canvas selection: the editor is one page now — a mock-data widget grid
// (canvas, left) + a drawer (right) that edits the clicked widget. Mirrors
// the layer dashboards editor.
// Sentinel id for the dashboard-meta "widget" (title + description). Real
// widget ids never collide with it.
const META_SEL = '__meta__';
const selectedWidgetId = ref<string | null>(null);
function selectWidget(id: string): void {
  selectedWidgetId.value = id;
}
// Drop the selection when the dashboard changes.
watch(selectedId, () => {
  selectedWidgetId.value = null;
});
// Esc closes the editor drawer (deselects) — unless a modal owns Esc.
function onEditorKey(e: KeyboardEvent): void {
  if (e.key === 'Escape' && selectedWidgetId.value && !pushDiffOpen.value && !newDashOpen.value) {
    selectedWidgetId.value = null;
  }
}
onMounted(() => window.addEventListener('keydown', onEditorKey));
onBeforeUnmount(() => window.removeEventListener('keydown', onEditorKey));

// Force-refresh the cached config bundle on mount so per-row badges
// (`synced` / `diverged` / `disabled`) reflect actual OAP state. The
// bundle's `syncStatus` is what `useTemplateSync.badgeFor` reads, and
// without this it would surface whatever a prior session persisted to
// localStorage. `force: true` also flushes the BFF's 30s OAP sync
// cache so even a fresh fetch sees live OAP state.
onMounted(() => void refreshConfigBundle({ force: true }));

// ── Canvas drag-reorder (HTML5 DnD over the flat widgets array) ─────
const dragId = ref<string | null>(null);
function onWidgetDragStart(e: DragEvent, id: string): void {
  dragId.value = id;
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
}
function onWidgetDrop(targetId: string): void {
  const d = draft.value;
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
  draft.value = { ...d, widgets: ws };
}

// ── Canvas corner-resize (drag updates span / rowSpan) ──────────────
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
  if (!resize.active || !draft.value) return;
  const span = Math.max(1, Math.min(resize.cols, resize.startSpan + Math.round((e.clientX - resize.startX) / resize.cellW)));
  const rowSpan = Math.max(1, Math.min(8, resize.startRowSpan + Math.round((e.clientY - resize.startY) / resize.cellH)));
  const w = draft.value.widgets.find((x) => x.id === resize.id);
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

interface PreviewSection {
  cols: number;
  /** The section-break widget that opened this section (its id + title),
   *  or null for the implicit first section. Lets the canvas render the
   *  section-break as a selectable header. */
  sb: OverviewWidget | null;
  widgets: OverviewWidget[];
}
const previewSections = computed<PreviewSection[]>(() => {
  if (!draft.value) return [];
  const out: PreviewSection[] = [];
  let cur: PreviewSection | null = null;
  for (const w of draft.value.widgets) {
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

/* Cheap deterministic mock values — keyed by widget id + KPI label
 * so re-renders return the same number (no jitter while editing).
 * Hash-based so different ids look different but each is stable. */
function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}
function mockNumber(seed: string, max = 999): number {
  return hash(seed) % max;
}
function mockPercent(seed: string): number {
  return 10 + (hash(seed) % 85);
}
/** Mock alarm rows for the preview's alarms widget. Deterministic
 *  per widget id so the rows don't churn while editing. */
const MOCK_ALARM_MSGS = [
  'Response time of service mesh-svr::cart is more than 20ms.',
  'JVM old-gen GC > 5s/min on agent::orders',
  'p95 SLA below threshold for service mesh-svr::reviews',
];
const MOCK_ALARM_SCOPES = ['Service · mesh-svr::cart', 'Instance · pod-2 of agent::orders', 'Service · reviews'];
const MOCK_ALARM_AGES = ['2m', '14m', '47m'];
function mockAlarms(seed: string, n: number): Array<{
  key: string;
  firing: boolean;
  msg: string;
  scope: string;
  since: string;
}> {
  const out: Array<{ key: string; firing: boolean; msg: string; scope: string; since: string }> = [];
  const cap = Math.max(0, Math.min(n, MOCK_ALARM_MSGS.length));
  for (let i = 0; i < cap; i++) {
    out.push({
      key: `${seed}::${i}`,
      firing: (hash(seed + i) % 4) !== 0, // ~3/4 firing
      msg: MOCK_ALARM_MSGS[i]!,
      scope: MOCK_ALARM_SCOPES[i]!,
      since: MOCK_ALARM_AGES[i]!,
    });
  }
  return out;
}

/** Mock value per KPI label for the real widget components — percent /
 *  progress-bar rows get a 0-100 value, everything else a plain number.
 *  Keyed by widget id + label so it's stable across re-renders. */
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
/** Grid placement for one preview cell — span/rowSpan within the
 *  section's column count. */
function previewCellStyle(w: OverviewWidget, cols: number): Record<string, string> {
  // Same clamps as the live renderer (OverviewDashboardView.widgetStyle):
  // span ∈ [1, cols], rowSpan ∈ [1, 8].
  return {
    gridColumn: `span ${Math.min(cols, Math.max(1, w.span ?? cols))}`,
    gridRow: `span ${Math.min(8, Math.max(1, w.rowSpan ?? 1))}`,
  };
}

// ── Delete current dashboard ───────────────────────────────────────
// A local-only draft (never pushed) is truly removed from the browser —
// a real hard delete, it was never on OAP. Anything on OAP (bundled or
// remote-only) is soft-disabled, because OAP has no hard DELETE; a
// disabled template drops out of the bundle, so it vanishes from the UI.
// Either way it's irreversible from the UI (no re-enable entrance).
// Styled confirm (replaces window.confirm — native box breaks the dark
// design). `askDeleteDash` opens it with the right copy; `confirmDeleteDash`
// runs the actual delete/disable.
const deleteOpen = ref(false);
const deleteTitle = ref('');
const deleteMessage = ref('');
const deleteConfirmLabel = ref('Delete');
function askDeleteDash(): void {
  const id = selectedId.value;
  if (!id || !editName.value) return;
  const onOap = remoteAvailable.value || bundledExists.value;
  if (!onOap) {
    deleteTitle.value = 'Delete local draft?';
    deleteMessage.value = `Delete the local draft “${id}”? It was never published, so it's removed from this browser only. This can't be undone.`;
    deleteConfirmLabel.value = 'Delete draft';
  } else if (bundledExists.value) {
    deleteTitle.value = 'Disable built-in dashboard?';
    deleteMessage.value = `Disable the built-in dashboard “${id}”? OAP has no hard delete, so it's soft-disabled — hidden from everyone. This can't be undone from the UI.`;
    deleteConfirmLabel.value = 'Disable';
  } else {
    deleteTitle.value = 'Delete dashboard?';
    deleteMessage.value = `Delete the dashboard “${id}”? OAP has no hard delete, so it's soft-disabled — hidden from everyone. This can't be undone from the UI.`;
    deleteConfirmLabel.value = 'Delete';
  }
  deleteOpen.value = true;
}
async function confirmDeleteDash(): Promise<void> {
  const id = selectedId.value;
  const name = editName.value;
  deleteOpen.value = false;
  if (!id || !name) return;
  const onOap = remoteAvailable.value || bundledExists.value;
  if (!onOap) {
    localEdits.remove(name);
    previewOverride.clear(name);
    setFlash(`deleted local draft · ${id}`);
    return;
  }
  try {
    await bff.templateSync.disable(name);
    localEdits.remove(name);
    previewOverride.clear(name);
    await Promise.all([listQuery.refetch(), sources.refetch(), refreshConfigBundle()]);
    setFlash(`deleted · ${id}`);
  } catch (err) {
    setFlash(err instanceof Error ? `error: ${err.message}` : 'delete failed');
  }
}

const detailQuery = useQuery({
  queryKey: computed(() => ['admin/overview-templates', selectedId.value]),
  queryFn: () => bff.overview.adminGet(selectedId.value),
  // Don't fetch detail for a local-only draft — there's no server copy
  // (it would 404); the editor loads it straight from the local draft.
  enabled: computed(() => selectedId.value.length > 0 && isServerBacked.value),
  staleTime: 60_000,
});

const { availableLayers } = useLayers();
/** Union of live layers + any layer already referenced by the draft
 *  so a "configured but quiet" layer (VIRTUAL_GENAI on a deployment
 *  with no AI traffic, etc.) stays selectable. */
const layerOptions = computed<string[]>(() => {
  const live = new Set((availableLayers.value ?? []).map((l) => l.key.toUpperCase()));
  for (const w of draft.value?.widgets ?? []) {
    if (w.layer) live.add(w.layer.toUpperCase());
  }
  return Array.from(live).sort();
});

/* ── Editor sources ───────────────────────────────────────────────
 * Load from LOCAL (browser draft), BUNDLED (shipped), or REMOTE (OAP).
 * `editorSource` tracks which is loaded; `loadedSnapshot` is the baseline
 * for `isDirty`. Save always writes LOCAL; publish LOCAL → OAP after.
 * ─────────────────────────────────────────────────────────────────── */
const editName = computed(() => (selectedId.value ? overviewEditName(selectedId.value) : ''));
const hasLocalDraft = computed<boolean>(() => !!editName.value && localEdits.has(editName.value));
const remoteAvailable = computed<boolean>(() => !!editName.value && sources.hasRemote(editName.value));
// Ships a bundled default → not deletable (delete would fall back to the
// bundle). Drives both the disabled delete button and the guard above.
const bundledExists = computed<boolean>(() => !!editName.value && sources.hasBundled(editName.value));
// When the bundled default matches what's live on OAP, "bundled" and
// "remote" are byte-equal copies of the same dashboard. Surfacing the
// distinction (BUNDLED pill, Reset to bundled, Preview bundled) gives
// the operator no actionable information — hide it. The pill still
// surfaces for LOCAL drafts (always meaningful) and for diverged rows.
const isSynced = computed<boolean>(
  () => !!editName.value && sync.badgeFor(editName.value) === 'synced',
);

const draft = ref<OverviewDashboard | null>(null);
// Remote is the canonical baseline. The editor opens from remote on
// every (re-)mount (`defaultEditorSource` returns 'remote' whenever
// remote is reachable + no local draft exists) and stays there until
// the operator explicitly hits "Reset to bundled" or saves a local
// draft. The initial ref matches so the source pill can stay hidden
// on the default path.
const editorSource = ref<'local' | 'bundled' | 'remote'>('remote');
const loadedSnapshot = ref<string>('');

function bundledContent(): OverviewDashboard | null {
  return (
    sources.bundled<OverviewDashboard>(editName.value) ??
    detailQuery.data.value?.dashboard ??
    null
  );
}
function sourceContent(src: 'local' | 'bundled' | 'remote'): OverviewDashboard | null {
  if (src === 'local') return localEdits.get<OverviewDashboard>(editName.value) ?? null;
  if (src === 'remote') return sources.remote<OverviewDashboard>(editName.value);
  return bundledContent();
}
function loadFrom(src: 'local' | 'bundled' | 'remote'): void {
  const c = sourceContent(src);
  draft.value = c ? (JSON.parse(JSON.stringify(c)) as OverviewDashboard) : null;
  loadedSnapshot.value = draft.value ? JSON.stringify(draft.value) : '';
  editorSource.value = src;
}

/** Write the editor content to the local draft (cleared if it equals
 *  remote). Drives hasLocalDraft / localDiffersFromRemote reactively. */
function persistLocal(content: OverviewDashboard): void {
  const remote = sources.remote<OverviewDashboard>(editName.value);
  if (remote && stableStringify(content) === stableStringify(remote)) {
    localEdits.remove(editName.value);
  } else {
    localEdits.set(editName.value, JSON.parse(JSON.stringify(content)));
  }
  loadedSnapshot.value = JSON.stringify(content);
}

// "Reset to ▾" dropdown — discard the current local draft and reload
// the editor from the picked source. Symmetric with the layer
// dashboards editor: reset is "discard, reload", not "re-stage as a
// new draft" (which would trigger TemplateConflictPrompt right after
// every reset). Subsequent edits re-create a local draft naturally.
const resetDropdownOpen = ref(false);
function resetTo(src: 'bundled' | 'remote'): void {
  loadFrom(src);
  if (editName.value) localEdits.remove(editName.value);
  resetDropdownOpen.value = false;
}

// "Preview ▾" dropdown — open the real overview page in a new tab
// rendering the chosen source (writes it to the preview-override store).
const previewDropdownOpen = ref(false);
function previewLive(src: 'local' | 'bundled' | 'remote'): void {
  const content = sourceContent(src);
  if (!content || !selectedId.value) return;
  previewOverride.set(editName.value, content);
  const href = router.resolve({ path: `/overview/${selectedId.value}`, query: { mode: 'preview', source: src } }).href;
  previewDropdownOpen.value = false;
  window.open(href, '_blank', 'noopener');
}

const flash = ref<string | null>(null);
const saving = ref(false);
function setFlash(msg: string): void {
  flash.value = msg;
  setTimeout(() => {
    if (flash.value === msg) flash.value = null;
  }, 4000);
}

// Manual "refresh from remote" affordance + post-push countdown share
// the same in-flight flag so concurrent clicks can't race each other.
const refreshingFromRemote = ref(false);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Force OAP re-read: invalidate the BFF's 30s sync cache + refetch
 *  everything the page consults. Used by the picker-bar button and as
 *  the tail of `pushToOap` after the propagation countdown. */
async function refreshFromRemote(): Promise<void> {
  if (refreshingFromRemote.value) return;
  refreshingFromRemote.value = true;
  try {
    await bff.templateSync.resync();
    await Promise.all([sources.refetch(), listQuery.refetch(), refreshConfigBundle()]);
    reconcileLocalDrafts();
    setFlash('Refreshed from OAP.');
  } catch (err) {
    setFlash(err instanceof Error ? `error: ${err.message}` : 'refresh failed');
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
    if (!name.startsWith('horizon.overview.')) continue;
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

const isDirty = computed<boolean>(() =>
  draft.value ? JSON.stringify(draft.value) !== loadedSnapshot.value : false,
);

/** Editor content differs from the publish target (remote) — gates Save
 *  so "Reset to bundled" (pristine-vs-load, `isDirty=false`) is still
 *  publishable when bundled ≠ remote. Key-stable to ignore key order. */
const editorDiffersFromRemote = computed<boolean>(() => {
  if (!draft.value) return false;
  const remote = sources.remote<OverviewDashboard>(editName.value);
  if (!remote) return true;
  return stableStringify(draft.value) !== stableStringify(remote);
});

// Which source to seed the editor from for the current selection.
// Remote is the canonical baseline — it's what the runtime bundle serves
// to end users — so the editor opens from remote on every re-mount when
// remote is reachable. Priority:
//   1. Local draft — unpublished in-progress edits in this browser.
//   2. Remote — the default for every re-entry when remote exists.
//   3. Otherwise NOTHING. We do NOT auto-load bundled (even for a
//      bundled-only overview): bundled is the seed/reset source, never the
//      runtime render, so the editor shows a "no published version" panel
//      and the operator resets to bundled explicitly.
function seedEditor(): void {
  if (hasLocalDraft.value) {
    loadFrom('local');
    return;
  }
  if (remoteAvailable.value) {
    loadFrom('remote');
    return;
  }
  draft.value = null;
  loadedSnapshot.value = '';
}
/** Selected overview exists but has neither a local draft nor an OAP row,
 *  so nothing is loaded. Drives the "no published version" panel. */
const noPublishedVersion = computed<boolean>(
  () =>
    sourcesReady.value &&
    !!selectedId.value &&
    !hasLocalDraft.value &&
    !remoteAvailable.value &&
    !draft.value,
);

// Seed the editor when the selected overview (or a background refetch)
// changes — but never clobber unsaved keystrokes OR an operator-driven
// load (Reset to bundled / local draft). Defer the initial seed until
// `sourcesReady` so the editor doesn't visibly flip from bundled to
// remote on first mount. Once sources are ready the watcher runs
// every time the operator picks a different overview.
watch(
  [selectedId, () => detailQuery.data.value],
  () => {
    if (!sourcesReady.value) return;
    if (isDirty.value) return;
    seedEditor();
  },
  { immediate: true },
);

// First-mount deferred seed. The moment sources transition to ready,
// run the seed for the currently-selected overview once.
watch(sourcesReady, (ready, wasReady) => {
  if (ready && !wasReady && selectedId.value && !isDirty.value) {
    seedEditor();
  }
});

/** Save the editor to the browser local draft. Never writes OAP. */
function onSave(): void {
  if (!draft.value || !editName.value) return;
  persistLocal(draft.value);
  editorSource.value = 'local';
  setFlash('Saved to your browser (local). Publish with “Check diff & push”.');
}

// Push = publish local → remote. Available only when a local draft exists
// AND differs from remote. The confirm modal shows the remote→local diff.
const pushDiffOpen = ref(false);
// Key-stable so a one-field edit doesn't read as "everything changed".
function prettyJson(o: unknown): string {
  return o ? stableStringify(o, 2) : '';
}
const localDiffersFromRemote = computed<boolean>(() => {
  const local = localEdits.get<OverviewDashboard>(editName.value);
  if (!local) return false;
  return stableStringify(local) !== stableStringify(sources.remote<OverviewDashboard>(editName.value) ?? null);
});
const pushLocalPretty = computed(() => prettyJson(localEdits.get(editName.value)));
const pushRemotePretty = computed(() => prettyJson(sources.remote(editName.value)));

/** Publish the local draft to OAP. The BFF waits for the new row to
 *  become visible (BanyanDB read-after-write window, ~5s). A live
 *  count-up is shown while waiting. On 504 propagation-timeout the
 *  client still refetches — the row may have propagated moments
 *  later. */
async function pushToOap(): Promise<void> {
  const local = localEdits.get<OverviewDashboard>(editName.value);
  if (!local || saving.value) return;
  saving.value = true;
  flash.value = 'Saving to OAP…';
  let elapsed = 0;
  const ticker = setInterval(() => {
    elapsed++;
    flash.value = `Saving to OAP… ${elapsed}s`;
  }, 1000);
  try {
    await bff.templateSync.save(editName.value, local);
    clearInterval(ticker);
    localEdits.remove(editName.value);
    previewOverride.clear(editName.value);
    pushDiffOpen.value = false;
    for (let n = 10; n > 0; n--) {
      flash.value = `Pushed. Refreshing in ${n}s…`;
      await sleep(1000);
    }
    await bff.templateSync.resync();
    await Promise.all([sources.refetch(), detailQuery.refetch(), refreshConfigBundle()]);
    reconcileLocalDrafts();
    loadFrom('remote');
    setFlash('Published your local draft to OAP — now live for everyone.');
  } catch (err) {
    clearInterval(ticker);
    if (err instanceof BffApiError && err.status === 504) {
      flash.value = 'Timeout waiting for OAP propagation. Refetching…';
      try {
        await bff.templateSync.resync();
        await Promise.all([sources.refetch(), detailQuery.refetch(), refreshConfigBundle()]);
        reconcileLocalDrafts();
      } catch {
        /* refetch best-effort */
      }
      setFlash('Refetched after timeout — the push may have completed; please verify.');
    } else {
      setFlash(err instanceof Error ? `error: ${err.message}` : 'push failed');
    }
  } finally {
    saving.value = false;
  }
}

// ── Import / Export ────────────────────────────────────────────────
// Export downloads the IN-USE version (what end users render: remote,
// else bundled) — never the editor draft. A never-published local-only
// draft has no in-use version, so Export is disabled there.
const canExport = computed<boolean>(() => remoteAvailable.value || bundledExists.value);
function onExport(): void {
  if (!editName.value) return;
  const inUse =
    sources.remote<OverviewDashboard>(editName.value) ??
    sources.bundled<OverviewDashboard>(editName.value);
  if (!inUse) return;
  downloadJson(`${editName.value}.json`, buildExportEnvelope('overview', editName.value, inUse));
}
// Import stages a file as a LOCAL draft for the dashboard the file names
// (a new id creates a new local-only draft), then selects it. Order
// matters: set the draft first so `localOnlyDrafts` sees a new id before
// the auto-select watchEffect runs, then select + force-load local so an
// unsaved-but-dirty editor doesn't suppress the seed watcher.
async function onImportFile(): Promise<void> {
  const text = await pickJsonFile();
  if (text === null) return;
  const res = validateImport('overview', text);
  if (!res.ok) {
    setFlash(res.error);
    return;
  }
  const id = res.key;
  const existed = dashboards.value.some((d) => d.id === id);
  localEdits.set(overviewEditName(id), res.content);
  await nextTick();
  selectedId.value = id;
  selectedWidgetId.value = null;
  loadFrom('local');
  setFlash(
    existed
      ? `Imported · overwrote the local draft “${id}”. Preview, then “Check diff & push”.`
      : `Imported “${id}” as a new local draft. Preview, then “Check diff & push”.`,
  );
}

// ── KPI row helpers (kpi-tile only) ────────────────────────────────
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

// ── Widget reorder + delete ────────────────────────────────────────
function moveWidget(idx: number, dir: -1 | 1): void {
  if (!draft.value) return;
  const next = [...draft.value.widgets];
  const j = idx + dir;
  if (j < 0 || j >= next.length) return;
  [next[idx], next[j]] = [next[j], next[idx]];
  draft.value = { ...draft.value, widgets: next };
}
function removeWidget(idx: number): void {
  if (!draft.value) return;
  const removed = draft.value.widgets[idx];
  const next = draft.value.widgets.filter((_, i) => i !== idx);
  draft.value = { ...draft.value, widgets: next };
  if (removed && removed.id === selectedWidgetId.value) selectedWidgetId.value = null;
}

// ── Add-widget composer ────────────────────────────────────────────
/* Small inline form that gates a new widget on (type, width, height)
 * — the operator picks those first per the spec, then the widget
 * is appended with sensible defaults and the existing per-widget
 * editor handles everything else. */
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
  const existing = new Set(draft.value?.widgets.map((w) => w.id) ?? []);
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
  if (!draft.value) return;
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
  draft.value = { ...draft.value, widgets: [...draft.value.widgets, widget] };
  composerOpen.value = false;
  selectedWidgetId.value = widget.id; // open the drawer to finish editing it
}

// ── Widget meta ────────────────────────────────────────────────────
const WIDGET_TYPE_OPTIONS: ReadonlyArray<{ type: OverviewWidget['type']; label: string }> = [
  { type: 'section-break', label: 'Section break' },
  { type: 'metric', label: 'Metric' },
  { type: 'topology', label: 'Topology' },
  { type: 'alarms', label: 'Alarms' },
  { type: 'kpi-tile', label: 'KPI tile (number + metrics)' },
  { type: 'metric-composite', label: 'Composite metrics (mixed)' },
];

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
</script>

<template>
  <div class="ot">
    <header class="ot__head">
      <div>
        <div class="ot__kicker">{{ t('Dashboard setup · Overviews') }}</div>
        <h1>{{ t('Overview templates') }}</h1>
        <p class="ot__lede">
          <!-- Single translation unit with three inline <code> slots. Splitting
               into separate t() chunks left non-English operators seeing a
               mostly-English sentence with one translated word in the middle. -->
          <i18n-t keypath="Per-widget editor for the overview dashboards. Each widget kind shows only the fields it consumes — e.g. {kpi} exposes its KPI row list with number / progress-bar style; {alarms} exposes the row limit. Type and widget set are code-shape decisions and stay frozen; edits write to OAP via the UI-template REST surface (bundled JSON is the seed + read-only fallback)." tag="span" scope="global">
            <template #kpi><code>kpi-tile</code></template>
            <template #alarms><code>alarms</code></template>
          </i18n-t>
        </p>
      </div>
    </header>

    <SyncStatusBanner :banner="sync.banner.value" />

    <div v-if="listQuery.isPending.value" class="ot__empty">loading…</div>

    <div v-else class="ot__main">
      <!-- Top dashboard picker — filterable dropdown (same pattern as the
           layer dashboards switcher); "+ New" lives inside it. -->
      <div class="ot__picker-bar">
        <div class="ot__dd">
          <button type="button" class="ot__dd-btn" @click="listDropdownOpen = !listDropdownOpen">
            <span class="ot__dd-title">{{ selectedDash?.title || 'Select dashboard' }}</span>
            <code v-if="selectedDash" class="ot__dd-id">{{ selectedDash.id }}</code>
            <span v-if="selectedId && hasLocalDraftFor(selectedId)" class="ot__local-badge" title="Unpublished local draft">local</span>
            <TemplateStatusBadge v-if="selectedId" :status="sync.badgeFor(`horizon.overview.${selectedId}`)" />
            <span class="caret" :class="{ open: listDropdownOpen }">›</span>
          </button>
          <template v-if="listDropdownOpen">
            <div class="ot__dd-backdrop" @click="listDropdownOpen = false" />
            <div class="ot__dd-pop">
              <!-- Browse mode: search + filters + list. Hidden while the
                   New-dashboard composer is open so the form stands alone. -->
              <template v-if="!newDashOpen">
              <div class="ot__dd-search">
                <input v-model="listSearch" type="text" placeholder="Search dashboards…" autocomplete="off" spellcheck="false" />
              </div>
              <div class="ot__dd-filters">
                <label class="ot__dd-filter" :class="{ on: divergedOnly }">
                  <input v-model="divergedOnly" type="checkbox" :disabled="divergedCount === 0" />
                  Diverged<span v-if="divergedCount" class="ot__dd-fc">{{ divergedCount }}</span>
                </label>
                <label class="ot__dd-filter" :class="{ on: localOnly }">
                  <input v-model="localOnly" type="checkbox" :disabled="localDraftCount === 0" />
                  Local<span v-if="localDraftCount" class="ot__dd-fc local">{{ localDraftCount }}</span>
                </label>
              </div>
              <div class="ot__dd-list">
                <button
                  v-for="d in filteredDashboards"
                  :key="d.id"
                  type="button"
                  class="ot__dd-item"
                  :class="{ active: d.id === selectedId }"
                  @click="pickDashboard(d.id)"
                >
                  <span class="ot__dd-item-title">{{ d.title }}</span>
                  <code>{{ d.id }}</code>
                  <span class="ot__dd-item-count">{{ d.widgetCount }}w</span>
                  <span v-if="!d.editable" class="ot__readonly-tag">no source</span>
                  <span v-if="hasLocalDraftFor(d.id)" class="ot__local-badge" title="Unpublished local draft">local</span>
                  <TemplateStatusBadge :status="sync.badgeFor(`horizon.overview.${d.id}`)" />
                </button>
                <p v-if="filteredDashboards.length === 0" class="ot__dd-empty">No dashboards match.</p>
              </div>
              <div class="ot__dd-new">
                <button
                  type="button"
                  class="ot__btn"
                  :disabled="sync.readOnly.value"
                  :title="sync.readOnly.value ? 'OAP unreachable — cannot create' : ''"
                  @click="openNewDash"
                >+ New dashboard</button>
              </div>
              <div class="ot__dd-foot">
                <span class="ot__picker-count">{{ dashboards.length }} dashboard{{ dashboards.length === 1 ? '' : 's' }}</span>
                <button
                  type="button"
                  class="ot__btn ot__refresh-btn"
                  :disabled="refreshingFromRemote || sync.readOnly.value"
                  :title="sync.readOnly.value
                    ? 'OAP unreachable — cannot refresh'
                    : 'Force the BFF to re-read every UI-template from OAP (clears the 30s cache)'"
                  @click="refreshFromRemote"
                >{{ refreshingFromRemote ? 'refreshing…' : 'refresh from remote' }}</button>
              </div>
              </template>

              <!-- Create mode: self-contained form (replaces the list). -->
              <div v-else class="ot__newdash">
                <div class="ot__newdash-head">New dashboard</div>
                <label class="ot__field ot__field--wide">
                  <span>Id (used as the name — must be unique)</span>
                  <input v-model="newDashId" type="text" class="ot__in ot__in--mono" placeholder="my-overview" @keyup.enter="createDash" />
                </label>
                <label class="ot__field ot__field--wide">
                  <span>Title</span>
                  <input v-model="newDashTitle" type="text" class="ot__in" placeholder="My overview" @keyup.enter="createDash" />
                </label>
                <label class="ot__field ot__field--wide">
                  <span>Description (optional)</span>
                  <textarea v-model="newDashDescription" class="ot__in ot__in--ta" rows="2" placeholder="Short, one-paragraph description shown under the dashboard title." />
                </label>
                <div v-if="newDashError" class="ot__newdash-err">{{ newDashError }}</div>
                <div class="ot__newdash-foot">
                  <button type="button" class="ot__btn" @click="cancelNewDash">cancel</button>
                  <button type="button" class="ot__btn ot__btn--primary" @click="createDash">create</button>
                </div>
              </div>
            </div>
          </template>
        </div>
      </div>

      <section class="ot__detail">
        <div v-if="detailQuery.isPending.value && !draft" class="ot__empty">loading…</div>
        <!-- Overview selected but no working copy: no local draft, no OAP
             row. We do NOT auto-load the bundled default (seed/reset source
             only); the operator adopts it explicitly. -->
        <div v-else-if="noPublishedVersion" class="ot__empty ot__no-remote">
          <h3>{{ t('No published version on OAP') }}</h3>
          <p>{{ t('This overview has no version stored on OAP. A bundled default may ship with Horizon, but it is not loaded for editing and the live UI does not render it. Reset to bundled to start from the shipped default, then edit and publish.') }}</p>
          <button class="ot__btn ot__btn--primary" type="button" :disabled="!bundledExists" @click="loadFrom('bundled')">{{ t('Reset to bundled') }}</button>
        </div>
        <template v-else-if="draft">
          <header class="ot__detail-head">
            <h2><code>{{ draft.id }}</code></h2>
            <span class="ot__count mono">
              {{ draft.widgets.length }} widget{{ draft.widgets.length === 1 ? '' : 's' }}
            </span>
            <span v-if="isDirty" class="ot__dirty">unsaved changes</span>
            <span v-else class="ot__clean">saved</span>
            <!-- Delete. A local-only draft is removed from the browser; a
                 dashboard on OAP (bundled or remote-only) is soft-disabled
                 (OAP has no hard delete). Irreversible from the UI. -->
            <button
              type="button"
              class="ot__head-btn ot__head-btn--danger"
              :disabled="sync.readOnly.value && (remoteAvailable || bundledExists)"
              :title="(sync.readOnly.value && (remoteAvailable || bundledExists))
                ? 'OAP unreachable — cannot delete'
                : bundledExists
                  ? `Disable built-in dashboard ${draft.id} (OAP has no hard delete — hidden, irreversible from the UI)`
                  : remoteAvailable
                    ? `Delete dashboard ${draft.id} (soft-disabled on OAP — irreversible from the UI)`
                    : `Delete local draft ${draft.id} (never published)`"
              @click="askDeleteDash"
            >{{ bundledExists ? 'disable' : 'delete' }}</button>
            <!-- Source / save / publish actions, right-aligned (same row as
                 the title + tabs, mirroring the layer dashboards editor). -->
            <div class="ot__head-actions">
              <!-- Source pill — three visible states gated on
                   `sourcesReady` so the initial render doesn't flash
                   "from bundled" while the config bundle is still
                   resolving (see Layer Dashboards admin for the
                   parallel fix). -->
              <span
                v-if="sourcesReady && editorSource === 'local'"
                class="ot__src is-local"
                :title="t('Unpublished local edits — Push to publish to OAP.')"
              >{{ t('from local') }}</span>
              <span
                v-else-if="sourcesReady && editorSource === 'bundled'"
                class="ot__src is-bundled"
                :title="t('Showing the shipped bundled default — Push to overwrite OAP with bundled.')"
              >{{ t('from bundled') }}</span>
              <span
                v-else-if="sourcesReady && editorSource === 'remote'"
                class="ot__src is-remote"
                :title="t('Showing the OAP-live version. End users render the same bytes.')"
              >{{ t('from remote') }}</span>
              <!-- Export the in-use version to a file; import a file as a
                   local draft. Export is disabled for a never-published
                   local-only draft (nothing in use to download). -->
              <button
                type="button"
                class="ot__btn"
                :disabled="!canExport"
                :title="canExport
                  ? 'Download the in-use version (live on OAP, or the bundled default) as a JSON file.'
                  : 'Nothing published yet to export — push this draft first.'"
                @click="onExport"
              >export</button>
              <button
                type="button"
                class="ot__btn"
                title="Import a dashboard JSON file as a local draft — preview, then publish."
                @click="onImportFile"
              >import</button>
              <div class="reset-dd">
                <button type="button" class="ot__btn" @click="resetDropdownOpen = !resetDropdownOpen">
                  reset to <span class="caret" :class="{ open: resetDropdownOpen }">›</span>
                </button>
                <template v-if="resetDropdownOpen">
                  <div class="reset-dd-backdrop" @click="resetDropdownOpen = false" />
                  <div class="reset-dd-pop">
                    <!-- Bundled stays visible when synced; disabled
                         with "(synced)" tail so the option is
                         recognizable but the operator knows there's
                         nothing meaningful to reset to. -->
                    <button
                      class="reset-dd-item"
                      type="button"
                      :disabled="isSynced"
                      :title="isSynced
                        ? t('Bundled equals OAP-live for this row — nothing to reset to.')
                        : t('Discard current edits and reload the bundled default.')"
                      @click="resetTo('bundled')"
                    >{{ t('Bundled') }}<span v-if="isSynced" class="reset-dd-suffix"> {{ t('(synced)') }}</span></button>
                    <button class="reset-dd-item" type="button" :disabled="!remoteAvailable" :title="remoteAvailable ? t('Discard current edits and reload OAP\'s live version.') : t('OAP has no copy yet.')" @click="resetTo('remote')">{{ t('Remote') }}</button>
                  </div>
                </template>
              </div>
              <div class="reset-dd">
                <button type="button" class="ot__btn" @click="previewDropdownOpen = !previewDropdownOpen">
                  preview <span class="caret" :class="{ open: previewDropdownOpen }">›</span>
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
              <button
                v-if="!sync.readOnly.value"
                type="button"
                class="ot__btn"
                :disabled="!localDiffersFromRemote || saving"
                :title="localDiffersFromRemote ? 'Review the local → remote diff, then publish to OAP.' : 'No local changes to publish — local matches remote.'"
                @click="pushDiffOpen = true"
              >
                check diff &amp; push
              </button>
              <button
                type="button"
                class="ot__btn ot__btn--primary"
                :disabled="(!isDirty && !editorDiffersFromRemote) || saving"
                title="Save the editor to your browser (local). Publish later with “Check diff & push”."
                @click="onSave"
              >
                {{ saving ? 'saving…' : 'save (local)' }}
              </button>
            </div>
          </header>
          <!-- Own row so a long flash never overlaps the action cluster. -->
          <div v-if="flash" class="ot__flash-row">
            <span class="ot__flash">{{ flash }}</span>
          </div>

          <!-- One-page editor: mock-data widget grid (canvas, left) +
               drawer (right) that edits the clicked widget. -->
          <div class="ot__editor-split" :class="{ 'has-sel': !!selectedWidgetId }">

          <aside v-if="selectedWidgetId" class="ot__drawer-pane ot__widgets">
            <div class="ot__drawer-head">
              <span class="ot__drawer-title">{{ selectedWidgetId === META_SEL ? 'Dashboard meta' : 'Edit widget' }}</span>
              <button type="button" class="ot__drawer-close" title="Close (Esc)" @click="selectedWidgetId = null">✕</button>
            </div>
            <!-- Dashboard-level meta: title + description. -->
            <section v-if="selectedWidgetId === META_SEL" class="ot__meta">
              <header class="ot__meta-head">
                <span class="ot__meta-kicker">Dashboard meta</span>
                <span class="ot__meta-hint">Shown in the sidebar and as the page sub-heading.</span>
              </header>
              <label class="ot__field">
                <span>Title</span>
                <input v-model="draft.title" type="text" class="ot__in" />
              </label>
              <label class="ot__field ot__field--wide">
                <span>Description</span>
                <textarea
                  v-model="draft.description"
                  class="ot__in ot__in--ta"
                  rows="3"
                  placeholder="Short, one-paragraph description shown under the dashboard title."
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
              <!-- Header: type kicker + widget id + move/delete row actions. -->
              <header class="ot__widget-head">
                <span class="ot__widget-kind">{{ widgetKindLabel(w.type) }}</span>
                <code class="ot__widget-id">{{ w.id }}</code>
                <span class="ot__widget-actions">
                  <button
                    type="button"
                    class="ot__arrow"
                    :disabled="wi === 0"
                    title="Move up"
                    @click="moveWidget(wi, -1)"
                  >‹</button>
                  <button
                    type="button"
                    class="ot__arrow"
                    :disabled="wi === draft.widgets.length - 1"
                    title="Move down"
                    @click="moveWidget(wi, 1)"
                  >›</button>
                  <button
                    type="button"
                    class="ot__del"
                    title="Remove widget"
                    @click="removeWidget(wi)"
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

              <!-- 2. Title + tip. -->
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

              <!-- 3. Layer — universal for data widgets. -->
              <div v-if="w.type !== 'section-break'" class="ot__row">
                <label class="ot__field">
                  <span>Layer</span>
                  <select v-model="w.layer" class="ot__in ot__in--narrow">
                    <option :value="undefined">— any —</option>
                    <option v-for="k in layerOptions" :key="k" :value="k">{{ k }}</option>
                  </select>
                </label>
              </div>

              <!-- metric: mqe + unit + aggregation -->
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

              <!-- alarms: limit -->
              <div v-if="w.type === 'alarms'" class="ot__row">
                <label class="ot__field">
                  <span>Row limit</span>
                  <input v-model.number="w.limit" type="number" min="1" max="100" class="ot__in ot__in--num" />
                </label>
              </div>

              <!-- kpi-tile / metric-composite: KPI rows. -->
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

          <!-- Canvas: mock-data widget grid (left). Click a widget to edit
               it in the drawer; only the live "Preview ▾" page uses real
               OAP data. -->
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
              <h2>{{ draft.title || draft.id }}</h2>
              <p v-if="draft.description" class="ot__canvas-desc">{{ draft.description }}</p>
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
                    <!-- Per-type mock body. -->
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
          </div>
        </template>
      </section>
    </div>

    <!-- Push confirm: shows the remote → local diff before publishing. -->
    <Modal :open="pushDiffOpen" title="Publish local → OAP?" width="min(1100px, 94vw)" @close="pushDiffOpen = false">
      <p class="ot__push-lede">
        This replaces the live (remote) version with your local draft — live for everyone. Review the
        diff (left = remote, right = your local):
      </p>
      <div class="ot__push-diff">
        <MonacoDiff :original="pushRemotePretty" :modified="pushLocalPretty" language="json" />
      </div>
      <template #footer>
        <button class="sw-btn" type="button" @click="pushDiffOpen = false">Cancel</button>
        <button class="sw-btn is-primary" type="button" :disabled="saving" @click="pushToOap">
          {{ saving ? 'Pushing…' : 'Confirm push' }}
        </button>
      </template>
    </Modal>

    <!-- Delete / disable confirm — styled (not the native confirm box). -->
    <Modal :open="deleteOpen" :title="deleteTitle" width="min(520px, 92vw)" @close="deleteOpen = false">
      <p class="ot__confirm-msg">{{ deleteMessage }}</p>
      <template #footer>
        <button class="sw-btn" type="button" @click="deleteOpen = false">Cancel</button>
        <button class="sw-btn is-danger" type="button" @click="confirmDeleteDash">{{ deleteConfirmLabel }}</button>
      </template>
    </Modal>
  </div>
</template>

<style scoped>
.ot__confirm-msg { margin: 0; font-size: 13px; line-height: 1.55; color: var(--sw-fg-1); }
.sw-btn.is-danger { border-color: rgba(239, 68, 68, 0.4); color: #f87171; }
.sw-btn.is-danger:hover { background: var(--sw-err-soft, rgba(239, 68, 68, 0.12)); }
.reset-dd { position: relative; display: inline-flex; }
.reset-dd .caret { display: inline-block; transform: rotate(90deg); font-size: 11px; }
.reset-dd .caret.open { transform: rotate(-90deg); }
.reset-dd-backdrop { position: fixed; inset: 0; z-index: 40; }
.reset-dd-pop {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
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
.ot__push-lede { margin: 0 0 10px; font-size: 12px; color: var(--sw-fg-2); line-height: 1.5; }
.ot__push-diff { height: 50vh; min-height: 320px; border: 1px solid var(--sw-line); border-radius: 6px; overflow: hidden; }
</style>

<style scoped>
.ot { padding: 20px 20px 60px; max-width: 1400px; margin: 0 auto; }
.ot__head { margin-bottom: 18px; }
.ot__kicker {
  font-size: 10px; text-transform: uppercase; letter-spacing: 0.1em;
  color: var(--sw-accent); margin-bottom: 4px;
}
.ot h1 { font-size: 22px; font-weight: 600; color: var(--sw-fg-0); margin: 0 0 8px; }
.ot__lede { font-size: 12.5px; color: var(--sw-fg-1); line-height: 1.5; margin: 0; max-width: 820px; }
.ot__lede code {
  font-family: var(--sw-mono); font-size: 11.5px;
  color: var(--sw-fg-0); background: var(--sw-bg-2); padding: 1px 5px; border-radius: 3px;
}
.ot__empty { padding: 32px; text-align: center; color: var(--sw-fg-3); font-size: 12px; }
.ot__no-remote { text-align: left; max-width: 600px; padding: 24px; }
.ot__no-remote h3 { margin: 0 0 8px; font-size: 14px; color: var(--sw-fg-0); }
.ot__no-remote p { margin: 0 0 16px; font-size: 12px; line-height: 1.6; color: var(--sw-fg-2); }
.ot__toolbar { display: flex; justify-content: flex-end; margin: 8px 0; }

.ot__main { display: flex; flex-direction: column; gap: 12px; }
.ot__picker-bar { display: flex; align-items: center; gap: 10px; }
.ot__picker-count { font-size: 10.5px; color: var(--sw-fg-3); }
.ot__dd-foot {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border-top: 1px solid var(--sw-line-2);
}
.ot__dd-foot .ot__refresh-btn { margin-left: auto; font-size: 11px; height: 24px; padding: 0 8px; }
.ot__dd { position: relative; display: flex; }
.ot__dd-btn {
  display: inline-flex; align-items: center; gap: 8px;
  height: 32px; padding: 0 12px;
  background: var(--sw-bg-2); border: 1px solid var(--sw-line-2); border-radius: 6px;
  color: var(--sw-fg-0); font: inherit; font-size: 13px; font-weight: 600; cursor: pointer; min-width: 240px;
}
.ot__dd-btn:hover { background: var(--sw-bg-3); }
.ot__dd-btn .ot__dd-title { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 280px; }
.ot__dd-btn .ot__dd-id { font-family: var(--sw-mono); font-size: 10px; color: var(--sw-fg-3); background: var(--sw-bg-1); padding: 1px 5px; border-radius: 3px; }
.ot__dd-btn .caret { margin-left: auto; transform: rotate(90deg); transition: transform 0.15s; font-size: 12px; }
.ot__dd-btn .caret.open { transform: rotate(-90deg); }
.ot__dd-backdrop { position: fixed; inset: 0; z-index: 40; }
.ot__dd-pop {
  position: absolute; top: calc(100% + 4px); left: 0; z-index: 41;
  width: min(80vw, 560px); max-height: 60vh; display: flex; flex-direction: column;
  background: var(--sw-bg-1); border: 1px solid var(--sw-line); border-radius: 8px;
  box-shadow: 0 12px 32px -8px rgba(0,0,0,0.5); padding: 6px;
}
.ot__dd-filters { display: flex; gap: 12px; padding: 2px 4px 8px; border-bottom: 1px solid var(--sw-line); margin-bottom: 4px; }
.ot__dd-filter { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; color: var(--sw-fg-2); cursor: pointer; }
.ot__dd-filter.on { color: var(--sw-fg-0); }
.ot__dd-filter input:disabled { cursor: not-allowed; }
.ot__dd-fc { padding: 0 5px; border-radius: 8px; background: var(--sw-warn, var(--sw-accent)); color: #1a1a1a; font-size: 9.5px; font-weight: 700; }
.ot__dd-search { padding: 2px 2px 6px; }
.ot__dd-search input {
  width: 100%; box-sizing: border-box; height: 30px; padding: 0 8px;
  background: var(--sw-bg-2); border: 1px solid var(--sw-line-2); border-radius: 5px; color: var(--sw-fg-0); font: inherit; font-size: 12px;
}
.ot__dd-search input:focus { outline: none; border-color: var(--sw-accent); }
.ot__dd-list { overflow-y: auto; display: flex; flex-direction: column; gap: 2px; }
.ot__dd-item {
  display: flex; align-items: center; gap: 8px; width: 100%;
  padding: 7px 9px; border: none; background: transparent; border-radius: 5px;
  color: var(--sw-fg-1); font: inherit; font-size: 12px; text-align: left; cursor: pointer;
}
.ot__dd-item:hover { background: var(--sw-bg-2); color: var(--sw-fg-0); }
.ot__dd-item.active { background: var(--sw-accent-soft); color: var(--sw-accent-2); box-shadow: inset 2px 0 0 var(--sw-accent); }
.ot__dd-item-title { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ot__dd-item code { font-family: var(--sw-mono); font-size: 10px; color: var(--sw-fg-3); }
.ot__dd-item-count { font-family: var(--sw-mono); font-size: 10px; color: var(--sw-fg-3); }
.ot__dd-empty { padding: 10px; font-size: 11px; color: var(--sw-fg-3); }
.ot__local-badge {
  flex: 0 0 auto; font-size: 9px; font-weight: 700; letter-spacing: 0.06em;
  text-transform: uppercase; color: #1a1a1a; background: var(--sw-warn, #f59e0b);
  padding: 1px 6px; border-radius: 8px;
}
.ot__dd-new { border-top: 1px solid var(--sw-line); margin-top: 4px; padding: 8px 2px 2px; }
.ot__split { display: grid; grid-template-columns: 280px 1fr; gap: 16px; align-items: start; }
.ot__list {
  list-style: none; margin: 0; padding: 0;
  background: var(--sw-bg-1); border: 1px solid var(--sw-line); border-radius: 8px; overflow: hidden;
}
.ot__list-item { padding: 10px 14px; border-bottom: 1px solid var(--sw-line); cursor: pointer; }
.ot__list-item:last-child { border-bottom: none; }
.ot__list-item:hover { background: var(--sw-bg-2); }
.ot__list-item.active { background: var(--sw-bg-3); box-shadow: inset 2px 0 0 var(--sw-accent); }
.ot__list-item.readonly { opacity: 0.6; cursor: not-allowed; }
.ot__list-title { font-size: 12.5px; font-weight: 500; color: var(--sw-fg-0); }
.ot__list-meta { margin-top: 4px; display: flex; gap: 8px; font-size: 10.5px; color: var(--sw-fg-3); }
.ot__list-meta code { font-family: var(--sw-mono); color: var(--sw-fg-2); }
.ot__readonly-tag { color: var(--sw-warn); font-style: italic; }
.ot__list-empty { padding: 24px; text-align: center; font-size: 12px; color: var(--sw-fg-3); }
.ot__list-add { padding: 8px; border-top: 1px solid var(--sw-line); }
.ot__add-trigger--list { font-size: 11.5px; padding: 6px; }
.ot__newdash { display: flex; flex-direction: column; gap: 10px; padding: 10px 12px; }
.ot__newdash-head {
  font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em;
  color: var(--sw-fg-2); padding-bottom: 8px; border-bottom: 1px solid var(--sw-line);
}
.ot__newdash-err { font-size: 11px; color: var(--sw-err); }
.ot__newdash-foot {
  display: flex; gap: 8px; justify-content: flex-end;
  padding-top: 8px; border-top: 1px solid var(--sw-line);
}
.ot__head-btn {
  background: transparent;
  border: 1px solid var(--sw-line-2);
  color: var(--sw-fg-2);
  font: inherit;
  font-size: 10.5px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  padding: 4px 10px;
  border-radius: 4px;
  cursor: pointer;
}
.ot__head-btn:hover { background: var(--sw-bg-2); color: var(--sw-fg-0); }
.ot__head-btn.active { background: var(--sw-bg-3); color: var(--sw-fg-0); border-color: var(--sw-accent); }
.ot__head-btn--danger:hover {
  background: transparent; color: var(--sw-err); border-color: rgba(239,68,68,0.4);
}

/* Config / Preview tab strip. Sits between the dashboard id + the
 * delete action; consumes flex space so the delete button lands at
 * the right edge. */
.ot__tabs {
  display: inline-flex;
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line);
  border-radius: 5px;
  padding: 2px;
  margin-left: 12px;
}
.ot__tab {
  background: transparent;
  border: 0;
  color: var(--sw-fg-2);
  font: inherit;
  font-size: 11px;
  font-weight: 500;
  padding: 4px 14px;
  border-radius: 3px;
  cursor: pointer;
}
.ot__tab:hover { color: var(--sw-fg-0); }
.ot__tab.active {
  background: var(--sw-bg-3);
  color: var(--sw-fg-0);
  font-weight: 600;
}

/* Preview pane */
.ot__preview {
  margin-top: 14px;
  padding: 12px;
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line);
  border-radius: 6px;
}
.ot__preview-head {
  display: flex; align-items: baseline; gap: 8px;
  margin-bottom: 10px;
}
.ot__preview-head h3 {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--sw-fg-2);
  margin: 0;
}
.ot__preview-hint { font-size: 10.5px; color: var(--sw-fg-3); font-style: italic; }
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
.ot__pv-bignum {
  font-size: 20px; font-weight: 600; color: var(--sw-fg-0);
  font-variant-numeric: tabular-nums; margin-top: auto;
}
.ot__pv-bignum--err { color: var(--sw-err); }
.ot__pv-unit { font-size: 11px; color: var(--sw-fg-3); margin-left: 4px; }
.ot__pv-sub { font-size: 10px; color: var(--sw-fg-3); }
.ot__pv-mqe {
  font-family: var(--sw-mono); font-size: 9px;
  color: var(--sw-fg-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
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

/* Alarms mock rows */
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

/* Composite metrics mock — same number-grid + bar-grid split the
 * real MetricCompositeWidget uses. */
.ot__pv-num-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(72px, 1fr));
  gap: 4px;
}
.ot__pv-num-tile {
  display: flex; flex-direction: column; gap: 1px;
  padding: 5px 7px;
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line);
  border-radius: 4px;
}
.ot__pv-num-val {
  font-size: 14px; font-weight: 600; color: var(--sw-fg-0);
  font-variant-numeric: tabular-nums;
}
.ot__pv-num-unit { font-size: 9px; color: var(--sw-fg-3); margin-left: 2px; }
.ot__pv-num-label {
  font-size: 9px; color: var(--sw-fg-3);
  text-transform: uppercase; letter-spacing: 0.05em;
}
.ot__pv-bar-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 6px;
  margin-top: 6px;
}
.ot__pv-bar-row { display: flex; flex-direction: column; gap: 3px; }
.ot__pv-bar-head { display: flex; justify-content: space-between; align-items: baseline; }
.ot__pv-bar-label { font-size: 10px; color: var(--sw-fg-2); }
.ot__pv-bar-val {
  font-size: 10.5px; font-weight: 600; color: var(--sw-fg-0);
  font-variant-numeric: tabular-nums;
}
.ot__pv-bar {
  height: 3px; background: var(--sw-bg-2);
  border-radius: 2px; overflow: hidden;
}
.ot__pv-bar-fill { display: block; height: 100%; background: var(--sw-accent); }
.ot__pv-empty {
  padding: 14px; text-align: center;
  font-size: 11px; color: var(--sw-fg-3); font-style: italic;
}

.ot__detail { background: var(--sw-bg-1); border: 1px solid var(--sw-line); border-radius: 8px; padding: 16px; }
/* One-page editor: canvas (left, mock-data grid) + drawer (right, editor).
   DOM order is drawer-then-canvas; `order` flips them visually. */
.ot__editor-split { display: flex; gap: 14px; align-items: flex-start; }
.ot__canvas-pane { order: 1; flex: 1 1 0; min-width: 0; }
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
.ot__canvas-hint { font-size: 10.5px; color: var(--sw-fg-3); margin-bottom: 8px; }
.ot__canvas-title {
  margin-bottom: 12px; padding: 4px 6px 10px; cursor: pointer; border-radius: 6px;
  /* Same selectable hint as the canvas cells. */
  outline: 1px dashed var(--sw-line-2); outline-offset: 2px;
}
.ot__canvas-title:hover { background: var(--sw-bg-2); outline-color: var(--sw-fg-3); }
.ot__canvas-title h2 { margin: 0; font-size: 17px; font-weight: 600; color: var(--sw-fg-0); }
.ot__canvas-desc { margin: 4px 0 0; font-size: 12px; color: var(--sw-fg-2); line-height: 1.5; max-width: 760px; }
.ot__drawer-head { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; padding-bottom: 8px; border-bottom: 1px solid var(--sw-line); }
.ot__drawer-title { font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--sw-fg-2); font-weight: 600; }
.ot__drawer-close { margin-left: auto; background: transparent; border: none; color: var(--sw-fg-3); font-size: 14px; cursor: pointer; width: 22px; height: 22px; border-radius: 4px; }
.ot__drawer-close:hover { background: var(--sw-bg-2); color: var(--sw-fg-0); }
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
.ot__detail-head { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; flex-wrap: wrap; }
.ot__head-actions { display: flex; align-items: center; gap: 8px; margin-left: auto; }
.ot__detail-subhead { display: flex; align-items: center; justify-content: flex-end; gap: 10px; margin-bottom: 12px; }
.ot__del-note { font-size: 10.5px; color: var(--sw-fg-3); font-style: italic; }
.ot__detail-head h2 { margin: 0; font-size: 13px; font-weight: 600; }
.ot__detail-head h2 code { font-family: var(--sw-mono); color: var(--sw-fg-0); }
.ot__count { font-size: 11px; color: var(--sw-fg-3); }

/* Per-widget card */
.ot__widgets { display: flex; flex-direction: column; gap: 10px; }
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
.ot__row--tight { gap: 4px; align-items: center; }
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
.ot__in--xnarrow { width: 70px; }
.ot__in--mono { font-family: var(--sw-mono); }
.ot__in--num { width: 80px; font-variant-numeric: tabular-nums; }
.ot__in--xnum { width: 48px; font-variant-numeric: tabular-nums; }
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

/* Dashboard-level meta card (sits above the widget list). */
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

/* Sub-title (description preview) in the dashboard list. */
.ot__list-desc {
  margin-top: 3px;
  color: var(--sw-fg-2);
  font-size: 11px;
  line-height: 1.4;
  /* Clamp to two lines so long descriptions don't push the meta row
     off-screen. Falls back gracefully on browsers without -webkit-line-clamp. */
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

/* KPI sub-table */
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

/* Add-widget composer */
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

.ot__flash-row { display: flex; justify-content: flex-end; padding: 4px 0 0; }
.ot__flash { font-size: 11px; color: var(--sw-ok); }
.ot__dirty { font-size: 11px; color: var(--sw-warn); }
/* Source pill — per-state theme matched across all three editors
 * (Layer Dashboards, Overview Templates, Translations):
 *   local   → warn  : unpublished edits, action recommended
 *   bundled → info  : informational (showing disk default)
 *   remote  → dim   : canonical baseline, quiet */
.ot__src {
  font-size: var(--sw-fs-xs);
  font-weight: var(--sw-fw-semibold);
  text-transform: uppercase;
  letter-spacing: var(--sw-ls-caps);
  border-radius: 4px;
  padding: 2px 7px;
}
.ot__src.is-local   { color: var(--sw-warn); background: var(--sw-warn-soft); border: 1px solid transparent; }
.ot__src.is-bundled { color: var(--sw-info); background: var(--sw-info-soft); border: 1px solid transparent; }
.ot__src.is-remote  { color: var(--sw-fg-3); background: var(--sw-bg-2);     border: 1px solid var(--sw-line-2); }
.ot__clean { font-size: 11px; color: var(--sw-fg-3); }
.ot__btn {
  background: var(--sw-bg-1); border: 1px solid var(--sw-line-2);
  color: var(--sw-fg-0); font: inherit; font-size: 12px;
  padding: 6px 14px; border-radius: 4px; cursor: pointer;
}
.ot__btn:not(:disabled):hover { background: var(--sw-bg-2); }
.ot__btn:disabled { opacity: 0.4; cursor: not-allowed; }
.ot__btn--primary {
  background: var(--sw-accent); border-color: var(--sw-accent);
  color: #0a0d12; font-weight: 600;
}
.ot__btn--primary:not(:disabled):hover { background: var(--sw-accent-light, #fb923c); }
</style>
