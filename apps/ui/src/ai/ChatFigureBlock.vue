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
<!-- A numbered figure block: a lone figure inline, a cluster as one tab block
     (stack/grid are alternative groupings for the roomy full-page layout). -->
<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import ChatWidgetRenderer from './ChatWidgetRenderer.vue';
import type { FigureBlock } from './types';

const props = defineProps<{ block: FigureBlock }>();
const { t } = useI18n({ useScope: 'global' });
const active = ref(0);

const label = computed<string>(() => {
  const len = props.block.figures.length;
  const base =
    len > 1
      ? t('Figures {start}–{end}', { start: props.block.n, end: props.block.n + len - 1 })
      : t('Figure {n}', { n: props.block.n });
  return props.block.title ? `${base} · ${props.block.title}` : base;
});
</script>

<template>
  <figure class="cfb">
    <figcaption class="cfb__label">{{ label }}</figcaption>

    <!-- single -->
    <div v-if="block.layout === 'single' || block.figures.length === 1" class="cfb__one">
      <div class="cfb__cap">{{ block.figures[0].spec.title }}</div>
      <ChatWidgetRenderer :figure="block.figures[0]" />
    </div>

    <!-- tabs -->
    <div v-else-if="block.layout === 'tabs'" class="cfb__tabs">
      <div class="cfb__tabbar" role="tablist">
        <button
          v-for="(f, i) in block.figures"
          :key="i"
          type="button"
          class="cfb__tab"
          :class="{ active: active === i }"
          role="tab"
          :aria-selected="active === i"
          @click="active = i"
        >{{ f.spec.title }}</button>
      </div>
      <ChatWidgetRenderer :figure="block.figures[active]" />
    </div>

    <!-- stack / grid -->
    <div v-else :class="block.layout === 'grid' ? 'cfb__grid' : 'cfb__stack'">
      <div v-for="(f, i) in block.figures" :key="i" class="cfb__cell">
        <div class="cfb__cap">{{ f.spec.title }}</div>
        <ChatWidgetRenderer :figure="f" />
      </div>
    </div>
  </figure>
</template>

<style scoped>
.cfb {
  margin: 10px 0;
  padding: 10px 12px 12px;
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line);
  border-radius: 10px;
}
.cfb__label {
  font-size: var(--sw-fs-xs);
  font-weight: var(--sw-fw-bold);
  text-transform: uppercase;
  letter-spacing: var(--sw-ls-caps);
  color: var(--sw-fg-3);
  margin-bottom: 8px;
}
.cfb__cap {
  font-size: var(--sw-fs-sm);
  font-weight: var(--sw-fw-medium);
  color: var(--sw-fg-1);
  margin-bottom: 4px;
}
.cfb__tabbar {
  display: flex;
  flex-wrap: wrap;
  gap: 2px;
  margin-bottom: 8px;
  background: var(--sw-bg-1);
  border: 1px solid var(--sw-line);
  border-radius: 7px;
  padding: 3px;
}
.cfb__tab {
  background: transparent;
  border: 0;
  color: var(--sw-fg-2);
  font: inherit;
  font-size: var(--sw-fs-sm);
  padding: 4px 10px;
  border-radius: 5px;
  cursor: pointer;
}
.cfb__tab:hover {
  color: var(--sw-fg-0);
}
.cfb__tab.active {
  background: var(--sw-bg-3);
  color: var(--sw-fg-0);
}
.cfb__stack {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.cfb__grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 12px;
}
</style>
