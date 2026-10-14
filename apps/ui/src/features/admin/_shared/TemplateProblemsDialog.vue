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
 * Why a template's JSON is not a usable template, shown on the JSON itself:
 * every problem is listed with its path and underlined where it sits, and
 * picking one from the list scrolls the text to it. Opened for a stored
 * template that does not load, and for a refused import — `text` is then the
 * imported file, verbatim.
 */
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import Modal from '@/components/primitives/Modal.vue';
import MonacoView, { type MonacoViewMarker } from '@/components/primitives/MonacoView.vue';
import Btn from '@/components/primitives/Btn.vue';
import { locateJsonPath, type JsonRange } from '@/utils/jsonLocate';
import { formatProblemPath, type TemplateProblem } from './templateProblems';

const props = defineProps<{
  open: boolean;
  title: string;
  /** The JSON shown, exactly as stored or imported; problem paths and offsets are into it. */
  text: string;
  problems: TemplateProblem[];
  /** Offers the text as a file of this name. */
  downloadName?: string;
}>();

const emit = defineEmits<{ close: [] }>();

const { t } = useI18n({ useScope: 'global' });

const view = ref<InstanceType<typeof MonacoView> | null>(null);
const selected = ref<number>(-1);

watch(
  () => [props.open, props.text, props.problems],
  () => {
    selected.value = -1;
  },
);

function rangeOf(problem: TemplateProblem): JsonRange | null {
  const { offset } = problem;
  if (offset === undefined) return locateJsonPath(props.text, problem.path);
  return Number.isInteger(offset) && offset >= 0 && offset <= props.text.length ? { offset, length: 1 } : null;
}

const rows = computed(() =>
  props.problems.map((problem) => {
    const path = formatProblemPath(problem.path, t('(root)'));
    return {
      path,
      message: problem.message,
      range: rangeOf(problem),
      // The squiggle can land on an ancestor (a missing key marks the object
      // that lacks it), so its hover names the path the message is about.
      hover: problem.path.length > 0 ? `${path}: ${problem.message}` : problem.message,
    };
  }),
);

const markers = computed<MonacoViewMarker[]>(() =>
  rows.value.flatMap((row) => (row.range ? [{ ...row.range, message: row.hover }] : [])),
);

function reveal(index: number): void {
  const range = rows.value[index]?.range;
  if (!range) return;
  selected.value = index;
  view.value?.revealOffset(range.offset);
}

/** The text as-is, not re-serialised: for a refused import that IS the
 *  operator's file, and reformatting it would move every reported offset. */
function download(): void {
  if (!props.downloadName) return;
  const url = URL.createObjectURL(new Blob([props.text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = props.downloadName;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke after the click is committed — Safari aborts the download if the
  // object URL is freed synchronously.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
</script>

<template>
  <Modal :open="open" :title="title" width="82vw" fit-body @close="emit('close')">
    <div class="tpd">
      <div class="tpd__head">
        <span class="tpd__count">{{ t('{n} problems', problems.length, { named: { n: problems.length } }) }}</span>
        <span v-if="markers.length > 0" class="tpd__hint">{{ t('Click a problem to show where it is in the document.') }}</span>
      </div>
      <div class="tpd__main">
        <ol class="tpd__list">
          <li v-for="(row, i) in rows" :key="i">
            <button
              type="button"
              class="tpd__item"
              :class="{ 'tpd__item--sel': i === selected }"
              :disabled="!row.range"
              @click="reveal(i)"
            >
              <code class="tpd__path">{{ row.path }}</code>
              <span class="tpd__msg">{{ row.message }}</span>
              <span v-if="!row.range" class="tpd__lost">{{ t('location not found') }}</span>
            </button>
          </li>
        </ol>
        <div class="tpd__view">
          <MonacoView ref="view" :value="text" language="json" :markers="markers" />
        </div>
      </div>
    </div>

    <template #footer>
      <Btn v-if="downloadName" @click="download">{{ t('Download') }}</Btn>
      <Btn @click="emit('close')">{{ t('Close') }}</Btn>
    </template>
  </Modal>
</template>

<style scoped>
.tpd {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.tpd__head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  flex-shrink: 0;
}

.tpd__count {
  font-family: var(--rr-font-mono);
  font-size: var(--sw-fs-md);
  font-weight: var(--sw-fw-semibold);
  color: var(--rr-err);
}

.tpd__hint {
  font-size: var(--sw-fs-sm);
  color: var(--rr-dim);
}

.tpd__main {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(240px, 30%) minmax(0, 1fr);
  grid-template-rows: minmax(0, 1fr);
  gap: 10px;
}

.tpd__list {
  margin: 0;
  padding: 0;
  list-style: none;
  overflow: auto;
  background: var(--rr-bg);
  border: 1px solid var(--rr-border);
}

.tpd__item {
  display: flex;
  flex-direction: column;
  gap: 3px;
  width: 100%;
  padding: 6px 9px;
  text-align: left;
  font: inherit;
  color: var(--rr-ink);
  background: transparent;
  border: 0;
  border-bottom: 1px solid var(--rr-border);
  border-left: 2px solid transparent;
  cursor: pointer;
}

.tpd__item:hover:not(:disabled) {
  background: var(--rr-bg2);
}

.tpd__item:disabled {
  cursor: default;
}

.tpd__item--sel {
  border-left-color: var(--rr-err);
  background: color-mix(in srgb, var(--rr-err) 10%, var(--rr-bg));
}

.tpd__path {
  font-family: var(--rr-font-mono);
  font-size: var(--sw-fs-sm);
  color: var(--rr-heading);
  word-break: break-all;
}

.tpd__msg {
  font-size: var(--sw-fs-sm);
  line-height: var(--sw-lh-normal);
  color: var(--rr-ink2);
  white-space: pre-wrap;
  word-break: break-word;
}

.tpd__lost {
  font-size: var(--sw-fs-xs);
  text-transform: uppercase;
  letter-spacing: var(--sw-ls-caps);
  color: var(--rr-warn);
}

.tpd__view {
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  border: 1px solid var(--rr-border);
}

/* Narrow screens: the list above the text instead of beside it. */
@media (max-width: 900px) {
  .tpd__main {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: minmax(0, 35%) minmax(0, 1fr);
  }
}
</style>
