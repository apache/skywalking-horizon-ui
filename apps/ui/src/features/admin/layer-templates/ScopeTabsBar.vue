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
  Scope-tab strip — the row of per-scope tabs above the per-scope editor.
  The strip can hold ~11 scopes; on a narrow editor it overflows, so it
  scrolls and surfaces chevron buttons that appear only on the side(s) with
  hidden tabs. The DOM-scroll math (overflow detection + the ResizeObserver /
  window-resize listeners) is owned HERE — it's pure presentation chrome.
  Stateless otherwise: `visibleScopes` + the label / widget-count resolvers
  are props; the active scope is a two-way model the tab click writes.

  The root element keeps `id="scope-editor"` because the parent's menu-preview
  jump scrolls `#scope-editor` into view.
-->
<script setup lang="ts">
import { ref, watch, onMounted, onBeforeUnmount, nextTick } from 'vue';
import type { DashboardWidget } from '@skywalking-horizon-ui/api-client';
import { type AdminScope, WIDGET_SCOPES } from './layer-dashboards.scopes';

const activeScope = defineModel<AdminScope>('activeScope', { required: true });
const props = defineProps<{
  visibleScopes: AdminScope[];
  labelFor: (s: AdminScope) => string;
  widgetsFor: (s: AdminScope) => DashboardWidget[];
}>();

// Scope-tab strip horizontal scroll. The strip can hold ~11 scopes;
// on a narrow editor it overflows, so we let it scroll and surface
// chevron buttons that appear only on the side(s) with hidden tabs.
const scopeNav = ref<HTMLElement | null>(null);
const canScrollScopeLeft = ref(false);
const canScrollScopeRight = ref(false);
function updateScopeScroll(): void {
  const el = scopeNav.value;
  if (!el) {
    canScrollScopeLeft.value = false;
    canScrollScopeRight.value = false;
    return;
  }
  canScrollScopeLeft.value = el.scrollLeft > 2;
  canScrollScopeRight.value = Math.ceil(el.scrollLeft + el.clientWidth) < el.scrollWidth - 1;
}
function scrollScopeTabs(dir: -1 | 1): void {
  const el = scopeNav.value;
  if (!el) return;
  el.scrollBy({ left: dir * Math.max(180, el.clientWidth * 0.7), behavior: 'smooth' });
}
// Attach the ResizeObserver when the <nav> actually mounts — the scope
// strip only renders once a template is selected (async after loadAll),
// so it's null at onMounted. Watching the template ref catches it
// appearing AND re-runs the overflow check then.
let scopeResizeObs: ResizeObserver | null = null;
watch(
  scopeNav,
  (el) => {
    scopeResizeObs?.disconnect();
    scopeResizeObs = null;
    if (el && typeof ResizeObserver !== 'undefined') {
      scopeResizeObs = new ResizeObserver(() => updateScopeScroll());
      scopeResizeObs.observe(el);
    }
    void nextTick(updateScopeScroll);
  },
  { immediate: true },
);
// Content changes (scopes toggled, labels/counts) change scrollWidth
// without resizing the nav, so refresh on those too.
watch(() => [props.visibleScopes, activeScope.value], () => void nextTick(updateScopeScroll));
function onWinResizeScope(): void { updateScopeScroll(); }

onMounted(() => {
  window.addEventListener('resize', onWinResizeScope);
});
onBeforeUnmount(() => {
  window.removeEventListener('resize', onWinResizeScope);
  scopeResizeObs?.disconnect();
  scopeResizeObs = null;
});
</script>

<template>
  <div id="scope-editor" class="scope-tabs-wrap sw-card">
    <button
      v-show="canScrollScopeLeft"
      class="scope-scroll left"
      type="button"
      aria-label="Scroll tabs left"
      @click="scrollScopeTabs(-1)"
    >‹</button>
    <nav ref="scopeNav" class="scope-tabs" @scroll="updateScopeScroll">
      <button
        v-for="s in visibleScopes"
        :key="s"
        class="scope-tab"
        :class="{ on: activeScope === s }"
        type="button"
        @click="activeScope = s"
      >
        {{ labelFor(s) }}
        <span v-if="WIDGET_SCOPES.has(s)" class="count">{{ widgetsFor(s).length }}</span>
      </button>
    </nav>
    <button
      v-show="canScrollScopeRight"
      class="scope-scroll right"
      type="button"
      aria-label="Scroll tabs right"
      @click="scrollScopeTabs(1)"
    >›</button>
  </div>
</template>

<style scoped>
/* Scope-tab strip (duplicated scoped; .sw-card is global). */
.scope-tabs-wrap {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px;
}
.scope-tabs {
  display: flex;
  gap: 2px;
  flex: 1;
  min-width: 0;
  overflow-x: auto;
  scroll-behavior: smooth;
  scrollbar-width: none;
}
.scope-tabs::-webkit-scrollbar { display: none; }
.scope-scroll {
  flex: 0 0 auto;
  width: 24px;
  height: 34px;
  border: 1px solid var(--sw-line-2);
  border-radius: 4px;
  background: var(--sw-bg-1);
  color: var(--sw-fg-2);
  font-size: 16px;
  line-height: 1;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.scope-scroll:hover { background: var(--sw-bg-2); color: var(--sw-fg-0); }
.scope-tab {
  /* Fill the strip when there's room, but never shrink/wrap — overflow
     scrolls instead (see the chevron buttons + .scope-tabs overflow). */
  flex: 1 0 auto;
  white-space: nowrap;
  padding: 8px 12px;
  font-size: 11.5px;
  font-weight: 500;
  color: var(--sw-fg-2);
  background: transparent;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  text-transform: capitalize;
  font: inherit;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
}
.scope-tab:hover { background: var(--sw-bg-2); color: var(--sw-fg-1); }
.scope-tab.on {
  background: var(--sw-accent-soft);
  color: var(--sw-accent-2);
  font-weight: 600;
}
.scope-tab .count {
  font-family: var(--sw-mono);
  font-size: 10px;
  color: var(--sw-fg-3);
}
.scope-tab.on .count { color: var(--sw-accent-2); }
</style>
