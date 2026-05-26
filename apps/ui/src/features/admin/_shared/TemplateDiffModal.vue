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
  Per-template "show diff & reset" modal. Opens from any diverged row
  in the admin lists. Two stacked surfaces:

    1. Monaco side-by-side diff — bundled (left, original) vs remote
       (right, modified). JSON syntax. Read-only.
    2. Reset-to-bundled affordance with destructive confirmation —
       the operator must type the template KEY (e.g. `GENERAL`,
       `services`, `page-setup`) to arm the Reset button. Reset POSTs
       the bundled JSON to OAP, overwriting whatever the operator (or
       another UI) wrote there.

  Reset is the inverse of Save: Save sends draft to OAP; Reset sends
  bundled to OAP. There is no "adopt remote into bundled" — bundled is
  a code-shape decision, edited by committing JSON in the repo.
-->
<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { bff } from '@/api/client';
import type { TemplateSyncRow } from '@/api/scopes/template-sync';
import Modal from '@/features/operate/_shared/Modal.vue';
import MonacoDiff from '@/features/operate/_shared/MonacoDiff.vue';
import Btn from '@/components/primitives/Btn.vue';

const { t } = useI18n({ useScope: 'global' });

const props = defineProps<{
  /** Full OAP UI-template name, e.g. `horizon.layer.GENERAL`. */
  name: string;
  /** Short key the operator types to confirm. Just the trailing
   *  segment, e.g. `GENERAL`, `services`, `page-setup`. */
  confirmKey: string;
  open: boolean;
}>();

const emit = defineEmits<{ close: []; reset: [] }>();

const row = ref<TemplateSyncRow | null>(null);
const loading = ref(false);
const loadError = ref<string | null>(null);
const typed = ref('');
const resetBusy = ref(false);
const resetError = ref<string | null>(null);
const armed = computed<boolean>(() => typed.value.trim() === props.confirmKey);

// Pretty-printed JSON for the diff editor — the wire form is canonical
// (sorted keys, no whitespace), readable for compare but unreadable
// for a human. JSON.parse + JSON.stringify(_, null, 2) gives us
// 2-space pretty without changing the data.
const bundledPretty = computed<string>(() => prettyJson(row.value?.bundled?.configuration ?? ''));
const remotePretty = computed<string>(() => prettyJson(row.value?.remote?.configuration ?? ''));

