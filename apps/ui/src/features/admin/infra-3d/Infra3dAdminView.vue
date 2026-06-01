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
  Admin: 3D Infrastructure Map · structured config editor.

  The 3D-map config is a singleton template kind (`horizon.infra-3d.config`)
  on the same bundled → local(browser) → remote(OAP) machinery as the layer
  / overview dashboards: edits save to a browser-local draft, "Check diff &
  push" publishes to OAP, and the map renders the remote (bundled fallback).

  Sections (top-to-bottom):
    1. Header — source pill + sync badge + Reset menu (to remote / to
       bundled) + Save (local draft) + Check diff & push (Monaco diff vs
       remote, then publish).
    2. SyncStatusBanner — synced / diverged / OAP-unreachable state.
    3. Global filter — one regex (`filter.layer`).
    4. Tiers & layers — per-tier cards: id / order / label + the layers
       pinned to each tier (explicit `layers` lists are the only placement
       mechanism). Anything unpinned falls to the failover tier.
    5. Layers — color + traffic MQE per layer, with each layer's RESOLVED
       level shown read-only (assignment lives in Levels).
    6. Groups — logic-group cards (id / label / tier / color / icon +
       member chips).
    7. Failover tier — the single catch-all for unpinned layers.

  Validation runs server-side on push (the generic save endpoint checks
  3D-map content before it reaches OAP); issues land in the push error list.
-->
<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useLayers } from '@/shell/useLayers';
import {
  bff,
  type Infra3dConfig,
  type InfraGroupSpec,
  type InfraLayerSpec,
  type InfraLevelSpec,
  type InfraMqe,
} from '@/api/client';
import { refresh as refreshLiveInfraConfig } from '@/features/infra-3d/composables/useInfra3dConfig';
import { useTemplateSources } from '@/features/admin/_shared/useTemplateSources';
import { useTemplateSync } from '@/features/admin/_shared/useTemplateSync';
import { useLocalTemplateEdits } from '@/controls/localTemplateEdits';
import { refreshConfigBundle } from '@/controls/configBundle';
import { stableStringify } from '@/utils/stableJson';
import SyncStatusBanner from '@/features/admin/_shared/SyncStatusBanner.vue';
import TemplateStatusBadge from '@/features/admin/_shared/TemplateStatusBadge.vue';
import Modal from '@/features/operate/_shared/Modal.vue';
import MonacoDiff from '@/features/operate/_shared/MonacoDiff.vue';

// ── Live OAP layer catalog ────────────────────────────────────────────
// We hydrate the Layers section from the catalog union'd with config
// keys, so an OAP layer the admin hasn't classified yet shows up here
// and an out-of-tree layer (config exists, OAP no longer reports it)
// also shows so the admin can remove it.
const { availableLayers } = useLayers();
const { t } = useI18n();

// ── Template-sync state ───────────────────────────────────────────────
// The 3D-map config is a singleton template kind — ONE row,
// `horizon.infra-3d.config`. It rides the same bundled → local(browser)
// → remote(OAP) machinery as the layer / overview dashboards: edits save
// to a browser-local draft, "Check diff & push" publishes to OAP, and
// the map renders the remote (with bundled as fallback).
const NAME = 'horizon.infra-3d.config';
const sources = useTemplateSources('infra-3d');
const sync = useTemplateSync({ kind: 'infra-3d' });
const localEdits = useLocalTemplateEdits();

/** Working copy the structured editor below mutates. */
const draft = ref<Infra3dConfig | null>(null);
const layerSearch = ref('');
/** Which of the three sources the editor is currently showing. */
const editorSource = ref<'local' | 'bundled' | 'remote'>('remote');
const pushing = ref(false);
const pushErr = ref<string[] | null>(null);
const pushDiffOpen = ref(false);
const resetMenuOpen = ref(false);

const readOnly = computed(() => sync.readOnly.value);
const ready = computed(() => !sources.isLoading.value && draft.value !== null);
const hasLocalDraft = computed(() => localEdits.has(NAME));
const hasRemote = computed(() => sources.hasRemote(NAME));
/** Per-row sync badge (synced / diverged / …) for the source pill. */
const badge = computed(() => sync.badgeFor(NAME));
/** Bundled byte-equals OAP-live — resetting to bundled is then a no-op. */
const isSynced = computed(() => badge.value === 'synced');

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/** Collapse the deprecated `topology` / `load` shapes into the single
 *  `metric` the editor edits, so an OAP row saved before the single-metric
 *  change still shows its metric. Mutates in place. */
function normalizeSpecs(cfg: Infra3dConfig): void {
  for (const spec of Object.values(cfg.layers)) {
    if (!spec.metric) {
      const m = spec.topology?.server ?? spec.topology?.client ?? spec.load;
      if (m) spec.metric = m;
    }
    delete spec.topology;
    delete spec.load;
  }
}

/** Cloned + normalized — used as a comparison baseline so an old-shape
 *  remote doesn't read as "dirty" the moment it loads. */
function normalizedClone(cfg: Infra3dConfig | null): Infra3dConfig | null {
  if (!cfg) return null;
  const c = clone(cfg);
  normalizeSpecs(c);
  return c;
}

