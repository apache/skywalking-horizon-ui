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
 * Template-store spine for LayerDashboardsAdmin. Owns the reactive draft
 * (`draft.template`), the layer-list + sync status, the three editor sources
 * (LOCAL browser draft / BUNDLED shipped default / REMOTE OAP-live), and the
 * whole save / push / disable-reactivate lifecycle. The parent SFC is the
 * SINGLE caller — `const store = useLayerTemplateStore()` in setup — and wires
 * the returned state/handlers into its already-extracted child components.
 * NOT a singleton: state is created per-call. The setup-context pieces
 * (useRoute/useRouter/useI18n, onMounted, the URL⇄state watch) run because the
 * parent invokes this inside its own `<script setup>`.
 */
import { computed, reactive, ref, onMounted, watch, nextTick } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute, useRouter } from 'vue-router';
import type { AdminLayerTemplate } from '@/api/client';

import { bff, bffClient, BffApiError } from '@/api/client';
import { useLayers } from '@/shell/useLayers';
import { useLocalTemplateEdits, layerEditName } from '@/controls/localTemplateEdits';
import { useTemplateSources } from '@/features/admin/_shared/useTemplateSources';
import { buildExportEnvelope, downloadJson, pickJsonFile, validateImport } from '@/features/admin/_shared/templatePortability';
import { usePreviewOverride } from '@/controls/previewOverride';
import { stableStringify } from '@/utils/stableJson';
import { refreshConfigBundle } from '@/controls/configBundle';
import { useTemplateSync } from '@/features/admin/_shared/useTemplateSync';
import { type AdminScope, SCOPES } from './layer-dashboards.scopes';

