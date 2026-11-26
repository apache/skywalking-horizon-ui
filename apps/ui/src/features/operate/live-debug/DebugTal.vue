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
 * TAL live-debugger view, laid out as an IDE debugger: the frames of the
 * capture on the left, the rule file in the middle with each executed line's
 * value at its end, and the selected frame's variables on the right under the
 * stepping controls.
 *
 * A native rule captures one segment per record, every span with the rule's
 * run on it, so its frames nest under their segment; an OTLP rule captures
 * one span per record.
 */
import { computed, reactive, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute } from 'vue-router';
import { useQuery } from '@tanstack/vue-query';
import type { Granularity, TalInputType, TalRun } from '@skywalking-horizon-ui/api-client';
import { BffApiError, bff } from '@/api/client';
import OapVersionBanner from '@/shell/OapVersionBanner.vue';
import Btn from '@/components/primitives/Btn.vue';
import DebugView from './DebugView.vue';
import TalFramesList from './TalFramesList.vue';
import TalSourcePane from './TalSourcePane.vue';
import TalVariablesPane from './TalVariablesPane.vue';
import { useDebugSession } from './useDebugSession';
import { useDebugHistory } from './useDebugHistory';
import { routeIsTab, useDebugReplay } from './useDebugReplay.js';
import {
  dslAt,
  dslOffsetIn,
  lineOf,
  lineValues,
  lineVariables,
  stepLines,
  localsOf,
  outputLinks,
  ruleRange,
  talCaptureCounts,
  talRecordViews,
  type TalFrame,
  type TalOutputLink,
} from './talDebug.js';
import { DEFAULT_RETENTION_MINUTES, MS_PER_MINUTE, RECORD_CAP_MAX } from './constants.js';

const { t } = useI18n({ useScope: 'global' });
const route = useRoute();
const dbg = useDebugSession('tal');
const history = useDebugHistory('tal');

const selectedFile = ref('');
const selectedRule = ref('');
/** Block, OAP's default, records the blocks a run entered and what it sent
 *  out; statement adds every statement, its variables and every `if`. */
const granularity = ref<Granularity>('block');
const recordCap = ref<number>(RECORD_CAP_MAX);
const retentionMinutes = ref<number>(DEFAULT_RETENTION_MINUTES);

/** Deep-link from the TAL rule page: `?file=<name>&ruleName=<rule>`. */
watch(
  () => [route.params.tab, route.query.file, route.query.ruleName] as const,
  ([, f, r]) => {
    if (!routeIsTab(route, 'tal')) return;
    if (typeof f === 'string' && f.length > 0) selectedFile.value = f;
    if (typeof r === 'string' && r.length > 0) selectedRule.value = r;
  },
  { immediate: true },
);

/** The listing needs `rule:read`; without it the picker takes typed names. */
const filesQuery = useQuery({
  queryKey: ['debug-tal/files'],
  queryFn: async () => bff.dsl.talFiles(),
  retry: false,
});
const files = computed(() => filesQuery.data.value?.files ?? []);
/** OAP answers 404 for the TAL rule listing before 11.2, which added TAL debugging. */
const talNotServed = computed(
  () => filesQuery.error.value instanceof BffApiError && filesQuery.error.value.status === 404,
);
const rulesOfFile = computed(() => files.value.find((f) => f.name === selectedFile.value)?.rules ?? []);

/** A file picked from the list keeps its rule when the file has it, else
 *  takes its first rule that can be debugged. */
watch(rulesOfFile, (rules) => {
  if (rules.length === 0 || rules.some((r) => r.name === selectedRule.value)) return;
  selectedRule.value = rules.find((r) => r.debuggable)?.name ?? '';
});

const startEnabled = computed(() => {
  const s = dbg.state.value;
  return (
    selectedFile.value !== '' &&
    selectedRule.value !== '' &&
    (s === 'idle' || s === 'captured' || s === 'stopped' || s === 'error')
  );
});
const stopEnabled = computed(
  () => dbg.state.value === 'capturing' || dbg.state.value === 'starting',
);

async function startSampling(): Promise<void> {
  if (!selectedFile.value || !selectedRule.value) return;
  // A start leaves a saved capture on screen, as back to live does: the new capture is the one shown and saved.
  clearHistorical();
  const args = {
    catalog: 'tal' as const,
    name: selectedFile.value,
    ruleName: selectedRule.value,
    granularity: granularity.value,
    recordCap: recordCap.value,
    retentionMillis: retentionMinutes.value * MS_PER_MINUTE,
  };
  await dbg.start(args);
}