function loadFrom(src: 'local' | 'bundled' | 'remote'): void {
  let next: Infra3dConfig | null = null;
  if (src === 'local') next = localEdits.get<Infra3dConfig>(NAME) ?? null;
  else if (src === 'remote') next = sources.remote<Infra3dConfig>(NAME);
  else next = sources.bundled<Infra3dConfig>(NAME);
  // Bundled always exists; remote/local may be null — fall back so the
  // editor always has a working doc.
  if (!next) next = sources.bundled<Infra3dConfig>(NAME);
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

/** Set when the sources settle but still produce no working doc (the BFF
 *  itself is unreachable — bundled rows are absent, so there's nothing to
 *  edit). Surfaces an error instead of an indefinite spinner. */
const loadError = ref(false);

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

const localContent = computed<Infra3dConfig | null>(
  () => localEdits.get<Infra3dConfig>(NAME) ?? null,
);
const remoteContent = computed<Infra3dConfig | null>(() => sources.remote<Infra3dConfig>(NAME));

/** Dirty = the editor diverges from its baseline (the local draft when
 *  one exists, otherwise remote / bundled). Drives the Save button. */
const dirty = computed(() => {
  if (!draft.value) return false;
  const baseline = hasLocalDraft.value
    ? localContent.value
    : (remoteContent.value ?? sources.bundled<Infra3dConfig>(NAME));
  // Normalize the baseline to the single-metric shape so an old-shape
  // remote (topology/load) doesn't read as dirty against the normalized draft.
  return stableStringify(draft.value) !== stableStringify(normalizedClone(baseline ?? null));
});

/** Save the current editor state as a browser-local draft. The only
 *  "save" — it never writes OAP. Publish via "Check diff & push". */
function save(): void {
  if (!draft.value) return;
  localEdits.set(NAME, clone(draft.value));
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
    await bff.templateSync.save(NAME, draft.value);
  } catch (err) {
    const anyErr = err as { body?: { issues?: string[] }; message?: string };
    pushErr.value = anyErr.body?.issues ?? [anyErr.message ?? String(err)];
    pushing.value = false;
    return; // keep the modal open with the error; nothing was committed
  }
  // Committed. Clear the local draft + close the modal regardless of the
  // post-write cache refresh outcome below.
  localEdits.remove(NAME);
  pushDiffOpen.value = false;
  // 2) Best-effort cache refreshes. A failure here (e.g. the /3d/map read
  //    cache pop 403-ing for a role without infra-3d:read) does NOT undo the
  //    publish, so it must never surface as a "push failed".
  try {
    await bff.templateSync.resync();
    await Promise.all([sources.refetch(), refreshConfigBundle({ force: true })]);
    await refreshLiveInfraConfig();
    loadFrom('remote');
  } catch (err) {
    console.warn('[infra-3d] post-push refresh failed (the publish already committed):', err);
  } finally {
    pushing.value = false;
  }
}

/** Reset the editor to a clean source and drop any local draft. */
function resetTo(src: 'bundled' | 'remote'): void {
  loadFrom(src);
  localEdits.remove(NAME);
  pushErr.value = null;
  resetMenuOpen.value = false;
}

// ── Levels editing ────────────────────────────────────────────────────
function addLevel(): void {
  if (!draft.value) return;
  const maxOrder = Math.max(-1, ...draft.value.levels.map((l) => l.order));
  // Unique id — a length-based id collides after add-then-remove editing
  // (and a duplicate level id aliases tier buckets + fails save validation).
  const taken = new Set(draft.value.levels.map((l) => l.id));
  let n = draft.value.levels.length + 1;
  let id = `level-${n}`;
  while (taken.has(id)) id = `level-${++n}`;
  draft.value.levels.push({ id, order: maxOrder + 1, label: 'New level', layers: [] });
}
function removeLevel(id: string): void {
  if (!draft.value) return;
  draft.value.levels = draft.value.levels.filter((l) => l.id !== id);
  if (draft.value.unknownLayer.level === id && draft.value.levels.length > 0) {
    draft.value.unknownLayer.level = draft.value.levels[0]!.id;
  }
}
const levelsSorted = computed<InfraLevelSpec[]>(() => {
  if (!draft.value) return [];
  return [...draft.value.levels].sort((a, b) => a.order - b.order);
});

/** `idx` is the index in `levelsSorted` (what the template renders) — NOT
 *  the unsorted `draft.levels` array, whose order can differ from the sort
 *  (bundled has mesh order 2 before middleware order 1). Swap the `order`
 *  values of the two SORTED neighbours so ↑/↓ moves the intended tier. */
function moveLevel(idx: number, delta: number): void {
  const sorted = levelsSorted.value;
  const target = idx + delta;
  if (target < 0 || target >= sorted.length) return;
  const a = sorted[idx]!;
  const b = sorted[target]!;
  const ao = a.order;
  a.order = b.order;
  b.order = ao;
}

// ── Layer ⇄ level resolution ──────────────────────────────────────────
// Level membership is edited in ONE place — the Levels section's member
// chips. The Layers section only DISPLAYS where each layer lands, using
// the same resolution order the BFF applies, so the two surfaces never
// drift into the old "edit the same array twice" redundancy.

/** Compile that never throws — a half-typed regex in an input just stops
 *  matching rather than blowing up the page. */
function safeRegex(src: string): RegExp | null {
  try {
    return new RegExp(src);
  } catch {
    return null;
  }
}

/** Union of OAP-reported + config-declared layer keys (canonical upper). */
const allLayerKeys = computed<string[]>(() => {
  const s = new Set<string>();
  for (const L of availableLayers.value ?? []) s.add(L.key.toUpperCase());
  if (draft.value) for (const k of Object.keys(draft.value.layers)) s.add(k.toUpperCase());
  return [...s].sort((a, b) => a.localeCompare(b));
});

type LevelVia = 'group' | 'explicit' | 'default' | 'filtered';

/** Mirror the BFF's layer→level resolution (see useInfra3dConfig): global
 *  filter → group membership → explicit list → unknownLayer fallback.
 *  Returns HOW it resolved so the unpinned rows can flag fallback / filtered
 *  layers the operator didn't pin by hand. */
function resolveLevel(key: string): { levelId: string | null; via: LevelVia } {
  if (!draft.value) return { levelId: null, via: 'default' };
  const u = key.toUpperCase();
  const gf = safeRegex(draft.value.filter.layer);
  if (gf && !gf.test(u)) return { levelId: null, via: 'filtered' };
  for (const g of draft.value.groups ?? []) {
    if (g.layers.some((k) => k.toUpperCase() === u)) return { levelId: g.level, via: 'group' };
  }
  for (const lvl of draft.value.levels) {
    if (lvl.layers.some((k) => k.toUpperCase() === u)) return { levelId: lvl.id, via: 'explicit' };
  }
  return { levelId: draft.value.unknownLayer.level, via: 'default' };
}

