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
  Translations page (`/admin/translations`). Three-step picker (Kind →
  Template → Component) drives a live preview rendered with the shared
  read-only canvas components — the same widgets the operator sees on
  live pages, rendered from the picked template + the operator's
  in-progress translation overlay applied to the EN source.

  Editing model: clicking any widget in the preview opens a floating
  panel anchored next to it, with only that widget's translatable
  fields (title, tip, kpi labels, expressionLabels, …). Save in the
  panel writes to the per-template in-memory draft. The draft is
  staged into the browser's local-edit store (the same one the layer
  + overview admin pages use), which the BFF config-bundle layer
  overlays so the preview reflects the changes. Push opens a Monaco
  diff modal (remote vs local) and publishes via templateSync.save.
-->
<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useTemplateSources } from '@/features/admin/_shared/useTemplateSources';
import {
  buildOverlayExportEnvelope,
  downloadJson,
  parseOverlayImport,
  pickJsonFile,
} from '@/features/admin/_shared/templatePortability';
import { useTemplateSync } from '@/features/admin/_shared/useTemplateSync';
import SyncStatusBanner from '@/features/admin/_shared/SyncStatusBanner.vue';
import LayerDashboardCanvas from '@/features/admin/_shared/LayerDashboardCanvas.vue';
import OverviewDashboardCanvas from '@/features/admin/_shared/OverviewDashboardCanvas.vue';
import TemplatePicker, { type TemplatePickerEntry } from '@/features/admin/_shared/TemplatePicker.vue';
import TypeaheadSelect from '@/components/primitives/TypeaheadSelect.vue';
import FloatingPanel from '@/components/primitives/FloatingPanel.vue';
import Modal from '@/features/operate/_shared/Modal.vue';
import MonacoDiff from '@/features/operate/_shared/MonacoDiff.vue';
import { useLocalTranslationEdits } from '@/controls/localTranslationEdits';
import { refreshConfigBundle } from '@/controls/configBundle';
import { bff, BffApiError } from '@/api/client';
import { stableStringify } from '@/utils/stableJson';
import {
  walkTranslatable,
  setAtPath,
  getAtPath,
  type TranslatableField,
} from '@/features/admin/_shared/translatableFields';
import { SUPPORTED_LOCALES, LOCALE_NATIVE_LABEL, type Locale } from '@/i18n';
import { vAutosize } from '@/utils/autosize';
import type { AdminLayerTemplate } from '@/api/client';
import type {
  OverviewDashboard,
  OverviewWidget,
  DashboardWidget,
  DashboardScope,
} from '@skywalking-horizon-ui/api-client';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const { t } = useI18n({ useScope: 'global' });

const overviewSources = useTemplateSources('overview');
const layerSources = useTemplateSources('layer');
const layerSync = useTemplateSync({ kind: 'layer' });
const overviewSync = useTemplateSync({ kind: 'overview' });
const localEdits = useLocalTranslationEdits();

// ── Picker state ───────────────────────────────────────────────────
const selectedKind = ref<'overview' | 'layer'>('overview');
const selectedName = ref<string>('');
const scope = ref<DashboardScope>('service');

// Bundled-only entries (overview / layer rows the operator may not
// have pushed yet) come off the sync-status badge list.
const bundledOverviewNames = computed<string[]>(() => {
  const s = overviewSync.status.value;
  return s ? s.badges.filter((b) => b.kind === 'overview').map((b) => b.name) : [];
});
const layerNames = computed<string[]>(() => {
  const s = layerSync.status.value;
  return s ? s.badges.filter((b) => b.kind === 'layer').map((b) => b.name) : [];
});

function metaFor(name: string, kind: 'overview' | 'layer'): {
  syncBadge: ReturnType<typeof layerSync.badgeFor>;
  hasLocalDraft: boolean;
  isDiverged: boolean;
  localeBadges: TemplatePickerEntry['localeBadges'];
} {
  const sync = kind === 'overview' ? overviewSync : layerSync;
  const sources = kind === 'overview' ? overviewSources : layerSources;
  const badge = sync.badgeFor(name);
  // Per-locale status chips: derived from the overlay sibling rows
  // already present in sync-status, with the operator's unstaged
  // browser draft taking precedence ('local' wins over any sync state).
  const localeBadges = SUPPORTED_LOCALES.filter((l) => l !== 'en').map((locale) => {
    if (localEdits.has(name, locale)) {
      return { locale, status: 'local' as const };
    }
    const s = sources.overlayStatus(name, locale);
    return { locale, status: s ?? ('empty' as const) };
  });
  return {
    syncBadge: badge,
    // Picker chip lights up when ANY locale has an unstaged draft for
    // this template.
    hasLocalDraft: localEdits.localesFor(name).length > 0,
    isDiverged: badge === 'diverged',
    localeBadges,
  };
}

const overviewEntries = computed<TemplatePickerEntry[]>(() => {
  const out: TemplatePickerEntry[] = [];
  const seen = new Set<string>();
  const push = (name: string, content: OverviewDashboard | null): void => {
    if (!content || seen.has(name)) return;
    seen.add(name);
    out.push({
      value: name,
      label: content.title || content.id,
      key: content.id,
      ...metaFor(name, 'overview'),
    });
  };
  for (const name of overviewSources.remoteNames()) {
    push(name, overviewSources.remote<OverviewDashboard>(name));
  }
  for (const name of bundledOverviewNames.value) {
    push(name, overviewSources.bundled<OverviewDashboard>(name));
  }
  out.sort((a, b) => a.label.localeCompare(b.label));
  return out;
});

const layerEntries = computed<TemplatePickerEntry[]>(() => {
  const out: TemplatePickerEntry[] = [];
  for (const name of layerNames.value) {
    const content =
      layerSources.remote<AdminLayerTemplate>(name) ??
      layerSources.bundled<AdminLayerTemplate>(name);
    if (!content) continue;
    out.push({
      value: name,
      label: content.alias || content.key,
      key: content.key,
      color: content.color,
      ...metaFor(name, 'layer'),
    });
  }
  out.sort((a, b) => a.label.localeCompare(b.label));
  return out;
});

