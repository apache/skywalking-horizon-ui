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
  Recursive tree-graph for a profile analyze result: Thread Stack / Duration /
  Self Duration / Dump Count, each frame indented under its caller. The
  columns start out filling the area; dragging a header's right edge resizes
  that column alone, so widening one widens the whole table, which then
  scrolls sideways. Double-clicking an edge fits the columns again.

  Inputs:
    trees        — raw analyze trees
    highlightTop — (v-model) accent-colour the frames with the ten largest
                   self times and jump to them; scrolling them all out of
                   view turns it off
    hidePatterns — fold frames starting with one of these into one
                   "⋯ N frames hidden" row per connected group (click unfolds)
    search       — mark rows whose signature contains this

  Exposed:
    jumpToNext(kind)  — scroll to the next row that matches the search
                        ('match') or is among the slowest ('top'), opening
                        any collapsed row above it; wraps at the end
-->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { ProfileAnalyzationTree } from '@/api/client';
import ProfileStackRow, { type StackColumns } from './ProfileStackRow.vue';
import { foldStack, type StackNode } from './profileStackFold';

const { t } = useI18n({ useScope: 'global' });

const props = withDefaults(
  defineProps<{
    trees: ProfileAnalyzationTree[];
    hidePatterns?: string[];
    search?: string;
  }>(),
  { hidePatterns: () => [], search: '' },
);
/** On while the operator is looking at the slowest frames: turning it on
 *  jumps to them, and scrolling them all out of view turns it off again. */
const highlightTop = defineModel<boolean>('highlightTop', { default: false });

/** Folded groups the operator opened. A host that shows a hidden-frame count
 *  binds it; otherwise it is this table's own state. */
const unfolded = defineModel<Set<string>>('unfolded', { default: () => new Set<string>() });
/** Rows whose children the operator closed with the caret. Held here rather
 *  than in each row so a jump can open the way to a row it is not drawing. */
const collapsed = ref<Set<string>>(new Set());
watch(
  () => [props.trees, props.hidePatterns],
  () => {
    unfolded.value = new Set();
    collapsed.value = new Set();
  },
);
function toggled(set: Set<string>, key: string): Set<string> {
  const next = new Set(set);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}
function toggleGroup(key: string): void {
  unfolded.value = toggled(unfolded.value, key);
}
function toggleOpen(key: string): void {
  collapsed.value = toggled(collapsed.value, key);
}

const nodes = computed(() =>
  foldStack(props.trees, { hidePatterns: props.hidePatterns, unfolded: unfolded.value, search: props.search }),
);

/** Rows that satisfy `pick`, top to bottom, each with the rows above it. */
function targets(pick: (n: StackNode) => boolean): { key: string; ancestors: string[] }[] {
  const out: { key: string; ancestors: string[] }[] = [];
  const walk = (list: StackNode[], ancestors: string[]) => {
    for (const n of list) {
      if (pick(n)) out.push({ key: n.key, ancestors });
      walk(n.children, [...ancestors, n.key]);
    }
  };
  walk(nodes.value, []);
  return out;
}

type Column = keyof StackColumns;
const MIN_WIDTH: StackColumns = { thread: 160, duration: 60, self: 60, count: 60 };
const FIT_NUMBER_WIDTHS = { duration: 120, self: 140, count: 110 };
const widths = reactive<StackColumns>({ thread: 0, ...FIT_NUMBER_WIDTHS });
/** Until the operator drags a border, Thread Stack takes what the number
 *  columns leave, so the table fits its area as that changes. */
const fitted = ref(true);
const scroller = ref<HTMLElement | null>(null);
const areaWidth = ref(0);
const cols = computed<StackColumns>(() =>
  fitted.value
    ? {
        ...widths,
        thread: Math.max(MIN_WIDTH.thread, areaWidth.value - widths.duration - widths.self - widths.count),
      }
    : { ...widths },
);
const colStyle = (w: number) => ({ width: w + 'px', flex: `0 0 ${w}px` });

/** Drag a header's right edge: that column alone changes, so widening it
 *  widens the whole table, which then scrolls sideways. */
let endDrag: (() => void) | null = null;
function startResize(col: Column, event: MouseEvent): void {
  event.preventDefault();
  // Pin every width first, or Thread Stack would keep filling what is left
  // and shrink as the dragged column grows.
  Object.assign(widths, cols.value);
  fitted.value = false;
  const start = event.clientX;
  const base = widths[col];
  const move = (e: MouseEvent) => {
    widths[col] = Math.max(MIN_WIDTH[col], base + (e.clientX - start));
  };
  const up = () => {
    document.removeEventListener('mousemove', move);
    document.removeEventListener('mouseup', up);
    endDrag = null;
  };
  document.addEventListener('mousemove', move);
  document.addEventListener('mouseup', up);
  endDrag = up;
}
function fitToArea(): void {
  Object.assign(widths, FIT_NUMBER_WIDTHS);
  fitted.value = true;
}
const headers = computed<{ col: Column; label: string }[]>(() => [
  { col: 'thread', label: t('Thread Stack') },
  { col: 'duration', label: t('Duration (ms)') },
  { col: 'self', label: t('Self Duration (ms)') },
  { col: 'count', label: t('Dump Count') },
]);

let observer: ResizeObserver | null = null;
onMounted(() => {
  const el = scroller.value;
  if (!el) return;
  areaWidth.value = el.clientWidth;
  if (typeof ResizeObserver !== 'undefined') {
    observer = new ResizeObserver(() => {
      areaWidth.value = el.clientWidth;
    });
    observer.observe(el);
  }
  // A table that appears with top slow already on — the pop-out, or Tree
  // picked back from Flame — shows the slow frame, not the top of the stack.
  if (highlightTop.value) void jumpToNext('top');
});
onBeforeUnmount(() => {
  observer?.disconnect();
  endDrag?.();
});

