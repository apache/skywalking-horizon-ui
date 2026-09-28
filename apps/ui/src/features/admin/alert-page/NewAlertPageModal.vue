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
  Names a new alert page. Nothing is written here: the page opens in the
  editor, and reaches OAP when it is saved with at least one pin.
-->
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import Modal from '@/components/primitives/Modal.vue';
import { TITLE_MAX, pageIdProblem, titleProblem } from './alertPages';

const { t } = useI18n({ useScope: 'global' });

const props = defineProps<{
  open: boolean;
  /** Every id an alert row already holds, disabled rows included. */
  taken: ReadonlySet<string>;
  readOnly: boolean;
}>();

const emit = defineEmits<{
  close: [];
  create: [payload: { id: string; title: string }];
}>();

const id = ref('');
const title = ref('');
const tried = ref(false);

watch(
  () => props.open,
  (open) => {
    if (open) {
      id.value = '';
      title.value = '';
      tried.value = false;
    }
  },
);

const idError = computed<string | null>(() => {
  const value = id.value.trim();
  if (value === '' && !tried.value) return null;
  switch (pageIdProblem(value, props.taken)) {
    case 'format':
      return t('Use 1–64 characters: lower-case letters, digits, “-” and “_”, starting with a letter or digit.');
    case 'reserved':
      return t('“{id}” is reserved.', { id: value });
    case 'taken':
      return t('An alarm page with the id “{id}” is already stored on OAP. A deleted page keeps its id, so pick another.', { id: value });
    default:
      return null;
  }
});

const titleError = computed<string | null>(() => {
  if (!tried.value && title.value === '') return null;
  switch (titleProblem(title.value)) {
    case 'blank': return t('Give the page a title.');
    case 'long': return t('A title is at most {max} characters.', { max: TITLE_MAX });
    default: return null;
  }
});

function submit(): void {
  if (props.readOnly) return;
  tried.value = true;
  if (idError.value || titleError.value) return;
  emit('create', { id: id.value.trim(), title: title.value.trim() });
}
</script>

<template>
  <Modal :open="open" :title="t('New alarm page')" width="min(520px, 92vw)" @close="emit('close')">
    <div class="nap">
      <label class="nap__field">
        <span>{{ t('Id (the page address and stored name — cannot be changed later)') }}</span>
        <input v-model="id" type="text" class="nap__in nap__in--mono" placeholder="payments-oncall" @keyup.enter="submit" />
        <em v-if="idError" class="nap__err">{{ idError }}</em>
      </label>
      <label class="nap__field">
        <span>{{ t('Title') }}</span>
        <input v-model="title" type="text" class="nap__in" :placeholder="t('Payments on-call')" @keyup.enter="submit" />
        <em v-if="titleError" class="nap__err">{{ titleError }}</em>
      </label>
    </div>
    <template #footer>
      <button class="sw-btn" type="button" @click="emit('close')">{{ t('Cancel') }}</button>
      <button class="sw-btn is-primary" type="button" :disabled="readOnly" @click="submit">{{ t('Create') }}</button>
    </template>
  </Modal>
</template>

<style scoped>
.nap { display: flex; flex-direction: column; gap: 10px; }
.nap__field { display: flex; flex-direction: column; gap: 3px; }
.nap__field > span {
  font-size: var(--sw-fs-xs);
  text-transform: uppercase;
  letter-spacing: var(--sw-ls-caps);
  color: var(--sw-fg-3);
  font-weight: var(--sw-fw-semibold);
}
.nap__in {
  background: var(--sw-bg-1);
  border: 1px solid var(--sw-line);
  color: var(--sw-fg-0);
  font: inherit;
  font-size: var(--sw-fs-base);
  padding: 4px 6px;
  border-radius: 4px;
}
.nap__in--mono { font-family: var(--sw-mono); }
.nap__err { font-style: normal; font-size: var(--sw-fs-sm); color: var(--sw-err); }
</style>
