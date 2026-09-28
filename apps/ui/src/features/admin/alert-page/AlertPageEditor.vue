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
  The fields of one alert page. The default page keeps its three settings
  (pins, window, the overview widget's cap); a named page adds a title and an
  order, and may leave its window to the default page's.
-->
<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  ALARMS_WINDOW_OPTIONS,
  OVERVIEW_ALARMS_LIMIT_DEFAULT,
  OVERVIEW_ALARMS_LIMIT_MAX,
  OVERVIEW_ALARMS_LIMIT_MIN,
} from '@/api/client';
import AlertPinEditor from './AlertPinEditor.vue';
import {
  MAX_PINS,
  ORDER_DEFAULT,
  ORDER_MAX,
  ORDER_MIN,
  TITLE_MAX,
  type DraftProblems,
  type PageDraft,
} from './alertPages';

const { t } = useI18n({ useScope: 'global' });

const props = defineProps<{
  pageId: string;
  isDefault: boolean;
  /** Not on OAP yet: there is no page to open. */
  isNew: boolean;
  draft: PageDraft;
  problems: DraftProblems;
  knownLayers: string[];
  readOnly: boolean;
  /** The default page's window, which a named page inherits. */
  inheritedWindowMs: number;
}>();

const emit = defineEmits<{ update: [patch: Partial<PageDraft>] }>();

const WINDOW_LABELS = computed<Record<number, string>>(() => ({
  [20 * 60_000]: t('20 minutes'),
  [2 * 60 * 60_000]: t('2 hours'),
  [4 * 60 * 60_000]: t('4 hours'),
}));

const windowOptions = computed<Array<{ value: number | null; label: string }>>(() => {
  const fixed = ALARMS_WINDOW_OPTIONS.map((ms) => ({ value: ms as number | null, label: WINDOW_LABELS.value[ms] ?? '—' }));
  if (props.isDefault) return fixed;
  return [
    {
      value: null,
      label: t('Same as the default page ({window})', {
        window: WINDOW_LABELS.value[props.inheritedWindowMs] ?? '—',
      }),
    },
    ...fixed,
  ];
});

const titleError = computed<string | null>(() => {
  switch (props.problems.title) {
    case 'blank': return t('Give the page a title.');
    case 'long': return t('A title is at most {max} characters.', { max: TITLE_MAX });
    default: return null;
  }
});

function rangeError(p: 'integer' | 'range' | undefined, min: number, max: number): string | null {
  if (p === 'integer') return t('must be an integer');
  if (p === 'range') return t('must be between {min} and {max}', { min, max });
  return null;
}
const orderError = computed(() => rangeError(props.problems.order, ORDER_MIN, ORDER_MAX));
const limitError = computed(() => rangeError(props.problems.limit, OVERVIEW_ALARMS_LIMIT_MIN, OVERVIEW_ALARMS_LIMIT_MAX));
const pinsError = computed<string | null>(() => {
  switch (props.problems.pins) {
    case 'none': return t('A named page needs at least one pin.');
    case 'many': return t('At most {max} pins.', { max: MAX_PINS });
    case 'invalid': return t('Not a valid pin. Remove it and add it again.');
    case 'duplicate': return t('The same pin is listed twice. Remove one of them.');
    default: return null;
  }
});

function onInput(field: 'title' | 'orderText' | 'limitText', e: Event): void {
  emit('update', { [field]: (e.target as HTMLInputElement).value });
}
</script>

