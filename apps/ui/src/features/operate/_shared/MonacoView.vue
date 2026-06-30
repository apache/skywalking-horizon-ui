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
 * syntax highlighting (the inspect popout uses it for the cell's full
 * JSON). The editable counterpart is `MonacoYaml`; the two-pane diff is
 * `MonacoDiff`.
 */
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import * as monaco from 'monaco-editor';
import { setupMonaco, RR_THEME_NAME } from '../../../monaco/setup.js';

const props = withDefaults(
  defineProps<{ value: string; language?: string }>(),
  { language: 'json' },
);

const host = ref<HTMLDivElement | null>(null);
let editor: monaco.editor.IStandaloneCodeEditor | null = null;
let model: monaco.editor.ITextModel | null = null;

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
});

watch(
  () => props.value,
  (next) => {
    if (model && model.getValue() !== next) model.setValue(next);
  },
);
watch(
  () => props.language,
  (next) => {
    if (model) monaco.editor.setModelLanguage(model, next);
  },
);

onBeforeUnmount(() => {
  editor?.dispose();
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
