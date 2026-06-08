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
  MQE expression field. A single-line inline input for quick edits plus an
  expand button that opens a larger pop-out so a long expression can be
  read and edited in full. Shared by the layer-dashboard and overview
  template editors via `v-model`. Self-contained (own teleported overlay)
  so it carries no cross-feature dependency.
-->
<script setup lang="ts">
import { nextTick, ref } from 'vue';

const props = withDefaults(
  defineProps<{
    /** Optional so callers can bind an `mqe?: string` field directly. */
    modelValue?: string;
    placeholder?: string;
    readonly?: boolean;
    /** Header label for the pop-out. */
    title?: string;
  }>(),
  { modelValue: '', placeholder: '', readonly: false, title: 'MQE expression' },
);
const emit = defineEmits<{ 'update:modelValue': [value: string] }>();

const open = ref(false);
const draft = ref('');
const taRef = ref<HTMLTextAreaElement | null>(null);

function openPopout(): void {
  draft.value = props.modelValue ?? '';
  open.value = true;
  void nextTick(() => taRef.value?.focus());
}
function apply(): void {
  if (props.readonly) {
    open.value = false;
    return;
  }
  // MQE is single-line; fold any stray newlines the larger box invited
  // back into spaces so the saved expression stays valid.
  emit('update:modelValue', draft.value.replace(/\s*\n\s*/g, ' ').trim());
  open.value = false;
}
function cancel(): void {
  open.value = false;
}
function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.preventDefault();
    cancel();
  } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    apply();
  }
}
</script>

<template>
  <div class="mqe-input">
    <input
      class="mono mqe-inline"
      :value="modelValue"
      :placeholder="placeholder"
      :readonly="readonly"
      @input="$emit('update:modelValue', ($event.target as HTMLInputElement).value)"
    />
    <button type="button" class="mqe-expand" :title="`Expand — ${title}`" @click="openPopout">⤢</button>
  </div>

  <Teleport to="body">
    <div v-if="open" class="mqe-pop-backdrop" @mousedown.self="cancel">
      <div class="mqe-pop" role="dialog" aria-modal="true" @keydown="onKeydown">
        <header class="mqe-pop-head">
          <span>{{ title }}</span>
          <button type="button" class="mqe-pop-close" title="Close (Esc)" @click="cancel">×</button>
        </header>
        <textarea
          ref="taRef"
          v-model="draft"
          class="mono mqe-pop-area"
          :readonly="readonly"
          :placeholder="placeholder"
          spellcheck="false"
        ></textarea>
        <footer class="mqe-pop-foot">
          <span class="mqe-pop-hint">⌘/Ctrl + Enter to apply · Esc to cancel</span>
          <span class="spacer"></span>
          <button type="button" class="sw-btn ghost small" @click="cancel">Cancel</button>
          <button type="button" class="sw-btn small" :disabled="readonly" @click="apply">Apply</button>
        </footer>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.mqe-input {
  display: flex;
  gap: 4px;
  align-items: center;
  min-width: 0;
  width: 100%;
}
.mqe-inline {
  flex: 1 1 auto;
  min-width: 0;
  height: 26px;
  padding: 0 8px;
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line-2);
  border-radius: 4px;
  color: var(--sw-fg-0);
  font-family: var(--sw-mono);
  font-size: 11px;
}
.mqe-inline:focus {
  outline: none;
  border-color: var(--sw-accent-line);
}
.mqe-expand {
  flex: 0 0 auto;
  width: 24px;
  height: 26px;
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line-2);
  border-radius: 4px;
  color: var(--sw-fg-3);
  cursor: pointer;
  font-size: 12px;
  line-height: 1;
}
.mqe-expand:hover {
  color: var(--sw-fg-0);
  border-color: var(--sw-accent-line);
}

.mqe-pop-backdrop {
  position: fixed;
  inset: 0;
  z-index: 1000;
  background: rgba(0, 0, 0, 0.5);
  display: grid;
  place-items: center;
}
.mqe-pop {
  width: min(760px, 90vw);
  background: var(--sw-bg-1);
  border: 1px solid var(--sw-line);
  border-radius: 8px;
  display: flex;
  flex-direction: column;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.4);
}
.mqe-pop-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--sw-line);
  font-size: 12px;
  font-weight: 600;
  color: var(--sw-fg-0);
}
.mqe-pop-close {
  margin-left: auto;
  width: 24px;
  height: 24px;
  background: none;
  border: none;
  color: var(--sw-fg-3);
  font-size: 14px;
  cursor: pointer;
}
.mqe-pop-close:hover {
  color: var(--sw-fg-0);
}
.mqe-pop-area {
  margin: 12px 14px;
  min-height: 220px;
  resize: vertical;
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line-2);
  border-radius: 6px;
  color: var(--sw-fg-0);
  font-family: var(--sw-mono);
  font-size: 12.5px;
  line-height: 1.6;
  padding: 10px 12px;
}
.mqe-pop-area:focus {
  outline: none;
  border-color: var(--sw-accent-line);
}
.mqe-pop-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  border-top: 1px solid var(--sw-line);
}
.mqe-pop-foot .spacer {
  flex: 1;
}
.mqe-pop-hint {
  font-size: 10px;
  color: var(--sw-fg-3);
}
</style>