function levelLabel(levelId: string | null): string {
  if (!levelId) return '—';
  return draft.value?.levels.find((l) => l.id === levelId)?.label ?? levelId;
}

// ── Layers editing ────────────────────────────────────────────────────
/** Union of OAP-known + config-known layers. The keys are canonical
 *  upper-case; the entry's `inOap`/`inConfig` flags drive the row badges. */
interface LayerRow {
  key: string;
  inOap: boolean;
  inConfig: boolean;
  hasTopology: boolean;
  spec: InfraLayerSpec | null;
}

const layerRows = computed<LayerRow[]>(() => {
  if (!draft.value) return [];
  const oap = new Map<string, { hasTopology: boolean }>();
  for (const L of availableLayers.value ?? []) {
    oap.set(L.key.toUpperCase(), { hasTopology: !!L.caps?.serviceMap });
  }
  const keys = new Set<string>([...oap.keys(), ...Object.keys(draft.value.layers).map((k) => k.toUpperCase())]);
  const out: LayerRow[] = [];
  for (const k of keys) {
    const o = oap.get(k);
    out.push({
      key: k,
      inOap: !!o,
      inConfig: !!draft.value.layers[k],
      hasTopology: o?.hasTopology ?? !!draft.value.layers[k]?.topology,
      spec: draft.value.layers[k] ?? null,
    });
  }
  // Sort: classified-in-config first (alphabetical), unclassified last.
  out.sort((a, b) => {
    if (a.inConfig !== b.inConfig) return a.inConfig ? -1 : 1;
    return a.key.localeCompare(b.key);
  });
  return out;
});

const filteredLayerRows = computed<LayerRow[]>(() => {
  // Search-only. The global `filter.layer` does NOT hide rows here — an
  // excluded layer still shows (in Unpinned, tagged "filtered out") so the
  // operator can see what the filter drops; it's the SCENE that omits it.
  const q = layerSearch.value.trim().toUpperCase();
  if (!q) return layerRows.value;
  return layerRows.value.filter((r) => r.key.includes(q));
});

/** Layers whose template provides a service map (`caps.serviceMap`) — their
 *  cubes render as a call graph on the map. Read-only here (it's a layer
 *  template property, not a 3D-config field), surfaced in its own section. */
const serviceMapLayers = computed<string[]>(() =>
  layerRows.value.filter((r) => r.hasTopology).map((r) => r.key),
);

/** Resolved level per layer-key — drives the read-only "via" qualifier on
 *  UNPINNED rows so the operator sees how a layer lands when no tier pins
 *  it (regex / fallback / filtered). */
const resolvedLevels = computed<Record<string, { levelId: string | null; via: LevelVia }>>(() => {
  const out: Record<string, { levelId: string | null; via: LevelVia }> = {};
  for (const r of layerRows.value) out[r.key] = resolveLevel(r.key);
  return out;
});

/** Explicit tier (level id) a layer is pinned to, or absent when unpinned. */
const explicitTier = computed<Record<string, string>>(() => {
  const m: Record<string, string> = {};
  for (const lvl of draft.value?.levels ?? []) {
    for (const k of lvl.layers) m[k.toUpperCase()] = lvl.id;
  }
  return m;
});

/** Filtered layer rows grouped under their pinned tier. Every tier gets an
 *  entry (possibly empty) so the combined view renders one block per tier. */
const layersByTier = computed<Record<string, LayerRow[]>>(() => {
  const out: Record<string, LayerRow[]> = {};
  for (const lvl of draft.value?.levels ?? []) out[lvl.id] = [];
  for (const r of filteredLayerRows.value) {
    // Filter-excluded layers are OFF the map — they belong in the Unpinned
    // bucket (tagged "filtered out"), never under a tier even if pinned, so
    // the editor matches what the scene renders.
    if (resolvedLevels.value[r.key]?.via === 'filtered') continue;
    const tierId = explicitTier.value[r.key];
    if (tierId && out[tierId]) out[tierId].push(r);
  }
  return out;
});

/** Rows not shown under a tier: not pinned (→ failover) OR filter-excluded
 *  (→ off the map). The via tag distinguishes "→ <tier>" from "filtered out". */
const unpinnedRows = computed<LayerRow[]>(() =>
  filteredLayerRows.value.filter((r) => {
    const via = resolvedLevels.value[r.key]?.via;
    return via === 'filtered' || !explicitTier.value[r.key];
  }),
);

/** A layer is "unclassified" when nothing places it — it lands on the
 *  failover tier (or is filtered out). Highlights the unpinned row so the
 *  operator notices layers that silently fall through. */
function isUnclassified(key: string): boolean {
  const via = resolvedLevels.value[key]?.via;
  return via === 'default' || via === 'filtered';
}

function ensureLayerSpec(key: string): InfraLayerSpec {
  const u = key.toUpperCase();
  if (!draft.value!.layers[u]) {
    draft.value!.layers[u] = { color: '#8a8a8a' };
  }
  return draft.value!.layers[u]!;
}

/** Pin a layer to one tier, or unpin (nextLevelId null → falls to
 *  failover). A layer belongs to at most one tier's explicit list. */
function assignLayerToLevel(key: string, nextLevelId: string | null): void {
  if (!draft.value) return;
  const u = key.toUpperCase();
  for (const lvl of draft.value.levels) {
    lvl.layers = lvl.layers.filter((k) => k.toUpperCase() !== u);
  }
  if (nextLevelId) {
    const lvl = draft.value.levels.find((l) => l.id === nextLevelId);
    if (lvl) lvl.layers.push(u);
    // Pinning implies the layer is configured (gets a spec to colour/metric).
    ensureLayerSpec(u);
  }
}

/** Tier dropdown handler — empty value unpins (→ failover). */
function onMoveTier(key: string, e: Event): void {
  assignLayerToLevel(key, (e.target as HTMLSelectElement).value || null);
}

