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
import FloatingPanel from '@/components/primitives/FloatingPanel.vue';
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
const HEADER_HEIGHT = 28;
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
  if (pointerTimer) clearTimeout(pointerTimer);
  observer?.disconnect();
  endDrag?.();
});

/** Open every row above the target, then scroll to it — the page too when it
 *  must: on a short window the table's own bottom can sit below the fold. */
async function reveal(target: { key: string; ancestors: string[] }, smooth = false): Promise<void> {
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
  const reduced = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  row?.scrollIntoView({ block: 'center', inline: 'nearest', behavior: smooth && !reduced ? 'smooth' : 'auto' });
  // A row already on screen needs no scroll, so no scroll event marks it seen.
  if (highlightTop.value && topRowInView()) topSeen = true;
}

/** Each row's parent, for the depth button on rows whose indent stopped. */
const parentOf = computed(() => {
  const map = new Map<string, string>();
  const walk = (list: StackNode[], parent: string | null) => {
    for (const n of list) {
      if (parent) map.set(n.key, parent);
      walk(n.children, n.key);
    }
  };
  walk(nodes.value, null);
  return map;
});
const nodeByKey = computed(() => {
  const map = new Map<string, { node: StackNode; depth: number }>();
  const walk = (list: StackNode[], depth: number) => {
    for (const n of list) {
      map.set(n.key, { node: n, depth });
      walk(n.children, depth + 1);
    }
  };
  walk(nodes.value, 0);
  return map;
});

const body = ref<HTMLElement | null>(null);
const rowEl = (key: string) =>
  [...(body.value?.querySelectorAll<HTMLElement>('.row') ?? [])].find((r) => r.dataset.key === key) ?? null;
/** The band of the table the operator can actually see: below its sticky
 *  header and inside every clipping ancestor and the window — on a short
 *  window the page itself cuts the table off. */
let clippingAncestors: HTMLElement[] | null = null;
function visibleBand(): { top: number; bottom: number } | null {
  const el = scroller.value;
  if (!el) return null;
  if (!clippingAncestors) {
    clippingAncestors = [];
    for (let p = el.parentElement; p; p = p.parentElement) {
      const overflow = getComputedStyle(p).overflowY;
      if (overflow && overflow !== 'visible') clippingAncestors.push(p);
    }
  }
  const box = el.getBoundingClientRect();
  let top = Math.max(box.top + HEADER_HEIGHT, 0);
  let bottom = Math.min(box.bottom, window.innerHeight);
  for (const a of clippingAncestors) {
    const r = a.getBoundingClientRect();
    top = Math.max(top, r.top);
    bottom = Math.min(bottom, r.bottom);
  }
  return { top, bottom };
}
function rowInView(row: HTMLElement): boolean {
  const band = visibleBand();
  if (!band) return false;
  const r = row.getBoundingClientRect();
  return r.top >= band.top && r.bottom <= band.bottom;
}

/** A depth click does not move the view. When the parent row is on screen an
 *  arrow points at it from the clicked row; when it is not, a card names it
 *  and offers to scroll there. */
const flashKey = ref<string | null>(null);
const pointer = ref<{ top: number; height: number; left: number } | null>(null);
const parentCard = ref<{ anchor: HTMLElement; fromKey: string; key: string } | null>(null);
const parentCardInfo = computed(() => (parentCard.value ? nodeByKey.value.get(parentCard.value.key) ?? null : null));
let pointerTimer: ReturnType<typeof setTimeout> | null = null;
function clearPointer(): void {
  if (pointerTimer) clearTimeout(pointerTimer);
  pointerTimer = null;
  pointer.value = null;
  flashKey.value = null;
}