/** Open every row above the target, then scroll to it — the page too when it
 *  must: on a short window the table's own bottom can sit below the fold. */
async function reveal(target: { key: string; ancestors: string[] }): Promise<void> {
  if (target.ancestors.some((k) => collapsed.value.has(k))) {
    const next = new Set(collapsed.value);
    for (const k of target.ancestors) next.delete(k);
    collapsed.value = next;
  }
  // Also lets rows take the highlight a watcher has just turned on.
  await nextTick();
  const row = [...(scroller.value?.querySelectorAll<HTMLElement>('.row') ?? [])].find(
    (r) => r.dataset.key === target.key,
  );
  row?.scrollIntoView({ block: 'center', inline: 'nearest' });
  // A row already on screen needs no scroll, so no scroll event marks it seen.
  if (highlightTop.value && topRowInView()) topSeen = true;
}

// The row the last jump landed on. Row keys are OAP element ids, which repeat
// from one analysis to the next, so a new tree or hide list must drop it as
// surely as new search text does.
const currentKey = ref<string | null>(null);
watch(
  () => [props.search, props.trees, props.hidePatterns],
  () => {
    currentKey.value = null;
  },
);
async function jumpToNext(kind: 'match' | 'top'): Promise<void> {
  const list = targets((n) => (kind === 'match' ? n.match : n.top));
  if (!list.length) return;
  const at = list.findIndex((m) => m.key === currentKey.value);
  const next = list[(at + 1) % list.length];
  currentKey.value = next.key;
  await reveal(next);
}
defineExpose({ jumpToNext });

// Off again once the operator scrolls away: only after a highlighted row has
// been in view, so the scrolls that bring it there do not count as leaving.
let topSeen = false;
const HEADER_HEIGHT = 28;

// Turning the highlight on takes the operator to the first slow frame — in a
// deep stack it is usually far below the framework frames on screen.
watch(highlightTop, async (on) => {
  topSeen = false;
  if (!on) return;
  currentKey.value = null;
  await jumpToNext('top');
});

function topRowInView(): boolean {
  const el = scroller.value;
  if (!el) return false;
  const box = el.getBoundingClientRect();
  return [...el.querySelectorAll<HTMLElement>('.row.is-top')].some((r) => {
    const b = r.getBoundingClientRect();
    return b.bottom > box.top + HEADER_HEIGHT && b.top < box.bottom;
  });
}
function onScroll(): void {
  if (!highlightTop.value) return;
  if (topRowInView()) {
    topSeen = true;
  } else if (topSeen) {
    topSeen = false;
    currentKey.value = null;
    highlightTop.value = false;
  }
}
watch(
  () => [props.trees, props.hidePatterns],
  () => {
    topSeen = false;
  },
);
</script>

<template>
  <!-- Header + body share ONE scroll container so the column titles
       horizontally scroll alongside the rows. `position: sticky; top: 0`
       keeps the header vertically pinned during a body scroll. -->
  <div class="stack-table">
    <div ref="scroller" class="stack-scroll" @scroll.passive="onScroll">
      <div class="stack-header">
        <div
          v-for="h in headers"
          :key="h.col"
          class="cell"
          :class="h.col === 'thread' ? 'sig' : 'num'"
          :style="colStyle(cols[h.col])"
          :title="h.label"
        >
          <span class="hd-label">{{ h.label }}</span>
          <span
            class="col-resize"
            :title="t('Drag to resize this column; double-click to fit all columns')"
            @mousedown="startResize(h.col, $event)"
            @dblclick="fitToArea"
          ></span>
        </div>
      </div>
      <div class="stack-body">
        <div v-if="!nodes.length" class="empty">{{ t('No analyze data yet — pick a profiled span and click Analyze.') }}</div>
        <ProfileStackRow
          v-for="n in nodes"
          :key="n.key"
          :node="n"
          :cols="cols"
          :depth="0"
          :highlight-top="highlightTop"
          :current-key="currentKey"
          :collapsed="collapsed"
          @toggle-group="toggleGroup"
          @toggle-open="toggleOpen"
        />
      </div>
    </div>
  </div>
</template>

<style scoped>
.stack-table {
  height: 100%;
  display: flex;
  flex-direction: column;
  font-size: 11.5px;
  color: var(--sw-fg-1);
  font-family: var(--sw-mono);
  overflow: hidden;
}
.stack-scroll {
  flex: 1 1 0;
  min-height: 0;
  overflow: auto;
}
.stack-header {
  display: flex;
  align-items: center;
  background: var(--sw-bg-2);
  border-bottom: 1px solid var(--sw-line);
  flex: 0 0 auto;
  position: sticky;
  top: 0;
  z-index: 2;
  width: max-content;
  min-width: 100%;
}
.stack-body {
  width: max-content;
  min-width: 100%;
}
.cell {
  box-sizing: border-box;
  height: 28px;
  line-height: 28px;
  padding: 0 8px;
  border-right: 1px dotted var(--sw-line-2);
  white-space: nowrap;
  overflow: hidden;
  font-weight: 600;
  color: var(--sw-fg-1);
  position: relative;
  display: flex;
  align-items: center;
}
.cell.num {
  justify-content: flex-end;
}
.hd-label {
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}
.col-resize {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  width: 7px;
  cursor: col-resize;
  user-select: none;
}
.col-resize:hover {
  background: var(--sw-accent-line);
}
.empty {
  padding: 16px;
  text-align: center;
  color: var(--sw-fg-3);
  font-family: inherit;
}
</style>
