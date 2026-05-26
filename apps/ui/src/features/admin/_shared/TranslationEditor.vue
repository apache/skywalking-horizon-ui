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
  Per-template translation editor. Single target language at a time;
  EN column is fixed; saves embed the new translations into the
  template's configuration as a sibling `i18n` block. The BFF's
  localizeContent merges them at render time.

  The editor doesn't own template content — it receives the EN source
  + current i18n state from the parent admin view and emits a save
  request with the updated map. The parent owns the save path
  (templateSync.save / save-local).
-->
<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { SUPPORTED_LOCALES, LOCALE_NATIVE_LABEL, type Locale } from '@/i18n';

const { t } = useI18n({ useScope: 'global' });
import {
  walkTranslatable,
  getAtPath,
  setAtPath,
  type TranslatableField,
} from './translatableFields';

const props = defineProps<{
  /** English source content (whatever the parent currently has as the
   *  authoritative copy — local draft, remote, or bundled). */
  source: unknown;
  /** Current i18n overlays embedded in the template, keyed by locale.
   *  Loaded from `source.i18n` if present. */
  i18n?: Record<string, unknown>;
  /** True while the parent is publishing this editor's edits. Disables
   *  the save button + greys the inputs. */
  saving?: boolean;
  /** When set, rows whose path starts with this prefix get a `.focused`
   *  highlight and the first match scrolls into view. Driven by the
   *  preview pane's click-to-focus signal. */
  focusPrefix?: string;
}>();

const emit = defineEmits<{
  /** Emitted when the operator clicks Save. Payload is the COMPLETE
   *  i18n map (all locales, including unchanged ones), ready to splice
   *  into the source's configuration.i18n. */
  save: [next: Record<string, unknown>];
}>();

const targetLocales = SUPPORTED_LOCALES.filter((l) => l !== 'en');
const target = ref<Locale>(targetLocales[0]);

/** Editor draft, indexed by path string → operator-entered value.
 *  Loaded from the embedded i18n on locale switch; saved back into a
 *  full structural overlay on emit. */
const draft = ref<Record<string, string>>({});

const fields = computed<TranslatableField[]>(() => walkTranslatable(props.source));
const targetOverlay = computed<unknown>(() => props.i18n?.[target.value] ?? null);

watch(
  [target, targetOverlay],
  ([loc, overlay]) => {
    const next: Record<string, string> = {};
    for (const f of fields.value) {
      const existing = getAtPath(overlay, f.segments);
      if (existing !== undefined) next[f.path] = existing;
    }
    draft.value = next;
    void loc;
  },
  { immediate: true },
);

const showLexicon = ref(false);

/** Fields that need translator attention (operator has typed nothing
 *  and no overlay value exists). The lexicon doesn't reach here —
 *  this view is per-template prose only. */
const needsTranslation = computed<TranslatableField[]>(() =>
  fields.value.filter((f) => !draft.value[f.path] || draft.value[f.path].length === 0),
);
const filledCount = computed<number>(() => fields.value.length - needsTranslation.value.length);

const groupedFields = computed<Array<{ section: string; rows: TranslatableField[] }>>(() => {
  const visible = showLexicon.value ? fields.value : fields.value;
  const groups = new Map<string, TranslatableField[]>();
  for (const f of visible) {
    const list = groups.get(f.section) ?? [];
    list.push(f);
    groups.set(f.section, list);
  }
  return Array.from(groups, ([section, rows]) => ({ section, rows }));
});

function isFocused(f: TranslatableField): boolean {
  const p = props.focusPrefix;
  return !!p && (f.path === p || f.path.startsWith(`${p}.`) || f.path.startsWith(`${p}[`));
}

const rowRefs = ref<Map<string, HTMLElement>>(new Map());
function setRowRef(path: string, el: HTMLElement | null): void {
  if (el) rowRefs.value.set(path, el);
  else rowRefs.value.delete(path);
}

watch(
  () => props.focusPrefix,
  async (prefix) => {
    if (!prefix) return;
    await nextTick();
    const first = fields.value.find((f) => isFocused(f));
    if (!first) return;
    const el = rowRefs.value.get(first.path);
    if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  },
);

function onSave(): void {
  const overlay: Record<string, unknown> = {};
  for (const f of fields.value) {
    const v = draft.value[f.path];
    if (!v || v.length === 0) continue;
    setAtPath(overlay, f.segments, v);
  }
  const next: Record<string, unknown> = { ...(props.i18n ?? {}) };
  if (Object.keys(overlay).length === 0) {
    delete next[target.value];
  } else {
    next[target.value] = overlay;
  }
  emit('save', next);
}

