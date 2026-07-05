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
<!-- Chat composer. Enter sends, Shift+Enter newlines. `streaming` swaps Send for
     Stop (an answer is in flight); `disabled` greys Send out for another reason
     WITHOUT showing Stop — a Stop button that can't stop anything misreads the
     state. -->
<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';

const props = defineProps<{ disabled?: boolean; streaming?: boolean }>();
const emit = defineEmits<{ (e: 'send', text: string): void; (e: 'stop'): void }>();
const { t } = useI18n({ useScope: 'global' });

const text = ref('');
const input = ref<HTMLTextAreaElement | null>(null);
onMounted(() => input.value?.focus());

function submit(): void {
  const q = text.value.trim();
  if (!q || props.disabled || props.streaming) return;
  emit('send', q);
  text.value = '';
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    submit();
  }
}
</script>

<template>
  <div class="cmp">
    <textarea
      ref="input"
      v-model="text"
      class="cmp__input"
      rows="2"
      :placeholder="t('Ask about your services, metrics, traces and logs…')"
      @keydown="onKeydown"
    ></textarea>
    <button
      v-if="streaming"
      type="button"
      class="cmp__send cmp__stop"
      :title="t('Stop')"
      @click="emit('stop')"
    >
      {{ t('Stop') }}
    </button>
    <button
      v-else
      type="button"
      class="cmp__send"
      :disabled="disabled || text.trim().length === 0"
      @click="submit"
    >
      {{ t('Send') }}
    </button>
  </div>
</template>

<style scoped>
.cmp {
  display: flex;
  gap: 8px;
}
.cmp__input {
  flex: 1 1 auto;
  resize: none;
  background: var(--sw-bg-1);
  border: 1px solid var(--sw-line-2);
  border-radius: 8px;
  padding: 8px 10px;
  color: var(--sw-fg-0);
  font: inherit;
  font-size: var(--sw-fs-base);
  line-height: var(--sw-lh-normal);
}
.cmp__input:focus {
  outline: none;
  border-color: var(--sw-accent);
}
.cmp__send {
  flex: 0 0 auto;
  align-self: flex-end;
  height: 34px;
  padding: 0 14px;
  background: var(--sw-accent);
  border: 1px solid var(--sw-accent);
  border-radius: 8px;
  color: #0a0d12;
  font: inherit;
  font-size: var(--sw-fs-sm);
  font-weight: var(--sw-fw-semibold);
  cursor: pointer;
}
.cmp__send:hover:not(:disabled) {
  background: var(--sw-accent-2);
}
.cmp__stop {
  background: var(--sw-bg-2);
  border-color: var(--sw-line-2);
  color: var(--sw-fg-1);
}
.cmp__stop:hover {
  border-color: var(--sw-accent);
  color: var(--sw-fg-0);
}
</style>