export function useLayerTemplateStore() {
  // OAP UI-template sync status for layer dashboards. Drives the banner +
  // Save gating + per-row badge below.
  const sync = useTemplateSync({ kind: 'layer' });


  // Templates loaded from the BFF (bundled + remote). The editable list
  // (`templates`) is LAYER-LIST oriented: it merges the loaded templates with
  // EVERY layer the live roster reports, so the picker shows all available
  // layers — not only the ones shipping a bundled JSON or living on OAP. A
  // layer with no template yet opens from a blank default and becomes real on
  // first Save (published to OAP).
  const rawTemplates = ref<AdminLayerTemplate[]>([]);
  const { layers: menuLayers } = useLayers();
  function blankTemplateFor(key: string, alias: string, color?: string): AdminLayerTemplate {
    return {
      key,
      alias,
      ...(color ? { color } : {}),
      slots: {},
      components: { service: true },
      metrics: {},
      widgets: [],
    };
  }
  const templates = computed<AdminLayerTemplate[]>(() => {
    const present = new Set(rawTemplates.value.map((t) => t.key.toUpperCase()));
    const synthesized = menuLayers.value
      .filter((L) => !present.has(L.key.toUpperCase()))
      .map((L) => blankTemplateFor(L.key.toUpperCase(), L.name, L.color))
      .sort((a, b) => a.key.localeCompare(b.key));
    return [...rawTemplates.value, ...synthesized];
  });
  // Layers the roster reports that carry no dashboard template yet (the
  // synthesized blanks above). Surfaced in the sync banner so the operator
  // reads the picker's total as "configured + not-configured-yet".
  const unconfiguredCount = computed(() => Math.max(0, templates.value.length - rawTemplates.value.length));
  // The shared sync banner counts only TEMPLATED layers (synced / diverged /
  // local). On this layer-list view we append the not-yet-configured count so
  // the summary explains the full picker. Other admin pages keep the plain
  // banner (they aren't layer-list oriented).
  const layerSyncBanner = computed(() => {
    const b = sync.banner.value;
    const n = unconfiguredCount.value;
    if (n === 0) return b;
    return { ...b, message: `${b.message} ${n} layer${n === 1 ? '' : 's'} not configured yet.` };
  });
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
  function isDivergedRow(key: string): boolean {
    const s = sync.badgeFor(`horizon.layer.${key}`);
    return s === 'diverged' || s === 'bundled-fallback';
  }
  /** A layer with no dashboard template yet — present only via the merged live
   *  roster (a synthesized blank), not in the BFF's loaded template set. */
  function isUnconfiguredRow(key: string): boolean {
    return !rawTemplates.value.some((t) => t.key.toUpperCase() === key.toUpperCase());
  }
  // Declared HERE — before divergedCount / localCount and their watches.
  // Those watches evaluate their source at setup, and `templates` can already
  // be non-empty (the merged live roster), so the filter callbacks read
  // `localEdits` synchronously — it must be initialized first (TDZ otherwise).
  const localEdits = useLocalTemplateEdits();
  // Server-side bundled + remote content for the Reset-to / Preview editor
  // sources. Local (browser draft) comes from `localEdits`.
  const sources = useTemplateSources('layer');
  const sourcesReady = computed(() => !sources.isLoading.value);
  const previewOverride = usePreviewOverride();
  const divergedCount = computed(() => templates.value.filter((t) => isDivergedRow(t.key)).length);
  const localCount = computed(() => templates.value.filter((t) => localEdits.has(layerEditName(t.key))).length);

  /** Working copy — reactively edited. Diffs against `templates` to drive
   *  the Save / Reset state. */
  const draft = reactive<{ template: AdminLayerTemplate | null }>({ template: null });

  async function loadAll(): Promise<void> {
    isLoading.value = true;
    error.value = null;
    try {
      const res = await bffClient.layerTemplates.list();
      rawTemplates.value = res.templates;
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
      // Seed the editor only once the config-bundle (and hence
      // `remoteAvailable` / `hasLocalDraft`) has resolved — otherwise
      // syncDraft falls through to bundled and the editor visibly
      // re-loads as the bundle lands. Two paths: (a) sources are
      // already ready (warm cache) → run synchronously; (b) still
      // loading → handed off to the corrective watcher below, which
      // fires syncDraft on the false → true transition.
      if (sourcesReady.value) syncDraft();
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
  const { t } = useI18n();
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
  // Remote is the canonical baseline (what the runtime menu renders for
  // synced + diverged + remote-only rows). The editor opens from remote
  // on every (re-)mount and stays there until the operator explicitly
  // loads bundled (Reset to bundled) or saves a local draft. The default
  // `'remote'` here matches what `syncDraft()` will pick on the first
  // pass — pre-seeding the same value lets the source pill stay hidden
  // (labelling the default would be noise).
  const editorSource = ref<'local' | 'bundled' | 'remote'>('remote');
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
  /** Seed the editor when the selected layer changes. Remote is the
   *  canonical baseline — it's what the runtime bundle serves to end users
   *  for synced / diverged / remote-only rows, so the editor opens from
   *  remote whenever remote is reachable.
   *  Priority: local draft → remote → bundled (or the synthesized blank for
   *  layers that ship no JSON). The bundled fall-through is what makes every
   *  roster layer editable; nothing renders live until the operator
   *  publishes, so opening from bundled is safe. */
  function syncDraft(): void {
    if (hasLocalDraft.value) {
      loadFrom('local');
      return;
    }
    if (remoteAvailable.value) {
      loadFrom('remote');
      return;
    }
    // No local draft and nothing on OAP — fall back to the bundled/synthesized
    // template so layers that ship no JSON (an untemplated OAP layer like
    // BanyanDB, surfaced from the live roster) still open in a blank editor
    // the operator can configure and Save (publishing creates the OAP copy).
    // `bundledContent()` resolves the synthesized blank via the templates list.
    if (bundledContent()) {
      loadFrom('bundled');
      return;
    }
    draft.template = null;
    loadedSnapshot.value = '';
    saveMsg.value = null;
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

  // "Reset to ▾" dropdown — discard the current local draft and reload the
  // editor from the picked source. The op-facing tooltip says "Discard
  // current edits and reload …", so the action must DROP the local draft
  // rather than re-stage the new content as a fresh draft — re-staging would
  // trigger the TemplateConflictPrompt right after every reset. Subsequent
  // edits in the editor re-create a local draft naturally on the next change.
  function resetTo(src: 'bundled' | 'remote'): void {
    loadFrom(src);
    localEdits.remove(editName.value);
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
  function previewLive(src: 'local' | 'bundled' | 'remote'): void {
    const content = sourceContent(src);
    if (!content) return;
    previewOverride.set(editName.value, content);
    const href = router.resolve({
      path: `/layer/${selectedKey.value}/${firstTabFor(content)}`,
      query: { mode: 'preview', source: src },
    }).href;
    window.open(href, '_blank', 'noopener');
  }

  watch(selectedKey, () => {
    if (sourcesReady.value) syncDraft();
  });

  // First-mount deferred sync. When the page opens on a cold cache
  // `loadAll()` returns before the config-bundle has settled, so the
  // initial syncDraft is skipped (see loadAll). The moment sources
  // transition to ready, run syncDraft for the currently-selected
  // layer — once. No clobber on later transitions: this only fires on
  // the false → true edge.
  watch(sourcesReady, (ready, wasReady) => {
    if (ready && !wasReady && selectedKey.value) {
      syncDraft();
    }
  });
  onMounted(loadAll);
  // Force-refresh the cached config bundle on mount so per-row badges
  // (`synced` / `diverged` / `disabled`) reflect actual OAP state. Without
  // this, the badges would surface whatever a prior session persisted to
  // localStorage. `force: true` also flushes the BFF's 30s OAP sync cache
  // so even a fresh fetch sees live OAP state.
  onMounted(() => void refreshConfigBundle({ force: true }));

  // Unsaved keystrokes: editor differs from the content last loaded/saved.
  const dirty = computed(() => {
    if (!draft.template) return false;
    return JSON.stringify(draft.template) !== loadedSnapshot.value;
  });

  /** Editor content differs from the publish target (remote) — gates Save
   *  so "Reset to bundled" (pristine-vs-load, `dirty=false`) is still
   *  publishable when bundled ≠ remote. Key-stable to ignore key order. */
  const editorDiffersFromRemote = computed<boolean>(() => {
    if (!draft.template) return false;
    const remote = sources.remote<AdminLayerTemplate>(editName.value);
    if (!remote) return true;
    return stableStringify(draft.template) !== stableStringify(remote);
  });

  /** An all-empty `deployment` block (no metrics anywhere, no rules) carries no
   *  renderable config but its mere presence flips caps.deployment on save —
   *  strip it so an opened-then-abandoned editor can't enable the tab. */
  function stripEmptyDeployment(tpl: AdminLayerTemplate): void {
    const d = tpl.deployment;
    if (!d) return;
    const hasMetrics =
      (d.nodeMetrics?.length ?? 0) > 0 ||
      (d.linkServerMetrics?.length ?? 0) > 0 ||
      (d.linkClientMetrics?.length ?? 0) > 0 ||
      (d.roleToRole?.some((p) => (p.metrics?.length ?? 0) > 0) ?? false) ||
      (d.roles?.some((r) => (r.nodeMetrics?.length ?? 0) > 0) ?? false);
    if (!hasMetrics && !d.clusterBy && !d.siblingBy && !d.roleBy && !(d.roles?.length)) {
      delete tpl.deployment;
    }
  }

  /** Save the current editor state to the browser local draft. This is the
   *  only "save" — it never writes OAP. Publish later with "Push local → OAP". */
  function save(): void {
    if (!draft.template) return;
    stripEmptyDeployment(draft.template);
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

  function flashMsg(msg: string): void {
    saveMsg.value = msg;
    setTimeout(() => {
      if (saveMsg.value === msg) saveMsg.value = null;
    }, 6000);
  }
  // Export downloads the IN-USE version (remote, else bundled) — what end
  // users render — not the editor draft. Every shipped layer has a bundled
  // default, so Export is effectively always available.
  const canExport = computed<boolean>(() => remoteAvailable.value || bundledExists.value);
  function onExport(): void {
    const name = editName.value;
    const inUse =
      sources.remote<AdminLayerTemplate>(name) ??
      sources.bundled<AdminLayerTemplate>(name) ??
      templates.value.find((t) => t.key === selectedKey.value) ??
      null;
    if (!inUse) return;
    downloadJson(`${name}.json`, buildExportEnvelope('layer', name, inUse));
  }
  // Import stages a file as a local draft for the layer the file names. Layer
  // keys are a closed enum — you can't invent a layer here — so the target
  // KEY must already be loaded on this deployment; otherwise reject.
  async function onImportFile(): Promise<void> {
    const text = await pickJsonFile();
    if (text === null) return;
    const res = validateImport('layer', text);
    if (!res.ok) {
      flashMsg(res.error);
      return;
    }
    const key = res.key; // already upper-cased by the validator
    if (!templates.value.some((t) => t.key === key)) {
      flashMsg(`Layer “${key}” is not loaded on this deployment — import is limited to layers present here.`);
      return;
    }
    selectedKey.value = key;
    localEdits.set(layerEditName(key), res.content);
    loadFrom('local');
    flashMsg(`Imported “${key}” as a local draft. Preview, then “Check diff & push”.`);
  }

  // Disable / reactivate — OAP has no hard DELETE.
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

  return {
    sync,
    t,
    draft,
    selectedKey,
    activeScope,
    editorSource,
    loadedSnapshot,
    selectedTpl,
    editName,
    rawTemplates,
    templates,
    unconfiguredCount,
    divergedCount,
    localCount,
    layerSyncBanner,
    isLoading,
    error,
    isSaving,
    saveMsg,
    refreshingFromRemote,
    isDivergedRow,
    isUnconfiguredRow,
    blankTemplateFor,
    reconcileLocalDrafts,
    refreshFromRemote,
    sources,
    localEdits,
    previewOverride,
    sourcesReady,
    hasLocalDraft,
    remoteAvailable,
    bundledExists,
    isSynced,
    hasLocalDraftFor,
    bundledContent,
    sourceContent,
    loadFrom,
    syncDraft,
    persistLocal,
    resetTo,
    loadAll,
    firstTabFor,
    previewLive,
    dirty,
    editorDiffersFromRemote,
    localDiffersFromRemote,
    canExport,
    stripEmptyDeployment,
    save,
    pushToOap,
    pushDiffOpen,
    pushLocalPretty,
    pushRemotePretty,
    prettyJson,
    flashMsg,
    onExport,
    onImportFile,
    isLayerDisabled,
    deleteOpen,
    confirmTitle,
    confirmMessage,
    confirmLabel,
    confirmIsDanger,
    runConfirm,
    askDeleteLayer,
    askReactivateLayer,
    doDeleteLayer,
    doReactivateLayer,
  };
}