const isDirty = computed<boolean>(() => {
  const overlay = targetOverlay.value;
  for (const f of fields.value) {
    const existing = getAtPath(overlay, f.segments) ?? '';
    const current = draft.value[f.path] ?? '';
    if (existing !== current) return true;
  }
  return false;
});
</script>

<template>
  <div class="te">
    <div class="te__head">
      <label class="te__lang">
        <span>{{ t('Target language') }}</span>
        <select v-model="target">
          <option v-for="loc in targetLocales" :key="loc" :value="loc">
            {{ LOCALE_NATIVE_LABEL[loc] }} ({{ loc }})
          </option>
        </select>
      </label>
      <span class="te__progress">
        {{ t('{filled} / {total} translated', { filled: filledCount, total: fields.length }) }}
      </span>
      <button
        type="button"
        class="sw-btn is-primary"
        :disabled="!isDirty || saving"
        @click="onSave"
      >
        {{ saving ? t('Saving…') : t('Save translations') }}
      </button>
    </div>

    <div v-if="fields.length === 0" class="te__empty">
      {{ t('No translatable fields in this template.') }}
    </div>

    <div v-else class="te__list">
      <div v-for="g in groupedFields" :key="g.section" class="te__group">
        <h4 class="te__section">{{ g.section }}</h4>
        <div class="te__row te__row--header">
          <span class="te__col-path">{{ t('Field') }}</span>
          <span class="te__col-src">{{ t('English (source)') }}</span>
          <span class="te__col-tgt">{{ LOCALE_NATIVE_LABEL[target] }}</span>
        </div>
        <div
          v-for="f in g.rows"
          :key="f.path"
          :ref="(el) => setRowRef(f.path, el as HTMLElement | null)"
          class="te__row"
          :class="{ 'te__row--focus': isFocused(f) }"
        >
          <code class="te__col-path" :title="f.path">{{ f.path }}</code>
          <span class="te__col-src">{{ f.source }}</span>
          <input
            v-model="draft[f.path]"
            type="text"
            class="te__col-tgt te__input"
            :placeholder="f.source"
            :disabled="saving"
          />
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.te {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-height: 0;
}
.te__head {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 8px 12px;
  background: var(--sw-bg-1);
  border: 1px solid var(--sw-line-2);
  border-radius: 6px;
}
.te__lang {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11.5px;
  color: var(--sw-fg-3);
}
.te__lang select {
  background: var(--sw-bg-2);
  color: var(--sw-fg-1);
  border: 1px solid var(--sw-line-2);
  border-radius: 4px;
  padding: 2px 6px;
  font-size: 12px;
}
.te__progress {
  font-size: 12px;
  color: var(--sw-fg-2);
}
.te__head .sw-btn {
  margin-left: auto;
}
.te__empty {
  padding: 24px;
  text-align: center;
  color: var(--sw-fg-3);
  font-size: 12.5px;
}
.te__list {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.te__group {
  border: 1px solid var(--sw-line-2);
  border-radius: 6px;
  overflow: hidden;
}
.te__section {
  margin: 0;
  padding: 8px 12px;
  font-size: 11px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--sw-fg-3);
  background: var(--sw-bg-1);
  border-bottom: 1px solid var(--sw-line-2);
}
.te__row {
  display: grid;
  grid-template-columns: minmax(140px, 1fr) minmax(160px, 1.4fr) minmax(160px, 1.4fr);
  gap: 10px;
  align-items: center;
  padding: 7px 12px;
  border-bottom: 1px solid var(--sw-line-2);
  min-height: 32px;
}
.te__row:last-child { border-bottom: none; }
.te__row--focus {
  background: rgba(255, 152, 0, 0.08);
  border-left: 2px solid var(--sw-accent);
  padding-left: 10px;
}
.te__row--header {
  font-size: 10.5px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--sw-fg-3);
}
.te__col-path {
  font-family: var(--sw-mono);
  font-size: 11px;
  color: var(--sw-fg-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.te__col-src {
  font-size: 12.5px;
  color: var(--sw-fg-2);
  white-space: pre-wrap;
  word-break: break-word;
}
.te__col-tgt {
  font-size: 12.5px;
  color: var(--sw-fg-1);
}
.te__input {
  width: 100%;
  background: var(--sw-bg-2);
  color: var(--sw-fg-1);
  border: 1px solid var(--sw-line-2);
  border-radius: 4px;
  padding: 4px 6px;
  font-size: 12.5px;
}
.te__input:focus {
  outline: none;
  border-color: var(--sw-accent);
}
</style>
