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
 * The rule file as a debugger's editor shows it during a run: each line the
 * run executed ends with what it produced, in gray; the line the current step
 * sits on is the execution line; the gutter marks where data left the rule,
 * where it aborted and where it failed. A variable the run gave a value to
 * is clickable in the code: it is highlighted, and its value on this line
 * opens under the line with what the line produced.
 */
import { computed, nextTick, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { TalRun } from '@skywalking-horizon-ui/api-client';
import { tokenizeLine } from '../dsl/syntaxHighlight.js';
import {
  displayValue,
  stepResult,
  type TalLineResult,
  type TalLineValues,
  type TalLineVar,
} from './talDebug.js';
import TalValueTree from './TalValueTree.vue';

const props = defineProps<{
  lines: readonly string[];
  title: string;
  /** The lines of the rule's DSL; others belong to other rules or the YAML. */
  range: { first: number; last: number } | null;
  /** The values of the steps up to the current one. */
  values: Map<number, TalLineValues>;
  /** The variables those steps gave values to, placed in their lines. */
  vars: Map<number, TalLineVar[]>;
  /** Every line the run has a step on, whatever the current step. */
  executed: ReadonlySet<number>;
  /** Dim the code lines of the rule the run has no step on: only a
   *  statement-granularity capture has a step for every statement. */
  dimUnexecuted: boolean;
  currentLine: number | null;
  run: TalRun | null;
  /** Number the first line this much past 1, when `lines` are the rule's
   *  DSL standing in for a file the view could not read. */
  numberOffset?: number;
  /** A line to bring into view, flash and open, as an output in the
   *  variables pane asks for the statement that sent it; `seq` repeats a
   *  request for the same line. */
  reveal?: { line: number; seq: number } | null;
  /** The name selected in either pane, whose uses this file highlights. */
  selectedName?: string | null;
  /** What each `if` of the run decided, by its line, for why a line did not run. */
  ifResults?: Map<number, boolean>;
  /** The line the run stopped at, when it aborted. */
  stopLine?: number | null;
  /** The last line a run that failed completed; the statement that threw is after it. */
  failedAfter?: number | null;
}>();

const emit = defineEmits<{
  step: [index: number];
  /** A variable was picked in the file, or let go. */
  'select-name': [name: string | null];
  /** The line whose values are open under it, or none. */
  'open-line': [line: number | null];
}>();

const { t } = useI18n();
const body = ref<HTMLElement | null>(null);
const openLine = ref<number | null>(null);
/** The variable clicked in the code, by its line and its place in it. */
const selected = ref<{ line: number; start: number } | null>(null);
const flashLine = ref<number | null>(null);
let flashTimer: ReturnType<typeof setTimeout> | undefined;

/** A line with nothing a run could execute: blank, a comment, or closing
 *  braces, an `else` or a bare block opener, whose steps sit elsewhere. */
const NOT_A_STATEMENT = /^(?:$|\/\/|#|[})\]]+$|}?\s*else(?!\s+if\b)|[A-Za-z]+\s*\{$)/;

/** A run of a line's code: one variable, or the code between two, as the
 *  token pieces it covers. */
interface Segment {
  /** Index into the line's variables, when the run is one. */
  variable: number | null;
  /** Whether the run is a use of the selected variable's name. */
  usage: boolean;
  parts: { text: string; kind: string }[];
}

interface PaneLine {
  num: number;
  segments: Segment[];
  vars: TalLineVar[];
  outside: boolean;
  unrun: boolean;
  /** Why the run did not reach this line. */
  why: string | null;
  /** Shown on the first line of a region the run skipped for one reason. */
  note: string | null;
  /** The code's leading spaces, under which a wrapped line continues. */
  indent: number;
  value: TalLineValues | null;
}

/** A wrapped line continues four columns in from where its code starts. */
function hangingIndent(indent: number): Record<string, string> {
  return { paddingLeft: `${indent + 4}ch`, textIndent: `-${indent + 4}ch` };
}

function indentOf(text: string): number {
  return text.length - text.trimStart().length;
}

const BLANK_OR_COMMENT = /^\s*(?:$|\/\/|#)/;

/** Where a name is used in a line: as a whole word, or a whole dotted path. */
function usagesOf(text: string, name: string | null): { start: number; end: number }[] {
  if (!name || text.trimStart().startsWith('//') || text.trimStart().startsWith('#')) return [];
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [...text.matchAll(new RegExp(`(?<![\\w.])${escaped}(?![\\w])`, 'g'))].map((m) => ({
    start: m.index!,
    end: m.index! + name.length,
  }));
}

/** The line's tokens, cut where a variable or a use of the selected name
 *  starts or ends, and grouped into runs, so `meta.kind` is one element. */
function segmentsOf(text: string, vars: readonly TalLineVar[], usageName: string | null): Segment[] {
  const usages = usagesOf(text, usageName);
  const marks = [...vars, ...usages];
  const out: Segment[] = [];
  let pos = 0;
  for (const token of tokenizeLine(text, 'tal')) {
    const start = pos;
    const end = pos + token.text.length;
    pos = end;
    let at = start;
    while (at < end) {
      const inside = vars.findIndex((v) => v.start <= at && at < v.end);
      const used = inside < 0 ? usages.find((u) => u.start <= at && at < u.end) : undefined;
      const nextStart = Math.min(end, ...marks.filter((m) => m.start > at).map((m) => m.start));
      const stop = inside >= 0 ? Math.min(vars[inside]!.end, end) : used ? Math.min(used.end, end) : nextStart;
      const variable = inside >= 0 ? inside : null;
      const usage = used !== undefined;
      const part = { text: token.text.slice(at - start, stop - start), kind: token.kind };
      const last = out[out.length - 1];
      if (last && last.variable === variable && last.usage === usage) last.parts.push(part);
      else out.push({ variable, usage, parts: [part] });
      at = stop;
    }
  }
  return out;
}

/**
 * Why the run skipped a line: it stopped before it, or the block holding the
 * line — found by indentation — opens with an `if` that was false, or is the
 * `else` of one that was true. A line in a skipped block takes its block's
 * reason.
 */
function whyNotRun(index: number, reasons: Map<number, string>): string | null {
  const off = props.numberOffset ?? 0;
  const num = index + 1 + off;
  if (props.stopLine !== null && props.stopLine !== undefined && num > props.stopLine) {
    return t('not run · the run stopped at line {n}', { n: props.stopLine });
  }
  if (props.failedAfter !== null && props.failedAfter !== undefined && num > props.failedAfter) {
    return t('no run recorded · the run failed after line {n}', { n: props.failedAfter });
  }
  const lines = props.lines;
  const indent = indentOf(lines[index]!);
  for (let j = index - 1; j >= 0; j--) {
    const text = lines[j]!;
    if (BLANK_OR_COMMENT.test(text) || indentOf(text) >= indent) continue;
    const opener = j + 1 + off;
    if (props.ifResults?.get(opener) === false) return t('not run · line {n} was false', { n: opener });
    if (/^}\s*else\b/.test(text.trim())) {
      // Up the chain to the branch that was taken: a branch after it was never evaluated.
      for (let k = j - 1; k >= 0; k--) {
        const above = lines[k]!;
        if (indentOf(above) !== indentOf(text) || !/^(?:}\s*else\s+)?if\b/.test(above.trim())) continue;
        const n = k + 1 + off;
        const result = props.ifResults?.get(n);
        if (result === true) return t('not run · line {n} was true', { n });
        if (result === false || /^if\b/.test(above.trim())) return null;
      }
    }
    return reasons.get(opener) ?? null;
  }
  return null;
}

const paneLines = computed<PaneLine[]>(() => {
  const reasons = new Map<number, string>();
  let lastWhy: string | null = null;
  return props.lines.map((text, i) => {
    const num = i + 1 + (props.numberOffset ?? 0);
    const outside = props.range !== null && (num < props.range.first || num > props.range.last);
    const statement = !NOT_A_STATEMENT.test(text.trim());
    const skipped = props.dimUnexecuted && !outside && !props.executed.has(num) && !BLANK_OR_COMMENT.test(text);
    const why = skipped ? whyNotRun(i, reasons) : null;
    if (why) reasons.set(num, why);
    const note = why && statement && why !== lastWhy ? why : null;
    if (statement && !BLANK_OR_COMMENT.test(text)) lastWhy = why;
    const unrun = skipped && statement;
    const vars = props.vars.get(num) ?? [];
    const segments = segmentsOf(text, vars, outside ? null : (props.selectedName ?? null));
    return { num, segments, vars, outside, unrun, why, note, indent: indentOf(text), value: props.values.get(num) ?? null };
  });
});

const selectedVar = computed<TalLineVar | null>(() => {
  const s = selected.value;
  return s === null ? null : (props.vars.get(s.line) ?? []).find((v) => v.start === s.start) ?? null;
});

/** What opens under a line: the clicked variable and the result of the
 *  statement that gave it its value, or every variable of the line and
 *  what the line's statements produced. */
const panel = computed<{ vars: TalLineVar[]; results: TalLineResult[] } | null>(() => {
  const run = props.run;
  if (!run || openLine.value === null) return null;
  const chosen = selectedVar.value;
  const steps = [...new Set(chosen ? [chosen.step] : (props.values.get(openLine.value)?.steps ?? []))];
  const results = steps
    .map((i) => stepResult(run.steps[i]!, run.outputs))
    .filter((r): r is TalLineResult => r !== null);
  const vars = chosen ? [chosen] : (props.vars.get(openLine.value) ?? []);
  return vars.length === 0 && results.length === 0 ? null : { vars, results };
});

function varClass(line: PaneLine, index: number): string {
  const v = line.vars[index]!;
  const chosen = selectedVar.value;
  if (chosen && chosen.line === v.line && chosen.start === v.start) return 'tsp__var tsp__var--selected';
  return props.selectedName === v.name ? 'tsp__var tsp__var--same' : 'tsp__var';
}

/** A variable takes the click; any other code passes it to its line. */
function clickSegment(event: MouseEvent, line: PaneLine, seg: Segment): void {
  if (seg.variable === null) return;
  event.stopPropagation();
  selectVar(line, seg.variable);
}

function selectVar(line: PaneLine, index: number): void {
  const v = line.vars[index]!;
  const again = selected.value?.line === v.line && selected.value.start === v.start;
  selected.value = again ? null : { line: v.line, start: v.start };
  openLine.value = again ? null : v.line;
  emit('select-name', again ? null : v.name);
}


function toggleValue(line: number): void {
  openLine.value = openLine.value === line && selected.value === null ? null : line;
  selected.value = null;
}

function jumpTo(line: PaneLine): void {
  if (!line.value) return;
  emit('step', line.value.steps[line.value.steps.length - 1]!);
}

/** Centre the line in the pane, scrolling the pane only, not the page. */
function scrollTo(line: number | null): void {
  if (line === null) return;
  void nextTick(() => {
    const pane = body.value;
    const el = pane?.querySelector<HTMLElement>(`[data-line="${line}"]`);
    if (!pane || !el) return;
    pane.scrollTop = el.offsetTop - pane.clientHeight / 2;
  });
}

watch(() => props.currentLine, scrollTo, { immediate: true });
watch(openLine, (line) => emit('open-line', line));
/** A name picked in the variables pane is tinted where the file uses it; the
 *  file lets go of a variable it picked under another name, and stays where
 *  it is — moving it is the go-to-line buttons' job. */
watch(
  () => props.selectedName,
  (name) => {
    const own = selectedVar.value;
    if (own && own.name !== name) {
      selected.value = null;
      openLine.value = null;
    }
  },
);
watch(
  () => props.reveal,
  (r) => {
    if (!r) return;
    selected.value = null;
    openLine.value = r.line;
      scrollTo(r.line);
    flashLine.value = r.line;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => (flashLine.value = null), 1500);
  },
);
// The file's text can arrive after the frame: the DSL stands in until then.
watch(
  () => props.lines,
  () => scrollTo(props.currentLine ?? props.range?.first ?? null),
);
watch(
  () => props.range?.first ?? null,
  (first) => {
    if (props.currentLine === null) scrollTo(first);
  },
);
// Another span's run, of the same rule or not: what was open under a line was this run's.
watch(
  () => props.run,
  () => {
    openLine.value = null;
    selected.value = null;
  },
);
</script>