const { historicalEntry, displaySession, clearHistorical, shownMeta } = useDebugReplay({
  dbg,
  history,
  name: selectedFile,
  ruleName: selectedRule,
  recordCap,
  retentionMinutes,
  granularity,
  widget: 'tal',
});
/** The granularity and cap of the capture on screen, which the picker, the next run's form, may since have left. */
const capturedWith = computed<Granularity>(() => shownMeta.value?.granularity ?? granularity.value);
const capturedCap = computed<number>(() => shownMeta.value?.recordCap ?? recordCap.value);

// ── Frames and selection ───────────────────────────────────────────

const recordViews = computed(() => talRecordViews(displaySession.value));
const counts = computed(() => talCaptureCounts(displaySession.value));
const frames = computed<TalFrame[]>(() => recordViews.value.flatMap((v) => v.frames));
const multiNode = computed(() => (displaySession.value?.nodes.length ?? 0) > 1);

/** The input of the capture on screen: its records say; before any, the file it runs, not the one picked next. */
const inputType = computed<TalInputType | null>(() => {
  const seen = recordViews.value[0]?.record.rule.inputType;
  if (seen === 'sw-native' || seen === 'otlp') return seen;
  const file = shownMeta.value?.name ?? selectedFile.value;
  return files.value.find((f) => f.name === file)?.inputType ?? null;
});

const selectedKey = ref<string | null>(null);
const stepIndex = ref(0);
const selectedFrame = computed(() => frames.value.find((f) => f.key === selectedKey.value) ?? null);
const run = computed<TalRun | null>(() => selectedFrame.value?.run ?? null);

/** Until the operator picks a frame, the first run that sent data out is
 *  selected, else the first run at all; a new capture starts over. */
watch(
  () => [displaySession.value?.sessionId, frames.value.length] as const,
  ([sessionId], previous) => {
    if (previous && previous[0] !== sessionId) selectedKey.value = null;
    if (selectedKey.value === null || !selectedFrame.value) {
      const ran = frames.value.filter((f) => f.run !== null);
      selectedKey.value = (ran.find((f) => f.run!.continueOn && f.run!.outputs.length > 0) ?? ran[0])?.key ?? null;
    }
  },
  { immediate: true },
);

/** The frame on screen. A frame's key names its node, record and span, which
 *  another capture can repeat, so the capture is part of it: what is set per
 *  frame below starts over whenever this changes. */
const frameOnScreen = computed(() => `${displaySession.value?.sessionId ?? ''}|${selectedKey.value ?? ''}`);

/** A frame opens at its last step, so the whole run shows; stepping back
 *  replays it from the start. Immediate: a saved capture's frame is selected
 *  before this watcher exists. */
watch(
  frameOnScreen,
  () => {
    stepIndex.value = Math.max(0, (run.value?.steps.length ?? 1) - 1);
  },
  { immediate: true },
);

// ── Source pane ────────────────────────────────────────────────────

/** The file of the selected frame's record, as the node named it. */
const sourceFile = computed(() => selectedFrame.value?.record.rule.file ?? selectedFile.value);
const fileQuery = useQuery({
  queryKey: computed(() => ['debug-tal/file', sourceFile.value]),
  queryFn: async () => bff.dsl.talFileContent(sourceFile.value),
  enabled: computed(() => sourceFile.value !== ''),
  retry: false,
  staleTime: Infinity,
});
// OAP may have restarted with the file changed since it was read: another capture reads it again.
watch(
  () => displaySession.value?.sessionId,
  (now, before) => {
    if (before !== undefined && now !== before && sourceFile.value !== '') void fileQuery.refetch();
  },
);
const fetchedLines = computed<string[] | null>(() => {
  const text = fileQuery.data.value;
  return typeof text === 'string' ? text.replace(/\n$/, '').split('\n') : null;
});
const dsl = computed(() => selectedFrame.value?.record.dsl ?? '');
const dslLines = computed(() => dsl.value.replace(/\n$/, '').split('\n'));
/** Where the rule's DSL started in the file when it was captured, as OAP numbered the steps' file lines from it; null
 *  when the node could not read the file, and the steps then count their lines within the DSL. */
const capturedOffset = computed<number | null>(() => {
  const first = Number(selectedFrame.value?.record.rule.dslFirstLine);
  return Number.isInteger(first) && first > 0 ? first - 1 : null;
});
/** Where the captured DSL sits in the file OAP serves now: where the capture's lines put it, when the file still holds
 *  it there; null when not, as for a saved capture of a rule edited or moved since. Lines counted within the DSL map
 *  onto wherever the file holds it. */
