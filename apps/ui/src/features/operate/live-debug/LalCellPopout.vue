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
 * Full-data inspect popout for one LAL matrix cell. Opens the cell's
 * complete payload as a syntax-highlighted JSON viewer. The compare
 * picker IS the captured DSL: every rule line, with per-statement sibling
 * steps marked `▶` on their line and the block-level snapshots
 * (extractor / output) drawn as an accent-barred range over their whole
 * `{…}` block — click any of them to diff. The opened cell's line is
 * marked `◆`. Picking swaps the viewer for a side-by-side diff. The input
 * row has no comparator (its raw-proto format differs).
 */
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import Modal from '@/features/operate/_shared/Modal.vue';
import MonacoView from '@/features/operate/_shared/MonacoView.vue';
import MonacoDiff from '@/features/operate/_shared/MonacoDiff.vue';
import FloatingPanel from '@/components/primitives/FloatingPanel.vue';
import Icon from '@/components/icons/Icon.vue';

const props = defineProps<{
  open: boolean;
  title: string;
  /** The opened cell's verbatim DSL statement (empty for block-level steps). */
  script: string;
  /** The opened cell's complete payload, pretty JSON. */
  json: string;
  /** Same-format sibling cells. `lineStart..lineEnd` is the DSL span
   *  (equal for per-statement steps, the block range for block steps). */
  comparable: { label: string; script: string; json: string; lineStart: number; lineEnd: number }[];
  /** The captured DSL, one entry per line. */
  dslLines: string[];
  /** The opened cell's 1-based DSL line (0 if unmapped). */
  currentLine: number;
}>();
defineEmits<{ close: [] }>();

const { t } = useI18n();

/** Index into `comparable`, or -1 for the single-cell view. */
const compareIdx = ref<number>(-1);
const ddOpen = ref<boolean>(false);
const ddAnchor = ref<HTMLElement | null>(null);

watch(
  () => props.title,
  () => {
    compareIdx.value = -1;
    ddOpen.value = false;
  },
);

/** 1-based opening line → comparable index (the `▶` + click anchor). */
const startToCmp = computed(() => {
  const m = new Map<number, number>();
  props.comparable.forEach((c, i) => {
    if (c.lineStart > 0) m.set(c.lineStart, i);
  });
  return m;
});
/** Every line inside a multi-line block range → its comparable index
 *  (the accent range bar; also lets clicking anywhere in the block pick it). */
const blockLineToCmp = computed(() => {
  const m = new Map<number, number>();
  props.comparable.forEach((c, i) => {
    if (c.lineEnd > c.lineStart) {
      for (let ln = c.lineStart; ln <= c.lineEnd; ln++) m.set(ln, i);
    }
  });
  return m;
});
/** Steps with no DSL span at all — kept as a fallback list (rare). */
const lineless = computed(() =>
  props.comparable.map((c, i) => ({ c, i })).filter((x) => x.c.lineStart <= 0),
);

const compareJson = computed(() =>
  compareIdx.value >= 0 ? (props.comparable[compareIdx.value]?.json ?? '') : '',
);
const selectedLabel = computed(() =>
  compareIdx.value >= 0 ? (props.comparable[compareIdx.value]?.label ?? '') : '—',
);

function pick(i: number): void {
  compareIdx.value = compareIdx.value === i ? -1 : i;
  ddOpen.value = false;
}
function pickLine(n: number): void {
  const idx = startToCmp.value.get(n) ?? blockLineToCmp.value.get(n);
  if (idx !== undefined) pick(idx);
}
function clearCompare(): void {
  compareIdx.value = -1;
}
</script>

<template>
  <Modal :open="open" :title="title" width="82vw" :fit-body="true" @close="$emit('close')">
    <div class="lpop">
      <pre v-if="script" class="lpop__script">{{ script }}</pre>

      <div v-if="comparable.length > 0" class="lpop__bar">
        <span class="lpop__lbl">{{ t('compare with') }}</span>
        <button
          ref="ddAnchor"
          type="button"
          class="lpop__ddbtn"
          :class="{ 'lpop__ddbtn--on': compareIdx >= 0 }"
          @click="ddOpen = !ddOpen"
        >
          <span>{{ selectedLabel }}</span>
          <Icon name="caret" :size="10" />
        </button>
        <button
          v-if="compareIdx >= 0"
          type="button"
          class="lpop__clear"
          :title="t('clear')"
          @click="clearCompare"
        >
          ✕
        </button>
        <span v-if="compareIdx >= 0" class="lpop__hint">{{ t('diff vs this cell') }}</span>
      </div>

      <FloatingPanel :open="ddOpen" :anchor="ddAnchor" :width="800" @close="ddOpen = false">
        <div class="lpop__menu">
          <div class="lpop__dsl">
            <button
              v-for="(line, i) in dslLines"
              :key="i"
              type="button"
              class="lpop__dline"
              :class="{
                'lpop__dline--cmp': startToCmp.has(i + 1) || blockLineToCmp.has(i + 1),
                'lpop__dline--block': blockLineToCmp.has(i + 1),
                'lpop__dline--cur': i + 1 === currentLine,
                'lpop__dline--sel':
                  startToCmp.get(i + 1) === compareIdx || blockLineToCmp.get(i + 1) === compareIdx,
              }"
              @click="pickLine(i + 1)"
            >
              <span class="lpop__dgut">{{ i + 1 }}</span>
              <span class="lpop__dmark">{{
                i + 1 === currentLine ? '◆' : startToCmp.has(i + 1) ? '▶' : ''
              }}</span>
              <code class="lpop__dtext">{{ line }}</code>
            </button>
          </div>

          <template v-if="lineless.length > 0">
            <div class="lpop__sep">{{ t('other') }}</div>
            <button
              v-for="x in lineless"
              :key="`l-${x.i}`"
              type="button"
              class="lpop__opt"
              :class="{ 'lpop__opt--sel': compareIdx === x.i }"
              @click="pick(x.i)"
            >
              <span class="lpop__opttag">{{ x.c.label }}</span>
              <code v-if="x.c.script" class="lpop__optscript">{{ x.c.script }}</code>
            </button>
          </template>
        </div>
      </FloatingPanel>

      <div class="lpop__view">
        <MonacoDiff
          v-if="compareIdx >= 0"
          :original="compareJson"
          :modified="json"
          language="json"
        />
        <MonacoView v-else :value="json" language="json" />
      </div>
    </div>
  </Modal>
