/*
 * Licensed to the Apache Software Foundation (ASF) under one or more
 * contributor license agreements.  See the NOTICE file distributed with
 * this work for additional information regarding copyright ownership.
 * The ASF licenses this file to You under the Apache License, Version 2.0
 * (the "License"); you may not use this file except in compliance with
 * the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * Draft / overlay state machine for the Translations page.
 *
 * Owns the per-template in-memory translation draft and the disk→oap→local
 * seeding precedence: for one (template, locale) the draft is seeded from the
 * BFF-shipped disk overlay, then the OAP overlay row (wins per leaf), then the
 * operator's local-staged draft (wins over both) — while existing draft values
 * are never clobbered so active typing survives a locale switch. Exposes the
 * localized preview source (target draft merged onto English), the per-target
 * dirty/diff state, the editor-source pill state, and the field-level draft
 * accessors the floating editor reads/writes.
 *
 * The caller passes the picker refs (kind / name) and the strictly-REMOTE
 * `effective` source; this composable owns `target`, the draft, the fetched
 * overlay snapshots, and the seeding watches.
 */

import { computed, ref, watch, type ComputedRef, type Ref } from 'vue';
import { useLocalTranslationEdits } from '@/controls/localTranslationEdits';
import { bff } from '@/api/client';
import { stableStringify } from '@/utils/stableJson';
import {
  walkTranslatable,
  setAtPath,
  getAtPath,
  type TranslatableField,
} from '@/features/admin/_shared/translatableFields';
import { SUPPORTED_LOCALES, type Locale } from '@/i18n';
import { useAdminFeatures } from '@/shell/useAdminFeatures';
import type { AdminLayerTemplate } from '@/api/client';
import type { OverviewDashboard } from '@skywalking-horizon-ui/api-client';
import {
  alignOverlayToSource,
  canonicalizeOverlay,
  mergeLocalizedNode,
  stampOverlayIds,
} from '@skywalking-horizon-ui/api-client';

/** Effective SOURCE for the picked template — strictly REMOTE. */
export interface EffectiveSource { source: Record<string, unknown> }

/** OAP + disk overlay snapshots already fetched from the BFF. */
interface OverlaySnapshot { disk: unknown; oap: unknown }

export interface UseTranslationDraftArgs {
  selectedKind: Ref<'overview' | 'layer'>;
  selectedName: Ref<string>;
  effective: ComputedRef<EffectiveSource | null>;
}

export interface UseTranslationDraftReturn {
  target: Ref<Locale>;
  targetLocales: Locale[];
  fetchedOverlays: Ref<Record<string, OverlaySnapshot>>;
  editorSource: Ref<'local' | 'bundled' | 'remote'>;
  localizedOverview: ComputedRef<OverviewDashboard | null>;
  localizedLayer: ComputedRef<AdminLayerTemplate | null>;
  allFields: ComputedRef<TranslatableField[]>;
  filledCount: ComputedRef<number>;
  oapOverlayForTarget: ComputedRef<unknown>;
  draftOverlayForTarget: ComputedRef<Record<string, unknown> | null>;
  inUseOverlayForTarget: ComputedRef<Record<string, unknown> | null>;
  dirty: ComputedRef<boolean>;
  hasStagedLocal: ComputedRef<boolean>;
  overlayKey: (name: string, locale: string) => string;
  draftValue: (path: string) => string;
  setDraftValue: (path: string, value: string) => void;
  applyOverlayToDraft: (name: string, loc: string, overlay: unknown, eff: EffectiveSource) => void;
  buildOverlayContent: (name: string, loc: string, eff: EffectiveSource) => Record<string, unknown> | null;
  rebuildDraftForLocale: (name: string, loc: string, src: 'remote' | 'bundled') => void;
  clearDraftLocale: (name: string, loc: string) => void;
}

