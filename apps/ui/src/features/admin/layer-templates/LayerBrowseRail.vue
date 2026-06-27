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
  Layer browse surface — two mutually-exclusive presentations of the same
  filtered layer list, toggled by `layerListOpen`:
    - expanded → the pinned left rail (<aside>), a sticky column of rows;
    - collapsed → the compact dropdown switcher at the top of the editor.
  Both share one browse state (free-text search + the diverged / local /
  not-configured filters + the filtered list), which lives HERE so the two
  surfaces filter identically. The count-zero guard watches that auto-uncheck
  a filter the moment its set empties travel with that state — without them an
  operator who reset / pushed the last matching row would be stranded on an
  empty picker with a disabled checkbox and no way back.

  Stateless about layer content: the row predicates (badge / diverged /
  unconfigured / local-draft) and the counts arrive as props; the selection +
  open flag are two-way models; the dropdown's refresh button emits `refresh`.
-->
<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import type { AdminLayerTemplate } from '@/api/client';
import type { TemplateStatus } from '@/api/scopes/configs';
import TemplateStatusBadge from '@/features/admin/_shared/TemplateStatusBadge.vue';

const selectedKey = defineModel<string>('selectedKey', { required: true });
const layerListOpen = defineModel<boolean>('layerListOpen', { required: true });

const props = defineProps<{
  templates: AdminLayerTemplate[];
  // The live draft of the selected layer — the collapsed switcher button
  // reads its alias / colour / key so an unsaved alias edit shows there
  // immediately (the rows below come from the saved `templates`).
  selectedTpl: AdminLayerTemplate | null;
  divergedCount: number;
  localCount: number;
  unconfiguredCount: number;
  refreshing: boolean;
  readOnly: boolean;
  badgeFor: (name: string) => TemplateStatus | null;
  isDiverged: (key: string) => boolean;
  isUnconfigured: (key: string) => boolean;
  hasLocalDraftFor: (key: string) => boolean;
}>();
const emit = defineEmits<{ refresh: [] }>();

/** Free-text filter for the layers rail — matches alias or key. */
const layerSearch = ref('');
// When on, the list shows only layers whose bundled copy differs from
// OAP (diverged) or isn't on OAP yet (bundled-fallback) — i.e. the set
// "Sync all to OAP" would push. Off shows every layer.
const divergedOnly = ref(false);
const localOnly = ref(false);
const unconfiguredOnly = ref(false);

// Auto-uncheck the picker filter whenever its underlying set goes to
// zero. Without this the operator can hit Reset / Push / Sync — which
// drops the matching row out of the filter — and then be stranded on
// an empty picker with no way to navigate to another layer (the
// filter checkbox would also be disabled since divergedCount === 0).
// Catches every path that depletes the set, not just reset.
watch(() => props.divergedCount, (n) => { if (n === 0) divergedOnly.value = false; });
watch(() => props.localCount, (n) => { if (n === 0) localOnly.value = false; });
watch(() => props.unconfiguredCount, (n) => { if (n === 0) unconfiguredOnly.value = false; });

const filteredTemplates = computed<AdminLayerTemplate[]>(() => {
  const q = layerSearch.value.trim().toLowerCase();
  return props.templates.filter((t) => {
    if (divergedOnly.value && !props.isDiverged(t.key)) return false;
    if (localOnly.value && !props.hasLocalDraftFor(t.key)) return false;
    if (unconfiguredOnly.value && !props.isUnconfigured(t.key)) return false;
    if (!q) return true;
    return (t.alias ?? '').toLowerCase().includes(q) || t.key.toLowerCase().includes(q);
  });
});

/** Rail click: switch layer and collapse the rail so the editor reclaims
 *  the full width (subsequent switching uses the top dropdown). */
function selectLayer(key: string): void {
  selectedKey.value = key;
  layerListOpen.value = false;
}

/** Collapsed-mode switcher dropdown — same search + filter as the rail
 *  (not a native <select>). */
const layerDropdownOpen = ref(false);
function pickFromDropdown(key: string): void {
  selectedKey.value = key;
  layerDropdownOpen.value = false;
}
</script>

