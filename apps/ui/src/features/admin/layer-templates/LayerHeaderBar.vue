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
  Layer identity / action header — the selected layer's name + key + sync
  status, the Disable / Reactivate control, the source pill (local / bundled /
  remote), Export / Import, the Reset-to and Preview dropdowns, Publish + Save,
  the flash message, and the sidebar-placement (public / operate) toggle.

  Purely presentational: every piece of state arrives as a prop and every
  mutation leaves as an emit — the parent keeps owning the draft and the
  template-store wiring. The two source-picker dropdowns are the only local
  state (open/closed), since their open flag is cosmetic.
-->
<script setup lang="ts">
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { AdminLayerTemplate } from '@/api/client';
import type { TemplateStatus } from '@/api/scopes/configs';
import TemplateStatusBadge from '@/features/admin/_shared/TemplateStatusBadge.vue';

type EditorSource = 'local' | 'bundled' | 'remote';

defineProps<{
  selectedTpl: AdminLayerTemplate;
  badge: TemplateStatus | null;
  readOnly: boolean;
  hasLocalDraft: boolean;
  isLayerDisabled: boolean;
  isSaving: boolean;
  remoteAvailable: boolean;
  bundledExists: boolean;
  sourcesReady: boolean;
  editorSource: EditorSource;
  canExport: boolean;
  isSynced: boolean;
  localDiffersFromRemote: boolean;
  dirty: boolean;
  editorDiffersFromRemote: boolean;
  saveMsg: string | null;
}>();
const emit = defineEmits<{
  reactivate: [];
  delete: [];
  export: [];
  import: [];
  reset: [src: 'bundled' | 'remote'];
  preview: [src: EditorSource];
  push: [];
  save: [];
  'set-visibility': [v: 'public' | 'operate'];
}>();

const { t } = useI18n();

// The two source-picker dropdowns own only their open flag — the picked
// source leaves as a `reset` / `preview` emit.
const resetDropdownOpen = ref(false);
const previewDropdownOpen = ref(false);
function reset(src: 'bundled' | 'remote'): void {
  emit('reset', src);
  resetDropdownOpen.value = false;
}
function preview(src: EditorSource): void {
  emit('preview', src);
  previewDropdownOpen.value = false;
}
</script>

