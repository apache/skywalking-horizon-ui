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

  Sections (top-to-bottom):
    1. Header + action bar (Save / Reset to bundled / Discard).
    2. Banner — dirty / saved / issues list from server validation.
    3. Global filter — one regex (`filter.layer`).
    4. Levels — per-level cards (id, order, label, layerFilter regex,
       explicit-layer chip grid).
    5. Layers — table over the UNION of (a) OAP `listLayers` catalog
       (live, refetched on the menu's TTL) and (b) layer keys already
       in the config. Each row carries color, level dropdown, has-
       topology badge (from `caps.serviceMap`), and an expandable MQE
       editor (server + client pair OR single load).
    6. Edges — three cards (hierarchy / cross-level call / intra-layer
       call) with color + style + arrow toggle.
    7. Pipeline — three numeric inputs (chunk + concurrency limits).
    8. Unknown layer — fallback level dropdown + badge text.
    9. Advanced (collapsible) — Monaco JSON editor showing the full
       resolved doc, for power-edits the structured UI can't express.

  Editing is local-first: the page hydrates from
  `GET /api/infra-3d/config`, mutates a draft, and POSTs the whole doc
  on Save. Server validation issues land back in the banner with the
  exact field path so the operator can jump to the input that failed.
-->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import * as monaco from 'monaco-editor';
import { useLayers } from '@/shell/useLayers';
import {
  bff,
  type Infra3dConfig,
  type InfraEdgeStyle,
  type InfraLayerSpec,
  type InfraLevelSpec,
  type InfraMqe,
} from '@/api/client';
import { refresh as refreshLiveInfraConfig } from '@/features/infra-3d/composables/useInfra3dConfig';
import { setupMonaco, RR_THEME_NAME } from '@/monaco/setup';

// ── Live OAP layer catalog ────────────────────────────────────────────
// We hydrate the Layers section from the catalog union'd with config
// keys, so an OAP layer the admin hasn't classified yet shows up here
// and an out-of-tree layer (config exists, OAP no longer reports it)
// also shows so the admin can remove it.
const { availableLayers } = useLayers();

// ── State ─────────────────────────────────────────────────────────────
const loading = ref(true);
const saving = ref(false);
const flash = ref<{ kind: 'ok' | 'err'; text: string } | null>(null);
const issues = ref<string[]>([]);
const draft = ref<Infra3dConfig | null>(null);
/** Persisted snapshot — used as the dirty-check baseline and as the
 *  "Discard changes" target. Updated on every successful load / save. */
const orig = ref<string | null>(null);
/** Per-row UI state — which layer rows are expanded for MQE editing. */
const expandedLayers = ref<Set<string>>(new Set());
const layerSearch = ref('');
const advancedOpen = ref(false);

function setFlash(kind: 'ok' | 'err', text: string): void {
  flash.value = { kind, text };
  setTimeout(() => {
    if (flash.value && flash.value.text === text) flash.value = null;
  }, 4000);
}

function snapshot(cfg: Infra3dConfig): string {
  return JSON.stringify(cfg);
}

const dirty = computed(() => {
  if (!draft.value || orig.value === null) return false;
  return snapshot(draft.value) !== orig.value;
});

async function loadConfig(): Promise<void> {
  loading.value = true;
  try {
    const live = await bff.infra3d.config();
    draft.value = live;
    orig.value = snapshot(live);
    issues.value = [];
  } catch (err) {
    setFlash('err', err instanceof Error ? err.message : String(err));
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  void loadConfig();
});

async function onSave(): Promise<void> {
  if (!draft.value || saving.value) return;
  saving.value = true;
  issues.value = [];
  try {
    const saved = await bff.infra3d.saveConfig(draft.value);
    draft.value = saved;
    orig.value = snapshot(saved);
    // Pop the next /3d/map view's read cache so it picks up the new
    // config without a page reload.
    await refreshLiveInfraConfig();
    setFlash('ok', 'Saved. The 3D map will reload on next visit.');
  } catch (err) {
    const anyErr = err as { body?: { issues?: string[] }; message?: string };
    if (anyErr.body?.issues && Array.isArray(anyErr.body.issues)) {
      issues.value = anyErr.body.issues;
      setFlash('err', `Rejected: ${anyErr.body.issues.length} issue(s) — see below.`);
    } else {
      setFlash('err', anyErr.message ?? String(err));
    }
  } finally {
    saving.value = false;
  }
}

function onDiscard(): void {
  if (!orig.value) return;
  draft.value = JSON.parse(orig.value) as Infra3dConfig;
  issues.value = [];
}

async function onResetBundled(): Promise<void> {
  try {
    const b = await bff.infra3d.bundledConfig();
    draft.value = b;
    // dirty intentionally — operator reviews and clicks Save.
    setFlash('ok', 'Bundled defaults loaded — review and Save to apply.');
  } catch (err) {
    setFlash('err', err instanceof Error ? err.message : String(err));
  }
}

// ── Levels editing ────────────────────────────────────────────────────
function addLevel(): void {
  if (!draft.value) return;
  const maxOrder = Math.max(-1, ...draft.value.levels.map((l) => l.order));
  draft.value.levels.push({
    id: `level-${draft.value.levels.length + 1}`,
    order: maxOrder + 1,
    label: 'New level',
    layerFilter: '.*',
    layers: [],
  });
}
function removeLevel(id: string): void {
  if (!draft.value) return;
  draft.value.levels = draft.value.levels.filter((l) => l.id !== id);
  if (draft.value.unknownLayer.level === id && draft.value.levels.length > 0) {
    draft.value.unknownLayer.level = draft.value.levels[0]!.id;
  }
}
function moveLevel(idx: number, delta: number): void {
  if (!draft.value) return;
  const target = idx + delta;
  if (target < 0 || target >= draft.value.levels.length) return;
  // Swap `order` values so the resulting sort is stable.
  const a = draft.value.levels[idx]!;
  const b = draft.value.levels[target]!;
  const ao = a.order;
  a.order = b.order;
  b.order = ao;
}

const levelsSorted = computed<InfraLevelSpec[]>(() => {
  if (!draft.value) return [];
  return [...draft.value.levels].sort((a, b) => a.order - b.order);
});

// ── Layers editing ────────────────────────────────────────────────────
/** Union of OAP-known + config-known layers. The keys are canonical
 *  upper-case; the entry's `inOap`/`inConfig` flags drive the row badges. */
interface LayerRow {
  key: string;
  inOap: boolean;
  inConfig: boolean;
  hasTopology: boolean;
  /** Layer template's `group` / OAP grouping. Surfaces as a row badge. */
  group: string | null;
  spec: InfraLayerSpec | null;
}

const layerRows = computed<LayerRow[]>(() => {
  if (!draft.value) return [];
  const oap = new Map<string, { hasTopology: boolean; group: string | null }>();
  for (const L of availableLayers.value ?? []) {
    oap.set(L.key.toUpperCase(), {
      hasTopology: !!L.caps?.serviceMap,
      group: L.group ?? null,
    });
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
      group: o?.group ?? null,
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
  const q = layerSearch.value.trim().toUpperCase();
  if (!q) return layerRows.value;
  return layerRows.value.filter((r) => r.key.includes(q));
});

function ensureLayerSpec(key: string): InfraLayerSpec {
  const u = key.toUpperCase();
  if (!draft.value!.layers[u]) {
    draft.value!.layers[u] = { color: '#8a8a8a' };
  }
  return draft.value!.layers[u]!;
}

function levelForLayerKey(key: string): string | null {
  if (!draft.value) return null;
  const u = key.toUpperCase();
  for (const l of draft.value.levels) {
    if (l.layers.some((k) => k.toUpperCase() === u)) return l.id;
  }
  return null;
}

function assignLayerToLevel(key: string, nextLevelId: string | null): void {
  if (!draft.value) return;
  const u = key.toUpperCase();
  // Remove from all levels first — a layer can only belong to one
  // explicit list (the validator rejects otherwise).
  for (const lvl of draft.value.levels) {
    lvl.layers = lvl.layers.filter((k) => k.toUpperCase() !== u);
  }
  if (nextLevelId) {
    const lvl = draft.value.levels.find((l) => l.id === nextLevelId);
    if (lvl) lvl.layers.push(u);
  }
  // Make sure the layer has a config entry so the row doesn't snap
  // back to "unconfigured" once a level is picked.
  ensureLayerSpec(u);
}

function removeLayerFromConfig(key: string): void {
  if (!draft.value) return;
  const u = key.toUpperCase();
  delete draft.value.layers[u];
  for (const lvl of draft.value.levels) {
    lvl.layers = lvl.layers.filter((k) => k.toUpperCase() !== u);
  }
  expandedLayers.value.delete(u);
}

function setLayerMode(key: string, mode: 'topology' | 'load' | 'none'): void {
  if (!draft.value) return;
  const spec = ensureLayerSpec(key);
  if (mode === 'topology') {
    spec.load = undefined;
    spec.topology = spec.topology ?? { server: emptyMqe('Server RPM', 'rpm') };
  } else if (mode === 'load') {
    spec.topology = undefined;
    spec.load = spec.load ?? emptyMqe('Load', '');
  } else {
    spec.topology = undefined;
    spec.load = undefined;
  }
}

function ensureTopologyHalf(key: string, side: 'server' | 'client'): void {
  const spec = ensureLayerSpec(key);
  if (!spec.topology) spec.topology = {};
  if (!spec.topology[side]) {
    spec.topology[side] = emptyMqe(side === 'server' ? 'Server RPM' : 'Client RPM', 'rpm');
  }
}

function dropTopologyHalf(key: string, side: 'server' | 'client'): void {
  const spec = draft.value?.layers[key.toUpperCase()];
  if (spec?.topology) delete spec.topology[side];
}

function emptyMqe(label: string, unit: string): InfraMqe {
  return { mqe: '', label, unit };
}

function toggleLayerExpand(key: string): void {
  const u = key.toUpperCase();
  const s = new Set(expandedLayers.value);
  if (s.has(u)) s.delete(u);
  else s.add(u);
  expandedLayers.value = s;
}

// ── Advanced JSON editor ──────────────────────────────────────────────
const advHost = ref<HTMLDivElement | null>(null);
let advEditor: monaco.editor.IStandaloneCodeEditor | null = null;
let advModel: monaco.editor.ITextModel | null = null;
let suppressAdvChange = false;

watch(advancedOpen, async (open) => {
  if (!open) return;
  // Lazy-init Monaco only when the operator actually expands the
  // section — avoids paying the editor cost for everyone.
  await Promise.resolve();
  if (advEditor || !advHost.value || !draft.value) return;
  setupMonaco();
  advModel = monaco.editor.createModel(JSON.stringify(draft.value, null, 2), 'json');
  advEditor = monaco.editor.create(advHost.value, {
    model: advModel,
    theme: RR_THEME_NAME,
    automaticLayout: true,
    minimap: { enabled: false },
    folding: true,
    scrollBeyondLastLine: false,
    fontSize: 12.5,
    tabSize: 2,
  });
  advModel.onDidChangeContent(() => {
    if (suppressAdvChange) return;
    if (!advModel) return;
    try {
      draft.value = JSON.parse(advModel.getValue()) as Infra3dConfig;
    } catch {
      // Parse error — operator is mid-typing; ignore. Save catches it.
    }
  });
});

// Keep advanced editor synchronised when the structured UI mutates
// draft. We diff to avoid clobbering operator cursor when the
// structured edit is from the editor itself.
watch(
  draft,
  (next) => {
    if (!advEditor || !advModel || !next) return;
    const want = JSON.stringify(next, null, 2);
    if (advModel.getValue() === want) return;
    suppressAdvChange = true;
    advModel.setValue(want);
    suppressAdvChange = false;
  },
  { deep: true },
);

onBeforeUnmount(() => {
  advEditor?.dispose();
  advModel?.dispose();
});

// ── Edge style helpers ────────────────────────────────────────────────
const EDGE_STYLES = ['solid', 'dashed'] as const;
type EdgeStyleKind = (typeof EDGE_STYLES)[number];
function castEdgeStyle(s: string): EdgeStyleKind {
  return s === 'dashed' ? 'dashed' : 'solid';
}

// Quick-stat counts for the section heads.
const stats = computed(() => {
  if (!draft.value) return { layersConfigured: 0, layersOap: 0, layersUnclassified: 0 };
  const oap = (availableLayers.value ?? []).map((l) => l.key.toUpperCase());
  const claimed = new Set<string>();
  for (const lvl of draft.value.levels) for (const k of lvl.layers) claimed.add(k.toUpperCase());
  return {
    layersConfigured: Object.keys(draft.value.layers).length,
    layersOap: oap.length,
    layersUnclassified: oap.filter((k) => !claimed.has(k)).length,
  };
});

function edgeRef(key: 'hierarchy' | 'crossLevelCall' | 'intraCall'): InfraEdgeStyle | null {
  return draft.value?.edges[key] ?? null;
}
</script>

<template>
  <div class="i3d-admin">
    <header class="hd">
      <div class="hd-text">
        <span class="kicker">Dashboard setup · 3D Infra Map</span>
        <h1>3D Infrastructure Map</h1>
        <p class="lede">
          Global config for the <code>/3d/map</code> view. Levels control
          the vertical stack; per-layer color + metrics drive each cube.
          Bundled defaults ship with the BFF; saves shadow them locally and
          take effect on the next visit to the map.
        </p>
      </div>
      <div class="hd-actions">
        <button class="btn" :disabled="saving || !dirty" @click="onDiscard">Discard changes</button>
        <button class="btn" :disabled="saving" @click="onResetBundled">Reset to bundled</button>
        <button class="btn primary" :disabled="!dirty || saving" @click="onSave">
          {{ saving ? 'Saving…' : dirty ? 'Save' : 'Saved' }}
        </button>
      </div>
    </header>

    <div v-if="flash" class="flash" :data-kind="flash.kind">{{ flash.text }}</div>
    <ul v-if="issues.length" class="issues">
      <li v-for="(it, i) in issues" :key="i"><code>{{ it }}</code></li>
    </ul>

    <div v-if="loading" class="loading">Loading config…</div>
    <template v-else-if="draft">
      <!-- ── Global filter ─────────────────────────────────────────── -->
      <section class="sect">
        <header class="sect-head">
          <h2>Global layer filter</h2>
          <span class="sec-hint">JS regex applied before levelling. Default <code>.*</code>.</span>
        </header>
        <div class="sect-body">
          <label class="field">
            <span class="lbl">filter.layer</span>
            <input class="inp mono" v-model="draft.filter.layer" placeholder=".*" />
          </label>
        </div>
      </section>

      <!-- ── Levels ────────────────────────────────────────────────── -->
      <section class="sect">
        <header class="sect-head">
          <h2>Levels (top → bottom)</h2>
          <span class="sec-hint">Each level is one plane on the 3D map. Order = vertical stacking.</span>
          <button type="button" class="btn small" @click="addLevel">+ add level</button>
        </header>
        <div class="sect-body">
          <article
            v-for="(lvl, idx) in levelsSorted"
            :key="lvl.id"
            class="lvl-card"
          >
            <header class="lvl-head">
              <span class="lvl-order">#{{ lvl.order }}</span>
              <input class="inp lvl-id mono" v-model="lvl.id" placeholder="apps" />
              <input class="inp lvl-label" v-model="lvl.label" placeholder="Apps" />
              <div class="lvl-spacer" />
              <button type="button" class="btn tiny" :disabled="idx === 0" @click="moveLevel(idx, -1)">↑</button>
              <button type="button" class="btn tiny" :disabled="idx === levelsSorted.length - 1" @click="moveLevel(idx, 1)">↓</button>
              <button type="button" class="btn tiny danger" @click="removeLevel(lvl.id)">remove</button>
            </header>
            <div class="lvl-body">
              <label class="field">
                <span class="lbl">layerFilter (regex)</span>
                <input class="inp mono" v-model="lvl.layerFilter" placeholder=".*" />
              </label>
              <div class="field">
                <span class="lbl">explicit layers ({{ lvl.layers.length }})</span>
                <div class="chips">
                  <span v-for="k in lvl.layers" :key="k" class="chip">
                    {{ k }}
                    <button class="x" type="button" @click="assignLayerToLevel(k, null)">×</button>
                  </span>
                  <span v-if="lvl.layers.length === 0" class="chips-empty">(none — admit by regex)</span>
                </div>
              </div>
            </div>
          </article>
        </div>
      </section>

      <!-- ── Layers ────────────────────────────────────────────────── -->
      <section class="sect">
        <header class="sect-head">
          <h2>Layers</h2>
          <span class="sec-hint">
            <strong>{{ stats.layersOap }}</strong> OAP · <strong>{{ stats.layersConfigured }}</strong> configured ·
            <strong>{{ stats.layersUnclassified }}</strong> unclassified
          </span>
          <input class="inp search" v-model="layerSearch" placeholder="filter by key…" />
        </header>
        <div class="sect-body">
          <div class="layers-grid">
            <article
              v-for="row in filteredLayerRows"
              :key="row.key"
              class="layer-card"
              :class="{ unclassified: !levelForLayerKey(row.key) }"
            >
              <header class="layer-head" @click="toggleLayerExpand(row.key)">
                <input
                  type="color"
                  class="color-pick"
                  :value="row.spec?.color ?? '#8a8a8a'"
                  @click.stop
                  @input="(e) => (ensureLayerSpec(row.key).color = (e.target as HTMLInputElement).value)"
                />
                <span class="layer-key">{{ row.key }}</span>
                <span v-if="row.group" class="badge muted">{{ row.group }}</span>
                <span v-if="row.hasTopology" class="badge topo">topology</span>
                <span v-if="!row.inOap" class="badge stale">no OAP data</span>
                <span v-if="!row.inConfig" class="badge new">new</span>

                <select
                  class="inp level-pick"
                  :value="levelForLayerKey(row.key) ?? ''"
                  @click.stop
                  @change="(e) => assignLayerToLevel(row.key, (e.target as HTMLSelectElement).value || null)"
                >
                  <option value="">— pick level —</option>
                  <option v-for="lvl in levelsSorted" :key="lvl.id" :value="lvl.id">{{ lvl.label }}</option>
                </select>

                <span class="layer-mqe-summary mono">
                  <template v-if="row.spec?.topology?.server">srv: {{ row.spec.topology.server.mqe.slice(0, 36) }}{{ row.spec.topology.server.mqe.length > 36 ? '…' : '' }}</template>
                  <template v-else-if="row.spec?.load">load: {{ row.spec.load.mqe.slice(0, 36) }}{{ row.spec.load.mqe.length > 36 ? '…' : '' }}</template>
                  <template v-else>—</template>
                </span>

                <button class="btn tiny" type="button" @click.stop="toggleLayerExpand(row.key)">
                  {{ expandedLayers.has(row.key) ? 'collapse' : 'edit' }}
                </button>
              </header>

              <div v-if="expandedLayers.has(row.key)" class="layer-body">
                <div class="field mode-pick">
                  <span class="lbl">metric mode</span>
                  <div class="seg">
                    <button
                      type="button"
                      class="seg-btn"
                      :class="{ on: row.spec?.topology }"
                      @click="setLayerMode(row.key, 'topology')"
                    >topology (server + client)</button>
                    <button
                      type="button"
                      class="seg-btn"
                      :class="{ on: row.spec?.load }"
                      @click="setLayerMode(row.key, 'load')"
                    >single load</button>
                    <button
                      type="button"
                      class="seg-btn"
                      :class="{ on: !row.spec?.topology && !row.spec?.load }"
                      @click="setLayerMode(row.key, 'none')"
                    >no metric</button>
                  </div>
                </div>

                <!-- Topology editor -->
                <template v-if="row.spec?.topology">
                  <div class="mqe-pair">
                    <div class="mqe-half">
                      <div class="half-head">
                        <span class="lbl">server</span>
                        <button
                          v-if="!row.spec.topology.server"
                          class="btn tiny"
                          type="button"
                          @click="ensureTopologyHalf(row.key, 'server')"
                        >+ add</button>
                        <button
                          v-else
                          class="btn tiny danger"
                          type="button"
                          @click="dropTopologyHalf(row.key, 'server')"
                        >remove</button>
                      </div>
                      <template v-if="row.spec.topology.server">
                        <label class="field">
                          <span class="lbl small">MQE</span>
                          <input class="inp mono" v-model="row.spec.topology.server.mqe" />
                        </label>
                        <div class="row-2">
                          <label class="field">
                            <span class="lbl small">label</span>
                            <input class="inp" v-model="row.spec.topology.server.label" />
                          </label>
                          <label class="field">
                            <span class="lbl small">unit</span>
                            <input class="inp" v-model="row.spec.topology.server.unit" />
                          </label>
                        </div>
                      </template>
                    </div>
                    <div class="mqe-half">
                      <div class="half-head">
                        <span class="lbl">client</span>
                        <button
                          v-if="!row.spec.topology.client"
                          class="btn tiny"
                          type="button"
                          @click="ensureTopologyHalf(row.key, 'client')"
                        >+ add</button>
                        <button
                          v-else
                          class="btn tiny danger"
                          type="button"
                          @click="dropTopologyHalf(row.key, 'client')"
                        >remove</button>
                      </div>
                      <template v-if="row.spec.topology.client">
                        <label class="field">
                          <span class="lbl small">MQE</span>
                          <input class="inp mono" v-model="row.spec.topology.client.mqe" />
                        </label>
                        <div class="row-2">
                          <label class="field">
                            <span class="lbl small">label</span>
                            <input class="inp" v-model="row.spec.topology.client.label" />
                          </label>
                          <label class="field">
                            <span class="lbl small">unit</span>
                            <input class="inp" v-model="row.spec.topology.client.unit" />
                          </label>
                        </div>
                      </template>
                    </div>
                  </div>
                  <p class="hint-sm">Server-side preferred at render time; client falls in when server has no data.</p>
                </template>

                <!-- Load editor -->
                <template v-else-if="row.spec?.load">
                  <label class="field">
                    <span class="lbl small">MQE</span>
                    <input class="inp mono" v-model="row.spec.load.mqe" />
                  </label>
                  <div class="row-2">
                    <label class="field">
                      <span class="lbl small">label</span>
                      <input class="inp" v-model="row.spec.load.label" />
                    </label>
                    <label class="field">
                      <span class="lbl small">unit</span>
                      <input class="inp" v-model="row.spec.load.unit" />
                    </label>
                  </div>
                </template>

                <template v-else>
                  <p class="hint-sm">Cube renders without a traffic ring. Choose a mode above to attach an MQE.</p>
                </template>

                <footer class="layer-foot">
                  <button class="btn tiny danger" type="button" @click="removeLayerFromConfig(row.key)">
                    remove layer from config
                  </button>
                </footer>
              </div>
            </article>
            <div v-if="filteredLayerRows.length === 0" class="empty">No layers match the filter.</div>
          </div>
        </div>
      </section>

      <!-- ── Edges ─────────────────────────────────────────────────── -->
      <section class="sect">
        <header class="sect-head">
          <h2>Edge styling</h2>
          <span class="sec-hint">Colors for the three edge classes drawn on the map.</span>
        </header>
        <div class="sect-body edges-grid">
          <article
            v-for="key in (['hierarchy', 'crossLevelCall', 'intraCall'] as const)"
            :key="key"
            class="edge-card"
          >
            <header class="edge-head">
              <span class="edge-name">{{ key }}</span>
            </header>
            <template v-if="edgeRef(key)">
              <label class="field">
                <span class="lbl small">color</span>
                <div class="color-row">
                  <input
                    type="color"
                    class="color-pick"
                    :value="parseHexColor(edgeRef(key)!.color)"
                    @input="(e) => (edgeRef(key)!.color = (e.target as HTMLInputElement).value)"
                  />
                  <input class="inp mono small" v-model="edgeRef(key)!.color" />
                </div>
              </label>
              <label class="field">
                <span class="lbl small">style</span>
                <select
                  class="inp"
                  :value="edgeRef(key)!.style"
                  @change="(e) => (edgeRef(key)!.style = castEdgeStyle((e.target as HTMLSelectElement).value))"
                >
                  <option v-for="s in EDGE_STYLES" :key="s" :value="s">{{ s }}</option>
                </select>
              </label>
              <label class="field row">
                <input type="checkbox" v-model="edgeRef(key)!.arrow" />
                <span class="lbl small">arrow at target</span>
              </label>
            </template>
          </article>
        </div>
      </section>

      <!-- ── Pipeline + Unknown ─────────────────────────────────────── -->
      <section class="sect two-col">
        <div class="col">
          <header class="sect-head"><h2>Loading pipeline</h2></header>
          <div class="sect-body">
            <label class="field">
              <span class="lbl">metricChunkSize</span>
              <!-- Capped at 12: the BFF metrics route (MAX_SERVICES) rejects
                   larger chunks — OAP's GraphQL complexity ceiling 5xx's. -->
              <input type="number" class="inp" v-model.number="draft.pipeline.metricChunkSize" min="1" max="12" />
            </label>
            <label class="field">
              <span class="lbl">topologyConcurrency</span>
              <input type="number" class="inp" v-model.number="draft.pipeline.topologyConcurrency" min="1" max="16" />
            </label>
            <label class="field">
              <span class="lbl">templateConcurrency</span>
              <input type="number" class="inp" v-model.number="draft.pipeline.templateConcurrency" min="1" max="32" />
            </label>
          </div>
        </div>
        <div class="col">
          <header class="sect-head"><h2>Unknown layer fallback</h2></header>
          <div class="sect-body">
            <label class="field">
              <span class="lbl">level</span>
              <select class="inp" v-model="draft.unknownLayer.level">
                <option v-for="lvl in levelsSorted" :key="lvl.id" :value="lvl.id">{{ lvl.label }} ({{ lvl.id }})</option>
              </select>
            </label>
            <label class="field">
              <span class="lbl">badge text</span>
              <input class="inp" v-model="draft.unknownLayer.badge" />
            </label>
          </div>
        </div>
      </section>

      <!-- ── Advanced ──────────────────────────────────────────────── -->
      <section class="sect">
        <header class="sect-head clickable" @click="advancedOpen = !advancedOpen">
          <h2>{{ advancedOpen ? '▾' : '▸' }} Advanced — raw JSON</h2>
          <span class="sec-hint">Edit the full document directly. Two-way bound with the structured editor above.</span>
        </header>
        <div v-show="advancedOpen" class="sect-body">
          <div ref="advHost" class="adv-editor" />
        </div>
      </section>
    </template>
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
.hd-actions { display: flex; gap: 8px; flex: 0 0 auto; }

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
.flash {
  margin: 8px 20px 0;
  padding: 6px 10px;
  font-size: 11.5px;
  border-radius: 4px;
}
.flash[data-kind='ok']  { background: rgba(34, 197, 94, 0.16); color: #4ade80; }
.flash[data-kind='err'] { background: rgba(239, 68, 68, 0.16); color: #f87171; }
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
.sect-head.clickable { cursor: pointer; }
.sect-head h2 { margin: 0; font-size: 12px; color: var(--sw-fg-0); font-weight: 700; letter-spacing: 0.02em; }
.sec-hint    { font-size: 11px; color: var(--sw-fg-3); }
.sec-hint code { background: var(--sw-bg-3); padding: 0 4px; border-radius: 3px; }
.sect-body  { padding: 12px 14px; }
.sect.two-col .sect-body { padding: 0; }
.sect.two-col { display: flex; gap: 12px; padding: 0; background: transparent; border: none; }
.sect.two-col > .col { flex: 1; border: 1px solid var(--sw-line); border-radius: 6px; background: var(--sw-bg-1); }

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

/* Levels */
.lvl-card {
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
.lvl-id    { width: 140px; }
.lvl-label { width: 200px; }
.lvl-spacer { flex: 1; }
.lvl-body  { padding: 8px 10px; }
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

/* Layers */
.layers-grid { display: flex; flex-direction: column; gap: 6px; }
.layer-card {
  border: 1px solid var(--sw-line);
  border-radius: 4px;
  background: var(--sw-bg-2);
}
.layer-card.unclassified { border-color: rgba(239, 158, 68, 0.5); }
.layer-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  cursor: pointer;
}
.color-pick {
  width: 24px;
  height: 20px;
  padding: 0;
  border: 1px solid var(--sw-line-2);
  border-radius: 3px;
  background: transparent;
  cursor: pointer;
}
.layer-key {
  font-family: var(--sw-mono-font, monospace);
  font-size: 11.5px;
  font-weight: 600;
  color: var(--sw-fg-0);
  min-width: 160px;
}
.badge {
  font-size: 9.5px;
  letter-spacing: 0.04em;
  padding: 1px 6px;
  border-radius: 8px;
  text-transform: uppercase;
}
.badge.muted { background: var(--sw-bg-3); color: var(--sw-fg-3); }
.badge.topo  { background: rgba(94, 177, 191, 0.2); color: #5eb1bf; }
.badge.stale { background: rgba(239, 158, 68, 0.18); color: #f0a04b; }
.badge.new   { background: rgba(94, 234, 212, 0.16); color: #5eead4; }
.level-pick { min-width: 160px; }
.layer-mqe-summary {
  flex: 1;
  font-size: 10.5px;
  color: var(--sw-fg-3);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.layer-body {
  padding: 10px 12px;
  border-top: 1px solid var(--sw-line);
  background: var(--sw-bg-1);
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.mode-pick { flex-direction: row; align-items: center; gap: 8px; }
.seg { display: inline-flex; border: 1px solid var(--sw-line-2); border-radius: 4px; overflow: hidden; }
.seg-btn {
  height: 22px;
  padding: 0 10px;
  background: var(--sw-bg-2);
  border: none;
  border-right: 1px solid var(--sw-line-2);
  color: var(--sw-fg-2);
  font-size: 10.5px;
  cursor: pointer;
}
.seg-btn:last-child { border-right: none; }
.seg-btn.on { background: var(--sw-accent); color: #1a1106; }
.row-2 { display: flex; gap: 8px; }
.row-2 .field { flex: 1; }
.mqe-pair { display: flex; gap: 10px; }
.mqe-half {
  flex: 1;
  padding: 8px;
  border: 1px solid var(--sw-line);
  border-radius: 4px;
  background: var(--sw-bg-2);
}
.half-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; }
.hint-sm { font-size: 10.5px; color: var(--sw-fg-3); margin: 0; }
.layer-foot { display: flex; justify-content: flex-end; padding-top: 4px; border-top: 1px dashed var(--sw-line); }
.empty { padding: 14px; text-align: center; color: var(--sw-fg-3); font-size: 11.5px; }

/* Edges */
.edges-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
.edge-card {
  border: 1px solid var(--sw-line);
  border-radius: 4px;
  background: var(--sw-bg-2);
  padding: 8px 10px;
}
.edge-head .edge-name {
  font-family: var(--sw-mono-font, monospace);
  font-size: 11px;
  color: var(--sw-fg-1);
}
.color-row { display: flex; align-items: center; gap: 6px; }

/* Advanced */
.adv-editor { width: 100%; height: 360px; border: 1px solid var(--sw-line); border-radius: 4px; overflow: hidden; }
</style>