<template>
  <!-- Browse rail. Shown only while expanded; selecting a layer
       collapses it so the editor claims the full width. Once
       collapsed, layer switching moves to the top dropdown inside
       the detail pane (no left zone consumed). -->
  <aside v-if="layerListOpen" class="sw-card layer-list">
    <div class="list-head">
      <button
        class="list-toggle"
        type="button"
        title="Collapse the layers list"
        @click="layerListOpen = false"
      >
        <span class="caret open">›</span>
      </button>
      <h4>Layers</h4>
      <span class="sub">
        {{ layerSearch.trim()
          ? `${filteredTemplates.length} / ${templates.length}`
          : `${templates.length} template${templates.length === 1 ? '' : 's'}` }}
      </span>
    </div>
    <div class="list-search">
      <input
        v-model="layerSearch"
        type="text"
        class="list-search-input"
        placeholder="Search layers…"
        autocomplete="off"
        spellcheck="false"
      />
    </div>
    <div class="dd-filters">
      <label class="diverged-filter" :class="{ on: divergedOnly }" :title="divergedCount === 0 ? 'No layers differ from OAP' : `${divergedCount} layer(s) differ from the OAP-stored copy`">
        <input v-model="divergedOnly" type="checkbox" :disabled="divergedCount === 0" />
        Diverged<span v-if="divergedCount" class="diverged-count">{{ divergedCount }}</span>
      </label>
      <label class="diverged-filter local" :class="{ on: localOnly }" :title="localCount === 0 ? 'No unpublished local drafts in this browser' : `${localCount} layer(s) with an unpublished local draft`">
        <input v-model="localOnly" type="checkbox" :disabled="localCount === 0" />
        Local<span v-if="localCount" class="diverged-count local">{{ localCount }}</span>
      </label>
      <label class="diverged-filter unconfigured" :class="{ on: unconfiguredOnly }" :title="unconfiguredCount === 0 ? 'Every reported layer has a dashboard template' : `${unconfiguredCount} layer(s) reported by OAP with no dashboard template yet`">
        <input v-model="unconfiguredOnly" type="checkbox" :disabled="unconfiguredCount === 0" />
        Not configured<span v-if="unconfiguredCount" class="diverged-count">{{ unconfiguredCount }}</span>
      </label>
    </div>
    <button
      v-for="t in filteredTemplates"
      :key="t.key"
      class="layer-row"
      :class="{ active: selectedKey === t.key }"
      @click="selectLayer(t.key)"
    >
      <span class="dot" :style="{ background: t.color || 'var(--sw-fg-3)' }" />
      <span class="name">{{ t.alias || t.key }}</span>
      <code v-if="t.alias && t.alias !== t.key" class="key-tag">{{ t.key }}</code>
      <span v-if="hasLocalDraftFor(t.key)" class="local-badge" title="Unpublished local draft">local</span>
      <TemplateStatusBadge :status="badgeFor(`horizon.layer.${t.key}`)" />
    </button>
    <p v-if="filteredTemplates.length === 0" class="list-empty">
      {{ divergedOnly && !layerSearch.trim() ? 'No layers differ from OAP.' : `No layers match “${layerSearch}”.` }}
    </p>
  </aside>

  <!-- Collapsed-rail layer switcher: a filterable dropdown at the
       top of the editor so the left zone stays free. Same search +
       filter as the rail (not a native select). -->
  <div v-else-if="selectedTpl" class="layer-switch-bar">
      <div class="layer-dd">
        <button
          class="layer-dd-btn"
          type="button"
          @click="layerDropdownOpen = !layerDropdownOpen"
        >
        <span class="dot inline" :style="{ background: selectedTpl.color || 'var(--sw-fg-3)' }" />
        <span class="layer-dd-name">{{ selectedTpl.alias || selectedTpl.key }}</span>
        <code v-if="selectedTpl.alias && selectedTpl.alias !== selectedTpl.key" class="key-tag">{{ selectedTpl.key }}</code>
        <span v-if="hasLocalDraftFor(selectedTpl.key)" class="local-badge" title="Unpublished local draft in this browser">local</span>
        <TemplateStatusBadge :status="badgeFor(`horizon.layer.${selectedTpl.key}`)" />
        <span class="caret dd-caret" :class="{ open: layerDropdownOpen }">›</span>
      </button>
      <template v-if="layerDropdownOpen">
        <div class="layer-dd-backdrop" @click="layerDropdownOpen = false" />
        <div class="layer-dd-pop sw-card">
          <div class="list-search">
            <input
              v-model="layerSearch"
              type="text"
              class="list-search-input"
              placeholder="Search layers…"
              autocomplete="off"
              spellcheck="false"
            />
          </div>
          <div class="dd-filters">
            <label class="diverged-filter" :class="{ on: divergedOnly }" :title="divergedCount === 0 ? 'No layers differ from OAP' : `${divergedCount} layer(s) differ from the OAP-stored copy`">
              <input v-model="divergedOnly" type="checkbox" :disabled="divergedCount === 0" />
              Diverged<span v-if="divergedCount" class="diverged-count">{{ divergedCount }}</span>
            </label>
            <label class="diverged-filter local" :class="{ on: localOnly }" :title="localCount === 0 ? 'No unpublished local drafts in this browser' : `${localCount} layer(s) with an unpublished local draft`">
              <input v-model="localOnly" type="checkbox" :disabled="localCount === 0" />
              Local<span v-if="localCount" class="diverged-count local">{{ localCount }}</span>
            </label>
            <label class="diverged-filter unconfigured" :class="{ on: unconfiguredOnly }" :title="unconfiguredCount === 0 ? 'Every reported layer has a dashboard template' : `${unconfiguredCount} layer(s) reported by OAP with no dashboard template yet`">
              <input v-model="unconfiguredOnly" type="checkbox" :disabled="unconfiguredCount === 0" />
              Not configured<span v-if="unconfiguredCount" class="diverged-count">{{ unconfiguredCount }}</span>
            </label>
          </div>
          <div class="layer-dd-list">
            <button
              v-for="t in filteredTemplates"
              :key="t.key"
              class="layer-row"
              :class="{ active: selectedKey === t.key }"
              @click="pickFromDropdown(t.key)"
            >
              <span class="dot" :style="{ background: t.color || 'var(--sw-fg-3)' }" />
              <span class="name">{{ t.alias || t.key }}</span>
              <code v-if="t.alias && t.alias !== t.key" class="key-tag">{{ t.key }}</code>
              <span v-if="hasLocalDraftFor(t.key)" class="local-badge" title="Unpublished local draft">local</span>
              <TemplateStatusBadge :status="badgeFor(`horizon.layer.${t.key}`)" />
            </button>
            <p v-if="filteredTemplates.length === 0" class="list-empty">
              {{ divergedOnly && !layerSearch.trim() ? 'No layers differ from OAP.' : `No layers match “${layerSearch}”.` }}
            </p>
          </div>
          <div class="layer-dd-foot">
            <span class="sub">{{ templates.length }} layer{{ templates.length === 1 ? '' : 's' }}</span>
            <button
              type="button"
              class="sw-btn refresh-btn"
              :disabled="refreshing || readOnly"
              :title="readOnly
                ? 'OAP unreachable — cannot refresh'
                : 'Force the BFF to re-read every UI-template from OAP (clears the 30s cache)'"
              @click="emit('refresh')"
            >{{ refreshing ? 'refreshing…' : 'refresh from remote' }}</button>
          </div>
        </div>
      </template>
      </div>
  </div>
