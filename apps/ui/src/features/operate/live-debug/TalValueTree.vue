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
 * A value as a tree, as a debugger's variables view shows one: `name = value`
 * for a leaf, coloured by type; an object or a list folds open by its name,
 * showing its value in gray while folded. A value with no name lists its
 * fields directly.
 */
import { computed, ref } from 'vue';
import { shortValue, timeText } from './talDebug.js';

defineOptions({ name: 'TalValueTree' });

const props = withDefaults(
  defineProps<{
    value: unknown;
    name?: string;
    /** Open the first levels; deeper ones start folded. */
    openDepth?: number;
    depth?: number;
  }>(),
  { name: '', openDepth: 1, depth: 0 },
);

const isBranch = computed(() => props.value !== null && typeof props.value === 'object');
const entries = computed<[string, unknown][]>(() => {
  if (!isBranch.value) return [];
  return Array.isArray(props.value)
    ? props.value.map((v, i) => [String(i), v] as [string, unknown])
    : Object.entries(props.value as Record<string, unknown>);
});
const open = ref(props.depth < props.openDepth);


const leafClass = computed(() => {
  const v = props.value;
  if (v === null || v === undefined) return 'tvt__v--null';
  return `tvt__v--${typeof v}`;
});

/** A time field reads as the browser's local time; its raw value is the title. */
const time = computed(() => timeText(props.name, props.value));

const leafText = computed(() => {
  const v = props.value;
  if (time.value) return time.value;
  if (v === undefined) return 'undefined';
  if (typeof v === 'string') return JSON.stringify(v);
  return String(v);
});
</script>

<template>
  <div class="tvt" :class="{ 'tvt--root': depth === 0 }">
    <div v-if="isBranch && !name" class="tvt__fields">
      <TalValueTree
        v-for="[k, v] in entries"
        :key="k"
        :name="k"
        :value="v"
        :open-depth="openDepth"
        :depth="depth"
      />
    </div>
    <div v-else-if="isBranch" class="tvt__row">
      <button type="button" class="tvt__toggle" @click="open = !open">
        <span class="tvt__caret">{{ open ? '▾' : '▸' }}</span>
        <span class="tvt__k">{{ name }}</span>
        <span v-if="!open" class="tvt__sum">{{ shortValue(value) }}</span>
      </button>
    </div>
    <div v-else class="tvt__row tvt__row--leaf">
      <span v-if="name" class="tvt__k">{{ name }}</span>
      <span v-if="name" class="tvt__eq">=</span>
      <span class="tvt__v" :class="time ? 'tvt__v--time' : leafClass" :title="time ? String(value) : undefined">{{ leafText }}</span>
    </div>
    <div v-if="isBranch && name && open" class="tvt__kids">
      <TalValueTree
        v-for="[k, v] in entries"
        :key="k"
        :name="k"
        :value="v"
        :open-depth="openDepth"
        :depth="depth + 1"
      />
    </div>
  </div>
</template>

<style scoped>
.tvt {
  font-family: var(--rr-font-mono);
  font-size: var(--sw-fs-sm);
  line-height: 1.6;
  color: var(--rr-ink);
}

.tvt__kids {
  padding-left: 14px;
  border-left: 1px dotted var(--rr-border);
  margin-left: 5px;
}

.tvt__row {
  display: flex;
  align-items: baseline;
  gap: 4px;
  min-width: 0;
}

.tvt__row--leaf {
  padding-left: 14px;
}

.tvt__toggle {
  display: inline-flex;
  align-items: baseline;
  gap: 4px;
  background: transparent;
  border: 0;
  padding: 0;
  font: inherit;
  color: inherit;
  cursor: pointer;
  text-align: left;
}

.tvt__caret {
  width: 10px;
  color: var(--rr-dim);
}

.tvt__k {
  color: var(--rr-heading);
}

.tvt__eq {
  color: var(--rr-dim);
}

.tvt__sum {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-style: italic;
  color: var(--rr-dim);
}

.tvt__toggle {
  min-width: 0;
  max-width: 100%;
}

.tvt__v {
  white-space: pre-wrap;
  word-break: break-all;
}

.tvt__v--string {
  color: var(--rr-ok);
}

.tvt__v--number,
.tvt__v--bigint {
  color: var(--rr-info);
}

.tvt__v--boolean {
  color: var(--rr-warn);
}

.tvt__v--time {
  color: var(--sw-purple);
}

.tvt__v--null {
  color: var(--rr-dim);
  font-style: italic;
}
</style>