function prettyJson(raw: string): string {
  if (!raw) return '';
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

async function load(): Promise<void> {
  loading.value = true;
  loadError.value = null;
  try {
    const status = await bff.templateSync.syncStatus();
    const found = status.rows.find((r) => r.name === props.name) ?? null;
    if (!found) {
      loadError.value = t('No template named {name} in OAP sync status.', { name: props.name });
    }
    row.value = found;
  } catch (err) {
    loadError.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}

// Re-fetch on every open, and reset the confirm input. Stale data
// between opens would mislead operators about what they're about to
// overwrite.
watch(
  () => props.open,
  (isOpen) => {
    if (!isOpen) {
      typed.value = '';
      resetError.value = null;
      return;
    }
    void load();
  },
);

onMounted(() => {
  if (props.open) void load();
});

async function onReset(): Promise<void> {
  if (!armed.value || resetBusy.value) return;
  resetBusy.value = true;
  resetError.value = null;
  try {
    await bff.templateSync.pushBundled(props.name);
    emit('reset');
    emit('close');
  } catch (err) {
    resetError.value = err instanceof Error ? err.message : String(err);
  } finally {
    resetBusy.value = false;
  }
}
</script>

<template>
  <Modal :open="open" :title="t('Template diff — {name}', { name })" width="80vw" fit-body @close="emit('close')">
    <div v-if="loading" class="tdm__loading">{{ t('Loading sync status…') }}</div>
    <div v-else-if="loadError" class="tdm__err">{{ loadError }}</div>
    <template v-else-if="row">
      <p class="tdm__about">
        {{ t('This is the dashboard definition for') }} <code>{{ name }}</code>. {{ t("It drives the rendered page for this scope — the widget layout, each widget's metric (MQE) expression, and which components / tabs appear. A difference means the template stored on OAP was edited (by an operator or another UI) and no longer matches the JSON bundled in this build; the live UI follows the right (OAP-stored) side until you reset.") }}
      </p>
      <div class="tdm__cols">
        <div class="tdm__col tdm__col--l">
          <span class="tdm__col-side">{{ t('◀ LEFT') }}</span>
          <span class="tdm__col-name">{{ t('bundled') }}</span>
          <span class="tdm__col-note">{{ t("the build's seed JSON (source of truth)") }}</span>
        </div>
        <div class="tdm__col tdm__col--r">
          <span class="tdm__col-side">{{ t('RIGHT ▶') }}</span>
          <span class="tdm__col-name">{{ t('OAP-stored') }}</span>
          <span class="tdm__col-note">{{ t("what's live now (operator-edited)") }}</span>
        </div>
      </div>
      <div class="tdm__diff">
        <MonacoDiff :original="bundledPretty" :modified="remotePretty" language="json" />
      </div>

      <div class="tdm__reset">
        <h4>{{ t('Reset to bundled') }}</h4>
        <p class="tdm__reset-lede">
          {{ t('This overwrites') }} <code>{{ name }}</code> {{ t("on OAP with the bundled JSON shown on the left. The operator's edits on OAP are lost. The bundle is considered the source of truth after this action.") }}
        </p>
        <label class="tdm__reset-label">
          <span>{{ t('Type') }} <code class="tdm__reset-key">{{ confirmKey }}</code> {{ t('to arm the Reset button:') }}</span>
          <input
            v-model="typed"
            type="text"
            autocomplete="off"
            spellcheck="false"
            class="tdm__reset-input"
          />
        </label>
        <div v-if="resetError" class="tdm__err">{{ resetError }}</div>
      </div>
    </template>

    <template #footer>
      <Btn @click="emit('close')">{{ t('close') }}</Btn>
      <Btn
        v-if="row"
        kind="danger"
        :disabled="!armed || resetBusy"
        @click="onReset"
      >
        {{ resetBusy ? t('resetting…') : t('reset OAP to bundled') }}
      </Btn>
    </template>
  </Modal>
</template>

<style scoped>
.tdm__loading,
.tdm__err {
  padding: 16px;
  font-size: 13px;
  color: var(--rr-ink2);
}
.tdm__err {
  color: var(--rr-danger, #c0392b);
}
.tdm__about {
  margin: 0 0 10px;
  padding: 8px 10px;
  font-size: 12px;
  line-height: 1.55;
  color: var(--rr-ink2);
  background: var(--rr-bg, rgba(255, 255, 255, 0.02));
  border: 1px solid var(--rr-border, #2a2f38);
  border-radius: var(--rr-radius, 6px);
}
.tdm__about code {
  font-family: var(--rr-font-mono, ui-monospace, monospace);
}
/* Two column headers aligned 50/50 over the side-by-side diff panes, so
 * it's unambiguous which side is bundled vs OAP-stored. */
.tdm__cols {
  display: flex;
  border: 1px solid var(--rr-border, #2a2f38);
  border-bottom: none;
  border-top-left-radius: var(--rr-radius, 6px);
  border-top-right-radius: var(--rr-radius, 6px);
  overflow: hidden;
}
.tdm__col {
  flex: 1 1 50%;
  min-width: 0;
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 7px 12px;
  font-size: 11.5px;
  background: var(--rr-bg3, rgba(255, 255, 255, 0.03));
}
.tdm__col--l { border-right: 1px solid var(--rr-border, #2a2f38); }
.tdm__col--r { justify-content: flex-start; }
.tdm__col-side {
  font-family: var(--rr-font-mono, ui-monospace, monospace);
  font-size: 10px;
  letter-spacing: 0.08em;
  color: var(--rr-dim, #6b7280);
}
.tdm__col--l .tdm__col-name { color: var(--sw-text-muted, #8a93a0); font-weight: 600; }
.tdm__col--r .tdm__col-name { color: var(--sw-warn, #b88500); font-weight: 600; }
.tdm__col-name { font-family: var(--rr-font-mono, ui-monospace, monospace); }
.tdm__col-note { color: var(--rr-ink2); font-size: 11px; }
.tdm__diff {
  /* Absorb the leftover height inside the fit-mode modal body and scroll
   * internally — keeps the popout itself free of a vertical scrollbar. */
  flex: 1;
  min-height: 0;
  border-bottom: 1px solid var(--rr-border, #2a2f38);
}
.tdm__reset {
  flex: 0 0 auto;
  padding: 12px 6px 2px;
}
.tdm__reset h4 {
  margin: 0 0 6px;
  font-size: 13px;
  font-weight: 600;
  color: var(--sw-danger, #c0392b);
}
.tdm__reset-lede {
  margin: 0 0 12px;
  font-size: 12px;
  line-height: 1.55;
  color: var(--rr-ink2);
}
.tdm__reset-label {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--rr-ink2);
  white-space: nowrap;
}
.tdm__reset-key {
  color: var(--sw-danger, #c0392b);
  font-family: var(--rr-font-mono, ui-monospace, monospace);
  font-weight: 600;
}
.tdm__reset-input {
  font-family: var(--rr-font-mono, ui-monospace, monospace);
  padding: 4px 6px;
}
</style>
