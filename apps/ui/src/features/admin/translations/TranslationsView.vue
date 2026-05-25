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
  Translations page — `/admin/translations`. One screen per template:
  picker on top (overview + layer rows), preview on the left, EN→target
  editor on the right. Save embeds the operator's draft into the
  template's configuration as a sibling `i18n[<locale>]` block and
  pushes via templateSync.save — same path as the other template
  editors, including the visibility-confirm + 504 / refetch chain.

  Templates source: useTemplateSources (per kind) gives us the raw
  envelope content, so we read the English source from either remote
  (if previously pushed) or bundled. The editor strips the existing
  `i18n` block off the source it walks, and treats it as the current
  overlay state. Save merges new edits onto that.
-->
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useTemplateSources } from '@/features/admin/_shared/useTemplateSources';
import TranslationEditor from '@/features/admin/_shared/TranslationEditor.vue';
import TranslationPreview from './TranslationPreview.vue';
import SyncStatusBanner from '@/features/admin/_shared/SyncStatusBanner.vue';
import { useTemplateSync } from '@/features/admin/_shared/useTemplateSync';
import { bff, BffApiError } from '@/api/client';
import { refreshConfigBundle } from '@/controls/configBundle';
import {
  walkTranslatable,
  setAtPath,
  getAtPath,
} from '@/features/admin/_shared/translatableFields';
import type { AdminLayerTemplate } from '@/api/client';
import type { OverviewDashboard } from '@skywalking-horizon-ui/api-client';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const overviewSources = useTemplateSources('overview');
const layerSources = useTemplateSources('layer');
const sync = useTemplateSync({ kind: 'layer' });

interface PickerEntry {
  /** Wire name, e.g. `horizon.overview.services`. */
  name: string;
  kind: 'overview' | 'layer';
  /** Short display name. */
  label: string;
  /** Original-key tag shown alongside. */
  key: string;
}

const entries = computed<PickerEntry[]>(() => {
  const out: PickerEntry[] = [];
  for (const name of overviewSources.remoteNames()) {
    const content = overviewSources.remote<OverviewDashboard>(name);
    if (!content) continue;
    out.push({ name, kind: 'overview', label: content.title || content.id, key: content.id });
  }
  // Bundled-only entries the operator may not have pushed yet.
  for (const name of bundledOverviewNames.value) {
    if (out.some((e) => e.name === name)) continue;
    const content = overviewSources.bundled<OverviewDashboard>(name);
    if (!content) continue;
    out.push({ name, kind: 'overview', label: content.title || content.id, key: content.id });
  }
  for (const name of layerNames.value) {
    const content =
      layerSources.remote<AdminLayerTemplate>(name) ??
      layerSources.bundled<AdminLayerTemplate>(name);
    if (!content) continue;
    out.push({ name, kind: 'layer', label: content.alias || content.key, key: content.key });
  }
  out.sort((a, b) => (a.kind === b.kind ? a.label.localeCompare(b.label) : a.kind.localeCompare(b.kind)));
  return out;
});

// The remoteNames helper only returns OAP-present names; bundled
// overviews / layers that haven't been pushed yet have to be enumerated
// from elsewhere. We pull them from the sync-status row list filtered
// by kind + non-null bundled.
const bundledOverviewNames = computed<string[]>(() => {
  const s = sync.status.value;
  if (!s) return [];
  return s.badges.filter((b) => b.kind === 'overview').map((b) => b.name);
});
const layerNames = computed<string[]>(() => {
  const s = sync.status.value;
  if (!s) return [];
  return s.badges.filter((b) => b.kind === 'layer').map((b) => b.name);
});

const selectedName = ref<string>('');
const selectedKind = ref<'overview' | 'layer'>('overview');
const scope = ref<'service' | 'instance' | 'endpoint'>('service');

watch(entries, (list) => {
  if (selectedName.value) return;
  const first = list[0];
  if (first) {
    selectedName.value = first.name;
    selectedKind.value = first.kind;
  }
});

function onPick(name: string): void {
  const e = entries.value.find((x) => x.name === name);
  if (!e) return;
  selectedName.value = e.name;
  selectedKind.value = e.kind;
}

