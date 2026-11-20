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
  Read-only layer-dashboard canvas. Renders the per-scope widget grid
  in the same 12-col layout the admin LayerDashboardsAdmin uses (same
  mock-data path, same TimeChart / TopList components) but without the
  editor decorations (drag, resize, type chip, grip, size badge).

  Used by the Translations page so the operator sees a real preview of
  how their translation edits look — the LayerDashboardsAdmin editor
  itself remains the source of truth for the rich edit canvas and is
  not yet migrated to use this component.
-->
<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { AdminLayerTemplate } from '@/api/client';
import type { DashboardScope, DashboardWidget } from '@skywalking-horizon-ui/api-client';
import LayerCanvasLeaf from './LayerCanvasLeaf.vue';

type AdminScope = DashboardScope;

const { t } = useI18n({ useScope: 'global' });

const props = defineProps<{
  template: AdminLayerTemplate;
  scope: AdminScope;
  /** Which page of `scope` to preview — `null` is the component's default
   *  grid. Without it the canvas always drew the default, so an extension
   *  page's widgets could not be clicked to translate them. */
  page?: string | null;
  /** Selected widget id; the matching cell gets the accent outline. */
  selectedWidgetId?: string | null;
}>();

const emit = defineEmits<{
  /** `child` names a chart inside a `tab` widget's panel; without it the
   *  click was on the widget itself — for a `tab` widget, its tab strip. */
  'select-widget': [
    payload: {
      widget: DashboardWidget;
      idx: number;
      el: HTMLElement;
      event: MouseEvent;
      child?: { tab: number; index: number };
    },
  ];
  'select-header': [payload: { el: HTMLElement; event: MouseEvent }];
  'select-page': [payload: { el: HTMLElement; event: MouseEvent }];
}>();

const widgets = computed<DashboardWidget[]>(() => {
  const tpl = props.template as AdminLayerTemplate & { dashboards?: Record<string, DashboardWidget[]> };
  if (props.page) {
    const scope = props.scope as 'service' | 'instance' | 'endpoint';
    return tpl.dashboardExtPages?.[scope]?.find((p) => p.id === props.page)?.widgets ?? [];
  }
  if (tpl.dashboards?.[props.scope]) return tpl.dashboards[props.scope];
  if (props.scope === 'service' && tpl.widgets) return tpl.widgets;
  return [];
});

function widgetSpan(w: DashboardWidget): number {
  return Math.min(12, Math.max(1, w.span ?? 4));
}
function widgetRowSpan(w: DashboardWidget): number {
  return Math.min(8, Math.max(1, w.rowSpan ?? 1));
}
function widgetGridStyle(w: DashboardWidget): Record<string, string> {
  return { gridColumn: `span ${widgetSpan(w)}`, gridRow: `span ${widgetRowSpan(w)}` };
}

/** A `tab` widget keeps the height its author gave it, past the cap the
 *  other widgets take, so its tallest panel fits as it does on the page. */
function tabGridStyle(w: DashboardWidget): Record<string, string> {
  return { gridColumn: `span ${widgetSpan(w)}`, gridRow: `span ${Math.max(1, w.rowSpan ?? 2)}` };
}
const activeTabs = ref<Record<string, number>>({});
function activeTab(w: DashboardWidget): number {
  const n = w.tabs?.length ?? 0;
  return n === 0 ? 0 : Math.min(activeTabs.value[w.id] ?? 0, n - 1);
}
function activeChildren(w: DashboardWidget): DashboardWidget[] {
  return w.tabs?.[activeTab(w)]?.widgets ?? [];
}

function onCellClick(e: MouseEvent, w: DashboardWidget, i: number): void {
  emit('select-widget', { widget: w, idx: i, el: e.currentTarget as HTMLElement, event: e });
}

/** Opening a tab also opens its widget's own fields — the panel names live
 *  there — so a click on a tab name lands where that name is translated. */
function onTabClick(e: MouseEvent, w: DashboardWidget, i: number, tab: number): void {
  activeTabs.value = { ...activeTabs.value, [w.id]: tab };
  emit('select-widget', { widget: w, idx: i, el: e.currentTarget as HTMLElement, event: e });
}

function onChildClick(e: MouseEvent, c: DashboardWidget, i: number, tab: number, index: number): void {
  emit('select-widget', { widget: c, idx: i, el: e.currentTarget as HTMLElement, event: e, child: { tab, index } });
}

function onHeaderClick(e: MouseEvent): void {
  emit('select-header', { el: e.currentTarget as HTMLElement, event: e });
}

function onPageClick(e: MouseEvent): void {
  e.stopPropagation();
  emit('select-page', { el: e.currentTarget as HTMLElement, event: e });
}

/** The selected page's own record, so its name can be shown and clicked
 *  as itself rather than through the layer header. */
const activePageRef = computed(() => {
  if (!props.page) return null;
  const scope = props.scope as 'service' | 'instance' | 'endpoint';
  return props.template.dashboardExtPages?.[scope]?.find((p) => p.id === props.page) ?? null;
});
</script>

