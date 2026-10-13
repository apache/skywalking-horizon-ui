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
 * Read-only Monaco viewer — a single editor for inspecting a value with
 * syntax highlighting: an LAL cell's full payload, an MQE response, a
 * template with its problems marked.
 * The editable counterpart is `MonacoYaml` (which stays with the feature
 * that owns rule editing); the two-pane diff is `MonacoDiff`.
 */
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import * as monaco from 'monaco-editor';
import { setupMonaco, RR_THEME_NAME } from '@/monaco/setup';

export interface MonacoViewMarker {
  /** Character offset into `value`. */
  offset: number;
  /** Characters to underline; anything below 1 underlines one. */
  length: number;
  message: string;
}

const props = withDefaults(
  defineProps<{
    value: string;
    language?: string;
    /** Error squiggles over ranges of `value`, with `message` on hover. */
    markers?: MonacoViewMarker[];
  }>(),
  { language: 'json', markers: () => [] },
);

const MARKER_OWNER = 'monaco-view';

const host = ref<HTMLDivElement | null>(null);
let editor: monaco.editor.IStandaloneCodeEditor | null = null;
let model: monaco.editor.ITextModel | null = null;

function applyMarkers(): void {
  if (!model) return;
  const m = model;
  // A read-only editor draws no error squiggles by default ('editable'), so
  // a view handed markers asks for them explicitly.
  editor?.updateOptions({ renderValidationDecorations: props.markers.length > 0 ? 'on' : 'editable' });
  monaco.editor.setModelMarkers(
    m,
    MARKER_OWNER,
    props.markers.map((mk) => {
      const start = m.getPositionAt(mk.offset);
      const end = m.getPositionAt(mk.offset + Math.max(1, mk.length));
      return {
        severity: monaco.MarkerSeverity.Error,
        message: mk.message,
        startLineNumber: start.lineNumber,
        startColumn: start.column,
        endLineNumber: end.lineNumber,
        endColumn: end.column,
      };
    }),
  );
}

/** Scroll `offset`'s line to the middle of the view and put the cursor on it. */
function revealOffset(offset: number): void {
  if (!editor || !model) return;
  const pos = model.getPositionAt(offset);
  editor.setPosition(pos);
  editor.revealLineInCenter(pos.lineNumber);
}

defineExpose({ revealOffset });

onMounted(() => {
  if (!host.value) return;
  setupMonaco();
  model = monaco.editor.createModel(props.value, props.language);
  editor = monaco.editor.create(host.value, {
    model,
    theme: RR_THEME_NAME,
    automaticLayout: true,
    fontFamily: "'JetBrains Mono', ui-monospace, monospace",
    fontSize: 13,
    minimap: { enabled: false },
    readOnly: true,
    scrollBeyondLastLine: false,
    wordWrap: 'on',
  });
  applyMarkers();
});

watch(
  () => props.value,
  (next) => {
    if (model && model.getValue() !== next) model.setValue(next);
    // Offsets are into the new text, so they are re-read rather than left
    // to drift with the replaced content.
    applyMarkers();
  },
);
watch(() => props.markers, applyMarkers, { deep: true });
watch(
  () => props.language,
  (next) => {
    if (model) monaco.editor.setModelLanguage(model, next);
  },
);

onBeforeUnmount(() => {
  editor?.dispose();
  if (model) monaco.editor.setModelMarkers(model, MARKER_OWNER, []);
  model?.dispose();
  editor = null;
  model = null;
});
</script>

<template>
  <div ref="host" class="mview" :data-testid="'monaco-view'" />
</template>

<style scoped>
.mview {
  width: 100%;
  height: 100%;
  min-height: 320px;
}
</style>