const fileOffset = computed<number | null>(() => {
  const file = fetchedLines.value;
  if (!file) return null;
  const captured = capturedOffset.value;
  if (captured !== null) return dslAt(file, dsl.value, captured) ? captured : null;
  return dslOffsetIn(file, dsl.value, Number(selectedFrame.value?.record.rule.sourceLine) || 0);
});
/** The file, when it holds the DSL the capture ran where the capture ran it; else the pane shows the captured DSL. */
const fileLines = computed<string[] | null>(() => (fileOffset.value !== null ? fetchedLines.value : null));

/** Where the rule's DSL starts in the file the steps' lines count in. */
const dslOffset = computed<number | null>(() => (fileLines.value ? fileOffset.value : capturedOffset.value));

const paneLines = computed(() => fileLines.value ?? dslLines.value);
const paneTitle = computed(() => {
  const rule = selectedFrame.value?.record.rule.ruleName ?? selectedRule.value;
  if (fileLines.value) return `${sourceFile.value} · ${rule}`;
  return fetchedLines.value
    ? t('{rule} · the rule’s DSL as captured (the file has changed since)', { rule })
    : t('{rule} · the rule’s DSL (the file is not readable here)', { rule });
});
const range = computed(() => (fileLines.value ? ruleRange(dsl.value, dslOffset.value) : null));
const values = computed(() => {
  const r = run.value;
  if (!r) return new Map();
  return lineValues({ ...r, steps: r.steps.slice(0, stepIndex.value + 1) }, dslOffset.value);
});
/** The variables the run gave values to up to the current step, placed in
 *  the pane's lines, which are the file's or, without it, the rule's DSL. */
const vars = computed(() =>
  lineVariables(
    run.value,
    stepIndex.value,
    dslOffset.value,
    (line) => paneLines.value[line - 1 - (fileLines.value ? 0 : (dslOffset.value ?? 0))],
  ),
);
/** The lines the run executed: each step's statement, wrapped lines and a `metrics {}` or `source {}` body included. */
const executed = computed<Set<number>>(() => {
  const out = new Set<number>();
  const steps = run.value?.steps ?? [];
  const textOf = (line: number): string | undefined =>
    paneLines.value[line - 1 - (fileLines.value ? 0 : (dslOffset.value ?? 0))];
  steps.forEach((step) => {
    const line = lineOf(step, dslOffset.value);
    if (line !== null) for (const n of stepLines(step, line, textOf)) out.add(n);
  });
  return out;
});
const currentLine = computed(() => {
  const step = run.value?.steps[stepIndex.value];
  return step ? lineOf(step, dslOffset.value) : null;
});

const links = computed(() => outputLinks(run.value, dslOffset.value));

/** What each `if` of the whole run decided, by its line, the latest when a
 *  line ran more than once. */
const ifResults = computed(() => {
  const out = new Map<number, boolean>();
  for (const s of run.value?.steps ?? []) {
    const line = lineOf(s, dslOffset.value);
    if (s.kind === 'if' && line !== null) out.set(line, s.result === true);
  }
  return out;
});

/** The last line a run that stopped short completed: its last step with a line. */
const lastRunLine = computed<number | null>(() => {
  const r = run.value;
  if (!r || r.continueOn) return null;
  for (let i = r.steps.length - 1; i >= 0; i--) {
    const line = lineOf(r.steps[i]!, dslOffset.value);
    if (line !== null) return line;
  }
  return null;
});
/** Whether the run ended in a failure, whose step names no line: the statement that threw is past the last step,
 *  as a statement's probe fires only once it is done. */
const failed = computed(() => run.value?.steps[run.value.steps.length - 1]?.kind === 'failure');
/** The line an aborted run stopped at: the `abort` statement's own step. */
const stopLine = computed<number | null>(() => (failed.value ? null : lastRunLine.value));
/** The last line a failed run completed, as context only: the statement that threw is after it. */
const failedAfter = computed<number | null>(() => (failed.value ? lastRunLine.value : null));

/** The one selection the rule file and the variables pane share: a name
 *  the rule reads or sets, picked in either, and the file's open line. */
const selectedName = ref<string | null>(null);
const openRowLine = ref<number | null>(null);
watch(frameOnScreen, () => {
  selectedName.value = null;
  openRowLine.value = null;
});
const locals = computed(() => localsOf(vars.value));
const reveal = ref<{ line: number; seq: number } | null>(null);

function revealLine(line: number): void {
  reveal.value = { line, seq: (reveal.value?.seq ?? 0) + 1 };
}