const activeEntries = computed<TemplatePickerEntry[]>(() =>
  selectedKind.value === 'overview' ? overviewEntries.value : layerEntries.value,
);

const refreshing = ref(false);
async function onRefreshTemplates(): Promise<void> {
  if (refreshing.value) return;
  refreshing.value = true;
  try {
    await bff.templateSync.resync();
    await Promise.all([
      overviewSources.refetch(),
      layerSources.refetch(),
      refreshConfigBundle({ force: true }),
    ]);
  } catch {
    /* best-effort refresh */
  } finally {
    refreshing.value = false;
  }
}

watch(
  [selectedKind, activeEntries],
  ([, list]) => {
    if (list.some((e) => e.value === selectedName.value)) return;
    selectedName.value = list[0]?.value ?? '';
  },
  { immediate: true },
);

// ── Source + draft state ───────────────────────────────────────────

/** Effective SOURCE for the picked template — strictly REMOTE (the
 *  version published to OAP). We translate the PUBLISHED template's
 *  fields, not the bundled disk copy: the runtime localizes against the
 *  remote source, so enumerating fields from bundled would let an
 *  operator translate fields that never reach end users. A template with
 *  no OAP row therefore isn't translatable until it's published (the
 *  editor shows the empty state). Embedded `i18n` is no longer written by
 *  this page; any historical embedded block is stripped defensively. */
const effective = computed<{ source: Record<string, unknown> } | null>(() => {
  const name = selectedName.value;
  const kind = selectedKind.value;
  if (!name) return null;
  const sources = kind === 'overview' ? overviewSources : layerSources;
  const raw = sources.remote<Record<string, unknown>>(name);
  if (!raw) return null;
  const { i18n: _i18n, ...rest } = raw as { i18n?: Record<string, unknown> };
  void _i18n;
  return { source: rest };
});

/** Operator's in-progress overlay, keyed by template-name → locale →
 *  field-path → translation. Editor reads/writes here; Push serializes
 *  the per-locale map back into the sibling OAP overlay row. */
const draft = ref<Record<string, Record<string, Record<string, string>>>>({});

/** OAP + disk overlay snapshots we've already fetched from the BFF,
 *  keyed by `${name}:${locale}`. Used to seed the draft AND to compute
 *  the diff for the push modal. */
interface OverlaySnapshot { disk: unknown; oap: unknown }
const fetchedOverlays = ref<Record<string, OverlaySnapshot>>({});

function overlayKey(name: string, locale: string): string {
  return `${name}:${locale}`;
}

/** Walk an overlay into the draft for (name, locale). Translatable
 *  leaves only; existing draft values are NEVER clobbered (preserves
 *  the operator's in-progress typing across locale switches). */
function applyOverlayToDraft(name: string, loc: string, overlay: unknown, eff: { source: Record<string, unknown> }): void {
  if (!overlay) return;
  const fields = walkTranslatable(eff.source);
  const m: Record<string, string> = {};
  for (const f of fields) {
    const v = getAtPath(overlay, f.segments);
    if (typeof v === 'string' && v.length > 0) m[f.path] = v;
  }
  const tplMap = { ...(draft.value[name] ?? {}) };
  const cur = tplMap[loc] ?? {};
  tplMap[loc] = { ...m, ...cur };
  draft.value = { ...draft.value, [name]: tplMap };
}

/** Seed the draft for one (template, locale) from:
 *    1. disk overlay (BFF-shipped sibling catalog)
 *    2. OAP overlay row (previously-pushed translations) — wins over disk
 *    3. local-staged draft (operator's in-progress) — wins over both
 *  Existing draft values still take precedence over (1) and (2) so
 *  active typing isn't disturbed. */
async function ensureOverlayFetched(name: string, loc: Locale, eff: NonNullable<typeof effective.value>): Promise<void> {
  if (loc === 'en') return;
  const k = overlayKey(name, loc);
  if (Object.prototype.hasOwnProperty.call(fetchedOverlays.value, k)) return;
  try {
    const { disk, oap } = await bff.templateSync.overlay(name, loc);
    fetchedOverlays.value = { ...fetchedOverlays.value, [k]: { disk, oap } };
    // Disk first, then OAP on top — OAP wins per-leaf where set.
    applyOverlayToDraft(name, loc, disk, eff);
    applyOverlayToDraft(name, loc, oap, eff);
  } catch {
    fetchedOverlays.value = { ...fetchedOverlays.value, [k]: { disk: null, oap: null } };
  }
  // Local stage wins over everything — apply last so it survives the
  // seed even when an OAP row exists.
  const staged = localEdits.get<unknown>(name, loc);
  if (staged) applyOverlayToDraft(name, loc, staged, eff);
}

// `target` MUST be declared above the `watch(effective, ...)` below
// because that watch uses `{ immediate: true }` and reads `target.value`
// in its callback — which fires DURING setup. Declaring `target` after
// the watch leaves it in the TDZ at the moment the immediate callback
// runs, producing a silent ReferenceError that aborts setup and renders
// the page blank with no console trace (CLAUDE.md flags this as a
// recurring failure mode for `immediate: true` watchers).
const target = ref<Locale>(
  (SUPPORTED_LOCALES.find((l) => l !== 'en') as Locale) ?? 'zh-CN',
);
const targetLocales = SUPPORTED_LOCALES.filter((l) => l !== 'en');

watch(
  effective,
  (eff) => {
    if (!eff) return;
    const name = selectedName.value;
    if (!draft.value[name]) {
      draft.value = { ...draft.value, [name]: {} };
    }
    void ensureOverlayFetched(name, target.value, eff);
  },
  { immediate: true },
);

