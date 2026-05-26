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
  Reusable template-picker chip-button + dropdown matching the visual
  theme used by the layer/overview-templates admin pages: colored bullet
  + display name + key-tag + per-row sync badge, with a search input,
  Diverged / Local filter checkboxes, and a footer carrying the total
  count + a refresh-from-remote action.

  Stateless beyond search + filter state — the parent owns the entries
  list, selected value, and refresh trigger.
-->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import TemplateStatusBadge from './TemplateStatusBadge.vue';
import type { TemplateStatus } from '@/api/scopes/configs';

export interface TemplatePickerEntry {
  /** Wire value (typically the canonical template name `horizon.<kind>.<id>`). */
  value: string;
  /** Display name (alias / title). */
  label: string;
  /** Original key tag shown next to the label (layer key / dashboard id).
   *  Omitted from the row when identical to `label`. */
  key: string;
  /** Optional bullet color (layers have one; overviews fall back to muted). */
  color?: string;
  /** Sync state — drives the SYNCED / DIVERGED / DISABLED / … badge. */
  syncBadge?: TemplateStatus | null;
  /** True when the operator has an unpublished local draft for this entry. */
  hasLocalDraft?: boolean;
  /** True when the entry's content differs from the live OAP version. */
  isDiverged?: boolean;
  /** Optional per-locale status chips rendered after the source badge.
   *  Only the Translations picker passes this — every other admin
   *  consumer omits it and the chip row stays hidden. Status vocabulary
   *  matches `syncBadge` (synced / diverged / remote-only / disabled /
   *  bundled-fallback), plus `local` when there's an unstaged draft for
   *  that (template, locale) and `empty` when no overlay row exists
   *  anywhere. */
  localeBadges?: Array<{ locale: string; status: TemplateStatus | 'local' | 'empty' }>;
}

const props = defineProps<{
  modelValue: string | null;
  entries: TemplatePickerEntry[];
  /** Plural noun for empty / count strings ("layers", "dashboards"). */
  kindLabel: string;
  disabled?: boolean;
  refreshing?: boolean;
}>();

const emit = defineEmits<{
  'update:modelValue': [v: string];
  refresh: [];
}>();

const open = ref(false);
const search = ref('');
const divergedOnly = ref(false);
const localOnly = ref(false);
const root = ref<HTMLElement | null>(null);
const searchEl = ref<HTMLInputElement | null>(null);

const selected = computed<TemplatePickerEntry | null>(() => {
  return props.entries.find((e) => e.value === props.modelValue) ?? null;
});

const divergedCount = computed<number>(() => props.entries.filter((e) => e.isDiverged).length);
const localCount = computed<number>(() => props.entries.filter((e) => e.hasLocalDraft).length);

const filtered = computed<TemplatePickerEntry[]>(() => {
  const q = search.value.trim().toLowerCase();
  return props.entries.filter((e) => {
    if (divergedOnly.value && !e.isDiverged) return false;
    if (localOnly.value && !e.hasLocalDraft) return false;
    if (!q) return true;
    return e.label.toLowerCase().includes(q) || e.key.toLowerCase().includes(q);
  });
});

function toggle(): void {
  if (props.disabled) return;
  open.value = !open.value;
  if (open.value) {
    void nextTick(() => searchEl.value?.focus());
  }
}

function pick(e: TemplatePickerEntry): void {
  emit('update:modelValue', e.value);
  open.value = false;
}

function onDocClick(e: MouseEvent): void {
  if (!open.value || !root.value) return;
  if (!root.value.contains(e.target as Node)) open.value = false;
}
function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape' && open.value) open.value = false;
}
document.addEventListener('click', onDocClick);
document.addEventListener('keydown', onKey);
onBeforeUnmount(() => {
  document.removeEventListener('click', onDocClick);
  document.removeEventListener('keydown', onKey);
});

// Reset the search when the dropdown closes so it doesn't surprise the
// operator the next time they open it on a different entry.
watch(open, (v) => {
  if (!v) search.value = '';
});
</script>