/** An output goes to the statement that sent it: the run steps there when a
 *  step names it, and its row opens in the rule file. */
function goToOutput(link: TalOutputLink): void {
  if (link.step !== null) step(link.step);
  if (link.line !== null) revealLine(link.line);
}

const currentStep = computed(() => run.value?.steps[stepIndex.value] ?? null);
const lastStep = computed(() => (run.value?.steps.length ?? 0) - 1);

// ── Layout: the frames and the variables can be resized and hidden ────

const LAYOUT_KEY = 'vs:tal-debug-layout:v1';
const layout = reactive({ left: 300, right: 380, leftOpen: true, rightOpen: true });
try {
  const saved = JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? 'null') as Partial<typeof layout> | null;
  if (saved) Object.assign(layout, saved);
} catch {
  // the defaults stand
}

function saveLayout(): void {
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
  } catch {
    // a layout that does not persist still works
  }
}

const columns = computed(() =>
  [
    layout.leftOpen ? `${layout.left}px 6px` : '28px 6px',
    'minmax(0, 1fr)',
    layout.rightOpen ? `6px ${layout.right}px` : '6px 28px',
  ].join(' '),
);

/** Drag a pane's inner edge: the frames widen to the right, the variables
 *  to the left. */
function resize(side: 'left' | 'right', start: PointerEvent): void {
  const from = start.clientX;
  const width = layout[side];
  const move = (e: PointerEvent): void => {
    const dx = e.clientX - from;
    layout[side] = Math.min(720, Math.max(180, side === 'left' ? width + dx : width - dx));
  };
  const end = (): void => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', end);
    document.body.style.userSelect = '';
    saveLayout();
  };
  document.body.style.userSelect = 'none';
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', end);
}

function togglePane(side: 'leftOpen' | 'rightOpen'): void {
  layout[side] = !layout[side];
  saveLayout();
}

function step(index: number): void {
  const total = run.value?.steps.length ?? 0;
  stepIndex.value = Math.min(Math.max(index, 0), Math.max(total - 1, 0));
}

function formatTime(ms: number): string {
  const d = new Date(ms);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
}

/** The capture as OAP sent it, every record of every node, with what it was
 *  captured with, saved as a JSON file. */
