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
<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import type { AlertPageListItem } from './alertPages';

const { t } = useI18n({ useScope: 'global' });

defineProps<{
  items: AlertPageListItem[];
  selected: string;
  /** Why "+ New page" is unavailable; `null` when it is. */
  createBlocked: string | null;
  /** Shown under the rows when the named pages could not be listed. */
  note: string | null;
}>();

const emit = defineEmits<{ select: [id: string]; create: [] }>();
</script>

<template>
  <nav class="apl" :aria-label="t('Alarm pages')">
    <button
      v-for="item in items"
      :key="item.id"
      type="button"
      class="apl__row"
      :class="{ active: item.id === selected }"
      @click="emit('select', item.id)"
    >
      <span class="apl__label">
        {{ item.label }}
        <span v-if="item.dirty" class="apl__dot" :title="t('unsaved changes')" />
      </span>
      <span class="apl__meta">
        <code v-if="item.path" class="apl__path">{{ item.path }}</code>
        <span v-if="item.tag" class="apl__tag">{{ item.tag }}</span>
      </span>
    </button>
    <div v-if="note" class="apl__note">{{ note }}</div>
    <button
      type="button"
      class="apl__new"
      :disabled="createBlocked !== null"
      :title="createBlocked ?? ''"
      @click="emit('create')"
    >{{ t('+ New page') }}</button>
  </nav>
</template>

<style scoped>
.apl {
  display: flex;
  flex-direction: column;
  gap: 2px;
  background: var(--sw-bg-1);
  border: 1px solid var(--sw-line);
  border-radius: 8px;
  padding: 6px;
  align-self: flex-start;
}
.apl__row {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  width: 100%;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 5px;
  padding: 6px 8px;
  font: inherit;
  text-align: left;
  color: var(--sw-fg-1);
  cursor: pointer;
}
.apl__row:hover { background: var(--sw-bg-2); color: var(--sw-fg-0); }
.apl__row.active {
  background: var(--sw-bg-3);
  border-color: var(--sw-accent-line);
  color: var(--sw-fg-0);
}
.apl__label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: var(--sw-fs-base);
  font-weight: var(--sw-fw-medium);
  word-break: break-word;
}
.apl__dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--sw-warn);
  flex: none;
}
.apl__meta {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.apl__path {
  font-family: var(--sw-mono);
  font-size: var(--sw-fs-xs);
  color: var(--sw-fg-3);
}
.apl__tag {
  font-size: var(--sw-fs-xs);
  color: var(--sw-warn);
  text-transform: uppercase;
  letter-spacing: var(--sw-ls-caps);
}
.apl__note {
  padding: 6px 8px;
  font-size: var(--sw-fs-sm);
  color: var(--sw-warn);
  line-height: 1.4;
}
.apl__new {
  margin-top: 4px;
  background: transparent;
  border: 1px dashed var(--sw-line-2);
  border-radius: 5px;
  color: var(--sw-fg-2);
  font: inherit;
  font-size: var(--sw-fs-sm);
  padding: 6px 8px;
  cursor: pointer;
}
.apl__new:not(:disabled):hover { color: var(--sw-fg-0); border-color: var(--sw-accent); }
.apl__new:disabled { opacity: 0.4; cursor: not-allowed; }
</style>