<template>
  <div ref="root" class="tp">
    <button
      type="button"
      class="tp-btn"
      :class="{ 'is-open': open, 'is-disabled': disabled }"
      :disabled="disabled"
      @click="toggle"
    >
      <span v-if="selected" class="tp-bullet" :style="{ background: selected.color || 'var(--sw-fg-3)' }" />
      <span class="tp-name">{{ selected?.label ?? `Select a ${kindLabel.replace(/s$/, '')}…` }}</span>
      <code v-if="selected && selected.key && selected.key !== selected.label" class="tp-key">{{ selected.key }}</code>
      <span v-if="selected?.hasLocalDraft" class="tp-local" title="Unpublished local draft">local</span>
      <TemplateStatusBadge v-if="selected" :status="selected.syncBadge ?? null" />
      <span v-if="selected?.localeBadges?.length" class="tp-locales">
        <span
          v-for="lb in selected.localeBadges"
          :key="lb.locale"
          class="tp-loc"
          :class="`tp-loc--${lb.status}`"
          :title="`${lb.locale}: ${lb.status}`"
        >{{ lb.locale }}</span>
      </span>
      <span class="tp-caret" :class="{ open }">›</span>
    </button>

    <template v-if="open">
      <div class="tp-pop sw-card">
        <div class="tp-search-wrap">
          <input
            ref="searchEl"
            v-model="search"
            type="text"
            class="tp-search"
            :placeholder="`Search ${kindLabel}…`"
            autocomplete="off"
            spellcheck="false"
          />
        </div>
        <div class="tp-filters">
          <label
            class="tp-filter"
            :class="{ on: divergedOnly }"
            :title="divergedCount === 0
              ? `No ${kindLabel} differ from OAP`
              : `${divergedCount} ${kindLabel} differ from OAP`"
          >
            <input v-model="divergedOnly" type="checkbox" :disabled="divergedCount === 0" />
            Diverged<span v-if="divergedCount" class="tp-filter-count">{{ divergedCount }}</span>
          </label>
          <label
            class="tp-filter local"
            :class="{ on: localOnly }"
            :title="localCount === 0
              ? 'No unpublished local drafts in this browser'
              : `${localCount} unpublished local draft(s)`"
          >
            <input v-model="localOnly" type="checkbox" :disabled="localCount === 0" />
            Local<span v-if="localCount" class="tp-filter-count local">{{ localCount }}</span>
          </label>
        </div>
        <div class="tp-list">
          <button
            v-for="e in filtered"
            :key="e.value"
            class="tp-row"
            :class="{ active: modelValue === e.value }"
            @click="pick(e)"
          >
            <span class="tp-bullet" :style="{ background: e.color || 'var(--sw-fg-3)' }" />
            <span class="tp-name">{{ e.label }}</span>
            <code v-if="e.key && e.key !== e.label" class="tp-key">{{ e.key }}</code>
            <span v-if="e.hasLocalDraft" class="tp-local" title="Unpublished local draft">local</span>
            <TemplateStatusBadge :status="e.syncBadge ?? null" />
            <span v-if="e.localeBadges?.length" class="tp-locales">
              <span
                v-for="lb in e.localeBadges"
                :key="lb.locale"
                class="tp-loc"
                :class="`tp-loc--${lb.status}`"
                :title="`${lb.locale}: ${lb.status}`"
              >{{ lb.locale }}</span>
            </span>
          </button>
          <p v-if="filtered.length === 0" class="tp-empty">
            {{ divergedOnly && !search.trim()
              ? `No ${kindLabel} differ from OAP.`
              : `No ${kindLabel} match “${search}”.` }}
          </p>
        </div>
        <div class="tp-foot">
          <span class="tp-foot-sub">{{ entries.length }} {{ kindLabel }}</span>
          <button
            type="button"
            class="sw-btn tp-refresh"
            :disabled="refreshing"
            title="Force the BFF to re-read every UI-template from OAP (clears the 30s cache)"
            @click="emit('refresh')"
          >{{ refreshing ? 'refreshing…' : 'refresh from remote' }}</button>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.tp { position: relative; display: inline-flex; }
