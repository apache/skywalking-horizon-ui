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
  Type-to-filter combobox. Reads `modelValue` (the selected option's
  value), shows the selected option's label in a read-only-looking
  input; clicking the input opens a dropdown with a search box and
  the case-insensitively filtered options.

  Designed for moderate option counts (dozens to a few hundred) —
  rendered all at once, no virtual scroll. Keyboard: ArrowDown / Up
  navigates, Enter selects, Esc closes.
-->
<script setup lang="ts" generic="V extends string | number">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { buildGroupedRows, flattenGroupedRows, reindexActiveAfterExpand, type GroupedSection } from './groupedOptions';

const { t } = useI18n({ useScope: 'global' });

interface Opt {
  value: V;
  label: string;
  /** Optional secondary text shown right-aligned in the row (e.g. key tag). */
  hint?: string;
  /** `accent` for a hint worth spotting at a glance; `muted` is the default. */
  hintTone?: 'accent' | 'muted';
  /** When ANY option carries one, the panel renders sections with headers. */
  group?: string;
}

const props = defineProps<{
  modelValue: V | null;
  options: Opt[];
  placeholder?: string;
  disabled?: boolean;
  ariaLabel?: string;
  /** Minimum width of the dropdown panel. The trigger sizes to its own
   *  content; the dropdown is `max(triggerWidth, minPanelWidth)`. */
  minPanelWidth?: number;
  /** Stretch to the container's width instead of sizing to the label. Long
   *  identifiers (service names with a group prefix) truncate otherwise. */
  block?: boolean;
}>();

const emit = defineEmits<{ 'update:modelValue': [V] }>();

const open = ref(false);
const query = ref('');
const activeIdx = ref(0);
const root = ref<HTMLElement | null>(null);
const searchEl = ref<HTMLInputElement | null>(null);

const selectedLabel = computed<string>(() => {
  const m = props.options.find((o) => o.value === props.modelValue);
  return m?.label ?? '';
});

/** Rows rendered at once. Scrolling is not a bound — every option was still
 *  mounted, so a 200-service picker built 200 rows on open. */
const PAGE = 50;
const page = ref(1);

const filtered = computed<Opt[]>(() => {
  const q = query.value.trim().toLowerCase();
  if (!q) return props.options;
  return props.options.filter((o) => {
    if (o.label.toLowerCase().includes(q)) return true;
    if (o.hint && o.hint.toLowerCase().includes(q)) return true;
    return false;
  });
});

const visible = computed<Opt[]>(() => filtered.value.slice(0, page.value * PAGE));
/** Sections over the VISIBLE slice, so grouping does not re-introduce the
 *  unbounded render paging just removed. Keyboard nav and the initial-open
 *  seek address `displayRows`, NOT `visible` — see groupedOptions.ts for why
 *  a row's position in `visible` and its on-screen position can differ. */
const grouped = computed<GroupedSection<Opt>[]>(() => buildGroupedRows(visible.value));
const displayRows = computed<Opt[]>(() => flattenGroupedRows(grouped.value));
const showGroups = computed(() => grouped.value.some((g) => g.name) && grouped.value.length > 1);
const heldBack = computed(() => Math.max(0, filtered.value.length - visible.value.length));
watch([query, open], () => {
  page.value = 1;
});

watch(filtered, () => {
  activeIdx.value = 0;
});

function toggle(): void {
  if (props.disabled) return;
  open.value = !open.value;
  if (open.value) {
    query.value = '';
    // Seed AFTER the query/open watchers reset the window. `activeIdx` indexes
    // the RENDERED slice, so a selection past the page had no row and made
    // Enter a dead key.
    void nextTick(() => {
      const idx = filtered.value.findIndex((o) => o.value === props.modelValue);
      page.value = idx < 0 ? 1 : Math.ceil((idx + 1) / PAGE);
      // Re-look-up in DISPLAY order, not `idx` — grouping can move the
      // selected row to a different position than its place in `filtered`.
      const dIdx = displayRows.value.findIndex((o) => o.value === props.modelValue);
      activeIdx.value = Math.max(0, dIdx);
      searchEl.value?.focus();
    });
  }
}

function pick(o: Opt): void {
  emit('update:modelValue', o.value);
  open.value = false;
}

function onKey(e: KeyboardEvent): void {
  if (!open.value) return;
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    // Bound to what is RENDERED, in DISPLAY (grouped) order; reaching the end
    // reveals the next page.
    if (activeIdx.value >= displayRows.value.length - 1 && heldBack.value > 0) {
      const activeValue = displayRows.value[activeIdx.value]?.value;
      page.value += 1;
      activeIdx.value = reindexActiveAfterExpand(displayRows.value, activeValue);
    } else {
      activeIdx.value = Math.min(displayRows.value.length - 1, activeIdx.value + 1);
    }
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    activeIdx.value = Math.max(0, activeIdx.value - 1);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    const o = displayRows.value[activeIdx.value];
    if (o) pick(o);
  } else if (e.key === 'Escape') {
    open.value = false;
  }
}

function onDocClick(e: MouseEvent): void {
  if (!root.value) return;
  if (!root.value.contains(e.target as Node)) open.value = false;
}
document.addEventListener('click', onDocClick);
onBeforeUnmount(() => document.removeEventListener('click', onDocClick));
</script>