// When the operator switches target language, lazy-fetch its overlays.
watch([target, effective], ([loc, eff]) => {
  if (!eff || !selectedName.value) return;
  void ensureOverlayFetched(selectedName.value, loc, eff);
});

/** Build the overlay object (source-shape mirror) for one (name, locale)
 *  from the in-memory draft. Returns null when the draft is empty. */
function buildOverlayContent(name: string, loc: string, eff: NonNullable<typeof effective.value>): Record<string, unknown> | null {
  const fields = walkTranslatable(eff.source);
  const overlay: Record<string, unknown> = {};
  const m = draft.value[name]?.[loc] ?? {};
  for (const f of fields) {
    const v = m[f.path];
    if (v && v.length > 0) setAtPath(overlay, f.segments, v);
  }
  return Object.keys(overlay).length === 0 ? null : overlay;
}

/** The source as the preview should render it — the target locale's
 *  current draft is merged onto English. */
const localizedSource = computed<unknown>(() => {
  const eff = effective.value;
  if (!eff) return null;
  const overlay = buildOverlayContent(selectedName.value, target.value, eff);
  if (!overlay) return eff.source;
  return deepMerge(eff.source, overlay);
});

function deepMerge(src: unknown, ovl: unknown): unknown {
  if (Array.isArray(src)) {
    if (!Array.isArray(ovl)) return src;
    return src.map((item, i) => deepMerge(item, ovl[i]));
  }
  if (src !== null && typeof src === 'object') {
    if (!ovl || typeof ovl !== 'object' || Array.isArray(ovl)) return src;
    const ovlMap = ovl as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(src as Record<string, unknown>)) {
      out[k] = deepMerge(v, ovlMap[k]);
    }
    return out;
  }
  if (typeof src === 'string' && typeof ovl === 'string' && ovl.length > 0) return ovl;
  return src;
}

const localizedOverview = computed<OverviewDashboard | null>(() => {
  if (selectedKind.value !== 'overview') return null;
  return (localizedSource.value as OverviewDashboard) ?? null;
});
const localizedLayer = computed<AdminLayerTemplate | null>(() => {
  if (selectedKind.value !== 'layer') return null;
  return (localizedSource.value as AdminLayerTemplate) ?? null;
});

// ── Scope (Component) selector for layer kind ──────────────────────

const scopeOptions = computed<Array<{ value: DashboardScope; label: string }>>(() => {
  const eff = effective.value;
  const slots = eff && selectedKind.value === 'layer' ? (eff.source as unknown as AdminLayerTemplate).slots : null;
  return [
    { value: 'service', label: slots?.services || 'Service' },
    { value: 'instance', label: slots?.instances || 'Instance' },
    { value: 'endpoint', label: slots?.endpoints || 'Endpoint' },
  ];
});

// ── Translation progress counter ───────────────────────────────────

const allFields = computed<TranslatableField[]>(() => {
  const eff = effective.value;
  return eff ? walkTranslatable(eff.source) : [];
});
const filledCount = computed<number>(() => {
  const m = draft.value[selectedName.value]?.[target.value] ?? {};
  return allFields.value.filter((f) => (m[f.path] ?? '').length > 0).length;
});

// ── Click-widget → floating panel ──────────────────────────────────

interface PanelState {
  open: boolean;
  /** Anchor element for outside-click detection. */
  anchor: HTMLElement | null;
  /** Click point in viewport coordinates — drives the panel's
   *  position so it pops up near the cursor, not edge-aligned. */
  point: { x: number; y: number } | null;
  /** Resolved field list shown in the panel (already scoped to the
   *  clicked widget / header). */
  fields: TranslatableField[];
  /** Display name shown in the panel header. */
  label: string;
}
const panel = ref<PanelState>({ open: false, anchor: null, point: null, fields: [], label: '' });

function openPanel(fields: TranslatableField[], label: string, el: HTMLElement, point: { x: number; y: number }): void {
  // Widgets with no translatable text (e.g. a topology widget that
  // only carries `layer`) shouldn't open an empty panel.
  if (fields.length === 0) return;
  panel.value = { open: true, anchor: el, point, fields, label };
}
function closePanel(): void {
  panel.value = { ...panel.value, open: false };
}

function pointFromEvent(e: { clientX?: number; clientY?: number } | null | undefined): { x: number; y: number } {
  return { x: e?.clientX ?? window.innerWidth / 2, y: e?.clientY ?? window.innerHeight / 2 };
}

function fieldsForPrefix(prefix: string): TranslatableField[] {
  return allFields.value.filter(
    (f) => f.path === prefix || f.path.startsWith(`${prefix}.`) || f.path.startsWith(`${prefix}[`),
  );
}

function onSelectOverviewWidget(payload: { widget: OverviewWidget; el: HTMLElement; event: MouseEvent }): void {
  const eff = effective.value;
  if (!eff) return;
  const dash = eff.source as unknown as OverviewDashboard;
  const idx = (dash.widgets ?? []).findIndex((x) => x.id === payload.widget.id);
  if (idx < 0) return;
  openPanel(
    fieldsForPrefix(`widgets[${idx}]`),
    payload.widget.title || payload.widget.id,
    payload.el,
    pointFromEvent(payload.event),
  );
}

function onSelectLayerWidget(payload: { widget: DashboardWidget; idx: number; el: HTMLElement; event: MouseEvent }): void {
  const eff = effective.value;
  if (!eff) return;
  const tpl = eff.source as unknown as AdminLayerTemplate & { dashboards?: Record<string, DashboardWidget[]> };
  const prefix = tpl.dashboards
    ? `dashboards.${scope.value}[${payload.idx}]`
    : `widgets[${payload.idx}]`;
  openPanel(
    fieldsForPrefix(prefix),
    payload.widget.title || payload.widget.id || `widget ${payload.idx + 1}`,
    payload.el,
    pointFromEvent(payload.event),
  );
}