function removeLayerFromConfig(key: string): void {
  if (!draft.value) return;
  const u = key.toUpperCase();
  delete draft.value.layers[u];
  for (const lvl of draft.value.levels) {
    lvl.layers = lvl.layers.filter((k) => k.toUpperCase() !== u);
  }
  // Also drop it from any logic group — otherwise a "deleted" layer keeps
  // rendering inside its group block (spec-less, default colour).
  for (const g of draft.value.groups ?? []) {
    g.layers = g.layers.filter((k) => k.toUpperCase() !== u);
  }
}

/** Ensure a single metric object exists to bind the mqe/label/unit inputs
 *  to (creates the layer spec if missing). */
function ensureMetric(key: string): InfraMqe {
  const spec = ensureLayerSpec(key);
  if (!spec.metric) spec.metric = { mqe: '', label: '', unit: '' };
  return spec.metric;
}

function clearMetric(key: string): void {
  const spec = draft.value?.layers[key.toUpperCase()];
  if (spec) spec.metric = undefined;
}

// ── Groups editing ────────────────────────────────────────────────────
// Logic groups (e.g. Self-Observability) cluster several layers into one
// block on a tier. The icon set is the bakeable subset the 3D stamp
// renderer knows (useLayerIconTexture.LayerIconName); an unknown name
// falls back to the generic `svc` glyph at render time.
const ICON_NAMES = [
  'svc', 'sky', 'skywalking', 'mesh', 'cluster',
  'web', 'fn', 'db', 'cache', 'topic', 'flame',
] as const;

function addGroup(): void {
  if (!draft.value) return;
  // `groups` is optional on the wire (older saved configs predate it) —
  // materialise it before pushing so the rest of the editor can treat
  // it as always-present.
  const groups = draft.value.groups ?? (draft.value.groups = []);
  const taken = new Set(groups.map((g) => g.id));
  let n = groups.length + 1;
  let id = `group-${n}`;
  while (taken.has(id)) id = `group-${++n}`;
  groups.push({
    id,
    label: 'New group',
    level: levelsSorted.value[0]?.id ?? '',
    color: '#a78bfa',
    icon: 'svc',
    layers: [],
  });
}
function removeGroup(id: string): void {
  if (!draft.value?.groups) return;
  draft.value.groups = draft.value.groups.filter((g) => g.id !== id);
}
function onAddLayerToGroup(g: InfraGroupSpec, e: Event): void {
  const sel = e.target as HTMLSelectElement;
  const key = sel.value;
  sel.value = '';
  const u = key.toUpperCase();
  if (u && !g.layers.some((k) => k.toUpperCase() === u)) g.layers.push(u);
}
function removeLayerFromGroup(g: InfraGroupSpec, key: string): void {
  const u = key.toUpperCase();
  g.layers = g.layers.filter((k) => k.toUpperCase() !== u);
}
/** A group's add-picker candidates — every layer not already in ANY group
 *  (a layer belongs to at most one logic group; the validator rejects double
 *  membership). Group membership is independent of tier pinning. */
function groupCandidates(_g: InfraGroupSpec): string[] {
  const inAnyGroup = new Set<string>();
  for (const gr of draft.value?.groups ?? []) {
    for (const k of gr.layers) inAnyGroup.add(k.toUpperCase());
  }
  return allLayerKeys.value.filter((k) => !inAnyGroup.has(k));
}

// Quick-stat counts for the Layers section head. `oap` = layers OAP
// actually reports; `unclassified` = live OAP layers that nothing places
// (they fall to the unknown-layer level). We deliberately don't surface a
// "configured" count — every layer carries a spec, so it was always ~52
// and told the operator nothing.
const stats = computed(() => {
  const rows = layerRows.value;
  return {
    oap: rows.filter((r) => r.inOap).length,
    unclassified: rows.filter((r) => r.inOap && isUnclassified(r.key)).length,
  };
});
</script>

