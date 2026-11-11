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
  The tag filters a search form has committed, each removable — the row under
  a TagInput on the trace tabs.
-->
<script setup lang="ts">
import { useI18n } from 'vue-i18n';

const props = withDefaults(defineProps<{ tags: readonly string[]; label?: string }>(), { label: '' });
const emit = defineEmits<{ remove: [index: number] }>();
const { t } = useI18n({ useScope: 'global' });
</script>

<template>
  <div class="tag-row">
    <span class="tag-row-label">{{ props.label || t('Active tags') }}</span>
    <span class="tag-chips">
      <span v-for="(tag, i) in props.tags" :key="i" class="tag-chip">
        <span class="tag-text" :title="tag">{{ tag }}</span>
        <button type="button" class="tag-x" :aria-label="t('Remove')" @click="emit('remove', i)">×</button>
      </span>
    </span>
  </div>
</template>

<style scoped>
.tag-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding-top: 6px;
  border-top: 1px dashed var(--sw-line);
  min-width: 0;
}
.tag-row-label { font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--sw-fg-3); flex: 0 0 auto; }
/* Every level gives up its automatic minimum width, so one long value (a URL,
   a statement) is cut to the row instead of pushing its × out of it. */
.tag-chips { display: flex; flex-wrap: wrap; gap: 4px; flex: 1 1 auto; min-width: 0; }
.tag-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 22px;
  padding: 0 6px;
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line-2);
  border-radius: 11px;
  font-size: 10.5px;
  max-width: 100%;
  min-width: 0;
  box-sizing: border-box;
}
/* `pre` keeps a value's own edge spaces visible; it also stops wrapping. */
.tag-text { white-space: pre; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.tag-x {
  background: transparent;
  border: none;
  color: var(--sw-fg-3);
  cursor: pointer;
  font-size: 12px;
  line-height: 1;
  padding: 0;
  flex: 0 0 auto;
}
.tag-x:hover { color: var(--sw-err); }
</style>