<template>
  <div ref="root" class="tas" :class="{ 'is-open': open, 'is-disabled': disabled, 'is-block': block }">
    <button
      type="button"
      class="tas__trigger"
      :disabled="disabled"
      :aria-label="ariaLabel"
      aria-haspopup="listbox"
      :aria-expanded="open"
      @click="toggle"
    >
      <span class="tas__label" :class="{ 'tas__label--ph': !selectedLabel }">
        {{ selectedLabel || placeholder || t('Select…') }}
      </span>
      <span class="tas__caret" aria-hidden="true">▾</span>
    </button>
    <div
      v-if="open"
      class="tas__panel"
      :style="{ minWidth: (minPanelWidth ?? 220) + 'px' }"
      @keydown="onKey"
    >
      <input
        ref="searchEl"
        v-model="query"
        type="text"
        class="tas__search"
        :placeholder="t('Filter…')"
        @keydown="onKey"
      />
      <!-- Optional filter row, directly under the search — the same shape the
           layer-template picker uses. Kept a slot so the primitive stays
           feature-agnostic: it provides the place, the caller provides the
           predicate and does its own filtering of `options`. -->
      <div v-if="$slots.filters" class="tas__filters">
        <slot name="filters" />
      </div>
      <ul class="tas__list" role="listbox">
        <li v-if="filtered.length === 0" class="tas__empty">{{ t('No matches') }}</li>
        <template v-for="g in grouped" :key="g.name || '_'">
          <li v-if="showGroups && g.name" class="tas__group">{{ g.name }}</li>
          <li
            v-for="{ o, i } in g.rows"
            :key="String(o.value)"
            class="tas__row"
            role="option"
            :aria-selected="o.value === modelValue"
            :class="{ 'is-active': i === activeIdx, 'is-selected': o.value === modelValue }"
            @mouseenter="activeIdx = i"
            @click="pick(o)"
          >
            <span class="tas__row-label">{{ o.label }}</span>
            <span
              v-if="o.hint"
              class="tas__row-hint"
              :class="{ 'tas__row-hint--accent': o.hintTone === 'accent' }"
            >{{ o.hint }}</span>
          </li>
        </template>
      </ul>
      <!-- Never a silent cut: name what is held back and how to reach it. -->
      <div v-if="heldBack" class="tas__more">
        <span>{{ t('Showing {shown} of {total}', { shown: visible.length, total: filtered.length }) }}</span>
        <button type="button" class="tas__more-btn" @mousedown.prevent="page += 1">
          {{ t('Show more') }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.tas { position: relative; display: inline-block; }
.tas.is-block { display: block; width: 100%; }
.tas.is-block .tas__trigger { width: 100%; max-width: none; }
/* The panel tracks the trigger when block, so the two edges line up instead of
   a narrow menu hanging under a full-width control. */
.tas.is-block .tas__panel { width: 100%; }
.tas__trigger {
  display: inline-flex; align-items: center; gap: 8px;
  background: var(--sw-bg-2); color: var(--sw-fg-1);
  border: 1px solid var(--sw-line-2); border-radius: 4px;
  padding: 3px 8px; font-size: 12px;
  min-width: 160px; max-width: 360px;
  cursor: pointer;
  font: inherit;
}
.tas__trigger:hover:not(:disabled) { border-color: var(--sw-fg-3); }
.tas.is-open .tas__trigger { border-color: var(--sw-accent); }
.tas__trigger:disabled { opacity: 0.55; cursor: not-allowed; }
.tas__label {
  flex: 1;
  text-align: left;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.tas__label--ph { color: var(--sw-fg-3); }
.tas__caret { font-size: 10px; color: var(--sw-fg-3); flex: 0 0 auto; }

.tas__panel {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  z-index: 50;
  background: var(--sw-bg-1);
  border: 1px solid var(--sw-line-2);
  border-radius: 4px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
  padding: 6px;
  max-width: 480px;
}
.tas__search {
  width: 100%;
  background: var(--sw-bg-2); color: var(--sw-fg-1);
  border: 1px solid var(--sw-line-2); border-radius: 3px;
  padding: 3px 6px; font-size: 12px;
  margin-bottom: 4px;
}
.tas__search:focus { outline: none; border-color: var(--sw-accent); }
.tas__list {
  list-style: none; margin: 0; padding: 0;
  max-height: 320px; overflow-y: auto;
}
.tas__empty { padding: 10px 8px; font-size: 12px; color: var(--sw-fg-3); text-align: center; }
.tas__group {
  padding: 6px 8px 2px;
  font-size: 10.5px;
  font-family: var(--sw-mono);
  color: var(--sw-fg-3);
  text-transform: uppercase;
  letter-spacing: var(--sw-ls-caps);
  position: sticky;
  top: 0;
  background: var(--sw-bg-1);
}
.tas__row {
  display: flex; align-items: center; gap: 10px;
  padding: 5px 8px; border-radius: 3px;
  font-size: 12px; color: var(--sw-fg-1);
  cursor: pointer;
}
.tas__row.is-active { background: var(--sw-bg-2); }
.tas__row.is-selected { color: var(--sw-accent); }
.tas__row-label { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tas__filters {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 0 8px 8px;
  border-bottom: 1px solid var(--sw-line);
  margin-bottom: 4px;
  align-items: center;
}
.tas__row-hint {
  font-family: var(--sw-mono);
  font-size: 10.5px;
  color: var(--sw-fg-3);
  margin-left: auto;
  flex: 0 0 auto;
  white-space: nowrap;
}
.tas__more {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 8px;
  border-top: 1px solid var(--sw-line);
  font-size: 11px;
  color: var(--sw-fg-3);
}
.tas__more-btn {
  background: none;
  border: 1px solid var(--sw-line-2);
  border-radius: 3px;
  color: var(--sw-fg-1);
  font: inherit;
  padding: 1px 8px;
  cursor: pointer;
}
.tas__row-hint--accent {
  color: var(--sw-accent);
  border: 1px solid var(--sw-accent-line, var(--sw-line-2));
  border-radius: var(--sw-radius);
  padding: 0 6px;
}
</style>