<template>
  <div class="i3d-admin">
    <header class="hd">
      <div class="hd-text">
        <span class="kicker">{{ t('Dashboard setup · 3D Infra Map') }}</span>
        <h1>{{ t('3D Infrastructure Map') }}</h1>
        <p class="lede">
          <i18n-t keypath="Config for the {mapPath} view, published to OAP. Levels control the vertical stack; per-layer color + metrics drive each cube. Edits save to a {localDraft}; {checkDiffPush} publishes to OAP — the map renders the remote, with bundled defaults as fallback." tag="span" scope="global">
            <template #mapPath><code>/3d/map</code></template>
            <template #localDraft><strong>{{ t('local draft in this browser') }}</strong></template>
            <template #checkDiffPush><strong>{{ t('Check diff & push') }}</strong></template>
          </i18n-t>
        </p>
      </div>
      <div class="hd-actions">
        <span class="src-pill" :data-src="editorSource">
          {{ t('editing: {source}', { source: editorSource }) }}
          <TemplateStatusBadge v-if="badge" :status="badge" />
        </span>
        <div class="reset-wrap">
          <button class="btn" :disabled="pushing" @click="resetMenuOpen = !resetMenuOpen">{{ t('Reset to') }} ▾</button>
          <div v-if="resetMenuOpen" class="reset-menu">
            <button
              class="reset-item"
              :disabled="isSynced"
              :title="isSynced ? t('Bundled equals OAP-live — nothing to reset to.') : t('Discard current edits and reload the bundled (shipped) default.')"
              @click="resetTo('bundled')"
            >
              {{ t('Bundled') }}<span v-if="isSynced" class="reset-suffix"> ({{ t('synced') }})</span>
            </button>
            <button
              class="reset-item"
              :disabled="!hasRemote"
              :title="hasRemote ? t('Discard current edits and reload OAP\'s live version.') : t('OAP has no copy of this config yet.')"
              @click="resetTo('remote')"
            >
              {{ t('Remote') }}
            </button>
          </div>
        </div>
        <button class="btn" :disabled="!dirty" @click="save">
          {{ hasLocalDraft && !dirty ? t('Saved local') : t('Save local') }}
        </button>
        <button class="btn primary" :disabled="readOnly || (!dirty && !hasLocalDraft)" @click="openPushDiff">
          {{ t('Check diff & push') }}
        </button>
      </div>
    </header>

    <SyncStatusBanner :banner="sync.banner.value" />
    <ul v-if="pushErr && pushErr.length" class="issues">
      <li v-for="(it, i) in pushErr" :key="i"><code>{{ it }}</code></li>
    </ul>

    <div v-if="loadError" class="loading">
      {{ t('Couldn\'t load the 3D-map config — the BFF may be unreachable. Refresh the page to retry.') }}
    </div>
    <div v-else-if="!ready" class="loading">{{ t('Loading config…') }}</div>
    <template v-else-if="draft">
      <!-- ── Global filter ─────────────────────────────────────────── -->
      <section class="sect">
        <header class="sect-head">
          <h2>{{ t('Global layer filter') }}</h2>
          <span class="sec-hint">
            <i18n-t keypath='The one top-level gate — a layer this JS regex excludes is off the map (it still shows below in Unpinned, tagged "filtered out"). Default {dotStar} admits all.' tag="span" scope="global">
              <template #dotStar><code>.*</code></template>
            </i18n-t>
          </span>
        </header>
        <div class="sect-body">
          <label class="field">
            <span class="lbl">filter.layer</span>
            <input class="inp mono" v-model="draft.filter.layer" placeholder=".*" />
          </label>
        </div>
      </section>

      <!-- ── Tiers & layers ─────────────────────────────────────────── -->
      <section class="sect">
        <header class="sect-head">
          <h2>{{ t('Tiers & layers (top → bottom)') }}</h2>
          <span class="sec-hint">
            {{ t('Every layer belongs to one tier — set it with the tier dropdown; order = vertical stacking.') }}
            <i18n-t keypath="{count} in OAP" tag="span" scope="global">
              <template #count><strong>{{ stats.oap }}</strong></template>
            </i18n-t><template v-if="stats.unclassified > 0"> ·
            <i18n-t keypath="{count} unpinned → fallback" tag="span" scope="global">
              <template #count><strong class="warn-count">{{ stats.unclassified }}</strong></template>
            </i18n-t></template>
          </span>
          <input class="inp search" v-model="layerSearch" :placeholder="t('filter layers…')" />
          <button type="button" class="btn small" @click="addLevel">{{ t('+ add tier') }}</button>
        </header>
        <div class="sect-body">
          <article v-for="(lvl, idx) in levelsSorted" :key="lvl.id" class="tier-card">
            <header class="lvl-head">
              <span class="lvl-order">#{{ lvl.order }}</span>
              <input class="inp lvl-id mono" v-model="lvl.id" placeholder="apps" />
              <input class="inp lvl-label" v-model="lvl.label" placeholder="Apps" />
              <span class="tier-count">{{ t('{count} layers', { count: layersByTier[lvl.id]?.length ?? 0 }) }}</span>
              <div class="lvl-spacer" />
              <button type="button" class="btn tiny" :disabled="idx === 0" @click="moveLevel(idx, -1)">↑</button>
              <button type="button" class="btn tiny" :disabled="idx === levelsSorted.length - 1" @click="moveLevel(idx, 1)">↓</button>
              <button type="button" class="btn tiny danger" @click="removeLevel(lvl.id)">{{ t('remove') }}</button>
            </header>
            <div class="tier-body">
              <div class="layer-rows">
                <div v-for="row in layersByTier[lvl.id]" :key="row.key" class="layer-row">
                  <input type="color" class="color-pick" :value="row.spec?.color ?? '#8a8a8a'" @input="(e) => (ensureLayerSpec(row.key).color = (e.target as HTMLInputElement).value)" />
                  <span class="layer-key">{{ row.key }}</span>
                  <template v-if="row.spec?.metric">
                    <input class="inp mono metric-mqe" v-model="row.spec.metric.mqe" :placeholder="t('mqe e.g. service_cpm')" />
                    <input class="inp metric-lbl" v-model="row.spec.metric.label" :placeholder="t('label')" />
                    <input class="inp metric-unit" v-model="row.spec.metric.unit" :placeholder="t('unit')" />
                    <button class="btn tiny danger" type="button" :title="t('remove metric')" @click="clearMetric(row.key)">⊘</button>
                  </template>
                  <button v-else class="btn tiny ghost" type="button" @click="ensureMetric(row.key)">{{ t('+ metric') }}</button>
                  <div class="row-spacer" />
                  <select class="inp tier-select" :value="explicitTier[row.key] ?? ''" @change="(e) => onMoveTier(row.key, e)">
                    <option value="">{{ t('— unpinned —') }}</option>
                    <option v-for="tier in levelsSorted" :key="tier.id" :value="tier.id">{{ tier.label }}</option>
                  </select>
                  <button class="btn tiny ghost" type="button" :title="t('Remove from this tier (moves to Unpinned)')" @click="assignLayerToLevel(row.key, null)">×</button>
                </div>
                <div v-if="(layersByTier[lvl.id]?.length ?? 0) === 0" class="tier-empty">{{ t('No layers pinned — use a layer\'s tier dropdown to move one here.') }}</div>
              </div>
            </div>
          </article>
        </div>
      </section>

      <!-- ── Unpinned → failover ────────────────────────────────────── -->
      <section class="sect">
        <header class="sect-head">
          <h2>{{ t('Unpinned layers') }}</h2>
          <span class="sec-hint">
            <i18n-t keypath="Pinned to no tier — they land on the failover tier ({failoverTier}). Pick a tier to pin one." tag="span" scope="global">
              <template #failoverTier><strong>{{ levelLabel(draft.unknownLayer.level) }}</strong></template>
            </i18n-t>
          </span>
        </header>
        <div class="sect-body">
          <div class="layer-rows">
            <div
              v-for="row in unpinnedRows"
              :key="row.key"
              class="layer-row"
              :class="{ unclassified: isUnclassified(row.key) }"
            >
              <input type="color" class="color-pick" :value="row.spec?.color ?? '#8a8a8a'" @input="(e) => (ensureLayerSpec(row.key).color = (e.target as HTMLInputElement).value)" />
              <span class="layer-key">{{ row.key }}</span>
              <template v-if="row.spec?.metric">
                <input class="inp mono metric-mqe" v-model="row.spec.metric.mqe" placeholder="mqe" />
                <input class="inp metric-lbl" v-model="row.spec.metric.label" :placeholder="t('label')" />
                <input class="inp metric-unit" v-model="row.spec.metric.unit" :placeholder="t('unit')" />
                <button class="btn tiny danger" type="button" :title="t('remove metric')" @click="clearMetric(row.key)">⊘</button>
              </template>
              <button v-else class="btn tiny ghost" type="button" @click="ensureMetric(row.key)">{{ t('+ metric') }}</button>
              <div class="row-spacer" />
              <span class="via-tag" :data-via="resolvedLevels[row.key]?.via" :title="t('falls to {via}', { via: resolvedLevels[row.key]?.via })">
                {{ resolvedLevels[row.key]?.via === 'filtered' ? t('filtered out') : '→ ' + levelLabel(resolvedLevels[row.key]?.levelId ?? null) }}
              </span>
              <select class="inp tier-select" :value="explicitTier[row.key] ?? ''" @change="(e) => onMoveTier(row.key, e)">
                <option value="">{{ t('— pin to tier —') }}</option>
                <option v-for="tier in levelsSorted" :key="tier.id" :value="tier.id">{{ tier.label }}</option>
              </select>
              <button class="btn tiny danger" type="button" :title="t('Delete this layer from the config entirely')" @click="removeLayerFromConfig(row.key)">×</button>
            </div>
            <div v-if="unpinnedRows.length === 0" class="empty">{{ t('No unpinned layers.') }}</div>
          </div>
        </div>
      </section>

      <!-- ── Groups ────────────────────────────────────────────────── -->
      <section class="sect">
        <header class="sect-head">
          <h2>{{ t('Logic groups') }}</h2>
          <span class="sec-hint">{{ t('Several layers drawn as one labelled block on a tier (e.g. Self-Observability). Each member keeps its own cube color.') }}</span>
          <button type="button" class="btn small" @click="addGroup">{{ t('+ add group') }}</button>
        </header>
        <div class="sect-body">
          <div class="groups-grid">
            <article v-for="g in (draft.groups ?? [])" :key="g.id" class="group-card">
              <header class="group-head">
                <input
                  type="color"
                  class="color-pick"
                  :value="parseHexColor(g.color)"
                  @input="(e) => (g.color = (e.target as HTMLInputElement).value)"
                />
                <input class="inp group-id mono" v-model="g.id" placeholder="self-observability" />
                <input class="inp group-label" v-model="g.label" placeholder="Self-Observability" />
                <div class="lvl-spacer" />
                <button type="button" class="btn tiny danger" @click="removeGroup(g.id)">{{ t('remove') }}</button>
              </header>
              <div class="group-body">
                <div class="row-2">
                  <label class="field">
                    <span class="lbl small">{{ t('level') }}</span>
                    <select class="inp" v-model="g.level">
                      <option v-for="lvl in levelsSorted" :key="lvl.id" :value="lvl.id">{{ lvl.label }} ({{ lvl.id }})</option>
                    </select>
                  </label>
                  <label class="field">
                    <span class="lbl small">{{ t('icon') }}</span>
                    <select class="inp" v-model="g.icon">
                      <option v-for="ic in ICON_NAMES" :key="ic" :value="ic">{{ ic }}</option>
                    </select>
                  </label>
                </div>
                <div class="field">
                  <span class="lbl small">{{ t('member layers ({count})', { count: g.layers.length }) }}</span>
                  <div class="chips">
                    <span v-for="k in g.layers" :key="k" class="chip">
                      {{ k }}
                      <button class="x" type="button" :title="t('remove from group')" @click="removeLayerFromGroup(g, k)">×</button>
                    </span>
                    <select class="add-layer" :value="''" @change="(e) => onAddLayerToGroup(g, e)">
                      <option value="">{{ t('＋ add layer…') }}</option>
                      <option v-for="k in groupCandidates(g)" :key="k" :value="k">{{ k }}</option>
                    </select>
                  </div>
                  <p v-if="g.layers.length === 0" class="hint-sm warn">{{ t('A group needs at least one layer — pushing will be rejected until you add one.') }}</p>
                </div>
              </div>
            </article>
            <div v-if="(draft.groups ?? []).length === 0" class="empty">{{ t('No logic groups. Add one to cluster related layers into a single block.') }}</div>
          </div>
        </div>
      </section>

      <!-- ── Service-map layers ─────────────────────────────────────── -->
      <section class="sect">
        <header class="sect-head">
          <h2>{{ t('Service-map layers') }}</h2>
          <span class="sec-hint">
            {{ t('These layers\' templates provide a service map, so their cubes render as a call graph (and seed the cross-layer hierarchy). Read-only — it\'s a layer-template property, not a 3D-map setting.') }}
          </span>
        </header>
        <div class="sect-body">
          <div class="chips">
            <span v-for="k in serviceMapLayers" :key="k" class="chip">{{ k }}</span>
            <span v-if="serviceMapLayers.length === 0" class="chips-empty">{{ t('None reporting a service map.') }}</span>
          </div>
        </div>
      </section>

      <!-- ── Unknown layer fallback ─────────────────────────────────── -->
      <section class="sect">
        <header class="sect-head">
          <h2>{{ t('Failover tier') }}</h2>
          <span class="sec-hint">{{ t('The single catch-all: any layer no tier pins lands here.') }}</span>
        </header>
        <div class="sect-body">
          <label class="field">
            <span class="lbl">{{ t('level') }}</span>
            <select class="inp fallback-level" v-model="draft.unknownLayer.level">
              <option v-for="lvl in levelsSorted" :key="lvl.id" :value="lvl.id">{{ lvl.label }} ({{ lvl.id }})</option>
            </select>
          </label>
        </div>
      </section>

    </template>

    <!-- ── Check diff & push ──────────────────────────────────────────── -->
    <Modal :open="pushDiffOpen" :title="t('Push 3D-map config to OAP')" width="min(1100px, 94vw)" @close="pushDiffOpen = false">
      <div class="push-modal">
        <p class="push-lede">
          {{ t('Left = live on OAP (remote). Right = your local draft. Pushing replaces the OAP copy — the map renders it on the next visit.') }}
        </p>
        <ul v-if="pushErr && pushErr.length" class="issues">
          <li v-for="(it, i) in pushErr" :key="i"><code>{{ it }}</code></li>
        </ul>
        <MonacoDiff :original="pushRemotePretty" :modified="pushLocalPretty" language="json" />
      </div>
      <template #footer>
        <button class="btn" :disabled="pushing" @click="pushDiffOpen = false">{{ t('Cancel') }}</button>
        <button class="btn primary" :disabled="pushing || readOnly" @click="pushToOap">
          {{ pushing ? t('Pushing…') : t('Push to OAP') }}
        </button>
      </template>
    </Modal>
  </div>
