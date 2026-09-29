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
  Alarm pages admin. The default page (`horizon.alert.default`, the /alarms
  page) and any number of named pages (`horizon.alert.<id>`, each at
  /alarms/<id> and in the sidebar), every one a set of pinned tiles over the
  alarms the reader may read. A page arranges tiles; it never grants access.
  Saves go straight to OAP, as they always have on this page.
-->
<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { ALERT_DEFAULT_PAGE_ID } from '@skywalking-horizon-ui/api-client';
import { ALARMS_WINDOW_OPTIONS } from '@/api/client';
import { useLayers } from '@/shell/useLayers';
import { canonicalLayerKey } from '@/state/verbGrammar';
import SyncStatusBanner from '@/features/admin/_shared/SyncStatusBanner.vue';
import TemplateDiffModal from '@/features/admin/_shared/TemplateDiffModal.vue';
import { useTemplateSync } from '@/features/admin/_shared/useTemplateSync';
import AlertPageList from './AlertPageList.vue';
import AlertPageEditor from './AlertPageEditor.vue';
import NewAlertPageModal from './NewAlertPageModal.vue';
import DeleteAlertPageModal from './DeleteAlertPageModal.vue';
import { alertRowName, pageNotServed, type AlertPageListItem, type NamedAlertPage } from './alertPages';
import { useAlertPageEditor } from './useAlertPageEditor';

const { t } = useI18n({ useScope: 'global' });

const sync = useTemplateSync({ kind: 'alert' });
const ed = useAlertPageEditor(sync.readOnly);

// Every layer the menu knows, whether or not it has services now: a pin is
// configuration, and a layer that is quiet today still gets alarms tomorrow.
// A layer split by service group is offered under its base key, where the
// group is chosen instead.
const layersList = useLayers();
const knownLayerKeys = computed<string[]>(() =>
  [...new Set(layersList.layers.value.map((l) => canonicalLayerKey(l.key.split('~', 1)[0]!)))].sort(),
);

// Read-only has two causes, and "OAP unreachable" is the wrong answer for
// the permission one — it sends the operator to check a server that is fine.
const readOnlyReason = computed<string>(() =>
  sync.lacksWriteVerb.value
    ? t('You can view this configuration but not change it.')
    : t('OAP unreachable — page is read-only'),
);

const unreadable = computed<Set<string>>(
  () => new Set((sync.status.value?.unreadable ?? []).filter((u) => u.kind === 'alert').map((u) => u.name)),
);
function notServed(p: NamedAlertPage): boolean {
  return pageNotServed(p) || unreadable.value.has(alertRowName(p.id));
}

const listItems = computed<AlertPageListItem[]>(() => {
  const items: AlertPageListItem[] = [
    {
      id: ALERT_DEFAULT_PAGE_ID,
      label: t('Alarms (default)'),
      path: '/alarms',
      tag: null,
      dirty: ed.isDirty(ALERT_DEFAULT_PAGE_ID),
    },
  ];
  for (const p of ed.named.value) {
    items.push({
      id: p.id,
      label: p.title.trim() || p.id,
      path: `/alarms/${p.id}`,
      tag: notServed(p) ? t('not served') : null,
      dirty: ed.isDirty(p.id),
    });
  }
  if (ed.pending.value) {
    items.push({ id: ed.pending.value.id, label: ed.pending.value.title, path: null, tag: t('not saved'), dirty: false });
  }
  return items;
});

const listNote = computed<string | null>(() => {
  if (ed.rowsQ.isError.value) {
    const err = ed.rowsQ.error.value;
    return t('Could not read the named pages: {msg}', { msg: err instanceof Error ? err.message : String(err) });
  }
  if (ed.rowsQ.data.value?.unreachable) return t('OAP is unreachable, so the named pages cannot be listed.');
  return null;
});

const createBlocked = computed<string | null>(() => {
  if (sync.readOnly.value) return readOnlyReason.value;
  if (ed.pending.value) return t('Save or discard the new page first.');
  return null;
});

const inheritedWindowMs = computed<number>(() => ed.configQ.data.value?.defaultWindowMs ?? ALARMS_WINDOW_OPTIONS[0]);

const loading = computed<boolean>(() =>
  ed.isDefault.value ? ed.configQ.isPending.value : ed.rowsQ.isPending.value && !ed.isPending.value,
);

const conflictBanner = computed(() => sync.conflictBannerFor(alertRowName(ed.selectedId.value)));

const newOpen = ref(false);
function onCreate(page: { id: string; title: string }): void {
  ed.create(page);
  newOpen.value = false;
}

