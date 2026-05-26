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
  Compact sorted-list renderer for `top_n(...)` MQE results. Each row
  has a name + value + a horizontal bar normalized to the row's value
  vs the list max.

  Supports two shapes:
   - `items` — single sorted list (one MQE, one view)
   - `groups` — multiple sorted lists, one per MQE expression. Renders
     a tab switcher at the top so operators can toggle between e.g.
     "Top by traffic" / "Top slowest" / "Top by SR" without leaving the
     widget. The first group is active by default.
-->
<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { DashboardTopItem } from '@skywalking-horizon-ui/api-client';
import { fmtMetric } from '@/utils/formatters';

const { t } = useI18n({ useScope: 'global' });

interface TopGroup {
  label: string;
  /** MQE that produced this list — surfaced in the tab tooltip so the
   *  operator can copy/reuse the expression. */
  expression?: string;
  /** Per-tab unit override. Falls back to the widget-level `unit` prop
   *  when missing. Lets one widget mix rpm / ms / % across tabs. */
  unit?: string;
  items: DashboardTopItem[];
}

const props = withDefaults(
  defineProps<{
    items?: ReadonlyArray<DashboardTopItem>;
    groups?: ReadonlyArray<TopGroup>;
    unit?: string;
    color?: string;
    /** Widget title — shown as the pop-out modal header. */
    title?: string;
  }>(),
  {
    color: 'var(--sw-accent)',
  },
);

// Normalize: derive the effective groups (always render via the tab
// path, single-list case becomes a 1-group set with no tabs visible).
const effectiveGroups = computed<TopGroup[]>(() => {
  if (props.groups && props.groups.length > 0) return [...props.groups];
  if (props.items) return [{ label: '', items: [...props.items] }];
  return [];
});
const activeIdx = ref(0);
watch(effectiveGroups, (g) => {
  // Reset to first tab when the group set changes shape.
  if (activeIdx.value >= g.length) activeIdx.value = 0;
});
const activeGroup = computed(() => effectiveGroups.value[activeIdx.value] ?? null);
const activeItems = computed<DashboardTopItem[]>(() => activeGroup.value?.items ?? []);
const activeUnit = computed<string | undefined>(() => activeGroup.value?.unit ?? props.unit);

const max = computed(() => {
  let m = 0;
  for (const it of activeItems.value) {
    const v = it.value;
    if (v !== null && Number.isFinite(v) && v > m) m = v;
  }
  return m || 1;
});
function pct(v: number | null): number {
  if (v === null || !Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(100, (v / max.value) * 100));
}
const showTabs = computed(() => effectiveGroups.value.length > 1);

// Pop-out: a widget often can't show the full ranked list (rows scroll)
// or the full names (ellipsized). The pop-out renders the same active
// list in a large teleported modal with wrapping names and roomy rows.
const expanded = ref(false);
function openExpanded(): void {
  expanded.value = true;
  window.addEventListener('keydown', onKeydown);
}
function closeExpanded(): void {
  expanded.value = false;
  window.removeEventListener('keydown', onKeydown);
}
function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') closeExpanded();
}
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown));

// The pop-out trigger lives in the host widget's title bar (so it can't
// overlap the in-widget tab row); the host calls this via a template ref.
defineExpose({ openExpanded });

// Full-name hover tooltip. Row names are ellipsized to fit the widget,
// so long api / endpoint / instance names are unreadable inline. A
// teleported floating box (rendered to <body>, not inside the widget)
// shows the complete name without being clipped by the widget border.
const hoverTip = ref<{ text: string; x: number; y: number } | null>(null);
function showTip(e: MouseEvent, text: string): void {
  hoverTip.value = { text, x: e.clientX, y: e.clientY };
}
function moveTip(e: MouseEvent): void {
  if (hoverTip.value) hoverTip.value = { ...hoverTip.value, x: e.clientX, y: e.clientY };
}
function hideTip(): void {
  hoverTip.value = null;
}
// Flip to the left of the cursor near the right edge so the box stays
// on-screen; vertical offset keeps it clear of the pointer.
const tipStyle = computed(() => {
  const t = hoverTip.value;
  if (!t) return {};
  const flipLeft = t.x > window.innerWidth * 0.6;
  return {
    left: `${t.x + (flipLeft ? -12 : 12)}px`,
    top: `${t.y + 14}px`,
    transform: flipLeft ? 'translateX(-100%)' : 'none',
  } as Record<string, string>;
});
</script>