function pointAt(fromKey: string, parentKey: string): void {
  const from = rowEl(fromKey);
  const to = rowEl(parentKey);
  if (!from || !to) return;
  const sig = to.querySelector<HTMLElement>('.cell.sig');
  const indent = sig ? parseFloat(getComputedStyle(sig).paddingLeft) || 0 : 0;
  const top = to.offsetTop + to.offsetHeight / 2;
  // Cleared first so pointing at the same parent again replays the animation.
  pointer.value = null;
  flashKey.value = null;
  void nextTick(() => {
    pointer.value = { top, height: Math.max(0, from.offsetTop + from.offsetHeight / 2 - top), left: Math.max(2, indent - 12) };
    flashKey.value = parentKey;
  });
  if (pointerTimer) clearTimeout(pointerTimer);
  pointerTimer = setTimeout(() => {
    pointer.value = null;
    flashKey.value = null;
  }, 2600);
}
function toParent(key: string, anchor: HTMLElement): void {
  const parent = parentOf.value.get(key);
  if (!parent) return;
  const parentRow = rowEl(parent);
  if (parentRow && rowInView(parentRow)) {
    parentCard.value = null;
    pointAt(key, parent);
  } else {
    parentCard.value = { anchor, fromKey: key, key: parent };
  }
}
async function scrollToParentCard(): Promise<void> {
  const card = parentCard.value;
  if (!card) return;
  parentCard.value = null;
  const ancestors: string[] = [];
  for (let k = parentOf.value.get(card.key); k; k = parentOf.value.get(k)) ancestors.unshift(k);
  await reveal({ key: card.key, ancestors }, true);
  pointAt(card.fromKey, card.key);
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

// Turning the highlight on takes the operator to the first slow frame — in a
// deep stack it is usually far below the framework frames on screen.
watch(highlightTop, async (on) => {
  topSeen = false;
  if (!on) return;
  currentKey.value = null;
  await jumpToNext('top');
});

function topRowInView(): boolean {
  const band = visibleBand();
  if (!band) return false;
  return [...(scroller.value?.querySelectorAll<HTMLElement>('.row.is-top') ?? [])].some((r) => {
    const b = r.getBoundingClientRect();
    return b.bottom > band.top && b.top < band.bottom;
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
    // Keyed by element ids that the next analysis reuses for other frames.
    parentCard.value = null;
    clearPointer();
  },
);
// The arrow is drawn from row positions, which any layout change moves.
watch([collapsed, unfolded, () => cols.value.thread], clearPointer);
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
      <div ref="body" class="stack-body">
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
          :flash-key="flashKey"
          @toggle-group="toggleGroup"
          @toggle-open="toggleOpen"
          @to-parent="toParent"
        />
        <div
          v-if="pointer"
          class="parent-pointer"
          :style="{ top: pointer.top + 'px', height: pointer.height + 'px', left: pointer.left + 'px' }"
        ></div>
      </div>
      <FloatingPanel :open="!!parentCard" :anchor="parentCard?.anchor ?? null" :width="420" @close="parentCard = null">
        <div v-if="parentCardInfo" class="parent-card" @click.stop>
          <div class="parent-card-head">
            {{ t('Parent frame') }} · {{ t('depth {n}', { n: parentCardInfo.depth }) }}
            <span class="parent-card-note">{{ t('out of view') }}</span>
          </div>
          <div class="parent-card-sig">
            {{ parentCardInfo.node.codeSignature ?? '⋯ ' + t('{n} frames hidden', { n: parentCardInfo.node.hidden.length }) }}
          </div>
          <dl class="parent-card-nums">
            <div><dt>{{ t('Duration (ms)') }}</dt><dd>{{ parentCardInfo.node.duration }}</dd></div>
            <div><dt>{{ t('Self Duration (ms)') }}</dt><dd>{{ parentCardInfo.node.durationChildExcluded }}</dd></div>
            <div><dt>{{ t('Dump Count') }}</dt><dd>{{ parentCardInfo.node.count }}</dd></div>
          </dl>
          <div class="parent-card-actions">
            <button type="button" class="parent-card-go" @click="scrollToParentCard">{{ t('Scroll to it') }}</button>
          </div>
        </div>
      </FloatingPanel>
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
  position: relative;
}
/* A bracket in the indent gutter from the clicked row up to its parent, the
 * arrowhead pointing at the parent's name. */
.parent-pointer {
  position: absolute;
  width: 9px;
  border: 2px solid var(--sw-accent);
  border-right: none;
  border-radius: 5px 0 0 5px;
  pointer-events: none;
  z-index: 1;
  transform-origin: bottom;
  animation: parent-pointer-in 0.35s ease-out;
}
.parent-pointer::after {
  content: '';
  position: absolute;
  top: -7px;
  right: -9px;
  border-left: 9px solid var(--sw-accent);
  border-top: 6px solid transparent;
  border-bottom: 6px solid transparent;
  animation: parent-pointer-nudge 0.6s ease-in-out 0.35s 3;
}
@keyframes parent-pointer-in {
  from {
    transform: scaleY(0);
    opacity: 0;
  }
  to {
    transform: scaleY(1);
    opacity: 1;
  }
}
@keyframes parent-pointer-nudge {
  50% {
    transform: translateX(4px);
  }
}
@media (prefers-reduced-motion: reduce) {
  .parent-pointer,
  .parent-pointer::after {
    animation: none;
  }
}
.parent-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 14px;
  width: 100%;
  box-sizing: border-box;
  min-height: 0;
  overflow: auto;
  font-family: var(--sw-sans);
}
.parent-card-head {
  font-size: 12px;
  font-weight: 600;
  color: var(--sw-fg-0);
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.parent-card-note {
  margin-left: auto;
  font-size: 10.5px;
  font-weight: 500;
  color: var(--sw-fg-3);
}
.parent-card-sig {
  font-family: var(--sw-mono);
  font-size: 11.5px;
  color: var(--sw-fg-1);
  overflow-wrap: anywhere;
  word-break: break-all;
}
.parent-card-nums {
  margin: 0;
  display: flex;
  gap: 16px;
  font-size: 11px;
}
.parent-card-nums dt {
  color: var(--sw-fg-3);
}
.parent-card-nums dd {
  margin: 0;
  color: var(--sw-fg-0);
  font-variant-numeric: tabular-nums;
}
.parent-card-actions {
  display: flex;
  justify-content: flex-end;
}
.parent-card-go {
  font-family: inherit;
  font-size: 11.5px;
  font-weight: 500;
  height: 24px;
  padding: 0 12px;
  border-radius: 4px;
  border: 1px solid var(--sw-accent-line);
  background: var(--sw-accent-soft);
  color: var(--sw-accent);
  cursor: pointer;
}
.parent-card-go:hover {
  border-color: var(--sw-accent);
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