<template>
  <div class="ape">
    <section v-if="!isDefault" class="ape__panel">
      <header class="ape__panel-head"><h3>{{ t('Page') }}</h3></header>
      <div class="ape__fields">
        <label class="ape__field ape__field--grow">
          <span>{{ t('Title') }}</span>
          <input
            type="text"
            class="ape__in"
            :value="draft.title"
            :disabled="readOnly"
            @input="onInput('title', $event)"
          />
          <em v-if="titleError" class="ape__err">{{ titleError }}</em>
        </label>
        <label class="ape__field">
          <span>{{ t('Order') }}</span>
          <input
            type="text"
            inputmode="numeric"
            class="ape__in ape__in--num"
            :value="draft.orderText"
            :placeholder="String(ORDER_DEFAULT)"
            :disabled="readOnly"
            @input="onInput('orderText', $event)"
          />
          <em v-if="orderError" class="ape__err">{{ orderError }}</em>
        </label>
        <div class="ape__field">
          <span>{{ t('Id') }}</span>
          <code class="ape__id">{{ pageId }}</code>
          <RouterLink v-if="!isNew" :to="`/alarms/${pageId}`" class="ape__open">{{ t('Open page') }}</RouterLink>
        </div>
      </div>
      <p class="ape__hint">
        {{ t('Named pages are listed by order, then by title. A blank order counts as {n}. The id names the stored row and the page address; it cannot be changed.', { n: ORDER_DEFAULT }) }}
      </p>
    </section>

    <section class="ape__panel">
      <header class="ape__panel-head">
        <h3>{{ t('Pinned ({n} / {max})', { n: draft.pinnedLayers.length, max: MAX_PINS }) }}</h3>
      </header>
      <p class="ape__lede">
        {{ t('Each pin gets its own tile at the top of the page, left to right in this order. A pin names a layer, and optionally service groups in it. A named page lists only the alarms its pins cover; on the default page, every other layer with a firing alarm gets its own tab above the alarm list.') }}
      </p>
      <AlertPinEditor
        :model-value="draft.pinnedLayers"
        :known-layers="knownLayers"
        :max="MAX_PINS"
        :read-only="readOnly"
        @update:model-value="emit('update', { pinnedLayers: $event })"
      />
      <div v-if="pinsError" class="ape__err ape__err--block">{{ pinsError }}</div>
    </section>

    <section class="ape__panel">
      <header class="ape__panel-head"><h3>{{ t('Default time window') }}</h3></header>
      <div class="ape__win">
        <p class="ape__lede ape__lede--flush">
          {{
            isDefault
              ? t('Time window applied to all three alarm surfaces — the topbar alarm badge, the alarms page\'s first load, and the overview "Active alarms" widget. Unified here so the counts reconcile across pages.')
              : t('The window this page opens with.')
          }}
        </p>
        <div class="ape__win-options">
          <label
            v-for="opt in windowOptions"
            :key="opt.value ?? 'inherit'"
            class="ape__win-opt"
            :class="{ active: draft.windowMs === opt.value, disabled: readOnly }"
          >
            <input
              type="radio"
              :name="`window-${pageId}`"
              :checked="draft.windowMs === opt.value"
              :disabled="readOnly"
              @change="emit('update', { windowMs: opt.value })"
            />
            <span>{{ opt.label }}</span>
          </label>
        </div>
      </div>
    </section>

    <section v-if="isDefault" class="ape__panel">
      <header class="ape__panel-head"><h3>{{ t('Overview alarms widget') }}</h3></header>
      <div class="ape__win">
        <p class="ape__lede ape__lede--flush">
          {{ t('Per-poll fetch cap for the "Active alarms" widget on overview dashboards. The widget merges the fetched events into incidents client-side and surfaces the top N by recency. Higher caps catch more variety in noisy installs; smaller caps cut the per-poll payload. Range') }}
          <code>{{ OVERVIEW_ALARMS_LIMIT_MIN }}</code>–<code>{{ OVERVIEW_ALARMS_LIMIT_MAX }}</code>,
          {{ t('default') }} <code>{{ OVERVIEW_ALARMS_LIMIT_DEFAULT }}</code>.
        </p>
        <label class="ape__field">
          <span>{{ t('Fetch cap') }}</span>
          <input
            type="text"
            inputmode="numeric"
            class="ape__in ape__in--num"
            :value="draft.limitText"
            :disabled="readOnly"
            @input="onInput('limitText', $event)"
          />
          <em v-if="limitError" class="ape__err">{{ limitError }}</em>
        </label>
      </div>
    </section>
  </div>
</template>

<style scoped>
.ape__panel {
  background: var(--sw-bg-1);
  border: 1px solid var(--sw-line);
  border-radius: 8px;
  margin-bottom: 14px;
  overflow: hidden;
}
.ape__panel-head {
  padding: 8px 14px;
  background: var(--sw-bg-2);
  border-bottom: 1px solid var(--sw-line);
}
.ape__panel-head h3 {
  font-size: var(--sw-fs-xs);
  font-weight: var(--sw-fw-bold);
  text-transform: uppercase;
  letter-spacing: var(--sw-ls-caps);
  color: var(--sw-fg-3);
  margin: 0;
}
.ape__fields {
  display: flex;
  gap: 14px;
  flex-wrap: wrap;
  padding: 10px 14px 4px;
}
.ape__field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.ape__field--grow { flex: 1 1 260px; }
.ape__field > span {
  font-size: var(--sw-fs-xs);
  font-weight: var(--sw-fw-bold);
  text-transform: uppercase;
  letter-spacing: var(--sw-ls-caps);
  color: var(--sw-fg-3);
}
.ape__in {
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line);
  color: var(--sw-fg-0);
  font: inherit;
  font-size: var(--sw-fs-base);
  padding: 5px 8px;
  border-radius: 4px;
}
.ape__in--num {
  width: 100px;
  font-variant-numeric: tabular-nums;
}
.ape__in:disabled { opacity: 0.5; cursor: not-allowed; }
.ape__id {
  font-family: var(--sw-mono);
  font-size: var(--sw-fs-base);
  color: var(--sw-fg-0);
  padding: 5px 0;
}
.ape__open {
  font-size: var(--sw-fs-sm);
  color: var(--sw-accent);
  text-decoration: none;
}
.ape__open:hover { text-decoration: underline; }
.ape__hint,
.ape__lede {
  margin: 0;
  padding: 6px 14px 10px;
  font-size: var(--sw-fs-sm);
  color: var(--sw-fg-2);
  line-height: 1.5;
}
.ape__lede { padding: 8px 14px 0; }
.ape__lede--flush { padding: 0 0 8px; }
.ape__lede code {
  font-family: var(--sw-mono);
  font-size: var(--sw-fs-xs);
  color: var(--sw-fg-0);
}
.ape__err {
  font-style: normal;
  font-size: var(--sw-fs-sm);
  color: var(--sw-err);
}
.ape__err--block { padding: 0 14px 10px; }
.ape__win { padding: 10px 14px 12px; }
.ape__win-options {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.ape__win-opt {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 12px;
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line);
  border-radius: 5px;
  font-size: var(--sw-fs-base);
  color: var(--sw-fg-1);
  cursor: pointer;
}
.ape__win-opt input { margin: 0; cursor: pointer; }
.ape__win-opt input:disabled { cursor: not-allowed; }
.ape__win-opt:not(.disabled):hover { border-color: var(--sw-line-2); color: var(--sw-fg-0); }
.ape__win-opt.active {
  border-color: var(--sw-accent);
  color: var(--sw-fg-0);
  background: var(--sw-bg-3);
}
.ape__win-opt.disabled { opacity: 0.5; cursor: not-allowed; }
</style>
