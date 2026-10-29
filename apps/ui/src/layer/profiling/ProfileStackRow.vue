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
  A single row in the recursive profile stack table. Recursion is what
  forces this to be its own component; the parent table renders one
  ProfileStackRow per root and lets each row paint its own subtree.
-->
<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { StackNode } from './profileStackFold';

export interface StackColumns {
  thread: number;
  duration: number;
  self: number;
  count: number;
}

const { t } = useI18n({ useScope: 'global' });

const props = defineProps<{
  node: StackNode;
  cols: StackColumns;
  depth: number;
  highlightTop: boolean;
  currentKey: string | null;
  /** Rows whose children are closed; the table owns it. */
  collapsed: ReadonlySet<string>;
  /** The row a depth click just took the operator to. */
  flashKey: string | null;
}>();
const emit = defineEmits<{
  'toggle-group': [key: string];
  'toggle-open': [key: string];
  'to-parent': [key: string, anchor: HTMLElement];
}>();

const open = computed(() => !props.collapsed.has(props.node.key));

// Indentation stops growing once the name would have less than NAME_ROOM
// left in the column; past that point the row shows its depth instead, a
// button that points out the parent, so a deep frame still reads and the
// number columns stay under their headers.
const INDENT = 12;
const NAME_ROOM = 200;
const indent = computed(() => Math.min(props.depth * INDENT, Math.max(0, props.cols.thread - 32 - NAME_ROOM)));
const clamped = computed(() => props.depth * INDENT > indent.value);

const isTop = computed(() => props.highlightTop && props.node.top);
const groupLabel = computed(() => {
  const n = props.node.hidden.length;
  return n === 1 ? t('{n} frame hidden', { n }) : t('{n} frames hidden', { n });
});
const HIDDEN_TITLE_LINES = 30;
const groupTitle = computed(() => {
  const sigs = props.node.hidden.map((e) => e.codeSignature);
  const more = sigs.length - HIDDEN_TITLE_LINES;
  return sigs.slice(0, HIDDEN_TITLE_LINES).join('\n') + (more > 0 ? `\n… +${more}` : '');
});
const colStyle = (w: number) => ({ width: w + 'px', flex: `0 0 ${w}px` });
</script>

<template>
  <div
    class="row"
    :class="{ 'is-match': node.match, 'is-current': currentKey === node.key, 'is-top': isTop, 'is-flash': flashKey === node.key }"
    :data-key="node.key"
  >
    <div
      class="cell sig"
      :style="{ ...colStyle(cols.thread), paddingLeft: 8 + indent + 'px' }"
      :class="{ 'is-top': isTop, 'is-root': depth === 0 }"
    >
      <span
        v-if="node.children.length"
        class="caret"
        :class="{ open }"
        @click="emit('toggle-open', node.key)"
      >▸</span>
      <span v-else class="caret-spacer"></span>
      <button
        v-if="clamped"
        type="button"
        class="depth"
        :title="t('Point out the parent frame')"
        @click.stop="emit('to-parent', node.key, $event.currentTarget as HTMLElement)"
      >{{ t('depth {n}', { n: depth }) }}</button>
      <button
        v-if="node.hidden.length"
        type="button"
        class="group"
        :title="groupTitle"
        @click="emit('toggle-group', node.key)"
      >⋯ {{ groupLabel }}</button>
      <template v-else>
        <span class="sig-text" :title="node.codeSignature ?? ''">{{ node.codeSignature }}</span>
        <button
          v-if="node.unfoldedGroupKey"
          type="button"
          class="refold"
          :title="t('Fold the frames shown from here')"
          @click="emit('toggle-group', node.unfoldedGroupKey)"
        >{{ t('Fold') }}</button>
      </template>
    </div>
    <div class="cell num" :style="colStyle(cols.duration)">{{ node.duration }}</div>
    <div class="cell num self" :style="colStyle(cols.self)">{{ node.durationChildExcluded }}</div>
    <div class="cell num" :style="colStyle(cols.count)">{{ node.count }}</div>
  </div>
  <template v-if="open">
    <ProfileStackRow
      v-for="c in node.children"
      :key="c.key"
      :node="c"
      :cols="cols"
      :depth="depth + 1"
      :highlight-top="highlightTop"
      :current-key="currentKey"
      :collapsed="collapsed"
      :flash-key="flashKey"
      @toggle-group="(k: string) => emit('toggle-group', k)"
      @toggle-open="(k: string) => emit('toggle-open', k)"
      @to-parent="(k: string, el: HTMLElement) => emit('to-parent', k, el)"
    />
  </template>
