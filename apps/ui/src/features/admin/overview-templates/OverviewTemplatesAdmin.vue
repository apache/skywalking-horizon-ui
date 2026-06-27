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
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch, watchEffect } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import { useQuery } from '@tanstack/vue-query';
import type { OverviewDashboard } from '@skywalking-horizon-ui/api-client';
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
import TemplatePicker, { type TemplatePickerEntry } from '@/features/admin/_shared/TemplatePicker.vue';
import { useTemplateSync } from '@/features/admin/_shared/useTemplateSync';
import Modal from '@/features/operate/_shared/Modal.vue';
import MonacoDiff from '@/features/operate/_shared/MonacoDiff.vue';
import OverviewEditCanvas from './OverviewEditCanvas.vue';
import OverviewWidgetDrawer from './OverviewWidgetDrawer.vue';
import NewOverviewDashboardModal from './NewOverviewDashboardModal.vue';

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
// True when the selected dashboard exists on the server (disk/remote) — a
// local-only draft has no server detail to fetch, so the detail query must
// stay disabled for it (it would 404).
const isServerBacked = computed(() =>
  serverDashboards.value.some((d) => d.id === selectedId.value),
);

// Top dashboard picker — the shared TemplatePicker chip + dropdown (same
// component the Translations page uses). Filterable + Diverged / Local
// filters live inside it; "+ New dashboard" sits beside it.
function isDivergedRow(id: string): boolean {
  const s = sync.badgeFor(`horizon.overview.${id}`);
  return s === 'diverged' || s === 'bundled-fallback';
}
/** Whether a dashboard id has an unpublished local browser draft — drives
 *  the "local" badge in the picker. */
function hasLocalDraftFor(id: string): boolean {
  return localEdits.has(overviewEditName(id));
}
const pickerEntries = computed<TemplatePickerEntry[]>(() =>
  dashboards.value.map((d) => ({
    value: d.id,
    label: d.title,
    key: d.id,
    syncBadge: sync.badgeFor(`horizon.overview.${d.id}`),
    hasLocalDraft: hasLocalDraftFor(d.id),
    isDiverged: isDivergedRow(d.id),
  })),
);
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

const newDashOpen = ref(false);
const newDashError = ref<string | null>(null);

function openNewDash(): void {
  newDashOpen.value = true;
  newDashError.value = null;
}
function cancelNewDash(): void {
  newDashOpen.value = false;
  newDashError.value = null;
}
function createDash(payload: { id: string; title: string; description: string }): void {
  const id = payload.id.trim();
  const title = payload.title.trim();
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
  const description = payload.description.trim();
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

/* Lightweight layout preview — recreates the dashboard's grid + a
 * summary card per widget (kind / title / KPI labels) so the
 * operator can see "is the layout right?" without saving + tab-
 * switching to the actual overview. Mock values fill anywhere the
 * widget would normally show a number (random 0..999 for counts,
 * 0..100 for percent / progress-bar). Not pixel-fidelity vs the real
 * widget components — that would require running the orchestrator
 * against mock OAP data — but enough to validate placement + scope. */
// Canvas selection: the editor is one page now — a mock-data widget grid
// (OverviewEditCanvas, left) + a drawer (OverviewWidgetDrawer, right) that
// edits the clicked widget. The canvas owns its own drag / resize / add-
// widget composer; the parent owns only the shared selection + the array-
// level reorder / remove the drawer reaches back into.
const selectedWidgetId = ref<string | null>(null);
function selectWidget(id: string): void {
  selectedWidgetId.value = id;
}
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

// Widget reorder + delete — the drawer reaches back into these.
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
      <!-- Top dashboard picker — shared TemplatePicker chip + dropdown
           (search + Diverged / Local filters + refresh live inside it);
           "+ New dashboard" sits beside it. -->
      <div class="ot__picker-bar">
        <TemplatePicker
          :model-value="selectedId"
          :entries="pickerEntries"
          kind-label="dashboards"
          :refreshing="refreshingFromRemote"
          @update:model-value="(v) => (selectedId = v)"
          @refresh="refreshFromRemote"
        />
        <button
          type="button"
          class="ot__btn"
          :disabled="sync.readOnly.value"
          :title="sync.readOnly.value ? 'OAP unreachable — cannot create' : ''"
          @click="openNewDash"
        >+ New dashboard</button>
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
            <OverviewWidgetDrawer
              v-if="selectedWidgetId"
              :draft="draft"
              :selected-widget-id="selectedWidgetId"
              :layer-options="layerOptions"
              @close="selectedWidgetId = null"
              @move="moveWidget"
              @remove="removeWidget"
              @update:title="(v) => { if (draft) draft.title = v; }"
              @update:description="(v) => { if (draft) draft.description = v; }"
            />
            <OverviewEditCanvas
              :model-value="draft"
              :selected-widget-id="selectedWidgetId"
              @update:model-value="(d) => (draft = d)"
              @select-widget="selectWidget"
            />
          </div>
        </template>
      </section>
    </div>

    <!-- New-dashboard composer. Create mirrors edit — the parent writes a
         LOCAL browser draft and validates uniqueness, pushing any failure
         back via :error. -->
    <NewOverviewDashboardModal
      :open="newDashOpen"
      :error="newDashError"
      @close="cancelNewDash"
      @submit="createDash"
    />

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

.ot__main { display: flex; flex-direction: column; gap: 12px; }
.ot__picker-bar { display: flex; align-items: center; gap: 10px; }

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
.ot__head-btn--danger:hover {
  background: transparent; color: var(--sw-err); border-color: rgba(239,68,68,0.4);
}

.ot__detail { background: var(--sw-bg-1); border: 1px solid var(--sw-line); border-radius: 8px; padding: 16px; }
/* One-page editor: canvas (left, mock-data grid) + drawer (right, editor).
   The panes set their own `order` / `flex` from inside their components. */
.ot__editor-split { display: flex; gap: 14px; align-items: flex-start; }
.ot__detail-head { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; flex-wrap: wrap; }
.ot__head-actions { display: flex; align-items: center; gap: 8px; margin-left: auto; }
.ot__detail-head h2 { margin: 0; font-size: 13px; font-weight: 600; }
.ot__detail-head h2 code { font-family: var(--sw-mono); color: var(--sw-fg-0); }
.ot__count { font-size: 11px; color: var(--sw-fg-3); }

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
