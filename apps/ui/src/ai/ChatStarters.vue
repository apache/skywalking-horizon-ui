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
<!-- Empty-chat starter chips. A plain starter sends on click. A PARAMETERIZED
     starter (one carrying `<service>` / `<layer>` tokens) opens a small fill-in:
     type the value FREE-FORM — a partial name, a description, whatever — and the
     assistant resolves it via its cross-layer service search at query time. No
     dropdown / roster pre-fetch: the LLM does the matching, so an approximate
     name still lands (and it's instant). Enter submits. -->
<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { fillStarter, starterTokens } from './starters';

const props = defineProps<{ starters: string[] }>();
const emit = defineEmits<{ (e: 'ask', text: string): void }>();
const { t } = useI18n({ useScope: 'global' });

// Which parameterized starter's fill-in panel is open (index into `starters`).
const activeIdx = ref<number | null>(null);
const values = ref<Record<string, string>>({});
const panel = ref<HTMLElement | null>(null);

function tokensOf(text: string): string[] {
  return starterTokens(text);
}

const activeStarter = computed(() => (activeIdx.value != null ? props.starters[activeIdx.value] : ''));
const activeTokens = computed(() => (activeStarter.value ? starterTokens(activeStarter.value) : []));
const preview = computed(() => (activeStarter.value ? fillStarter(activeStarter.value, values.value) : ''));
const canAsk = computed(() => activeTokens.value.every((tok) => (values.value[tok] ?? '').trim().length > 0));

// A known token maps to its translated field label; anything else shows raw.
function labelFor(tok: string): string {
  return t(tok.charAt(0).toUpperCase() + tok.slice(1));
}

function onChip(idx: number): void {
  const text = props.starters[idx];
  if (starterTokens(text).length === 0) {
    emit('ask', text);
    return;
  }
  if (activeIdx.value === idx) {
    close();
    return;
  }
  activeIdx.value = idx;
  values.value = {};
}

function close(): void {
  activeIdx.value = null;
}

function ask(): void {
  if (!canAsk.value) return;
  emit('ask', preview.value);
  close();
}

// Focus the first field the instant the panel opens, so a parameterized starter
// is one click + type + Enter away.
watch(activeIdx, (v) => {
  if (v !== null) void nextTick(() => panel.value?.querySelector('input')?.focus());
});
</script>

<template>
  <div class="stx">
    <div class="stx__chips">
      <button
        v-for="(s, i) in starters"
        :key="i"
        type="button"
        class="stx__chip"
        :class="{ 'is-active': activeIdx === i, 'is-param': tokensOf(s).length > 0 }"
        @click="onChip(i)"
      >
        {{ s }}
        <span v-if="tokensOf(s).length" class="stx__badge" aria-hidden="true">⋯</span>
      </button>
    </div>

    <div v-if="activeIdx !== null" ref="panel" class="stx__panel">
      <div class="stx__preview">{{ preview }}</div>
      <div class="stx__fields">
        <label v-for="tok in activeTokens" :key="tok" class="stx__field">
          <span class="stx__flabel">{{ labelFor(tok) }}</span>
          <input
            v-model="values[tok]"
            class="stx__input"
            type="text"
            :placeholder="t('Type a name — the assistant will find it')"
            @keydown.enter.prevent="ask"
          />
        </label>
      </div>
      <div class="stx__acts">
        <button type="button" class="stx__btn" @click="close">{{ t('Cancel') }}</button>
        <button type="button" class="stx__btn stx__btn--primary" :disabled="!canAsk" @click="ask">
          {{ t('Ask') }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.stx {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.stx__chips {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.stx__chip {
  position: relative;
  text-align: left;
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line-2);
  border-radius: 8px;
  color: var(--sw-fg-1);
  font: inherit;
  font-size: var(--sw-fs-sm);
  padding: 7px 10px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.stx__chip:hover {
  background: var(--sw-bg-3);
  color: var(--sw-fg-0);
  border-color: var(--sw-accent-line);
}
.stx__chip.is-active {
  border-color: var(--sw-accent);
  color: var(--sw-fg-0);
}
/* Parameterized chips carry a subtle glyph so it's clear they open a fill-in
   step rather than send immediately. */
.stx__badge {
  flex: 0 0 auto;
  font-family: var(--sw-mono);
  font-size: var(--sw-fs-xs);
  color: var(--sw-fg-3);
  border: 1px solid var(--sw-line-2);
  border-radius: 4px;
  padding: 0 5px;
  line-height: 16px;
}
.stx__panel {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 10px;
  border: 1px solid var(--sw-accent-line);
  border-radius: 8px;
  background: var(--sw-bg-0);
}
.stx__preview {
  font-size: var(--sw-fs-sm);
  color: var(--sw-fg-0);
  font-family: var(--sw-mono);
  line-height: var(--sw-lh-normal);
}
.stx__fields {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.stx__field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.stx__flabel {
  font-size: var(--sw-fs-xs);
  color: var(--sw-fg-2);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.stx__input {
  height: 30px;
  padding: 0 8px;
  border: 1px solid var(--sw-line-2);
  border-radius: 6px;
  background: var(--sw-bg-2);
  color: var(--sw-fg-0);
  font: inherit;
  font-size: var(--sw-fs-sm);
}
.stx__input:focus {
  outline: none;
  border-color: var(--sw-accent);
}
.stx__acts {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.stx__btn {
  height: 28px;
  padding: 0 12px;
  border: 1px solid var(--sw-line-2);
  border-radius: 6px;
  background: var(--sw-bg-2);
  color: var(--sw-fg-1);
  font: inherit;
  font-size: var(--sw-fs-sm);
  cursor: pointer;
}
.stx__btn:hover {
  border-color: var(--sw-accent-line);
  color: var(--sw-fg-0);
}
.stx__btn--primary {
  background: var(--sw-accent-soft);
  border-color: var(--sw-accent);
  color: var(--sw-fg-0);
}
.stx__btn--primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