<template>
  <div class="tsp">
    <header class="tsp__head">
      <span class="tsp__zone">{{ t('Rule file') }}</span>
      <code class="tsp__file">{{ title }}</code>
      <span class="tsp__legend">
        <span class="tsp__mk tsp__mk--output">●</span>{{ t('output') }}
        <span class="tsp__mk tsp__mk--abort">⊘</span>{{ t('abort') }}
      </span>
    </header>
    <slot name="toolbar" />
    <p class="tsp__hint">
      <template v-if="dimUnexecuted">
        {{ t('Click an underlined variable to see its value on that line, or a value box at the end of a line to see everything the line produced.') }}
      </template>
      <template v-else>
        {{ t('A block capture records only the blocks and what the run sent out, not each statement, its variables or an if. Start a statement capture to see them.') }}
      </template>
    </p>
    <div ref="body" class="tsp__body">
      <template v-for="line in paneLines" :key="line.num">
        <div
          class="tsp__line"
          :data-line="line.num"
          :class="{
            'tsp__line--outside': line.outside,
            'tsp__line--unrun': line.unrun,
            'tsp__line--current': line.num === currentLine,
            'tsp__line--flash': line.num === flashLine,
            'tsp__line--ran': line.value !== null || line.vars.length > 0,
          }"
          :title="line.why ?? undefined"
          @click="(line.value !== null || line.vars.length > 0) && toggleValue(line.num)"
          @dblclick="jumpTo(line)"
        >
          <span class="tsp__gutter">
            <span v-if="line.num === currentLine" class="tsp__mk tsp__mk--current">➤</span>
            <span
              v-else-if="line.value?.marker"
              class="tsp__mk"
              :class="`tsp__mk--${line.value.marker}`"
            >{{ line.value.marker === 'output' ? '●' : line.value.marker === 'abort' ? '⊘' : '✕' }}</span>
          </span>
          <span class="tsp__num">{{ line.num }}</span>
          <span class="tsp__code" :style="hangingIndent(line.indent)"><span
            v-for="(seg, si) in line.segments"
            :key="si"
            :class="seg.variable !== null ? varClass(line, seg.variable) : seg.usage ? 'tsp__var--same' : ''"
            @click="clickSegment($event, line, seg)"
          ><span
            v-for="(part, pi) in seg.parts"
            :key="pi"
            :class="`hl hl--${part.kind}`"
          >{{ part.text }}</span></span></span>
          <span v-if="line.note" class="tsp__why">{{ line.note }}</span>
          <button
            v-if="line.value && line.value.text"
            type="button"
            class="tsp__inline"
            :title="line.value.text"
            @click.stop="toggleValue(line.num)"
          >{{ line.value.text }}</button>
        </div>
        <div
          v-if="openLine === line.num && panel"
          class="tsp__expand"
        >
          <div
            v-for="v in panel.vars"
            :key="`v${v.start}`"
            class="tsp__pv"
            :class="{ 'tsp__pv--selected': selectedVar === v }"
          >
            <TalValueTree :name="v.name" :value="displayValue(v.value)" :open-depth="2" />
          </div>
          <div v-for="(r, i) in panel.results" :key="`r${i}`" class="tsp__pr">
            <TalValueTree v-if="r.value !== undefined" :name="r.label" :value="r.value" :open-depth="2" />
            <span v-else class="tsp__prlabel">{{ r.label }}</span>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.tsp {
  display: flex;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
  background: var(--rr-bg2);
  border: 1px solid var(--rr-border);
}

