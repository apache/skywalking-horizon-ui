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
import type { AdminLayerTemplate } from '@/api/client';
import type { OverviewDashboard } from '@skywalking-horizon-ui/api-client';

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

  /** Walk an overlay into the draft for (name, locale). Translatable
   *  leaves only; existing draft values are NEVER clobbered (preserves
   *  the operator's in-progress typing across locale switches). */
  function applyOverlayToDraft(name: string, loc: string, overlay: unknown, eff: EffectiveSource): void {
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
  async function ensureOverlayFetched(name: string, loc: Locale, eff: EffectiveSource): Promise<void> {
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
  function buildOverlayContent(name: string, loc: string, eff: EffectiveSource): Record<string, unknown> | null {
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

  /** The in-use overlay for (selected template, target locale): the OAP row
   *  (what's published) wins, else the disk-shipped seed. A pushed row is
   *  already the full merged overlay, so this is the complete in-use copy. */
  const inUseOverlayForTarget = computed<Record<string, unknown> | null>(() => {
    const snap = fetchedOverlays.value[overlayKey(selectedName.value, target.value)];
    const v = snap?.oap ?? snap?.disk ?? null;
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
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