</template>

<style scoped>
/* Layer browse rail + collapsed switcher (duplicated scoped; .sw-card /
   .sw-btn are global; .dot.inline / .key-tag / .local-badge are shared
   chips the parent keeps its own copy of). */
.layer-list {
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  align-self: start;
  position: sticky;
  top: 16px;
}
.list-toggle {
  flex: 0 0 auto;
  width: 22px;
  height: 22px;
  margin-right: 4px;
  background: transparent;
  border: none;
  color: var(--sw-fg-3);
  cursor: pointer;
  font: inherit;
  border-radius: 3px;
  display: inline-grid;
  place-items: center;
}
.list-toggle:hover {
  background: var(--sw-bg-2);
  color: var(--sw-fg-1);
}
.list-toggle .caret {
  display: inline-block;
  font-size: 13px;
  line-height: 1;
  transition: transform 0.15s;
}
.list-toggle .caret.open {
  transform: rotate(90deg);
}
/* Collapsed-rail layer switcher — a compact dropdown bar at the top of
   the editor pane so layer switching costs no left-zone width. */
.layer-switch-bar {
  display: flex;
  align-items: center;
  gap: 8px;
}
.layer-switch-bar .list-toggle {
  margin-right: 0;
}
.layer-switch-bar .caret {
  display: inline-block;
  font-size: 13px;
  line-height: 1;
}
/* Filterable layer dropdown — same search + rows as the pinned rail.
   The sole layer switcher (no separate expand toggle). */