.tsp__head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 10px;
  background: var(--rr-bg3);
  border-bottom: 1px solid var(--rr-border2);
  font-family: var(--rr-font-ui);
  font-size: var(--sw-fs-sm);
}

.tsp__zone {
  font-size: var(--sw-fs-base);
  font-weight: var(--sw-fw-bold);
  color: var(--rr-heading);
}

.tsp__file {
  font-family: var(--rr-font-mono);
  color: var(--rr-ink2);
}

.tsp__legend {
  margin-left: auto;
  display: inline-flex;
  gap: 4px;
  align-items: baseline;
  color: var(--rr-dim);
}

.tsp__legend .tsp__mk {
  margin-left: 8px;
}

.tsp__body {
  position: relative;
  overflow: auto;
  flex: 1 1 auto;
  min-height: 0;
  font-family: var(--rr-font-mono);
  font-size: var(--sw-fs-base);
  padding: 4px 0;
}

.tsp__hint {
  margin: 0;
  padding: 4px 10px;
  border-bottom: 1px solid var(--rr-border);
  font-size: var(--sw-fs-sm);
  color: var(--rr-dim);
}

/* The rule's code comes first: a long line wraps inside the pane, as an
   editor's soft wrap does, and what the run left on it follows the code,
   never covering it. */
