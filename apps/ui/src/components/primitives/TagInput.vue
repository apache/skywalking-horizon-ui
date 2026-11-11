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

  Suggests tag KEYS (rendered `key=`) before the operator types `=`, and
  per-key VALUES (rendered `key=value`) after — OAP's native trace/log tags
  by `kind`, or whatever a host passes as `suggestions`. The suggestion
  completes the whole text, or — for a host whose field holds several terms
  — the term after the last `separator`: `,` for cross-layer inspect's
  list, ` and ` for Zipkin's annotation query. A single tag's value may hold
  a comma, so a host without a list must not pass one.

  `commit` fires on bare Enter when no suggestion is highlighted — a host
  with a chip model uses it to add a chip; single-field hosts can ignore it.
  A host that refuses the text, or runs without it, says so with the exposed
  `notify`: the note covers the field for five seconds, or until the text
  changes or the note is clicked.
-->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from 'vue';

import { bffClient } from '@/api/client';
import type { TagSuggestions } from './tagFilter';

const props = withDefaults(
  defineProps<{
    modelValue: string;
    kind?: 'trace' | 'log';
    suggestions?: TagSuggestions | null;
    separator?: string;
    windowMinutes?: number;
    placeholder?: string;
    disabled?: boolean;
  }>(),
  { kind: undefined, suggestions: null, separator: '', windowMinutes: 30, placeholder: '', disabled: false },
);

const emit = defineEmits<{
  'update:modelValue': [string];
  commit: [];
}>();

const root = ref<HTMLElement | null>(null);
const inputEl = ref<HTMLInputElement | null>(null);
const open = ref(false);
const activeIdx = ref(-1);

/**
 * The panel renders in a Teleport, positioned from the input's viewport rect,
 * as {@link TypeaheadSelect} does and for the same reason: an absolutely
 * positioned panel is cropped by any ancestor that clips, and every host here
 * puts this field inside an `.sw-card`, which does. Half the suggestion list
 * was cut off by the card's edge with no way to reach the rest.
 */
const panelStyle = ref<Record<string, string>>({});
const GAP = 3;
const EDGE = 8;

function place(): void {
  const el = inputEl.value;
  if (!el) return;
  const r = el.getBoundingClientRect();
  const below = window.innerHeight - r.bottom - GAP - EDGE;
  const above = r.top - GAP - EDGE;
  // Flip up only when below cannot hold a usable list AND above is roomier,
  // or the panel jumps as the list filters.
  const up = below < 140 && above > below;
  panelStyle.value = {
    left: `${Math.max(EDGE, Math.min(r.left, window.innerWidth - r.width - EDGE))}px`,
    width: `${r.width}px`,
    maxHeight: `${Math.max(120, Math.min(300, up ? above : below))}px`,
    ...(up ? { bottom: `${window.innerHeight - r.top + GAP}px` } : { top: `${r.bottom + GAP}px` }),
  };
}

/** Re-measure on ANY ancestor scroll (capture), not just the window's: the
 *  input moves with the container it sits in, and a panel pinned to stale
 *  coordinates detaches from it. */
function trackInput(on: boolean): void {
  const fn = on ? window.addEventListener : window.removeEventListener;
  fn('scroll', place, true);
  fn('resize', place);
}
watch(open, (v) => {
  trackInput(v);
  if (v) void nextTick(place);
});
onBeforeUnmount(() => trackInput(false));

// Effective suggest window — hosts may pass a custom-range sentinel (-1);
// fall back to a sane default so the suggest call still hits real data.
const winMinutes = computed<number>(() =>
  props.windowMinutes && props.windowMinutes > 0 ? props.windowMinutes : 30,
);

// Suggestions operate on the text after the last separator; everything
// before it is preserved verbatim when a suggestion is applied.
const prefixEnd = computed<number>(() => {
  if (!props.separator) return 0;
  const at = props.modelValue.lastIndexOf(props.separator);
  return at === -1 ? 0 : at + props.separator.length;
});
const prefix = computed<string>(() => props.modelValue.slice(0, prefixEnd.value));
const fragment = computed<string>(() => props.modelValue.slice(prefixEnd.value).replace(/^\s+/, ''));
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
  if (props.suggestions || !props.kind || keyCache.value !== null) return;
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
  if (!key) return;
  if (props.suggestions) {
    props.suggestions.loadValues(key);
    return;
  }
  if (!props.kind || valueCache.has(key) || loadingValuesFor.value === key) return;
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

// Before `=`: matching keys rendered `key=`. After `=`: matching values
// rendered `key=value`. Filter is case-insensitive prefix on the typed part.
const suggestions = computed<string[]>(() => {
  if (!open.value) return [];
  const frag = fragment.value;
  if (fragmentEq.value === -1) {
    const q = frag.trim().toLowerCase();
    const keys = props.suggestions ? props.suggestions.keys : (keyCache.value ?? []);
    return keys
      .filter((k) => k.toLowerCase().startsWith(q))
      .map((k) => `${k}=`);
  }
  const key = fragmentKey.value;
  if (!key) return [];
  const typed = frag.slice(fragmentEq.value + 1).trim().toLowerCase();
  const values = props.suggestions ? props.suggestions.valuesFor(key) : (valueCache.get(key) ?? []);
  return values
    .filter((v) => v.toLowerCase().startsWith(typed))
    .map((v) => `${key}=${v}`);
});