</template>

<script lang="ts">
// Lightweight hex normalizer so the <input type="color"> always gets
// `#rrggbb`. CSS color strings like `rgba(...)` go through unchanged
// to the text input, but the color picker would refuse them.
function parseHexColor(s: string): string {
  const m = /^#([0-9a-fA-F]{6})$/.exec(s.trim());
  if (m) return `#${m[1]!.toLowerCase()}`;
  // Best-effort fallback — a neutral gray so the picker doesn't get
  // stuck on an empty value.
  return '#8a8a8a';
}
export { parseHexColor };
</script>

<style scoped>
.i3d-admin {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--sw-bg-0);
  overflow-y: auto;
}

/* Header */
.hd {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 20px;
  border-bottom: 1px solid var(--sw-line);
  background: var(--sw-bg-1);
  flex: 0 0 auto;
  gap: 16px;
}
.hd-text { min-width: 0; }
.kicker  { display: block; font-size: 10.5px; letter-spacing: 0.06em; color: var(--sw-fg-3); text-transform: uppercase; }
.hd-text h1 { margin: 2px 0 4px; font-size: 16px; color: var(--sw-fg-0); }
.lede   { font-size: 11.5px; color: var(--sw-fg-2); margin: 0; max-width: 760px; line-height: 1.5; }
.lede code { background: var(--sw-bg-3); padding: 1px 4px; border-radius: 3px; }
.hd-actions { display: flex; align-items: center; gap: 8px; flex: 0 0 auto; }

