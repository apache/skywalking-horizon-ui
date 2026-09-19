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
  The TraceQL expression field: highlighting, completion fed by the store's own
  schema, and the lint's findings as editor markers on the text they are about.

  The schema is attached to the MODEL rather than passed to a provider, so one
  language registration serves both datasources without either one's tags
  leaking into the other's suggestions.
-->
<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import * as monaco from 'monaco-editor';
import { RR_THEME_NAME, setupMonaco, type TraceQLSchema } from '@/monaco/setup';
import { TRACEQL_LANGUAGE_ID } from '@/monaco/traceql-grammar';
import { lintTraceQL } from './traceqlLint';

const props = defineProps<{ modelValue: string; schema: TraceQLSchema; messageFor: (id: string) => string }>();

/** The shape of a query — one spanset, conditions joined with `&&`, a duration
 *  bound — shown behind an empty editor so it is visible before anything is
 *  typed. */
const EXAMPLE = '{resource.service.name="agent::songs" && span.http.method="GET" && duration>100ms}';
const emit = defineEmits<{ 'update:modelValue': [value: string]; run: [] }>();

const host = ref<HTMLElement | null>(null);
const editor = shallowRef<monaco.editor.IStandaloneCodeEditor | null>(null);
const model = shallowRef<(monaco.editor.ITextModel & { __tqlSchema?: TraceQLSchema }) | null>(null);

/** Put the lint on the text it is about, so a marker is read where the problem
 *  is rather than in a list underneath. */
function applyMarkers(): void {
  const m = model.value;
  if (!m) return;
  const text = m.getValue();
  const markers: monaco.editor.IMarkerData[] = [];
  // The SAME datasource the notice below lints for — the two stores' schemas
  // differ, and two surfaces disagreeing about one expression is worse than
  // either being silent.
  for (const issue of lintTraceQL(text, props.schema.ds)) {
    const at = issue.found ? text.indexOf(issue.found) : -1;
    const start = at >= 0 ? m.getPositionAt(at) : { lineNumber: 1, column: 1 };
    const end = at >= 0 ? m.getPositionAt(at + issue.found.length) : { lineNumber: 1, column: text.length + 1 };
    markers.push({
      // A warning, never an error: none of these stops the query.
      severity: monaco.MarkerSeverity.Warning,
      message: props.messageFor(issue.id),
      startLineNumber: start.lineNumber,
      startColumn: start.column,
      endLineNumber: end.lineNumber,
      endColumn: end.column,
    });
  }
  monaco.editor.setModelMarkers(m, 'traceql', markers);
}

onMounted(() => {
  setupMonaco();
  if (!host.value) return;
  const m = monaco.editor.createModel(props.modelValue, TRACEQL_LANGUAGE_ID);
  (m as monaco.editor.ITextModel & { __tqlSchema?: TraceQLSchema }).__tqlSchema = props.schema;
  model.value = m;
  const ed = monaco.editor.create(host.value, {
    model: m,
    theme: RR_THEME_NAME,
    fontSize: 13,
    lineHeight: 20,
    // Monaco lays itself out inside its host, so breathing room has to come
    // from ITS padding, not the container's — padding on the host would clip
    // the cursor at the edges instead.
    padding: { top: 8, bottom: 8 },
    lineNumbers: 'off',
    minimap: { enabled: false },
    scrollbar: { vertical: 'auto', horizontal: 'auto' },
    scrollBeyondLastLine: false,
    folding: false,
    lineDecorationsWidth: 12,
    overviewRulerLanes: 0,
    renderLineHighlight: 'none',
    wordWrap: 'on',
    automaticLayout: true,
    fixedOverflowWidgets: true,
  });
  editor.value = ed;
  ed.onDidChangeModelContent(() => {
    emit('update:modelValue', m.getValue());
    applyMarkers();
  });
  // Shift+Enter runs, as Tempo's own editor does; a plain Enter is a newline.
  ed.addCommand(monaco.KeyMod.Shift | monaco.KeyCode.Enter, () => emit('run'));
  applyMarkers();
});

watch(
  () => props.modelValue,
  (v) => {
    const m = model.value;
    if (m && m.getValue() !== v) m.setValue(v);
  },
);
watch(
  () => props.schema,
  (s) => {
    if (model.value) model.value.__tqlSchema = s;
    // The datasource decides which rules apply, so the markers are re-read
    // when it changes rather than describing the store left behind.
    applyMarkers();
  },
);

onBeforeUnmount(() => {
  const m = model.value;
  editor.value?.dispose();
  if (m) {
    monaco.editor.setModelMarkers(m, 'traceql', []);
    m.dispose();
  }
});
</script>

<template>
  <div class="tql-editor-wrap">
    <div ref="host" class="tql-monaco" />
    <!-- An example, not a value: it shows only while the editor is empty and
         takes no pointer events, so the first click lands in the editor. The
         builder writes real expressions of exactly this shape. -->
    <p v-if="!modelValue.trim()" class="tql-monaco-example mono" aria-hidden="true">{{ EXAMPLE }}</p>
  </div>
</template>

<style scoped>
.tql-editor-wrap { position: relative; }
.tql-monaco {
  /* Room for a real expression: three or four conditions wrap past 66px, and
     an editor that scrolls at its second line reads as a single-line input. */
  height: 132px;
  border: 1px solid var(--sw-line-2);
  border-radius: 4px;
  overflow: hidden;
}
.tql-monaco-example {
  position: absolute;
  /* Exactly where the first typed character lands — measured against the
     rendered view line, so the example does not shift as you start typing. */
  top: 9px;
  left: 13px;
  right: 12px;
  margin: 0;
  pointer-events: none;
  font-size: 13px;
  line-height: 20px;
  color: var(--sw-fg-3);
  opacity: 0.55;
  overflow-wrap: anywhere;
}
</style>