</template>

<style scoped>
.row {
  display: flex;
  align-items: center;
  border-bottom: 1px dotted var(--sw-line);
}
.row:hover {
  background: var(--sw-bg-2);
}
.row.is-match {
  background: var(--sw-accent-soft);
}
.row.is-current {
  box-shadow: inset 0 0 0 1px var(--sw-accent);
}
.cell {
  box-sizing: border-box;
  height: 26px;
  line-height: 26px;
  padding: 0 8px;
  border-right: 1px dotted var(--sw-line-2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.cell.num {
  text-align: right;
  color: var(--sw-fg-2);
}
.cell.num.self {
  color: var(--sw-fg-1);
  font-weight: 600;
}
.cell.sig {
  color: var(--sw-fg-1);
  display: flex;
  align-items: center;
  gap: 4px;
}
.cell.sig.is-top {
  color: var(--sw-accent);
}
.cell.sig.is-root {
  background: var(--sw-bg-2);
  border-left: 3px solid var(--sw-accent);
  padding-left: 5px !important;
}
.caret {
  width: 12px;
  flex: 0 0 12px;
  display: inline-block;
  transition: transform 0.15s;
  color: var(--sw-fg-3);
  cursor: pointer;
  user-select: none;
}
.caret.open {
  transform: rotate(90deg);
}
.caret-spacer {
  width: 12px;
  flex: 0 0 12px;
  display: inline-block;
}
.depth {
  flex: 0 0 auto;
  font: inherit;
  font-size: 10px;
  color: var(--sw-fg-2);
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line-2);
  border-radius: 3px;
  padding: 0 5px;
  line-height: 15px;
  cursor: pointer;
  white-space: nowrap;
}
.depth:hover {
  color: var(--sw-accent);
  border-color: var(--sw-accent-line);
}
/* The row a depth click lands on pulses twice, so the eye finds it after the
 * scroll; without motion it is simply outlined while the class is set. */
.row.is-flash {
  animation: stack-row-flash 0.7s ease-out 2;
}
@keyframes stack-row-flash {
  0% {
    background: var(--sw-accent-soft);
    box-shadow: inset 0 0 0 2px var(--sw-accent);
  }
  100% {
    background: transparent;
    box-shadow: inset 0 0 0 2px transparent;
  }
}
@media (prefers-reduced-motion: reduce) {
  .row.is-flash {
    animation: none;
    box-shadow: inset 0 0 0 2px var(--sw-accent);
  }
}
.sig-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
.group,
.refold {
  font: inherit;
  font-size: 10.5px;
  line-height: 16px;
  padding: 0 6px;
  border-radius: 3px;
  cursor: pointer;
  white-space: nowrap;
}
.group {
  color: var(--sw-fg-2);
  background: var(--sw-bg-2);
  border: 1px dashed var(--sw-line-2);
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}
.cell.sig.is-top .group {
  color: var(--sw-accent);
  border-color: var(--sw-accent-line);
}
.group:hover,
.refold:hover {
  border-color: var(--sw-accent);
  color: var(--sw-accent);
}
.refold {
  flex: 0 0 auto;
  margin-left: auto;
  color: var(--sw-fg-3);
  background: transparent;
  border: 1px solid var(--sw-line-2);
}
</style>
