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
 * The load / save / push / reset / import / export state machine shared by
 * SINGLETON admin templates — template kinds backed by exactly one row
 * (`horizon.<kind>.<key>`, e.g. `horizon.infra-3d.config`). They ride the
 * same bundled → local(browser) → remote(OAP) machinery as the layer /
 * overview dashboards, but without a picker: there's one document, so the
 * page binds a structured editor straight at the working `draft`.
 *
 * The host SFC owns only the section markup that edits `draft.value`; this
 * composable owns everything around it:
 *
 *   - `draft` — the working copy the editor mutates (cloned from a source).
 *   - source selection (`editorSource`, `loadFrom`, `syncDraft`) — local
 *     draft if present, else remote, else bundled.
 *   - `save` — persist the editor state as a browser-local draft (the only
 *     "save"; it never writes OAP).
 *   - push (`openPushDiff`, `pushToOap`, the diff pretties + error list) —
 *     the publish to OAP, the only thing whose failure means "not saved".
 *   - `resetTo` — discard edits + drop the local draft, reload a clean source.
 *   - import / export — file ⇄ local-draft round-trip.
 *   - `dirty` / `ready` / `loadError` / `badge` / `readOnly` — the derived
 *     flags the header + banner render.
 *
 * `normalize` is the per-kind hook for collapsing legacy wire shapes into
 * the one the editor edits (e.g. infra-3d's topology/load → metric). It runs
 * on every clone that lands in the editor AND on the dirty-baseline, so an
 * old-shape remote never reads as "dirty" the moment it loads. Defaults to
 * a structural clone with no transform.
 */

import { computed, onMounted, ref, watch, type ComputedRef, type Ref } from 'vue';
import { bff } from '@/api/client';
import type { TemplateKind, TemplateStatus } from '@/api/scopes/configs';
import { useTemplateSources } from '@/features/admin/_shared/useTemplateSources';
import { useTemplateSync, type SyncBanner } from '@/features/admin/_shared/useTemplateSync';
import { useLocalTemplateEdits } from '@/controls/localTemplateEdits';
import { buildExportEnvelope, downloadJson, pickJsonFile, validateImport } from '@/features/admin/_shared/templatePortability';
import { refreshConfigBundle } from '@/controls/configBundle';
import { stableStringify } from '@/utils/stableJson';

type Source = 'local' | 'bundled' | 'remote';

export interface SingletonTemplateEditorOptions<T> {
  /** Template kind — drives the sync badges + the source rows fetch. */
  kind: TemplateKind;
  /** The single canonical row name, `horizon.<kind>.<key>`. */
  name: string;
  /** Collapse legacy wire shapes into the editor's shape. Mutates in place;
   *  called on a fresh clone (never the live source). Optional. */
  normalize?: (content: T) => void;
  /** Best-effort refresh of the live (rendered) view after a successful
   *  publish — e.g. re-read the 3D-map config a page renders from. A failure
   *  here never surfaces as a push error (the publish already committed). */
  afterPush?: () => Promise<void>;
  /** Transient note shown after an Import succeeds. A getter so it
   *  re-resolves against the live locale at import time, not setup time. */
  importedNote: () => string;
}

export interface SingletonTemplateEditorReturn<T> {
  /** Working copy the structured editor mutates. */
  draft: Ref<T | null>;
  /** Which of the three sources the editor is currently showing. */
  editorSource: Ref<Source>;
  /** Sources have settled but produced no working doc (BFF unreachable). */
  loadError: Ref<boolean>;
  ready: ComputedRef<boolean>;
  readOnly: ComputedRef<boolean>;
  hasLocalDraft: ComputedRef<boolean>;
  hasRemote: ComputedRef<boolean>;
  /** Per-row sync badge (synced / diverged / …) for the source pill. */
  badge: ComputedRef<TemplateStatus | null>;
  /** Bundled byte-equals OAP-live — resetting to bundled is then a no-op. */
  isSynced: ComputedRef<boolean>;
  /** Editor diverges from its baseline — drives the Save button. */
  dirty: ComputedRef<boolean>;
  banner: ComputedRef<SyncBanner>;

  /** Server-side issue list from a failed push / import (or null). */
  pushErr: Ref<string[] | null>;
  pushing: Ref<boolean>;
  pushDiffOpen: Ref<boolean>;
  resetMenuOpen: Ref<boolean>;
  importMsg: Ref<string | null>;
  /** Pretty-printed draft / remote for the push diff. */
  pushLocalPretty: ComputedRef<string>;
  pushRemotePretty: ComputedRef<string>;

  loadFrom: (src: Source) => void;
  save: () => void;
  openPushDiff: () => void;
  pushToOap: () => Promise<void>;
  resetTo: (src: 'bundled' | 'remote') => void;
  onExport: () => void;
  onImportFile: () => Promise<void>;
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

export function useSingletonTemplateEditor<T>(
  opts: SingletonTemplateEditorOptions<T>,
): SingletonTemplateEditorReturn<T> {
  const { kind, name, normalize, afterPush, importedNote } = opts;
  const sources = useTemplateSources(kind);
  const sync = useTemplateSync({ kind });
  const localEdits = useLocalTemplateEdits();

  const draft = ref<T | null>(null) as Ref<T | null>;
  const editorSource = ref<Source>('remote');
  const pushing = ref(false);
  const pushErr = ref<string[] | null>(null);
  const pushDiffOpen = ref(false);
  const resetMenuOpen = ref(false);
  const importMsg = ref<string | null>(null);
  const loadError = ref(false);

  const readOnly = computed(() => sync.readOnly.value);
  const ready = computed(() => !sources.isLoading.value && draft.value !== null);
  const hasLocalDraft = computed(() => localEdits.has(name));
  const hasRemote = computed(() => sources.hasRemote(name));
  const badge = computed(() => sync.badgeFor(name));
  const isSynced = computed(() => badge.value === 'synced');

  /** Cloned + normalized — used as a comparison baseline so an old-shape
   *  remote doesn't read as "dirty" the moment it loads. */
  function normalizedClone(cfg: T | null): T | null {
    if (!cfg) return null;
    const c = clone(cfg);
    normalize?.(c);
    return c;
  }

  function loadFrom(src: Source): void {
    let next: T | null = null;
    if (src === 'local') next = localEdits.get<T>(name) ?? null;
    else if (src === 'remote') next = sources.remote<T>(name);
    else next = sources.bundled<T>(name);
    // Bundled always exists; remote/local may be null — fall back so the
    // editor always has a working doc.
    if (!next) next = sources.bundled<T>(name);
    draft.value = normalizedClone(next);
    editorSource.value = src;
  }

  /** Pick the source on (re)load: local draft if present, else remote (the
   *  runtime source of truth), else bundled. */
  function syncDraft(): void {
    if (hasLocalDraft.value) loadFrom('local');
    else if (hasRemote.value) loadFrom('remote');
    else loadFrom('bundled');
  }

  onMounted(async () => {
    // Force a fresh OAP read so badges + remote content are current.
    await refreshConfigBundle({ force: true });
    await sources.refetch();
    syncDraft();
    loadError.value = draft.value === null;
  });

  // Cold-cache arrival — hydrate once the sources land if mount raced ahead.
  watch(
    () => sources.isLoading.value,
    (loading) => {
      if (loading) return;
      if (!draft.value) syncDraft();
      loadError.value = draft.value === null;
    },
  );

  const localContent = computed<T | null>(() => localEdits.get<T>(name) ?? null);
  const remoteContent = computed<T | null>(() => sources.remote<T>(name));

  /** Dirty = the editor diverges from its baseline (the local draft when
   *  one exists, otherwise remote / bundled). Drives the Save button. */
  const dirty = computed(() => {
    if (!draft.value) return false;
    const baseline = hasLocalDraft.value
      ? localContent.value
      : (remoteContent.value ?? sources.bundled<T>(name));
    // Normalize the baseline so an old-shape remote doesn't read as dirty
    // against the normalized draft.
    return stableStringify(draft.value) !== stableStringify(normalizedClone(baseline ?? null));
  });

  /** Save the current editor state as a browser-local draft. The only
   *  "save" — it never writes OAP. Publish via "Check diff & push". */
  function save(): void {
    if (!draft.value) return;
    localEdits.set(name, clone(draft.value));
    editorSource.value = 'local';
  }

  const pushLocalPretty = computed(() => (draft.value ? stableStringify(draft.value, 2) : ''));
  const pushRemotePretty = computed(() => stableStringify(remoteContent.value ?? null, 2));

  function openPushDiff(): void {
    if (!draft.value) return;
    // Persist the editor state first so the diff reflects exactly what
    // would be pushed.
    save();
    pushErr.value = null;
    pushDiffOpen.value = true;
  }

  async function pushToOap(): Promise<void> {
    if (!draft.value || pushing.value) return;
    pushing.value = true;
    pushErr.value = null;
    // 1) The publish — the only thing whose failure means "not saved".
    try {
      await bff.templateSync.save(name, draft.value);
    } catch (err) {
      const anyErr = err as { body?: { issues?: string[] }; message?: string };
      pushErr.value = anyErr.body?.issues ?? [anyErr.message ?? String(err)];
      pushing.value = false;
      return; // keep the modal open with the error; nothing was committed
    }
    // Committed. Clear the local draft + close the modal regardless of the
    // post-write cache refresh outcome below.
    localEdits.remove(name);
    pushDiffOpen.value = false;
    // 2) Best-effort cache refreshes. A failure here does NOT undo the
    //    publish, so it must never surface as a "push failed".
    try {
      await bff.templateSync.resync();
      await Promise.all([sources.refetch(), refreshConfigBundle({ force: true })]);
      await afterPush?.();
      loadFrom('remote');
    } catch (err) {
      console.warn(`[${kind}] post-push refresh failed (the publish already committed):`, err);
    } finally {
      pushing.value = false;
    }
  }

  /** Reset the editor to a clean source and drop any local draft. */
  function resetTo(src: 'bundled' | 'remote'): void {
    loadFrom(src);
    localEdits.remove(name);
    pushErr.value = null;
    resetMenuOpen.value = false;
  }

  // Export downloads the IN-USE config (remote, else bundled) — what the
  // page renders — not the editor draft. Import stages a file as a local
  // draft; `loadFrom('local')` normalizes any legacy shapes. Errors reuse
  // the push-issue list; success shows a transient note.
  function onExport(): void {
    const inUse = sources.remote<T>(name) ?? sources.bundled<T>(name);
    if (!inUse) return;
    downloadJson(`${name}.json`, buildExportEnvelope(kind, name, inUse));
  }

  async function onImportFile(): Promise<void> {
    const text = await pickJsonFile();
    if (text === null) return;
    const res = validateImport(kind, text);
    if (!res.ok) {
      pushErr.value = [res.error];
      importMsg.value = null;
      return;
    }
    localEdits.set(name, res.content);
    loadFrom('local');
    pushErr.value = null;
    importMsg.value = importedNote();
    setTimeout(() => {
      importMsg.value = null;
    }, 6000);
  }

  return {
    draft,
    editorSource,
    loadError,
    ready,
    readOnly,
    hasLocalDraft,
    hasRemote,
    badge,
    isSynced,
    dirty,
    banner: sync.banner,
    pushErr,
    pushing,
    pushDiffOpen,
    resetMenuOpen,
    importMsg,
    pushLocalPretty,
    pushRemotePretty,
    loadFrom,
    save,
    openPushDiff,
    pushToOap,
    resetTo,
    onExport,
    onImportFile,
  };
}