/** Overview header → title + description. Excludes anything inside
 *  the widget grid so the operator gets ONLY the dashboard-level prose. */
function onSelectOverviewHeader(payload: { el: HTMLElement; event: MouseEvent }): void {
  const fields = allFields.value.filter(
    (f) => f.path === 'title' || f.path === 'description',
  );
  openPanel(fields, 'Dashboard header', payload.el, pointFromEvent(payload.event));
}

/** Layer header → layer alias + slots aliases + documentLink. Excludes
 *  widget grids and per-widget fields. */
function onSelectLayerHeader(payload: { el: HTMLElement; event: MouseEvent }): void {
  const fields = allFields.value.filter((f) => {
    if (f.path.startsWith('widgets[') || f.path.startsWith('dashboards.')) return false;
    if (f.path.startsWith('metrics.columns[')) return false;
    if (f.path.startsWith('overview.groups[')) return false;
    return true;
  });
  openPanel(fields, 'Layer header', payload.el, pointFromEvent(payload.event));
}

const currentPanelFields = computed<TranslatableField[]>(() => panel.value.fields);

// ── Editing inside the floating panel ──────────────────────────────

function draftValue(path: string): string {
  return draft.value[selectedName.value]?.[target.value]?.[path] ?? '';
}
function setDraftValue(path: string, value: string): void {
  const name = selectedName.value;
  const loc = target.value;
  const tplMap = { ...(draft.value[name] ?? {}) };
  const locMap = { ...(tplMap[loc] ?? {}) };
  if (value.length === 0) delete locMap[path];
  else locMap[path] = value;
  tplMap[loc] = locMap;
  draft.value = { ...draft.value, [name]: tplMap };
}

// ── Stage to local + Push to OAP ───────────────────────────────────
// Per-locale model: stage / push acts on the CURRENT target locale.
// Operator switches Target to translate another language; each locale
// is its own OAP overlay row.

const banner = computed(() =>
  selectedKind.value === 'overview' ? overviewSync.banner.value : layerSync.banner.value,
);

/** OAP overlay row content for (selected template, target locale).
 *  Used as the LEFT side of the push diff. */
const oapOverlayForTarget = computed<unknown>(() => {
  const snap = fetchedOverlays.value[overlayKey(selectedName.value, target.value)];
  return snap?.oap ?? null;
});

/** Operator's would-be next OAP overlay for (selected template, target
 *  locale) — built from the in-memory draft. */
const draftOverlayForTarget = computed<Record<string, unknown> | null>(() => {
  const eff = effective.value;
  if (!eff || !selectedName.value) return null;
  return buildOverlayContent(selectedName.value, target.value, eff);
});

/** Diff state — true when the draft differs from what's on OAP. The
 *  push modal's stage / push buttons gate on this. */
const dirty = computed<boolean>(() => {
  const a = draftOverlayForTarget.value;
  const b = oapOverlayForTarget.value;
  return stableStringify(a ?? null) !== stableStringify(b ?? null);
});

const saveMsg = ref<string | null>(null);
const saving = ref(false);

/* ── Editor source tracking ────────────────────────────────────────
 * Matches the Layer Dashboards + Overview Templates admin editors:
 * the pill always shows one of three states (`from local` / `from
 * bundled` / `from remote`) and the dropdown lets the operator reset
 * to the disk-shipped overlay only ("bundled") or to whatever OAP
 * currently has ("remote"). Local edits flip the pill to "from
 * local"; discard flips it back to "from remote". */
const editorSource = ref<'local' | 'bundled' | 'remote'>('remote');

// Switching template or target locale recomputes the source from
// whether the operator has unstaged local edits for that (name, loc).
// Don't clobber an explicitly-set source (bundled) inside the same
// locale — the watcher only fires when name/locale changes.
watch([selectedName, target], () => {
  editorSource.value = hasStagedLocal.value ? 'local' : 'remote';
});

/** Rebuild the draft for one (name, locale) from a specific source.
 *  - `remote` reproduces the default layering (disk overlay first, OAP
 *    overlay wins per leaf) — the canonical baseline the operator
 *    sees in the live UI.
 *  - `bundled` shows ONLY the disk-shipped overlay, ignoring OAP. Use
 *    this to compare against the on-disk seed without OAP overrides. */
function rebuildDraftForLocale(name: string, loc: string, src: 'remote' | 'bundled'): void {
  const eff = effective.value;
  if (!eff) return;
  const tplMap = { ...(draft.value[name] ?? {}) };
  delete tplMap[loc];
  draft.value = { ...draft.value, [name]: tplMap };
  const snap = fetchedOverlays.value[overlayKey(name, loc)];
  if (!snap) return;
  applyOverlayToDraft(name, loc, snap.disk, eff);
  if (src === 'remote') {
    applyOverlayToDraft(name, loc, snap.oap, eff);
  }
}

/** Reset to dropdown — discard the current local draft and reload the
 *  draft from the picked source. Symmetric with the layer / overview
 *  editors. */
const resetDropdownOpen = ref(false);
function resetTo(src: 'remote' | 'bundled'): void {
  const name = selectedName.value;
  const loc = target.value;
  if (!name) return;
  localEdits.remove(name, loc);
  rebuildDraftForLocale(name, loc, src);
  editorSource.value = src;
  resetDropdownOpen.value = false;
  closePanel();
}

/** Persist the current draft to localStorage for the active locale.
 *  Survives reloads, doesn't reach other users, doesn't touch OAP. */
function stageLocal(): void {
  const name = selectedName.value;
  const loc = target.value;
  const overlay = draftOverlayForTarget.value;
  if (!name) return;
  if (overlay === null) localEdits.remove(name, loc);
  else localEdits.set(name, loc, overlay);
  editorSource.value = 'local';
  saveMsg.value = t('Staged {locale} locally.', { locale: LOCALE_NATIVE_LABEL[loc] });
  closePanel();
  setTimeout(() => (saveMsg.value = null), 4000);
}