// The page the dialog was opened for. The selection moves to the default
// page while a delete finishes, and the dialog must not follow it.
const deleteTarget = ref<{ id: string; title: string } | null>(null);
function openDelete(): void {
  deleteTarget.value = { id: ed.selectedId.value, title: ed.selectedNamed.value?.title || ed.selectedId.value };
}
async function onConfirmDelete(): Promise<void> {
  if (deleteTarget.value && (await ed.remove(deleteTarget.value.id))) deleteTarget.value = null;
}

// Diff & reset compares the stored default page with the one this build
// ships; named pages ship nothing to compare with.
const defaultDiverged = computed<boolean>(
  () => ed.isDefault.value && sync.badgeFor(alertRowName(ALERT_DEFAULT_PAGE_ID)) === 'diverged',
);
const diffModalOpen = ref(false);
async function onDiffReset(): Promise<void> {
  if (await ed.afterReset()) ed.setFlash(t('OAP reset to bundled · reload to see header changes'));
  else ed.setFlash(t('Reset, but the stored page could not be read back, so this page may still show the old values. Reload before editing again.'), 'err');
}

const statusText = computed<{ text: string; cls: string }>(() => {
  const f = ed.flash.value;
  if (f) return { text: f.text, cls: f.kind === 'err' ? 'aps__flash aps__flash--err' : 'aps__flash' };
  if (ed.isPending.value) return { text: t('not saved'), cls: 'aps__dirty' };
  if (ed.isDirty(ed.selectedId.value)) return { text: t('unsaved changes'), cls: 'aps__dirty' };
  const page = ed.selectedNamed.value;
  if (page && notServed(page)) return { text: t('not served'), cls: 'aps__dirty' };
  return { text: t('saved'), cls: 'aps__clean' };
});
</script>

<template>
  <div class="aps">
    <header class="aps__head">
      <div class="aps__kicker">{{ t('Dashboard setup · Alarm pages') }}</div>
      <h1>{{ t('Alarm pages') }}</h1>
      <p class="aps__lede">
        <i18n-t keypath="The default page is {alarms}. Each named page is an extra sidebar entry that lists only the alarms its pins cover." tag="span" scope="global">
          <template #alarms><RouterLink to="/alarms">{{ t('Alarms') }}</RouterLink></template>
        </i18n-t>
        {{ ' ' }}
        {{ t('Which alarms a reader may see is decided by their alarms:read grant alone. The default page shows all of them; a named page shows only those its pins cover, and is listed only for readers who reach at least one of its pins.') }}
      </p>
    </header>

    <SyncStatusBanner :banner="sync.banner.value" />

    <div class="aps__body">
      <AlertPageList
        :items="listItems"
        :selected="ed.selectedId.value"
        :create-blocked="createBlocked"
        :note="listNote"
        @select="ed.select"
        @create="newOpen = true"
      />

      <div class="aps__main">
        <SyncStatusBanner v-if="conflictBanner" :banner="conflictBanner" />
        <div v-if="loading" class="aps__empty">{{ t('loading…') }}</div>
        <div v-else-if="!ed.draft.value" class="aps__empty">{{ t('This page is no longer stored on OAP.') }}</div>
        <AlertPageEditor
          v-else
          :key="ed.selectedId.value"
          :page-id="ed.selectedId.value"
          :is-default="ed.isDefault.value"
          :is-new="ed.isPending.value"
          :draft="ed.draft.value"
          :problems="ed.problems.value"
          :known-layers="knownLayerKeys"
          :read-only="sync.readOnly.value || ed.busy.value"
          :inherited-window-ms="inheritedWindowMs"
          @update="ed.update"
        />

        <div class="aps__actions">
          <span :class="statusText.cls">{{ statusText.text }}</span>
          <button
            v-if="ed.isPending.value"
            type="button"
            class="aps__btn"
            :disabled="ed.busy.value"
            @click="ed.discardPending"
          >{{ t('discard') }}</button>
          <button
            v-else-if="!ed.isDefault.value"
            type="button"
            class="aps__btn aps__btn--danger"
            :disabled="sync.readOnly.value || ed.busy.value"
            :title="sync.readOnly.value ? readOnlyReason : ''"
            @click="openDelete"
          >{{ t('delete') }}</button>
          <button
            type="button"
            class="aps__btn"
            :disabled="!ed.isDirty(ed.selectedId.value) || ed.busy.value || sync.readOnly.value"
            @click="ed.reset"
          >{{ t('reset') }}</button>
          <button
            v-if="defaultDiverged"
            type="button"
            class="aps__btn"
            :title="t('Show side-by-side diff vs OAP, and reset OAP back to bundled (with confirmation).')"
            @click="diffModalOpen = true"
          >{{ t('show diff & reset') }}</button>
          <button
            type="button"
            class="aps__btn aps__btn--primary"
            :disabled="!ed.canSave.value"
            :title="sync.readOnly.value ? readOnlyReason : ''"
            @click="ed.save"
          >{{ ed.saving.value ? t('saving…') : sync.readOnly.value ? t('read-only') : t('save to OAP') }}</button>
        </div>
      </div>
    </div>

    <NewAlertPageModal
      :open="newOpen"
      :taken="ed.taken.value"
      :read-only="sync.readOnly.value"
      @close="newOpen = false"
      @create="onCreate"
    />
    <DeleteAlertPageModal
      :open="deleteTarget !== null"
      :page-id="deleteTarget?.id ?? ''"
      :title="deleteTarget?.title ?? ''"
      :busy="ed.deleting.value"
      :read-only="sync.readOnly.value"
      @close="deleteTarget = null"
      @confirm="onConfirmDelete"
    />
    <TemplateDiffModal
      :open="diffModalOpen"
      :name="alertRowName(ALERT_DEFAULT_PAGE_ID)"
      :confirm-key="ALERT_DEFAULT_PAGE_ID"
      :read-only="sync.readOnly.value"
      @close="diffModalOpen = false"
      @reset="onDiffReset"
    />
  </div>
