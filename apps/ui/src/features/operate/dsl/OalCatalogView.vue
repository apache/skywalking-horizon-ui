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
 * OAL catalog browse — reads the upstream wire surface:
 *
 *   /runtime/oal/files          → bare file-name list
 *   /runtime/oal/files/{name}   → raw `.oal` text (text/plain)
 *
 * Single-pane view: file list on the left, line-numbered raw `.oal`
 * source on the right. The source / dispatcher / metric mapping is
 * computable from the file content itself; the live debugger picker
 * uses `/runtime/oal/rules` directly when it actually needs the
 * runtime-bound dispatcher set.
 */
import { computed, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useQuery } from '@tanstack/vue-query';
import { bff } from '@/api/client';
import Pill from '@/components/primitives/Pill.vue';
import Btn from '@/components/primitives/Btn.vue';
import { tokenizeLine, type Token } from './syntaxHighlight.js';
import AdminFeatureWarning from '@/shell/AdminFeatureWarning.vue';

const router = useRouter();

/** Detect a rule statement on this line and pull out the metric
 *  name (LHS of `=`) — the upstream debug install keys on
 *  `(catalog=oal, name=<file>, ruleName=<metric>)`, NOT the source
 *  class, so the jump must carry the metric for the picker to land
 *  on the right rule. OAL rule shape:
 *    `metricName = from(Source.field).filter(...).function();`
 *  Lines starting with `disable(` are bundled-rule overrides and
 *  aren't debuggable; lines starting with `//` or `#` are comments. */