const pushOpen = ref(false);
const pushRemotePretty = computed(() => prettyJson(oapOverlayForTarget.value));
const pushLocalPretty = computed(() => prettyJson(draftOverlayForTarget.value));
function prettyJson(o: unknown): string {
  return o ? stableStringify(o, 2) : '';
}

/** Publish the active locale's draft → OAP as a sibling overlay row.
 *  Same propagation-wait + 504 chain the source-save path uses. */
async function pushToOap(): Promise<void> {
  const name = selectedName.value;
  const loc = target.value;
  const overlay = draftOverlayForTarget.value;
  if (!name || saving.value) return;
  saving.value = true;
  saveMsg.value = t('Saving to OAP…');
  let elapsed = 0;
  const ticker = setInterval(() => {
    elapsed++;
    saveMsg.value = t('Saving to OAP… {n}s', { n: elapsed });
  }, 1000);
  try {
    if (overlay === null) {
      // Operator cleared the draft — soft-delete the OAP row so the
      // locale falls back to the disk catalog.
      await bff.templateSync.deleteTranslation(name, loc);
    } else {
      await bff.templateSync.saveTranslation(name, loc, overlay);
    }
    clearInterval(ticker);
    localEdits.remove(name, loc);
    pushOpen.value = false;
    // Drop our cached OAP snapshot so the next fetch re-reads the row
    // we just wrote.
    const next = { ...fetchedOverlays.value };
    delete next[overlayKey(name, loc)];
    fetchedOverlays.value = next;
    for (let n = 6; n > 0; n--) {
      saveMsg.value = t('Pushed. Refreshing in {n}s…', { n });
      await sleep(1000);
    }
    await bff.templateSync.resync();
    await refreshConfigBundle({ force: true });
    saveMsg.value = t('Published {locale} translations — now live for everyone.', { locale: LOCALE_NATIVE_LABEL[loc] });
    setTimeout(() => (saveMsg.value = null), 6000);
  } catch (err) {
    clearInterval(ticker);
    if (err instanceof BffApiError && err.status === 504) {
      saveMsg.value = t('Timeout waiting for OAP propagation. Refetching…');
      try {
        await bff.templateSync.resync();
        await refreshConfigBundle({ force: true });
      } catch {
        /* refetch best-effort */
      }
      saveMsg.value = t('Refetched after timeout — verify on OAP.');
      setTimeout(() => (saveMsg.value = null), 10000);
    } else {
      saveMsg.value = err instanceof Error
        ? t('Push failed: {error}', { error: err.message })
        : t('Push failed');
    }
  } finally {
    saving.value = false;
  }
}

function discardLocal(): void {
  const name = selectedName.value;
  const loc = target.value;
  if (!name) return;
  localEdits.remove(name, loc);
  rebuildDraftForLocale(name, loc, 'remote');
  editorSource.value = 'remote';
  saveMsg.value = t('Discarded {locale} local draft.', { locale: LOCALE_NATIVE_LABEL[loc] });
  closePanel();
  setTimeout(() => (saveMsg.value = null), 3000);
}

const hasStagedLocal = computed<boolean>(() => localEdits.has(selectedName.value, target.value));

const readOnly = computed<boolean>(() =>
  selectedKind.value === 'overview' ? overviewSync.readOnly.value : layerSync.readOnly.value,
);

// ── Import / Export ────────────────────────────────────────────────
// Translations are their own OAP rows on their own page, so their
// import/export is separate from the source-template pages. Both act on
// the CURRENT (template, target locale) — the same unit Stage / Push use.
function flashMsg(msg: string): void {
  saveMsg.value = msg;
  setTimeout(() => {
    if (saveMsg.value === msg) saveMsg.value = null;
  }, 6000);
}
/** The in-use overlay for (selected template, target locale): the OAP row
 *  (what's published) wins, else the disk-shipped seed. A pushed row is
 *  already the full merged overlay, so this is the complete in-use copy. */
const inUseOverlayForTarget = computed<Record<string, unknown> | null>(() => {
  const snap = fetchedOverlays.value[overlayKey(selectedName.value, target.value)];
  const v = snap?.oap ?? snap?.disk ?? null;
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
});
const canExport = computed<boolean>(() => inUseOverlayForTarget.value !== null);
function onExport(): void {
  const overlay = inUseOverlayForTarget.value;
  const name = selectedName.value;
  if (!overlay || !name) return;
  downloadJson(
    `${name}.i18n.${target.value}.json`,
    buildOverlayExportEnvelope(selectedKind.value, name, target.value, overlay),
  );
}
// Import stages a translation file as a LOCAL draft. A Horizon overlay
// envelope targets its own (template, locale) — switching the picker to
// it; a bare overlay object goes into the current selection.
async function onImportFile(): Promise<void> {
  const text = await pickJsonFile();
  if (text === null) return;
  const res = parseOverlayImport(text);
  if (!res.ok) {
    flashMsg(t('Import failed: {error}', { error: res.error }));
    return;
  }
  const kind = res.kind ?? selectedKind.value;
  const name = res.sourceName ?? selectedName.value;
  const locStr = res.locale ?? target.value;
  if (locStr === 'en' || !(SUPPORTED_LOCALES as readonly string[]).includes(locStr)) {
    flashMsg(t('Unsupported language: {locale}', { locale: locStr }));
    return;
  }
  const loc = locStr as Locale;
  if (res.sourceName) {
    const entries = kind === 'overview' ? overviewEntries.value : layerEntries.value;
    if (!entries.some((e) => e.value === name)) {
      flashMsg(t('Template {name} is not loaded on this deployment.', { name }));
      return;
    }
    selectedKind.value = kind;
    selectedName.value = name;
  }
  target.value = loc;
  await nextTick();
  const eff = effective.value;
  if (!eff) {
    flashMsg(t('Could not load the target template.'));
    return;
  }
  // Overwrite the (template, locale) draft from the imported overlay, then
  // stage it locally so Push publishes exactly the imported translation.
  const tplMap = { ...(draft.value[name] ?? {}) };
  delete tplMap[loc];
  draft.value = { ...draft.value, [name]: tplMap };
  applyOverlayToDraft(name, loc, res.content, eff);
  const overlay = buildOverlayContent(name, loc, eff);
  if (overlay) localEdits.set(name, loc, overlay);
  else localEdits.remove(name, loc);
  editorSource.value = 'local';
  closePanel();
  flashMsg(
    t('Imported {locale} translations as a local draft — review, then “Check diff & push”.', {
      locale: LOCALE_NATIVE_LABEL[loc],
    }),
  );
}

