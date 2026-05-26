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
  Recursive tree-graph for a profile analyze result. Mirrors the
  booster-ui Stack/Container + Stack/Item pair: top row is the column
  header (Thread Stack / Duration / Self Duration / Dump Count), each
  branch indents children, the leftmost column is draggable to widen.

  Inputs:
    trees: ProfileAnalyzationTree[]  — raw analyze result trees
    highlightTop: boolean            — when on, the top-10 slow methods
                                       by `durationChildExcluded` get an
                                       accent-coloured row
-->
<script setup lang="ts">
import { computed, ref, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import type { ProfileAnalyzationElement, ProfileAnalyzationTree } from '@/api/client';
import ProfileStackRow from './ProfileStackRow.vue';

const { t } = useI18n({ useScope: 'global' });

interface StackNode extends ProfileAnalyzationElement {
  topDur: boolean;
  children?: StackNode[];
}

const props = defineProps<{
  trees: ProfileAnalyzationTree[];
  highlightTop: boolean;
}>();
const emit = defineEmits<{
  (e: 'toggle-highlight'): void;
}>();

// ── Build the indented tree ─────────────────────────────────────────
// booster-ui's sortArr keyed by `id` and walked the array twice;
// the same approach is fine here for the smallish element counts
// returned by getSegmentsProfileAnalyze.
const tableData = computed<StackNode[]>(() => {
  if (!props.trees.length) return [];
  const allDurChildExcluded = props.trees.flatMap((t) =>
    t.elements.map((e) => e.durationChildExcluded),
  );
  const topDur = [...allDurChildExcluded]
    .sort((a, b) => b - a)
    .filter((v, i) => i < 10 && v !== 0);

  const roots: StackNode[] = [];
  for (const tree of props.trees) {
    const idx: Record<string, StackNode> = {};
    const items = tree.elements.map<StackNode>((el) => ({
      ...el,
      topDur: topDur.includes(el.durationChildExcluded) && props.highlightTop,
    }));
    for (const it of items) idx[it.id] = it;
    for (const it of items) {
      if (it.parentId === '0') {
        roots.push(it);
        continue;
      }
      const parent = idx[it.parentId];
      if (parent) (parent.children ??= []).push(it);
    }
  }
  return roots;
});

// ── Draggable left-column width ─────────────────────────────────────
const thread = ref<number>(520);
const dragger = ref<HTMLElement | null>(null);
onMounted(() => {
  const el = dragger.value;
  if (!el) return;
  el.addEventListener('mousedown', (event) => {
    const start = event.clientX;
    const base = thread.value;
    const move = (e: MouseEvent) => {
      thread.value = Math.max(120, base + (e.clientX - start));
    };
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });
});
</script>

<template>
  <!-- Header + body share ONE scroll container so the column titles
       horizontally scroll alongside the rows when the Thread Stack
       column overflows. `position: sticky; top: 0` keeps the header
       vertically pinned during a body scroll. -->
  <div class="stack-table">
    <div class="stack-scroll">
      <div class="stack-header">
        <div class="cell sig" :style="{ width: thread + 'px' }">
          {{ t('Thread Stack') }}
          <span ref="dragger" class="dragger" :title="t('Drag to resize')">⇿</span>
        </div>
        <div class="cell num">{{ t('Duration (ms)') }}</div>
        <div class="cell num">
          {{ t('Self Duration (ms)') }}
          <button
            type="button"
            class="top-slow"
            :class="{ 'is-on': highlightTop }"
            @click="emit('toggle-highlight')"
            :title="t('Highlight top 10 slow methods')"
          >
            {{ t('top slow') }}
          </button>
        </div>
        <div class="cell num">{{ t('Dump Count') }}</div>
      </div>
      <div class="stack-body">
        <div v-if="!tableData.length" class="empty">{{ t('No analyze data yet — pick a profiled span and click Analyze.') }}</div>
        <ProfileStackRow v-for="(n, i) in tableData" :key="'r' + i" :node="n" :thread="thread" :depth="0" />
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
/* Single scroll container — header lives inside so it scrolls
 * horizontally with rows. `width: max-content` lets the inner row
 * width drive horizontal scrollbar instead of being capped by the
 * viewport. */
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
  height: 28px;
  line-height: 28px;
  padding: 0 8px;
  border-right: 1px dotted var(--sw-line-2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-weight: 600;
  color: var(--sw-fg-1);
}
.cell.num {
  width: 140px;
  flex: 0 0 140px;
  position: relative;
}
.cell.sig {
  flex: 0 0 auto;
  position: relative;
}
.dragger {
  position: absolute;
  right: 4px;
  top: 0;
  cursor: col-resize;
  color: var(--sw-fg-3);
  user-select: none;
}
.top-slow {
  margin-left: 6px;
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 3px;
  border: 1px solid var(--sw-line-2);
  background: transparent;
  color: var(--sw-fg-2);
  cursor: pointer;
}
.top-slow.is-on {
  color: var(--sw-accent);
  border-color: var(--sw-accent);
}
.empty {
  padding: 16px;
  text-align: center;
  color: var(--sw-fg-3);
  font-family: inherit;
}
</style>