const RULE_LINE_RE = /^([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*from\s*\(/;
function ruleMetricFor(line: string): string | null {
  const trimmed = line.trim();
  if (trimmed.startsWith('//') || trimmed.startsWith('#')) return null;
  if (/^disable\s*\(/.test(trimmed)) return null;
  const m = trimmed.match(RULE_LINE_RE);
  return m ? m[1]! : null;
}

function jumpToDebug(metric: string): void {
  const file = selectedFile.value;
  if (!file) return;
  void router.push({
    path: '/operate/live-debug/oal',
    query: { file, ruleName: metric },
  });
}

const selectedFile = ref<string | null>(null);
const fileContent = ref<string | null>(null);
const fileLoading = ref(false);
const fileError = ref<string | null>(null);

const filesQuery = useQuery({
  queryKey: ['oal/files'],
  queryFn: async () => bff.dsl.oalFiles(),
});

const files = computed<string[]>(() => filesQuery.data.value?.files ?? []);

watch(
  () => selectedFile.value,
  async (name) => {
    fileContent.value = null;
    fileError.value = null;
    if (!name) return;
    fileLoading.value = true;
    try {
      fileContent.value = await bff.dsl.oalFileContent(name);
      if (fileContent.value === null) fileError.value = 'file not found';
    } catch (err) {
      fileError.value = err instanceof Error ? err.message : String(err);
    } finally {
      fileLoading.value = false;
    }
  },
);

// Auto-select the first file when the listing loads.
watch(
  () => files.value,
  (list) => {
    if (selectedFile.value === null && list.length > 0) {
      selectedFile.value = list[0]!;
    }
  },
);

/** Materialise the raw `.oal` body into syntax-highlighted lines so
 *  the pane can show a line-number gutter alongside coloured tokens.
 *  Done locally — no DOM measurement, no IntersectionObserver — to
 *  keep the render predictable. */
interface FileLine {
  num: number;
  tokens: Token[];
  /** Set when the line carries a debuggable OAL rule statement —
   *  the metric name (LHS of `=`); surfaces the green ▶ in the
   *  gutter and feeds the deep-link target. */
  debugMetric: string | null;
}

const fileLines = computed<FileLine[]>(() => {
  const c = fileContent.value;
  if (c === null) return [];
  // Trailing-newline split would emit a phantom empty line; trim only
  // the trailing newline (preserve interior blank lines).
  const body = c.endsWith('\n') ? c.slice(0, -1) : c;
  return body.split('\n').map((text, i) => ({
    num: i + 1,
    tokens: tokenizeLine(text, 'oal'),
    debugMetric: ruleMetricFor(text),
  }));
});
</script>

<template>
  <div class="oal">
    <AdminFeatureWarning module="receiver-runtime-rule" feature-label="OAL catalog" />
    <header class="oal__header">
      <h1 class="oal__h1">OAL catalog</h1>
      <Pill tone="dim">read-only</Pill>
      <Btn
        size="sm"
        :disabled="filesQuery.isFetching.value"
        title="re-pull /runtime/oal/files"
        @click="filesQuery.refetch()"
      >{{ filesQuery.isFetching.value ? 'refreshing…' : 'refresh' }}</Btn>
      <span class="oal__hint">
        OAL hot-update is upstream-deferred. Each <code>.oal</code> file
        defines source classes (the input row the analyzer emits, e.g.
        <code>Endpoint</code>) and the metrics derived from them.
        Browse the loaded files below; install a live debug session
        from
        <router-link to="/operate/live-debug" class="oal__link">Live debugger</router-link>
        to see runtime metric capture.
      </span>
    </header>

    <section class="oal__pane">
      <header class="oal__paneh">
        files
        <span class="oal__panecount">{{ files.length }}</span>
      </header>

      <div v-if="filesQuery.isPending.value" class="oal__loading">loading…</div>
      <div v-else-if="filesQuery.isError.value" class="oal__error">
        Could not load OAL files.
        <button type="button" @click="filesQuery.refetch()">retry</button>
      </div>
      <div v-else-if="files.length === 0" class="oal__empty">
        no <code>.oal</code> files loaded
      </div>
      <div v-else class="oal__filelistwrap">
        <ul class="oal__filelist">
          <li v-for="f in files" :key="f">
            <button
              type="button"
              class="oal__fileitem"
              :class="{ 'oal__fileitem--active': selectedFile === f }"
              @click="selectedFile = f"
            >
              <code>{{ f }}</code>
            </button>
          </li>
        </ul>

        <div class="oal__filedetail">
          <header v-if="selectedFile" class="oal__filehead">
            <code>{{ selectedFile }}</code>
            <span v-if="fileLines.length > 0" class="oal__filemeta">
              {{ fileLines.length }} lines
            </span>
          </header>
          <div v-if="fileLoading" class="oal__loading">loading…</div>
          <div v-else-if="fileError" class="oal__error">{{ fileError }}</div>
          <pre v-else-if="fileContent !== null" class="oal__filepre"><span
            v-for="line in fileLines"
            :key="line.num"
            class="oal__line"
            :class="{ 'oal__line--debuggable': line.debugMetric !== null }"
          ><button
              v-if="line.debugMetric"
              type="button"
              class="oal__dbgbtn"
              :title="`Live debug: ${line.debugMetric}`"
              @click="jumpToDebug(line.debugMetric)"
            >▶</button><span
              v-else
              class="oal__dbgslot"
              aria-hidden="true"
            ></span><span class="oal__linenum">{{ line.num }}</span><span class="oal__linetext"><span
            v-for="(tok, ti) in line.tokens"
            :key="ti"
            :class="`hl hl--${tok.kind}`"
          >{{ tok.text }}</span></span></span></pre>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.oal {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 18px 24px;
  font-family: var(--rr-font-sans);
  color: var(--rr-ink);
  height: calc(100vh - 16px);
  min-height: 0;
}

.oal__header {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  flex-shrink: 0;
}

.oal__h1 {
  font-size: 13px;
  font-weight: 600;
  margin: 0;
  color: var(--rr-heading);
}

.oal__hint {
  font-size: 12.5px;
  color: var(--rr-dim);
  flex-basis: 100%;
  line-height: 1.5;
}

.oal__hint code {
  font-family: var(--rr-font-mono);
  background: var(--rr-bg);
  padding: 0 4px;
  color: var(--rr-ink2);
}

.oal__link {
  color: var(--rr-active);
  text-decoration: underline;
}

.oal__pane {
  display: flex;
  flex-direction: column;
  background: var(--rr-bg2);
  border: 1px solid var(--rr-border);
  overflow: hidden;
  min-height: 0;
  flex: 1 1 auto;
}

.oal__paneh {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  font-family: var(--rr-font-mono);
  font-size: 11.5px;
  letter-spacing: 1.2px;
  text-transform: uppercase;
  color: var(--rr-dim);
  border-bottom: 1px solid var(--rr-border);
  flex-shrink: 0;
}

.oal__panecount {
  color: var(--rr-ink2);
  letter-spacing: 0.4px;
}

.oal__loading,
.oal__empty,
.oal__error {
  padding: 14px;
  font-size: 12px;
  color: var(--rr-dim);
}

.oal__error {
  color: var(--rr-err, #f44);
}

.oal__filelistwrap {
  display: grid;
  grid-template-columns: 260px 1fr;
  gap: 0;
  flex: 1 1 auto;
  min-height: 0;
}

.oal__filelist {
  list-style: none;
  margin: 0;
  padding: 0;
  border-right: 1px solid var(--rr-border);
  overflow-y: auto;
}

.oal__fileitem {
  display: block;
  width: 100%;
  padding: 6px 12px;
  background: transparent;
  border: 0;
  border-left: 2px solid transparent;
  text-align: left;
  cursor: pointer;
  font-family: var(--rr-font-mono);
  font-size: 12px;
  color: var(--rr-ink);
}

.oal__fileitem code {
  font-family: var(--rr-font-mono);
}

.oal__fileitem:hover {
  background: var(--rr-bg3);
}

.oal__fileitem--active {
  background: var(--rr-bg3);
  border-left-color: var(--rr-active);
}

.oal__filedetail {
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
}

.oal__filehead {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 6px 12px;
  font-family: var(--rr-font-mono);
  font-size: 11.5px;
  color: var(--rr-heading);
  border-bottom: 1px solid var(--rr-border);
  flex-shrink: 0;
}

.oal__filemeta {
  font-size: 11.5px;
  color: var(--rr-dim);
  letter-spacing: 0.4px;
}

.oal__filepre {
  margin: 0;
  padding: 0;
  font-family: var(--rr-font-mono);
  font-size: 12.5px;
  color: var(--rr-ink2);
  white-space: pre;
  overflow: auto;
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
}

.oal__line {
  display: flex;
  align-items: baseline;
  padding: 0 8px 0 0;
  min-height: 1.5em;
  white-space: pre;
}

.oal__line--debuggable:hover {
  background: var(--rr-bg3);
}

/* Gutter slot reserved on every line so debuggable / non-debuggable
   lines stay vertically aligned. The button lives inside the slot
   on debuggable lines; the slot is empty otherwise. */
.oal__dbgslot,
.oal__dbgbtn {
  display: inline-flex;
  width: 18px;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
}

.oal__dbgbtn {
  border: 0;
  padding: 0;
  margin: 0;
  background: transparent;
  color: transparent;
  cursor: pointer;
  font-family: inherit;
  font-size: 11.5px;
  line-height: 1;
  user-select: none;
  transition: color 80ms;
}

.oal__line--debuggable .oal__dbgbtn {
  color: var(--rr-ok, #7fbf7a);
}

.oal__dbgbtn:hover,
.oal__dbgbtn:focus-visible {
  color: var(--rr-active);
  outline: none;
}

.oal__linenum {
  display: inline-block;
  width: 36px;
  text-align: right;
  margin-right: 10px;
  color: var(--rr-dim);
  user-select: none;
  flex-shrink: 0;
}

.oal__linetext {
  display: inline-block;
  white-space: pre;
}
</style>
