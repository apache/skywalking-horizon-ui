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
  Picks WHICH page of the active component the canvas edits, and creates,
  renames and deletes them.

  It is not an ordering control. Where a page sits in the layer's menu is
  decided in the live menu preview; putting order here too would give the
  operator two places to answer the same question.
-->
<script setup lang="ts">
import { computed, ref, nextTick } from 'vue';
import { useI18n } from 'vue-i18n';
import { isBuiltInLayerRow } from '@skywalking-horizon-ui/api-client';
import type { AdminExtPage } from '@/api/client';
import { extPageIdIssue, suggestPageId, MAX_EXT_PAGES } from './useExtPages';
import { MAX_EXT_PAGE_ID_LENGTH, MAX_EXT_PAGE_NAME_LENGTH } from '@skywalking-horizon-ui/api-client';

const props = defineProps<{
  pages: readonly AdminExtPage[];
  activePage: string | null;
  canAdd: boolean;
  /** Service pages only: the filter field appears, with a live count
   *  against this roster. Empty while the roster is still loading, which
   *  shows an unavailable count rather than blocking the edit. */
  /** Label of the component whose pages these are — the DEFAULT entry
   *  shows it, so the operator reads "Service · DEFAULT". */
  scopeLabel: string;
  readOnly?: boolean;
}>();
const emit = defineEmits<{
  (e: 'select', id: string | null): void;
  (e: 'add', v: { id: string; name: string }): void;
  (e: 'rename', v: { id: string; name: string }): void;
  (e: 'delete', id: string): void;
}>();

const { t } = useI18n();

const adding = ref(false);
const draftName = ref('');
const draftId = ref('');
/** True once the operator edits the id, after which the name stops
 *  seeding it — otherwise typing the name would overwrite their id. */
const idTouched = ref(false);
const nameInput = ref<HTMLInputElement | null>(null);
const renamingId = ref<string | null>(null);
const renameValue = ref('');

const takenIds = computed(() => props.pages.map((p) => p.id));
/** The name seeds the id until the operator types one. The id is asked
 *  for at creation and then frozen: it is the route segment, the
 *  `menuOrder` entry and the translation anchor, so a later rename must
 *  not move it. */
const effectiveId = computed(() =>
  idTouched.value ? draftId.value.trim() : suggestPageId(draftName.value, takenIds.value, isBuiltInLayerRow),
);
const addIssue = computed<string | null>(() => {
  const name = draftName.value.trim();
  if (name === '') return t('Give the page a name.');
  if (name.length > MAX_EXT_PAGE_NAME_LENGTH) {
    return t('A name is at most {n} characters.', { n: MAX_EXT_PAGE_NAME_LENGTH });
  }
  if (effectiveId.value === '') return t('Give the page an id.');
  if (effectiveId.value.length > MAX_EXT_PAGE_ID_LENGTH) {
    return t('An id is at most {n} characters.', { n: MAX_EXT_PAGE_ID_LENGTH });
  }
  const issue = extPageIdIssue(effectiveId.value, takenIds.value, isBuiltInLayerRow);
  if (issue === 'duplicate') return t('That id is already used by another page.');
  if (issue === 'reserved') return t('That id is a built-in menu entry — pick another.');
  if (issue) return t('An id uses lowercase letters, digits and dashes.');
  return null;
});

/** Legal, so it does not block the add — but the id is derived from the
 *  name, so a repeat quietly becomes `<id>-2` and the two are told apart
 *  only by that. Worth saying before it is created, not after. */
const nameClash = computed<boolean>(() => {
  const n = draftName.value.trim().toLowerCase();
  return n !== '' && props.pages.some((p) => p.name.trim().toLowerCase() === n);
});

async function startAdd(): Promise<void> {
  adding.value = true;
  draftName.value = '';
  draftId.value = '';
  idTouched.value = false;
  await nextTick();
  nameInput.value?.focus();
}
function confirmAdd(): void {
  if (addIssue.value) return;
  emit('add', { id: effectiveId.value, name: draftName.value.trim() });
  adding.value = false;
  draftName.value = '';
  draftId.value = '';
  idTouched.value = false;
}

function startRenameActive(): void {
  const p = props.pages.find((x) => x.id === props.activePage);
  if (!p) return;
  renamingId.value = p.id;
  renameValue.value = p.name;
}
/** The same bounds the Add form holds. Rename accepted anything, and the
 *  draft was then refused at save by a message about ids. */
const renameIssue = computed<string | null>(() => {
  const name = renameValue.value.trim();
  if (name === '') return t('Give the page a name.');
  if (name.length > MAX_EXT_PAGE_NAME_LENGTH) {
    return t('A name is at most {n} characters.', { n: MAX_EXT_PAGE_NAME_LENGTH });
  }
  return null;
});
function commitRename(): void {
  const id = renamingId.value;
  // Keep the field open on a bad value rather than silently discarding
  // the edit — blur commits, and a dropped rename reads as a dead control.
  if (renameIssue.value) return;
  if (id) emit('rename', { id, name: renameValue.value.trim() });
  renamingId.value = null;
}
</script>

