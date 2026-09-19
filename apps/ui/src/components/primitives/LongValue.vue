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
  A value that may be far longer than the row it sits in — a SQL statement, a
  stack trace, a serialized payload.

  Short values render as themselves and cost nothing. A long one previews its
  first `limit` characters on one line, with a button that opens the whole thing
  in a scrollable dialog and a Copy that takes the WHOLE value, not the visible
  part. It knows nothing about traces, spans or logs: it is text with a length.
-->
<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import Modal from './Modal.vue';

const props = withDefaults(
  defineProps<{
    value: string;
    /** Names the value in the dialog's title. */
    label?: string;
    /** Characters kept inline. Past this the value is cut, and the dialog is
     *  the way to read it whole and to copy it. */
    limit?: number;
  }>(),
  { label: '', limit: 100 },
);

const { t } = useI18n({ useScope: 'global' });

const firstBreak = computed(() => props.value.indexOf('\n'));
/** Long by length, or carrying more than one line — either way the row cannot
 *  show it and the dialog must. */
const isLong = computed(
  () => props.value.length > props.limit || (firstBreak.value >= 0 && firstBreak.value < props.value.length - 1),
);
/** The preview collapses runs of whitespace rather than stopping at the first
 *  newline: a pretty-printed payload opens on `[` or `{`, and cutting there
 *  previews one character of a body the operator is trying to recognise. */
const collapsed = computed(() => (isLong.value ? props.value.replace(/\s+/g, ' ').trim() : props.value));
const shown = computed(() => collapsed.value.slice(0, props.limit));
/** Only when something was actually cut: a value long in whitespace alone
 *  collapses to fit, and an ellipsis there would claim a cut that never was. */
const truncated = computed(() => collapsed.value.length > props.limit);

const open = ref(false);
const copied = ref(false);
let copiedTimer: ReturnType<typeof setTimeout> | null = null;
function copyAll(): void {
  navigator.clipboard?.writeText(props.value).then(() => {
    copied.value = true;
    if (copiedTimer) clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => { copied.value = false; }, 1400);
  }, () => {});
}
</script>

<template>
  <span class="lv">
    <span class="lv-text">{{ shown }}</span>
    <template v-if="isLong">
      <span v-if="truncated" class="lv-ellipsis">…</span>
      <button
        type="button"
        class="lv-more"
        :title="t('Show the full value')"
        @click.stop="open = true"
      >{{ t('full') }}</button>
    </template>
  </span>

  <Modal :open="open" :title="label || t('Value')" width="min(880px, 92vw)" @close="open = false">
    <div class="lv-dialog">
      <div class="lv-dialog-bar">
        <span class="lv-size mono">{{ t('{n} characters', { n: value.length }) }}</span>
        <button type="button" class="sw-btn small ghost" @click="copyAll">⧉ {{ t('Copy') }}</button>
        <transition name="lv-flash">
          <span v-if="copied" class="lv-copied">{{ t('copied') }}</span>
        </transition>
      </div>
      <pre class="lv-full mono">{{ value }}</pre>
    </div>
  </Modal>
</template>

<style scoped>
.lv { display: inline; min-width: 0; }
.lv-text { overflow-wrap: anywhere; }
.lv-ellipsis { color: var(--sw-fg-3); }
.lv-more {
  margin-left: 6px;
  padding: 0 5px;
  height: 15px;
  border: 1px solid var(--sw-line-2);
  border-radius: 3px;
  background: var(--sw-bg-2);
  color: var(--sw-fg-2);
  font: inherit;
  font-size: 9.5px;
  line-height: 13px;
  cursor: pointer;
  vertical-align: baseline;
}
.lv-more:hover { border-color: var(--sw-accent); color: var(--sw-accent); }
.lv-dialog { display: flex; flex-direction: column; gap: 8px; }
.lv-dialog-bar { display: flex; align-items: center; gap: 8px; }
.lv-size { font-size: 10.5px; color: var(--sw-fg-3); margin-right: auto; }
.lv-copied { font-size: 10px; color: var(--sw-accent); border: 1px solid var(--sw-accent); border-radius: 3px; padding: 0 5px; }
.lv-flash-enter-active, .lv-flash-leave-active { transition: opacity 0.2s; }
.lv-flash-enter-from, .lv-flash-leave-to { opacity: 0; }
.lv-full {
  margin: 0;
  padding: 10px 12px;
  max-height: min(60vh, 520px);
  overflow: auto;
  background: var(--sw-bg-1);
  border: 1px solid var(--sw-line-1);
  border-radius: 6px;
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--sw-fg-0);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.mono { font-family: var(--sw-mono); }
</style>