/** Human label for a translatable field shown next to the EN source.
 *  The wire path (e.g. `kpis[0].label`) is internal — translators
 *  shouldn't see it; they should see what KIND of string they're
 *  translating (title, tip, tab label, …). EN source identifies
 *  which one. */
const FIELD_LABELS: Record<string, string> = {
  title: 'Title',
  tip: 'Tip',
  description: 'Description',
  label: 'Label',
  group: 'Group',
  alias: 'Alias',
  expressionLabels: 'Series label',
  tableHeaders: 'Column header',
  slots: 'Term',
  aliases: 'Layer alias',
};
function leafLabel(segments: Array<string | number>): string {
  // Walk back to the last non-index segment — that's the field's
  // structural name. For `kpis[3].label` it's "label"; for
  // `expressionLabels[2]` it's "expressionLabels".
  for (let i = segments.length - 1; i >= 0; i--) {
    const s = segments[i];
    if (typeof s === 'string') return FIELD_LABELS[s] ?? s;
  }
  return '';
}
</script>

<template>
  <div class="tv">
    <header class="tv__head">
      <div>
        <div class="tv__kicker">{{ t('Dashboard setup') }} · {{ t('Translations') }}</div>
        <h1>{{ t('Translations') }}</h1>
        <p class="tv__lede">
          {{ t('Pick a template + target language, click any widget in the preview, type the translation. Each language is its own OAP row (sibling of the template) — pushing zh-CN never touches ja. Stage saves the draft to your browser; Push writes the sibling row.') }}
        </p>
      </div>
    </header>

    <SyncStatusBanner :banner="banner" />

    <div class="tv__picker">
      <label>
        <span>{{ t('Kind') }}</span>
        <TypeaheadSelect
          :model-value="selectedKind"
          :options="[{ value: 'overview', label: t('Overview') }, { value: 'layer', label: t('Layer') }]"
          :disabled="readOnly"
          :min-panel-width="180"
          @update:model-value="(v) => (selectedKind = v as 'overview' | 'layer')"
        />
      </label>
      <label>
        <span>{{ selectedKind === 'overview' ? t('Dashboard') : t('Layer') }}</span>
        <TemplatePicker
          :model-value="selectedName"
          :entries="activeEntries"
          :kind-label="selectedKind === 'overview' ? 'dashboards' : 'layers'"
          :disabled="readOnly || activeEntries.length === 0"
          :refreshing="refreshing"
          @update:model-value="(v) => (selectedName = v)"
          @refresh="onRefreshTemplates"
        />
      </label>
      <label v-if="selectedKind === 'layer'">
        <span>{{ t('Component') }}</span>
        <TypeaheadSelect
          :model-value="scope"
          :options="scopeOptions"
          :disabled="readOnly"
          :min-panel-width="220"
          @update:model-value="(v) => (scope = v as DashboardScope)"
        />
      </label>
      <label>
        <span>{{ t('Target') }}</span>
        <TypeaheadSelect
          :model-value="target"
          :options="targetLocales.map((l) => ({ value: l, label: `${LOCALE_NATIVE_LABEL[l]} (${l})` }))"
          :disabled="readOnly"
          :min-panel-width="220"
          @update:model-value="(v) => (target = v as Locale)"
        />
      </label>
      <span class="tv__progress">{{ t('{filled} / {total} translated', { filled: filledCount, total: allFields.length }) }}</span>

      <div class="tv__actions">
        <!-- Source pill — sits at the right edge next to the
             "reset to" dropdown so the operator's eye reads
             `state pill → reset to source` left-to-right. Per-state
             colour: local = warn (action needed), bundled = info
             (informational), remote = dim (baseline / quiet). -->
        <span
          v-if="editorSource === 'local'"
          class="tv__src is-local"
          :title="t('Unpublished local edits — Push to publish to OAP.')"
        >{{ t('from local') }}</span>
        <span
          v-else-if="editorSource === 'bundled'"
          class="tv__src is-bundled"
          :title="t('Showing the shipped bundled default — Push to overwrite OAP with bundled.')"
        >{{ t('from bundled') }}</span>
        <span
          v-else-if="editorSource === 'remote'"
          class="tv__src is-remote"
          :title="t('Showing the OAP-live version. End users render the same bytes.')"
        >{{ t('from remote') }}</span>
        <!-- Export the in-use translation to a file; import a translation
             file as a local draft. Both act on the current target locale. -->
        <button
          type="button"
          class="sw-btn"
          :disabled="!canExport"
          :title="canExport
            ? t('Download the in-use {locale} translation as a JSON file.', { locale: LOCALE_NATIVE_LABEL[target] })
            : t('No published {locale} translation to export yet.', { locale: LOCALE_NATIVE_LABEL[target] })"
          @click="onExport"
        >{{ t('Export') }}</button>
        <button
          type="button"
          class="sw-btn"
          :title="t('Import a translation JSON file as a local draft — review, then publish.')"
          @click="onImportFile"
        >{{ t('Import') }}</button>
        <!-- Reset to ▾ dropdown — matches the layer / overview
             editors. Discards local edits and re-seeds the draft from
             the picked source. -->
        <div class="reset-dd">
          <button
            type="button"
            class="sw-btn"
            :disabled="readOnly || !selectedName"
            @click="resetDropdownOpen = !resetDropdownOpen"
          >
            {{ t('reset to') }} <span class="caret" :class="{ open: resetDropdownOpen }">›</span>
          </button>
          <template v-if="resetDropdownOpen">
            <div class="reset-dd-backdrop" @click="resetDropdownOpen = false" />
            <div class="reset-dd-pop">
              <button
                class="reset-dd-item"
                type="button"
                :title="t('Discard local edits and reload only the disk-shipped overlay (ignore OAP overlay).')"
                @click="resetTo('bundled')"
              >{{ t('Bundled') }}</button>
              <button
                class="reset-dd-item"
                type="button"
                :title="t('Discard local edits and reload from the OAP overlay row.')"
                @click="resetTo('remote')"
              >{{ t('Remote') }}</button>
            </div>
          </template>
        </div>
        <button
          v-if="hasStagedLocal"
          type="button"
          class="sw-btn"
          :disabled="saving"
          @click="discardLocal"
        >{{ t('Discard local') }}</button>
        <button
          type="button"
          class="sw-btn"
          :disabled="!dirty || saving"
          @click="stageLocal"
        >{{ t('Stage local') }}</button>
        <button
          type="button"
          class="sw-btn is-primary"
          :disabled="!dirty || saving"
          @click="pushOpen = true"
        >{{ t('Check diff & push') }}</button>
      </div>
    </div>
    <div v-if="saveMsg" class="tv__msg">{{ saveMsg }}</div>

    <div v-if="!effective" class="tv__empty">{{ t('No translatable templates found.') }}</div>

    <div v-else class="tv__preview">
      <div class="tv__pv-head">
        {{ t('Live preview ({locale}) · click any widget to translate it', { locale: LOCALE_NATIVE_LABEL[target] }) }}
      </div>
      <OverviewDashboardCanvas
        v-if="selectedKind === 'overview' && localizedOverview"
        :dashboard="localizedOverview"
        :selected-widget-id="null"
        @select-widget="onSelectOverviewWidget"
        @select-header="onSelectOverviewHeader"
      />
      <LayerDashboardCanvas
        v-else-if="selectedKind === 'layer' && localizedLayer"
        :template="localizedLayer"
        :scope="scope"
        :selected-widget-id="null"
        @select-widget="onSelectLayerWidget"
        @select-header="onSelectLayerHeader"
      />
    </div>

    <FloatingPanel
      :open="panel.open"
      :anchor="panel.anchor"
      :point="panel.point"
      :width="520"
      @close="closePanel"
    >
      <div class="fp">
        <header class="fp__head">
          <div class="fp__head-text">
            <span class="fp__kicker">EN → {{ LOCALE_NATIVE_LABEL[target] }}</span>
            <h4>{{ panel.label }}</h4>
          </div>
          <button type="button" class="fp__close" @click="closePanel">✕</button>
        </header>
        <div class="fp__rows">
          <div v-for="f in currentPanelFields" :key="f.path" class="fp__row">
            <div class="fp__row-meta">
              <span class="fp__tag">{{ leafLabel(f.segments) }}</span>
              <span class="fp__src">{{ f.source }}</span>
            </div>
            <textarea
              v-autosize="draftValue(f.path) || f.source"
              :value="draftValue(f.path)"
              :placeholder="f.source"
              rows="1"
              class="fp__input"
              @input="setDraftValue(f.path, ($event.target as HTMLTextAreaElement).value)"
            ></textarea>
          </div>
        </div>
        <footer class="fp__foot">
          <button type="button" class="sw-btn" @click="closePanel">{{ t('Close') }}</button>
          <button type="button" class="sw-btn is-primary" :disabled="saving || !dirty" @click="stageLocal">
            {{ t('Stage local') }}
          </button>
        </footer>
      </div>
    </FloatingPanel>

    <Modal
      :open="pushOpen"
      :title="t('Publish {locale} translations → OAP?', { locale: LOCALE_NATIVE_LABEL[target] })"
      width="min(1100px, 94vw)"
      @close="pushOpen = false"
    >
      <p class="tv__push-lede">
        {{ t('Writes a sibling translation row at {name}.i18n.{locale} on OAP — the source template itself is not touched. Other locales stay on whatever was already published / shipped on disk. Review the diff (left = current OAP row, right = your draft):', { name: selectedName, locale: target }) }}
      </p>
      <div class="tv__push-diff">
        <MonacoDiff :original="pushRemotePretty" :modified="pushLocalPretty" language="json" />
      </div>
      <template #footer>
        <button class="sw-btn" type="button" @click="pushOpen = false">{{ t('Cancel') }}</button>
        <button class="sw-btn is-primary" type="button" :disabled="saving" @click="pushToOap">
          {{ saving ? t('Pushing…') : t('Confirm push') }}
        </button>
      </template>
    </Modal>
  </div>