.tsp__line {
  display: flex;
  align-items: baseline;
  min-height: 1.5em;
  box-sizing: border-box;
  padding-right: 12px;
}

.tsp__why {
  flex: 0 0 auto;
  max-width: 40%;
  margin-left: 18px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--sw-fs-sm);
  font-style: italic;
  color: var(--rr-warn);
}

.tsp__line--outside {
  opacity: 0.35;
}

.tsp__line--unrun {
  opacity: 0.5;
}

.tsp__line--current {
  background: var(--sw-accent-soft);
  box-shadow: inset 2px 0 0 var(--rr-active);
}

.tsp__line--flash {
  background: var(--rr-bg3);
  box-shadow: inset 2px 0 0 var(--rr-accent);
}

.tsp__line--ran {
  cursor: pointer;
}

.tsp__line--ran:hover {
  background: var(--rr-bg3);
}

/* A line with captured values is selectable: its number stands out. */
.tsp__line--ran .tsp__num {
  color: var(--rr-heading);
  font-weight: var(--sw-fw-semibold);
}

.tsp__gutter {
  display: inline-flex;
  justify-content: center;
  width: 18px;
  flex-shrink: 0;
}

.tsp__num {
  width: 40px;
  padding-right: 10px;
  text-align: right;
  color: var(--rr-dim);
  flex-shrink: 0;
  user-select: none;
}