<template>
  <div class="top-list">
    <div v-if="showTabs" class="tabs">
      <button
        v-for="(g, i) in effectiveGroups"
        :key="i"
        type="button"
        class="tab"
        :class="{ on: activeIdx === i }"
        :title="g.expression ? `${g.label}\n\n${g.expression}` : g.label"
        @click="activeIdx = i"
      >
        {{ g.label }}
      </button>
    </div>
    <div class="rows">
      <div
        v-for="(it, i) in activeItems"
        :key="i"
        class="row"
        @mouseenter="showTip($event, it.name)"
        @mousemove="moveTip"
        @mouseleave="hideTip"
      >
        <!-- Background fill — trace-waterfall style. The bar paints the
             row from the left, value is proportional to row.value/max,
             and the rank+name+value text overlays the bar. -->
        <span class="bar-bg" :style="{ width: `${pct(it.value)}%`, background: color }" />
        <span class="rank">{{ i + 1 }}</span>
        <span class="name">{{ it.name }}</span>
        <span class="value">
          {{ fmtMetric(it.value) }}<span v-if="activeUnit" class="unit">{{ activeUnit }}</span>
        </span>
      </div>
      <p v-if="activeItems.length === 0" class="empty">{{ t('No data') }}</p>
    </div>

    <Teleport to="body">
      <div v-if="hoverTip" class="top-tip" :style="tipStyle">{{ hoverTip.text }}</div>
    </Teleport>

    <!-- Pop-out: full ranked list in a roomy modal with wrapping names. -->
    <Teleport to="body">
      <div v-if="expanded" class="tl-modal" @click.self="closeExpanded">
        <div class="tl-dialog">
          <header class="tl-head">
            <span class="tl-title">{{ title || t('Top list') }}</span>
            <button class="tl-close" :aria-label="t('Close')" @click="closeExpanded">×</button>
          </header>
          <div v-if="showTabs" class="tabs">
            <button
              v-for="(g, i) in effectiveGroups"
              :key="i"
              type="button"
              class="tab"
              :class="{ on: activeIdx === i }"
              :title="g.expression ? `${g.label}\n\n${g.expression}` : g.label"
              @click="activeIdx = i"
            >
              {{ g.label }}
            </button>
          </div>
          <div class="rows rows--big">
            <div v-for="(it, i) in activeItems" :key="i" class="row row--big">
              <span class="bar-bg" :style="{ width: `${pct(it.value)}%`, background: color }" />
              <span class="rank">{{ i + 1 }}</span>
              <span class="name name--wrap">{{ it.name }}</span>
              <span class="value">
                {{ fmtMetric(it.value) }}<span v-if="activeUnit" class="unit">{{ activeUnit }}</span>
              </span>
            </div>
            <p v-if="activeItems.length === 0" class="empty">{{ t('No data') }}</p>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.top-list {
  position: relative;
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  min-height: 0;
}
.tabs {
  display: flex;
  gap: 2px;
  padding: 2px 0 4px;
  border-bottom: 1px solid var(--sw-line);
  margin-bottom: 2px;
  flex: 0 0 auto;
}
.tab {
  padding: 3px 8px;
  font-size: 11px;
  font-weight: 500;
  color: var(--sw-fg-2);
  background: transparent;
  border: none;
  border-radius: 3px;
  cursor: pointer;
  font: inherit;
  text-transform: capitalize;
  white-space: nowrap;
}
.tab:hover {
  background: var(--sw-bg-2);
  color: var(--sw-fg-1);
}
.tab.on {
  background: var(--sw-bg-3);
  color: var(--sw-fg-0);
  font-weight: 600;
}
.rows {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 2px 0 4px;
  overflow-y: auto;
  flex: 1;
  min-height: 0;
}
/* Each row is its own absolute-positioning context: the .bar-bg fill
 * sits behind, .rank / .name / .value text overlay on top. Matches the
 * trace-waterfall pattern so operators read one mental model. */
