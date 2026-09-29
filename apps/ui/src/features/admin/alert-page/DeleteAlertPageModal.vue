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
  Confirms deleting a named alert page: the operator types its id to arm the
  button. OAP has no hard delete, so the row is disabled; the page leaves the
  sidebar for everyone, and its id stays taken.
-->
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import Modal from '@/components/primitives/Modal.vue';

const { t } = useI18n({ useScope: 'global' });

const props = defineProps<{
  open: boolean;
  pageId: string;
  title: string;
  busy: boolean;
  readOnly: boolean;
}>();

const emit = defineEmits<{ close: []; confirm: [] }>();

const typed = ref('');
watch(
  () => props.open,
  (open) => {
    if (!open) typed.value = '';
  },
);
const armed = computed<boolean>(() => typed.value.trim() === props.pageId);
</script>

<template>
  <Modal :open="open" :title="t('Delete alarm page?')" width="min(520px, 92vw)" @close="emit('close')">
    <p class="dap__msg">
      {{ t('Delete the alarm page “{title}” ({id})? OAP has no hard delete, so the page is disabled: it leaves the sidebar for everyone, and its id cannot be used again. This cannot be undone from the UI.', { title, id: pageId }) }}
    </p>
    <label class="dap__confirm">
      <i18n-t keypath="Type {id} to confirm:" tag="span" scope="global">
        <template #id><code>{{ pageId }}</code></template>
      </i18n-t>
      <input v-model="typed" type="text" autocomplete="off" spellcheck="false" class="dap__in" />
    </label>
    <template #footer>
      <button class="sw-btn" type="button" @click="emit('close')">{{ t('Cancel') }}</button>
      <button
        class="sw-btn dap__danger"
        type="button"
        :disabled="!armed || busy || readOnly"
        @click="emit('confirm')"
      >{{ busy ? t('Deleting…') : t('Delete') }}</button>
    </template>
  </Modal>
</template>

<style scoped>
.dap__msg { margin: 0 0 12px; font-size: var(--sw-fs-base); line-height: 1.55; color: var(--sw-fg-1); }
.dap__confirm { display: flex; flex-direction: column; gap: 6px; font-size: var(--sw-fs-sm); color: var(--sw-fg-2); }
.dap__confirm code { font-family: var(--sw-mono); color: var(--sw-fg-0); }
.dap__in {
  background: var(--sw-bg-1);
  border: 1px solid var(--sw-line);
  color: var(--sw-fg-0);
  font-family: var(--sw-mono);
  font-size: var(--sw-fs-base);
  padding: 4px 6px;
  border-radius: 4px;
}
.dap__danger { border-color: var(--sw-err); color: var(--sw-err); }
.dap__danger:not(:disabled):hover { background: var(--sw-err-soft); }
.dap__danger:disabled { opacity: 0.4; cursor: not-allowed; }
</style>