.tp-btn {
  display: inline-flex; align-items: center; gap: 8px;
  height: 30px; padding: 0 10px;
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line-2);
  border-radius: 6px;
  color: var(--sw-fg-0);
  font: inherit; font-size: 12px; font-weight: 600;
  min-width: 240px;
  cursor: pointer;
}
.tp-btn:hover:not(:disabled) { background: var(--sw-bg-3); }
.tp-btn.is-open { border-color: var(--sw-accent); }
.tp-btn:disabled { opacity: 0.55; cursor: not-allowed; }
.tp-bullet {
  width: 7px; height: 7px;
  border-radius: 50%;
  flex: 0 0 7px;
}
.tp-name {
  max-width: 260px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.tp-key {
  flex: 0 0 auto;
  font-family: var(--sw-mono);
  font-size: 9.5px; letter-spacing: 0.02em;
  color: var(--sw-fg-3); background: var(--sw-bg-2);
  padding: 1px 5px; border-radius: 3px;
}
.tp-btn .tp-key { background: var(--sw-bg-1); }
.tp-local {
  flex: 0 0 auto;
  font-size: 9px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase;
  color: #1a1a1a; background: var(--sw-warn, #f59e0b);
  padding: 1px 6px; border-radius: 8px;
}
.tp-caret {
  margin-left: auto;
  transform: rotate(90deg);
  transition: transform 0.15s;
  font-size: 13px; color: var(--sw-fg-3);
}
.tp-caret.open { transform: rotate(-90deg); }

.tp-pop {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  z-index: 41;
  width: min(80vw, 760px);
  max-height: 420px;
  display: flex; flex-direction: column;
  padding: 8px 0;
  box-shadow: 0 12px 32px -8px rgba(0, 0, 0, 0.5);
}
.tp-search-wrap { padding: 0 10px 8px; }
.tp-search {
  width: 100%; box-sizing: border-box;
  background: var(--sw-bg-1);
  border: 1px solid var(--sw-line-2);
  border-radius: 5px;
  color: var(--sw-fg-0);
  font: inherit; font-size: 11.5px;
  padding: 5px 8px;
}
.tp-search:focus { outline: none; border-color: var(--sw-accent); }

.tp-filters {
  display: flex; gap: 14px;
  padding: 0 10px 8px;
  margin-bottom: 4px;
  border-bottom: 1px solid var(--sw-line);
}
.tp-filter {
  display: inline-flex; align-items: center; gap: 5px;
  font-size: 11px; color: var(--sw-fg-2);
  cursor: pointer; user-select: none;
}
.tp-filter input:disabled { cursor: not-allowed; }
.tp-filter.on { color: var(--sw-fg-0); }
.tp-filter-count {
  margin-left: 2px; padding: 0 5px;
  border-radius: 8px;
  background: var(--sw-warn, var(--sw-accent));
  color: #1a1a1a;
  font-size: 10px; font-weight: 700;
}

.tp-list {
  overflow-y: auto;
  padding: 0 6px;
  display: flex; flex-direction: column; gap: 2px;
  flex: 1; min-height: 0;
}
.tp-row {
  display: flex; align-items: center; gap: 8px;
  padding: 7px 10px;
  border-radius: 5px;
  background: transparent; border: none;
  color: var(--sw-fg-1); font: inherit; font-size: 12px;
  cursor: pointer;
  text-align: left;
}
.tp-row:hover { background: var(--sw-bg-2); }
.tp-row.active {
  background: var(--sw-bg-3);
  color: var(--sw-fg-0);
  box-shadow: inset 2px 0 0 var(--sw-accent);
}
.tp-row .tp-name { flex: 1; max-width: none; }
.tp-empty {
  padding: 12px 14px;
  margin: 0;
  font-size: 11px;
  color: var(--sw-fg-3);
}

.tp-foot {
  display: flex; align-items: center; gap: 10px;
  padding: 8px 10px;
  border-top: 1px solid var(--sw-line-2);
}
.tp-foot-sub { font-size: 10.5px; color: var(--sw-fg-3); }
.tp-refresh { margin-left: auto; font-size: 11px; height: 24px; padding: 0 8px; }

/* Per-locale translation status chips, used only by the Translations
 * picker. Colors follow the same palette as TemplateStatusBadge so the
 * vocabulary stays consistent (green = synced, orange = diverged, …). */
.tp-locales {
  display: inline-flex;
  flex: 0 0 auto;
  gap: 3px;
  margin-left: 4px;
}
.tp-loc {
  font-family: var(--sw-mono);
  font-size: 9px;
  font-weight: 600;
  letter-spacing: 0.04em;
  padding: 1px 5px;
  border-radius: 3px;
  border: 1px solid transparent;
  text-transform: lowercase;
  white-space: nowrap;
  line-height: 1.3;
}
.tp-loc--synced {
  background: rgba(34, 197, 94, 0.14);
  color: #4ade80;
  border-color: rgba(34, 197, 94, 0.3);
}
.tp-loc--diverged {
  background: rgba(245, 158, 11, 0.14);
  color: #fbbf24;
  border-color: rgba(245, 158, 11, 0.3);
}
.tp-loc--remote-only {
  background: rgba(59, 130, 246, 0.14);
  color: #60a5fa;
  border-color: rgba(59, 130, 246, 0.3);
}
.tp-loc--bundled-fallback {
  background: rgba(148, 163, 184, 0.14);
  color: #cbd5e1;
  border-color: rgba(148, 163, 184, 0.3);
}
.tp-loc--disabled,
.tp-loc--unknown {
  background: var(--sw-bg-2);
  color: var(--sw-fg-3);
  border-color: var(--sw-line);
}
.tp-loc--local {
  background: var(--sw-warn, #f59e0b);
  color: #1a1a1a;
  border-color: transparent;
}
.tp-loc--empty {
  background: transparent;
  color: var(--sw-fg-3);
  border-color: var(--sw-line);
  opacity: 0.55;
}
</style>