<template>
  <div class="page-bar">
    <span class="page-bar-label">{{ t('Page') }}</span>

    <!-- A select, not chips: the plan asked for one, and a component may
         carry twelve pages — a chip row wraps and pushes the canvas down,
         while a select stays one line and names the current page even when
         two pages share a display name. -->
    <select
      class="page-select"
      :aria-label="t('Page')"
      :value="activePage ?? ''"
      @change="emit('select', ($event.target as HTMLSelectElement).value || null)"
    >
      <option value="">{{ scopeLabel }} — {{ t('DEFAULT') }}</option>
      <!-- Name AND id: duplicate names are legal because identity is the
           id, which leaves two pages called "Detail" indistinguishable
           without it. The runtime sidebar stays name-only — an operator
           reading the menu never picked the id. -->
      <option v-for="p in pages" :key="p.id" :value="p.id">{{ p.name }} ({{ p.id }})</option>
    </select>

    <!-- With the default page selected, Rename and Delete are simply
         absent. Say why: their absence reads as a bug or as a page not
         fully loaded, and the reason is worth knowing — the default page
         IS the component's own grid, so removing it would leave the
         component with no dashboard at all. -->
    <span v-if="!activePage" class="page-default-tip">
      {{ t('The default page is the component’s own grid — it cannot be renamed or removed. Add a page to create one that can.') }}
    </span>

    <template v-if="activePage && !readOnly">
      <input
        v-if="renamingId === activePage"
        v-model="renameValue"
        class="page-rename"
        type="text"
        :aria-label="t('Page name')"
        @keyup.enter="commitRename"
        @keyup.esc="renamingId = null"
        @blur="commitRename"
      />
      <span v-if="renamingId === activePage && renameIssue" class="page-issue">{{ renameIssue }}</span>
      <button v-else-if="renamingId !== activePage" type="button" class="sw-btn xs ghost" @click="startRenameActive">
        {{ t('Rename') }}
      </button>
      <button type="button" class="sw-btn xs ghost" :title="t('Delete this page')" @click="emit('delete', activePage)">
        {{ t('Delete') }}
      </button>
    </template>

    <template v-if="!readOnly">
      <span v-if="adding" class="page-add-form">
        <input
          ref="nameInput"
          v-model="draftName"
          class="page-rename"
          type="text"
          :placeholder="t('Page name')"
          :aria-label="t('Page name')"
          @keyup.enter="confirmAdd"
          @keyup.esc="adding = false"
        />
        <span class="page-id-field">
          <span class="page-id-slash">/</span>
          <input
            :value="effectiveId"
            class="page-id-input"
            type="text"
            :placeholder="t('page-id')"
            :aria-label="t('Page id')"
            @input="idTouched = true; draftId = ($event.target as HTMLInputElement).value"
            @keyup.enter="confirmAdd"
            @keyup.esc="adding = false"
          />
        </span>
        <button type="button" class="sw-btn xs" :disabled="!!addIssue" @click="confirmAdd">
          {{ t('Add') }}
        </button>
        <button type="button" class="sw-btn xs ghost" @click="adding = false">{{ t('Cancel') }}</button>
        <span v-if="addIssue && draftName" class="page-issue">{{ addIssue }}</span>
        <span v-else-if="nameClash" class="page-warn">
          {{ t('Another page already has this name — rename one, or they are told apart only by id.') }}
        </span>
      </span>
      <button
        v-else-if="canAdd"
        type="button"
        class="page-chip add"
        :title="t('Add a page to this component')"
        @click="startAdd"
      >+ {{ t('Page') }}</button>
      <span v-else class="page-cap">{{ t('{n} page maximum', { n: MAX_EXT_PAGES }) }}</span>
    </template>

  </div>
</template>

<style scoped>
.page-bar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  padding: 2px 10px 0;
}
.page-bar-label {
  font-size: 10.5px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--sw-fg-2);
  margin-right: 2px;
}
.page-default-tip {
  font-size: 11px;
  color: var(--sw-fg-3);
  line-height: 1.4;
}
.page-select {
  padding: 3px 8px;
  border: 1px solid var(--sw-line-2);
  border-radius: 5px;
  background: var(--sw-bg-2);
  color: var(--sw-fg-0);
  font-size: 11.5px;
  max-width: 260px;
}
.page-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 9px;
  border: 1px solid var(--sw-line-2);
  border-radius: 999px;
  background: transparent;
  color: var(--sw-fg-1);
  font-size: 11.5px;
  font-weight: 500;
  cursor: pointer;
}
.page-chip:hover {
  color: var(--sw-fg-0);
  border-color: var(--sw-line-1);
}
.page-chip.on {
  background: rgba(249, 115, 22, 0.12);
  border-color: var(--sw-accent);
  color: var(--sw-fg-0);
  font-weight: 600;
}
.page-chip.add {
  border-style: dashed;
  color: var(--sw-fg-2);
}
.default-tag {
  font-size: 9px;
  letter-spacing: 0.06em;
  color: var(--sw-fg-3);
  border: 1px solid var(--sw-line-2);
  border-radius: 3px;
  padding: 0 3px;
}
.page-chip.on .default-tag {
  color: var(--sw-fg-1);
}
.page-del {
  display: inline-flex;
  opacity: 0.7;
}
.page-del:hover {
  opacity: 1;
  color: var(--sw-err);
}
.page-add-form {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.page-rename {
  padding: 3px 8px;
  border: 1px solid var(--sw-accent);
  border-radius: 999px;
  background: var(--sw-bg-2);
  color: var(--sw-fg-0);
  font-size: 11.5px;
  min-width: 140px;
}
.page-issue {
  font-size: 10.5px;
  color: var(--sw-warn);
}
.page-id-field {
  display: inline-flex;
  align-items: center;
  gap: 2px;
}
.page-id-slash { font-family: var(--sw-mono); font-size: 11px; color: var(--sw-fg-3); }
.page-id-input {
  padding: 3px 8px;
  border: 1px solid var(--sw-accent);
  border-radius: 999px;
  background: var(--sw-bg-2);
  color: var(--sw-fg-0);
  font-size: 11.5px;
  width: 150px;
  font-family: var(--sw-mono);
}
.page-warn {
  font-size: 10.5px;
  color: var(--sw-warn);
}
.page-cap {
  font-size: 10.5px;
  color: var(--sw-fg-3);
}
</style>