// A list that grew or shrank changes the panel's height, so its placement is
// re-measured — it is positioned from the input, not laid out beside it.
watch(() => suggestions.value.length, () => { if (open.value) void nextTick(place); });
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
  const next = `${prefix.value}${prefix.value && !/\s$/.test(prefix.value) ? ' ' : ''}${s}`;
  emit('update:modelValue', next);
  activeIdx.value = -1;
  // Keep the dropdown alive so a key pick (`key=`) flows into value
  // suggestions; refetch the value list for the just-completed key.
  void nextTick(() => {
    if (fragmentEq.value !== -1 && fragmentKey.value) void ensureValues(fragmentKey.value);
    inputEl.value?.focus();
  });
}

function onInput(e: Event): void {
  emit('update:modelValue', (e.target as HTMLInputElement).value);
  open.value = true;
}

function onFocus(): void {
  open.value = true;
  void ensureKeys();
}

function onKeydown(e: KeyboardEvent): void {
  // Keys pressed while an IME composes are the IME's: Enter confirms its
  // candidate and the arrows move through them. Safari sends the confirming
  // Enter after `compositionend`, flagged only by keyCode 229.
  if (e.isComposing || e.keyCode === 229) return;
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
      // The keypress bubbles to window, where every open box listens; closing
      // this suggestion list must not close what the field sits inside.
      e.stopPropagation();
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

const NOTE_MS = 5000;
const note = ref<{ text: string; tone: 'warn' | 'err' } | null>(null);
let noteTimer: ReturnType<typeof setTimeout> | null = null;
function clearNote(): void {
  if (noteTimer) clearTimeout(noteTimer);
  noteTimer = null;
  note.value = null;
}
function notify(text: string, tone: 'warn' | 'err' = 'warn'): void {
  clearNote();
  note.value = { text, tone };
  noteTimer = setTimeout(clearNote, NOTE_MS);
}
/** The note covers the field, so a click on it is a click meant for the field. */
function dismissNote(): void {
  clearNote();
  inputEl.value?.focus();
}
// The note is about the text it was raised over; once that changes — the
// operator fixed it, or Enter added it — it no longer describes the field.
watch(() => props.modelValue, clearNote);
defineExpose({ notify });

onBeforeUnmount(() => {
  if (valueDebounce) clearTimeout(valueDebounce);
  clearNote();
});
</script>

<template>
  <div ref="root" class="tgi">
    <input
      ref="inputEl"
      class="tgi__input mono"
      type="text"
      :value="modelValue"
      :placeholder="placeholder"
      :disabled="disabled"
      autocomplete="off"
      spellcheck="false"
      @input="onInput"
      @focus="onFocus"
      @blur="onBlur"
      @keydown="onKeydown"
    />
    <Transition name="tgi-note">
      <span
        v-if="note"
        class="tgi__note"
        :class="`tgi__note--${note.tone}`"
        role="status"
        :title="note.text"
        @mousedown.prevent="dismissNote"
      >{{ note.text }}</span>
    </Transition>
    <Teleport to="body">
      <div v-if="open && suggestions.length > 0" class="tgi__panel" :style="panelStyle">
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
    </Teleport>
  </div>
</template>

<style scoped>
.tgi__input:disabled { opacity: 0.5; cursor: not-allowed; }
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
/* Drawn over the field rather than under it, so raising one never moves the
   form. The soft tints are translucent, hence the opaque field colour beneath
   them: the text under the note must not show through. */
.tgi__note {
  position: absolute; inset: 0; z-index: 1;
  display: flex; align-items: center; padding: 0 8px; box-sizing: border-box;
  border: 1px solid; border-radius: 4px;
  font-size: 11px; font-weight: 500; line-height: 1;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  cursor: text;
}
.tgi__note--warn {
  color: var(--sw-warn); border-color: var(--sw-warn);
  background: linear-gradient(var(--sw-warn-soft), var(--sw-warn-soft)), var(--sw-bg-2);
}
.tgi__note--err {
  color: var(--sw-err); border-color: var(--sw-err);
  background: linear-gradient(var(--sw-err-soft), var(--sw-err-soft)), var(--sw-bg-2);
}
.tgi-note-enter-active, .tgi-note-leave-active { transition: opacity 0.15s ease; }
.tgi-note-enter-from, .tgi-note-leave-to { opacity: 0; }

/* Fixed, in `body`: the coordinates come from `place()` because the panel no
   longer sits next to the input in the DOM. The z-index clears the cards and
   the sticky toolbars it now draws over, and stays under the modal layer. */
.tgi__panel {
  position: fixed; z-index: 1200;
  background: var(--sw-bg-1); border: 1px solid var(--sw-line-2); border-radius: 5px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
  overflow-y: auto;
}
.tgi__list { list-style: none; margin: 0; padding: 5px; }
.tgi__row {
  display: flex; align-items: baseline; padding: 4px 7px; border-radius: 3px;
  font-family: var(--sw-mono); font-size: 11.5px; color: var(--sw-fg-1); cursor: pointer;
}
.tgi__row.is-active { background: var(--sw-bg-3); }
.tgi__row-label { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
</style>