<template>
  <section class="sw-card identity-card">
    <div class="identity-row">
      <span class="dot inline" :style="{ background: selectedTpl.color || 'var(--sw-fg-3)' }" />
      <!-- Single-line identity: Layer: <name> <key> <local> <status>. -->
      <div class="identity-title">
        <span class="identity-label">Layer:</span>
        <h2>{{ selectedTpl.alias || selectedTpl.key }}</h2>
        <code>{{ selectedTpl.key }}</code>
        <!-- Same sync status the picker shows, so the editor and the
             dropdown agree (e.g. both read DISABLED, not one BUNDLED). -->
        <span v-if="hasLocalDraft" class="local-badge" title="Unpublished local draft in this browser">local</span>
        <TemplateStatusBadge :status="badge" />
      </div>
      <!-- Disable / Reactivate. Sits by the title, away from the
           save/push cluster. A disabled layer offers Reactivate
           (re-enable on OAP); otherwise Disable/Delete. -->
      <div class="identity-delete">
        <button
          v-if="isLayerDisabled"
          class="sw-btn"
          type="button"
          :disabled="isSaving || readOnly"
          :title="readOnly
            ? 'OAP unreachable — cannot reactivate'
            : `Reactivate the ${selectedTpl.key} layer (re-enable on OAP)`"
          @click="emit('reactivate')"
        >
          Reactivate
        </button>
        <button
          v-else
          class="sw-btn danger"
          type="button"
          :disabled="isSaving || (readOnly && (remoteAvailable || bundledExists))"
          :title="(readOnly && (remoteAvailable || bundledExists))
            ? 'OAP unreachable — cannot delete'
            : bundledExists
              ? `Disable the built-in ${selectedTpl.key} layer (hidden from the sidebar; Reactivate to bring it back)`
              : remoteAvailable
                ? `Delete the ${selectedTpl.key} layer template (soft-disabled on OAP)`
                : `Remove the local draft for ${selectedTpl.key}`"
          @click="emit('delete')"
        >
          {{ bundledExists ? 'Disable' : 'Delete' }}
        </button>
      </div>
      <div class="actions">
        <!-- Source pill — three visible states, one per
             `editorSource`. The pill is gated on
             `sourcesReady` to suppress the flash on initial
             load: until the config-bundle settles we can't tell
             whether the row is remote-backed or bundled-only,
             so showing anything is a guess that flips moments
             later. Once the bundle resolves the right pill
             renders directly. -->
        <span
          v-if="sourcesReady && editorSource === 'local'"
          class="src-tag is-local"
          :title="t('Unpublished local edits — Push to publish to OAP.')"
        >{{ t('from local') }}</span>
        <span
          v-else-if="sourcesReady && editorSource === 'bundled'"
          class="src-tag is-bundled"
          :title="t('Showing the shipped bundled default — Push to overwrite OAP with bundled.')"
        >{{ t('from bundled') }}</span>
        <span
          v-else-if="sourcesReady && editorSource === 'remote'"
          class="src-tag is-remote"
          :title="t('Showing the OAP-live version. End users render the same bytes.')"
        >{{ t('from remote') }}</span>
        <!-- Export the in-use version to a file; import a file as a
             local draft for the layer it names. -->
        <button
          class="sw-btn"
          type="button"
          :disabled="!canExport"
          :title="canExport
            ? 'Download the in-use version (live on OAP, or the bundled default) as a JSON file.'
            : 'Nothing to export yet.'"
          @click="emit('export')"
        >Export</button>
        <button
          class="sw-btn"
          type="button"
          title="Import a layer dashboard JSON file as a local draft — preview, then publish."
          @click="emit('import')"
        >Import</button>
        <div class="reset-dd">
          <button class="sw-btn" type="button" @click="resetDropdownOpen = !resetDropdownOpen">
            Reset to <span class="caret" :class="{ open: resetDropdownOpen }">›</span>
          </button>
          <template v-if="resetDropdownOpen">
            <div class="reset-dd-backdrop" @click="resetDropdownOpen = false" />
            <div class="reset-dd-pop">
              <!-- "Reset to → Bundled" stays visible even when
                   the row is synced (bundled === remote). The
                   button is disabled in that case with a
                   "(synced)" tail so the operator can tell the
                   option still exists but there's nothing
                   meaningful to reset to — Bundled equals what
                   Remote would already give them. -->
              <button
                class="reset-dd-item"
                type="button"
                :disabled="isSynced"
                :title="isSynced
                  ? t('Bundled equals OAP-live for this row — nothing to reset to.')
                  : t('Discard current edits and reload the bundled (shipped) default.')"
                @click="reset('bundled')"
              >
                {{ t('Bundled') }}<span v-if="isSynced" class="reset-dd-suffix"> {{ t('(synced)') }}</span>
              </button>
              <button
                class="reset-dd-item"
                type="button"
                :disabled="!remoteAvailable"
                :title="remoteAvailable ? t('Discard current edits and reload OAP\'s live version.') : t('OAP has no copy of this template yet.')"
                @click="reset('remote')"
              >
                {{ t('Remote') }}
              </button>
            </div>
          </template>
        </div>
        <div class="reset-dd">
          <button class="sw-btn" type="button" @click="previewDropdownOpen = !previewDropdownOpen">
            Preview <span class="caret" :class="{ open: previewDropdownOpen }">›</span>
          </button>
          <template v-if="previewDropdownOpen">
            <div class="reset-dd-backdrop" @click="previewDropdownOpen = false" />
            <div class="reset-dd-pop">
              <button class="reset-dd-item" type="button" :disabled="!hasLocalDraft" title="Preview your unpublished local draft." @click="preview('local')">Local</button>
              <button v-if="!isSynced" class="reset-dd-item" type="button" title="Preview the bundled (shipped) default." @click="preview('bundled')">Bundled</button>
              <button class="reset-dd-item" type="button" :disabled="!remoteAvailable" title="Preview OAP's live version." @click="preview('remote')">Remote</button>
            </div>
          </template>
        </div>
        <!-- Publish local → remote. Enabled only when local differs
             from remote; click shows the diff before pushing. -->
        <button
          v-if="!readOnly"
          class="sw-btn"
          type="button"
          :disabled="!localDiffersFromRemote || isSaving"
          :title="localDiffersFromRemote ? 'Review the local → remote diff, then publish to OAP.' : 'No local changes to publish — local matches remote.'"
          @click="emit('push')"
        >
          Check diff &amp; push
        </button>
        <button
          class="sw-btn is-primary"
          type="button"
          :disabled="(!dirty && !editorDiffersFromRemote) || isSaving"
          title="Save the editor to your browser (local). Publish later with “Push local → OAP”."
          @click="emit('save')"
        >
          {{ isSaving ? 'Saving…' : 'Save (local)' }}
        </button>
      </div>
    </div>
    <!-- Own row so a long flash never overlaps the action cluster. -->
    <div v-if="saveMsg" class="save-msg-row">
      <span class="save-msg">{{ saveMsg }}</span>
    </div>
    <!-- Sidebar placement: `public` (default) → regular Layers
         section. `operate` → operations block (alongside Cluster,
         DSL Management, etc.). Use for layers that an operator
         manages but a regular UI user doesn't need surfaced
         next to user-facing application layers — self-obs
         (OAP / Satellite / agent self-obs) is the canonical
         example. -->
    <div class="visibility-row">
      <label class="vis-label">Sidebar placement</label>
      <div class="vis-options">
        <label
          class="vis-opt"
          :class="{ on: (selectedTpl.visibility ?? 'public') === 'public' }"
        >
          <input
            type="radio"
            name="visibility"
            value="public"
            :checked="(selectedTpl.visibility ?? 'public') === 'public'"
            @change="emit('set-visibility', 'public')"
          />
          <span class="vis-opt-body">
            <span class="vis-opt-title">Public</span>
            <span class="vis-opt-hint">Shows in the user-facing Layers section</span>
          </span>
        </label>
        <label
          class="vis-opt"
          :class="{ on: selectedTpl.visibility === 'operate' }"
        >
          <input
            type="radio"
            name="visibility"
            value="operate"
            :checked="selectedTpl.visibility === 'operate'"
            @change="emit('set-visibility', 'operate')"
          />
          <span class="vis-opt-body">
            <span class="vis-opt-title">Operate</span>
            <span class="vis-opt-hint">Shows in the operations / self-observability section</span>
          </span>
        </label>
      </div>
    </div>
  </section>
