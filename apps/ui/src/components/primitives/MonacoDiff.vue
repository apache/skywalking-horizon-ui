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
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import * as monaco from 'monaco-editor';
import { setupMonaco, RR_THEME_NAME } from '@/monaco/setup';

const props = withDefaults(
  defineProps<{
    /** "before" — what's currently on the server (or bundled). */
    original: string;
    /** "after" — what the user has in the buffer. */
    modified: string;
    /** Monaco language id for syntax highlighting. Defaults to `yaml`
     *  because the rule editor (the original caller) is YAML; the
     *  template-diff modal passes `json`. */
    language?: string;
  }>(),
  { language: 'yaml' },
);

const host = ref<HTMLDivElement | null>(null);
let diff: monaco.editor.IStandaloneDiffEditor | null = null;
let originalModel: monaco.editor.ITextModel | null = null;
let modifiedModel: monaco.editor.ITextModel | null = null;

onMounted(() => {
  if (!host.value) return;
  setupMonaco();

  originalModel = monaco.editor.createModel(props.original, props.language);
  modifiedModel = monaco.editor.createModel(props.modified, props.language);

  diff = monaco.editor.createDiffEditor(host.value, {
    theme: RR_THEME_NAME,
    automaticLayout: true,
    fontFamily: "'JetBrains Mono', ui-monospace, monospace",
    fontSize: 13,
    minimap: { enabled: false },
    renderSideBySide: true,
    // Monaco collapses to a single inline column when the editor is
    // narrower than ~900px (default). That hides the "original" (left)
    // side entirely. Keep side-by-side regardless of width so the
    // bundled-vs-remote comparison always shows both columns.
    useInlineViewWhenSpaceIsLimited: false,
    readOnly: true,
    originalEditable: false,
  });
  diff.setModel({ original: originalModel, modified: modifiedModel });
});

watch(
  () => props.original,
  (next) => {
    if (originalModel && originalModel.getValue() !== next) originalModel.setValue(next);
  },
);
watch(
  () => props.modified,
  (next) => {
    if (modifiedModel && modifiedModel.getValue() !== next) modifiedModel.setValue(next);
  },
);

onBeforeUnmount(() => {
  diff?.dispose();
  originalModel?.dispose();
  modifiedModel?.dispose();
  diff = null;
  originalModel = null;
  modifiedModel = null;
});
</script>

<template>
  <div ref="host" class="diff" :data-testid="'monaco-diff'" />
</template>

<style scoped>
.diff {
  width: 100%;
  height: 100%;
  min-height: 320px;
}
</style>