.layer-dd { position: relative; display: flex; }
.layer-dd-btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  height: 30px;
  padding: 0 10px;
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line-2);
  border-radius: 6px;
  color: var(--sw-fg-0);
  font: inherit;
  font-size: 12px;
  font-weight: 600;
  min-width: 200px;
  cursor: pointer;
}
.layer-dd-btn:hover { background: var(--sw-bg-3); }
.layer-dd-name {
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dd-caret {
  margin-left: auto;
  transform: rotate(90deg);
  transition: transform 0.15s;
}
.dd-caret.open { transform: rotate(-90deg); }
.layer-dd-backdrop {
  position: fixed;
  inset: 0;
  z-index: 40;
}
.layer-dd-pop {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  z-index: 41;
  /* Wide enough to read alias + key + badge on one line per row. */
  width: min(80vw, 760px);
  max-height: 360px;
  display: flex;
  flex-direction: column;
  padding: 8px 0;
  box-shadow: 0 12px 32px -8px rgba(0, 0, 0, 0.5);
}
.layer-dd-pop .list-search { padding: 0 10px 8px; }
.layer-dd-list {
  overflow-y: auto;
  padding: 0 6px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.layer-dd-foot {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border-top: 1px solid var(--sw-line-2);
}
.layer-dd-foot .sub {
  font-size: 10.5px;
  color: var(--sw-fg-3);
}
.layer-dd-foot .refresh-btn {
  margin-left: auto;
  font-size: 11px;
  height: 24px;
  padding: 0 8px;
}
.list-head {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 10px 10px;
  border-bottom: 1px solid var(--sw-line);
  margin-bottom: 6px;
}
.list-head h4 {
  margin: 0;
  font-size: 11.5px;
  font-weight: 600;
  color: var(--sw-fg-0);
}
.list-head .sub {
  font-size: 10px;
  color: var(--sw-fg-3);
  margin-left: auto;
}
.list-search {
  padding: 0 10px 8px;
}
.list-search-input {
  width: 100%;
  box-sizing: border-box;
  background: var(--sw-bg-1);
  border: 1px solid var(--sw-line-2);
  border-radius: 5px;
  color: var(--sw-fg-0);
  font: inherit;
  font-size: 11.5px;
  padding: 5px 8px;
}
.list-search-input:focus {
  outline: none;
  border-color: var(--sw-accent);
}
/* Diverged / Local filters, co-located with the search inside the layer
   picker (rail + dropdown), same as the overview dashboards admin —
   keeps filter + selector + count read as one connected control instead
   of floating in a separate page-level row. */
.dd-filters {
  display: flex;
  gap: 14px;
  padding: 0 10px 8px;
  margin-bottom: 6px;
  border-bottom: 1px solid var(--sw-line);
}
.layer-dd-pop .dd-filters { padding: 0 10px 8px; }
.diverged-filter {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  color: var(--sw-fg-2);
  cursor: pointer;
  user-select: none;
}
.diverged-filter input:disabled { cursor: not-allowed; }
.diverged-filter.on { color: var(--sw-fg-0); }
.diverged-count {
  margin-left: 2px;
  padding: 0 5px;
  border-radius: 8px;
  background: var(--sw-warn, var(--sw-accent));
  color: #1a1a1a;
  font-size: 10px;
  font-weight: 700;
}
.list-empty {
  padding: 8px 10px;
  font-size: 11px;
  color: var(--sw-fg-3);
}
.layer-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  border-radius: 5px;
  background: transparent;
  border: none;
  color: var(--sw-fg-1);
  font-size: 12px;
  cursor: pointer;
  text-align: left;
  font: inherit;
}
.layer-row:hover { background: var(--sw-bg-2); }
.layer-row.active {
  background: var(--sw-bg-3);
  color: var(--sw-fg-0);
  box-shadow: inset 2px 0 0 var(--sw-accent);
}
.layer-row .dot {
  width: 7px; height: 7px;
  border-radius: 50%;
  flex: 0 0 7px;
}
.layer-row .name {
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dot.inline {
  width: 12px; height: 12px;
  border-radius: 50%;
  display: inline-block;
}
/* Dim mono chip for the raw layer key, shown next to the alias so the
 * operator sees both the display name and the OAP layer identity. */
.key-tag {
  flex: 0 0 auto;
  font-family: var(--sw-mono);
  font-size: 9.5px;
  letter-spacing: 0.02em;
  color: var(--sw-fg-3);
  background: var(--sw-bg-2);
  padding: 1px 5px;
  border-radius: 3px;
}
/* Amber "local" chip — surfaces an unpublished local browser draft in the
 * picker (the sync badge only reflects bundled-vs-remote). */
.local-badge {
  flex: 0 0 auto;
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: #1a1a1a;
  background: var(--sw-warn, #f59e0b);
  padding: 1px 6px;
  border-radius: 8px;
}
</style>
