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
import type { Catalog } from '@skywalking-horizon-ui/api-client';
import { setupMonaco, setModelCatalog, RR_THEME_NAME } from '../../../monaco/setup.js';

const props = defineProps<{
  modelValue: string;
  catalog: Catalog | null;
  readOnly?: boolean;
}>();

const emit = defineEmits<{
  'update:modelValue': [value: string];
  /** Fired when the operator clicks the green ▶ in the gutter next
   *  to a `- name: <X>` line. The parent decides how to route — for
   *  MAL/LAL editor pages, the catalog + file are already in the URL,
   *  so the parent just needs the rule/metric name. */
  'debug-click': [ruleName: string];
}>();

const host = ref<HTMLDivElement | null>(null);
let editor: monaco.editor.IStandaloneCodeEditor | null = null;
let model: monaco.editor.ITextModel | null = null;
let suppressChange = false;
let decorationCollection: monaco.editor.IEditorDecorationsCollection | null = null;
/** lineNumber → ruleName, refreshed on every model change so a click
 *  in the gutter resolves to the rule on that line without a re-scan. */
const lineToRule = new Map<number, string>();

/** MAL + LAL share the same `- name: <X>` shape inside YAML lists.
 *  Capture group 1 = metric / rule name. */
const RULE_NAME_RE = /^[ \t]*-[ \t]+name:[ \t]*([A-Za-z_][A-Za-z0-9_-]*)/gm;

function refreshDecorations(): void {
  lineToRule.clear();
  if (!model || !decorationCollection) return;
  const text = model.getValue();
  const decorations: monaco.editor.IModelDeltaDecoration[] = [];
  // Iterate matches and convert byte offsets to (line, column).
  let m: RegExpExecArray | null;
  RULE_NAME_RE.lastIndex = 0;
  while ((m = RULE_NAME_RE.exec(text)) !== null) {
    // Compute line number from the match offset.
    let line = 1;
    for (let i = 0; i < m.index; i++) {
      if (text.charCodeAt(i) === 10 /* \n */) line += 1;
    }
    const ruleName = m[1]!;
    lineToRule.set(line, ruleName);
    decorations.push({
      range: new monaco.Range(line, 1, line, 1),
      options: {
        glyphMarginClassName: 'rr-debug-glyph',
        glyphMarginHoverMessage: {
          value: `Live debug · **${ruleName}**`,
        },
      },
    });
  }
  decorationCollection.set(decorations);
}

onMounted(() => {
  if (!host.value) return;
  setupMonaco();

  model = monaco.editor.createModel(props.modelValue, 'yaml');
  if (props.catalog) setModelCatalog(model, props.catalog);

  editor = monaco.editor.create(host.value, {
    model,
    theme: RR_THEME_NAME,
    automaticLayout: true,
    fontFamily: "'JetBrains Mono', ui-monospace, monospace",
    fontSize: 13,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    tabSize: 2,
    insertSpaces: true,
    readOnly: props.readOnly ?? false,
    renderWhitespace: 'selection',
    smoothScrolling: true,
    wordWrap: 'off',
    /* Glyph margin hosts the green ▶ next to each `- name: …`
     * row so the operator can jump to the live debugger from
     * the editor without re-typing the metric name. */
    glyphMargin: true,
  });

  decorationCollection = editor.createDecorationsCollection([]);
  refreshDecorations();

  model.onDidChangeContent(() => {
    if (!suppressChange && model) emit('update:modelValue', model.getValue());
    refreshDecorations();
  });

  editor.onMouseDown((e) => {
    if (e.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) return;
    const line = e.target.position?.lineNumber;
    if (typeof line !== 'number') return;
    const ruleName = lineToRule.get(line);
    if (ruleName) emit('debug-click', ruleName);
  });
});

watch(
  () => props.modelValue,
  (next) => {
    if (model && model.getValue() !== next) {
      suppressChange = true;
      try {
        model.setValue(next);
      } finally {
        suppressChange = false;
      }
    }
  },
);

watch(
  () => props.catalog,
  (next) => {
    if (model && next) setModelCatalog(model, next);
  },
);

watch(
  () => props.readOnly,
  (ro) => {
    if (editor) editor.updateOptions({ readOnly: ro ?? false });
  },
);

onBeforeUnmount(() => {
  editor?.dispose();
  model?.dispose();
  editor = null;
  model = null;
  decorationCollection = null;
});
</script>

<template>
  <div ref="host" class="monaco" :data-testid="'monaco-yaml'" />
</template>

<style scoped>
.monaco {
  width: 100%;
  height: 100%;
  min-height: 320px;
}

/* Live-debug entrance rendered on every `- name: …` row inside the
 * MAL / LAL editor. Monaco creates the glyph DOM dynamically inside
 * .monaco, so :deep() is required to reach it from scoped styles.
 * SVG fill is hard-coded to the resolved --sw-ok value because
 * background-image: url() cannot reference CSS variables. */
.monaco :deep(.rr-debug-glyph) {
  cursor: pointer;
  width: 14px !important;
  height: 14px !important;
  margin-left: 4px;
  background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><path d='M5 3.5v9l8-4.5z' fill='%2322c55e'/></svg>");
  background-repeat: no-repeat;
  background-position: center;
  background-size: 12px 12px;
  opacity: 0.6;
  border-radius: 2px;
  transition: opacity 0.12s, background-color 0.12s;
}
.monaco :deep(.rr-debug-glyph:hover) {
  opacity: 1;
  background-color: var(--sw-ok-soft);
}
</style>