.tsp__code {
  flex: 0 1 auto;
  min-width: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  color: var(--rr-ink2);
}

.hl--comment {
  color: var(--rr-dim);
  font-style: italic;
}

.hl--string {
  color: var(--rr-ok);
}

.hl--keyword {
  color: var(--rr-accent);
  font-weight: var(--sw-fw-semibold);
}

.hl--fn,
.hl--number {
  color: var(--rr-info);
}

.hl--type {
  color: var(--sw-purple);
}

.tsp__mk--output {
  color: var(--rr-accent);
}

.tsp__mk--abort {
  color: var(--rr-warn);
}

.tsp__mk--failure {
  color: var(--rr-err);
}

.tsp__mk--current {
  color: var(--rr-active);
}

.tsp__inline {
  flex: 0 0 auto;
  max-width: 40%;
  overflow: hidden;
  text-overflow: ellipsis;
  margin-left: 18px;
  background: var(--rr-bg3);
  border: 1px solid var(--rr-border);
  border-radius: var(--rr-radius-sm);
  padding: 0 6px;
  font: inherit;
  font-style: italic;
  color: var(--rr-ink2);
  cursor: pointer;
  white-space: pre;
}

.tsp__inline:hover {
  color: var(--rr-ink);
  border-color: var(--rr-accent);
}

.tsp__var {
  cursor: pointer;
  text-decoration: underline dotted var(--rr-accent);
  text-underline-offset: 3px;
}

.tsp__var:hover {
  background: var(--rr-bg3);
}

.tsp__var--same {
  background: var(--sw-info-soft);
}

.tsp__var--selected {
  background: var(--sw-accent-soft);
  outline: 1px solid var(--rr-accent);
}

.tsp__pv,
.tsp__pr {
  padding: 1px 4px;
}

.tsp__pv--selected {
  background: var(--sw-accent-soft);
}

.tsp__pr {
  border-top: 1px dashed var(--rr-border);
  margin-top: 2px;
}

.tsp__prlabel {
  font-family: var(--rr-font-mono);
  font-size: var(--sw-fs-sm);
  color: var(--rr-heading);
}

.tsp__expand {
  box-sizing: border-box;
  margin: 2px 12px 6px 68px;
  padding: 8px 10px;
  background: var(--rr-bg);
  border: 1px solid var(--rr-border2);
  border-radius: var(--rr-radius-sm);
  white-space: normal;
}

</style>