/* Source pill + reset menu */
.src-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 26px;
  padding: 0 10px;
  border: 1px solid var(--sw-line-2);
  border-radius: 4px;
  background: var(--sw-bg-2);
  color: var(--sw-fg-2);
  font-size: 10.5px;
  text-transform: capitalize;
}
.src-pill[data-src='local'] { border-color: rgba(94, 234, 212, 0.5); color: #5eead4; }
.reset-wrap { position: relative; }
.reset-menu {
  position: absolute;
  right: 0;
  top: calc(100% + 4px);
  z-index: 20;
  display: flex;
  flex-direction: column;
  min-width: 200px;
  padding: 4px;
  border: 1px solid var(--sw-line-2);
  border-radius: 6px;
  background: var(--sw-bg-2);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
}
.reset-item {
  height: 26px;
  padding: 0 8px;
  text-align: left;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--sw-fg-1);
  font-size: 11.5px;
  cursor: pointer;
}
.reset-item:hover:not([disabled]) { background: var(--sw-bg-3); color: var(--sw-fg-0); }
.reset-item[disabled] { opacity: 0.45; cursor: default; }
.reset-suffix { color: var(--sw-fg-3); font-size: 10px; }

/* Push diff modal */
.push-modal { display: flex; flex-direction: column; gap: 10px; min-width: min(1040px, 90vw); }
.push-lede { font-size: 11.5px; color: var(--sw-fg-2); margin: 0; }