function exportCapture(): void {
  const session = displaySession.value;
  if (!session) return;
  const body = {
    exportedAt: new Date().toISOString(),
    ruleKey: session.ruleKey ?? {
      catalog: 'tal',
      name: shownMeta.value?.name ?? selectedFile.value,
      ruleName: shownMeta.value?.ruleName ?? selectedRule.value,
    },
    granularity: capturedWith.value,
    recordCap: capturedCap.value,
    session,
  };
  const url = URL.createObjectURL(new Blob([JSON.stringify(body, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `tal-debug-${session.sessionId}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

const outputCounts = computed(() =>
  Object.entries(counts.value.outputs).sort((a, b) => b[1] - a[1]),
);
</script>

<template>
  <DebugView :dbg="dbg" :node-views="displaySession?.nodes ?? []" :view-session="historicalEntry?.session ?? null">
    <template #controls>
      <!-- The rule list needs rule:read; without it the names are typed in. -->
      <template v-if="filesQuery.isError.value && !talNotServed">
        <div class="ctl">
          <label class="ctl__lbl">{{ t('rule file') }}</label>
          <input v-model="selectedFile" class="ctl__input ctl__input--file" :placeholder="t('e.g. native-rpc')" />
        </div>
        <div class="ctl ctl--grow">
          <label class="ctl__lbl">{{ t('rule') }}</label>
          <input v-model="selectedRule" class="ctl__input ctl__input--flex" :placeholder="t('e.g. native-rpc-entry')" />
        </div>
      </template>
      <template v-else>
        <div class="ctl">
          <label class="ctl__lbl">{{ t('rule file') }}</label>
          <select v-model="selectedFile" class="ctl__select" :disabled="filesQuery.isPending.value">
            <option value="" disabled>{{ filesQuery.isPending.value ? t('loading…') : t('select a TAL rule file…') }}</option>
            <option v-for="f in files" :key="f.name" :value="f.name">{{ f.name }}</option>
          </select>
        </div>
        <div class="ctl ctl--grow">
          <label class="ctl__lbl">{{ t('rule') }}</label>
          <select v-model="selectedRule" class="ctl__select" :disabled="selectedFile === ''">
            <option value="" disabled>{{ selectedFile === '' ? t('pick a file first…') : t('select a rule…') }}</option>
            <option
              v-for="r in rulesOfFile"
              :key="`${r.layer}/${r.name}`"
              :value="r.name"
              :disabled="!r.debuggable"
            >{{ r.debuggable ? r.name : `${r.name} · ${r.layer}` }}</option>
          </select>
        </div>
      </template>
      <div class="ctl">
        <label class="ctl__lbl">{{ t('granularity') }}</label>
        <div class="tal__granularity">
          <button
            type="button"
            class="tal__granbtn"
            :class="{ 'tal__granbtn--active': granularity === 'block' }"
            :aria-pressed="granularity === 'block'"
            @click="granularity = 'block'"
          >{{ t('block') }}</button>
          <button
            type="button"
            class="tal__granbtn"
            :class="{ 'tal__granbtn--active': granularity === 'statement' }"
            :aria-pressed="granularity === 'statement'"
            @click="granularity = 'statement'"
          >{{ t('statement') }}</button>
        </div>
      </div>
      <div class="ctl">
        <label class="ctl__lbl">recordCap</label>
        <input v-model.number="recordCap" type="number" min="1" :max="RECORD_CAP_MAX" class="ctl__input" />
      </div>
      <div class="ctl">
        <label class="ctl__lbl">{{ t('retention (min)') }}</label>
        <input v-model.number="retentionMinutes" type="number" min="1" max="60" class="ctl__input" />
      </div>
      <Btn kind="primary" :disabled="!startEnabled" @click="startSampling">{{ t('start sampling') }}</Btn>
      <Btn kind="ghost" :disabled="!stopEnabled" @click="dbg.stop()">{{ t('stop') }}</Btn>
      <router-link
        class="ctl__editlink"
        to="/operate/live-debug/history"
        :title="t('browse past captures saved locally')"
      >{{ t('history ({n}) →', { n: history.entries.value.length }) }}</router-link>
      <router-link
        class="ctl__editlink"
        to="/operate/tal"
        :title="t('browse the TAL rules (read-only)')"
      >{{ t('open in TAL rules →') }}</router-link>
    </template>

    <template #banner>
      <OapVersionBanner
        v-if="talNotServed && !historicalEntry"
        :feature-label="t('TAL debugging')"
        min-version="11.2"
        :detail="t('OAP answers 404 for its TAL rule listing, /runtime/tal/files.')"
      />
      <div v-if="historicalEntry" class="tal__histbanner">
        <span>⟲</span>
        <i18n-t keypath="Viewing saved capture from {time} · {catalog} · {name} · {rule}" tag="span" scope="global">
          <template #time><strong>{{ formatTime(historicalEntry.savedAt) }}</strong></template>
          <template #catalog>{{ historicalEntry.catalog }}</template>
          <template #name>{{ historicalEntry.name }}</template>
          <template #rule>{{ historicalEntry.ruleName }}</template>
        </i18n-t>
        <button type="button" class="tal__histback" @click="clearHistorical">{{ t('back to live') }}</button>
      </div>
    </template>

    <template #idle-hint>
      {{ t('Pick a TAL file and one of its rules, and hit start. A native rule captures each segment with every span and the rule’s run on it; an OTLP rule captures each span. Select a frame to see the rule file with the values its run produced at the end of each line.') }}
    </template>

    <template #capture>
      <div class="tal__sum">
        <span
          class="tal__mode"
          :class="`tal__mode--${capturedWith}`"
          :title="capturedWith === 'block'
            ? t('Records the blocks each run entered and what it sent out.')
            : t('Records every statement each run executed, its variables, and every if with its operands.')"
        >{{ capturedWith === 'block' ? t('block capture') : t('statement capture') }}</span>
        <span class="tal__badge" :class="`tal__badge--${inputType ?? 'none'}`">
          {{ inputType === 'sw-native' ? t('native · segment → spans') : inputType === 'otlp' ? t('OTLP · span by span') : 'TAL' }}
        </span>
        <span class="tal__stat"><strong>{{ counts.records }}</strong> {{ t('records') }}</span>
        <span v-if="counts.segments > 0" class="tal__stat">
          {{ t('{segments} segments · {spans} spans, {ran} run', { segments: counts.segments, spans: counts.segmentSpans, ran: counts.segmentSpansRun }) }}
        </span>
        <span v-if="counts.otlpSpans > 0" class="tal__stat">{{ t('{n} OTLP spans', { n: counts.otlpSpans }) }}</span>
        <span v-if="counts.stopped > 0" class="tal__stat tal__stat--warn">{{ t('{n} stopped', { n: counts.stopped }) }}</span>
        <span v-if="counts.failures > 0" class="tal__stat tal__stat--err">{{ t('{n} failed', { n: counts.failures }) }}</span>
        <span v-if="counts.oversized > 0" class="tal__stat tal__stat--warn">{{ t('{n} oversized', { n: counts.oversized }) }}</span>
        <span v-for="[kind, n] in outputCounts" :key="kind" class="tal__chip">{{ kind }} {{ n }}</span>
        <button
          type="button"
          class="tal__export"
          :disabled="!displaySession"
          :title="t('Download the whole capture as OAP sent it, as JSON, to read it outside the page or attach it to a report.')"
          @click="exportCapture"
        >⤓ {{ t('export capture') }}</button>
        <span class="tal__nodes">
          <span v-for="node in counts.nodes" :key="node.nodeKey" class="tal__chip" :class="{ 'tal__chip--done': node.captured }">
            {{ node.nodeLabel }} {{ node.records }}/{{ capturedCap }}<template v-if="node.captured"> · {{ t('captured') }}</template>
          </span>
        </span>
      </div>

      <div class="tal__ide" :style="{ gridTemplateColumns: columns }">
        <section v-if="layout.leftOpen" class="tal__pane">
          <header class="tal__paneh">
            <span class="tal__zone">{{ t('Captured spans') }}</span>
            <span class="tal__zonecount">{{ frames.length }}</span>
            <button type="button" class="tal__fold" :aria-label="t('hide the captured spans')" :title="t('hide the captured spans')" @click="togglePane('leftOpen')">◧</button>
          </header>
          <TalFramesList
            :key="displaySession?.sessionId ?? ''"
            :records="recordViews"
            :selected-key="selectedKey"
            :multi-node="multiNode"
            @select="selectedKey = $event"
          />
        </section>
        <button v-else type="button" class="tal__rail" :title="t('show the captured spans')" @click="togglePane('leftOpen')">
          <span class="tal__railicon">◧</span>
          <span class="tal__railtext">{{ t('Captured spans') }}</span>
        </button>
        <div
          class="tal__split"
          :class="{ 'tal__split--off': !layout.leftOpen }"
          :title="t('drag to resize')"
          @pointerdown="layout.leftOpen && resize('left', $event)"
        />
        <TalSourcePane
          v-if="selectedFrame"
          class="tal__source"
          :lines="paneLines"
          :title="paneTitle"
          :range="range"
          :values="values"
          :vars="vars"
          :executed="executed"
          :dim-unexecuted="capturedWith === 'statement'"
          :current-line="currentLine"
          :run="run"
          :number-offset="fileLines ? 0 : dslOffset ?? 0"
          :reveal="reveal"
          :selected-name="selectedName"
          :if-results="ifResults"
          :stop-line="stopLine"
          :failed-after="failedAfter"
          @step="step"
          @select-name="selectedName = $event"
          @open-line="openRowLine = $event"
        >
          <template #toolbar>
            <div class="tal__steps">
              <button type="button" class="tal__stepbtn" :disabled="stepIndex <= 0" :aria-label="t('first step')" :title="t('first step')" @click="step(0)">⏮</button>
              <button type="button" class="tal__stepbtn" :disabled="stepIndex <= 0" :aria-label="t('step back')" :title="t('step back')" @click="step(stepIndex - 1)">◀</button>
              <button type="button" class="tal__stepbtn" :disabled="stepIndex >= lastStep" :aria-label="t('step over')" :title="t('step over')" @click="step(stepIndex + 1)">▶</button>
              <button type="button" class="tal__stepbtn" :disabled="stepIndex >= lastStep" :aria-label="t('last step')" :title="t('last step')" @click="step(lastStep)">⏭</button>
              <span v-if="currentStep" class="tal__steppos">
                {{ t('step {n} / {total}', { n: stepIndex + 1, total: lastStep + 1 }) }}
                <template v-if="currentStep.stage"> · <code>{{ currentStep.stage }}</code></template>
                · <code>{{ currentStep.kind }}</code>
              </span>
              <span v-else class="tal__steppos">{{ t('no steps') }}</span>
              <button
                v-if="run && !run.continueOn"
                type="button"
                class="tal__stopped"
                :disabled="lastRunLine === null"
                :title="lastRunLine === null ? undefined : failed ? t('go to the last line it completed') : t('go to the line it stopped at')"
                @click="lastRunLine !== null && revealLine(lastRunLine)"
              >⊘ {{ t('stopped: {reason}', { reason: run.reason ?? '' }) }}</button>
            </div>
          </template>
        </TalSourcePane>
        <div v-else class="tal__source tal__placeholder">{{ t('Select a frame to see its run in the rule file.') }}</div>
        <div
          class="tal__split"
          :class="{ 'tal__split--off': !layout.rightOpen }"
          :title="t('drag to resize')"
          @pointerdown="layout.rightOpen && resize('right', $event)"
        />
        <section v-if="layout.rightOpen" class="tal__pane">
          <header class="tal__paneh">
            <button type="button" class="tal__fold" :aria-label="t('hide the selected span')" :title="t('hide the selected span')" @click="togglePane('rightOpen')">◨</button>
            <span class="tal__zone">{{ t('Selected span') }}</span>
          </header>
          <TalVariablesPane
            :frame="selectedFrame"
            :frame-key="frameOnScreen"
            :step-index="stepIndex"
            :outputs="links"
            :locals="locals"
            :selected-name="selectedName"
            :open-row-line="openRowLine"
            @go="goToOutput"
            @go-step="(index: number, line: number) => { step(index); revealLine(line); }"
            @select-name="selectedName = $event"
          />
        </section>
        <button v-else type="button" class="tal__rail" :title="t('show the selected span')" @click="togglePane('rightOpen')">
          <span class="tal__railicon">◨</span>
          <span class="tal__railtext">{{ t('Selected span') }}</span>
        </button>
      </div>
    </template>
  </DebugView>
</template>

<style scoped>
/* The controls row is the other live-debugger tabs' own. */
.ctl {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.ctl__lbl {
  font-family: var(--rr-font-mono);
  font-size: var(--sw-fs-xs);
  font-weight: var(--sw-fw-bold);
  text-transform: uppercase;
  letter-spacing: var(--sw-ls-caps);
  color: var(--sw-fg-3);
}

.ctl__select {
  min-width: 250px;
}

.ctl__select,
.ctl__input {
  background: var(--rr-bg2);
  color: var(--rr-ink);
  border: 1px solid var(--rr-border);
  padding: 4px 8px;
  font-family: var(--rr-font-mono);
  font-size: var(--sw-fs-base);
  width: 90px;
}

.ctl__input--file {
  width: 250px;
}

.ctl--grow {
  flex: 1 1 200px;
  min-width: 200px;
}

.ctl--grow .ctl__select {
  min-width: 250px;
}

.ctl__input--flex {
  width: 100%;
  min-width: 200px;
}

.ctl__editlink {
  font-family: var(--rr-font-mono);
  font-size: var(--sw-fs-sm);
  color: var(--rr-ink2);
  text-decoration: none;
  padding: 2px 8px;
  border: 1px dashed var(--rr-border);
  border-radius: var(--rr-radius-sm);
  white-space: nowrap;
  align-self: end;
  margin-bottom: 1px;
}

.ctl__editlink:hover {
  color: var(--rr-accent);
  border-color: var(--rr-accent);
}

.tal__granularity {
  display: inline-flex;
  border: 1px solid var(--rr-border);
  background: var(--rr-bg2);
}

.tal__granbtn {
  background: transparent;
  border: 0;
  color: var(--rr-ink2);
  padding: 4px 10px;
  font-family: var(--rr-font-mono);
  font-size: var(--sw-fs-base);
  cursor: pointer;
}

.tal__granbtn--active {
  background: var(--rr-bg3);
  color: var(--rr-heading);
}

.tal__granbtn:not(.tal__granbtn--active):hover {
  background: var(--rr-bg3);
}

.tal__histbanner {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  background: var(--rr-bg3);
  border: 1px solid var(--rr-border);
  font-size: var(--sw-fs-sm);
}

.tal__histback {
  margin-left: auto;
  background: transparent;
  border: 1px solid var(--rr-border);
  color: var(--rr-ink);
  cursor: pointer;
}

.tal__sum {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px 12px;
  padding: 8px 0;
  font-size: var(--sw-fs-sm);
  color: var(--rr-ink2);
}

.tal__mode {
  padding: 1px 8px;
  border-radius: var(--rr-radius-sm);
  font-family: var(--rr-font-mono);
  font-weight: var(--sw-fw-bold);
  letter-spacing: var(--sw-ls-caps);
  text-transform: uppercase;
}

.tal__mode--block {
  background: var(--sw-info-soft);
  color: var(--rr-info);
}

.tal__mode--statement {
  background: var(--sw-accent-soft);
  color: var(--rr-accent);
}

.tal__badge {
  padding: 1px 8px;
  border: 1px solid var(--rr-border2);
  border-radius: var(--rr-radius-sm);
  font-family: var(--rr-font-mono);
  color: var(--rr-heading);
}

.tal__badge--sw-native {
  border-color: var(--rr-accent);
}

.tal__badge--otlp {
  border-color: var(--rr-info);
}

.tal__stat strong {
  color: var(--rr-heading);
}

.tal__stat--warn {
  color: var(--rr-warn);
}

.tal__stat--err {
  color: var(--rr-err);
}

.tal__chip {
  padding: 0 6px;
  background: var(--rr-bg);
  border: 1px solid var(--rr-border);
  border-radius: var(--rr-radius-sm);
  font-family: var(--rr-font-mono);
}

.tal__chip--done {
  border-color: var(--rr-ok);
}

.tal__export {
  padding: 1px 8px;
  background: transparent;
  border: 1px dashed var(--rr-border);
  border-radius: var(--rr-radius-sm);
  font-family: var(--rr-font-mono);
  font-size: var(--sw-fs-sm);
  color: var(--rr-ink2);
  cursor: pointer;
}

.tal__export:hover:not(:disabled) {
  color: var(--rr-accent);
  border-color: var(--rr-accent);
}

.tal__nodes {
  display: inline-flex;
  gap: 6px;
  margin-left: auto;
}

.tal__ide {
  display: grid;
  height: max(520px, calc(100vh - 420px));
}

/* The edge between two panes: drag it to resize the side pane. */
.tal__split {
  cursor: col-resize;
  position: relative;
}

.tal__split::after {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  left: 2px;
  width: 2px;
  background: transparent;
}

.tal__split:hover::after {
  background: var(--rr-accent);
}

.tal__split--off {
  cursor: default;
}

.tal__split--off:hover::after {
  background: transparent;
}

.tal__fold {
  margin-left: auto;
  background: transparent;
  border: 0;
  font-size: var(--sw-fs-md);
  line-height: 1;
  color: var(--rr-dim);
  cursor: pointer;
}

.tal__fold:hover {
  color: var(--rr-accent);
}

.tal__paneh .tal__fold:first-child {
  margin-left: 0;
  margin-right: 6px;
}

/* A hidden pane leaves a rail that shows it again. */
.tal__rail {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 8px 0;
  background: var(--rr-bg2);
  border: 1px solid var(--rr-border);
  color: var(--rr-dim);
  cursor: pointer;
}

.tal__rail:hover {
  color: var(--rr-accent);
}

.tal__railicon {
  font-size: var(--sw-fs-md);
}

.tal__railtext {
  writing-mode: vertical-rl;
  font-family: var(--rr-font-mono);
  font-size: var(--sw-fs-sm);
  letter-spacing: var(--sw-ls-caps);
  text-transform: uppercase;
}

/* The stepping controls drive the rule file, so they sit at its top. */
.tal__steps {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 5px 10px;
  border-bottom: 1px solid var(--rr-border);
  font-family: var(--rr-font-mono);
  font-size: var(--sw-fs-sm);
}

.tal__stepbtn {
  width: 26px;
  height: 22px;
  background: var(--rr-bg);
  border: 1px solid var(--rr-border);
  border-radius: var(--rr-radius-sm);
  color: var(--rr-ink);
  cursor: pointer;
}

.tal__stepbtn:disabled {
  color: var(--rr-dim);
  cursor: default;
}

.tal__steppos {
  margin-left: 6px;
  color: var(--rr-dim);
}

.tal__stopped {
  margin-left: auto;
  padding: 1px 8px;
  background: var(--sw-warn-soft);
  border: 1px solid var(--rr-warn);
  border-radius: var(--rr-radius-sm);
  font: inherit;
  color: var(--rr-warn);
  cursor: pointer;
}

.tal__stopped:disabled {
  cursor: default;
}

.tal__pane {
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--rr-bg2);
  border: 1px solid var(--rr-border);
}

.tal__paneh {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  background: var(--rr-bg3);
  border-bottom: 1px solid var(--rr-border2);
  font-family: var(--rr-font-ui);
}

.tal__zone {
  font-size: var(--sw-fs-base);
  font-weight: var(--sw-fw-bold);
  color: var(--rr-heading);
}

.tal__zonecount {
  padding: 0 6px;
  border-radius: var(--rr-radius-sm);
  background: var(--rr-bg);
  font-family: var(--rr-font-mono);
  font-size: var(--sw-fs-sm);
  color: var(--rr-ink2);
}

.tal__source {
  min-height: 0;
}

.tal__placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--rr-dim);
  background: var(--rr-bg2);
  border: 1px solid var(--rr-border);
}
</style>