</template>

<style scoped>
/* Layer identity / action header (duplicated scoped; .sw-card / .sw-btn are
   global). .dot.inline / .key-tag / .local-badge are shared chips — the
   parent keeps its own copy. */
.identity-card {
  padding: 12px 16px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.identity-row {
  display: flex;
  align-items: center;
  gap: 14px;
}
.identity-row h2 {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  color: var(--sw-fg-0);
}
/* Single-line identity strip: label + name + key + badges all inline. */
.identity-title {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: nowrap;
  min-width: 0;
}
.identity-label {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--sw-fg-3);
  font-weight: 600;
}
.identity-title h2 { white-space: nowrap; }
.identity-title code {
  font-family: var(--sw-mono);
  font-size: 10.5px;
  background: var(--sw-bg-2);
  padding: 1px 6px;
  border-radius: 3px;
  color: var(--sw-fg-1);
}
.identity-delete { display: flex; align-items: center; gap: 8px; }
.dot.inline {
  width: 12px; height: 12px;
  border-radius: 50%;
  display: inline-block;
}
/* Amber "local" chip — surfaces an unpublished local browser draft. */
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
.actions {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 8px;
}
.actions .sw-btn { font-size: 11.5px; }
.actions .sw-btn[disabled] { opacity: 0.4; pointer-events: none; }
/* Source pill — per-state theme matched across all three editors
 * (Layer Dashboards, Overview Templates, Translations):
 *   local   → warn  : unpublished edits, action recommended
 *   bundled → info  : informational (showing disk default)
 *   remote  → dim   : canonical baseline, quiet
 * Geometry stays from the original `.src-tag` so widget metrics
 * don't shift; only colour swaps per modifier class. */
.src-tag {
  font-size: var(--sw-fs-xs);
  font-weight: var(--sw-fw-semibold);
  text-transform: uppercase;
  letter-spacing: var(--sw-ls-caps);
  border-radius: 4px;
  padding: 2px 7px;
}
.src-tag.is-local   { color: var(--sw-warn); background: var(--sw-warn-soft); border: 1px solid transparent; }
.src-tag.is-bundled { color: var(--sw-info); background: var(--sw-info-soft); border: 1px solid transparent; }
.src-tag.is-remote  { color: var(--sw-fg-3); background: var(--sw-bg-2);     border: 1px solid var(--sw-line-2); }
/* "Reset to ▾" merged dropdown (Bundled / Remote sources). */
.reset-dd { position: relative; display: inline-flex; }
.reset-dd .caret { display: inline-block; transform: rotate(90deg); font-size: 11px; }
.reset-dd .caret.open { transform: rotate(-90deg); }
.reset-dd-backdrop { position: fixed; inset: 0; z-index: 40; }
.reset-dd-pop {
  position: absolute;
  top: calc(100% + 4px);
  right: 0;
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
.save-msg-row { display: flex; justify-content: flex-end; }
.save-msg {
  font-size: 11px;
  color: var(--sw-ok);
}
.visibility-row {
  display: flex; align-items: center; gap: 16px;
  padding: 12px 0 0;
  margin-top: 10px;
  border-top: 1px dashed var(--sw-line);
}
.vis-label {
  font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.08em;
  color: var(--sw-fg-3); flex: 0 0 auto;
}
.vis-options { display: flex; gap: 10px; flex: 1; flex-wrap: wrap; }
.vis-opt {
  display: flex; align-items: flex-start; gap: 8px;
  padding: 8px 12px;
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line-2);
  border-radius: 5px;
  cursor: pointer; user-select: none;
  min-width: 220px;
}
.vis-opt:hover { background: var(--sw-bg-3); }
.vis-opt.on {
  background: var(--sw-accent-soft);
  border-color: var(--sw-accent-line, var(--sw-accent));
}
.vis-opt input { margin-top: 2px; accent-color: var(--sw-accent); }
.vis-opt-body { display: flex; flex-direction: column; gap: 2px; }
.vis-opt-title { font-size: 12px; font-weight: 600; color: var(--sw-fg-0); }
.vis-opt.on .vis-opt-title { color: var(--sw-accent-2); }
.vis-opt-hint { font-size: 10.5px; color: var(--sw-fg-3); line-height: 1.4; }
</style>