/** Effective source content for the selected template — remote if
 *  pushed, otherwise bundled. With the embedded `i18n` block split off
 *  separately so the editor's walker sees only the source structure. */
const effective = computed(() => {
  const name = selectedName.value;
  const kind = selectedKind.value;
  if (!name) return null;
  const sources = kind === 'overview' ? overviewSources : layerSources;
  const raw = sources.remote<Record<string, unknown>>(name) ?? sources.bundled<Record<string, unknown>>(name);
  if (!raw) return null;
  const { i18n, ...rest } = raw as { i18n?: Record<string, unknown> };
  return { source: rest, i18n: i18n ?? {} };
});

/** Operator's in-progress overlay state — { locale: pathString → translation }.
 *  Drives the editor (right pane) AND the preview's localized rendering
 *  (left pane). Persists per-template-per-locale until the operator
 *  picks a different template or saves. */
const draft = ref<Record<string, Record<string, string>>>({});

function draftKey(name: string): string {
  return name;
}

watch(
  effective,
  (eff) => {
    if (!eff) return;
    const k = draftKey(selectedName.value);
    if (draft.value[k]) return;
    // Seed the draft from the existing embedded i18n so the editor
    // starts populated with whatever's already saved.
    const fields = walkTranslatable(eff.source);
    const seed: Record<string, Record<string, string>> = {};
    for (const [loc, overlay] of Object.entries(eff.i18n)) {
      seed[loc] = {};
      for (const f of fields) {
        const v = getAtPath(overlay, f.segments);
        if (v !== undefined) seed[loc][f.path] = v;
      }
    }
    draft.value = { ...draft.value, [k]: Object.assign({}, ...Object.entries(seed).map(([loc, v]) => ({ [loc]: v }))) as Record<string, Record<string, string>>[] as unknown as Record<string, string> };
    // Reset to the cleaner shape: { locale: { path: value } }
    draft.value[k] = seed as unknown as Record<string, string>;
  },
  { immediate: true, deep: false },
);

const target = ref<string>('zh-CN');

/** Merged i18n map for the selected template, including the operator's
 *  in-progress edits. Used both by the preview (to localize the source)
 *  and by Save (to embed back into content.i18n). */
const mergedI18n = computed<Record<string, unknown>>(() => {
  const eff = effective.value;
  if (!eff) return {};
  const fields = walkTranslatable(eff.source);
  const out: Record<string, unknown> = {};
  const localeMap = (draft.value[draftKey(selectedName.value)] ?? {}) as unknown as Record<string, Record<string, string>>;
  for (const [loc, m] of Object.entries(localeMap)) {
    const overlay: Record<string, unknown> = {};
    for (const f of fields) {
      const v = m[f.path];
      if (v && v.length > 0) setAtPath(overlay, f.segments, v);
    }
    if (Object.keys(overlay).length > 0) out[loc] = overlay;
  }
  return out;
});

/** The localized source as the preview should render it. Applies the
 *  current target overlay to the source. */
