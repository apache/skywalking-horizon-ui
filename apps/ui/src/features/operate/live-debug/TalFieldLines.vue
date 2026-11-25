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
<script setup lang="ts">
/**
 * An object's fields one per line, as a debugger's variables view lists
 * them: the name, then the value. A plain value shows whole on its line; an
 * object or a list shows in gray and opens under its line. The field the
 * other pane selected is highlighted, and open when it can open.
 */
import { computed, nextTick, ref, watch } from 'vue';
import { displayValue, shortValue, timeText } from './talDebug.js';
import TalValueTree from './TalValueTree.vue';

const props = defineProps<{
  value: unknown;
  /** Names the fields: `span`, `meta`, `locals`, … */
  path: string;
  /** The selected field's path, which this list highlights and opens when
   *  it holds it. */
  highlight?: string | null;
}>();

const emit = defineEmits<{ pick: [field: string] }>();

const root = ref<HTMLElement | null>(null);
const opened = ref<Set<string>>(new Set());

const rows = computed<{ key: string; field: string; value: unknown; branch: boolean }[]>(() => {
  const v = displayValue(props.value);
  const entries: [string, unknown][] = Array.isArray(v)
    ? v.map((x, i) => [String(i), x])
    : v !== null && typeof v === 'object'
      ? Object.entries(v)
      : [['', v]];
  return entries.map(([key, value]) => ({
    key,
    field: key ? `${props.path}.${key}` : props.path,
    value,
    branch: value !== null && typeof value === 'object',
  }));
});

function marked(field: string): boolean {
  const h = props.highlight;
  return !!h && (h === field || h.startsWith(`${field}.`));
}

function isOpen(field: string): boolean {
  return opened.value.has(field) || marked(field);
}

/** A plain value has nothing to open; picking it only selects it. */
function toggle(field: string, branch: boolean): void {
  if (branch) {
    const next = new Set(opened.value);
    if (next.has(field)) next.delete(field);
    else next.add(field);
    opened.value = next;
  }
  emit('pick', field);
}

/** A plain value in full, a string quoted, a time field as local time. */
function fullValue(key: string, value: unknown): string {
  return timeText(key, value) ?? (typeof value === 'string' ? JSON.stringify(value) : String(value));
}

function leafClass(key: string, value: unknown): string {
  if (timeText(key, value)) return 'tfd__v--time';
  return value === null || value === undefined ? 'tfd__v--null' : `tfd__v--${typeof value}`;
}

watch(
  () => props.highlight,
  () =>
    void nextTick(() => {
      root.value?.querySelector<HTMLElement>('.tfd__row--marked')?.scrollIntoView({ block: 'nearest' });
    }),
);
</script>

<template>
  <div ref="root" class="tfd">
    <template v-for="row in rows" :key="row.field">
      <button
        type="button"
        class="tfd__row"
        :class="{
          'tfd__row--marked': marked(row.field),
          'tfd__row--open': row.branch && isOpen(row.field),
          'tfd__row--leaf': !row.branch,
        }"
        @click="toggle(row.field, row.branch)"
      >
        <span class="tfd__caret">{{ row.branch ? (isOpen(row.field) ? '▾' : '▸') : '' }}</span>
        <span v-if="row.key" class="tfd__k">{{ row.key }}</span>
        <span v-if="row.branch" class="tfd__v">{{ shortValue(row.value) }}</span>
        <span
          v-else
          class="tfd__leaf"
          :class="leafClass(row.key, row.value)"
          :title="timeText(row.key, row.value) ? String(row.value) : undefined"
        >{{ fullValue(row.key, row.value) }}</span>
      </button>
      <div v-if="row.branch && isOpen(row.field)" class="tfd__open">
        <TalValueTree :value="row.value" :open-depth="2" />
      </div>
    </template>
  </div>
</template>

<style scoped>
.tfd {
  display: flex;
  flex-direction: column;
}

.tfd__row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  width: 100%;
  padding: 1px 4px;
  background: transparent;
  border: 0;
  border-left: 2px solid transparent;
  font-family: var(--rr-font-mono);
  font-size: var(--sw-fs-sm);
  line-height: 1.6;
  text-align: left;
  cursor: pointer;
}

.tfd__row:hover {
  background: var(--rr-bg3);
}

.tfd__row--marked {
  background: var(--sw-info-soft);
  border-left-color: var(--rr-info);
}

.tfd__caret {
  width: 10px;
  flex-shrink: 0;
  color: var(--rr-dim);
}

.tfd__k {
  flex-shrink: 0;
  min-width: 9ch;
  color: var(--rr-ink);
}

.tfd__v {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-style: italic;
  color: var(--rr-dim);
}

.tfd__row--open .tfd__v {
  visibility: hidden;
}

/* A plain value shows whole, wrapping when long. */
.tfd__leaf {
  min-width: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.tfd__v--string {
  color: var(--rr-ok);
}

.tfd__v--number,
.tfd__v--bigint {
  color: var(--rr-info);
}

.tfd__v--boolean {
  color: var(--rr-warn);
}

.tfd__v--time {
  color: var(--sw-purple);
}

.tfd__v--null {
  color: var(--rr-dim);
  font-style: italic;
}

.tfd__open {
  margin: 0 0 4px 16px;
  padding: 4px 8px;
  background: var(--rr-bg);
  border: 1px solid var(--rr-border);
  border-radius: var(--rr-radius-sm);
}
</style>