/* Buttons */
.btn {
  height: 26px;
  padding: 0 12px;
  font-size: 11.5px;
  border: 1px solid var(--sw-line-2);
  border-radius: 4px;
  background: var(--sw-bg-2);
  color: var(--sw-fg-1);
  cursor: pointer;
  white-space: nowrap;
}
.btn:hover:not([disabled]) { background: var(--sw-bg-3); color: var(--sw-fg-0); }
.btn[disabled]             { opacity: 0.45; cursor: default; }
.btn.primary               { background: var(--sw-accent); border-color: var(--sw-accent); color: #1a1106; }
.btn.primary:hover:not([disabled]) { filter: brightness(1.1); }
.btn.small { height: 22px; padding: 0 10px; font-size: 10.5px; }
.btn.tiny  { height: 20px; padding: 0 8px;  font-size: 10px; }
.btn.danger { border-color: rgba(239, 68, 68, 0.6); color: #f87171; }
.btn.danger:hover:not([disabled]) { background: rgba(239, 68, 68, 0.15); color: #fca5a5; }

/* Banners */
.issues {
  margin: 8px 20px 0;
  padding: 8px 12px;
  border: 1px solid rgba(239, 68, 68, 0.4);
  border-radius: 4px;
  background: rgba(239, 68, 68, 0.08);
  list-style: none;
  font-size: 11px;
  color: #fca5a5;
  max-height: 140px;
  overflow-y: auto;
}
.issues code { color: #fff; }
.loading { padding: 20px; color: var(--sw-fg-3); font-size: 12px; }

/* Sections */
.sect {
  margin: 12px 20px;
  border: 1px solid var(--sw-line);
  border-radius: 6px;
  background: var(--sw-bg-1);
}
.sect-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--sw-line);
  background: var(--sw-bg-2);
}
.sect-head h2 { margin: 0; font-size: 12px; color: var(--sw-fg-0); font-weight: 700; letter-spacing: 0.02em; }
.sec-hint    { font-size: 11px; color: var(--sw-fg-3); }
.sec-hint code { background: var(--sw-bg-3); padding: 0 4px; border-radius: 3px; }
.sect-body  { padding: 12px 14px; }
.fallback-level { max-width: 260px; }

/* Inputs */
.field { display: flex; flex-direction: column; gap: 4px; margin-bottom: 8px; }
.field.row { flex-direction: row; align-items: center; gap: 6px; }
.lbl   { font-size: 10.5px; letter-spacing: 0.04em; text-transform: uppercase; color: var(--sw-fg-3); }
.lbl.small { font-size: 9.5px; }
.inp {
  height: 24px;
  padding: 0 8px;
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line-2);
  border-radius: 4px;
  color: var(--sw-fg-0);
  font-size: 11.5px;
  font-family: inherit;
}
.inp.mono { font-family: var(--sw-mono-font, ui-monospace, monospace); font-size: 11px; }
.inp.small { width: 100px; }
.inp.search { height: 22px; width: 180px; margin-left: auto; }
.inp:focus { outline: 1px solid var(--sw-accent); }

/* Tiers */
.tier-card {
  border: 1px solid var(--sw-line);
  border-radius: 4px;
  background: var(--sw-bg-2);
  margin-bottom: 8px;
}
.lvl-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-bottom: 1px solid var(--sw-line);
}
.lvl-order { font-size: 10.5px; color: var(--sw-fg-3); width: 28px; font-family: var(--sw-mono-font, monospace); }
.lvl-id    { width: 130px; }
.lvl-label { width: 170px; }
.lvl-spacer { flex: 1; }
.tier-count { font-size: 10.5px; color: var(--sw-fg-3); white-space: nowrap; }
.tier-body { padding: 8px 10px; display: flex; flex-direction: column; gap: 8px; }
.btn.ghost {
  align-self: flex-start;
  background: transparent;
  border-style: dashed;
  color: var(--sw-fg-3);
}
.btn.ghost:hover:not([disabled]) { color: var(--sw-fg-1); border-color: var(--sw-accent); background: transparent; }
.chips { display: flex; flex-wrap: wrap; gap: 4px; }
.chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 6px;
  border-radius: 10px;
  background: var(--sw-bg-3);
  font-family: var(--sw-mono-font, monospace);
  font-size: 10.5px;
  color: var(--sw-fg-1);
}
.chip .x {
  border: none;
  background: transparent;
  color: var(--sw-fg-3);
  font-size: 11px;
  cursor: pointer;
  padding: 0 2px;
}
.chip .x:hover { color: #f87171; }
.chips-empty { font-size: 11px; color: var(--sw-fg-3); font-style: italic; }
/* Inline "＋ add layer" picker — shares the chip row, styled to read as
   an affordance rather than a form control. */
.add-layer {
  height: 22px;
  padding: 0 6px;
  background: var(--sw-bg-3);
  border: 1px dashed var(--sw-line-2);
  border-radius: 10px;
  color: var(--sw-fg-2);
  font-size: 10.5px;
  font-family: inherit;
  cursor: pointer;
}
.add-layer:hover { border-color: var(--sw-accent); color: var(--sw-fg-0); }
.add-layer:focus { outline: 1px solid var(--sw-accent); }

/* Layer rows — one dense line per layer (inside a tier or the unpinned
   bucket): colour · key · badges · metric (mqe/label/unit) · tier · remove. */
.layer-rows { display: flex; flex-direction: column; gap: 4px; }
.layer-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 6px;
  border: 1px solid var(--sw-line);
  border-radius: 4px;
  background: var(--sw-bg-1);
}
.layer-row.unclassified { border-color: rgba(239, 158, 68, 0.5); }
.color-pick {
  width: 24px;
  height: 20px;
  padding: 0;
  border: 1px solid var(--sw-line-2);
  border-radius: 3px;
  background: transparent;
  cursor: pointer;
  flex: 0 0 auto;
}
.layer-key {
  font-family: var(--sw-mono-font, monospace);
  font-size: 11.5px;
  font-weight: 600;
  color: var(--sw-fg-0);
  /* Fixed column so the metric fields line up across every row regardless
     of key length (GENERAL … BYTEDANCE_MINI_PROGRAM). */
  flex: 0 0 190px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.via-tag { font-size: 10px; color: var(--sw-fg-3); white-space: nowrap; flex: 0 0 auto; }
.via-tag[data-via='default'],
.via-tag[data-via='filtered'] { color: #f0a04b; }
.metric-mqe { flex: 0 1 200px; min-width: 110px; }
.metric-lbl { flex: 0 0 110px; }
.metric-unit { flex: 0 0 72px; }
.row-spacer { flex: 1 1 auto; min-width: 8px; }
.tier-select { flex: 0 0 130px; }
.tier-empty { font-size: 11px; color: var(--sw-fg-3); font-style: italic; padding: 2px 2px 4px; }
.warn-count { color: #f0a04b; }
.row-2 { display: flex; gap: 8px; }
.row-2 .field { flex: 1; }
.hint-sm { font-size: 10.5px; color: var(--sw-fg-3); margin: 0; }
.empty { padding: 14px; text-align: center; color: var(--sw-fg-3); font-size: 11.5px; }

/* Groups */
.groups-grid { display: flex; flex-direction: column; gap: 8px; }
.group-card {
  border: 1px solid var(--sw-line);
  border-radius: 4px;
  background: var(--sw-bg-2);
}
.group-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-bottom: 1px solid var(--sw-line);
}
.group-id    { width: 200px; }
.group-label { width: 220px; }
.group-body  { padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; }
.group-body .row-2 { max-width: 420px; }
.hint-sm.warn { color: #f0a04b; }

/* Advanced */
</style>