const localizedSource = computed<unknown>(() => {
  const eff = effective.value;
  if (!eff) return null;
  const overlay = mergedI18n.value[target.value];
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

const saveMsg = ref<string | null>(null);
const saving = ref(false);

/** When the operator clicks a widget in the preview pane, this drops
 *  the field-path prefix that selects its translatable rows. The
 *  editor highlights matches and scrolls the first one into view. */
const focusPrefix = ref<string | null>(null);

function onSelectWidget(widgetId: string): void {
  const eff = effective.value;
  if (!eff) return;
  // `header:<metric>` — clicked a service-header column. The translatable
  // rows for it sit under `header.columns[N].label`.
  if (widgetId.startsWith('header:')) {
    const metric = widgetId.slice('header:'.length);
    const layer = eff.source as AdminLayerTemplate;
    const idx = (layer.metrics?.columns ?? []).findIndex((c) => c.metric === metric);
    if (idx >= 0) focusPrefix.value = `metrics.columns[${idx}]`;
    return;
  }
  if (selectedKind.value === 'overview') {
    const dash = eff.source as { widgets?: Array<{ id?: string }> };
    const idx = (dash.widgets ?? []).findIndex((w) => w.id === widgetId);
    if (idx >= 0) focusPrefix.value = `widgets[${idx}]`;
    return;
  }
  // Layer: look up the widget inside dashboards[scope].
  const tpl = eff.source as AdminLayerTemplate & { dashboards?: Record<string, Array<{ id?: string }>> };
  const list = tpl.dashboards?.[scope.value] ?? tpl.widgets ?? [];
  const idx = list.findIndex((w) => w.id === widgetId);
  if (idx >= 0) {
    focusPrefix.value = tpl.dashboards
      ? `dashboards.${scope.value}[${idx}]`
      : `widgets[${idx}]`;
  }
}

async function onSaveFromEditor(next: Record<string, unknown>): Promise<void> {
  // Editor emits the whole i18n map after its own merge. Splice into
  // the draft state so the preview reflects what was just saved.
  const k = draftKey(selectedName.value);
  const flat = draft.value[k] ?? {};
  // Sync the editor's incoming map back into our locale draft state.
  const eff = effective.value;
  if (!eff) return;
  const fields = walkTranslatable(eff.source);
  const updated = { ...(flat as unknown as Record<string, Record<string, string>>) };
  for (const [loc, overlay] of Object.entries(next)) {
    const m: Record<string, string> = {};
    for (const f of fields) {
      const v = getAtPath(overlay, f.segments);
      if (v !== undefined) m[f.path] = v;
    }
    if (Object.keys(m).length > 0) updated[loc] = m;
    else delete updated[loc];
  }
  draft.value = { ...draft.value, [k]: updated as unknown as Record<string, string> };

  // Push to OAP — merge the new i18n block into the source content and
  // save via templateSync, reusing the visibility-confirm + 504 chain
  // every other template save uses.
  if (saving.value) return;
  saving.value = true;
  saveMsg.value = 'Saving to OAP…';
  let elapsed = 0;
  const ticker = setInterval(() => {
    elapsed++;
    saveMsg.value = `Saving to OAP… ${elapsed}s`;
  }, 1000);
  try {
    const content = { ...eff.source, i18n: next };
    await bff.templateSync.save(selectedName.value, content);
    clearInterval(ticker);
    for (let n = 10; n > 0; n--) {
      saveMsg.value = `Saved. Refreshing in ${n}s…`;
      await sleep(1000);
    }
    await bff.templateSync.resync();
    await Promise.all([
      overviewSources.refetch(),
      layerSources.refetch(),
      refreshConfigBundle({ force: true }),
    ]);
    saveMsg.value = 'Translations published — live on the next render.';
    setTimeout(() => (saveMsg.value = null), 6000);
  } catch (err) {
    clearInterval(ticker);
    if (err instanceof BffApiError && err.status === 504) {
      saveMsg.value = 'Timeout waiting for OAP propagation. Refetching…';
      try {
        await bff.templateSync.resync();
        await Promise.all([
          overviewSources.refetch(),
          layerSources.refetch(),
          refreshConfigBundle({ force: true }),
        ]);
      } catch {
        /* refetch best-effort */
      }
      saveMsg.value = 'Refetched after timeout — verify the row on OAP.';
      setTimeout(() => (saveMsg.value = null), 10000);
    } else {
      saveMsg.value = err instanceof Error ? `Save failed: ${err.message}` : 'Save failed';
    }
  } finally {
    saving.value = false;
  }
}

/** Current target-locale overlay (the editor's input map for `target`). */
const editorI18n = computed<Record<string, unknown>>(() => mergedI18n.value);

const localized = computed<{ overview?: OverviewDashboard; layer?: AdminLayerTemplate }>(() => {
  const src = localizedSource.value;
  if (!src) return {};
  if (selectedKind.value === 'overview') return { overview: src as OverviewDashboard };
  return { layer: src as AdminLayerTemplate };
});
</script>

<template>
  <div class="tv">
    <header class="tv__head">
      <div>
        <div class="tv__kicker">Dashboard setup · Translations</div>
        <h1>Translations</h1>
        <p class="tv__lede">
          Pick a template, pick a target language, type translations in the right pane. The
          left pane shows the picked template rendered in the target language. Saves are
          embedded into the template's <code>configuration.i18n[locale]</code> block on OAP
          — the runtime localizer merges them on every render.
        </p>
      </div>
    </header>

    <SyncStatusBanner :banner="sync.banner.value" />

    <div class="tv__picker">
      <label>
        <span>Template</span>
        <select
          :value="selectedName"
          :disabled="sync.readOnly.value"
          @change="onPick(($event.target as HTMLSelectElement).value)"
        >
          <option v-for="e in entries" :key="e.name" :value="e.name">
            [{{ e.kind }}] {{ e.label }} — {{ e.key }}
          </option>
        </select>
      </label>
      <label v-if="selectedKind === 'layer'">
        <span>Scope</span>
        <select v-model="scope" :disabled="sync.readOnly.value">
          <option value="service">Service</option>
          <option value="instance">Instance</option>
          <option value="endpoint">Endpoint</option>
        </select>
      </label>
      <span v-if="saveMsg" class="tv__msg">{{ saveMsg }}</span>
    </div>

    <div v-if="!effective" class="tv__empty">No translatable templates found.</div>

    <div v-else class="tv__split">
      <div class="tv__pane tv__pane--preview">
        <div class="tv__pane-head">Live preview ({{ target }}) · click a widget to focus its translation row</div>
        <TranslationPreview
          :kind="selectedKind"
          :overview="localized.overview"
          :layer="localized.layer"
          :scope="scope"
          @select-widget="onSelectWidget"
        />
      </div>
      <div class="tv__pane tv__pane--editor">
        <div class="tv__pane-head">EN → {{ target }}</div>
        <TranslationEditor
          :source="effective.source"
          :i18n="editorI18n"
          :saving="saving"
          :focus-prefix="focusPrefix ?? undefined"
          @save="onSaveFromEditor"
        />
      </div>
    </div>
  </div>
</template>

<style scoped>
.tv { padding: 16px 20px 40px; display: flex; flex-direction: column; gap: 12px; max-width: 1600px; margin: 0 auto; height: 100%; min-height: 0; }
.tv__head h1 { margin: 2px 0 4px; font-size: 20px; color: var(--sw-fg-0); }
.tv__kicker { font-size: 10.5px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--sw-warn); }
.tv__lede { margin: 0; max-width: 880px; font-size: 12.5px; line-height: 1.55; color: var(--sw-fg-2); }
.tv__lede code { font-family: var(--sw-mono); font-size: 11.5px; }

.tv__picker {
  display: flex; align-items: center; gap: 14px; flex-wrap: wrap;
  padding: 8px 12px; background: var(--sw-bg-1); border: 1px solid var(--sw-line-2); border-radius: 6px;
}
.tv__picker label { display: inline-flex; align-items: center; gap: 6px; font-size: 11.5px; color: var(--sw-fg-3); }
.tv__picker select {
  background: var(--sw-bg-2); color: var(--sw-fg-1);
  border: 1px solid var(--sw-line-2); border-radius: 4px;
  padding: 3px 6px; font-size: 12px; min-width: 260px;
}
.tv__msg { margin-left: auto; font-size: 12px; color: var(--sw-fg-2); }

.tv__empty { padding: 60px 20px; text-align: center; color: var(--sw-fg-3); font-size: 13px; }

.tv__split {
  flex: 1 1 auto; min-height: 0;
  display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 12px;
}
.tv__pane {
  display: flex; flex-direction: column; min-height: 0;
  border: 1px solid var(--sw-line-2); border-radius: 6px;
  background: var(--sw-bg-0); overflow: hidden;
}
.tv__pane-head {
  padding: 6px 12px;
  border-bottom: 1px solid var(--sw-line-2);
  font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--sw-fg-3);
  background: var(--sw-bg-1);
}
.tv__pane--preview > :nth-child(2) { flex: 1 1 auto; min-height: 0; }
.tv__pane--editor { padding-bottom: 8px; }
.tv__pane--editor > :nth-child(2) { flex: 1 1 auto; min-height: 0; padding: 8px 10px; overflow: hidden; }
</style>
