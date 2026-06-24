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
  On-theme tag input with custom (non-`<datalist>`) autocomplete.

  Suggests OAP trace/log tag KEYS (rendered `key=`) before the operator
  types `=`, and per-key VALUES (rendered `key=value`) after. The
  suggestion targets the LAST comma-fragment of `modelValue`, so it works
  both for a single in-progress tag (per-layer Traces/Logs) and a
  comma-separated `key=value, key=value` list (cross-layer inspect).

  `commit` fires on bare Enter when no suggestion is highlighted — a host
  with a chip model uses it to add a chip; single-field hosts can ignore it.
-->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from 'vue';

import { bffClient } from '@/api/client';

const props = withDefaults(
  defineProps<{
    modelValue: string;
    kind: 'trace' | 'log';
    windowMinutes?: number;
    placeholder?: string;
  }>(),
  { windowMinutes: 30, placeholder: '' },
);

const emit = defineEmits<{
  'update:modelValue': [string];
  commit: [];
}>();

const inputEl = ref<HTMLInputElement | null>(null);
const open = ref(false);
const activeIdx = ref(-1);

// Effective suggest window — hosts may pass a custom-range sentinel (-1);
// fall back to a sane default so the suggest call still hits real data.
const winMinutes = computed<number>(() =>
  props.windowMinutes && props.windowMinutes > 0 ? props.windowMinutes : 30,
);

// ── Fragment parsing ─────────────────────────────────────────────
// Suggestions operate on the text after the last comma; everything
// before it is preserved verbatim when a suggestion is applied.
const lastComma = computed<number>(() => props.modelValue.lastIndexOf(','));
const prefix = computed<string>(() =>
  lastComma.value === -1 ? '' : props.modelValue.slice(0, lastComma.value + 1),
);
const fragment = computed<string>(() =>
  (lastComma.value === -1 ? props.modelValue : props.modelValue.slice(lastComma.value + 1)).replace(/^\s+/, ''),
);
const fragmentEq = computed<number>(() => fragment.value.indexOf('='));
const fragmentKey = computed<string>(() =>
  fragmentEq.value === -1 ? '' : fragment.value.slice(0, fragmentEq.value).trim(),
);

// ── Caches (best-effort; tolerate `error` envelopes) ─────────────
const keyCache = ref<string[] | null>(null);
// Reactive so the suggestions computed re-runs when the FIRST async
// value-fetch for a key lands — a plain Map wouldn't trigger it, so the
// dropdown would only refresh on the next keystroke.
const valueCache = reactive(new Map<string, string[]>());
const loadingValuesFor = ref<string | null>(null);
let valueDebounce: ReturnType<typeof setTimeout> | null = null;

async function ensureKeys(): Promise<void> {
  if (keyCache.value !== null) return;
  keyCache.value = [];
  try {
    const res =
      props.kind === 'trace'
        ? await bffClient.trace.tagKeys(winMinutes.value)
        : await bffClient.log.tagKeys(winMinutes.value);
    if (!res.error) keyCache.value = res.keys ?? [];
  } catch {
    /* autocomplete is best-effort */
  }
}

async function ensureValues(key: string): Promise<void> {
  if (!key || valueCache.has(key) || loadingValuesFor.value === key) return;
  loadingValuesFor.value = key;
  try {
    const res =
      props.kind === 'trace'
        ? await bffClient.trace.tagValues(key, winMinutes.value)
        : await bffClient.log.tagValues(key, winMinutes.value);
    valueCache.set(key, res.error ? [] : (res.values ?? []));
  } catch {
    valueCache.set(key, []);
  } finally {
    if (loadingValuesFor.value === key) loadingValuesFor.value = null;
  }
}

function scheduleValueFetch(key: string): void {
  if (valueDebounce) clearTimeout(valueDebounce);
  valueDebounce = setTimeout(() => void ensureValues(key), 180);
}

// ── Suggestion list ──────────────────────────────────────────────
// Before `=`: matching keys rendered `key=`. After `=`: matching values
// rendered `key=value`. Filter is case-insensitive prefix on the typed part.
const suggestions = computed<string[]>(() => {
  if (!open.value) return [];
  const frag = fragment.value;
  if (fragmentEq.value === -1) {
    const q = frag.trim().toLowerCase();
    const keys = keyCache.value ?? [];
    return keys
      .filter((k) => k.toLowerCase().startsWith(q))
      .map((k) => `${k}=`);
  }
  const key = fragmentKey.value;
  if (!key) return [];
  const typed = frag.slice(fragmentEq.value + 1).trim().toLowerCase();
  const values = valueCache.get(key) ?? [];
  return values
    .filter((v) => v.toLowerCase().startsWith(typed))
    .map((v) => `${key}=${v}`);
});

