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
  Node-detail popover for the Deployment view: key metrics + the (often long)
  instance attribute bag, plus "Open instance dashboard". Absolute-positioned by
  the parent via `popoverStyle`; the attribute search is owned here.
-->
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useEscapeToClose } from '@/components/primitives/useEscapeToClose';
import type { DeploymentNode, DeploymentMetricDef } from '@/api/client';

const props = defineProps<{
  node: DeploymentNode;
  popoverStyle: Record<string, string>;
  metricDefsFor: (n: DeploymentNode) => DeploymentMetricDef[];
  nodeVal: (n: DeploymentNode, def: DeploymentMetricDef | null) => number | null;
  fmtVal: (v: number | null, unit?: string, format?: DeploymentMetricDef['format'], compact?: boolean) => string;
}>();
const emit = defineEmits<{ (e: 'close'): void; (e: 'open-dashboard', n: DeploymentNode): void }>();
const { t } = useI18n({ useScope: 'global' });

useEscapeToClose(() => true, () => emit('close'));

// Attribute search — the FODC proxy stamps many labels onto each instance
// (k8s_*, net_*, …), so the list is long; filter + scroll it. Reset on node swap.
const attrFilter = ref('');
watch(() => props.node.id, () => { attrFilter.value = ''; });
const filteredAttrs = computed(() => {
  const query = attrFilter.value.trim().toLowerCase();
  if (!query) return props.node.attributes;
  return props.node.attributes.filter(
    (a) => a.name.toLowerCase().includes(query) || a.value.toLowerCase().includes(query),
  );
});
</script>

<template>
  <div class="sit-node-pop sw-card" :style="props.popoverStyle">
    <header class="np-head">
      <span class="np-name mono">{{ props.node.name }}</span>
      <button class="sw-btn small ghost" type="button" @click="emit('close')">×</button>
    </header>
    <section v-if="props.metricDefsFor(props.node).length > 0" class="np-metrics">
      <div class="np-section-label">{{ t('Key metrics') }}</div>
      <dl class="np-kv">
        <template v-for="def in props.metricDefsFor(props.node)" :key="def.id">
          <dt>{{ def.label }}</dt>
          <dd class="mono">{{ props.fmtVal(props.nodeVal(props.node, def), def.unit, def.format) }}</dd>
        </template>
      </dl>
    </section>

    <section v-if="props.node.attributes.length > 0" class="np-props">
      <div class="np-section-label">
        {{ t('Properties') }}
        <span class="np-count">{{ props.node.attributes.length }}</span>
      </div>
      <input
        v-if="props.node.attributes.length > 6"
        v-model="attrFilter"
        class="np-search"
        type="text"
        :placeholder="t('Filter attributes…')"
      />
      <div class="np-attrs-scroll">
        <dl class="np-attrs">
          <template v-for="a in filteredAttrs" :key="a.name">
            <dt>{{ a.name }}</dt>
            <dd class="mono">{{ a.value }}</dd>
          </template>
        </dl>
        <div v-if="filteredAttrs.length === 0" class="np-empty">{{ t('No matching attributes') }}</div>
      </div>
    </section>

    <button class="sw-btn small np-open" type="button" @click="emit('open-dashboard', props.node)">
      {{ t('Open instance dashboard') }} ↗
    </button>
  </div>
</template>

<style scoped>
/* width + max-height come from `popoverStyle` (inline) so the height bound
   can account for the toolbar header; here we only set the flex column so the
   attr list (`.np-attrs-scroll`) is the one scrollable region. */
.sit-node-pop { position: absolute; z-index: 5; display: flex; flex-direction: column; padding: 8px 10px 10px; box-shadow: 0 6px 22px rgba(0,0,0,0.4); }
.np-head { display: flex; align-items: center; gap: 6px; flex: 0 0 auto; }
.np-name { font-size: 11.5px; color: var(--sw-fg-0); flex: 1; word-break: break-all; }
/* Section label shared by Key metrics + Properties — small uppercase kicker. */
.np-section-label { flex: 0 0 auto; display: flex; align-items: center; gap: 6px; margin: 9px 1px 4px; font-size: 9px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--sw-fg-3); }
.np-count { letter-spacing: 0; font-size: 9px; color: var(--sw-fg-2); background: var(--sw-bg-1); border-radius: 7px; padding: 0 6px; }
/* Key metrics — a distinct inset card so it reads apart from the properties. */
.np-metrics { flex: 0 0 auto; }
.np-kv { display: grid; grid-template-columns: 1fr auto; gap: 4px 12px; margin: 0; padding: 7px 9px; font-size: 11px; background: var(--sw-bg-1); border: 1px solid var(--sw-line-2); border-radius: 6px; }
.np-kv dt { color: var(--sw-fg-2); }
.np-kv dd { margin: 0; color: var(--sw-fg-0); font-weight: 600; text-align: right; }
/* Properties — the scrollable region; only this grows + scrolls. */
.np-props { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; }
.np-search { flex: 0 0 auto; width: 100%; box-sizing: border-box; margin: 0 0 4px; padding: 3px 7px; font-size: 10.5px; color: var(--sw-fg-1); background: var(--sw-bg-1); border: 1px solid var(--sw-line-2); border-radius: 4px; }
.np-search:focus { outline: none; border-color: var(--sw-accent); }
/* Right padding + stable gutter so the scrollbar never overlaps the
   right-aligned attribute values. */
.np-attrs-scroll { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding-right: 12px; scrollbar-gutter: stable; }
.np-attrs-scroll::-webkit-scrollbar { width: 8px; }
.np-attrs-scroll::-webkit-scrollbar-thumb { background: var(--sw-line-2); border-radius: 4px; }
.np-empty { font-size: 10.5px; color: var(--sw-fg-3); padding: 6px 2px; }
.np-attrs { display: grid; grid-template-columns: minmax(0, auto) minmax(0, 1fr); gap: 2px 10px; margin: 0; font-size: 10.5px; }
.np-attrs dt { color: var(--sw-fg-3); overflow-wrap: anywhere; }
.np-attrs dd { margin: 0; color: var(--sw-fg-1); text-align: right; overflow-wrap: anywhere; }
/* Primary action — accent (orange in the default theme), matching the app's
   accent-button convention. */
.np-open { flex: 0 0 auto; width: 100%; justify-content: center; margin-top: 9px; }
.sit-node-pop .np-open { background: var(--sw-accent); border-color: var(--sw-accent); color: #1a1106; }
.sit-node-pop .np-open:hover { filter: brightness(1.07); }
.mono { font-family: var(--sw-mono); }
.sw-btn.small { height: 24px; padding: 0 10px; font-size: 11px; }
.sw-btn.ghost { background: transparent; border: 1px solid var(--sw-line-2); color: var(--sw-fg-2); cursor: pointer; }
</style>
