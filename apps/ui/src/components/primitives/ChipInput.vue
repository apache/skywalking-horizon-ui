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
  Chip input — a text field where Enter turns what was typed into removable
  chips, for a condition that takes several values of one kind. Values typed
  or pasted together, separated by commas or whitespace, become one chip each.
  Backspace in an empty field takes the last chip back into it; × removes one.

  Props:
    modelValue     — the committed values.
    placeholder    — shown while nothing is committed.
    disabled       — the whole control is inert.
    normalize      — the value to commit, or null to refuse it.
    invalidMessage — why a value was refused, shown under the field.

  Emits:
    update:modelValue — the committed values changed.

  Enter only commits; it never submits anything. `commitDraft()` is exposed so
  a caller's own run can take a value that was typed but never committed; it
  answers false when a typed value was refused.
-->
<script setup lang="ts">
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';

const { t } = useI18n({ useScope: 'global' });

const props = withDefaults(
  defineProps<{
    modelValue: string[];
    placeholder?: string;
    disabled?: boolean;
    normalize?: (value: string) => string | null;
    invalidMessage?: (value: string) => string;
    ariaLabel?: string;
  }>(),
  { placeholder: '', disabled: false, normalize: undefined, invalidMessage: undefined, ariaLabel: undefined },
);
const emit = defineEmits<{
  'update:modelValue': [string[]];
}>();

const draft = ref('');
const refusal = ref<string | null>(null);

/** Commit what is typed. A refused value stays in the field with the reason
 *  under it while the rest are committed. */
function commitDraft(): boolean {
  const parts = draft.value.split(/[\s,]+/).filter(Boolean);
  if (parts.length === 0) return true;
  const next = [...props.modelValue];
  const refused: string[] = [];
  for (const part of parts) {
    const value = props.normalize ? props.normalize(part) : part;
    if (value === null) refused.push(part);
    else if (!next.includes(value)) next.push(value);
  }
  if (next.length !== props.modelValue.length) emit('update:modelValue', next);
  draft.value = refused.join(' ');
  const first = refused[0];
  refusal.value = first !== undefined ? (props.invalidMessage ? props.invalidMessage(first) : first) : null;
  return refused.length === 0;
}
defineExpose({ commitDraft });

function remove(index: number): void {
  emit('update:modelValue', props.modelValue.filter((_, i) => i !== index));
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Enter') {
    e.preventDefault();
    commitDraft();
    return;
  }
  const last = props.modelValue[props.modelValue.length - 1];
  if (e.key === 'Backspace' && !draft.value && last !== undefined) {
    e.preventDefault();
    draft.value = last;
    emit('update:modelValue', props.modelValue.slice(0, -1));
  }
}
</script>

<template>
  <div class="chi" :class="{ 'is-disabled': disabled }">
    <div class="chi__box">
      <span v-for="(v, i) in modelValue" :key="v" class="chi__chip mono">
        {{ v }}
        <button type="button" class="chi__x" :title="t('Remove')" :disabled="disabled" @click="remove(i)">×</button>
      </span>
      <input
        v-model="draft"
        class="chi__input mono"
        type="text"
        :placeholder="modelValue.length === 0 ? placeholder : ''"
        :disabled="disabled"
        :aria-label="ariaLabel"
        autocomplete="off"
        spellcheck="false"
        @input="refusal = null"
        @keydown="onKeydown"
      />
    </div>
    <span v-if="refusal" class="chi__refusal">{{ refusal }}</span>
  </div>
</template>

<style scoped>
.chi { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.chi__box {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  min-height: 28px;
  padding: 3px 6px;
  box-sizing: border-box;
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line-2);
  border-radius: 4px;
}
.chi__box:focus-within { border-color: var(--sw-accent-line); }
.chi.is-disabled .chi__box { opacity: 0.5; cursor: not-allowed; }
.chi__chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 20px;
  padding: 0 6px;
  max-width: 100%;
  background: var(--sw-bg-3);
  border: 1px solid var(--sw-line-2);
  border-radius: 10px;
  color: var(--sw-fg-1);
  font-size: 10.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.chi__x {
  background: transparent;
  border: none;
  color: var(--sw-fg-3);
  cursor: pointer;
  font-size: 12px;
  line-height: 1;
  padding: 0;
}
.chi__x:hover:not(:disabled) { color: var(--sw-err); }
.chi__input {
  flex: 1 1 120px;
  min-width: 120px;
  height: 20px;
  padding: 0 2px;
  background: transparent;
  border: none;
  outline: none;
  color: var(--sw-fg-0);
  font-size: 11px;
}
.chi__input:disabled { cursor: not-allowed; }
.chi__refusal { font-size: 10.5px; line-height: 1.35; color: var(--sw-err); }
.mono { font-family: var(--sw-mono); }
</style>
