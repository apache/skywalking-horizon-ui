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
  The L1 layer row. A single-feature layer (services list only) renders as
  a direct RouterLink; everything else renders as an expandable accordion
  head that emits `toggle`. `variant` selects the placement-specific dress:
  `grouped` carries the diverged-warn badge + the in-group class, `operate`
  carries a serviceCount badge on the single-feature link.
-->
<script setup lang="ts">
import { computed } from 'vue';
import { RouterLink } from 'vue-router';
import { useI18n } from 'vue-i18n';
import type { LayerDef } from '@skywalking-horizon-ui/api-client';
import Icon from '@/components/icons/Icon.vue';
import { firstLayerTab, isSingleFeatureLayer } from '@/shell/useLayers';
import { layerIcon as layerIconByKey } from '@/shell/icons';
import { useRouteActive } from '@/shell/useSidebarActive';

const props = defineProps<{
  layer: LayerDef;
  expanded: boolean;
  variant: 'grouped' | 'ungrouped' | 'operate';
  /** Layer template has local edits not yet published to OAP. */
  diverged?: boolean;
}>();

defineEmits<{ toggle: [key: string] }>();

const { t } = useI18n({ useScope: 'global' });
const { isActive, isActiveExact } = useRouteActive();

const L = computed(() => props.layer);
const single = computed(() => isSingleFeatureLayer(L.value));
const inGroup = computed(() => props.variant === 'grouped');
const showWarn = computed(() => props.variant === 'grouped' && Boolean(props.diverged));
const showCount = computed(() => props.variant === 'operate');
const icon = computed(() => layerIconByKey(L.value.key));
</script>

<template>
  <RouterLink
    v-if="single"
    :to="`/layer/${L.key}/${firstLayerTab(L)}`"
    class="layer-row direct"
    :class="{ 'in-group': inGroup, 'is-active': isActive(`/layer/${L.key}`) }"
  >
    <Icon :name="icon" />
    <span class="layer-name">{{ L.name }}</span>
    <span
      v-if="showWarn"
      class="layer-warn"
      :title="t('Local changes not published to OAP')"
    ><Icon name="alert" :size="11" /></span>
    <span v-if="showCount" class="sw-badge" style="margin-left: auto">{{ L.serviceCount }}</span>
  </RouterLink>
  <div
    v-else
    class="layer-row expandable"
    :class="{
      'in-group': inGroup,
      'is-expanded': expanded,
      'is-active': isActiveExact(`/layer/${L.key}`),
    }"
    @click="$emit('toggle', L.key)"
  >
    <Icon :name="icon" />
    <span class="layer-name">{{ L.name }}</span>
    <span
      v-if="showWarn"
      class="layer-warn"
      :title="t('Local changes not published to OAP')"
    ><Icon name="alert" :size="11" /></span>
    <span class="caret" :class="{ open: expanded }">
      <Icon name="caret" :size="10" />
    </span>
  </div>
</template>

<style scoped>
/* L1 row — unified menu spec: 28px tall, 16px icon, 12/600 fg-1.
 * Active = accent inset + 10% accent fill; expanded-only = white-fade. */
.layer-row {
  display: flex;
  align-items: center;
  gap: 9px;
  margin: 1px 8px;
  padding: 6px 10px;
  border-radius: 6px;
  color: var(--sw-fg-1);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  user-select: none;
  position: relative;
}
.layer-row :deep(svg) {
  width: 16px;
  height: 16px;
  flex: 0 0 16px;
  color: var(--sw-fg-2);
  opacity: 1;
}
.layer-row .caret :deep(svg) {
  width: 10px;
  height: 10px;
  flex: 0 0 10px;
  color: var(--sw-fg-3);
}
.layer-row:hover {
  background: rgba(255, 255, 255, 0.04);
  color: var(--sw-fg-0);
}
.layer-row.is-expanded {
  background: rgba(255, 255, 255, 0.025);
  color: var(--sw-fg-0);
}
.layer-row.is-active {
  background: var(--sw-accent-soft);
  color: var(--sw-fg-0);
  box-shadow: inset 2px 0 0 var(--sw-accent);
}
.layer-row.is-active :deep(svg):not(.caret svg) {
  color: var(--sw-accent);
}
.layer-row .layer-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.layer-warn {
  display: inline-flex;
  align-items: center;
  flex: 0 0 auto;
  margin: 0 2px 0 4px;
}
.layer-row .layer-warn :deep(svg) {
  width: 12px;
  height: 12px;
  flex: 0 0 12px;
  color: #facc15;
}
.layer-row.direct {
  text-decoration: none;
}
.layer-row.expandable {
  cursor: pointer;
  user-select: none;
}
/* Grouped and ungrouped layer rows sit at the same indent — the group
 * header already delineates the section, so no extra tree-style nest. */
.layer-row.in-group { }
/* Base glyph points down; -90° collapses to right-arrow. */
.caret {
  margin-left: 4px;
  transition: transform 0.15s;
  display: inline-flex;
  width: 10px;
  transform: rotate(-90deg);
}
.caret.open {
  transform: rotate(0);
}
</style>