</template>

<style scoped>
.tv { padding: 16px 20px 40px; display: flex; flex-direction: column; gap: 12px; max-width: 1600px; margin: 0 auto; }
.tv__head h1 { margin: 2px 0 4px; font-size: 20px; color: var(--sw-fg-0); }
.tv__kicker { font-size: 10.5px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--sw-warn); }
.tv__lede { margin: 0; max-width: 880px; font-size: 12.5px; line-height: 1.55; color: var(--sw-fg-2); }
.tv__lede code { font-family: var(--sw-mono); font-size: 11.5px; }

.tv__picker {
  display: flex; align-items: center; gap: 14px; flex-wrap: wrap;
  padding: 8px 12px; background: var(--sw-bg-1); border: 1px solid var(--sw-line-2); border-radius: 6px;
}
.tv__picker label { display: inline-flex; align-items: center; gap: 6px; font-size: 11.5px; color: var(--sw-fg-3); }
.tv__progress {
  font-size: 12px; color: var(--sw-fg-2);
  padding: 3px 8px; background: var(--sw-bg-2); border-radius: 3px;
  font-variant-numeric: tabular-nums;
}
/* Source pill — same shape and vocabulary as the layer + overview
 * editors. Per-state colour:
 *   - local   → warn (yellow), background warn-soft : "you have
 *               unpublished changes, action recommended"
 *   - bundled → info (cyan), background info-soft : "showing the
 *               shipped default — informational"
 *   - remote  → fg-3 (dim), background bg-2 : "you're on the
 *               canonical baseline — nothing to call out"
 */