<template>
  <header class="ldc-layer-head" @click="onHeaderClick">
    <div class="ldc-layer-head-row">
      <span class="ldc-layer-dot" :style="{ background: template.color || 'var(--sw-fg-3)' }" />
      <h3 class="ldc-layer-alias">{{ template.alias || template.key }}</h3>
      <code class="ldc-layer-key">{{ template.key }}</code>
    </div>
    <p class="ldc-layer-hint">
      {{ t("Click to translate the layer's display name + term aliases (services / instances / endpoints).") }}
    </p>
  </header>

  <!-- The page's own name gets its own target. Folding it into the layer
       header meant clicking a control that says it edits the LAYER, and
       editing something else. -->
  <header v-if="activePageRef" class="ldc-page-head" @click="onPageClick">
    <div class="ldc-layer-head-row">
      <h3 class="ldc-layer-alias">{{ activePageRef.name }}</h3>
      <code class="ldc-layer-key">{{ activePageRef.id }}</code>
    </div>
    <p class="ldc-layer-hint">{{ t("Click to translate this page's name — the row operators see in the sidebar.") }}</p>
  </header>
  <div class="ldc-canvas">
    <div v-if="widgets.length === 0" class="ldc-empty">
      {{ t('No widgets in this scope.') }}
    </div>
    <template v-for="(w, i) in widgets" :key="`${w.id}-${i}`">
      <div
        v-if="w.type === 'tab'"
        class="ldc-cell ldc-tab"
        :style="tabGridStyle(w)"
        @click="onCellClick($event, w, i)"
      >
        <div class="ldc-tab-strip" role="tablist">
          <button
            v-for="(tab, ti) in w.tabs ?? []"
            :key="ti"
            type="button"
            role="tab"
            class="ldc-tab-btn"
            :class="{ on: ti === activeTab(w) }"
            :aria-selected="ti === activeTab(w)"
            @click.stop="onTabClick($event, w, i, ti)"
          >{{ tab.name || t('Tab {n}', { n: ti + 1 }) }}</button>
        </div>
        <div class="ldc-tab-grid">
          <div
            v-for="(c, ci) in activeChildren(w)"
            :key="`${c.id}-${ci}`"
            class="ldc-cell"
            :style="widgetGridStyle(c)"
            @click.stop="onChildClick($event, c, i, activeTab(w), ci)"
          >
            <LayerCanvasLeaf :widget="c" :row-span="widgetRowSpan(c)" :row-px="110" />
          </div>
        </div>
      </div>
      <div
        v-else
        class="ldc-cell"
        :class="{ 'is-sel': selectedWidgetId === w.id }"
        :style="widgetGridStyle(w)"
        @click="onCellClick($event, w, i)"
      >
        <LayerCanvasLeaf :widget="w" :row-span="widgetRowSpan(w)" :row-px="120" />
      </div>
    </template>
  </div>
</template>

<style scoped>
.ldc-page-head {
  cursor: pointer;
  padding: 8px 10px;
  border-bottom: 1px solid var(--sw-line-2);
  border-left: 2px solid var(--sw-accent);
}
.ldc-page-head:hover {
  background: rgba(255, 255, 255, 0.03);
}
.ldc-layer-head {
  margin: 8px 12px 0;
  padding: 8px 12px;
  border: 1px solid transparent;
  border-radius: 6px;
  cursor: pointer;
  transition: background 120ms ease, border-color 120ms ease;
}
.ldc-layer-head:hover { background: var(--sw-bg-1); border-color: var(--sw-line-2); }
.ldc-layer-head-row { display: flex; align-items: center; gap: 10px; }
.ldc-layer-dot { width: 8px; height: 8px; border-radius: 50%; flex: 0 0 8px; }
.ldc-layer-alias { margin: 0; font-size: 14px; font-weight: 600; color: var(--sw-fg-0); }
.ldc-layer-key {
  font-family: var(--sw-mono); font-size: 10.5px; color: var(--sw-fg-3);
  background: var(--sw-bg-2); padding: 1px 6px; border-radius: 3px;
}
.ldc-layer-hint {
  margin: 4px 0 0 18px;
  font-size: 10.5px; color: var(--sw-fg-3);
}
.ldc-canvas {
  position: relative;
  padding: 12px;
  background:
    linear-gradient(var(--sw-line) 1px, transparent 1px) 0 0/24px 24px,
    linear-gradient(90deg, var(--sw-line) 1px, transparent 1px) 0 0/24px 24px,
    var(--sw-bg-0);
  display: grid;
  grid-template-columns: repeat(12, 1fr);
  grid-auto-rows: 120px;
  gap: 8px;
  min-height: 360px;
}
.ldc-empty {
  grid-column: span 12;
  border: 1.5px dashed var(--sw-line-2);
  border-radius: 6px;
  display: grid;
  place-items: center;
  color: var(--sw-fg-3);
  font-size: 11.5px;
  padding: 24px;
  min-height: 120px;
}
.ldc-cell {
  position: relative;
  display: flex;
  flex-direction: column;
  background: var(--sw-bg-1);
  border: 1px solid var(--sw-line);
  border-radius: 6px;
  cursor: pointer;
  overflow: hidden;
  transition: border-color 120ms ease, box-shadow 120ms ease;
}
.ldc-cell:hover { border-color: var(--sw-line-2); }
.ldc-cell.is-sel {
  border-color: var(--sw-accent);
  box-shadow: 0 0 0 4px rgba(249, 115, 22, 0.18);
}
.ldc-tab {
  cursor: default;
  background: transparent;
}
.ldc-tab-strip {
  display: flex;
  gap: 2px;
  border-bottom: 1px solid var(--sw-line);
  overflow-x: auto;
  flex: 0 0 auto;
  cursor: pointer;
}
.ldc-tab-btn {
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  padding: 6px 12px;
  font-size: 11.5px;
  color: var(--sw-fg-2);
  cursor: pointer;
  white-space: nowrap;
}
.ldc-tab-btn:hover { color: var(--sw-fg-0); }
.ldc-tab-btn.on {
  color: var(--sw-fg-0);
  border-bottom-color: var(--sw-accent);
}
.ldc-tab-grid {
  flex: 1;
  min-height: 0;
  overflow: auto;
  display: grid;
  grid-template-columns: repeat(12, minmax(0, 1fr));
  grid-auto-rows: 110px;
  gap: 6px;
  padding: 8px 0 2px;
  align-content: start;
}
</style>