</template>

<style scoped>
.lpop {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.lpop__script {
  margin: 0;
  padding: 6px 9px;
  background: var(--rr-bg);
  border: 1px solid var(--rr-border);
  border-left: 2px solid var(--rr-accent, var(--rr-active));
  color: var(--rr-ink2);
  font-family: var(--rr-font-mono);
  font-size: var(--sw-fs-sm);
  line-height: 1.4;
  white-space: pre-wrap;
  word-break: break-word;
  flex-shrink: 0;
}

.lpop__bar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.lpop__lbl {
  font-size: var(--sw-fs-xs);
  text-transform: uppercase;
  letter-spacing: var(--sw-ls-caps);
  color: var(--rr-dim);
}

.lpop__ddbtn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 160px;
  justify-content: space-between;
  background: var(--rr-bg);
  border: 1px solid var(--rr-border);
  color: var(--rr-ink);
  font-family: var(--rr-font-mono);
  font-size: var(--sw-fs-sm);
  padding: 3px 8px;
  cursor: pointer;
}

.lpop__ddbtn--on {
  border-color: var(--rr-accent, var(--rr-active));
  color: var(--rr-accent, var(--rr-active));
}

.lpop__clear {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  background: var(--rr-bg);
  border: 1px solid var(--rr-border);
  color: var(--rr-dim);
  cursor: pointer;
}

.lpop__clear:hover {
  color: var(--rr-ink);
  border-color: var(--rr-ink2);
}

.lpop__hint {
  font-size: var(--sw-fs-xs);
  color: var(--rr-dim);
}

.lpop__menu {
  display: flex;
  flex-direction: column;
  background: var(--rr-bg);
  overflow: auto;
  max-height: calc(100vh - 16px);
}

/* The captured-DSL row selector. */
.lpop__dsl {
  display: flex;
  flex-direction: column;
  padding: 4px 0;
}

.lpop__dline {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  width: 100%;
  text-align: left;
  background: transparent;
  border: 0;
  border-left: 2px solid transparent;
  padding: 2px 12px;
  cursor: default;
  color: var(--rr-dim);
}

.lpop__dline--cmp {
  cursor: pointer;
  color: var(--rr-ink);
}

.lpop__dline--cmp:hover {
  background: var(--rr-bg2);
}

/* Block-level range (extractor / sink) — a continuous accent rail. */
.lpop__dline--block {
  border-left-color: var(--rr-accent, var(--rr-active));
  color: var(--rr-ink);
}

.lpop__dline--cur {
  color: var(--rr-ink);
  background: color-mix(in srgb, var(--rr-accent, var(--rr-active)) 9%, var(--rr-bg));
}

.lpop__dline--sel {
  background: color-mix(in srgb, var(--rr-accent, var(--rr-active)) 20%, var(--rr-bg));
}

.lpop__dgut {
  flex-shrink: 0;
  width: 22px;
  text-align: right;
  color: var(--rr-dim);
  font-family: var(--rr-font-mono);
  font-size: var(--sw-fs-xs);
  user-select: none;
  line-height: 1.4;
}

.lpop__dmark {
  flex-shrink: 0;
  width: 10px;
  color: var(--rr-accent, var(--rr-active));
  font-size: var(--sw-fs-xs);
  line-height: 1.4;
}

.lpop__dtext {
  flex: 1;
  min-width: 0;
  font-family: var(--rr-font-mono);
  font-size: var(--sw-fs-sm);
  white-space: pre-wrap;
  word-break: break-word;
  line-height: 1.4;
}

.lpop__sep {
  padding: 6px 12px 2px;
  font-size: var(--sw-fs-xs);
  text-transform: uppercase;
  letter-spacing: var(--sw-ls-caps);
  color: var(--rr-dim);
  border-top: 1px solid var(--rr-border);
}

.lpop__opt {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
  width: 100%;
  text-align: left;
  background: transparent;
  border: 0;
  border-bottom: 1px solid var(--rr-border);
  padding: 8px 12px;
  cursor: pointer;
}

.lpop__opt:hover {
  background: var(--rr-bg2);
}

.lpop__opt--sel {
  background: color-mix(in srgb, var(--rr-accent, var(--rr-active)) 12%, var(--rr-bg));
}

.lpop__opttag {
  font-family: var(--rr-font-mono);
  font-size: var(--sw-fs-xs);
  font-weight: var(--sw-fw-bold);
  text-transform: uppercase;
  letter-spacing: var(--sw-ls-caps);
  color: var(--rr-accent, var(--rr-active));
}

.lpop__optscript {
  font-family: var(--rr-font-mono);
  font-size: var(--sw-fs-sm);
  color: var(--rr-ink2);
  white-space: pre-wrap;
  word-break: break-word;
  line-height: 1.4;
}

.lpop__view {
  flex: 1;
  min-height: 0;
  border: 1px solid var(--rr-border);
}
</style>