.tv__src {
  font-size: var(--sw-fs-xs);
  font-weight: var(--sw-fw-semibold);
  letter-spacing: var(--sw-ls-caps);
  text-transform: uppercase;
  padding: 3px 8px;
  border-radius: 3px;
}
.tv__src.is-local   { color: var(--sw-warn); background: var(--sw-warn-soft); }
.tv__src.is-bundled { color: var(--sw-info); background: var(--sw-info-soft); }
.tv__src.is-remote  { color: var(--sw-fg-3); background: var(--sw-bg-2); }
.tv__actions { margin-left: auto; display: inline-flex; gap: 6px; align-items: center; }

/* Reset-to dropdown — vocabulary matches the layer + overview admin
 * editors so the affordance reads the same across all three pages. */
.reset-dd { position: relative; }
.reset-dd .caret {
  display: inline-block; margin-left: 4px;
  transition: transform 0.1s ease;
}
.reset-dd .caret.open { transform: rotate(90deg); }
.reset-dd-backdrop {
  position: fixed; inset: 0; z-index: 50;
}
.reset-dd-pop {
  position: absolute; top: calc(100% + 4px); right: 0;
  z-index: 51;
  min-width: 160px;
  background: var(--sw-bg-1);
  border: 1px solid var(--sw-line-2);
  border-radius: 4px;
  box-shadow: 0 6px 16px rgba(0, 0, 0, 0.35);
  padding: 4px;
  display: flex; flex-direction: column; gap: 2px;
}
.reset-dd-item {
  text-align: left;
  padding: 6px 10px;
  background: transparent;
  border: 0;
  border-radius: 3px;
  color: var(--sw-fg-1);
  font-size: var(--sw-fs-sm);
  cursor: pointer;
}
.reset-dd-item:hover:not(:disabled) { background: var(--sw-bg-2); color: var(--sw-fg-0); }
.reset-dd-item:disabled { opacity: 0.4; cursor: not-allowed; }
.tv__msg {
  padding: 6px 10px; font-size: 12px; color: var(--sw-fg-2);
  background: var(--sw-bg-1); border: 1px solid var(--sw-line-2); border-radius: 4px;
}

.tv__empty { padding: 60px 20px; text-align: center; color: var(--sw-fg-3); font-size: 13px; }
.tv__preview {
  border: 1px solid var(--sw-line-2); border-radius: 6px;
  background: var(--sw-bg-0); overflow: hidden;
}
.tv__pv-head {
  padding: 6px 12px;
  border-bottom: 1px solid var(--sw-line-2);
  font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--sw-fg-3);
  background: var(--sw-bg-1);
}

/* Floating panel (per-widget translation popover) */
.fp { display: flex; flex-direction: column; max-height: calc(100vh - 16px); }
.fp__head {
  display: flex; align-items: flex-start; gap: 10px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--sw-line-2);
  background: var(--sw-bg-2);
}
.fp__head-text { flex: 1; min-width: 0; }
.fp__kicker {
  font-size: 9.5px; letter-spacing: 0.06em; text-transform: uppercase;
  color: var(--sw-accent); display: block; margin-bottom: 2px;
}
.fp__head h4 { margin: 0; font-size: 13px; color: var(--sw-fg-0); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.fp__close {
  background: none; border: none; color: var(--sw-fg-3);
  cursor: pointer; font-size: 14px; padding: 0 4px;
}
.fp__close:hover { color: var(--sw-fg-1); }
.fp__rows { flex: 1; min-height: 0; overflow-y: auto; padding: 8px 12px; }
.fp__row { padding: 8px 0; border-bottom: 1px dashed var(--sw-line); }
.fp__row:last-child { border-bottom: none; }
.fp__row-meta { display: flex; align-items: baseline; gap: 8px; margin-bottom: 4px; }
.fp__tag {
  flex: 0 0 auto;
  font-size: 9.5px; letter-spacing: 0.06em; text-transform: uppercase;
  color: var(--sw-fg-3);
  background: var(--sw-bg-2); border: 1px solid var(--sw-line-2);
  padding: 1px 6px; border-radius: 3px;
}
.fp__src { font-size: 12px; color: var(--sw-fg-1); font-weight: 500; }
.fp__input {
  width: 100%; box-sizing: border-box;
  background: var(--sw-bg-2); color: var(--sw-fg-1);
  border: 1px solid var(--sw-line-2); border-radius: 3px;
  padding: 4px 6px; font-size: 12.5px; resize: vertical;
  font-family: inherit;
}
.fp__input:focus { outline: none; border-color: var(--sw-accent); }
.fp__foot {
  padding: 8px 12px;
  border-top: 1px solid var(--sw-line-2);
  display: flex; gap: 6px; justify-content: flex-end;
  background: var(--sw-bg-2);
}

.tv__push-lede {
  margin: 0 0 10px; font-size: 12.5px; color: var(--sw-fg-2); line-height: 1.5;
}
.tv__push-lede code { font-family: var(--sw-mono); font-size: 11.5px; }
.tv__push-diff { height: 60vh; min-height: 320px; border: 1px solid var(--sw-line-2); border-radius: 4px; overflow: hidden; }
</style>