.row {
  position: relative;
  display: grid;
  grid-template-columns: 18px 1fr auto;
  align-items: center;
  gap: 6px;
  font-size: 11.5px;
  padding: 3px 8px;
  line-height: 1.3;
  border-radius: 3px;
  overflow: hidden;
  min-height: 18px;
}
.row:hover {
  background: var(--sw-bg-2);
}
.bar-bg {
  position: absolute;
  inset: 0 auto 0 0;
  border-radius: 3px;
  opacity: 0.18;
  transition: width 0.2s ease-out;
  pointer-events: none;
  z-index: 0;
}
.rank {
  font-family: var(--sw-mono);
  font-size: 10px;
  color: var(--sw-fg-3);
  text-align: right;
  position: relative;
  z-index: 1;
}
.name {
  font-family: var(--sw-mono);
  font-size: 11.5px;
  color: var(--sw-fg-0);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  position: relative;
  z-index: 1;
}
.value {
  font-family: var(--sw-mono);
  font-size: 11px;
  color: var(--sw-fg-1);
  text-align: right;
  font-variant-numeric: tabular-nums;
  font-weight: 600;
  position: relative;
  z-index: 1;
}
.value .unit {
  margin-left: 2px;
  color: var(--sw-fg-3);
  font-size: 9.5px;
  font-weight: 500;
}
.empty {
  font-size: 11px;
  color: var(--sw-fg-3);
  text-align: center;
  margin: 10px 0;
}
.top-tip {
  position: fixed;
  z-index: 9999;
  max-width: 420px;
  padding: 6px 9px;
  font-family: var(--sw-mono);
  font-size: 11.5px;
  line-height: 1.4;
  color: var(--sw-fg-0);
  background: var(--sw-bg-0, #1c2630);
  border: 1px solid var(--sw-line-2);
  border-radius: 5px;
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.55);
  word-break: break-all;
  pointer-events: none;
}

/* ── Pop-out modal ───────────────────────────────────────────────── */
.tl-modal {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.55);
  padding: 5vh 4vw;
}
.tl-dialog {
  display: flex;
  flex-direction: column;
  width: min(720px, 92vw);
  max-height: 86vh;
  background: var(--sw-bg-1);
  border: 1px solid var(--sw-line-2);
  border-radius: 8px;
  box-shadow: 0 24px 64px rgba(0, 0, 0, 0.6);
  overflow: hidden;
}
.tl-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--sw-line);
}
.tl-title {
  flex: 1;
  font-size: 13px;
  font-weight: 600;
  color: var(--sw-fg-0);
  letter-spacing: -0.01em;
}
.tl-close {
  width: 24px;
  height: 24px;
  font-size: 16px;
  line-height: 1;
  color: var(--sw-fg-2);
  background: transparent;
  border: 1px solid var(--sw-line);
  border-radius: 5px;
  cursor: pointer;
}
.tl-close:hover {
  color: var(--sw-fg-0);
  background: var(--sw-bg-2);
}
.tl-dialog .tabs {
  padding: 8px 14px 6px;
}
.rows--big {
  padding: 8px 14px 14px;
  gap: 4px;
  overflow-y: auto;
}
.row--big {
  grid-template-columns: 26px 1fr auto;
  gap: 10px;
  font-size: 13px;
  padding: 7px 10px;
  min-height: 26px;
}
.row--big .rank {
  font-size: 11.5px;
}
.row--big .name {
  font-size: 13px;
}
.row--big .value {
  font-size: 12.5px;
}
.name--wrap {
  white-space: normal;
  overflow: visible;
  text-overflow: clip;
  word-break: break-all;
}
</style>