</template>

<style scoped>
.aps {
  padding: 20px 20px 60px;
  max-width: 1280px;
  margin: 0 auto;
}
.aps__head {
  margin-bottom: 18px;
}
/* Accent-coloured, unlike `.sw-uplabel`: a branded crumb above the page
 * title, matching the other Dashboard setup pages. */
.aps__kicker {
  font-size: var(--sw-fs-xs);
  font-weight: var(--sw-fw-semibold);
  text-transform: uppercase;
  letter-spacing: var(--sw-ls-caps);
  color: var(--sw-accent);
  margin-bottom: 4px;
}
.aps h1 {
  font-size: var(--sw-fs-2xl);
  font-weight: var(--sw-fw-semibold);
  letter-spacing: -0.02em;
  color: var(--sw-fg-0);
  margin: 0 0 8px;
}
.aps__lede {
  font-size: 12.5px;
  color: var(--sw-fg-1);
  line-height: 1.5;
  margin: 0;
  max-width: 820px;
}
.aps__lede a {
  color: var(--sw-accent);
  text-decoration: none;
}
.aps__lede a:hover {
  text-decoration: underline;
}
.aps__body {
  display: grid;
  grid-template-columns: 240px minmax(0, 1fr);
  gap: 14px;
  margin-top: 14px;
}
@media (max-width: 760px) {
  .aps__body { grid-template-columns: minmax(0, 1fr); }
}
.aps__main {
  min-width: 0;
}
.aps__empty {
  padding: 24px;
  text-align: center;
  color: var(--sw-fg-3);
  font-size: var(--sw-fs-base);
}
.aps__actions {
  display: flex;
  align-items: center;
  gap: 10px;
}
.aps__flash {
  font-size: var(--sw-fs-sm);
  color: var(--sw-ok);
  margin-right: auto;
}
.aps__flash--err {
  color: var(--sw-err);
}
.aps__dirty {
  font-size: var(--sw-fs-sm);
  color: var(--sw-warn);
  margin-right: auto;
}
.aps__clean {
  font-size: var(--sw-fs-sm);
  color: var(--sw-fg-3);
  margin-right: auto;
}
.aps__btn {
  background: var(--sw-bg-1);
  border: 1px solid var(--sw-line-2);
  color: var(--sw-fg-0);
  font: inherit;
  font-size: var(--sw-fs-base);
  padding: 6px 14px;
  border-radius: 4px;
  cursor: pointer;
}
.aps__btn:not(:disabled):hover {
  background: var(--sw-bg-2);
}
.aps__btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.aps__btn--danger {
  color: var(--sw-err);
}
.aps__btn--danger:not(:disabled):hover {
  background: var(--sw-err-soft);
}
.aps__btn--primary {
  background: var(--sw-accent);
  border-color: var(--sw-accent);
  color: #0a0d12;
  font-weight: var(--sw-fw-semibold);
}
.aps__btn--primary:not(:disabled):hover {
  background: var(--sw-accent-2);
}
</style>
