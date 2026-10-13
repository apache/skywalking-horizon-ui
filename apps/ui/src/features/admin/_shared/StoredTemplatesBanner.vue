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
<script setup lang="ts">
/**
 * The stored templates a Dashboard setup page owns that nobody is served, in
 * two lists, because valid / invalid and enabled / disabled are separate
 * questions:
 *
 *   - enabled and invalid — read its problems, download it, or disable it.
 *     Nothing else: it is configured again only once it is disabled, so a
 *     record nobody has looked at is never written over;
 *   - disabled, valid or not — enable it, and it comes back with the content
 *     it holds (an invalid one comes back invalid).
 */
import { computed, defineAsyncComponent, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { bff } from '@/api/client';
import type { TemplateSyncRow } from '@/api/scopes/template-sync';
import { refreshConfigBundle, useConfigBundle } from '@/controls/configBundle';
import Btn from '@/components/primitives/Btn.vue';
import Icon from '@/components/icons/Icon.vue';
import { storedRecordView } from './storedRecordView';
import { pushErrorLines } from './pushError';
// Monaco is loaded only when a problem is opened.
const TemplateProblemsDialog = defineAsyncComponent(() => import('./TemplateProblemsDialog.vue'));

const props = defineProps<{
  /** Which stored rows this page owns. */
  owns: (row: { kind: string; locale?: string }) => boolean;
  /** No Disable / Enable: the page cannot write right now. */
  readOnly: boolean;
}>();
const emit = defineEmits<{ changed: [name: string] }>();

const { t } = useI18n({ useScope: 'global' });
const { bundle } = useConfigBundle();

const rows = ref<TemplateSyncRow[]>([]);
const error = ref<string | null>(null);
const confirming = ref<string | null>(null);
const writing = ref<string | null>(null);
const shown = ref<TemplateSyncRow | null>(null);
const disabledOpen = ref(false);

const invalidRows = computed(() => rows.value.filter((r) => r.status === 'invalid'));
const disabledRows = computed(() => rows.value.filter((r) => r.remote?.disabled));

// The bundle carries which ones there are, on its own refresh cycle; the rows
// themselves — problems and stored text — come from the admin sync status.
const ownedNames = computed(() => {
  const s = bundle.value?.syncStatus;
  return [
    ...(s?.invalid ?? []).filter(props.owns),
    ...(s?.badges ?? []).filter((b) => b.status === 'disabled' && props.owns(b)),
  ]
    .map((r) => r.name)
    .join('\n');
});

// A record can change and stay as it was listed, so a new read of the store
// reloads the rows too — and an open dialog follows its record, or closes
// once gone.
const snapshotAt = computed(() => bundle.value?.syncStatus?.generatedAt ?? 0);

async function load(): Promise<void> {
  try {
    const status = await bff.templateSync.syncStatus(false);
    rows.value = status.rows.filter(
      (r) => r.remote && (r.status === 'invalid' || r.remote.disabled) && props.owns(r),
    );
    if (shown.value) {
      const name = shown.value.name;
      shown.value = rows.value.find((r) => r.name === name && r.problems?.length) ?? null;
    }
    error.value = null;
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}
watch([ownedNames, snapshotAt], () => void load(), { immediate: true });

const shownView = computed(() =>
  shown.value?.remote ? storedRecordView(shown.value.remote.configuration, shown.value.problems ?? []) : null,
);

const problemCount = (row: TemplateSyncRow): number => (row.problems ?? []).length;

function download(row: TemplateSyncRow): void {
  if (!row.remote) return;
  const { text } = storedRecordView(row.remote.configuration, []);
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `${row.name}.json`;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke after the click is committed — Safari aborts the download if the
  // object URL is freed synchronously.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

// By the record's own name, whatever it is: a translation stored under a
// language Horizon does not offer has no other way in or out.
async function write(row: TemplateSyncRow, action: 'disable' | 'enable'): Promise<void> {
  writing.value = row.name;
  error.value = null;
  try {
    await bff.templateSync[action](row.name);
    confirming.value = null;
    await refreshConfigBundle({ force: true });
    await load();
    emit('changed', row.name);
  } catch (err) {
    error.value = pushErrorLines(err).join(' · ');
  } finally {
    writing.value = null;
  }
}
</script>

<template>
  <div v-if="invalidRows.length > 0" class="itb" role="alert" data-testid="invalid-templates-banner">
    <div class="itb__head">
      <Icon name="alert" :size="14" />
      <strong>{{ t('{n} invalid templates stored on OAP', invalidRows.length, { named: { n: invalidRows.length } }) }}</strong>
      <span class="itb__detail">{{
        t('Nobody is served these. Check each one, or disable it before configuring a new one.')
      }}</span>
    </div>
    <ul class="itb__list">
      <li v-for="row in invalidRows" :key="row.name" class="itb__row">
        <code class="itb__name">{{ row.name }}</code>
        <span class="itb__meta">
          {{ t('record {id}', { id: row.remote?.id ?? '' }) }} ·
          {{ t('{n} problems', problemCount(row), { named: { n: problemCount(row) } }) }}
        </span>
        <span class="itb__actions">
          <Btn size="sm" @click="shown = row">{{ t('Show problems') }}</Btn>
          <Btn size="sm" @click="download(row)">{{ t('Download') }}</Btn>
          <template v-if="!readOnly">
            <template v-if="confirming === row.name">
              <span class="itb__confirm">{{ t('Disable this record on OAP? It can be enabled again.') }}</span>
              <Btn size="sm" kind="danger" :disabled="writing === row.name" @click="write(row, 'disable')">{{ t('Disable') }}</Btn>
              <Btn size="sm" :disabled="writing === row.name" @click="confirming = null">{{ t('Cancel') }}</Btn>
            </template>
            <Btn v-else size="sm" kind="danger" @click="confirming = row.name">{{ t('Disable') }}</Btn>
          </template>
        </span>
      </li>
    </ul>
  </div>
  <div v-if="disabledRows.length > 0" class="dtb" data-testid="disabled-templates">
    <button type="button" class="dtb__head" :aria-expanded="disabledOpen" @click="disabledOpen = !disabledOpen">
      <span class="dtb__caret" aria-hidden="true">{{ disabledOpen ? '▾' : '▸' }}</span>
      <strong>{{ t('{n} disabled templates stored on OAP', disabledRows.length, { named: { n: disabledRows.length } }) }}</strong>
      <span class="dtb__detail">{{ t('Nobody is served these. Enabling one brings it back with the content it holds.') }}</span>
    </button>
    <ul v-if="disabledOpen" class="itb__list">
      <li v-for="row in disabledRows" :key="row.name" class="itb__row">
        <code class="itb__name">{{ row.name }}</code>
        <span class="itb__meta">
          {{ t('record {id}', { id: row.remote?.id ?? '' }) }}<template v-if="problemCount(row) > 0"> ·
            <span class="dtb__invalid">{{ t('invalid') }}</span> ·
            {{ t('{n} problems', problemCount(row), { named: { n: problemCount(row) } }) }}</template>
        </span>
        <span class="itb__actions">
          <template v-if="problemCount(row) > 0">
            <Btn size="sm" @click="shown = row">{{ t('Show problems') }}</Btn>
            <Btn size="sm" @click="download(row)">{{ t('Download') }}</Btn>
          </template>
          <template v-if="!readOnly">
            <template v-if="confirming === row.name">
              <span class="dtb__confirm">{{
                problemCount(row) > 0
                  ? t('Enable this record on OAP? It comes back invalid.')
                  : t('Enable this record on OAP?')
              }}</span>
              <Btn size="sm" kind="primary" :disabled="writing === row.name" @click="write(row, 'enable')">{{ t('Enable') }}</Btn>
              <Btn size="sm" :disabled="writing === row.name" @click="confirming = null">{{ t('Cancel') }}</Btn>
            </template>
            <Btn v-else size="sm" @click="confirming = row.name">{{ t('Enable') }}</Btn>
          </template>
        </span>
      </li>
    </ul>
  </div>
  <p v-if="error" class="itb__err">{{ error }}</p>
  <TemplateProblemsDialog
    v-if="shown && shownView"
    :open="true"
    :title="t('Problems in {name}', { name: shown.name })"
    :text="shownView.text"
    :problems="shownView.problems"
    :download-name="`${shown.name}.json`"
    @close="shown = null"
  />
</template>

<style scoped>
.itb {
  margin: 0 0 14px;
  padding: 10px 12px;
  border: 1px solid var(--sw-err);
  border-radius: 6px;
  background: var(--sw-err-soft);
  font-size: 12px;
  color: var(--sw-fg-1);
}
.itb__head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.itb__head :deep(svg) {
  color: var(--sw-err);
}
.itb__head strong {
  color: var(--sw-err);
}
.itb__detail {
  color: var(--sw-fg-2);
}
.itb__list {
  list-style: none;
  margin: 8px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.itb__row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  padding: 4px 0;
  border-top: 1px solid var(--sw-line-2);
}
.itb__name {
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  color: var(--sw-fg-0);
}
.itb__meta {
  color: var(--sw-fg-3);
}
.itb__actions {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.itb__confirm {
  color: var(--sw-err);
}
.itb__err {
  margin: 0 0 14px;
  color: var(--sw-err);
  font-size: 12px;
}
.dtb {
  margin: 0 0 14px;
  padding: 6px 12px;
  border: 1px solid var(--sw-line-2);
  border-radius: 6px;
  background: var(--sw-bg-1);
  font-size: 12px;
  color: var(--sw-fg-1);
}
.dtb__head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  width: 100%;
  padding: 2px 0;
  border: 0;
  background: none;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.dtb__caret {
  color: var(--sw-fg-3);
  width: 10px;
}
.dtb__detail {
  color: var(--sw-fg-3);
}
.dtb__invalid {
  color: var(--sw-err);
  text-transform: uppercase;
  font-size: 10px;
  letter-spacing: 0.04em;
}
.dtb__confirm {
  color: var(--sw-fg-1);
}
</style>
