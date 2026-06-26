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
  Click-anchored translation editor for the Translations page. A
  FloatingPanel positioned next to the clicked widget, listing only that
  widget's translatable fields. Each row shows the EN source and a draft
  textarea; typing emits `update-field`, Stage emits `stage`. The wire
  path (e.g. `kpis[0].label`) is internal — the operator sees the field's
  structural KIND (title, tip, …) instead.
-->
<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import FloatingPanel from '@/components/primitives/FloatingPanel.vue';
import { vAutosize } from '@/utils/autosize';
import type { TranslatableField } from '@/features/admin/_shared/translatableFields';

defineProps<{
  open: boolean;
  anchor: HTMLElement | null;
  point: { x: number; y: number } | null;
  label: string;
  /** Native label of the target locale, shown in the panel kicker. */
  targetLabel: string;
  fields: TranslatableField[];
  saving: boolean;
  dirty: boolean;
  /** Reader for the draft value of a field path. */
  draftValue: (path: string) => string;
}>();

const emit = defineEmits<{
  close: [];
  'update-field': [path: string, value: string];
  stage: [];
}>();

const { t } = useI18n({ useScope: 'global' });

/** Human label for a translatable field shown next to the EN source.
 *  The wire path (e.g. `kpis[0].label`) is internal — translators
 *  shouldn't see it; they should see what KIND of string they're
 *  translating (title, tip, tab label, …). EN source identifies
 *  which one. */
const FIELD_LABELS: Record<string, string> = {
  title: 'Title',
  tip: 'Tip',
  description: 'Description',
  label: 'Label',
  group: 'Group',
  alias: 'Alias',
  expressionLabels: 'Series label',
  tableHeaders: 'Column header',
  slots: 'Term',
  aliases: 'Layer alias',
};
function leafLabel(segments: Array<string | number>): string {
  // Walk back to the last non-index segment — that's the field's
  // structural name. For `kpis[3].label` it's "label"; for
  // `expressionLabels[2]` it's "expressionLabels".
  for (let i = segments.length - 1; i >= 0; i--) {
    const s = segments[i];
    if (typeof s === 'string') return FIELD_LABELS[s] ?? s;
  }
  return '';
}
</script>

<template>
  <FloatingPanel
    :open="open"
    :anchor="anchor"
    :point="point"
    :width="520"
    @close="emit('close')"
  >
    <div class="fp">
      <header class="fp__head">
        <div class="fp__head-text">
          <span class="fp__kicker">EN → {{ targetLabel }}</span>
          <h4>{{ label }}</h4>
        </div>
        <button type="button" class="fp__close" @click="emit('close')">✕</button>
      </header>
      <div class="fp__rows">
        <div v-for="f in fields" :key="f.path" class="fp__row">
          <div class="fp__row-meta">
            <span class="fp__tag">{{ leafLabel(f.segments) }}</span>
            <span class="fp__src">{{ f.source }}</span>
          </div>
          <textarea
            v-autosize="draftValue(f.path) || f.source"
            :value="draftValue(f.path)"
            :placeholder="f.source"
            rows="1"
            class="fp__input"
            @input="emit('update-field', f.path, ($event.target as HTMLTextAreaElement).value)"
          ></textarea>
        </div>
      </div>
      <footer class="fp__foot">
        <button type="button" class="sw-btn" @click="emit('close')">{{ t('Close') }}</button>
        <button type="button" class="sw-btn is-primary" :disabled="saving || !dirty" @click="emit('stage')">
          {{ t('Stage local') }}
        </button>
      </footer>
    </div>
  </FloatingPanel>
</template>

<style scoped>
/* Floating panel (per-widget translation popover) */
.fp { display: flex; flex-direction: column; max-height: calc(100vh - 16px); }
.fp__head {
  display: flex; align-items: flex-start; gap: 10px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--sw-line-2);
  background: var(--sw-bg-2);
}
.fp__head-text { flex: 1; min-width: 0; }
.fp__kicker {
  font-size: 9.5px; letter-spacing: 0.06em; text-transform: uppercase;
  color: var(--sw-accent); display: block; margin-bottom: 2px;
}
.fp__head h4 { margin: 0; font-size: 13px; color: var(--sw-fg-0); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.fp__close {
  background: none; border: none; color: var(--sw-fg-3);
  cursor: pointer; font-size: 14px; padding: 0 4px;
}
.fp__close:hover { color: var(--sw-fg-1); }
.fp__rows { flex: 1; min-height: 0; overflow-y: auto; padding: 8px 12px; }
.fp__row { padding: 8px 0; border-bottom: 1px dashed var(--sw-line); }
.fp__row:last-child { border-bottom: none; }
.fp__row-meta { display: flex; align-items: baseline; gap: 8px; margin-bottom: 4px; }
.fp__tag {
  flex: 0 0 auto;
  font-size: 9.5px; letter-spacing: 0.06em; text-transform: uppercase;
  color: var(--sw-fg-3);
  background: var(--sw-bg-2); border: 1px solid var(--sw-line-2);
  padding: 1px 6px; border-radius: 3px;
}
.fp__src { font-size: 12px; color: var(--sw-fg-1); font-weight: 500; }
.fp__input {
  width: 100%; box-sizing: border-box;
  background: var(--sw-bg-2); color: var(--sw-fg-1);
  border: 1px solid var(--sw-line-2); border-radius: 3px;
  padding: 4px 6px; font-size: 12.5px; resize: vertical;
  font-family: inherit;
}
.fp__input:focus { outline: none; border-color: var(--sw-accent); }
.fp__foot {
  padding: 8px 12px;
  border-top: 1px solid var(--sw-line-2);
  display: flex; gap: 6px; justify-content: flex-end;
  background: var(--sw-bg-2);
}
</style>