watch(suggestions, () => {
  activeIdx.value = -1;
});

// Trigger the right fetch as the fragment shape changes.
watch(
  () => [props.modelValue, open.value] as const,
  () => {
    if (!open.value) return;
    if (fragmentEq.value === -1) void ensureKeys();
    else if (fragmentKey.value) scheduleValueFetch(fragmentKey.value);
  },
);

function applySuggestion(s: string): void {
  const next = `${prefix.value}${prefix.value ? ' ' : ''}${s}`;
  emit('update:modelValue', next);
  activeIdx.value = -1;
  // Keep the dropdown alive so a key pick (`key=`) flows into value
  // suggestions; refetch the value list for the just-completed key.
  void nextTick(() => {
    if (fragmentEq.value !== -1 && fragmentKey.value) void ensureValues(fragmentKey.value);
    inputEl.value?.focus();
  });
}

// ── Input / keyboard ─────────────────────────────────────────────
function onInput(e: Event): void {
  emit('update:modelValue', (e.target as HTMLInputElement).value);
  open.value = true;
}

function onFocus(): void {
  open.value = true;
  void ensureKeys();
}

function onKeydown(e: KeyboardEvent): void {
  const list = suggestions.value;
  if (e.key === 'ArrowDown') {
    if (!open.value) open.value = true;
    e.preventDefault();
    if (list.length) activeIdx.value = (activeIdx.value + 1) % list.length;
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (list.length) activeIdx.value = (activeIdx.value - 1 + list.length) % list.length;
  } else if (e.key === 'Enter') {
    if (open.value && activeIdx.value >= 0 && list[activeIdx.value]) {
      e.preventDefault();
      applySuggestion(list[activeIdx.value]);
    } else {
      // No highlight → let the host commit (chip add / single-field run).
      open.value = false;
      emit('commit');
    }
  } else if (e.key === 'Escape') {
    if (open.value) {
      e.preventDefault();
      open.value = false;
    }
  } else if (e.key === 'Tab') {
    open.value = false;
  }
}

// A row pick uses `mousedown.prevent`, which keeps the input focused, so
// a real blur means focus left the field entirely — close the dropdown.
function onBlur(): void {
  open.value = false;
}

// Clear the in-flight value-fetch debounce if the field unmounts mid-wait.
onBeforeUnmount(() => {
  if (valueDebounce) clearTimeout(valueDebounce);
});
</script>

<template>
  <div class="tgi">
    <input
      ref="inputEl"
      class="tgi__input mono"
      type="text"
      :value="modelValue"
      :placeholder="placeholder"
      autocomplete="off"
      spellcheck="false"
      @input="onInput"
      @focus="onFocus"
      @blur="onBlur"
      @keydown="onKeydown"
    />
    <div v-if="open && suggestions.length > 0" class="tgi__panel">
      <ul class="tgi__list" role="listbox">
        <li
          v-for="(s, i) in suggestions"
          :key="s"
          class="tgi__row"
          role="option"
          :aria-selected="i === activeIdx"
          :class="{ 'is-active': i === activeIdx }"
          @mouseenter="activeIdx = i"
          @mousedown.prevent="applySuggestion(s)"
        >
          <span class="tgi__row-label">{{ s }}</span>
        </li>
      </ul>
    </div>
  </div>
</template>

<style scoped>
.tgi { position: relative; display: block; width: 100%; }

/* The input must carry its own dark style — `.cf-input` is defined in each
   host's scoped CSS and does not cross the component boundary. */
.tgi__input {
  height: 28px; padding: 0 8px; width: 100%; box-sizing: border-box;
  background: var(--sw-bg-2); border: 1px solid var(--sw-line-2); border-radius: 4px;
  color: var(--sw-fg-0); font: inherit; font-size: 11px;
}
.tgi__input.mono { font-family: var(--sw-mono); }
.tgi__input:focus { outline: none; border-color: var(--sw-accent); }

.tgi__panel {
  position: absolute; top: calc(100% + 3px); left: 0; right: 0; z-index: 60;
  background: var(--sw-bg-1); border: 1px solid var(--sw-line-2); border-radius: 5px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
  max-height: 300px; overflow-y: auto;
}
.tgi__list { list-style: none; margin: 0; padding: 5px; }
.tgi__row {
  display: flex; align-items: baseline; padding: 4px 7px; border-radius: 3px;
  font-family: var(--sw-mono); font-size: 11.5px; color: var(--sw-fg-1); cursor: pointer;
}
.tgi__row.is-active { background: var(--sw-bg-3); }
.tgi__row-label { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
</style>