export function useTranslationDraft(args: UseTranslationDraftArgs): UseTranslationDraftReturn {
  const { selectedKind, selectedName, effective } = args;
  const localEdits = useLocalTranslationEdits();
  // `templates.mode`, not the page's broader read-only flag: an
  // unreachable admin port must NOT fall back to the disk catalog either
  // (nothing renders from it), and that flag folds the two together.
  const { templatesMode } = useAdminFeatures();

  /** Operator's in-progress overlay, keyed by template-name → locale →
   *  field-path → translation. Editor reads/writes here; Push serializes
   *  the per-locale map back into the sibling OAP overlay row. */
  const draft = ref<Record<string, Record<string, Record<string, string>>>>({});

  /** OAP + disk overlay snapshots we've already fetched from the BFF,
   *  keyed by `${name}:${locale}`. Used to seed the draft AND to compute
   *  the diff for the push modal. */
  const fetchedOverlays = ref<Record<string, OverlaySnapshot>>({});

  function overlayKey(name: string, locale: string): string {
    return `${name}:${locale}`;
  }

  /** Read one overlay's translatable leaves into a path → text map.
   *
   *  The overlay is realigned to the current source first, so an
   *  id-addressed entry is read at the position its widget occupies
   *  TODAY — the draft follows a reordered widget instead of picking up
   *  its neighbour's translation. */
  function overlayFieldMap(overlay: unknown, eff: EffectiveSource): Record<string, string> {
    const aligned = alignOverlayToSource(eff.source, overlay);
    const out: Record<string, string> = {};
    for (const f of walkTranslatable(eff.source)) {
      const v = getAtPath(aligned, f.segments);
      if (typeof v === 'string' && v.length > 0) out[f.path] = v;
    }
    return out;
  }

  /** Layer overlays into the draft for (name, locale), LATER overlays
   *  winning per leaf. Existing draft values are never clobbered by any
   *  of them, which is what preserves the operator's in-progress typing
   *  across a locale switch.
   *
   *  Precedence has to be applied in one pass: applying overlays one call
   *  at a time makes the FIRST one win, because everything it wrote is
   *  "existing draft" by the time the second arrives. */
  function applyOverlaysToDraft(name: string, loc: string, overlays: unknown[], eff: EffectiveSource): void {
    let seed: Record<string, string> = {};
    for (const overlay of overlays) {
      if (!overlay) continue;
      seed = { ...seed, ...overlayFieldMap(overlay, eff) };
    }
    const tplMap = { ...(draft.value[name] ?? {}) };
    const cur = tplMap[loc] ?? {};
    tplMap[loc] = { ...seed, ...cur };
    draft.value = { ...draft.value, [name]: tplMap };
  }

  function applyOverlayToDraft(name: string, loc: string, overlay: unknown, eff: EffectiveSource): void {
    applyOverlaysToDraft(name, loc, [overlay], eff);
  }

  /** The overlay a locale currently RENDERS — the editor's baseline.
   *
   *  Same contract as the templates themselves: the remote row wins, and
   *  the disk catalog reaches the runtime through exactly two doors —
   *  `templates.mode: readonly`, and the editor's explicit reset-to-
   *  bundled preview. So in live mode this is the OAP row and nothing
   *  else; where no row exists the locale renders English and the draft
   *  starts empty, which is the honest baseline and the one boot-seeding
   *  resolves. Falling back to disk here would show a translation for a
   *  field the live site serves in English, and publish it on the next
   *  push. */
  function renderedOverlay(snap: OverlaySnapshot | undefined): unknown {
    if (templatesMode.value === 'readonly') return snap?.disk ?? null;
    return snap?.oap ?? null;
  }

  /** Seed the draft for one (template, locale), lowest precedence first:
   *    1. what the locale renders today (see {@link renderedOverlay})
   *    2. the operator's local-staged draft
   *  All of it in ONE pass, because each pass treats what the previous
   *  one wrote as untouchable draft — layering across calls would make
   *  the FIRST source win, silently replacing a staged edit with the
   *  published value. In-memory typing still beats both. */
  async function ensureOverlayFetched(name: string, loc: Locale, eff: EffectiveSource): Promise<void> {
    if (loc === 'en') return;
    const k = overlayKey(name, loc);
    if (Object.prototype.hasOwnProperty.call(fetchedOverlays.value, k)) return;
    let snap: OverlaySnapshot = { disk: null, oap: null };
    try {
      snap = await bff.templateSync.overlay(name, loc);
    } catch {
      /* leave the snapshot empty — the draft then starts from English */
    }
    fetchedOverlays.value = { ...fetchedOverlays.value, [k]: snap };
    applyOverlaysToDraft(name, loc, [renderedOverlay(snap), localEdits.get<unknown>(name, loc)], eff);
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
   *  from the in-memory draft. Returns null when the draft is empty.
   *
   *  Entries of an id-addressable array are stamped with their source
   *  widget's `id`, which is what lets the merger follow that widget
   *  through a later reorder. Untranslated slots stay holes here;
   *  `draftOverlayForTarget` canonicalizes before anything is compared
   *  or pushed. */
  function buildOverlayContent(name: string, loc: string, eff: EffectiveSource): Record<string, unknown> | null {
    const fields = walkTranslatable(eff.source);
    const overlay: Record<string, unknown> = {};
    const m = draft.value[name]?.[loc] ?? {};
    for (const f of fields) {
      const v = m[f.path];
      if (v && v.length > 0) setAtPath(overlay, f.segments, v);
    }
    if (Object.keys(overlay).length === 0) return null;
    return stampOverlayIds(eff.source, overlay) as Record<string, unknown>;
  }

  /** The source as the preview should render it — the target locale's
   *  current draft is merged onto English through the SAME merger the
   *  BFF renders with, so the preview cannot disagree with what the
   *  locale actually shows. */
  const localizedSource = computed<unknown>(() => {
    const eff = effective.value;
    if (!eff) return null;
    const overlay = buildOverlayContent(selectedName.value, target.value, eff);
    if (!overlay) return eff.source;
    return mergeLocalizedNode(eff.source, overlay);
  });

  const localizedOverview = computed<OverviewDashboard | null>(() => {
    if (selectedKind.value !== 'overview') return null;
    return (localizedSource.value as OverviewDashboard) ?? null;
  });
  const localizedLayer = computed<AdminLayerTemplate | null>(() => {
    if (selectedKind.value !== 'layer') return null;
    return (localizedSource.value as AdminLayerTemplate) ?? null;
  });

  // ── Translation progress counter ─────────────────────────────────
  const allFields = computed<TranslatableField[]>(() => {
    const eff = effective.value;
    return eff ? walkTranslatable(eff.source) : [];
  });
  const filledCount = computed<number>(() => {
    const m = draft.value[selectedName.value]?.[target.value] ?? {};
    return allFields.value.filter((f) => (m[f.path] ?? '').length > 0).length;
  });

  // ── Field-level draft accessors ──────────────────────────────────
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

  /** OAP overlay row content for (selected template, target locale),
   *  canonicalized against the source. Used as the LEFT side of the push
   *  diff. Canonicalizing is what keeps a legacy positional row — or a
   *  row the seeder wrote — from reading as a pending edit: the same
   *  translations always render as the same bytes. */
  const oapOverlayForTarget = computed<unknown>(() => {
    const eff = effective.value;
    const snap = fetchedOverlays.value[overlayKey(selectedName.value, target.value)];
    if (!eff || !snap?.oap) return snap?.oap ?? null;
    return canonicalizeOverlay(eff.source, snap.oap);
  });

  /** Operator's would-be next OAP overlay for (selected template, target
   *  locale) — built from the in-memory draft, in the same canonical
   *  shape as the left side so the diff shows only real changes. This is
   *  what Push writes. */
  const draftOverlayForTarget = computed<Record<string, unknown> | null>(() => {
    const eff = effective.value;
    if (!eff || !selectedName.value) return null;
    const overlay = buildOverlayContent(selectedName.value, target.value, eff);
    return overlay === null ? null : (canonicalizeOverlay(eff.source, overlay) as Record<string, unknown>);
  });

  /** The in-use overlay for (selected template, target locale): the OAP row
   *  (what's published) wins, else the disk-shipped seed. A pushed row is
   *  already the full merged overlay, so this is the complete in-use copy. */
  const inUseOverlayForTarget = computed<Record<string, unknown> | null>(() => {
    const eff = effective.value;
    const snap = fetchedOverlays.value[overlayKey(selectedName.value, target.value)];
    const v = snap?.oap ?? snap?.disk ?? null;
    if (!v || typeof v !== 'object') return null;
    // Exported in canonical form so the file carries widget ids and can
    // be imported onto an OAP whose template has since been re-laid-out.
    return eff
      ? (canonicalizeOverlay(eff.source, v) as Record<string, unknown>)
      : (v as Record<string, unknown>);
  });

  /** Diff state — true when the draft differs from what's on OAP. The
   *  push modal's stage / push buttons gate on this. */
  const dirty = computed<boolean>(() => {
    const a = draftOverlayForTarget.value;
    const b = oapOverlayForTarget.value;
    return stableStringify(a ?? null) !== stableStringify(b ?? null);
  });

  const hasStagedLocal = computed<boolean>(() => localEdits.has(selectedName.value, target.value));

  /* ── Editor source tracking ──────────────────────────────────────
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

  /** Rebuild the draft for one (name, locale) from a specific source,
   *  discarding whatever is in it.
   *  - `remote` restores the baseline the locale renders today — see
   *    {@link renderedOverlay}.
   *  - `bundled` loads the disk-shipped catalog. This is the preview
   *    door: the one place a live-mode editor may show a translation
   *    that isn't published, so the operator can adopt the shipped
   *    wording and push it. */
  function rebuildDraftForLocale(name: string, loc: string, src: 'remote' | 'bundled'): void {
    const eff = effective.value;
    if (!eff) return;
    const tplMap = { ...(draft.value[name] ?? {}) };
    delete tplMap[loc];
    draft.value = { ...draft.value, [name]: tplMap };
    const snap = fetchedOverlays.value[overlayKey(name, loc)];
    if (!snap) return;
    applyOverlaysToDraft(name, loc, [src === 'remote' ? renderedOverlay(snap) : snap.disk], eff);
  }

  /** Drop the (name, locale) draft slot entirely — used before overwriting
   *  it from an imported overlay. */
  function clearDraftLocale(name: string, loc: string): void {
    const tplMap = { ...(draft.value[name] ?? {}) };
    delete tplMap[loc];
    draft.value = { ...draft.value, [name]: tplMap };
  }

  return {
    target,
    targetLocales,
    fetchedOverlays,
    editorSource,
    localizedOverview,
    localizedLayer,
    allFields,
    filledCount,
    oapOverlayForTarget,
    draftOverlayForTarget,
    inUseOverlayForTarget,
    dirty,
    hasStagedLocal,
    overlayKey,
    draftValue,
    setDraftValue,
    applyOverlayToDraft,
    buildOverlayContent,
    rebuildDraftForLocale,
    clearDraftLocale,
  };
}
